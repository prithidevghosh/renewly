"use client";

/**
 * Screen I — Settings.
 *
 * The whole screen exists to reinforce one thing: the human is in control. The
 * guardrails are stated as sentences the agent must obey, not as abstract
 * toggles, and the revoke control is always reachable.
 */

import { useEffect, useState } from "react";
import * as Switch from "@radix-ui/react-switch";
import {
  CreditCard,
  Fingerprint,
  Inbox,
  Landmark,
  Mail,
  Plus,
  ShieldAlert,
  X,
} from "lucide-react";
import { PageFrame, PageHeader } from "@/components/app/AppShell";
import { Card, Tag, type TagTone, Marker, Rule } from "@/components/ui/Primitives";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { useRenewly } from "@/lib/store/RenewlyStore";
import type { Source, SourceKind } from "@/lib/domain/types";
import { cx, longDate, money } from "@/lib/format";

const SOURCE_ICON: Record<SourceKind, typeof Mail> = {
  email_alias: Inbox,
  gmail: Mail,
  card: CreditCard,
  statement: Landmark,
};

const SOURCE_TONE: Record<Source["status"], TagTone> = {
  connected: "forest",
  connecting: "claret",
  syncing: "claret",
  disconnected: "neutral",
  error: "claret",
};

/* -------------------------------------------------------------------------- */

