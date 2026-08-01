"use client";

/**
 * The guardrails console — the one control on the page that actually controls
 * something. Move the ceiling and the four queued actions genuinely re-resolve
 * between "acts inside policy", "needs your approval" and "stopped".
 *
 * The three controls mirror the real policy surface: an envelope the agent may
 * act inside, a per-action ceiling, and a kill switch that outranks both. The
 * kill switch is deliberately the loudest control here — the objection this
 * section answers is "you want to move my money", and the answer is a visible
 * off switch, not a paragraph.
 */

import { useMemo, useState } from "react";
import { Logo } from "./brand-marks";

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

type Action = { k: string; n: string; amt: number; m: string };

const ACTIONS: readonly Action[] = [
  { k: "loom", n: "Cancel Loom Business", amt: 168, m: "Two sign-ins in ninety days" },
  { k: "figma", n: "Release four Figma seats", amt: 480, m: "Untouched since April" },
  { k: "notion", n: "Move Notion down to Plus", amt: 432, m: "Nine of eighteen seats in use" },
  { k: "datadog", n: "Move Datadog to annual", amt: 2244, m: "Renews on 26 August" },
];

const CAPS = [0, 250, 600, 1000, 2500] as const;

type Verdict = { tone: "auto" | "ask" | "stop"; label: string };

function resolve(a: Action, envelope: boolean, cap: number, frozen: boolean): Verdict {
  if (frozen) return { tone: "stop", label: "Frozen" };
  if (!envelope) return { tone: "ask", label: "Needs your approval" };
  if (a.amt <= cap) return { tone: "auto", label: "Acts inside policy" };
  return { tone: "stop", label: "Stopped — over your ceiling" };
}

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      className="sw"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
    />
  );
}

export function Console() {
  const [envelope, setEnvelope] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [cap, setCap] = useState(600);

  const verdicts = useMemo(
    () => ACTIONS.map((a) => resolve(a, envelope, cap, frozen)),
    [envelope, cap, frozen],
  );
  const auto = useMemo(
    () => ACTIONS.reduce((sum, a, i) => (verdicts[i].tone === "auto" ? sum + a.amt : sum), 0),
    [verdicts],
  );
  const autoCount = verdicts.filter((verdict) => verdict.tone === "auto").length;

  return (
    <div className="panel up" data-d="120">
      <div className="policy-head">
        <div>
          <span className="policy-kicker">
            <i /> Live policy
          </span>
          <p>Your rules become enforceable immediately.</p>
        </div>
        <span className={`policy-state${frozen ? " frozen" : ""}`}>
          {frozen ? "Everything frozen" : envelope ? "Mandate active" : "Approval required"}
        </span>
      </div>

      <div className="policy-grid">
        <div className="policy-controls">
          <div className="ctl">
            <div className="lab">
              <div>
                <div className="nm">Act inside this envelope</div>
                <div className="hint">Off means Renewly prepares every move and waits for you.</div>
              </div>
              <Switch
                on={envelope}
                onToggle={() => setEnvelope((v) => !v)}
                label="Let the agent act within your envelope"
              />
            </div>
          </div>

          <div className="ceiling">
            <div className="ceiling-copy">
              <span>Per-action ceiling</span>
              <strong>{money(cap)}</strong>
              <p>Anything above this amount stops and asks. Every time.</p>
            </div>
            <div className="cap-options" role="radiogroup" aria-label="Per-action ceiling">
              {CAPS.map((amount) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={cap === amount}
                  className={cap === amount ? "on" : ""}
                  onClick={() => setCap(amount)}
                  key={amount}
                >
                  {amount === 0 ? "$0" : amount >= 1000 ? `$${amount / 1000}k` : money(amount)}
                </button>
              ))}
            </div>
          </div>

          <div className="ctl freeze-ctl">
            <div className="lab">
              <div>
                <div className="nm">Freeze all activity</div>
                <div className="hint">Pending actions stop and live credentials expire.</div>
              </div>
              <Switch
                on={frozen}
                onToggle={() => setFrozen((v) => !v)}
                label="Freeze all activity"
              />
            </div>
          </div>
        </div>

        <div className="policy-results">
          <div className="results-head">
            <div>
              <span>Under this policy</span>
              <strong>Decisions under this mandate</strong>
            </div>
            <small>
              {autoCount} of {ACTIONS.length} inside policy
            </small>
          </div>

          <div className="action-list">
            {ACTIONS.map((a, i) => (
              <div className="act" key={a.k}>
                <div>
                  <div className="nm">{a.n}</div>
                  <div className="mt">
                    {a.m} · {money(a.amt)} a year
                  </div>
                </div>
                <div className={`v ${verdicts[i].tone}`}>
                  <i />
                  {verdicts[i].label}
                </div>
              </div>
            ))}
          </div>

          <div className="tally" aria-live="polite" aria-atomic="true">
            <span>Annual recurring value inside policy</span>
            <b>{money(auto)}</b>
            <small>
              {frozen
                ? "Nothing moves while activity is frozen."
                : auto
                  ? "Across the actions this mandate currently allows."
                  : "Every action currently needs your approval."}
            </small>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Named so the vendor row can reuse the same mark renderer. */
export { Logo };
