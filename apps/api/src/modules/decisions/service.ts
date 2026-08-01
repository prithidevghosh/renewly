import { and, desc, eq, lt, ne } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { decisionPackages, subscriptions, type DecisionPackageRow, type Subscription } from "../../db/schema.js";
import { AppError, notFound } from "../../lib/errors.js";
import { toPage, type Page } from "../../lib/http.js";
import { newId } from "../../lib/id.js";
import { getLlmClient, type DecisionExplainContext } from "../../lib/llm.js";
import { cmp, normalizeAmount } from "../../lib/money.js";
import type { AuthContext } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { replaceIdentifiedSavings, type SavingsActionType } from "../ledger/service.js";
import { catalogAnnualCost, type CatalogTool } from "./catalog.js";
import {
  buildCounterfactuals,
  decide,
  type Recommendation,
  decisionPackageSchema,
  deterministicNarrative,
  type DecisionPackage,
  type EnginePolicy,
  type EngineSubscription,
} from "./engine.js";

export interface DecisionDto {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  recommendation: DecisionPackage["recommendation"];
  confidence: number;
  modelId: string | null;
  policyVersion: number;
  pricedAmount: string | null;
  expiresAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  package: DecisionPackage;
}

export function serializeDecision(row: DecisionPackageRow): DecisionDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subscriptionId: row.subscriptionId,
    recommendation: row.recommendation,
    confidence: Number(row.confidence),
    modelId: row.modelId,
    policyVersion: row.policyVersion,
    pricedAmount: row.pricedAmount,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    package: decisionPackageSchema.parse(row.payload),
  };
}

export function toEngineSubscription(row: Subscription): EngineSubscription {
  return {
    id: row.id,
    merchantName: row.merchantName,
    planName: row.planName,
    amount: row.amount,
    currency: row.currency,
    billingCycle: row.billingCycle,
    criticality: row.criticality,
    jobCategory: row.jobCategory,
    usageNote: row.usageNote,
    seatsTotal: row.seatsTotal,
    seatsActive: row.seatsActive,
    nextRenewalAt: row.nextRenewalAt,
    status: row.status,
  };
}

export function toEnginePolicy(settings: AuthContext["settings"]): EnginePolicy {
  return {
    killSwitch: settings.killSwitch,
    approvalMode: settings.approvalMode,
    spendCeiling: settings.spendCeiling,
    aiMonthlyBudget: settings.aiMonthlyBudget,
    categoryCeilings: settings.categoryCeilings ?? {},
    currency: settings.currency,
    policyVersion: settings.policyVersion,
  };
}

/** Decisions go stale: prices move and policy changes. Force a fresh look weekly. */
const DECISION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Engine action -> the ledger's coarser action taxonomy. */
export function toSavingsActionType(action: Recommendation): SavingsActionType {
  switch (action) {
    case "cancel":
      return "cancel";
    case "rightsize_seats":
      return "rightsize";
    case "switch_term":
      return "term_switch";
    case "switch_vendor":
      return "switch_vendor";
    case "renew":
      return "renew";
    case "snooze":
      return "other";
  }
}

export interface GenerateDecisionInput {
  auth: AuthContext;
  subscription: Subscription;
  /** When false, an existing live package for this subscription is returned as is. */
  regenerate: boolean;
  db?: Database;
}

/**
 * Runs the deterministic engine, then asks the LLM for the human-facing wording
 * only. If the model is unavailable or writes something that fails validation,
 * the deterministic narrative is used — the recommendation and every number are
 * identical either way.
 */
