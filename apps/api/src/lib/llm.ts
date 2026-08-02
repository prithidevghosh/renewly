import OpenAI from "openai";
import { z } from "zod";
import { env } from "../env.js";
import { logger } from "./logger.js";

export const parsedRenewalSchema = z.object({
  merchant_name: z.string().min(1),
  plan_name: z.string().nullable(),
  amount: z
    .string()
    .regex(/^\d{1,15}(\.\d{1,2})?$/)
    .nullable(),
  currency: z.string().length(3).nullable(),
  billing_cycle: z.enum(["monthly", "yearly", "weekly", "unknown"]),
  next_renewal_at: z.string().nullable(),
  cancel_by_at: z.string().nullable(),
  price_change_note: z.string().nullable(),
  field_confidence: z.record(z.string(), z.number().min(0).max(1)),
  raw_excerpt: z.string(),
});

export type ParsedRenewal = z.infer<typeof parsedRenewalSchema>;

export const decisionNarrativeSchema = z.object({
  headline: z.string().min(1).max(160),
  narrative: z.string().min(1),
  alternatives: z.array(
    z.object({
      name: z.string().min(1),
      annual_cost: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
      switch_friction: z.enum(["low", "medium", "high"]),
    }),
  ),
});

export type DecisionNarrative = z.infer<typeof decisionNarrativeSchema>;

export interface LlmClient {
  readonly available: boolean;
  readonly modelId: string | null;
  /** Returns null when the model is unavailable or the output cannot be parsed. */
  extractRenewalFromText(text: string): Promise<ParsedRenewal | null>;
  explainDecision(context: DecisionExplainContext): Promise<DecisionNarrative | null>;
}

export interface DecisionExplainContext {
  recommendation:
    | "renew"
    | "rightsize_seats"
    | "switch_term"
    | "switch_vendor"
    | "cancel"
    | "snooze";
  merchant: string;
  planName: string | null;
  amount: string;
  currency: string;
  billingCycle: string;
  annualCost: string;
  criticality: string;
  usageNote: string | null;
  seatsTotal: number;
  seatsActive: number | null;
  policyFlags: string[];
  reasons: string[];
  /** Curated catalog rows only. The model must not invent tools or prices. */
  candidates: Array<{ name: string; annualCost: string; category: string; note: string }>;
}

const RENEWAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "merchant_name",
    "plan_name",
    "amount",
    "currency",
    "billing_cycle",
    "next_renewal_at",
    "cancel_by_at",
    "price_change_note",
    "field_confidence",
    "raw_excerpt",
  ],
  properties: {
    merchant_name: { type: "string" },
    plan_name: { type: ["string", "null"] },
    amount: { type: ["string", "null"], description: "Decimal string such as 20.00" },
    currency: { type: ["string", "null"], description: "ISO 4217 code" },
    billing_cycle: { type: "string", enum: ["monthly", "yearly", "weekly", "unknown"] },
    next_renewal_at: { type: ["string", "null"], description: "ISO 8601 UTC timestamp" },
    cancel_by_at: { type: ["string", "null"], description: "ISO 8601 UTC timestamp" },
    price_change_note: { type: ["string", "null"] },
    field_confidence: {
      type: "object",
      additionalProperties: false,
      required: ["merchant_name", "amount", "next_renewal_at", "billing_cycle"],
      properties: {
        merchant_name: { type: "number" },
        amount: { type: "number" },
        next_renewal_at: { type: "number" },
        billing_cycle: { type: "number" },
      },
    },
    raw_excerpt: { type: "string" },
  },
} as const;

const NARRATIVE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "narrative", "alternatives"],
  properties: {
    headline: { type: "string" },
    narrative: { type: "string" },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "annual_cost", "pros", "cons", "switch_friction"],
        properties: {
          name: { type: "string" },
          annual_cost: { type: "string" },
          pros: { type: "array", items: { type: "string" } },
          cons: { type: "array", items: { type: "string" } },
          switch_friction: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
} as const;