function Section({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-5 py-8 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-10">
      <div>
        <h2 className="text-title-m font-semibold tracking-[-0.015em]">{title}</h2>
        {lede && <p className="mt-1.5 text-body-s text-ink-3">{lede}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
  id: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-body font-medium text-ink">
          {label}
        </label>
        <p className="mt-0.5 text-body-s text-ink-3">{description}</p>
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className={cx(
          "relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-[var(--dur-quick)]",
          checked ? "border-forest/50 bg-forest/25" : "border-rule-firm bg-sunk",
        )}
      >
        <Switch.Thumb
          className={cx(
            "block size-4 translate-x-1 rounded-full transition-transform duration-[var(--dur-quick)]",
            "ease-[var(--ease-settle)] will-change-transform",
            checked ? "translate-x-6 bg-forest" : "bg-ink-400",
          )}
        />
      </Switch.Root>
    </div>
  );
}

function CapSlider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  return (
    <div className="py-3.5">
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={`cap-${label}`} className="text-body font-medium text-ink">
          {label}
        </label>
        <Money value={local} cents={false} className="text-title-s" />
      </div>
      <input
        id={`cap-${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={() => onCommit(local)}
        onTouchEnd={() => onCommit(local)}
        onKeyUp={() => onCommit(local)}
        className="mt-3 w-full"
      />
      <p className="mt-1.5 text-body-s text-ink-3">{hint}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export default function SettingsPage() {
  const { user, sources, connect, saveGuardrails, revokeAll, ready } = useRenewly();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [vendorInput, setVendorInput] = useState("");

  if (!ready || !user) {
    return (
      <PageFrame>
        <PageHeader title="Settings" />
      </PageFrame>
    );
  }

  const g = user.guardrails;

  return (
    <PageFrame>
      <PageHeader
        title="Settings"
        lede="What the agent can see, what it may do, and how to stop it."
      />

      <div className="divide-y divide-[var(--rule)]">
        {/* Sources */}
        <Section
          title="Connected sources"
          lede="Where the agent looks for recurring charges. It reads receipts and statements — nothing else."
        >
          <Card className="divide-y divide-[var(--rule)]">
            {sources.map((s) => {
              const Icon = SOURCE_ICON[s.kind];
              const busy = connecting === s.id || s.status === "connecting" || s.status === "syncing";
              return (
                <div key={s.id} className="flex flex-wrap items-center gap-4 p-4">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md border border-rule-firm bg-sunk">
                    <Icon className="size-4 text-ink-3" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-ink">{s.label}</span>
                      <Tag tone={SOURCE_TONE[s.status]} >
                        {busy ? "syncing" : s.status}
                      </Tag>
                    </div>
                    <p className="truncate figure text-caption text-ink-4">{s.detail}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {s.status === "connected" && (
                      <span className="hidden label sm:inline">
                        {s.discoveredCount} found
                      </span>
                    )}
                    {s.status === "disconnected" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={async () => {
                          setConnecting(s.id);
                          await connect(s.id);
                          setConnecting(null);
                        }}
                      >
                        {busy ? "Connecting…" : "Connect"}
                      </Button>
                    ) : (
                      <span className="label">
                        {s.lastSyncAt ? "synced 06:12" : "—"}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>
        </Section>

        {/* Passkey */}
        <Section
          title="Approval device"
          lede="Money-moving actions require a passkey from a device you registered. There is no password fallback."
        >
          <Card className="p-5">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-forest/30 bg-[var(--forest-soft)]">
                <Fingerprint className="size-5 text-forest" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-body font-medium text-ink">{user.passkey.deviceLabel}</p>
                  <Tag tone={user.passkey.enrolled ? "forest" : "claret"}>
                    {user.passkey.enrolled ? "Active" : "Revoked"}
                  </Tag>
                </div>
                <p className="mt-1 text-body-s text-ink-3">
                  {user.passkey.enrolledAt
                    ? `Registered ${longDate(user.passkey.enrolledAt)}`
                    : "Not registered"}
                </p>
              </div>
            </div>

            <Rule className="my-4" />

            <div className="flex flex-wrap gap-2.5">
              <Button size="sm" variant="secondary">
                <Plus className="size-3.5" />
                Add a device
              </Button>
              <Button size="sm" variant="quiet">
                View sign-in history
              </Button>
            </div>
            <p className="mt-3 label">
              Simulated · no WebAuthn credential is created
            </p>
          </Card>
        </Section>

        {/* Guardrails */}
        <Section
          title="Guardrails"
          lede="Hard limits the agent cannot talk its way around. Checked before every action, and again server-side in production."
        >
          <Card className="divide-y divide-[var(--rule)] px-5">
            <CapSlider
              label="Per-action cap"
              hint={`The agent will not move more than ${money(g.perActionCapCents, { cents: false })} in a single action, even with your approval.`}
              value={g.perActionCapCents}
              min={5_000}
              max={200_000}
              step={5_000}
              onCommit={(v) => void saveGuardrails({ perActionCapCents: v })}
            />
            <CapSlider
              label="Rolling 30-day cap"
              hint="Total the agent may move across all actions in any 30-day window."
              value={g.monthlyCapCents}
              min={50_000}
              max={1_000_000}
              step={25_000}
              onCommit={(v) => void saveGuardrails({ monthlyCapCents: v })}
            />
            <Toggle
              id="approval-always"
              checked={g.approvalAlways}
              onChange={(v) => void saveGuardrails({ approvalAlways: v })}
              label="Always ask me"
              description="Require a passkey for every action, including ones that move no money."
            />
            <Toggle
              id="allow-cancel"
              checked={g.allowCancellation}
              onChange={(v) => void saveGuardrails({ allowCancellation: v })}
              label="Allow cancellations"
              description="Let the agent cancel subscriptions outright, not just downgrade them."
            />
          </Card>

          {/* Vendor lists */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Card className="p-4">
              <Marker>Allow list</Marker>
              <p className="mt-2 text-body-s text-ink-3">
                Acted on without extra prompting, still within caps.
              </p>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {g.allowVendors.map((v) => (
                  <li key={v}>
                    <Tag tone="forest">{v}</Tag>
                  </li>
                ))}
              </ul>
            </Card>

            <Card className="p-4">
              <Marker >Deny list</Marker>
              <p className="mt-2 text-body-s text-ink-3">Never touched, under any circumstances.</p>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {g.denyVendors.map((v) => (
                  <li key={v}>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-claret/30 bg-[var(--claret-soft)] px-2 py-[3px] label text-claret">
                      {v}
                      <button
                        type="button"
                        aria-label={`Remove ${v} from deny list`}
                        onClick={() =>
                          void saveGuardrails({
                            denyVendors: g.denyVendors.filter((d) => d !== v),
                          })
                        }
                        className="rounded-full transition-opacity hover:opacity-60"
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = vendorInput.trim();
                  if (!v) return;
                  void saveGuardrails({ denyVendors: [...g.denyVendors, v] });
                  setVendorInput("");
                }}
              >
                <label htmlFor="deny-vendor" className="sr-only">
                  Add vendor to deny list
                </label>
                <input
                  id="deny-vendor"
                  value={vendorInput}
                  onChange={(e) => setVendorInput(e.target.value)}
                  placeholder="Add a vendor"
                  className="h-8 min-w-0 flex-1 rounded-md border border-rule bg-sunk px-2.5 text-body-s outline-none transition-colors placeholder:text-ink-4 focus:border-rule-ink"
                />
                <Button type="submit" size="sm" variant="secondary">
                  Add
                </Button>
              </form>
            </Card>
          </div>
        </Section>

        {/* Revoke */}
        <Section
          title="Revoke access"
          lede="Disconnects every source and retires the passkey. The ledger is preserved — history is never deleted."
        >
          <Card className="border-claret/25 p-5">
            <div className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-claret" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-ink">Stop the agent completely</p>
                <p className="mt-1 max-w-[54ch] text-body-s text-ink-3">
                  Renewly stops reading your inbox and card feed immediately and cannot propose or
                  execute anything. You can reconnect at any time.
                </p>

                <div className="mt-4 flex flex-wrap gap-2.5">
                  {!confirmRevoke ? (
                    <Button variant="danger" size="sm" onClick={() => setConfirmRevoke(true)}>
                      Revoke agent access
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={async () => {
                          await revokeAll();
                          setConfirmRevoke(false);
                        }}
                      >
                        Yes — revoke everything
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => setConfirmRevoke(false)}>
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </Card>
        </Section>
      </div>
    </PageFrame>
  );
}
