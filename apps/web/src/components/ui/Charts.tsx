"use client";

/**
 * Hand-rolled SVG charts, drawn like figures in a printed report: hairline
 * rules, ink strokes, no fills that aren't carrying meaning, no chartjunk.
 * Deliberately not a charting library — every default would have to be undone.
 */

import { cx } from "@/lib/format";

/* -------------------------------------------------------------------------- */
/* Sparkline — 12-month spend trail inside a table row                          */
/* -------------------------------------------------------------------------- */

export function Sparkline({
  data,
  width = 64,
  height = 20,
  tone = "neutral",
  className,
}: {
  data: number[];
  width?: number;
  height?: number;
  tone?: "neutral" | "forest" | "claret" | "faint";
  className?: string;
}) {
  if (data.length < 2) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pad = 2;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (width - pad * 2) + pad;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  const d = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");

  const stroke =
    tone === "forest"
      ? "var(--forest)"
      : tone === "claret"
        ? "var(--claret)"
        : tone === "faint"
          ? "var(--ink-5)"
          : "var(--ink-4)";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      className={cx("overflow-visible", className)}
      aria-hidden
    >
      <path d={d} stroke={stroke} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      <circle
        cx={points[points.length - 1][0]}
        cy={points[points.length - 1][1]}
        r="1.5"
        fill={stroke}
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Spend line — the 12-month curve. A single ink stroke over hairline rules.    */
/* -------------------------------------------------------------------------- */

export function SpendLine({
  data,
  labels,
  height = 160,
  className,
}: {
  data: number[];
  labels?: string[];
  height?: number;
  className?: string;
}) {
  const width = 720;
  const padY = 18;

  const max = Math.max(...data) * 1.06;
  const min = Math.min(...data) * 0.9;
  const span = max - min || 1;

  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - padY - ((v - min) / span) * (height - padY * 2);
    return [x, y] as const;
  });

  // Catmull-Rom → cubic Bézier. Smooth without overshooting the data.
  let line = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    line += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }

  return (
    <div className={cx("relative w-full", className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        aria-hidden
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={width}
            y1={height * f}
            y2={height * f}
            stroke="var(--rule)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path
          d={line}
          stroke="var(--ink)"
          strokeWidth="1.25"
          fill="none"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      </svg>

      {labels && (
        <div className="mt-2.5 flex justify-between text-[0.6875rem] text-ink-4">
          {labels.map((l, i) => (
            <span key={`${l}-${i}`} className={i % 2 === 1 ? "hidden sm:inline" : undefined}>
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Allocation — a ruled list, not a pie chart. Reads like a table of contents.  */
/* -------------------------------------------------------------------------- */

export function Allocation({
  segments,
  className,
}: {
  segments: { label: string; value: number }[];
  className?: string;
}) {
  const total = segments.reduce((t, s) => t + s.value, 0) || 1;

  return (
    <ul className={cx("divide-y divide-[var(--rule)]", className)}>
      {segments.map((s) => {
        const pct = (s.value / total) * 100;
        return (
          <li key={s.label} className="flex items-center gap-3 py-2">
            <span className="w-28 shrink-0 truncate text-caption text-ink-2">{s.label}</span>
            <span className="relative h-[3px] flex-1 bg-sunk">
              <span
                className="absolute inset-y-0 left-0 bg-ink-3"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="figure w-9 shrink-0 text-right text-caption text-ink-4">
              {Math.round(pct)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}