const EXTRACT_SYSTEM_PROMPT = [
  "You extract subscription renewal facts from raw email or receipt text.",
  "Return only fields the text supports. Use null when a field is absent.",
  "Amounts are decimal strings without currency symbols, for example 20.00.",
  "Dates are ISO 8601 UTC timestamps.",
  "field_confidence is your calibrated certainty per field, 0 to 1. Use a value",
  "below 0.7 for anything you inferred rather than read directly.",
  "raw_excerpt is the shortest verbatim span from the input that proves the amount",
  "and merchant. Never invent a merchant, price or date.",
].join(" ");

const EXPLAIN_SYSTEM_PROMPT = [
  "You write the human-facing explanation for an already-decided subscription",
  "recommendation. The recommendation and the numbers are given to you and are",
  "final. Do not contradict them and do not recalculate them.",
  "Alternatives must be chosen ONLY from the provided candidate list, using the",
  "provided annual_cost values verbatim. Never invent a tool, a price, or another",
  "subscription the user might have. Write plainly, no marketing language, no emoji.",
  // The product reads no vendor telemetry. usage_note is the user's own words and
  // is usually null, so any claim about how much a tool is used has to come from
  // there or not be made at all.
  "There is NO usage telemetry. When usage_note is null you must not say or imply",
  "the user rarely uses, barely uses, or has abandoned the tool, and you must not",
  "describe any seat as dead, idle or unused. State the invoice and policy reasons",
  "given in `reasons` instead. Never name or refer to an individual seat holder.",
].join(" ");

class OpenAiLlmClient implements LlmClient {
  readonly available = true;
  readonly modelId: string;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: env.LLM_BASE_URL, maxRetries: 1 });
    this.modelId = env.LLM_MODEL;
  }

  async extractRenewalFromText(text: string): Promise<ParsedRenewal | null> {
    return this.structured(
      parsedRenewalSchema,
      "renewal_extraction",
      RENEWAL_JSON_SCHEMA,
      EXTRACT_SYSTEM_PROMPT,
      text.slice(0, 12_000),
    );
  }

  async explainDecision(context: DecisionExplainContext): Promise<DecisionNarrative | null> {
    return this.structured(
      decisionNarrativeSchema,
      "decision_narrative",
      NARRATIVE_JSON_SCHEMA,
      EXPLAIN_SYSTEM_PROMPT,
      JSON.stringify(context),
    );
  }

  /** One retry: structured-output models occasionally emit a stray prose wrapper. */
  private async structured<T extends z.ZodTypeAny>(
    schema: T,
    name: string,
    jsonSchema: unknown,
    system: string,
    user: string,
  ): Promise<z.infer<T> | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.modelId,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name, strict: true, schema: jsonSchema as Record<string, unknown> },
          },
        });

        const message = response.choices[0]?.message;
        // A structured-output refusal is returned in its own field and is not
        // retryable: the same prompt refuses again.
        if (message?.refusal) {
          logger.warn({ name, refusal: message.refusal }, "llm refused the request");
          return null;
        }
        const content = message?.content;
        if (!content) continue;
        const parsed = schema.safeParse(JSON.parse(content));
        if (parsed.success) return parsed.data;
        logger.warn({ name, attempt, issues: parsed.error.issues }, "llm output failed schema");
      } catch (error) {
        logger.warn({ err: error, name, attempt }, "llm call failed");
      }
    }
    return null;
  }
}

class UnavailableLlmClient implements LlmClient {
  readonly available = false;
  readonly modelId = null;
  async extractRenewalFromText(): Promise<ParsedRenewal | null> {
    return null;
  }
  async explainDecision(): Promise<DecisionNarrative | null> {
    return null;
  }
}

let client: LlmClient | null = null;

export function getLlmClient(): LlmClient {
  if (!client) {
    client = env.LLM_API_KEY ? new OpenAiLlmClient(env.LLM_API_KEY) : new UnavailableLlmClient();
  }
  return client;
}

/** Tests inject a double; passing null restores the env-derived client. */
export function setLlmClient(next: LlmClient | null): void {
  client = next;
}

export const unavailableLlmClient = (): LlmClient => new UnavailableLlmClient();
