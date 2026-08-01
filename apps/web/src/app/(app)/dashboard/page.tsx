"use client";

/**
 * Screen C — Subscription inventory. The product home.
 *
 * The canonical list of what the company pays for, with the agent's confidence
 * and provenance attached to every row. Dense but never cramped: 44px rows,
 * horizontal hairlines only, money right-aligned and mono.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, Search } from "lucide-react";
import { PageFrame, PageHeader, StatusStrip } from "@/components/app/AppShell";
import { Allocation, Sparkline, SpendLine } from "@/components/ui/Charts";
import { Card, Tag, type TagTone, Marker, Rule, Skeleton, VendorMark } from "@/components/ui/Primitives";
import { Money } from "@/components/ui/Money";
import { ButtonLink } from "@/components/ui/Button";
import { useRenewly } from "@/lib/store/RenewlyStore";
import type { Subscription, SubscriptionStatus } from "@/lib/domain/types";
import { annualise, cadenceSuffix, cx, daysBadge, daysUntil, money, percent, shortDate } from "@/lib/format";

const STATUS_TONE: Record<SubscriptionStatus, TagTone> = {
  active: "neutral",
  underused: "claret",
  zombie: "claret",
  duplicate: "neutral",
};

const FILTERS = ["all", "active", "underused", "zombie", "duplicate"] as const;
type Filter = (typeof FILTERS)[number];

type SortKey = "renewal" | "amount" | "vendor";

/* -------------------------------------------------------------------------- */

function Stat({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="label">{label}</p>
      <div className="mt-1.5 text-title-l font-medium tracking-[-0.02em]">{children}</div>
      {hint && <p className="mt-1 text-caption text-ink-4">{hint}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export default function DashboardPage() {
  const { ready, subscriptions, summary, opportunities } = useRenewly();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("renewal");
  const [query, setQuery] = useState("");

  const live = useMemo(() => subscriptions.filter((s) => !s.cancelledAt), [subscriptions]);

  const rows = useMemo(() => {
    let out = live;
    if (filter !== "all") out = out.filter((s) => s.status === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (s) =>
          s.vendor.toLowerCase().includes(q) ||
          s.plan.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q),
      );
    }
    return [...out].sort((a, b) => {
      if (sort === "vendor") return a.vendor.localeCompare(b.vendor);
      if (sort === "amount")
        return annualise(b.amountCents, b.cadence) - annualise(a.amountCents, a.cadence);
      return daysUntil(a.nextRenewal) - daysUntil(b.nextRenewal);
    });
  }, [live, filter, query, sort]);

  /* 12-month spend curve — sum of every subscription's monthly trail. */
  const { curve, labels } = useMemo(() => {
    const months = 12;
    const totals = Array.from({ length: months }, (_, i) =>
      live.reduce((t, s) => t + (s.trail[i] ?? 0), 0),
    );
    const now = new Date();
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const ls = Array.from({ length: months }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - i), 1));
      return names[d.getUTCMonth()];
    });
    return { curve: totals.length ? totals : [0, 0], labels: ls };
  }, [live]);

  const allocation = useMemo(() => {
    const byCat = new Map<string, number>();
    live.forEach((s) => {
      byCat.set(s.category, (byCat.get(s.category) ?? 0) + annualise(s.amountCents, s.cadence));
    });
    return [...byCat.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [live]);

  const openOpps = opportunities.filter((o) => o.status === "open").length;

  return (
    <PageFrame>
      <PageHeader
        title="Inventory"
        lede="Every recurring charge the agent can see, with the evidence it used to find it."
      >
        <ButtonLink href="/opportunities" variant="primary" size="md">
          {openOpps} opportunities
        </ButtonLink>
      </PageHeader>

      <div className="mt-5">
        <StatusStrip
          items={[
            { label: "Sources", value: "3 connected" },
            { label: "Last sweep", value: "06:12" },
            { label: "Tracked", value: `${live.length} tools` },
          ]}
        />
      </div>

      {/* Summary */}
      <div className="mt-7 grid gap-px overflow-hidden rounded-lg border border-rule bg-line sm:grid-cols-2 lg:grid-cols-4">
        {!ready || !summary ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-card p-5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-7 w-28" />
            </div>
          ))
        ) : (
          <>
            <div className="bg-card p-5">
              <Stat label="Monthly spend" hint={`${money(summary.annualCents)} annualised`}>
                <Money value={summary.monthlyCents} animate />
              </Stat>
            </div>
            <div className="bg-card p-5">
              <Stat label="Saved YTD" hint="Realised, executed, receipted">
                <Money value={summary.realisedSavingsCents} tone="saving" animate />
              </Stat>
            </div>
            <div className="bg-card p-5">
              <Stat label="On the table" hint={`${openOpps} open opportunities`}>
                <Money value={summary.projectedSavingsCents} tone="saving" animate />
              </Stat>
            </div>
            <div className="bg-card p-5">
              <Stat
                label="Renewals · 30d"
                hint={`${summary.zombieCount} zombies flagged`}
              >
                <span className="figure">{summary.renewalsNext30}</span>
              </Stat>
            </div>
          </>
        )}
      </div>

      {/* Spend curve */}
      <div className="mt-6 grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <Card className="p-5">
          <div className="flex items-baseline justify-between">
            <Marker>Spend · 12 months</Marker>
            {summary && (
              <span className="figure text-caption text-ink-3 tabular">
                {money(summary.monthlyCents)}/mo
              </span>
            )}
          </div>
          <div className="mt-4">
            {ready ? (
              <SpendLine data={curve} labels={labels} />
            ) : (
              <Skeleton className="h-[168px] w-full" />
            )}
          </div>
        </Card>

        <Card className="p-5">
          <Marker>Where it goes</Marker>
          <div className="mt-5">
            {ready ? <Allocation segments={allocation} /> : <Skeleton className="h-2 w-full" />}
          </div>
        </Card>
      </div>

      {/* Controls */}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
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
              {f !== "all" && (
                <span className="ml-1.5 text-ink-4">
                  {live.filter((s) => s.status === f).length}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" />
            <label htmlFor="sub-search" className="sr-only">
              Search subscriptions
            </label>
            <input
              id="sub-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="h-9 w-full rounded-md border border-rule bg-card pl-8 pr-3 text-body-s outline-none transition-colors placeholder:text-ink-4 focus:border-rule-ink sm:w-44"
            />
          </div>
          <button
            type="button"
            onClick={() =>
              setSort((s) => (s === "renewal" ? "amount" : s === "amount" ? "vendor" : "renewal"))
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule px-3 label transition-colors hover:border-rule-ink hover:text-ink"
          >
            <ArrowUpDown className="size-3.5" />
            {sort}
          </button>
        </div>
      </div>

      {/* Table */}
      <Card className="mt-4 overflow-hidden">
        {/* Desktop header */}
        <div className="hidden grid-cols-[minmax(0,2.2fr)_1fr_1fr_0.9fr_0.8fr_auto] items-center gap-4 border-b border-rule px-4 py-2.5 label lg:grid">
          <span>Vendor</span>
          <span>Seats</span>
          <span>Renews</span>
          <span className="text-right">Amount</span>
          <span className="text-right">Annual</span>
          <span className="w-[68px] text-right">Trail</span>
        </div>

        {!ready ? (
          <div className="divide-y divide-[var(--rule)]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-16 text-center">
            <p className="text-body text-ink-3">Nothing matches that.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
              className="mt-2 text-body-s text-forest underline underline-offset-4"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--rule)]">
            {rows.map((s) => (
              <SubscriptionRow key={s.id} sub={s} />
            ))}
          </ul>
        )}
      </Card>

      <p className="mt-4 text-caption text-ink-4">
        Confidence reflects how certain the agent is that a row is real and correctly parsed.
        Anything under 90% is worth a glance —{" "}
        <Link href="/settings" className="text-ink-3 underline underline-offset-4">
          adjust sources in settings
        </Link>
        .
      </p>
    </PageFrame>
  );
}

