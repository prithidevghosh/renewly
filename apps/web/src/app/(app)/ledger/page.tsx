"use client";

/**
 * Screen H — The savings ledger. The "Prove" step.
 *
 * Append-only, monotonic, hash-stamped. Everything is mono and figure so the
 * page reads as receipts rather than a feed: sequence numbers align, money
 * aligns, timestamps align. Failures are shown, not hidden — a ledger that only
 * shows wins isn't a ledger.
 */

import { useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";
import { ArrowDownToLine, Check, CircleAlert, Eye, Send, Sparkles } from "lucide-react";
import { PageFrame, PageHeader } from "@/components/app/AppShell";
import { Card, Tag, type TagTone, Marker, Skeleton } from "@/components/ui/Primitives";
import { BigMoney, Money } from "@/components/ui/Money";
import { useRenewly } from "@/lib/store/RenewlyStore";
import type { LedgerEntry, LedgerEventType } from "@/lib/domain/types";
import { cx, stamp } from "@/lib/format";

const TYPE_META: Record<
  LedgerEventType,
  { label: string; tone: TagTone; icon: typeof Check }
> = {
  detected: { label: "Detected", tone: "neutral", icon: Eye },
  proposed: { label: "Proposed", tone: "neutral", icon: Send },
  approved: { label: "Approved", tone: "neutral", icon: Check },
  executed: { label: "Executed", tone: "forest", icon: Sparkles },
  failed: { label: "Failed", tone: "claret", icon: CircleAlert },
  saved: { label: "Saved", tone: "forest", icon: Sparkles },
};

const FILTERS = ["all", "executed", "approved", "proposed", "detected", "failed"] as const;
type Filter = (typeof FILTERS)[number];

export default function LedgerPage() {
  const { ready, ledger, summary } = useRenewly();
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(
    () => (filter === "all" ? ledger : ledger.filter((e) => e.type === filter)),
    [ledger, filter],
  );

  const executed = ledger.filter((e) => e.type === "executed");
  const totalCharged = executed.reduce((t, e) => t + e.chargedCents, 0);

  return (
    <PageFrame>
      <PageHeader
        title="Savings ledger"
        lede="Every action the agent proposed, you approved, and it completed — with the receipt attached. Append-only."
      />

      {/* Hero proof */}
      <Card className="relative mt-6 overflow-hidden">
        
        <div className="relative grid gap-px bg-line sm:grid-cols-3">
          <div className="bg-card p-6">
            <Marker>Realised savings · YTD</Marker>
            <div className="mt-3">
              {ready && summary ? (
                <BigMoney value={summary.realisedSavingsCents} suffix="/ year" />
              ) : (
                <Skeleton className="h-10 w-44" />
              )}
            </div>
            <p className="mt-2 text-caption text-ink-4">
              Annualised impact of {executed.length} executed actions
            </p>
          </div>

          <div className="bg-card p-6">
            <Marker >Cash moved</Marker>
            <div className="mt-3">
              <Money
                value={totalCharged}
                animate
                className="text-display-m font-medium tracking-[-0.03em]"
                cents={false}
              />
            </div>
            <p className="mt-2 text-caption text-ink-4">
              Across {executed.filter((e) => e.chargedCents > 0).length} single-use cards
            </p>
          </div>

          <div className="bg-card p-6">
            <Marker >Entries</Marker>
            <div className="mt-3 figure text-display-m font-medium figure tracking-[-0.03em]">
              {ledger.length}
            </div>
            <p className="mt-2 text-caption text-ink-4">
              Sequential · hash-stamped · never rewritten
            </p>
          </div>
        </div>
      </Card>

      {/* Filters */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter ledger">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={cx(
                "rounded-full border px-3 py-1.5 label transition-colors",
                filter === f
                  ? "border-forest/30 bg-[var(--forest-soft)] text-forest"
                  : "border-rule text-ink-4 hover:border-rule-ink hover:text-ink-2",
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 label transition-colors hover:border-rule-ink hover:text-ink-2"
          onClick={() => window.print()}
        >
          <ArrowDownToLine className="size-3.5" />
          Export
        </button>
      </div>

      {/* Ledger */}
      <Card className="mt-4 overflow-hidden">
        <div className="hidden grid-cols-[auto_9rem_7rem_minmax(0,1fr)_8rem_7rem] items-center gap-4 border-b border-rule px-4 py-2.5 label lg:grid">
          <span className="w-8">#</span>
          <span>Timestamp</span>
          <span>Event</span>
          <span>Detail</span>
          <span className="text-right">Impact / yr</span>
          <span className="text-right">Charged</span>
        </div>

        {!ready ? (
          <div className="divide-y divide-[var(--rule)]">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                <Skeleton className="h-3 w-8" />
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 flex-1" />
              </div>
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--rule)]">
            {rows.map((e, i) => (
              <LedgerRow key={e.id} entry={e} index={i} />
            ))}
          </ul>
        )}

        {ready && rows.length === 0 && (
          <div className="px-4 py-16 text-center text-body text-ink-3">
            No {filter} entries yet.
          </div>
        )}
      </Card>

      <p className="mt-4 max-w-[70ch] text-caption text-ink-4">
        Each row carries a content hash derived from its sequence, timestamp, vendor and impact.
        Rows are never edited or deleted — a correction is a new entry. In production these hashes
        chain to the previous entry so any tampering breaks the chain.
      </p>
    </PageFrame>
  );
}

