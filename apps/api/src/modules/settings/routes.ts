import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../db/client.js";
import { decisionPackages, subscriptions, workspaceSettings } from "../../db/schema.js";
import { decimalString, readJson } from "../../lib/http.js";
import { normalizeAmount } from "../../lib/money.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { decisionPackageSchema } from "../decisions/engine.js";
import { simulateApproval } from "../payments/policyGuard.js";
import { serializeSettings } from "./serialize.js";

const quietHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM"),
  end: z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM"),
  tz: z.string().min(1).max(64),
});

const patchSchema = z
  .object({
    aiMonthlyBudget: decimalString.nullable().optional(),
    approvalMode: z.enum(["always_ask", "ask_above_ceiling", "auto_within_envelope"]).optional(),
    spendCeiling: decimalString.nullable().optional(),
    killSwitch: z.boolean().optional(),
    categoryCeilings: z.record(z.string().min(1), decimalString).optional(),
    teamSize: z.number().int().min(1).max(10_000).optional(),
    quietHours: quietHoursSchema.nullable().optional(),
    primaryChannel: z.enum(["imessage", "whatsapp", "simulator"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.use("*", requireAuth());

settingsRoutes.get("/", (c) => c.json({ settings: serializeSettings(c.get("auth").settings) }));

settingsRoutes.patch("/", async (c) => {
  const { user, workspace, settings } = c.get("auth");
  const input = await readJson(c, patchSchema);
  const currency = settings.currency;

  const patch: Partial<typeof workspaceSettings.$inferInsert> = {
    updatedAt: new Date(),
    // Any policy edit bumps the version, so decisions can pin what they were
    // judged against and a stale package is detectable.
    policyVersion: settings.policyVersion + 1,
  };

  if (input.aiMonthlyBudget !== undefined) {
    patch.aiMonthlyBudget =
      input.aiMonthlyBudget === null ? null : normalizeAmount(input.aiMonthlyBudget, currency);
  }
  if (input.approvalMode !== undefined) patch.approvalMode = input.approvalMode;
  if (input.spendCeiling !== undefined) {
    patch.spendCeiling =
      input.spendCeiling === null ? null : normalizeAmount(input.spendCeiling, currency);
  }
  if (input.killSwitch !== undefined) patch.killSwitch = input.killSwitch;
  if (input.categoryCeilings !== undefined) {
    patch.categoryCeilings = Object.fromEntries(
      Object.entries(input.categoryCeilings).map(([k, v]) => [k, normalizeAmount(v, currency)]),
    );
  }
  if (input.teamSize !== undefined) patch.teamSize = input.teamSize;
  if (input.quietHours !== undefined) patch.quietHoursJson = input.quietHours;
  if (input.primaryChannel !== undefined) patch.primaryChannel = input.primaryChannel;

  const [updated] = await getDb()
    .update(workspaceSettings)
    .set(patch)
    .where(eq(workspaceSettings.workspaceId, workspace.id))
    .returning();
  if (!updated) throw new Error("settings update returned no row");

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "settings.updated",
    entityType: "workspace_settings",
    entityId: workspace.id,
    data: { changed: Object.keys(input), policyVersion: updated.policyVersion },
  });

  if (input.killSwitch !== undefined && input.killSwitch !== settings.killSwitch) {
    await recordAudit({
      workspaceId: workspace.id,
      actorUserId: user.id,
      type: input.killSwitch ? "kill_switch.enabled" : "kill_switch.disabled",
      entityType: "workspace_settings",
      entityId: workspace.id,
    });
  }

  c.get("log").info(
    { changed: Object.keys(input), policyVersion: updated.policyVersion },
    `policy updated — ${Object.keys(input).join(", ")} (version ${updated.policyVersion})`,
  );

  return c.json({ settings: serializeSettings(updated) });
});

settingsRoutes.post("/kill-switch", async (c) => {
  const { user, workspace } = c.get("auth");
  const { enabled } = await readJson(c, z.object({ enabled: z.boolean() }));

  const [updated] = await getDb()
    .update(workspaceSettings)
    .set({ killSwitch: enabled, updatedAt: new Date() })
    .where(eq(workspaceSettings.workspaceId, workspace.id))
    .returning();
  if (!updated) throw new Error("kill switch update returned no row");

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: enabled ? "kill_switch.enabled" : "kill_switch.disabled",
    entityType: "workspace_settings",
    entityId: workspace.id,
    data: { enabled },
  });

  return c.json({ settings: serializeSettings(updated) });
});

const simulateSchema = z
  .object({
    approvalMode: z.enum(["always_ask", "ask_above_ceiling", "auto_within_envelope"]).optional(),
    spendCeiling: decimalString.nullable().optional(),
    killSwitch: z.boolean().optional(),
  })
  .default({});

/**
 * Answers "if I loosened policy, what would the agent do on its own?" against
 * the decisions that are actually open, without executing anything.
 */
settingsRoutes.post("/simulate", async (c) => {
  const { workspace, settings } = c.get("auth");
  const overrides = await readJson(c, simulateSchema);
  const currency = settings.currency;

  const candidate = {
    ...settings,
    ...(overrides.approvalMode !== undefined ? { approvalMode: overrides.approvalMode } : {}),
    ...(overrides.killSwitch !== undefined ? { killSwitch: overrides.killSwitch } : {}),
    ...(overrides.spendCeiling !== undefined
      ? {
          spendCeiling:
            overrides.spendCeiling === null
              ? null
              : normalizeAmount(overrides.spendCeiling, currency),
        }
      : {}),
  };

  const rows = await getDb()
    .select({ decision: decisionPackages, subscription: subscriptions })
    .from(decisionPackages)
    .innerJoin(subscriptions, eq(subscriptions.id, decisionPackages.subscriptionId))
    .where(
      and(
        eq(decisionPackages.workspaceId, workspace.id),
        isNull(decisionPackages.supersededAt),
        eq(subscriptions.status, "active"),
      ),
    );

  const results = rows.map(({ decision, subscription }) => {
    const parsed = decisionPackageSchema.safeParse(decision.payload);
    const amount = parsed.success ? parsed.data.amount_due : "0.00";
    const verdict = simulateApproval(candidate, {
      amount,
      currency: subscription.currency,
      recommendation: decision.recommendation,
    });
    return {
      decisionId: decision.id,
      subscriptionId: subscription.id,
      merchantName: subscription.merchantName,
      recommendation: decision.recommendation,
      amount,
      currency: subscription.currency,
      outcome: verdict.outcome,
      reason: verdict.reason,
    };
  });

  return c.json({
    simulatedPolicy: {
      approvalMode: candidate.approvalMode,
      spendCeiling: candidate.spendCeiling,
      killSwitch: candidate.killSwitch,
    },
    counts: {
      auto: results.filter((r) => r.outcome === "auto").length,
      ask: results.filter((r) => r.outcome === "ask").length,
      blocked: results.filter((r) => r.outcome === "blocked").length,
    },
    decisions: results,
  });
});