/* -------------------------------------------------------------------------- */

function SubscriptionRow({ sub }: { sub: Subscription }) {
  const [open, setOpen] = useState(false);
  const days = daysUntil(sub.nextRenewal);
  const annual = annualise(sub.amountCents, sub.cadence);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover lg:grid-cols-[minmax(0,2.2fr)_1fr_1fr_0.9fr_0.8fr_auto] lg:gap-4"
      >
        {/* Vendor */}
        <div className="col-span-2 flex min-w-0 items-center gap-3 lg:col-span-1">
          <VendorMark initials={sub.initials} muted={sub.status === "zombie"} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-body font-medium text-ink">{sub.vendor}</span>
              <Tag tone={STATUS_TONE[sub.status]}>{sub.status}</Tag>
            </div>
            <p className="truncate text-caption text-ink-4">{sub.plan}</p>
          </div>
        </div>

        {/* Seats */}
        <div className="hidden lg:block">
          {sub.seats != null ? (
            <span
              className={cx(
                "figure text-body-s tabular",
                sub.activeSeats != null && sub.activeSeats < sub.seats
                  ? "text-claret"
                  : "text-ink-3",
              )}
            >
              {sub.activeSeats}/{sub.seats}
            </span>
          ) : (
            <span className="text-body-s text-ink-4">—</span>
          )}
        </div>

        {/* Renews */}
        <div className="hidden lg:block">
          <span
            className={cx(
              "figure text-body-s tabular",
              days <= 3 ? "text-claret" : "text-ink-3",
            )}
          >
            {shortDate(sub.nextRenewal)}
          </span>
          <span className="ml-1.5 label">
            {daysBadge(sub.nextRenewal)}
          </span>
        </div>

        {/* Amount */}
        <div className="text-right">
          <Money value={sub.amountCents} className="text-body-s" />
          <span className="text-caption text-ink-4">{cadenceSuffix(sub.cadence)}</span>
          <p className="label lg:hidden">
            {shortDate(sub.nextRenewal)} · {daysBadge(sub.nextRenewal)}
          </p>
        </div>

        {/* Annual */}
        <div className="hidden text-right lg:block">
          <Money value={annual} tone="muted" className="text-body-s" cents={false} />
        </div>

        {/* Trail */}
        <div className="hidden justify-end lg:flex">
          <Sparkline
            data={sub.trail}
            tone={sub.status === "zombie" ? "faint" : sub.status === "active" ? "neutral" : "claret"}
          />
        </div>
      </button>

      {open && (
        <div className="border-t border-rule bg-sunk px-4 py-3.5 lg:pl-[3.9rem]">
          <dl className="grid gap-x-8 gap-y-2 text-body-s sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="shrink-0 label">Evidence</dt>
              <dd className="text-ink-2">{sub.evidence}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 label">Confidence</dt>
              <dd className="figure text-ink-2">{percent(sub.confidence)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 label">Category</dt>
              <dd className="text-ink-2">{sub.category}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 label">Annualised</dt>
              <dd>
                <Money value={annual} className="text-body-s" />
              </dd>
            </div>
          </dl>
          <Rule className="my-3" />
          <Link
            href="/opportunities"
            className="label text-forest underline-offset-4 hover:underline"
          >
            See what the agent would do →
          </Link>
        </div>
      )}
    </li>
  );
}
