"use client";

/**
 * The proposal card and the execution trace — the two rich objects the agent
 * puts in front of a human. Shared by the chat surface and the opportunities
 * screen so "Propose" and "Execute" look identical wherever they appear.
 */

import { useReducedMotion } from "motion/react";
import { Check, ChevronDown, CircleAlert, Lock } from "lucide-react";
import { useState } from "react";
import type { Action, Opportunity } from "@/lib/domain/types";
import { Money } from "@/components/ui/Money";
import { Button } from "@/components/ui/Button";
import { Tag, VendorMark } from "@/components/ui/Primitives";
import { cx, money, percent, relativeDays } from "@/lib/format";

/* -------------------------------------------------------------------------- */
/* Proposal                                                                    */
/* -------------------------------------------------------------------------- */

export function ProposalCard({
  opportunity,
  onApprove,
  onDecline,
  locked = false,
  compact = false,
  className,
}: {
  opportunity: Opportunity;
  onApprove: (id: string) => void;
  onDecline?: (id: string) => void;
  /** Approved/executing — freeze the controls and show the commit sweep. */
  locked?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const [showSteps, setShowSteps] = useState(false);
  const reduce = useReducedMotion();

  const savedFraction =
    opportunity.currentAnnualCents > 0
      ? opportunity.savingCentsPerYear / opportunity.currentAnnualCents
      : 0;

  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-lg border bg-card",
        locked ? "border-forest/30" : "border-rule-firm",
        "transition-colors duration-[var(--dur-base)]",
        className,
      )}
    >
      {/* The commit sweep — a signal hairline crossing the card on approval */}
      {locked && !reduce && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-[var(--claret-soft)] to-transparent"
        />
      )}

      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <VendorMark initials={opportunity.vendor.slice(0, 2)} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">Proposal</span>
            <span className="label">
              · {percent(opportunity.confidence)} confidence
            </span>
            {opportunity.urgent && opportunity.deadline && (
              <Tag tone="claret">
                renews {relativeDays(opportunity.deadline)}
              </Tag>
            )}
          </div>
          <h3 className="mt-1.5 text-title-s font-semibold leading-snug text-ink">
            {opportunity.headline}
          </h3>
        </div>
      </div>

      {/* Money — the number that matters */}
      <div className="border-t border-rule px-4 py-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="label">You save</p>
            <Money
              value={opportunity.savingCentsPerYear}
              tone="saving"
              animate
              suffix="/yr"
              className="text-[1.75rem] font-medium leading-tight tracking-[-0.03em]"
            />
          </div>
          <div className="text-right text-body-s">
            <p className="text-ink-4">
              <span className="figure line-through decoration-ink-4/50">
                {money(opportunity.currentAnnualCents)}
              </span>
            </p>
            <p className="text-ink-2">
              <span className="figure">{money(opportunity.proposedAnnualCents)}</span>
              <span className="text-ink-4">/yr</span>
            </p>
          </div>
        </div>

        {/* Proportion bar — how much of this line item disappears */}
        <div className="mt-3.5 flex h-1.5 overflow-hidden rounded-full bg-sunk">
          <div
            className={cx("h-full bg-forest", !reduce && "grow-x")}
            style={{
              width: `${Math.min(100, savedFraction * 100)}%`,
              animationDelay: "150ms",
            }}
          />
        </div>
        <p className="mt-2 label">
          {Math.round(savedFraction * 100)}% of this line item removed
        </p>
      </div>

      {/* Steps */}
      {!compact && (
        <div className="border-t border-rule">
          <button
            type="button"
            onClick={() => setShowSteps((s) => !s)}
            aria-expanded={showSteps}
            className="flex w-full items-center justify-between px-4 py-3 text-body-s text-ink-3 transition-colors hover:bg-hover hover:text-ink-2"
          >
            <span>What I&rsquo;ll do · {opportunity.steps.length} steps</span>
            <ChevronDown
              className={cx(
                "size-4 transition-transform duration-[var(--dur-quick)]",
                showSteps && "rotate-180",
              )}
            />
          </button>
          {showSteps && (
            <ol className={cx("overflow-hidden px-4 pb-4", !reduce && "stage-in")}>
              {opportunity.steps.map((step, i) => (
                <li key={step} className="flex gap-3 py-1.5 text-body-s text-ink-3">
                  <span className="figure figure text-caption text-ink-4">
                    {(i + 1).toString().padStart(2, "0")}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col gap-2 border-t border-rule p-3 sm:flex-row">
        <Button
          variant="primary"
          className="flex-[1.6]"
          onClick={() => onApprove(opportunity.id)}
          disabled={locked}
        >
          {locked ? (
            <>
              <Lock className="size-3.5" /> Approved
            </>
          ) : (
            <>Approve — save {money(opportunity.savingCentsPerYear, { cents: false })}/yr</>
          )}
        </Button>
        {onDecline && (
          <Button
            variant="quiet"
            className="flex-1"
            onClick={() => onDecline(opportunity.id)}
            disabled={locked}
          >
            Not now
          </Button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Execution trace                                                             */
/* -------------------------------------------------------------------------- */

export function ExecutionTrace({
  action,
  className,
}: {
  action: Action;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const done = action.state === "executed";

  return (
    <div className={cx("rounded-lg border border-rule bg-sunk", className)}>
      <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
        <span className="label">
          {done ? "Execution complete" : "Executing"}
        </span>
        <span className="label">{action.vendor}</span>
      </div>

      <ol className="p-3">
        {action.steps.map((step, i) => (
          <li key={step.label} className="flex items-start gap-3 py-1.5">
            <span className="mt-[3px] grid size-4 shrink-0 place-items-center">
              {step.state === "done" && <Check className="size-3.5 text-forest" strokeWidth={2.5} />}
              {step.state === "running" && (
                <span
                  className={cx(
                    "size-2 rounded-full bg-forest",
                    !reduce && "pulse-soft",
                  )}
                />
              )}
              {step.state === "pending" && (
                <span className="size-2 rounded-full border border-rule-firm" />
              )}
              {step.state === "failed" && <CircleAlert className="size-3.5 text-claret" />}
            </span>

            <span className="min-w-0 flex-1">
              <span
                className={cx(
                  "block text-body-s transition-colors duration-[var(--dur-quick)]",
                  step.state === "pending" ? "text-ink-4" : "text-ink-2",
                )}
              >
                {step.label}
              </span>
              {step.detail && (
                <span className="mt-0.5 block label">
                  {step.detail}
                </span>
              )}
            </span>

            <span className="label tabular">
              {(i + 1).toString().padStart(2, "0")}
            </span>
          </li>
        ))}
      </ol>

      {done && (
        <div
          className={cx(
            "flex items-center justify-between border-t border-forest/25 bg-[var(--forest-soft)] px-4 py-3",
            !reduce && "stage-in",
          )}
        >
          <div>
            <p className="label">Logged to ledger</p>
            <p className="mt-0.5 text-body-s text-ink-2">
              {action.chargedCents > 0 ? (
                <>
                  Charged <Money value={action.chargedCents} className="text-body-s" /> via{" "}
                  <span className="figure text-caption">{action.railToken}</span>
                </>
              ) : (
                "No charge — cancellation confirmed"
              )}
            </p>
          </div>
          <Money
            value={action.savingCentsPerYear}
            tone="saving"
            sign
            animate
            suffix="/yr"
            className="text-title-s"
          />
        </div>
      )}
    </div>
  );
}
