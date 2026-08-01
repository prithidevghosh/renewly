"use client";

/**
 * Screen D — Renewal radar.
 *
 * A 90-day horizon rendered as an instrument track: hairline axis, ticks at
 * 7/30/60/90, and a marker per renewal sized by dollar stake. Anything inside
 * 7 days burns ember. Below the track, the same data grouped for scanning.
 */

import { useMemo } from "react";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { PageFrame, PageHeader } from "@/components/app/AppShell";
import { Card, Tag, Marker, VendorMark } from "@/components/ui/Primitives";
import { Money } from "@/components/ui/Money";
import { Button } from "@/components/ui/Button";
import { useRenewly } from "@/lib/store/RenewlyStore";
import type { Subscription } from "@/lib/domain/types";
import { annualise, cx, daysUntil, longDate, money, relativeDays } from "@/lib/format";

const HORIZON = 90;

export default function RadarPage() {
  const { subscriptions, opportunities, openApproval, ready } = useRenewly();

  const upcoming = useMemo(
    () =>
      subscriptions
        .filter((s) => !s.cancelledAt)
        .map((s) => ({ sub: s, days: daysUntil(s.nextRenewal) }))
        .filter((r) => r.days >= 0 && r.days <= HORIZON)
        .sort((a, b) => a.days - b.days),
    [subscriptions],
  );

  const oppFor = (subId: string) =>
    opportunities.find((o) => o.subscriptionId === subId && o.status === "open");

  const groups = [
    { key: "week", label: "This week", test: (d: number) => d <= 7 },
    { key: "month", label: "Next 30 days", test: (d: number) => d > 7 && d <= 30 },
    { key: "later", label: "31 – 90 days", test: (d: number) => d > 30 },
  ] as const;

  const atRisk = upcoming.filter((r) => r.days <= 7 && oppFor(r.sub.id));
  const weekTotal = upcoming
    .filter((r) => r.days <= 7)
    .reduce((t, r) => t + r.sub.amountCents, 0);

  const maxAmount = Math.max(...upcoming.map((r) => annualise(r.sub.amountCents, r.sub.cadence)), 1);

  return (
    <PageFrame>
      <PageHeader
        title="Renewal radar"
        lede="Every charge coming at you in the next 90 days, and what it costs to let it land."
      />

      {/* Alert band */}
      {atRisk.length > 0 && (
        <div className="mt-6 flex flex-col gap-3 rounded-lg border border-claret/30 bg-[var(--claret-soft)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-claret" />
            <div>
              <p className="text-body font-medium text-ink">
                {atRisk.length} renewal{atRisk.length > 1 ? "s" : ""} inside 7 days need a decision
              </p>
              <p className="mt-0.5 text-body-s text-ink-3">
                <span className="figure">{money(weekTotal)}</span> charges this week if
                nothing changes.
              </p>
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            className="shrink-0"
            onClick={() => {
              const o = oppFor(atRisk[0].sub.id);
              if (o) openApproval(o.id);
            }}
          >
            Handle {atRisk[0].sub.vendor}
          </Button>
        </div>
      )}

      {/* Horizon track */}
      <Card className="mt-6 overflow-hidden p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <Marker>90-day horizon</Marker>
          <span className="label">
            {upcoming.length} renewals
          </span>
        </div>

        <div className="relative mt-10 h-[104px]">
          {/* Axis */}
          <div className="absolute inset-x-0 top-[52px] h-px bg-line-firm" />
          {[0, 7, 30, 60, 90].map((tick) => (
            <div
              key={tick}
              className="absolute top-[52px] -translate-x-1/2"
              style={{ left: `${(tick / HORIZON) * 100}%` }}
            >
              <div
                className={cx("h-2.5 w-px", tick === 0 ? "bg-forest" : "bg-line-firm")}
                style={{ marginTop: -5 }}
              />
              <span className="absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap label">
                {tick === 0 ? "today" : `${tick}d`}
              </span>
            </div>
          ))}

          {/* Markers — alternate above/below so labels never collide */}
          {upcoming.map((r, i) => {
            const left = (r.days / HORIZON) * 100;
            const urgent = r.days <= 7;
            const weight = annualise(r.sub.amountCents, r.sub.cadence) / maxAmount;
            const size = 6 + weight * 12;
            const above = i % 2 === 0;

            return (
              <div
                key={r.sub.id}
                className="group absolute -translate-x-1/2"
                style={{ left: `${left}%`, top: above ? 52 - 26 : 52 + 12 }}
              >
                <div
                  className={cx(
                    "rounded-full transition-transform duration-[var(--dur-quick)] group-hover:scale-125",
                    urgent ? "bg-claret" : "bg-ink-400",
                  )}
                  style={{
                    width: size,
                    height: size,
                    boxShadow: urgent ? "0 0 12px rgb(255 162 76 / 0.5)" : undefined,
                  }}
                />
                {/* Hover-only. Renewals cluster hard in the first fortnight of
                    a 90-day scale, so always-on labels overlap into mush. The
                    track carries density; the list below carries the detail. */}
                <span
                  className={cx(
                    "pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap",
                    "label opacity-0 transition-opacity group-hover:opacity-100",
                    urgent ? "text-claret" : "text-ink-3",
                    above ? "bottom-full mb-1.5" : "top-full mt-1.5",
                  )}
                >
                  {r.sub.vendor} · {r.days}d
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Grouped list */}
      <div className="mt-8 space-y-8">
        {groups.map((g) => {
          const items = upcoming.filter((r) => g.test(r.days));
          if (items.length === 0) return null;
          const total = items.reduce((t, r) => t + r.sub.amountCents, 0);

          return (
            <section key={g.key}>
              <div className="flex items-baseline justify-between border-b border-rule pb-2.5">
                <h2 className="flex items-center gap-2.5 text-title-s font-semibold">
                  <CalendarClock className="size-4 text-ink-4" strokeWidth={1.75} />
                  {g.label}
                  <span className="label">
                    {items.length}
                  </span>
                </h2>
                <Money value={total} tone="muted" className="text-body-s" />
              </div>

              <ul className="divide-y divide-[var(--rule)]">
                {items.map(({ sub, days }) => (
                  <RenewalRow
                    key={sub.id}
                    sub={sub}
                    days={days}
                    opportunityId={oppFor(sub.id)?.id}
                    savingCents={oppFor(sub.id)?.savingCentsPerYear}
                    onAct={openApproval}
                  />
                ))}
              </ul>
            </section>
          );
        })}

        {ready && upcoming.length === 0 && (
          <Card className="p-12 text-center">
            <p className="text-body text-ink-3">Nothing renews in the next 90 days.</p>
          </Card>
        )}
      </div>
    </PageFrame>
  );
}

/* -------------------------------------------------------------------------- */

function RenewalRow({
  sub,
  days,
  opportunityId,
  savingCents,
  onAct,
}: {
  sub: Subscription;
  days: number;
  opportunityId?: string;
  savingCents?: number;
  onAct: (id: string) => void;
}) {
  const urgent = days <= 7;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3.5">
      {/* Countdown */}
      <div
        className={cx(
          "grid w-14 shrink-0 place-items-center rounded-md border py-1.5",
          urgent ? "border-claret/30 bg-[var(--claret-soft)]" : "border-rule bg-sunk",
        )}
      >
        <span
          className={cx(
            "figure text-title-s font-medium figure leading-none",
            urgent ? "text-claret" : "text-ink-2",
          )}
        >
          {days}
        </span>
        <span className="mt-0.5 label">days</span>
      </div>

      <VendorMark initials={sub.initials} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-ink">{sub.vendor}</span>
          {sub.activeSeats != null && sub.seats != null && sub.activeSeats < sub.seats && (
            <Tag tone="claret">
              {sub.seats - sub.activeSeats} idle {sub.seats - sub.activeSeats > 1 ? "seats" : "seat"}
            </Tag>
          )}
        </div>
        <p className="truncate text-caption text-ink-4">
          {sub.plan} · {longDate(sub.nextRenewal)} · {relativeDays(sub.nextRenewal)}
        </p>
      </div>

      <div className="text-right">
        <Money value={sub.amountCents} className="text-body" />
        {savingCents != null && (
          <p className="text-caption text-forest">
            <Money value={savingCents} tone="saving" sign cents={false} className="text-caption" />
            /yr recoverable
          </p>
        )}
      </div>

      {opportunityId ? (
        // Ghost even when urgent: the alert band above already owns this
        // screen's one primary action (DESIGN.md §2.2).
        <Button variant="secondary" size="sm" onClick={() => onAct(opportunityId)}>
          Handle it
        </Button>
      ) : (
        <span className="w-[86px] shrink-0 text-right label">
          priced ok
        </span>
      )}
    </li>
  );
}