/* -------------------------------------------------------------------------- */

function LedgerRow({ entry, index }: { entry: LedgerEntry; index: number }) {
  const reduce = useReducedMotion();
  const meta = TYPE_META[entry.type];
  const Icon = meta.icon;

  return (
    <li
      className={cx(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1.5 px-4 py-3.5 transition-colors hover:bg-hover lg:grid-cols-[auto_9rem_7rem_minmax(0,1fr)_8rem_7rem] lg:items-center",
        !reduce && "stage-in",
      )}
      style={{ "--stagger": `${Math.min(index * 25, 350)}ms` } as React.CSSProperties}
    >
      {/* Seq */}
      <span className="w-8 shrink-0 figure text-caption figure text-ink-4">
        {entry.seq.toString().padStart(3, "0")}
      </span>

      {/* Timestamp */}
      <span className="order-3 col-span-3 label lg:order-none lg:col-span-1 lg:text-caption lg:normal-case lg:tracking-normal">
        {stamp(entry.at)}
      </span>

      {/* Event */}
      <span className="hidden lg:block">
        <Tag tone={meta.tone}>
          <Icon className="size-2.5" />
          {meta.label}
        </Tag>
      </span>

      {/* Detail */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-s font-medium text-ink">{entry.vendor}</span>
          <span className="lg:hidden">
            <Tag tone={meta.tone}>{meta.label}</Tag>
          </span>
        </div>
        <p className="mt-0.5 text-body-s text-ink-3">{entry.summary}</p>
        <p className="mt-1 truncate label">
          {entry.evidence} · {entry.hash}
        </p>
      </div>

      {/* Impact */}
      <div className="text-right">
        {entry.deltaCentsPerYear > 0 ? (
          <Money
            value={entry.deltaCentsPerYear}
            tone={entry.type === "executed" ? "saving" : "muted"}
            sign
            className="text-body-s"
          />
        ) : (
          <span className="figure text-body-s text-ink-4">—</span>
        )}
      </div>

      {/* Charged */}
      <div className="hidden text-right lg:block">
        {entry.chargedCents > 0 ? (
          <Money value={entry.chargedCents} tone="cost" className="text-body-s" />
        ) : (
          <span className="figure text-body-s text-ink-4">—</span>
        )}
      </div>
    </li>
  );
}