export async function generateDecisionPackage(
  input: GenerateDecisionInput,
): Promise<DecisionPackageRow> {
  const db = input.db ?? getDb();
  const { auth, subscription } = input;

  if (subscription.status === "cancelled") {
    throw new AppError(
      "INVALID_DECISION_STATE",
      "Cannot generate a decision for a cancelled subscription",
      { subscriptionId: subscription.id },
    );
  }

  if (!input.regenerate) {
    const existing = await findLiveDecision(auth.workspace.id, subscription.id, db);
    if (existing) return existing;
  }

  const peers = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, auth.workspace.id),
        eq(subscriptions.status, "active"),
        ne(subscriptions.id, subscription.id),
      ),
    );

  const engineSubscription = toEngineSubscription(subscription);
  const outcome = decide({
    subscription: engineSubscription,
    policy: toEnginePolicy(auth.settings),
    peers: peers.map((peer) => ({
      id: peer.id,
      amount: peer.amount,
      billingCycle: peer.billingCycle,
      jobCategory: peer.jobCategory,
      merchantName: peer.merchantName,
    })),
  });

  const seats = Math.max(1, subscription.seatsTotal);
  const catalogAlternatives = buildAlternatives(outcome.candidates, outcome.catalogTool, seats);

  const llm = getLlmClient();
  let narrativeSource: DecisionPackage["narrative_source"] = "deterministic";
  let { headline, narrative } = deterministicNarrative(outcome, engineSubscription);
  let alternatives = catalogAlternatives;

  if (llm.available) {
    const context: DecisionExplainContext = {
      recommendation: outcome.recommendation,
      merchant: subscription.merchantName,
      planName: subscription.planName,
      amount: subscription.amount,
      currency: subscription.currency,
      billingCycle: subscription.billingCycle,
      annualCost: outcome.doNothingAnnual,
      criticality: subscription.criticality,
      usageNote: subscription.usageNote,
      seatsTotal: seats,
      seatsActive: subscription.seatsActive,
      policyFlags: outcome.policyFlags,
      reasons: outcome.reasons,
      candidates: catalogAlternatives.map((alt) => ({
        name: alt.name,
        annualCost: alt.annual_cost,
        category: outcome.catalogTool?.category ?? "unknown",
        note: alt.pros[0] ?? "",
      })),
    };

    const written = await llm.explainDecision(context);
    if (written) {
      // Keep only alternatives that exist in the catalog at the catalog price.
      // A model that invents a tool or a price is discarded, not trusted.
      const permitted = new Map(catalogAlternatives.map((alt) => [alt.name, alt]));
      const verified = written.alternatives
        .map((alt) => permitted.get(alt.name))
        .filter((alt): alt is (typeof catalogAlternatives)[number] => alt !== undefined);

      headline = written.headline;
      narrative = written.narrative;
      alternatives = verified.length > 0 ? verified : catalogAlternatives;
      narrativeSource = "llm";
    }
  }

  const packagePayload: DecisionPackage = decisionPackageSchema.parse({
    recommendation: outcome.recommendation,
    confidence: outcome.confidence,
    headline,
    narrative,
    counterfactuals: buildCounterfactuals(outcome, engineSubscription),
    alternatives,
    diagnosis: outcome.diagnosis,
    inputs_used: outcome.inputsUsed,
    policy_flags: outcome.policyFlags,
    policy_version: auth.settings.policyVersion,
    amount_due: outcome.amountDue,
    currency: subscription.currency,
    seats_target: outcome.seatsTarget,
    term_target: outcome.termTarget,
    vendor_target: outcome.vendorTarget,
    narrative_source: narrativeSource,
  });

  // Regeneration supersedes rather than deletes: the audit trail must keep the
  // package the user was actually looking at when they approved.
  await db
    .update(decisionPackages)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(decisionPackages.workspaceId, auth.workspace.id),
        eq(decisionPackages.subscriptionId, subscription.id),
      ),
    );

  const [row] = await db
    .insert(decisionPackages)
    .values({
      id: newId("dec"),
      workspaceId: auth.workspace.id,
      subscriptionId: subscription.id,
      recommendation: outcome.recommendation,
      payload: packagePayload as unknown as Record<string, unknown>,
      confidence: outcome.confidence.toFixed(3),
      modelId: narrativeSource === "llm" ? llm.modelId : null,
      policyVersion: auth.settings.policyVersion,
      pricedAmount: normalizeAmount(subscription.amount, subscription.currency),
      expiresAt: new Date(Date.now() + DECISION_TTL_MS),
    })
    .returning();
  if (!row) throw new Error("decision insert returned no row");

  // A decision that saves money is an opportunity the agent is claiming exists.
  // It is recorded as identified, never as realized, until something is banked.
  if (cmp(outcome.savingsAnnual, "0.00", subscription.currency) > 0) {
    await replaceIdentifiedSavings(
      {
        workspaceId: auth.workspace.id,
        actorUserId: auth.user.id,
        subscriptionId: subscription.id,
        decisionId: row.id,
        actionType: toSavingsActionType(outcome.recommendation),
        recognition: "identified",
        amountSaved: outcome.savingsAnnual,
        currency: subscription.currency,
        note: `Identified by decision ${row.id}: ${outcome.recommendation}`,
      },
      db,
    );
  }

  await recordAudit(
    {
      workspaceId: auth.workspace.id,
      actorUserId: auth.user.id,
      type: "decision.generated",
      entityType: "decision_package",
      entityId: row.id,
      data: {
        subscriptionId: subscription.id,
        recommendation: outcome.recommendation,
        savingsAnnual: outcome.savingsAnnual,
        narrativeSource,
        policyFlags: outcome.policyFlags,
      },
    },
    db,
  );

  return row;
}

