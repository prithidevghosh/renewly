"use client";

import { cx } from "@/lib/format";

/* -------------------------------------------------------------------------- */
/* Card — white leaf on ivory ground, held by a hairline. No shadow.           */
/* -------------------------------------------------------------------------- */

export function Card({
  className,
  children,
  interactive = false,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cx(
        "rounded-lg border border-rule bg-card",
        interactive && "transition-colors duration-[var(--dur-quick)] hover:border-rule-firm",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Marker — a short claret rule, then a sentence-case label.                    */
/* Replaces the uppercase micro-caps eyebrow entirely.                          */
/* -------------------------------------------------------------------------- */

export function Marker({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cx("marker", className)}>{children}</p>;
}

/** Quiet metadata label. Sentence case — never uppercase. */
export function Label({
  children,
  className,
  as: As = "p",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "p" | "span" | "dt";
}) {
  return <As className={cx("label", className)}>{children}</As>;
}

/* -------------------------------------------------------------------------- */
/* Tag — status. Quiet, bordered, sentence case, always carries a word.        */
/* -------------------------------------------------------------------------- */

export type TagTone = "neutral" | "claret" | "forest";

const tagTones: Record<TagTone, string> = {
  neutral: "border-rule-firm text-ink-3 bg-sunk",
  claret: "border-claret/30 text-claret bg-[var(--claret-soft)]",
  forest: "border-forest/30 text-forest bg-[var(--forest-soft)]",
};

export function Tag({
  tone = "neutral",
  children,
  className,
}: {
  tone?: TagTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-[2px]",
        "text-[0.6875rem] font-medium leading-[1.35]",
        tagTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Vendor mark — set in the serif, like an initial in a ledger column.          */
/* -------------------------------------------------------------------------- */

export function VendorMark({
  initials,
  size = 32,
  muted = false,
}: {
  initials: string;
  size?: number;
  muted?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center rounded-sm border font-serif",
        muted ? "border-rule bg-sunk text-ink-4" : "border-rule-firm bg-sunk text-ink-2",
      )}
      style={{ width: size, height: size, fontSize: size * 0.42, lineHeight: 1 }}
    >
      {initials}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                        */
/* -------------------------------------------------------------------------- */

export function Rule({ className, fade = false }: { className?: string; fade?: boolean }) {
  return (
    <div
      role="separator"
      className={cx(fade ? "rule-fade" : "h-px w-full bg-rule", className)}
      aria-hidden
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                     */
/* -------------------------------------------------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-xs bg-sunk",
        "after:absolute after:inset-0 after:-translate-x-full",
        "after:bg-gradient-to-r after:from-transparent after:via-[rgb(25_23_18_/_0.04)] after:to-transparent",
        "after:animate-[shimmer_1.6s_infinite] motion-reduce:after:hidden",
        className,
      )}
      aria-hidden
    />
  );
}
