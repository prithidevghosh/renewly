import { and, desc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getDb } from "../../db/client.js";
import { csvCandidates, csvImports, subscriptions } from "../../db/schema.js";
import { env } from "../../env.js";
import { AppError, conflict, notFound, validationError } from "../../lib/errors.js";
import { readJson } from "../../lib/http.js";
import { newId } from "../../lib/id.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { canonicalizeMerchant, serializeSubscription } from "../subscriptions/service.js";
import { detectRecurring, parseCsv } from "./csvParser.js";
import {
  parseRenewalText,
  recordRenewalEvent,
  serializeRenewalEvent,
  type ParseOutcome,
} from "./service.js";

export const intakeRoutes = new Hono<AppEnv>();

intakeRoutes.use("*", requireAuth());

/* -------------------------------------------------------------------------- */
/* Email and file intake                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parsing produces a draft, not a subscription. The user confirms it into the
 * inventory, which is also what puts the gated fields beyond the payment guard.
 */
function draftFrom(outcome: ParseOutcome) {
  const { parsed } = outcome;
  return {
    merchantName: parsed.merchant_name,
    merchantCanonical: canonicalizeMerchant(parsed.merchant_name),
    planName: parsed.plan_name,
    amount: parsed.amount,
    currency: parsed.currency ?? "USD",
    billingCycle: parsed.billing_cycle,
    nextRenewalAt: parsed.next_renewal_at,
    cancelByAt: parsed.cancel_by_at,
    priceChangeNote: parsed.price_change_note,
    fieldConfidence: parsed.field_confidence,
    rawExcerpt: parsed.raw_excerpt,
    parser: outcome.parser,
    confidence: outcome.confidence,
    /** The draft cannot be paid until these are confirmed. */
    requiresConfirmation: Object.entries(parsed.field_confidence).some(
      ([field, value]) =>
        ["amount", "merchant_name", "next_renewal_at"].includes(field) && value < 0.7,
    ),
  };
}

async function handleText(c: Context<AppEnv>, text: string, sourceType: "email" | "file") {
  const auth = c.get("auth");
  const outcome = await parseRenewalText(text);
  const event = await recordRenewalEvent({ auth, rawText: text, outcome, sourceType });
  return c.json(
    { renewalEvent: serializeRenewalEvent(event), draft: draftFrom(outcome) },
    201,
  );
}

intakeRoutes.post("/email", async (c) => {
  const { text } = await readJson(
    c,
    z.object({ text: z.string().min(10).max(100_000) }),
  );
  return handleText(c, text, "email");
});

intakeRoutes.post("/file", async (c) => {
  const form = await readMultipart(c);
  const file = form.get("file");
  if (!(file instanceof File)) throw validationError("Expected a multipart field named \"file\"");

  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", `File exceeds the ${env.MAX_UPLOAD_BYTES} byte limit`, {
      size: file.size,
    });
  }

  const name = file.name.toLowerCase();
  if (!/\.(txt|eml|md|text)$/.test(name) && file.type && !file.type.startsWith("text/")) {
    throw validationError("Only plain text, .txt and .eml files are supported", {
      filename: file.name,
    });
  }

  const text = await file.text();
  if (text.trim().length < 10) throw validationError("File does not contain enough text to parse");

  return handleText(c, text, "file");
});

/* -------------------------------------------------------------------------- */
/* CSV intake                                                                 */
/* -------------------------------------------------------------------------- */

intakeRoutes.post("/csv", async (c) => {
  const { user, workspace } = c.get("auth");
  const form = await readMultipart(c);
  const file = form.get("file");
  if (!(file instanceof File)) throw validationError("Expected a multipart field named \"file\"");

  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", `File exceeds the ${env.MAX_UPLOAD_BYTES} byte limit`, {
      size: file.size,
    });
  }

  const content = await file.text();
  const rows = parseCsv(content, env.MAX_CSV_ROWS);
  const candidates = detectRecurring(rows);

  const db = getDb();
  const [importRow] = await db
    .insert(csvImports)
    .values({
      id: newId("imp"),
      workspaceId: workspace.id,
      filename: file.name || "upload.csv",
      rowCount: rows.length,
    })
    .returning();
  if (!importRow) throw new Error("csv import insert returned no row");

  const inserted =
    candidates.length > 0
      ? await db
          .insert(csvCandidates)
          .values(
            candidates.map((candidate) => ({
              id: newId("cnd"),
              importId: importRow.id,
              workspaceId: workspace.id,
              merchantGuess: candidate.merchantGuess,
              merchantCanonical: candidate.merchantCanonical,
              amount: candidate.amount,
              currency: candidate.currency,
              date: candidate.date,
              billingCycle: candidate.billingCycle,
              occurrences: candidate.occurrences,
              confidence: candidate.confidence.toFixed(3),
              rawRow: candidate.rawRow,
            })),
          )
          .returning()
      : [];

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "csv.imported",
    entityType: "csv_import",
    entityId: importRow.id,
    data: {
      filename: importRow.filename,
      rowCount: rows.length,
      candidateCount: inserted.length,
    },
  });

  return c.json(
    {
      import: {
        id: importRow.id,
        filename: importRow.filename,
        rowCount: importRow.rowCount,
        createdAt: importRow.createdAt.toISOString(),
      },
      candidates: inserted.map(serializeCandidate),
    },
    201,
  );
});

