"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, type FormEvent } from "react";

const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

type ContactResponse = {
  contact: { email: string; sentAt: string };
};

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

export function ContactButton() {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ContactResponse["contact"] | null>(null);

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
    const message = {
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      message: String(data.get("message") ?? "").trim(),
    };

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`${API_ORIGIN}/v1/contact`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });

      const payload = (await response.json().catch(() => null)) as
        ContactResponse | ErrorResponse | null;

      if (!response.ok || !payload || !("contact" in payload)) {
        const apiError = payload && "error" in payload ? payload.error : undefined;
        if (response.status === 429 || apiError?.code === "RATE_LIMITED") {
          throw new Error("Too many messages were sent at once. Please try again in a minute.");
        }
        throw new Error(apiError?.message ?? "We couldn’t send your message. Please try again.");
      }

      form.reset();
      setResult(payload.contact);
    } catch (caught) {
      setError(
        caught instanceof TypeError
          ? "The contact service is not reachable right now. Please try again shortly."
          : caught instanceof Error
            ? caught.message
            : "We couldn’t send your message. Please try again shortly.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <button type="button">Contact</button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="waitlist-overlay" />
        <Dialog.Content className="waitlist-dialog contact-dialog">
          <Dialog.Close className="waitlist-close" aria-label="Close contact form">
            <CloseMark />
          </Dialog.Close>

          {result ? (
            <div className="waitlist-success">
              <div className="waitlist-check">
                <CheckMark />
              </div>
              <p className="waitlist-kicker">Message received</p>
              <Dialog.Title>Thank you for writing.</Dialog.Title>
              <Dialog.Description className="waitlist-description">
                Your note was delivered. We’ll reply directly to {result.email}.
              </Dialog.Description>
              <Dialog.Close className="btn waitlist-done">Done</Dialog.Close>
            </div>
          ) : (
            <>
              <p className="waitlist-kicker">Contact</p>
              <Dialog.Title>How can we help?</Dialog.Title>
              <Dialog.Description className="waitlist-description">
                Send us a note and we’ll respond at the email address you provide.
              </Dialog.Description>

              <form onSubmit={submit} className="waitlist-form">
                <label>
                  <span>Name</span>
                  <input
                    type="text"
                    name="name"
                    autoComplete="name"
                    maxLength={200}
                    placeholder="Ada Lovelace"
                    required
                    autoFocus
                  />
                </label>
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    name="email"
                    autoComplete="email"
                    maxLength={320}
                    placeholder="ada@company.com"
                    required
                  />
                </label>
                <label>
                  <span>Message</span>
                  <textarea
                    name="message"
                    maxLength={5000}
                    rows={5}
                    placeholder="Tell us what’s on your mind."
                    required
                  />
                </label>

                {error ? (
                  <p className="waitlist-error" role="alert">
                    {error}
                  </p>
                ) : null}

                <button type="submit" className="btn waitlist-submit" disabled={submitting}>
                  {submitting ? "Sending…" : "Send message"}
                </button>
              </form>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
