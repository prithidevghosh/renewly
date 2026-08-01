"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, type FormEvent, type ReactNode } from "react";

const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

type WaitlistResult = {
  email: string;
  position: number;
  alreadyJoined: boolean;
  welcomeEmail: string;
  joinedAt: string;
};

type WaitlistResponse = { waitlist: WaitlistResult };
type ErrorResponse = { error?: { code?: string; message?: string } };

function CheckMark() {
  return (
    <svg viewBox="0 0 56 56" width="56" height="56" fill="none" aria-hidden="true">
      <circle cx="28" cy="28" r="27" stroke="currentColor" strokeOpacity=".22" />
      <path
        d="m17 28.5 7 7L39.5 20"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseMark() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" fill="none" aria-hidden="true">
      <path d="m4 4 10 10M14 4 4 14" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

export function WaitlistButton({
  source,
  className,
  children = "Join the waitlist",
}: {
  source: string;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WaitlistResult | null>(null);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setError(null);
      setResult(null);
    }
    setOpen(next);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const name = String(data.get("name") ?? "").trim();

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`${API_ORIGIN}/v1/waitlist`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          ...(name ? { name } : {}),
          source,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        WaitlistResponse | ErrorResponse | null;
      if (!response.ok || !payload || !("waitlist" in payload)) {
        const apiError = payload && "error" in payload ? payload.error : undefined;
        if (response.status === 429 || apiError?.code === "RATE_LIMITED") {
          throw new Error(
            "A few too many requests reached us at once. Please try again in a minute.",
          );
        }
        throw new Error(apiError?.message ?? "We could not save your place. Please try again.");
      }

      setResult(payload.waitlist);
      form.reset();
    } catch (caught) {
      setError(
        caught instanceof TypeError
          ? "The waitlist service is not reachable right now. Please try again shortly."
          : caught instanceof Error
            ? caught.message
            : "We could not save your place. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <button type="button" className={className}>
          {children}
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="waitlist-overlay" />
        <Dialog.Content className="waitlist-dialog">
          <Dialog.Close className="waitlist-close" aria-label="Close waitlist form">
            <CloseMark />
          </Dialog.Close>

          {result ? (
            <div className="waitlist-success">
              <div className="waitlist-check">
                <CheckMark />
              </div>
              <p className="waitlist-kicker">Place confirmed</p>
              <Dialog.Title>
                {result.alreadyJoined ? "You were already with us." : "You’re on the waitlist."}
              </Dialog.Title>
              <Dialog.Description className="waitlist-description">
                {result.alreadyJoined
                  ? "Your original place is still yours. Nothing was moved or duplicated."
                  : "Your place is secured. We’ll let you know when Renewly is ready for you."}
              </Dialog.Description>

              <div
                className="waitlist-position"
                aria-label={`Waitlist position ${result.position}`}
              >
                <span>No.</span>
                <strong>{result.position.toLocaleString("en-US")}</strong>
              </div>

              <p className="waitlist-confirmation">
                {result.welcomeEmail === "sent"
                  ? `A confirmation is on its way to ${result.email}.`
                  : `Your place is saved for ${result.email}. Email confirmation may take a little longer.`}
              </p>
              <Dialog.Close className="btn waitlist-done">Done</Dialog.Close>
            </div>
          ) : (
            <div className="waitlist-form-state">
              <p className="waitlist-kicker">Early access</p>
              <Dialog.Title>Put recurring spend under your law.</Dialog.Title>
              <Dialog.Description className="waitlist-description">
                Join the first group using Renewly to decide, authorize and prove every recurring
                commitment.
              </Dialog.Description>

              <form onSubmit={submit} className="waitlist-form">
                <label>
                  <span>
                    Name <small>optional</small>
                  </span>
                  <input
                    type="text"
                    name="name"
                    autoComplete="name"
                    maxLength={200}
                    placeholder="Ada Lovelace"
                  />
                </label>
                <label>
                  <span>Work email</span>
                  <input
                    type="email"
                    name="email"
                    autoComplete="email"
                    maxLength={320}
                    placeholder="ada@company.com"
                    required
                    autoFocus
                  />
                </label>

                {error ? (
                  <p className="waitlist-error" role="alert">
                    {error}
                  </p>
                ) : null}

                <button type="submit" className="btn waitlist-submit" disabled={submitting}>
                  {submitting ? "Saving your place…" : "Join the waitlist"}
                </button>
                <p className="waitlist-fine">
                  No card. No workspace access. Just your place in line.
                </p>
              </form>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