function buildAlternatives(
  candidates: CatalogTool[],
  current: CatalogTool | null,
  seats: number,
): DecisionPackage["alternatives"] {
  const alternatives: DecisionPackage["alternatives"] = candidates.map((tool) => ({
    name: tool.name,
    annual_cost: catalogAnnualCost(tool, seats),
    pros: tool.pros,
    cons: tool.cons,
    switch_friction: tool.switchFriction,
  }));

  // Annual billing of the same tool is an alternative in its own right and
  // usually the least disruptive one, so it leads.
  if (current?.annualMonthlyPrice) {
    const annualCost = catalogAnnualCost(current, seats, true);
    if (cmp(annualCost, catalogAnnualCost(current, seats)) < 0) {
      alternatives.unshift({
        name: `${current.name} (annual billing)`,
        annual_cost: annualCost,
        pros: ["Same tier and same tool", "No migration"],
        cons: ["Twelve months committed up front"],
        switch_friction: "low",
      });
    }
  }

  return alternatives.slice(0, 4);
}

export async function findLiveDecision(
  workspaceId: string,
  subscriptionId: string,
  db: Database = getDb(),
): Promise<DecisionPackageRow | null> {
  const [row] = await db
    .select()
    .from(decisionPackages)
    .where(
      and(
        eq(decisionPackages.workspaceId, workspaceId),
        eq(decisionPackages.subscriptionId, subscriptionId),
      ),
    )
    .orderBy(desc(decisionPackages.id))
    .limit(1);
  if (!row || row.supersededAt) return null;
  return row;
}

export async function getDecision(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<DecisionPackageRow> {
  const [row] = await db
    .select()
    .from(decisionPackages)
    .where(and(eq(decisionPackages.id, id), eq(decisionPackages.workspaceId, workspaceId)));
  if (!row) throw notFound("Decision package");
  return row;
}

export async function listDecisionsForSubscription(
  workspaceId: string,
  subscriptionId: string,
  options: { limit: number; cursor?: string },
  db: Database = getDb(),
): Promise<Page<DecisionPackageRow>> {
  const filters = [
    eq(decisionPackages.workspaceId, workspaceId),
    eq(decisionPackages.subscriptionId, subscriptionId),
  ];
  if (options.cursor) filters.push(lt(decisionPackages.id, options.cursor));

  const rows = await db
    .select()
    .from(decisionPackages)
    .where(and(...filters))
    .orderBy(desc(decisionPackages.id))
    .limit(options.limit + 1);

  return toPage(rows, options.limit);
}
