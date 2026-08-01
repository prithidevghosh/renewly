"use client";

/**
 * ── THE SEAL ──────────────────────────────────────────────────────────────
 *
 * Renewly's mark: a struck seal. A hairline double ring with a serif R set in
 * claret — the kind of thing that gets embossed on the corner of a statement.
 *
 * It is the logo, the agent's avatar in the transcript, and the working
 * indicator. Its state is legible without a single glow, gradient or spinner:
 * a small claret tick sits on the ring and breathes while the agent is busy,
 * and the ring itself goes claret once an action has settled.
 *
 *   idle      watching                  static
 *   scanning  reading receipts          tick breathing, slow
 *   thinking  composing a proposal      tick breathing, quicker
 *   acting    moving money              full claret ring
 *   settled   done                      full claret ring, tick at rest
 */

import { cx } from "@/lib/format";

export type MarkState = "idle" | "scanning" | "thinking" | "acting" | "settled";

export function Mark({
  state = "idle",
  size = 32,
  className,
}: {
  state?: MarkState;
  size?: number;
  className?: string;
}) {
  const busy = state === "scanning" || state === "thinking";
  const struck = state === "acting" || state === "settled";

  return (
    <span
      className={cx("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
      data-state={state}
    >
      <svg
        viewBox="0 0 48 48"
        width={size}
        height={size}
        fill="none"
        role="img"
        aria-label={`Renewly — ${state}`}
      >
        {/* Double ring, struck */}
        <circle
          cx="24"
          cy="24"
          r="23"
          stroke={struck ? "var(--claret)" : "var(--rule-ink)"}
          strokeWidth="1"
          style={{ transition: "stroke var(--dur-slow) var(--ease-settle)" }}
        />
        <circle
          cx="24"
          cy="24"
          r="19.5"
          stroke={struck ? "var(--claret-line)" : "var(--rule)"}
          strokeWidth="1"
          style={{ transition: "stroke var(--dur-slow) var(--ease-settle)" }}
        />

        {/* The monogram */}
        <text
          x="24"
          y="24"
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--claret)"
          fontFamily="var(--font-newsreader), Georgia, serif"
          fontSize="22"
          fontWeight="400"
          style={{ letterSpacing: "0.01em" }}
        >
          R
        </text>

        {/* Working tick — sits on the ring at 12 o'clock */}
        {(busy || struck) && (
          <circle
            cx="24"
            cy="1"
            r="2"
            fill="var(--claret)"
            className={busy ? "pulse-soft" : undefined}
            style={busy ? { animationDuration: state === "thinking" ? "1.1s" : "2.2s" } : undefined}
          />
        )}
      </svg>
    </span>
  );
}

/** Lock-up: the seal plus the wordmark. Used in nav, footer and the app rail. */
export function Wordmark({
  size = 28,
  state = "idle",
  className,
}: {
  size?: number;
  state?: MarkState;
  className?: string;
}) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <Mark size={size} state={state} />
      <span className="font-serif text-[1.25rem] leading-none tracking-[-0.015em] text-ink">
        Renewly
      </span>
    </span>
  );
}
