/**
 * How far back a mailbox sweep reads.
 *
 * Expressed in days rather than months because the shortest window offered is
 * a fortnight, and because a day count is unambiguous at a month boundary —
 * "one month back" from the 31st is a question, "30 days back" is not.
 *
 * The value travels on the agent session's `state`, so a resumed run reads the
 * same window it started with rather than silently widening.
 */

export const LOOKBACK_DAYS = [15, 30, 60, 90] as const;

export type LookbackDays = (typeof LOOKBACK_DAYS)[number];

/**
 * A month of receipts is enough to see every monthly plan at least once, and
 * it is the cheapest window that still answers "what am I paying for". Wider
 * windows are opt-in because each one re-reads the mailbox in full.
 */
export const DEFAULT_LOOKBACK_DAYS: LookbackDays = 30;

const LABELS: Record<LookbackDays, string> = {
  15: "15 days",
  30: "1 month",
  60: "2 months",
  90: "3 months",
};

export function isLookbackDays(value: unknown): value is LookbackDays {
  return (
    typeof value === "number" && (LOOKBACK_DAYS as readonly number[]).includes(value)
  );
}

/** How a window is said in a transcript line. */
export function lookbackLabel(days: number): string {
  if (isLookbackDays(days)) return LABELS[days];
  return `${days} days`;
}

/**
 * The window for a run, from whatever its session state carries. An absent or
 * unrecognised value falls back to the default rather than throwing: a session
 * row written before this option existed must still be resumable.
 */
export function lookbackFromState(state: Record<string, unknown>): LookbackDays {
  const raw = state.lookbackDays;
  return isLookbackDays(raw) ? raw : DEFAULT_LOOKBACK_DAYS;
}
