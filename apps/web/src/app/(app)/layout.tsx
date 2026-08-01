"use client";

import { AppShell } from "@/components/app/AppShell";
import { PasskeySheet } from "@/components/agent/PasskeySheet";
import { RenewlyProvider, useRenewly } from "@/lib/store/RenewlyStore";

/**
 * Product shell. Mounts the store once so an approval made in the agent chat is
 * instantly reflected in the inventory, the opportunity list and the ledger.
 *
 * The passkey sheet lives here — a single instance for the whole app, driven by
 * `pendingApproval` in the store, so any screen can raise it identically.
 */
function AppFrame({ children }: { children: React.ReactNode }) {
  const { pendingApproval, closeApproval, runAction, user } = useRenewly();

  return (
    <>
      <AppShell>{children}</AppShell>
      <PasskeySheet
        opportunity={pendingApproval}
        user={user}
        open={pendingApproval !== null}
        onOpenChange={(open) => !open && closeApproval()}
        onApproved={(id) => {
          void runAction(id);
        }}
      />
    </>
  );
}

export default function ProductLayout({ children }: { children: React.ReactNode }) {
  return (
    <RenewlyProvider>
      <AppFrame>{children}</AppFrame>
    </RenewlyProvider>
  );
}
