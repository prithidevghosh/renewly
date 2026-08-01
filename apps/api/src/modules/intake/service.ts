import { getDb, type Database } from "../../db/client.js";
import { renewalEvents, type RenewalEvent } from "../../db/schema.js";
import { newId } from "../../lib/id.js";
import { getLlmClient, parsedRenewalSchema, type ParsedRenewal } from "../../lib/llm.js";
import { logger } from "../../lib/logger.js";
import { normalizeAmount } from "../../lib/money.js";
import type { AuthContext } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { extractRenewalHeuristically } from "./emailParser.js";

export type ParserUsed = "llm" | "heuristic";

export interface ParseOutcome {
  parsed: ParsedRenewal;
  parser: ParserUsed;
  confidence: number;
}

/** Mean of the gated field confidences; the number the UI shows as "sure". */
export function overallConfidence(parsed: ParsedRenewal): number {
  const values = Object.values(parsed.field_confidence ?? {});
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Number(Math.min(1, Math.max(0, mean)).toFixed(3));
}

/**
 * Tries the LLM first, falls back to the heuristic parser. The fallback is not
 * a degraded stub — it is the same contract with honestly lower confidence, so
 * the payment gate does its job when the extraction was guesswork.
 */
export async function parseRenewalText(text: string): Promise<ParseOutcome> {
  const llm = getLlmClient();

  if (llm.available) {
    const extracted = await llm.extractRenewalFromText(text);
    if (extracted) {
      const normalized = normalizeParsed(extracted, text);
      const validated = parsedRenewalSchema.safeParse(normalized);
      if (validated.success) {
        return {
          parsed: validated.data,
          parser: "llm",
          confidence: overallConfidence(validated.data),
        };
      }
      logger.warn({ issues: validated.error.issues }, "llm extraction failed validation");
    }
  }

  const heuristic = extractRenewalHeuristically(text);
  const parsed = normalizeParsed(heuristic, text);
  return { parsed, parser: "heuristic", confidence: overallConfidence(parsed) };
}

function normalizeParsed(parsed: ParsedRenewal, sourceText: string): ParsedRenewal {
  const currency = (parsed.currency ?? "USD").toUpperCase();
  return {
    ...parsed,
    currency: parsed.amount ? currency : parsed.currency,
    amount: parsed.amount ? normalizeAmount(parsed.amount, currency) : null,
    next_renewal_at: toIso(parsed.next_renewal_at),
    cancel_by_at: toIso(parsed.cancel_by_at),
    raw_excerpt: (parsed.raw_excerpt || sourceText).slice(0, 500),
  };
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface RecordRenewalEventInput {
  auth: AuthContext;
  rawText: string;
  outcome: ParseOutcome;
  sourceType: "email" | "file" | "csv" | "manual";
  subscriptionId?: string | null;
  db?: Database;
}

export async function recordRenewalEvent(
  input: RecordRenewalEventInput,
): Promise<RenewalEvent> {
  const db = input.db ?? getDb();
  const { parsed, parser, confidence } = input.outcome;

  const [row] = await db
    .insert(renewalEvents)
    .values({
      id: newId("rev"),
      workspaceId: input.auth.workspace.id,
      subscriptionId: input.subscriptionId ?? null,
      rawText: input.rawText.slice(0, 100_000),
      rawExcerpt: parsed.raw_excerpt,
      parsedJson: parsed as unknown as Record<string, unknown>,
      parseConfidence: confidence.toFixed(3),
      sourceType: input.sourceType,
      parserUsed: parser,
    })
    .returning();
  if (!row) throw new Error("renewal event insert returned no row");

  await recordAudit(
    {
      workspaceId: input.auth.workspace.id,
      actorUserId: input.auth.user.id,
      type: "renewal.parsed",
      entityType: "renewal_event",
      entityId: row.id,
      data: {
        merchantName: parsed.merchant_name,
        amount: parsed.amount,
        currency: parsed.currency,
        parser,
        confidence,
        sourceType: input.sourceType,
      },
    },
    db,
  );

  return row;
}

export interface RenewalEventDto {
  id: string;
  workspaceId: string;
  subscriptionId: string | null;
  rawExcerpt: string;
  parsed: ParsedRenewal;
  parseConfidence: number;
  parserUsed: string;
  sourceType: RenewalEvent["sourceType"];
  createdAt: string;
}

export function serializeRenewalEvent(row: RenewalEvent): RenewalEventDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subscriptionId: row.subscriptionId,
    rawExcerpt: row.rawExcerpt,
    parsed: row.parsedJson as unknown as ParsedRenewal,
    parseConfidence: Number(row.parseConfidence),
    parserUsed: row.parserUsed,
    sourceType: row.sourceType,
    createdAt: row.createdAt.toISOString(),
  };
}
