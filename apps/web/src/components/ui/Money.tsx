"use client";

/**
 * Money, set the way a statement sets it (DESIGN.md §3.2).
 *
 * Figures are LINING TABULAR numerals in the text faces — never monospace.
 * Mono reads as machine output; this product is asking to be trusted like an
 * institution, and institutions set their figures in their text face. Tabular
 * widths keep columns aligned and stop a counting figure reflowing its own box.
 *
 * Colour convention follows accounting, not decoration:
 *   money saved  → forest (the only positive colour in the system)
 *   money owed   → ink
 *   money at risk→ claret
 */

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cx, money, moneyCompact } from "@/lib/format";
import type { Cents } from "@/lib/domain/types";

type Tone = "default" | "saving" | "cost" | "muted" | "risk";

const tones: Record<Tone, string> = {
  default: "text-ink",
  saving: "text-forest",
  cost: "text-ink-2",
  muted: "text-ink-4",
  risk: "text-claret",
};

function useCountUp(target: number, duration = 560, enabled = true) {
  const reduce = useReducedMotion();
  const [value, setValue] = useState(enabled && !reduce ? 0 : target);
  const frame = useRef<number>(undefined);
  const from = useRef(0);

  useEffect(() => {
    if (!enabled || reduce) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    const delta = target - origin;

    const tick = (now: number) => {
      // Clamp BOTH ends. A non-monotonic clock can hand us now < start, and an
      // unclamped negative t drives the expo curve to a large negative — which
      // renders as a negative dollar figure.
      const t = Math.max(0, Math.min(1, (now - start) / duration));
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setValue(Math.round(origin + delta * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else from.current = target;
    };

    frame.current = requestAnimationFrame(tick);

    // Failsafe: rAF is throttled to a standstill in background tabs. Without
    // this a money figure can sit at its start value forever and show $0.00.
    const settle = setTimeout(() => {
      setValue(target);
      from.current = target;
    }, duration + 300);

    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      clearTimeout(settle);
    };
  }, [target, duration, enabled, reduce]);

  return value;
}

export function Money({
  value,
  tone = "default",
  cents = true,
  sign = false,
  compact = false,
  animate = false,
  className,
  suffix,
}: {
  value: Cents;
  tone?: Tone;
  cents?: boolean;
  sign?: boolean;
  compact?: boolean;
  animate?: boolean;
  className?: string;
  suffix?: string;
}) {
  const shown = useCountUp(value, 560, animate);

  return (
    <span className={cx("figure", tones[tone], className)}>
      {compact ? moneyCompact(shown) : money(shown, { cents, sign })}
      {suffix && <span className="ml-0.5 text-[0.82em] font-normal text-ink-4">{suffix}</span>}
    </span>
  );
}

/**
 * The display figure — set in the serif at annual-report scale. Used for the
 * one number that matters on a page, never for table cells.
 */
export function BigMoney({
  value,
  animate = true,
  suffix,
  className,
  tone = "saving",
  cents = false,
}: {
  value: Cents;
  animate?: boolean;
  suffix?: string;
  className?: string;
  tone?: Tone;
  cents?: boolean;
}) {
  const shown = useCountUp(value, 900, animate);
  return (
    <span className={cx("figure-display text-display-m", tones[tone], className)}>
      {money(shown, { cents })}
      {suffix && (
        <span className="ml-1.5 font-sans text-[0.36em] font-medium tracking-normal text-ink-4">
          {suffix}
        </span>
      )}
    </span>
  );
}
