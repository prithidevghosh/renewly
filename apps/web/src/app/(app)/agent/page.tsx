"use client";

/**
 * ── THE AGENT SURFACE ─────────────────────────────────────────────────────
 *
 * The screen the whole product lives in. It plays the loop end to end:
 *
 *   Detect  → the overnight sweep strip
 *   Propose → a streamed message + the proposal card with the dollar number
 *   Approve → the passkey sheet
 *   Execute → the live step trace
 *   Prove   → the ledger confirmation
 *
 * ⚠️  No LLM is called. Replies are templated from the mock store — every
 *     figure quoted below is read out of real (mock) state, not hardcoded, so
 *     the agent never contradicts the dashboard.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUp, CornerDownLeft, RotateCw } from "lucide-react";
import { Mark, type MarkState } from "@/components/brand/Mark";
import { ExecutionTrace, ProposalCard } from "@/components/agent/Proposal";
import { StreamingText } from "@/components/ui/StreamingText";
import { Button } from "@/components/ui/Button";
import { Tag, VendorMark } from "@/components/ui/Primitives";
import { useRenewly } from "@/lib/store/RenewlyStore";
import type { ChatMessage } from "@/lib/domain/types";
import { daysUntil, money, relativeDays } from "@/lib/format";

/* -------------------------------------------------------------------------- */
/* Detection strip — the "Detect" step made visible                            */
/* -------------------------------------------------------------------------- */

