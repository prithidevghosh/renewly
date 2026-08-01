"use client";

/**
 * Character-by-character reveal for agent messages.
 *
 * This is not a typewriter gimmick — it is the honest representation of an
 * agent composing (DESIGN.md §4.3). Under `prefers-reduced-motion` it resolves
 * instantly to the full string, and the whole text is exposed to assistive
 * tech as one `aria-live` announcement rather than per-character noise.
 *
 * ⚠️  No LLM is involved. Bodies are scripted from mock data.
 */

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cx } from "@/lib/format";

const MS_PER_CHAR = 16;

export function StreamingText({
  text,
  instant = false,
  startDelay = 0,
  onDone,
  className,
  showCaret = true,
}: {
  text: string;
  /** Skip the reveal (replayed history). */
  instant?: boolean;
  startDelay?: number;
  onDone?: () => void;
  className?: string;
  showCaret?: boolean;
}) {
  const reduce = useReducedMotion();
  const skip = instant || reduce;
  const [shown, setShown] = useState(skip ? text.length : 0);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (skip) {
      setShown(text.length);
      if (!doneRef.current) {
        doneRef.current = true;
        onDoneRef.current?.();
      }
      return;
    }

    doneRef.current = false;
    setShown(0);
    let raf = 0;

    const begin = () => {
      const start = performance.now();
      const tick = (now: number) => {
        const chars = Math.floor((now - start) / MS_PER_CHAR);
        if (chars >= text.length) {
          setShown(text.length);
          if (!doneRef.current) {
            doneRef.current = true;
            onDoneRef.current?.();
          }
          return;
        }
        setShown(chars);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const timer = setTimeout(begin, startDelay);

    // Failsafe. The reveal is driven by requestAnimationFrame, which stops in
    // background tabs. An agent message that never finishes streaming would be
    // permanently blank, so a timer guarantees the full text lands.
    const settle = setTimeout(
      () => {
        setShown(text.length);
        if (!doneRef.current) {
          doneRef.current = true;
          onDoneRef.current?.();
        }
      },
      startDelay + text.length * MS_PER_CHAR + 400,
    );

    return () => {
      clearTimeout(timer);
      clearTimeout(settle);
      cancelAnimationFrame(raf);
    };
  }, [text, skip, startDelay]);

  const complete = shown >= text.length;

  return (
    <span className={cx("relative", className)}>
      {/* Screen readers get the finished sentence once, not 400 mutations. */}
      <span className="sr-only" aria-live="polite">
        {complete ? text : ""}
      </span>
      <span aria-hidden>
        {text.slice(0, shown)}
        {!complete && showCaret && (
          <span
            className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.12em] bg-forest align-baseline"
            style={{ animation: "caret 1s steps(1) infinite" }}
          />
        )}
      </span>
    </span>
  );
}
