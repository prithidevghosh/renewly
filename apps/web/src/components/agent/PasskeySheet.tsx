"use client";

/**
 * The passkey approval sheet — the product's core safety promise made visible.
 *
 * Every money-moving action passes through here. It shows, before the biometric:
 *   · exactly what will happen, in one sentence
 *   · exactly what will be charged, and what it saves
 *   · which guardrail permitted it
 *   · that the card minted is single-use and capped
 *
 * ⚠️  SIMULATED. There is no WebAuthn call here. The real implementation calls
 *     `navigator.credentials.get({ publicKey })` at the marked line; everything
 *     around it — copy, states, timing, focus handling — is built as if it were
 *     real so the swap is mechanical.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import type { Opportunity, User } from "@/lib/domain/types";
import { checkGuardrails, chargeForOpportunity, requestPasskey } from "@/lib/mock/mockApi";
import { Money } from "@/components/ui/Money";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Primitives";
import { cx, money } from "@/lib/format";

type Phase = "review" | "scanning" | "verified" | "blocked";

/* -------------------------------------------------------------------------- */
/* Biometric affordance                                                        */
/* -------------------------------------------------------------------------- */

/** Fingerprint drawn as concentric arcs that fill with signal as it reads. */
function Fingerprint({ progress, done }: { progress: number; done: boolean }) {
  const arcs = [
    "M32 46c0-8 6-14 14-14s14 6 14 14",
    "M26 46c0-11 9-20 20-20s20 9 20 20v6",
    "M20 48c0-14 12-26 26-26s26 12 26 26v10",
    "M38 48c0-4 3-8 8-8s8 4 8 8v14",
  ];
  return (
    <svg viewBox="0 0 92 92" className="size-full" fill="none" aria-hidden>
      <circle cx="46" cy="46" r="43" stroke="var(--rule-firm)" strokeWidth="1" />
      {arcs.map((d, i) => {
        const threshold = (i + 1) / (arcs.length + 1);
        const lit = done || progress > threshold;
        return (
          <path
            key={d}
            d={d}
            stroke={lit ? "var(--claret)" : "var(--ink-5)"}
            strokeWidth="2.25"
            strokeLinecap="round"
            style={{
              transition: "stroke var(--dur-quick) var(--ease-settle)",
              filter: lit ? "drop-shadow(0 0 5px var(--claret-soft))" : undefined,
            }}
          />
        );
      })}
      <path
        d="M46 62v10"
        stroke={done ? "var(--claret)" : "var(--ink-5)"}
        strokeWidth="2.25"
        strokeLinecap="round"
        style={{ transition: "stroke var(--dur-quick)" }}
      />
    </svg>
  );
}