function DetectionStrip({
  vendor,
  daysToRenewal,
  amountCents,
}: {
  vendor: string;
  daysToRenewal: number;
  amountCents: number;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-claret/25 bg-[var(--claret-soft)] px-3.5 py-3">
      <VendorMark initials={vendor.slice(0, 2)} size={30} />
      <div className="min-w-0 flex-1">
        <p className="label text-claret">Renewal detected</p>
        <p className="mt-0.5 text-body-s text-ink-2">
          {vendor} · <span className="figure">{money(amountCents)}</span> in{" "}
          {daysToRenewal} days
        </p>
      </div>
      <Link
        href="/radar"
        className="rounded-md label underline-offset-4 transition-colors hover:text-ink-2 hover:underline"
      >
        Radar
      </Link>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Message row                                                                 */
/* -------------------------------------------------------------------------- */

function MessageRow({
  message,
  children,
  onStreamed,
}: {
  message: ChatMessage;
  children?: React.ReactNode;
  onStreamed?: () => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm border border-rule-firm bg-card px-3.5 py-2.5 text-body text-ink">
          {message.body}
        </div>
      </div>
    );
  }

  // Agent messages are unboxed — the agent owns the page, the user is the guest.
  return (
    <div className="flex gap-3 sm:gap-4">
      <div className="w-6 shrink-0 pt-0.5 sm:w-7">
        <Mark size={22} state="idle" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-body leading-relaxed text-ink-2 [&>span]:text-ink-2">
          <StreamingText text={message.body} instant={message.instant} onDone={onStreamed} />
        </p>
        {message.detection && <DetectionStrip {...message.detection} />}
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Scripted responder — templated from live mock state, never an LLM           */
/* -------------------------------------------------------------------------- */

interface RespondCtx {
  summary: ReturnType<typeof useRenewly>["summary"];
  subscriptions: ReturnType<typeof useRenewly>["subscriptions"];
  opportunities: ReturnType<typeof useRenewly>["opportunities"];
}

function respond(input: string, ctx: RespondCtx): { body: string; opportunityId?: string } {
  const q = input.toLowerCase();
  const open = ctx.opportunities.filter((o) => o.status === "open");
  const live = ctx.subscriptions.filter((s) => !s.cancelledAt);

  // Direct vendor mention → surface that vendor's proposal.
  const byVendor = open.find((o) => q.includes(o.vendor.toLowerCase()));
  if (byVendor) {
    return {
      body: `${byVendor.rationale} I can handle it now — you'd keep ${money(
        byVendor.savingCentsPerYear,
        { cents: false },
      )} a year.`,
      opportunityId: byVendor.id,
    };
  }

  if (/(saved|savings|save|how much have)/.test(q) && ctx.summary) {
    return {
      body: `I've realised ${money(ctx.summary.realisedSavingsCents)} in annualised savings so far this year across ${
        ctx.subscriptions.length
      } tracked tools. There's another ${money(
        ctx.summary.projectedSavingsCents,
      )} a year sitting in ${open.length} open opportunities — the ledger has every receipt.`,
    };
  }

  if (/(zombie|unused|dead|not using|idle)/.test(q)) {
    const zombies = live.filter((s) => s.status === "zombie" || s.status === "underused");
    return {
      body: `${zombies.length} tools are earning their keep badly: ${zombies
        .map((z) => `${z.vendor} (${z.status})`)
        .join(", ")}. The clearest kills are Webflow — no publish in 168 days — and Loom, zero recordings since February.`,
    };
  }

  if (/(renew|upcoming|this week|due|soon|deadline)/.test(q)) {
    const soon = live
      .filter((s) => daysUntil(s.nextRenewal) >= 0 && daysUntil(s.nextRenewal) <= 14)
      .sort((a, b) => daysUntil(a.nextRenewal) - daysUntil(b.nextRenewal));
    return {
      body: `${soon.length} renewals land in the next fortnight: ${soon
        .map((s) => `${s.vendor} ${relativeDays(s.nextRenewal)} (${money(s.amountCents)})`)
        .join(", ")}. Figma is the one that actually needs a decision.`,
    };
  }

  if (/(spend|total|cost|paying|budget)/.test(q) && ctx.summary) {
    return {
      body: `You're at ${money(ctx.summary.monthlyCents)} a month — ${money(
        ctx.summary.annualCents,
      )} a year across ${ctx.summary.subscriptionCount} subscriptions. About ${Math.round(
        (ctx.summary.projectedSavingsCents / ctx.summary.annualCents) * 100,
      )}% of that is recoverable without losing a single tool anyone actually uses.`,
    };
  }

  if (/(safe|secure|card|trust|how do you pay)/.test(q)) {
    return {
      body: `I never hold your card. For each action I mint a single-use credential scoped to one vendor and capped at the exact amount you approved, and it dies on use. Nothing moves without a passkey from you — your guardrails cap me at $500 per action and $2,000 a month.`,
    };
  }

  if (/(everything|all of it|do it all|go ahead)/.test(q)) {
    return {
      body: `I can queue all ${open.length} open actions — that's ${money(
        open.reduce((t, o) => t + o.savingCentsPerYear, 0),
      )} a year. You'll still approve each money-moving one separately; that's not something I'll route around. Starting with the highest impact.`,
      opportunityId: open[0]?.id,
    };
  }

  const next = open[0];
  return {
    body: next
      ? `I can answer on spend, renewals, unused seats, or how payments stay safe. Right now the highest-value thing on the table is ${next.vendor}: ${next.headline.toLowerCase()}, worth ${money(
          next.savingCentsPerYear,
          { cents: false },
        )} a year.`
      : `Everything's clean — no open opportunities. I'll keep watching and message you when something changes.`,
    opportunityId: next?.id,
  };
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

const SUGGESTIONS = [
  "What renews this week?",
  "How much have you saved me?",
  "Show me the zombie subscriptions",
  "How do payments stay safe?",
];

export default function AgentPage() {
  const {
    ready,
    chat,
    opportunities,
    subscriptions,
    summary,
    pushMessage,
    openApproval,
    dismiss,
    liveAction,
  } = useRenewly();

  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const executedRef = useRef<string | null>(null);
  const approvedRef = useRef<string | null>(null);

  const ctx = useMemo(
    () => ({ summary, subscriptions, opportunities }),
    [summary, subscriptions, opportunities],
  );

  /* --- Detect → Propose: the opening proposal ---------------------------- */
  useEffect(() => {
    if (!ready || openedRef.current) return;
    const opening = opportunities.find((o) => o.id === "opp_figma_seats" && o.status === "open");
    if (!opening) return;
    openedRef.current = true;

    const t = setTimeout(() => {
      pushMessage({
        role: "agent",
        body: "Here's what I'd do. Three of those four seats haven't opened a file in over 90 days, so I'd renew on one editor and move the rest to free viewer access. Nobody loses anything they're using.",
        opportunityId: opening.id,
      });
    }, 700);
    return () => clearTimeout(t);
  }, [ready, opportunities, pushMessage]);

  /* --- Execute → Prove: narrate the action as it runs -------------------- */
  useEffect(() => {
    if (!liveAction) return;

    if (liveAction.state === "executing" && approvedRef.current !== liveAction.id) {
      approvedRef.current = liveAction.id;
      pushMessage({
        role: "agent",
        body: `Approved with your passkey. Executing now — I'll mint a single-use card capped at ${money(
          liveAction.chargedCents,
        )} and complete it directly with ${liveAction.vendor}.`,
        actionId: liveAction.id,
      });
    }

    if (liveAction.state === "executed" && executedRef.current !== liveAction.id) {
      executedRef.current = liveAction.id;
      setTimeout(() => {
        pushMessage({
          role: "agent",
          body: `Done. ${liveAction.vendor} is settled and the receipt is in your ledger — ${money(
            liveAction.savingCentsPerYear,
          )} a year back in the business. I'll keep watching the rest.`,
        });
      }, 500);
    }
  }, [liveAction, pushMessage]);

  /* --- Autoscroll -------------------------------------------------------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [chat.length, liveAction?.steps, thinking]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pushMessage({ role: "user", body: trimmed });
      setInput("");
      setThinking(true);

      // Believable "composing" delay — scaled to answer length, like a real agent.
      window.setTimeout(
        () => {
          const reply = respond(trimmed, ctx);
          setThinking(false);
          pushMessage({
            role: "agent",
            body: reply.body,
            opportunityId: reply.opportunityId,
          });
        },
        620 + Math.random() * 520,
      );
    },
    [ctx, pushMessage],
  );

  const agentState: MarkState = thinking
    ? "thinking"
    : liveAction?.state === "executing"
      ? "acting"
      : liveAction?.state === "executed"
        ? "settled"
        : "idle";

  const openCount = opportunities.filter((o) => o.status === "open").length;

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] flex-col lg:h-dvh">
      {/* Header */}
      <header className="shrink-0 border-b border-rule bg-paper/90 backdrop-blur-sm">
        <div className="shell-x mx-auto flex h-14 w-full max-w-[820px] items-center justify-between">
          <div className="flex items-center gap-3">
            <Mark size={26} state={agentState} />
            <div>
              <p className="text-title-s font-semibold leading-none">Renewly</p>
              <p className="mt-1 label">
                {agentState === "thinking"
                  ? "Composing"
                  : agentState === "acting"
                    ? "Executing"
                    : "Watching · 12 tools"}
              </p>
            </div>
          </div>
          {summary && (
            <div className="flex items-center gap-2">
              <Tag tone="forest">{openCount} open</Tag>
              <Tag tone="neutral">{money(summary.projectedSavingsCents, { cents: false })}/yr</Tag>
            </div>
          )}
        </div>
      </header>

      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="shell-x mx-auto w-full max-w-[820px] space-y-7 py-7">
          {!ready && (
            <div className="flex items-center gap-3 text-body-s text-ink-4">
              <Mark size={22} state="scanning" />
              Waking the agent…
            </div>
          )}

          {chat.map((m) => {
            const opp = m.opportunityId
              ? opportunities.find((o) => o.id === m.opportunityId)
              : undefined;
            const act =
              m.actionId && liveAction?.id === m.actionId ? liveAction : undefined;

            return (
              <MessageRow key={m.id} message={m}>
                {opp && (
                  <div className="mt-4">
                    <ProposalCard
                      opportunity={opp}
                      locked={opp.status !== "open"}
                      onApprove={openApproval}
                      onDecline={(id) => {
                        void dismiss(id);
                        pushMessage({
                          role: "agent",
                          body: "Understood — I'll leave it. I'll flag it again if the price moves or usage changes.",
                        });
                      }}
                    />
                  </div>
                )}
                {act && (
                  <div className="mt-4">
                    <ExecutionTrace action={act} />
                  </div>
                )}
              </MessageRow>
            );
          })}

          {thinking && (
            <div className="flex gap-3 sm:gap-4">
              <div className="w-6 shrink-0 pt-0.5 sm:w-7">
                <Mark size={22} state="thinking" />
              </div>
              <div className="flex items-center gap-1.5 pt-1.5" aria-label="Agent is composing">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="size-1.5 rounded-full bg-ink-4 motion-safe:pulse-soft"
                    style={{ animationDelay: `${i * 160}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-rule bg-paper">
        <div className="shell-x mx-auto w-full max-w-[820px] py-3.5">
          <div className="mb-2.5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="shrink-0 rounded-full border border-rule px-3 py-1.5 text-caption text-ink-3 transition-colors hover:border-rule-ink hover:bg-hover hover:text-ink-2"
              >
                {s}
              </button>
            ))}
            <Link
              href="/opportunities"
              className="ml-auto hidden shrink-0 items-center gap-1.5 rounded-full border border-rule px-3 py-1.5 text-caption text-ink-4 transition-colors hover:text-ink-2 sm:inline-flex"
            >
              <RotateCw className="size-3" />
              All opportunities
            </Link>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 rounded-lg border border-rule-firm bg-card p-1.5 transition-colors focus-within:border-rule-ink"
          >
            <label htmlFor="agent-input" className="sr-only">
              Message Renewly
            </label>
            <input
              id="agent-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about spend, renewals, or tell me what to cancel…"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink-4"
            />
            <Button
              type="submit"
              variant={input.trim() ? "primary" : "secondary"}
              size="sm"
              className="size-8 !px-0"
              aria-label="Send message"
              disabled={!input.trim()}
            >
              <ArrowUp className="size-4" />
            </Button>
          </form>

          <p className="mt-2 flex items-center gap-1.5 label">
            <CornerDownLeft className="size-3" />
            Simulated agent · scripted from mock data · no money moves
          </p>
        </div>
      </div>
    </div>
  );
}
