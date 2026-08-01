"use client";

/**
 * Screen E — Savings opportunities.
 *
 * Ranked by dollar impact, each one carrying the agent's reasoning in its own
 * voice and a single "let Renewly handle it" action that drops straight into
 * the passkey sheet. The banner totals what's on the table so the page always
 * answers "what is this worth?" before you scroll.
 */

import { useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { PageFrame, PageHeader } from "@/components/app/AppShell";
import { Card, Tag, Marker, Skeleton, VendorMark } from "@/components/ui/Primitives";
import { BigMoney, Money } from "@/components/ui/Money";
import { Button } from "@/components/ui/Button";
import { ExecutionTrace } from "@/components/agent/Proposal";
import { useRenewly } from "@/lib/store/RenewlyStore";
import type { Opportunity, OpportunityKind } from "@/lib/domain/types";
import { cx, money, percent, relativeDays } from "@/lib/format";

const KIND_LABEL: Record<OpportunityKind, string> = {
  switch_to_annual: "Billing term",
  cut_seats: "Seat cut",
  cancel_zombie: "Cancellation",
  consolidate_duplicate: "Consolidation",
  downgrade_tier: "Tier change",
  renegotiate_renewal: "Renegotiation",
};

export default function OpportunitiesPage() {
  const { ready, opportunities, openApproval, dismiss, liveAction } = useRenewly();
  const [tab, setTab] = useState<"open" | "done">("open");

  const open = useMemo(
    () => opportunities.filter((o) => o.status === "open").sort((a, b) => b.priority - a.priority),
    [opportunities],
  );
  const closed = useMemo(
    () => opportunities.filter((o) => o.status === "done" || o.status === "dismissed"),
    [opportunities],
  );

  const total = open.reduce((t, o) => t + o.savingCentsPerYear, 0);
  const list = tab === "open" ? open : closed;

  return (
    <PageFrame>
      <PageHeader
        title="Opportunities"
        lede="Ranked by what they're worth. Each one is a complete action the agent can finish, not a suggestion for you to chase."
      />

      {/* Banner */}
      <Card className="relative mt-6 overflow-hidden p-6 sm:p-7">
        
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Marker>On the table</Marker>
            <div className="mt-3">
              {ready ? (
                <BigMoney value={total} suffix="/ year" />
              ) : (
                <Skeleton className="h-10 w-52" />
              )}
            </div>
            <p className="mt-2 max-w-[46ch] text-body-s text-ink-3">
              Across {open.length} actions. Nothing here loses you a tool anyone is actually using.
            </p>
          </div>

          {open.length > 0 && (
            <Button variant="primary" size="lg" onClick={() => openApproval(open[0].id)}>
              Start with {open[0].vendor}
            </Button>
          )}
        </div>
      </Card>

      {/* Tabs */}
      <div className="mt-8 flex gap-1.5 border-b border-rule" role="tablist">
        {(
          [
            ["open", `Open · ${open.length}`],
            ["done", `Handled · ${closed.length}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cx(
              "relative -mb-px px-3 py-2.5 text-body-s transition-colors",
              tab === key ? "text-ink" : "text-ink-4 hover:text-ink-2",
            )}
          >
            {label}
            {tab === key && <span className="absolute inset-x-0 bottom-0 h-px bg-forest" />}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {!ready &&
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-4 h-8 w-32" />
              <Skeleton className="mt-4 h-16 w-full" />
            </Card>
          ))}

        {list.map((o, i) => (
          <OpportunityCard
            key={o.id}
            opportunity={o}
            index={i}
            onApprove={openApproval}
            onDismiss={dismiss}
            live={liveAction?.opportunityId === o.id ? liveAction : null}
          />
        ))}
      </div>

      {ready && list.length === 0 && (
        <Card className="mt-6 p-14 text-center">
          <p className="text-body text-ink-3">
            {tab === "open"
              ? "Nothing left on the table. The agent is still watching."
              : "Nothing handled yet."}
          </p>
        </Card>
      )}
    </PageFrame>
  );
}

/* -------------------------------------------------------------------------- */

function OpportunityCard({
  opportunity: o,
  index,
  onApprove,
  onDismiss,
  live,
}: {
  opportunity: Opportunity;
  index: number;
  onApprove: (id: string) => void;
  onDismiss: (id: string) => Promise<void>;
  live: ReturnType<typeof useRenewly>["liveAction"];
}) {
  const reduce = useReducedMotion();
  const done = o.status === "done";
  const dismissed = o.status === "dismissed";

  return (
    <div
      className={cx(!reduce && "stage-in")}
      style={{ "--stagger": `${Math.min(index * 50, 300)}ms` } as React.CSSProperties}
    >
      <Card
        className={cx(
          "flex h-full flex-col overflow-hidden",
          done && "border-forest/25",
          dismissed && "opacity-55",
        )}
      >
        {/* Head */}
        <div className="flex items-start gap-3 p-5 pb-4">
          <VendorMark initials={o.vendor.slice(0, 2)} size={38} muted={dismissed} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label">
                {KIND_LABEL[o.kind]}
              </span>
              <span className="label">
                · {percent(o.confidence)} sure
              </span>
              {o.urgent && o.deadline && (
                <Tag tone="claret">
                  {relativeDays(o.deadline)}
                </Tag>
              )}
              {done && (
                <Tag tone="forest">
                  executed
                </Tag>
              )}
              {dismissed && <Tag tone="neutral">declined</Tag>}
            </div>
            <h3 className="mt-1.5 text-title-s font-semibold leading-snug">{o.headline}</h3>
          </div>
        </div>

        {/* Rationale — the agent's voice, not marketing copy */}
        <p className="px-5 pb-4 text-body-s leading-relaxed text-ink-3">{o.rationale}</p>

        {/* Money */}
        <div className="mt-auto border-t border-rule px-5 py-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="label">
                {done ? "Saved" : "Saves"}
              </p>
              <Money
                value={o.savingCentsPerYear}
                tone="saving"
                animate
                suffix="/yr"
                className="text-title-l font-medium tracking-[-0.025em]"
              />
            </div>
            <div className="text-right figure text-caption figure text-ink-4">
              <p className="line-through decoration-ink-4/50">{money(o.currentAnnualCents)}</p>
              <p className="text-ink-2">{money(o.proposedAnnualCents)}</p>
            </div>
          </div>
        </div>

        {/* Live trace or controls */}
        {live && live.state !== "executed" ? (
          <div className="border-t border-rule p-3">
            <ExecutionTrace action={live} />
          </div>
        ) : done ? (
          <div className="flex items-center gap-2 border-t border-forest/25 bg-[var(--forest-soft)] px-5 py-3.5 text-body-s text-ink-2">
            <Check className="size-4 text-forest" strokeWidth={2.5} />
            Executed and logged to the ledger.
          </div>
        ) : dismissed ? (
          <div className="border-t border-rule px-5 py-3.5 text-body-s text-ink-4">
            Declined — the agent will re-flag it if the price or usage changes.
          </div>
        ) : (
          <div className="flex gap-2 border-t border-rule p-3">
            {/* Ghost, not solid signal. Eight lime buttons on one screen would
                break the rationing rule in DESIGN.md §2.2 — the banner leads. */}
            <Button variant="secondary" className="flex-[1.5]" onClick={() => onApprove(o.id)}>
              Let Renewly handle it
            </Button>
            <Button variant="quiet" onClick={() => void onDismiss(o.id)}>
              Not now
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
