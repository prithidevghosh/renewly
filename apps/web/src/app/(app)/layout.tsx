"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Mark } from "@/components/brand/Mark";
import { apiFetch, RenewlyApiError } from "@/lib/api/client";
import type { MailboxConnection, MeResponse } from "@/lib/api/types";

const LIVE_ROUTES = new Set(["/agent", "/dashboard"]);

/**
 * Hard product boundary. Only backend-integrated screens may render here.
 * Legacy prototype routes still exist in the tree for migration work, but are
 * never mounted as a fallback when the real API is unavailable.
 */
export default function ProductLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [gate, setGate] = useState<"checking" | "open" | "closed" | "failed">("checking");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!LIVE_ROUTES.has(pathname)) {
      setGate("closed");
      router.replace("/agent");
      return () => {
        cancelled = true;
      };
    }

    void Promise.all([
      apiFetch<MeResponse>("/v1/me"),
      apiFetch<{ connections: MailboxConnection[] }>("/v1/mailbox"),
    ])
      .then(([me, mailbox]) => {
        if (cancelled) return;
        const connected = mailbox.connections.some((connection) => connection.status === "active");
        void connected;
        if (me.user.emailVerified) setGate("open");
        else {
          setGate("closed");
          router.replace("/onboarding");
        }
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof RenewlyApiError && caught.code === "UNAUTHORIZED") {
          setGate("closed");
          router.replace("/onboarding?mode=login");
          return;
        }
        setFailure(caught instanceof Error ? caught.message : "The control plane did not answer.");
        setGate("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  if (gate === "failed") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-paper px-6 text-center text-ink-3">
        <Mark size={36} />
        <h1 className="font-serif text-display-m text-ink">The control plane did not open.</h1>
        <p className="max-w-[44ch] text-body-s">{failure}</p>
        <button
          type="button"
          className="mt-2 rounded-full border border-rule-firm px-4 py-2 text-caption text-ink-2"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </main>
    );
  }

  if (gate !== "open") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-paper text-ink-3">
        <Mark size={36} state="scanning" />
        <p className="text-caption">
          {gate === "checking" ? "Verifying your workspace…" : "Returning to onboarding…"}
        </p>
      </main>
    );
  }

  return children;
}
