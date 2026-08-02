"use client";

/**
 * The pay page. Opened from the link texted into the thread, on whatever
 * device received it — there is no session here and must never need to be.
 * The single-use token in the query string is the entire credential; every
 * API call below carries it and nothing else.
 *
 * Flow: bootstrap → mount Prava's hosted page → the user authorises with a
 * passkey → confirm completion → show the proof.
 *
 * Prava's hosted page may refuse to be embedded (X-Frame-Options /
 * frame-ancestors), so the iframe is an attempt, not an assumption: a
 * new-tab link and an explicit "I've completed payment" confirmation are
 * always present, and completion is idempotent server-side either way.
 */

import { use, useCallback, useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch, RenewlyApiError } from "@/lib/api/client";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, Label, Rule, Tag } from "@/components/ui/Primitives";

interface PayBootstrap {
  approvalId: string;
  sessionId: string;
  hostedUrl: string;
  amount: string;
  currency: string;
  merchantName: string;
  expiresAt: string;
}

interface CompleteResponse {
  approval: {
    state: string;
    merchantName: string;
    resultPayload: { amount?: string; cardLast4?: string } | null;
  };
  transactionId: string | null;
  receiptId: string | null;
  executed: boolean;
}

type Phase =
  | { name: "loading" }
  | { name: "error"; title: string; detail: string | null }
  | { name: "ready"; bootstrap: PayBootstrap }
  | { name: "completing"; bootstrap: PayBootstrap }
  | { name: "done"; bootstrap: PayBootstrap; result: CompleteResponse };

/** Each backend code maps to one sentence the person on the phone can act on. */
function describeError(error: unknown): { title: string; detail: string | null } {
  if (error instanceof RenewlyApiError) {
    switch (error.code) {
      case "UNAUTHORIZED":
      case "NOT_FOUND":
        return { title: "This link is not valid.", detail: null };
      case "APPROVAL_EXPIRED":
        return {
          title: "This link has expired.",
          detail: "Reply RETRY in the thread to get a fresh one.",
        };
      case "INVALID_STATE_TRANSITION":
        return {
          title: "This payment has already been completed.",
          detail: "If that doesn't sound right, check the thread for the latest message.",
        };
      default:
        return { title: "Something went wrong.", detail: error.message };
    }
  }
  return { title: "Something went wrong.", detail: null };
}

function PayPageInner({ approvalId }: { approvalId: string }) {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  useEffect(() => {
    let cancelled = false;

    apiFetch<PayBootstrap>(
      `/v1/approvals/${approvalId}/pay-bootstrap?token=${encodeURIComponent(token)}`,
    )
      .then((bootstrap) => {
        if (!cancelled) setPhase({ name: "ready", bootstrap });
      })
      .catch((error) => {
        if (!cancelled) setPhase({ name: "error", ...describeError(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [approvalId, token]);

  const complete = useCallback(async () => {
    if (phase.name !== "ready") return;
    const { bootstrap } = phase;
    setPhase({ name: "completing", bootstrap });

    try {
      const result = await apiFetch<CompleteResponse>(
        `/v1/approvals/${approvalId}/prava/complete?token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      setPhase({ name: "done", bootstrap, result });
    } catch (error) {
      // "Already completed" on confirm is success seen twice, not a failure.
      if (error instanceof RenewlyApiError && error.code === "INVALID_STATE_TRANSITION") {
        setPhase({
          name: "error",
          title: "This payment has already been completed.",
          detail: "The receipt is in your thread.",
        });
        return;
      }
      setPhase({ name: "error", ...describeError(error) });
    }
  }, [phase, approvalId, token]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-4 px-4 py-10">
      <p className="marker">Renewly — secure payment</p>

      {phase.name === "loading" && (
        <Card className="p-6">
          <p className="text-ink-3">Preparing your payment…</p>
        </Card>
      )}

      {phase.name === "error" && (
        <Card className="p-6">
          <h1 className="text-lg font-medium text-ink">{phase.title}</h1>
          {phase.detail && <p className="mt-2 text-[0.875rem] text-ink-3">{phase.detail}</p>}
        </Card>
      )}

      {(phase.name === "ready" || phase.name === "completing") && (
        <>
          <Card className="p-6">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <Label>Paying</Label>
                <h1 className="text-lg font-medium text-ink">{phase.bootstrap.merchantName}</h1>
              </div>
              <div className="text-right">
                <Label>Amount</Label>
                <p className="text-lg font-medium text-ink tabular-nums">
                  {phase.bootstrap.amount} {phase.bootstrap.currency}
                </p>
              </div>
            </div>
            <Rule className="my-4" />
            <p className="text-[0.8125rem] text-ink-4">
              This link expires {new Date(phase.bootstrap.expiresAt).toLocaleString()}. Authorise
              with your passkey below, then confirm.
            </p>
          </Card>

          <Card className="overflow-hidden">
            <iframe
              src={phase.bootstrap.hostedUrl}
              title="Prava secure payment"
              className="h-[420px] w-full border-0"
              allow="publickey-credentials-get *; payment *"
            />
          </Card>

          <Card className="flex flex-col gap-3 p-6">
            <p className="text-[0.8125rem] text-ink-3">
              If the payment page did not load above, open it in a new tab — then come back and
              confirm.
            </p>
            <div className="flex flex-wrap gap-3">
              <ButtonLink
                href={phase.bootstrap.hostedUrl}
                target="_blank"
                rel="noreferrer"
                variant="secondary"
              >
                Open payment page
              </ButtonLink>
              <Button
                variant="primary"
                onClick={() => void complete()}
                disabled={phase.name === "completing"}
              >
                {phase.name === "completing" ? "Confirming…" : "I've completed payment"}
              </Button>
            </div>
          </Card>
        </>
      )}

      {phase.name === "done" && (
        <Card className="p-6">
          <Tag tone="forest">Paid</Tag>
          <h1 className="mt-3 text-lg font-medium text-ink">
            {phase.bootstrap.merchantName} — {phase.bootstrap.amount} {phase.bootstrap.currency}
          </h1>
          <Rule className="my-4" />
          <dl className="grid gap-2 text-[0.875rem]">
            {phase.result.approval.resultPayload?.cardLast4 && (
              <div className="flex justify-between">
                <dt className="text-ink-4">Card</dt>
                <dd className="text-ink tabular-nums">
                  ···· {phase.result.approval.resultPayload.cardLast4}
                </dd>
              </div>
            )}
            {phase.result.receiptId && (
              <div className="flex justify-between">
                <dt className="text-ink-4">Receipt</dt>
                <dd className="text-ink">{phase.result.receiptId}</dd>
              </div>
            )}
          </dl>
          <p className="mt-4 text-[0.8125rem] text-ink-4">
            The proof has been posted back into your thread. You can close this page.
          </p>
        </Card>
      )}
    </main>
  );
}

export default function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <PayPageInner approvalId={id} />
    </Suspense>
  );
}