/** Face ID bracket that closes as it reads. */
function FaceMark({ progress, done }: { progress: number; done: boolean }) {
  const lit = (t: number) => (done || progress > t ? "var(--claret)" : "var(--ink-5)");
  return (
    <svg viewBox="0 0 92 92" className="size-full" fill="none" aria-hidden>
      <circle cx="46" cy="46" r="43" stroke="var(--rule-firm)" strokeWidth="1" />
      {[
        ["M22 34V26a4 4 0 0 1 4-4h8", 0.1],
        ["M58 22h8a4 4 0 0 1 4 4v8", 0.35],
        ["M70 58v8a4 4 0 0 1-4 4h-8", 0.6],
        ["M34 70h-8a4 4 0 0 1-4-4v-8", 0.85],
      ].map(([d, t]) => (
        <path
          key={d as string}
          d={d as string}
          stroke={lit(t as number)}
          strokeWidth="2.5"
          strokeLinecap="round"
          style={{ transition: "stroke var(--dur-quick) var(--ease-settle)" }}
        />
      ))}
      <circle cx="38" cy="42" r="2.25" fill={lit(0.2)} />
      <circle cx="54" cy="42" r="2.25" fill={lit(0.2)} />
      <path d="M38 56c2.5 2.5 5.5 3.5 8 3.5s5.5-1 8-3.5" stroke={lit(0.7)} strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */

export function PasskeySheet({
  opportunity,
  user,
  open,
  onOpenChange,
  onApproved,
}: {
  opportunity: Opportunity | null;
  user: User | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires once the biometric resolves — caller then runs the execution. */
  onApproved: (opportunityId: string) => void;
}) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("review");
  const [progress, setProgress] = useState(0);

  const charge = opportunity ? chargeForOpportunity(opportunity) : 0;
  const verdict =
    opportunity && user ? checkGuardrails(opportunity, charge, user.guardrails) : null;
  const modality = user?.passkey.modality ?? "touch";
  const biometricName = modality === "face" ? "Face ID" : "Touch ID";

  useEffect(() => {
    if (open) {
      setPhase(verdict && !verdict.ok ? "blocked" : "review");
      setProgress(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, opportunity?.id]);

  const authenticate = useCallback(async () => {
    if (!opportunity) return;
    setPhase("scanning");

    // Drive the fill while the "biometric" resolves. Stepped with timers
    // rather than requestAnimationFrame: rAF stops in background tabs, which
    // would freeze the fingerprint mid-read even though auth had succeeded.
    const steps = reduce
      ? []
      : [0.2, 0.4, 0.6, 0.8, 1].map((v, i) =>
          setTimeout(() => setProgress(v), 230 * (i + 1)),
        );

    // ── REAL IMPLEMENTATION GOES HERE ────────────────────────────────────
    // const assertion = await navigator.credentials.get({ publicKey: challenge });
    await requestPasskey();
    // ─────────────────────────────────────────────────────────────────────

    steps.forEach(clearTimeout);
    setProgress(1);
    setPhase("verified");

    window.setTimeout(
      () => {
        onApproved(opportunity.id);
        onOpenChange(false);
      },
      reduce ? 120 : 760,
    );
  }, [opportunity, onApproved, onOpenChange, reduce]);

  if (!opportunity) return null;

  const Mark = modality === "face" ? FaceMark : Fingerprint;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(25_23_18_/_0.42)] data-[state=open]:animate-[rise_var(--dur-quick)_ease-out]" />
        <Dialog.Content
          className={cx(
            "fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-1.5rem))]",
            "-translate-x-1/2 -translate-y-1/2 rounded-xl border border-rule-firm bg-card",
            "shadow-[0_24px_64px_-16px_rgb(25_23_18/0.22)] focus:outline-none",
            "data-[state=open]:animate-[rise_var(--dur-slow)_var(--ease-settle)]",
          )}
          aria-describedby="passkey-desc"
        >
          

          <div className="relative p-6 sm:p-7">
            <div className="flex items-start justify-between">
              <div>
                <Dialog.Title className="text-title-m font-semibold tracking-[-0.015em]">
                  Approve this action
                </Dialog.Title>
                <p id="passkey-desc" className="mt-1 text-body-s text-ink-3">
                  Nothing moves until you confirm with {biometricName}.
                </p>
              </div>
              <Dialog.Close
                className="-mr-1.5 -mt-1 rounded-md p-1.5 text-ink-4 transition-colors hover:bg-hover hover:text-ink"
                aria-label="Cancel approval"
              >
                <X className="size-4" />
              </Dialog.Close>
            </div>

            {/* What will happen */}
            <div className="mt-5 rounded-lg border border-rule bg-sunk p-4">
              <p className="text-body font-medium text-ink">{opportunity.headline}</p>

              <dl className="mt-4 space-y-2.5 text-body-s">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-3">Charged now</dt>
                  <dd>
                    {charge > 0 ? (
                      <Money value={charge} tone="default" />
                    ) : (
                      <span className="figure text-ink-3">$0.00</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-3">Saves per year</dt>
                  <dd>
                    <Money value={opportunity.savingCentsPerYear} tone="saving" sign />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-3">Payment method</dt>
                  <dd className="figure text-caption text-ink-2">
                    {charge > 0 ? "single-use card · capped" : "no card required"}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Guardrail verdict — always shown, pass or fail */}
            <div
              className={cx(
                "mt-3 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-body-s",
                verdict?.ok
                  ? "border-rule bg-card text-ink-3"
                  : "border-claret/30 bg-[var(--claret-soft)] text-claret",
              )}
            >
              <ShieldCheck className="mt-px size-4 shrink-0" />
              <span>
                {verdict?.reason}{" "}
                {verdict?.ok && charge > 0 && user && (
                  <span className="text-ink-4">
                    Cap is {money(user.guardrails.perActionCapCents, { cents: false })} per action.
                  </span>
                )}
              </span>
            </div>

            {/* Biometric */}
            <div className="mt-6 flex flex-col items-center">
              <div className="relative grid size-[92px] place-items-center">
                {phase === "verified" ? (
                  <div
                    className={cx(
                      "grid size-full place-items-center rounded-full border border-forest/30 bg-[var(--forest-soft)]",
                      !reduce && "pop-in",
                    )}
                  >
                    <Check className="size-9 text-forest" strokeWidth={2.5} />
                  </div>
                ) : (
                  <div className="size-full">
                    <Mark progress={progress} done={false} />
                  </div>
                )}

                {phase === "scanning" && (
                  <span
                    className="absolute inset-[-40%] rounded-full"
                    aria-hidden
                    style={{ opacity: 0.9 }}
                  />
                )}
              </div>

              <p
                className="mt-3 h-5 label"
                aria-live="polite"
              >
                {phase === "review" && (user?.passkey.deviceLabel ?? "")}
                {phase === "scanning" && `Reading ${biometricName}…`}
                {phase === "verified" && "Verified · executing"}
                {phase === "blocked" && "Blocked by guardrail"}
              </p>
            </div>

            {/* Actions */}
            <div className="mt-5 flex gap-2.5">
              <Dialog.Close asChild>
                <Button variant="secondary" size="lg" className="flex-1">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                variant="primary"
                size="lg"
                className="flex-[1.4]"
                onClick={authenticate}
                disabled={phase !== "review" || !verdict?.ok}
              >
                {phase === "review" && `Approve with ${biometricName}`}
                {phase === "scanning" && "Hold…"}
                {phase === "verified" && "Approved"}
                {phase === "blocked" && "Can't approve"}
              </Button>
            </div>

            <p className="mt-4 text-center text-caption text-ink-4">
              Renewly never sees or stores your card. Each action gets its own scoped,
              single-use credential.
            </p>

            <Tag tone="neutral" className="absolute right-6 top-[4.7rem] sm:right-7">
              simulated
            </Tag>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
