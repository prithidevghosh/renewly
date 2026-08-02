"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  LayoutGrid,
  MessagesSquare,
  Radar,
  ScrollText,
  Settings2,
  Sparkles,
} from "lucide-react";
import { Mark, Wordmark } from "@/components/brand/Mark";
import { Money } from "@/components/ui/Money";
import { useRenewly } from "@/lib/store/RenewlyStore";
import { cx } from "@/lib/format";

const NAV = [
  { href: "/agent", label: "Agent", icon: MessagesSquare, hint: "Chat" },
  { href: "/dashboard", label: "Inventory", icon: LayoutGrid, hint: "Subscriptions" },
  { href: "/radar", label: "Radar", icon: Radar, hint: "Renewals" },
  { href: "/opportunities", label: "Opportunities", icon: Sparkles, hint: "Savings" },
  { href: "/ledger", label: "Ledger", icon: ScrollText, hint: "Proof" },
  { href: "/settings", label: "Settings", icon: Settings2, hint: "Control" },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, summary, liveAction } = useRenewly();

  const agentState =
    liveAction?.state === "executing"
      ? "acting"
      : liveAction?.state === "executed"
        ? "settled"
        : "idle";

  // The agentic cockpit owns both axes of the viewport: the live terminal is
  // the upper field and its three evidence/configuration ledgers form the
  // lower field. A second navigation rail would break that composition.
  if (pathname === "/agent" || pathname === "/dashboard") return <>{children}</>;

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* ── Desktop rail ────────────────────────────────────────────────── */}
      <aside className="sticky top-0 hidden h-dvh w-[236px] shrink-0 flex-col border-r border-rule bg-paper lg:flex">
        <div className="px-5 py-5">
          <Link href="/" className="inline-block rounded-md">
            <Wordmark size={24} state={agentState} />
          </Link>
        </div>

        <nav className="flex-1 px-3" aria-label="Product">
          <p className="px-2 pb-2 pt-3 label">Workspace</p>
          <ul className="space-y-0.5">
            {NAV.map(({ href, label, icon: Icon, hint }) => {
              const active = pathname === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "group relative flex h-9 items-center gap-2.5 rounded-md px-2.5",
                      "text-body-s transition-colors duration-[var(--dur-instant)]",
                      active ? "bg-sunk text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2",
                    )}
                  >
                    {active && (
                      <span
                        className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-forest"
                        aria-hidden
                      />
                    )}
                    <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                    {label}
                    <span className="ml-auto label opacity-0 transition-opacity group-hover:opacity-100">
                      {hint}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Agent status — always visible proof of life */}
        <div className="border-t border-rule p-3">
          <div className="rounded-lg border border-rule bg-card p-3">
            <div className="flex items-center gap-2.5">
              <Mark size={22} state={agentState} />
              <div className="min-w-0">
                <p className="truncate label">
                  {agentState === "acting" ? "Executing" : "Watching"}
                </p>
                <p className="truncate text-caption text-ink-2">Last sweep 06:12</p>
              </div>
            </div>
            {summary && (
              <div className="mt-3 border-t border-rule pt-3">
                <p className="label">Saved YTD</p>
                <Money
                  value={summary.realisedSavingsCents}
                  tone="saving"
                  animate
                  className="text-title-s"
                />
              </div>
            )}
          </div>

          {user && (
            <div className="mt-3 flex items-center gap-2.5 px-1">
              <span
                className="grid size-7 shrink-0 place-items-center rounded-full border border-rule-firm bg-sunk figure text-caption text-ink-2"
                aria-hidden
              >
                {user.name
                  .split(" ")
                  .map((p) => p[0])
                  .join("")}
              </span>
              <div className="min-w-0">
                <p className="truncate text-caption text-ink-2">{user.name}</p>
                <p className="truncate text-label text-ink-4">{user.company}</p>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ── Mobile header ───────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-rule bg-paper/92 px-4 backdrop-blur-sm lg:hidden">
        <Link href="/" className="rounded-md">
          <Wordmark size={22} state={agentState} />
        </Link>
        {summary && (
          <div className="text-right">
            <p className="label">Saved YTD</p>
            <Money value={summary.realisedSavingsCents} tone="saving" className="text-caption" />
          </div>
        )}
      </header>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <main className="min-w-0 flex-1 pb-20 lg:pb-0">{children}</main>

      {/* ── Mobile tab bar ──────────────────────────────────────────────── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-paper/95 backdrop-blur-md lg:hidden"
        aria-label="Product"
      >
        <ul className="grid grid-cols-6">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex h-16 flex-col items-center justify-center gap-1 transition-colors",
                    active ? "text-forest" : "text-ink-4",
                  )}
                >
                  <Icon className="size-[18px]" strokeWidth={1.75} />
                  <span className="text-[0.5625rem] tracking-[0.02em]">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page header — shared across product screens                                 */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-rule pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-serif text-display-m">{title}</h1>
        {lede && <p className="mt-1.5 max-w-[52ch] text-body text-ink-3">{lede}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2.5">{children}</div>}
    </div>
  );
}

/** Standard page frame: consistent gutters and vertical rhythm. */
export function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="shell-x mx-auto w-full max-w-[1240px] py-8 lg:py-10">{children}</div>;
}

/** The agent status line used at the top of dense screens. */
export function StatusStrip({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 label">
      <span className="inline-flex items-center gap-1.5">
        <Activity className="size-3 text-forest" />
        Agent online
      </span>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.label}
          <span className="text-ink-2">{i.value}</span>
        </span>
      ))}
    </div>
  );
}