intakeRoutes.get("/csv/:importId/candidates", async (c) => {
  const { workspace } = c.get("auth");
  const importId = c.req.param("importId");

  const [importRow] = await getDb()
    .select()
    .from(csvImports)
    .where(and(eq(csvImports.id, importId), eq(csvImports.workspaceId, workspace.id)));
  if (!importRow) throw notFound("CSV import");

  const rows = await getDb()
    .select()
    .from(csvCandidates)
    .where(
      and(eq(csvCandidates.importId, importId), eq(csvCandidates.workspaceId, workspace.id)),
    )
    .orderBy(desc(csvCandidates.confidence));

  return c.json({ candidates: rows.map(serializeCandidate) });
});

const acceptSchema = z
  .object({
    merchantName: z.string().min(1).max(200).optional(),
    planName: z.string().max(200).nullish(),
    criticality: z.enum(["must_keep", "nice_to_have", "experimental"]).optional(),
    jobCategory: z.string().max(120).nullish(),
    seatsTotal: z.number().int().min(1).max(10_000).optional(),
    nextRenewalAt: z.string().datetime().nullish(),
  })
  .default({});

intakeRoutes.post("/csv/candidates/:id/accept", async (c) => {
  const { user, workspace } = c.get("auth");
  const id = c.req.param("id");
  const input = await readJson(c, acceptSchema);
  const db = getDb();

  const [candidate] = await db
    .select()
    .from(csvCandidates)
    .where(and(eq(csvCandidates.id, id), eq(csvCandidates.workspaceId, workspace.id)));
  if (!candidate) throw notFound("CSV candidate");
  if (candidate.status !== "pending") {
    throw conflict(`Candidate has already been ${candidate.status}`, { candidateId: id });
  }

  const merchantName = input.merchantName ?? candidate.merchantGuess;
  const detectionConfidence = Number(candidate.confidence);

  // A statement line gives the amount exactly but only guesses the merchant and
  // the renewal date, so those two carry the detection confidence forward.
  const fieldConfidence = {
    amount: 0.95,
    merchant_name: input.merchantName ? 1 : detectionConfidence,
    next_renewal_at: input.nextRenewalAt ? 1 : Math.min(detectionConfidence, 0.6),
  };

  const [subscription] = await db
    .insert(subscriptions)
    .values({
      id: newId("sub"),
      workspaceId: workspace.id,
      merchantName,
      merchantCanonical: canonicalizeMerchant(merchantName),
      planName: input.planName ?? null,
      amount: candidate.amount,
      currency: candidate.currency,
      billingCycle: candidate.billingCycle,
      nextRenewalAt: input.nextRenewalAt
        ? new Date(input.nextRenewalAt)
        : nextRenewalFrom(candidate.date, candidate.billingCycle),
      criticality: input.criticality ?? "nice_to_have",
      jobCategory: input.jobCategory ?? null,
      seatsTotal: input.seatsTotal ?? 1,
      lastSignalAt: candidate.date,
      sourceType: "csv",
      fieldConfidence,
      confirmedAt: null,
      rawExcerpt: JSON.stringify(candidate.rawRow).slice(0, 500),
      notes: `Detected from ${candidate.occurrences} matching statement lines`,
    })
    .returning();
  if (!subscription) throw new Error("subscription insert returned no row");

  await db
    .update(csvCandidates)
    .set({ status: "accepted", linkedSubscriptionId: subscription.id })
    .where(eq(csvCandidates.id, id));

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "csv.candidate_accepted",
    entityType: "csv_candidate",
    entityId: id,
    data: { subscriptionId: subscription.id, merchantName, amount: candidate.amount },
  });

  return c.json({ subscription: serializeSubscription(subscription) }, 201);
});

intakeRoutes.post("/csv/candidates/:id/reject", async (c) => {
  const { user, workspace } = c.get("auth");
  const id = c.req.param("id");
  const db = getDb();

  const [candidate] = await db
    .select()
    .from(csvCandidates)
    .where(and(eq(csvCandidates.id, id), eq(csvCandidates.workspaceId, workspace.id)));
  if (!candidate) throw notFound("CSV candidate");
  if (candidate.status !== "pending") {
    throw conflict(`Candidate has already been ${candidate.status}`, { candidateId: id });
  }

  const [updated] = await db
    .update(csvCandidates)
    .set({ status: "rejected" })
    .where(eq(csvCandidates.id, id))
    .returning();

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "csv.candidate_rejected",
    entityType: "csv_candidate",
    entityId: id,
    data: { merchantGuess: candidate.merchantGuess },
  });

  return c.json({ candidate: updated ? serializeCandidate(updated) : null });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function serializeCandidate(row: typeof csvCandidates.$inferSelect) {
  return {
    id: row.id,
    importId: row.importId,
    workspaceId: row.workspaceId,
    merchantGuess: row.merchantGuess,
    merchantCanonical: row.merchantCanonical,
    amount: row.amount,
    currency: row.currency,
    date: row.date?.toISOString() ?? null,
    billingCycle: row.billingCycle,
    occurrences: row.occurrences,
    confidence: Number(row.confidence),
    status: row.status,
    linkedSubscriptionId: row.linkedSubscriptionId,
    rawRow: row.rawRow,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Project the next charge one cycle past the most recent one seen. */
function nextRenewalFrom(last: Date | null, cycle: string): Date | null {
  if (!last) return null;
  const next = new Date(last.getTime());
  if (cycle === "yearly") next.setUTCFullYear(next.getUTCFullYear() + 1);
  else if (cycle === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

async function readMultipart(c: Context<AppEnv>): Promise<FormData> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw validationError("Expected a multipart/form-data upload");
  }
  try {
    return await c.req.formData();
  } catch {
    throw validationError("Could not read the multipart upload");
  }
}
