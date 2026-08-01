/**
 * Turns a chat reply into an intent. This runs on every inbound message, so it
 * is deliberately deterministic and free of model calls: a user who types
 * "approve" must never wait on an LLM, and must never have "no, don't" read as
 * consent.
 */

export type Intent =
  | "APPROVE"
  | "KEEP"
  | "CANCEL"
  | "SNOOZE"
  | "WHY"
  | "STOP"
  | "HELP"
  | "RETRY"
  | "DONE"
  | "UNKNOWN";

export interface ParsedIntent {
  intent: Intent;
  confidence: number;
  /** What in the message triggered the match, for the audit trail. */
  matchedOn: string;
}

/**
 * Negation is checked before anything else. "not approving this" and "don't
 * cancel" both contain a keyword that would otherwise fire, and getting either
 * wrong moves real money.
 */
const NEGATION_RE =
  /\b(no|not|nope|don'?t|do not|never|stop|cancel that|nah|negative|hold off|wait)\b/i;

const RULES: Array<{ intent: Intent; re: RegExp; weight: number }> = [
  // Approval. Tapbacks and emoji are first-class: on iMessage a thumbs-up is
  // the most natural way to say yes.
  { intent: "APPROVE", re: /^\s*(approve|approved|yes|yep|yeah|yup|ok|okay|k|go|do it|send it|confirm|confirmed|proceed|ship it|sure|please do|go ahead)\s*[.!]?\s*$/i, weight: 0.97 },
  { intent: "APPROVE", re: /^\s*(👍|👌|✅|💯|🙌|❤️|🔥)\s*$/u, weight: 0.9 },
  { intent: "APPROVE", re: /\b(approve|approved|go ahead|do it|please proceed)\b/i, weight: 0.82 },

  { intent: "DONE", re: /^\s*(done|did it|completed|cancelled it|canceled it|finished|sorted)\s*[.!]?\s*$/i, weight: 0.95 },
  { intent: "DONE", re: /\b(i (?:have )?(?:cancelled|canceled|removed|downgraded)|already (?:cancelled|canceled|done))\b/i, weight: 0.85 },

  { intent: "KEEP", re: /^\s*(keep|keep it|leave it|no change|hold|as is|skip)\s*[.!]?\s*$/i, weight: 0.95 },
  { intent: "KEEP", re: /\b(keep it|leave it (?:alone|as is)|don'?t change|no change)\b/i, weight: 0.86 },

  { intent: "CANCEL", re: /^\s*(cancel|cancel it|kill it|drop it|end it|terminate)\s*[.!]?\s*$/i, weight: 0.94 },
  { intent: "CANCEL", re: /\b(cancel (?:it|this|the subscription)|kill this)\b/i, weight: 0.85 },
  // A bare "cancel" anywhere, at low weight. Its real job is to make negation
  // visible: without it, "no, do not cancel" matches nothing and reads as
  // UNKNOWN rather than as the refusal it plainly is.
  { intent: "CANCEL", re: /\bcancel(?:s|ling|led|ing)?\b/i, weight: 0.62 },

  { intent: "SNOOZE", re: /^\s*(later|snooze|not now|remind me|tomorrow|next week|defer)\s*[.!]?\s*$/i, weight: 0.94 },
  { intent: "SNOOZE", re: /\b(remind me|ask me later|not right now|come back)\b/i, weight: 0.84 },

  { intent: "WHY", re: /^\s*(why|why\?|explain|details|how come|reason|more info)\s*[.?!]?\s*$/i, weight: 0.95 },
  { intent: "WHY", re: /\b(why (?:is|are|do|did|would|should)|explain (?:that|this|why)|what'?s the (?:reason|math))\b/i, weight: 0.85 },

  { intent: "STOP", re: /^\s*(stop|unsubscribe|quit|end|opt out|leave me alone)\s*[.!]?\s*$/i, weight: 0.96 },
  { intent: "STOP", re: /\b(stop (?:messaging|texting|contacting) me|unsubscribe)\b/i, weight: 0.9 },

  { intent: "HELP", re: /^\s*(help|commands|\?|what can you do|options)\s*$/i, weight: 0.94 },
  { intent: "HELP", re: /\b(what can you do|how does this work|list commands)\b/i, weight: 0.8 },

  { intent: "RETRY", re: /^\s*(retry|try again|again|resend)\s*[.!]?\s*$/i, weight: 0.94 },
  { intent: "RETRY", re: /\b(try (?:it )?again|run it again|retry that)\b/i, weight: 0.84 },
];

/** Reactions that carry meaning on their own, independent of any text. */
const TAPBACK_INTENTS: Record<string, Intent> = {
  like: "APPROVE",
  love: "APPROVE",
  thumbsup: "APPROVE",
  "👍": "APPROVE",
  "❤️": "APPROVE",
  dislike: "KEEP",
  thumbsdown: "KEEP",
  "👎": "KEEP",
  question: "WHY",
  "?": "WHY",
};

export interface ParseIntentInput {
  text: string;
  /** A tapback or reaction, when the channel reports one. */
  tapback?: string | null;
}

export function parseIntent(input: ParseIntentInput | string): ParsedIntent {
  const normalized: ParseIntentInput =
    typeof input === "string" ? { text: input } : input;

  // A reaction is unambiguous and needs no text analysis.
  if (normalized.tapback) {
    const key = normalized.tapback.toLowerCase().trim();
    const mapped = TAPBACK_INTENTS[key];
    if (mapped) return { intent: mapped, confidence: 0.93, matchedOn: `tapback:${key}` };
  }

  const text = (normalized.text ?? "").trim();
  if (!text) return { intent: "UNKNOWN", confidence: 0, matchedOn: "empty" };

  // STOP is checked before negation: "no, stop messaging me" is still STOP.
  const stopRule = RULES.find((rule) => rule.intent === "STOP" && rule.re.test(text));
  if (stopRule) {
    return { intent: "STOP", confidence: stopRule.weight, matchedOn: text.slice(0, 60) };
  }

  const negated = NEGATION_RE.test(text);

  let best: ParsedIntent | null = null;
  for (const rule of RULES) {
    if (!rule.re.test(text)) continue;

    // "don't approve" must not approve. It is a refusal, which is KEEP.
    if (negated && (rule.intent === "APPROVE" || rule.intent === "DONE")) {
      return { intent: "KEEP", confidence: 0.75, matchedOn: `negated:${text.slice(0, 60)}` };
    }
    if (negated && rule.intent === "CANCEL") {
      return { intent: "KEEP", confidence: 0.7, matchedOn: `negated:${text.slice(0, 60)}` };
    }

    if (!best || rule.weight > best.confidence) {
      best = { intent: rule.intent, confidence: rule.weight, matchedOn: text.slice(0, 60) };
    }
  }

  return best ?? { intent: "UNKNOWN", confidence: 0, matchedOn: text.slice(0, 60) };
}

/** Intents that mean "act on the proposal". */
export const AFFIRMATIVE_INTENTS: readonly Intent[] = ["APPROVE"] as const;

/** Intents that close the approval without acting. */
export const DECLINING_INTENTS: readonly Intent[] = ["KEEP", "STOP"] as const;

export const isAffirmative = (intent: Intent): boolean => AFFIRMATIVE_INTENTS.includes(intent);
export const isDeclining = (intent: Intent): boolean => DECLINING_INTENTS.includes(intent);
