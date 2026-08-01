"use client";

/**
 * The loop, playing by itself.
 *
 * A self-contained, looping dramatisation of Detect → Propose → Approve →
 * Execute → Prove. It reuses the real seed opportunity from `mockData`, so the
 * numbers on the marketing page can never drift from the numbers in the product.
 *
 * Implementation note — entrances here are **pure CSS keyframes, not JS
 * animation**. This is the centrepiece of the marketing page; it must never
 * render an empty frame because a requestAnimationFrame callback was throttled
 * (background tab, reduced-perf device, headless capture). CSS animations are
 * driven by the compositor and always resolve to their final state.
 *
 * Behaviour:
 *   · pauses when scrolled out of view (IntersectionObserver)
 *   · the phase list is clickable — clicking takes manual control
 *   · under prefers-reduced-motion autoplay is off and it opens on "Prove",
 *     so the payoff is visible without a single animation
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Check, Fingerprint, Pause, Play } from "lucide-react";
import { Mark, type MarkState } from "@/components/brand/Mark";
import { Money } from "@/components/ui/Money";
import { StreamingText } from "@/components/ui/StreamingText";
import { Tag, VendorMark } from "@/components/ui/Primitives";
import { opportunities, ledger } from "@/lib/mock/mockData";
import { cx, money } from "@/lib/format";

const OPP = opportunities.find((o) => o.id === "opp_figma_seats")!;
const BASELINE = ledger
  .filter((e) => e.type === "executed")
  .reduce((t, e) => t + e.deltaCentsPerYear, 0);

const PHASES = [
  {
    key: "detect",
    label: "Detect",
    blurb: "Reads the receipt before you do.",
    ms: 2600,
    agent: "scanning",
  },
  {
    key: "propose",
    label: "Propose",
    blurb: "States the action and the dollars.",
    ms: 5200,
    agent: "thinking",
  },
  {
    key: "approve",
    label: "Approve",
    blurb: "One passkey. Every time money moves.",
    ms: 3000,
    agent: "thinking",
  },
  {
    key: "execute",
    label: "Execute",
    blurb: "Completes it on a single-use card.",
    ms: 4600,
    agent: "acting",
  },
  {
    key: "prove",
    label: "Prove",
    blurb: "Writes the receipt to your ledger.",
    ms: 4200,
    agent: "settled",
  },
] as const;

type PhaseKey = (typeof PHASES)[number]["key"];

export function LoopDemo() {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(reduce ? 4 : 0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const [cycle, setCycle] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  const phase = PHASES[index];

  /* Only run while on screen. */
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setVisible(entries[0]?.isIntersecting ?? false),
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* The clock. */
  useEffect(() => {
    if (!playing || !visible || reduce) return;
    const t = setTimeout(() => {
      setIndex((i) => {
        const next = (i + 1) % PHASES.length;
        if (next === 0) setCycle((c) => c + 1);
        return next;
      });
    }, phase.ms);
    return () => clearTimeout(t);
  }, [index, playing, visible, reduce, phase.ms]);

  const jump = useCallback((i: number) => {
    setPlaying(false);
    setIndex(i);
  }, []);

  const at = (k: PhaseKey) => PHASES.findIndex((p) => p.key === k) <= index;
  const savings = at("prove") ? BASELINE + OPP.savingCentsPerYear : BASELINE;
  const anim = reduce ? undefined : "stage-in";

  return (
    <div ref={frameRef} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
      {/* ── The screen ─────────────────────────────────────────────────── */}
      <div className="relative order-2 lg:order-1">
        <div className="relative overflow-hidden rounded-xl border border-rule-firm bg-card">
          {/* Frame chrome */}
          <div className="flex items-center justify-between border-b border-rule bg-paper/60 px-4 py-2.5">
            <div className="flex items-center gap-2.5">
              <Mark size={20} state={phase.agent as MarkState} />
              <span className="label">
                Renewly · {phase.label}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Tag tone="neutral">simulated</Tag>
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="rounded-md p-1 text-ink-4 transition-colors hover:text-ink-2"
                aria-label={playing ? "Pause demo" : "Play demo"}
              >
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              </button>
            </div>
          </div>

          {/* Stage */}
          <div className="relative min-h-[26rem] p-4 sm:min-h-[27rem] sm:p-5">
            <div className="space-y-4">
              {/* Detect */}
              {at("detect") && (
                <div
                  key={`detect-${cycle}`}
                  className={cx(
                    "flex items-center gap-3 rounded-lg border border-claret/25 bg-[var(--claret-soft)] px-3.5 py-3",
                    anim,
                  )}
                >
                  <VendorMark initials="Fi" size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="label text-claret">Renewal detected</p>
                    <p className="mt-0.5 text-body-s text-ink-2">
                      Figma · <span className="figure">{money(57_600)}</span> in 2 days ·
                      3 of 4 seats idle
                    </p>
                  </div>
                </div>
              )}

              {/* Propose */}
              {at("propose") && (
                <div key={`propose-${cycle}`} className={cx("flex gap-3", anim)}>
                  <Mark size={20} state="idle" className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-body-s leading-relaxed text-ink-2">
                      <StreamingText
                        key={`stream-${cycle}`}
                        text="I'd renew on one editor and move the other three to free viewer access. Nobody loses anything they're using."
                        instant={reduce || index > 1}
                      />
                    </p>

                    <div className="mt-3 overflow-hidden rounded-lg border border-rule-firm bg-sunk">
                      <div className="flex items-end justify-between gap-4 p-3.5">
                        <div>
                          <p className="label">You save</p>
                          <Money
                            value={OPP.savingCentsPerYear}
                            tone="saving"
                            suffix="/yr"
                            className="text-title-l font-medium tracking-[-0.025em]"
                          />
                        </div>
                        <div className="text-right figure text-caption figure text-ink-4">
                          <p className="line-through decoration-ink-4/50">{money(57_600)}</p>
                          <p className="text-ink-2">{money(14_400)}</p>
                        </div>
                      </div>
                      <div className="flex h-1.5 bg-sunk">
                        <div
                          className={cx("h-full w-[75%] bg-forest", !reduce && "grow-x")}
                          style={{ animationDelay: "400ms" }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Execute */}
              {at("execute") && (
                <div key={`execute-${cycle}`} className={anim}>
                  <ExecuteTrace
                    steps={OPP.steps}
                    running={index === 3 && playing && !reduce}
                    allDone={index > 3 || !!reduce}
                    cycle={cycle}
                  />
                </div>
              )}

              {/* Prove */}
              {at("prove") && (
                <div
                  key={`prove-${cycle}`}
                  className={cx(
                    "flex items-center justify-between gap-4 rounded-lg border border-forest/25 bg-[var(--forest-soft)] px-4 py-3.5",
                    !reduce && "stamp-in",
                  )}
                >
                  <div className="min-w-0">
                    <p className="label">Ledger · entry 012</p>
                    <p className="mt-0.5 truncate text-body-s text-ink-2">
                      Renewed Figma on 1 editor · charged {money(14_400)}
                    </p>
                  </div>
                  <Money
                    value={OPP.savingCentsPerYear}
                    tone="saving"
                    sign
                    suffix="/yr"
                    className="shrink-0 text-title-s"
                  />
                </div>
              )}
            </div>

            {/* Approve — overlays the stage */}
            {index === 2 && (
              <div
                key={`approve-${cycle}`}
                className={cx(
                  "absolute inset-0 grid place-items-center bg-paper/85 backdrop-blur-[3px]",
                  !reduce && "fade-in",
                )}
              >
                <div
                  className={cx(
                    "w-[min(20rem,90%)] rounded-xl border border-rule-firm bg-card p-5 text-center",
                    !reduce && "stage-in",
                  )}
                >
                  <PasskeyPulse cycle={cycle} reduce={!!reduce} />
                  <p className="mt-4 text-body font-medium text-ink">Approve $144.00 renewal</p>
                  <p className="mt-1 text-body-s text-ink-3">
                    Single-use card, capped. Touch ID required.
                  </p>
                  <div className="mt-4 h-9 rounded-md bg-forest text-paper">
                    <span className="flex h-full items-center justify-center gap-2 text-[0.875rem] font-semibold">
                      <Fingerprint className="size-4" />
                      Approved
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Running total */}
          <div className="flex items-center justify-between border-t border-rule bg-paper/60 px-4 py-3">
            <span className="label">Saved this year</span>
            <Money value={savings} tone="saving" animate className="text-title-s" />
          </div>
        </div>
      </div>

      {/* ── The phase list ─────────────────────────────────────────────── */}
      <ol className="order-1 flex gap-2 overflow-x-auto pb-2 lg:order-2 lg:flex-col lg:gap-0 lg:overflow-visible lg:pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {PHASES.map((p, i) => {
          const active = i === index;
          const passed = i < index;
          return (
            <li key={p.key} className="shrink-0 lg:shrink">
              <button
                type="button"
                onClick={() => jump(i)}
                aria-current={active ? "step" : undefined}
                className={cx(
                  "group relative flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors lg:px-3.5 lg:py-4",
                  active ? "bg-sunk" : "hover:bg-hover",
                )}
              >
                <span
                  className={cx(
                    "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border figure text-[0.5625rem] transition-colors",
                    active
                      ? "border-forest bg-forest text-paper"
                      : passed
                        ? "border-forest/30 text-forest"
                        : "border-rule-firm text-ink-4",
                  )}
                >
                  {passed && !active ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className={cx(
                      "block whitespace-nowrap text-body font-medium transition-colors lg:whitespace-normal",
                      active ? "text-ink" : "text-ink-3",
                    )}
                  >
                    {p.label}
                  </span>
                  <span className="mt-0.5 hidden text-body-s text-ink-4 lg:block">{p.blurb}</span>
                </span>

                {/* Timing bar */}
                {active && playing && !reduce && (
                  <span
                    key={`bar-${index}-${cycle}`}
                    className="grow-x absolute inset-x-3 bottom-1 h-px bg-forest/50 lg:inset-x-3.5"
                    style={{ animationDuration: `${p.ms}ms`, animationTimingFunction: "linear" }}
                    aria-hidden
                  />
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ExecuteTrace({
  steps,
  running,
  allDone,
  cycle,
}: {
  steps: readonly string[];
  running: boolean;
  allDone: boolean;
  cycle: number;
}) {
  const [done, setDone] = useState(allDone ? steps.length : 0);

  useEffect(() => {
    if (allDone) {
      setDone(steps.length);
      return;
    }
    if (!running) return;
    setDone(0);
    const timers = steps.map((_, i) => setTimeout(() => setDone(i + 1), 700 * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [running, allDone, steps, cycle]);

  return (
    <div className="rounded-lg border border-rule bg-sunk">
      <div className="border-b border-rule px-3.5 py-2 label">
        {done >= steps.length ? "Execution complete" : "Executing"}
      </div>
      <ol className="p-2.5">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2.5 py-1">
            <span className="grid size-3.5 shrink-0 place-items-center">
              {i < done ? (
                <Check className="size-3 text-forest" strokeWidth={2.5} />
              ) : i === done ? (
                <span className="size-1.5 rounded-full bg-forest motion-safe:pulse-soft" />
              ) : (
                <span className="size-1.5 rounded-full border border-rule-firm" />
              )}
            </span>
            <span
              className={cx(
                "truncate text-caption transition-colors",
                i < done ? "text-ink-2" : "text-ink-4",
              )}
            >
              {s}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PasskeyPulse({ cycle, reduce }: { cycle: number; reduce: boolean }) {
  /** Step count instead of rAF — timers survive throttling, rAF doesn't. */
  const [lit, setLit] = useState(reduce ? 5 : 0);

  useEffect(() => {
    if (reduce) return;
    setLit(0);
    const timers = [0, 1, 2, 3, 4].map((i) => setTimeout(() => setLit(i + 1), 220 * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [cycle, reduce]);

  const arcs = [
    "M32 46c0-8 6-14 14-14s14 6 14 14",
    "M26 46c0-11 9-20 20-20s20 9 20 20v6",
    "M20 48c0-14 12-26 26-26s26 12 26 26v10",
    "M38 48c0-4 3-8 8-8s8 4 8 8v14",
  ];

  return (
    <div className="relative mx-auto grid size-20 place-items-center">
      <span className="absolute inset-[-50%] rounded-full" aria-hidden />
      <svg viewBox="0 0 92 92" className="relative size-full" fill="none" aria-hidden>
        <circle cx="46" cy="46" r="43" stroke="var(--rule-firm)" strokeWidth="1" />
        {arcs.map((d, i) => (
          <path
            key={d}
            d={d}
            stroke={lit > i ? "var(--claret)" : "var(--ink-5)"}
            strokeWidth="2.25"
            strokeLinecap="round"
            style={{ transition: "stroke 180ms var(--ease-settle)" }}
          />
        ))}
        <path
          d="M46 62v10"
          stroke={lit > 4 ? "var(--claret)" : "var(--ink-5)"}
          strokeWidth="2.25"
          strokeLinecap="round"
          style={{ transition: "stroke 180ms var(--ease-settle)" }}
        />
      </svg>
    </div>
  );
}
