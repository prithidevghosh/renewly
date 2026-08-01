"use client";

/**
 * Screen B — Onboarding.
 *
 * Three steps: connect a source, register the passkey, then watch the first
 * inventory assemble itself. The scan is the payoff — subscriptions stream in
 * one at a time with the running total climbing, so the value lands before the
 * user has done any work.
 *
 * ⚠️  Every connection is simulated. No OAuth, no WebAuthn, no mailbox is read.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "motion/react";
import { ArrowRight, Check, CreditCard, Fingerprint, Inbox, Mail } from "lucide-react";
import { Mark, Wordmark } from "@/components/brand/Mark";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, Tag, Marker, VendorMark } from "@/components/ui/Primitives";
import { BigMoney, Money } from "@/components/ui/Money";
import { StreamingText } from "@/components/ui/StreamingText";
import { connectSource, registerPasskey, runFirstScan } from "@/lib/mock/mockApi";
import type { Subscription } from "@/lib/domain/types";
import { annualise, cx, money } from "@/lib/format";

type Step = "connect" | "passkey" | "scan" | "done";

const SOURCES = [
  {
    id: "src_alias",
    icon: Inbox,
    label: "Forwarding alias",
    detail: "northbeam@in.renewly.app",
    blurb: "Forward receipts. Nothing else is read.",
  },
  {
    id: "src_gmail",
    icon: Mail,
    label: "Gmail",
    detail: "ada@northbeam.co",
    blurb: "Read-only scope, receipts only.",
  },
  {
    id: "src_card",
    icon: CreditCard,
    label: "Company card",
    detail: "Ramp · •••• 4417",
    blurb: "Statement feed. No spending access.",
  },
] as const;

export default function OnboardingPage() {
  const reduce = useReducedMotion();
  const [step, setStep] = useState<Step>("connect");
  const [connected, setConnected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [passkeyState, setPasskeyState] = useState<"idle" | "working" | "done">("idle");
  const [found, setFound] = useState<Subscription[]>([]);
  const [scanDone, setScanDone] = useState(false);
  const scanStarted = useRef(false);

  const total = found.reduce((t, s) => t + annualise(s.amountCents, s.cadence), 0);

  const handleConnect = useCallback(async (id: string) => {
    setBusy(id);
    await connectSource(id);
    setConnected((c) => [...c, id]);
    setBusy(null);
  }, []);

  const handlePasskey = useCallback(async () => {
    setPasskeyState("working");
    await registerPasskey();
    setPasskeyState("done");
    setTimeout(() => setStep("scan"), 700);
  }, []);

  /* The reveal: subscriptions stream in one at a time. */
  useEffect(() => {
    if (step !== "scan" || scanStarted.current) return;
    scanStarted.current = true;
    void runFirstScan((sub) => setFound((f) => [...f, sub])).then(() => {
      setTimeout(() => setScanDone(true), 400);
    });
  }, [step]);

  const stepIndex = { connect: 0, passkey: 1, scan: 2, done: 2 }[step];

  return (
    <div className="relative min-h-dvh">
      

      <header className="shell-x relative mx-auto flex h-16 w-full max-w-[880px] items-center justify-between">
        <Link href="/" className="rounded-md">
          <Wordmark size={24} />
        </Link>
        <span className="label">
          Step {stepIndex + 1} of 3
        </span>
      </header>

      {/* Progress rail */}
      <div className="shell-x relative mx-auto w-full max-w-[880px]">
        <div className="flex gap-1.5">
          {["Connect", "Secure", "Inventory"].map((label, i) => (
            <div key={label} className="flex-1">
              <div
                className={cx(
                  "h-[2px] rounded-full transition-colors duration-[var(--dur-slow)]",
                  i <= stepIndex ? "bg-forest" : "bg-press",
                )}
              />
              <p
                className={cx(
                  "mt-2 label transition-colors",
                  i <= stepIndex ? "text-ink-2" : "text-ink-4",
                )}
              >
                {label}
              </p>
            </div>
          ))}
        </div>
      </div>

      <main className="shell-x relative mx-auto w-full max-w-[880px] pb-24 pt-12">
          {/* ── Connect ─────────────────────────────────────────────────── */}
          {step === "connect" && (
            <div key="connect" className={cx(!reduce && "stage-in")}>
              <Marker>Detect</Marker>
              <h1 className="mt-4 max-w-[18ch] font-serif text-display-l">
                Show me where the receipts land.
              </h1>
              <p className="mt-4 max-w-[56ch] text-body text-ink-3">
                Connect one source and I&rsquo;ll build your inventory in about a minute. I only
                read billing receipts and statement lines — never your mail, never your files.
              </p>

              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                {SOURCES.map((s) => {
                  const isConnected = connected.includes(s.id);
                  const isBusy = busy === s.id;
                  const Icon = s.icon;
                  return (
                    <Card
                      key={s.id}
                      className={cx(
                        "flex flex-col p-4 transition-colors",
                        isConnected && "border-forest/30",
                      )}
                    >
                      <span
                        className={cx(
                          "grid size-10 place-items-center rounded-lg border",
                          isConnected
                            ? "border-forest/30 bg-[var(--forest-soft)]"
                            : "border-rule-firm bg-sunk",
                        )}
                      >
                        <Icon
                          className={cx("size-4", isConnected ? "text-forest" : "text-ink-3")}
                          strokeWidth={1.75}
                        />
                      </span>
                      <p className="mt-3.5 text-body font-medium text-ink">{s.label}</p>
                      <p className="mt-0.5 truncate figure text-caption text-ink-4">
                        {s.detail}
                      </p>
                      <p className="mt-2 flex-1 text-body-s text-ink-3">{s.blurb}</p>
                      {/* Three equal choices, so none of them is *the* primary
                          action — "Continue" is. See DESIGN.md §2.2. */}
                      <Button
                        size="sm"
                        variant="secondary"
                        className="mt-4"
                        disabled={isConnected || isBusy}
                        onClick={() => void handleConnect(s.id)}
                      >
                        {isConnected ? (
                          <>
                            <Check className="size-3.5" /> Connected
                          </>
                        ) : isBusy ? (
                          "Connecting…"
                        ) : (
                          "Connect"
                        )}
                      </Button>
                    </Card>
                  );
                })}
              </div>

              <div className="mt-8 flex items-center gap-4">
                <Button
                  variant="primary"
                  size="lg"
                  disabled={connected.length === 0}
                  onClick={() => setStep("passkey")}
                >
                  Continue
                  <ArrowRight className="size-4" />
                </Button>
                <span className="label">
                  {connected.length === 0 ? "Connect at least one" : `${connected.length} connected`}
                </span>
              </div>
            </div>
          )}

          {/* ── Passkey ─────────────────────────────────────────────────── */}
          {step === "passkey" && (
            <div key="passkey" className={cx(!reduce && "stage-in")}>
              <Marker>Approve</Marker>
              <h1 className="mt-4 max-w-[20ch] font-serif text-display-l">
                Nothing moves without your thumb.
              </h1>
              <p className="mt-4 max-w-[58ch] text-body text-ink-3">
                Register a passkey. Every action that touches money will ask for it — no password,
                no fallback, no way for me to route around you.
              </p>

              <Card className="mt-8 max-w-[30rem] p-6">
                <div className="flex items-start gap-4">
                  <span
                    className={cx(
                      "grid size-12 shrink-0 place-items-center rounded-lg border transition-colors",
                      passkeyState === "done"
                        ? "border-forest/30 bg-[var(--forest-soft)]"
                        : "border-rule-firm bg-sunk",
                    )}
                  >
                    {passkeyState === "done" ? (
                      <Check className="size-5 text-forest" strokeWidth={2.5} />
                    ) : (
                      <Fingerprint
                        className={cx(
                          "size-5",
                          passkeyState === "working" ? "text-forest" : "text-ink-3",
                        )}
                        strokeWidth={1.75}
                      />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="text-body font-medium text-ink">MacBook Pro · Touch ID</p>
                    <p className="mt-0.5 text-body-s text-ink-3">
                      {passkeyState === "idle" && "This device supports platform passkeys."}
                      {passkeyState === "working" && "Waiting for your fingerprint…"}
                      {passkeyState === "done" && "Registered. You're the only approver."}
                    </p>
                  </div>
                </div>

                <Button
                  variant="primary"
                  size="lg"
                  className="mt-5 w-full"
                  disabled={passkeyState !== "idle"}
                  onClick={() => void handlePasskey()}
                >
                  {passkeyState === "idle" && "Register passkey"}
                  {passkeyState === "working" && "Hold…"}
                  {passkeyState === "done" && "Registered"}
                </Button>

                <p className="mt-3 text-center label">
                  Simulated · no credential is created
                </p>
              </Card>
            </div>
          )}

          {/* ── Scan ────────────────────────────────────────────────────── */}
          {step === "scan" && (
            <div key="scan" className={cx(!reduce && "stage-in")}>
              <div className="flex flex-col items-center text-center">
                <Mark size={72} state={scanDone ? "settled" : "scanning"} />
                <h1 className="mt-7 max-w-[20ch] font-serif text-display-l">
                  {scanDone ? "Here's what you're paying for." : "Reading your receipts."}
                </h1>
                <p className="mt-4 max-w-[52ch] text-body text-ink-3">
                  <StreamingText
                    text={
                      scanDone
                        ? `${found.length} subscriptions, ${money(total)} a year. I've already spotted where it's leaking.`
                        : "Matching invoices, card lines and renewal notices…"
                    }
                    instant={!scanDone}
                    showCaret={false}
                  />
                </p>

                <div className="mt-8">
                  <p className="label">Annual spend found</p>
                  <div className="mt-2">
                    <BigMoney value={total} tone="default" />
                  </div>
                </div>
              </div>

              {/* Streamed findings */}
              <Card className="mt-10 divide-y divide-[var(--rule)]">
                  {found.map((s, i) => (
                    <div
                      key={s.id}
                      className={cx(
                        "flex items-center gap-3 px-4 py-3",
                        !reduce && "slide-in",
                      )}
                    >
                      <span className="w-7 shrink-0 figure text-caption figure text-ink-4">
                        {(i + 1).toString().padStart(2, "0")}
                      </span>
                      <VendorMark initials={s.initials} size={30} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-body-s font-medium text-ink">
                            {s.vendor}
                          </span>
                          {s.status !== "active" && <Tag tone="claret">{s.status}</Tag>}
                        </div>
                        <p className="truncate text-caption text-ink-4">{s.evidence}</p>
                      </div>
                      <Money value={s.amountCents} className="text-body-s" />
                    </div>
                  ))}
        
                {!scanDone && (
                  <div className="flex items-center gap-3 px-4 py-3.5 text-body-s text-ink-4">
                    <Mark size={20} state="scanning" />
                    Scanning…
                  </div>
                )}
              </Card>

              {scanDone && (
                <div
                  className={cx(
                    "mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center",
                    !reduce && "stage-in",
                  )}
                >
                  <ButtonLink href="/agent" variant="primary" size="lg">
                    See what I&rsquo;d do about it
                    <ArrowRight className="size-4" />
                  </ButtonLink>
                  <ButtonLink href="/dashboard" variant="quiet" size="lg">
                    Just show me the list
                  </ButtonLink>
                </div>
              )}
            </div>
          )}
      </main>
    </div>
  );
}
