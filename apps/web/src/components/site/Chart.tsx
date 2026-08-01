"use client";

/**
 * Twelve months of recurring spend, net of everything returned. The visual
 * distinguishes a detected opportunity from money that actually left the bill.
 *
 * The geometry is computed once at module scope; only the hover readout is
 * state, so moving the pointer never re-renders the path.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const SPEND = [8634, 8598, 8544, 8544, 8448, 8352, 8352, 8180, 8024, 7840, 7552, 7398];
const MONTH = [
  "August", "September", "October", "November", "December", "January",
  "February", "March", "April", "May", "June", "July",
];

const W = 1000;
const H = 340;
const PX = 24;
const PY = 38;

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** Pad below the true minimum — a hard zero baseline flattens the year into a ribbon. */
const HI = Math.max(...SPEND);
const LO = Math.min(...SPEND);
const MIN = LO - (HI - LO) * 0.7;
const MAX = HI + (HI - LO) * 0.25;

const POINTS = SPEND.map((n, i): [number, number] => [
  PX + (i / (SPEND.length - 1)) * (W - PX * 2),
  H - PY - ((n - MIN) / (MAX - MIN)) * (H - PY * 2),
]);

const LINE = POINTS.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const AREA = `${LINE} L${POINTS[POINTS.length - 1][0]},${H} L${POINTS[0][0]},${H} Z`;

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export function Chart() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState(SPEND.length - 1);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          obs.unobserve(e.target);
          setDrawn(true);
        });
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const step = (W - PX * 2) / (SPEND.length - 1);
    const i = clamp(Math.round((((e.clientX - r.left) / r.width) * W - PX) / step), 0, SPEND.length - 1);
    setHover(i);
  }, []);

  const saved = SPEND[0] - SPEND[SPEND.length - 1];
  const percentage = (saved / SPEND[0]) * 100;
  const [x, y] = POINTS[hover];

  return (
    <div className="spend-card up" data-d="120">
      <div className="spend-summary">
        <div className="spend-primary">
          <span>Realized this year</span>
          <strong>{money(saved)}</strong>
          <small>returned to the operating account</small>
        </div>
        <dl>
          <div>
            <dt>Starting run-rate</dt>
            <dd>{money(SPEND[0])}</dd>
          </div>
          <div>
            <dt>Current run-rate</dt>
            <dd>{money(SPEND[SPEND.length - 1])}</dd>
          </div>
          <div>
            <dt>Change</dt>
            <dd className="gain">−{percentage.toFixed(1)}%</dd>
          </div>
        </dl>
      </div>

      <div className="chart-stage" onPointerMove={onMove}>
        <svg
          className={`spend-chart${drawn ? " in" : ""}`}
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Recurring annual spend declined from ${money(SPEND[0])} in August to ${money(SPEND[SPEND.length - 1])} in July.`}
        >
          <defs>
            <linearGradient id="spendArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity=".2" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[70, 150, 230, 310].map((gy) => (
            <line className="chart-grid" key={gy} x1="0" y1={gy} x2={W} y2={gy} />
          ))}
          <path className="chart-area" d={AREA} />
          <path className="chart-line" d={LINE} pathLength="1" />
          <line className="chart-cursor" x1={x} y1="20" x2={x} y2={H} />
          <circle className="chart-point-halo" cx={x} cy={y} r="11" />
          <circle className="chart-point" cx={x} cy={y} r="4" />
        </svg>

        <div
          className={`chart-tooltip${hover === 0 ? " is-first" : hover === SPEND.length - 1 ? " is-last" : ""}`}
          style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` }}
          aria-live="polite"
        >
          <b>{money(SPEND[hover])}</b>
          <span>
            {MONTH[hover]}
            {hover ? ` · ${money(SPEND[0] - SPEND[hover])} returned` : " · baseline"}
          </span>
        </div>
      </div>

      <div className="chart-months" aria-hidden="true">
        {MONTH.map((month) => <span key={month}>{month.slice(0, 3)}</span>)}
      </div>

      <div className="spend-foot">
        <span><i className="receipt-mark" /> Receipt-verified run-rate</span>
        <span>Move across the line to inspect the year</span>
      </div>
    </div>
  );
}
