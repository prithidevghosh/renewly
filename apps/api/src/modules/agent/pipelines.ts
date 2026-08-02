import { and, desc, eq, inArray } from "drizzle-orm";
import {
  mailReceipts,
  subscriptions,
  workspaceSettings,
  type MailReceipt,
  type Subscription,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import { annualize, isValidAmount, normalizeAmount, sum } from "../../lib/money.js";
import { activeConnection, fetchReceipts, getConnection } from "../mailbox/service.js";
import type { MailMessage } from "../mailbox/types.js";
import { parseRenewalText, recordRenewalEvent } from "../intake/service.js";
import { canonicalizeMerchant } from "../subscriptions/service.js";
import { generateDecisionPackage } from "../decisions/service.js";
import { decisionPackageSchema } from "../decisions/engine.js";
import { classify, senderDomain } from "./classify.js";
import { lookbackFromState, lookbackLabel } from "./lookback.js";
import { PARKED, type Pipeline, type PipelineStep, type StepContext } from "./runner.js";

/**
 * What each kind of run actually does.
 *
 * A step is a unit of narration as much as a unit of work: the terminal shows
 * one headline per step and a line per thing that happened inside it, so the
 * seams are drawn where a person would want a progress update, not where the
 * code happens to be easiest to split. "Read the mailbox" and "decide which of
 * those are subscriptions" are one function call apart and two steps, because
 * they answer different questions for whoever is watching.
 *
 * Steps hand work to each other through `mail_receipts` rows rather than
 * through memory. That is what makes a run resumable across a restart, and it
 * means the evidence for every subscription the agent creates is still on disk
 * afterwards.
 */

/** Ceiling on one sweep, so a decade-old mailbox cannot stall a run. */
const MESSAGE_LIMIT = 200;
/**
 * A subscription with no charge in this window is treated as lapsed. Two
 * months rather than one: an annual plan charged on the 3rd should not look
 * dead on the 2nd of the following month.
 */
const ACTIVE_WINDOW_DAYS = 62;
/** Bodies are truncated before storage; the signal is always near the top. */
const BODY_LIMIT = 8_000;

/* -------------------------------------------------------------------------- */
/* Shared steps                                                               */
/* -------------------------------------------------------------------------- */

const checkMailbox: PipelineStep = {
  id: "mailbox",
  label: "Checking your mailbox connection",
  async run(ctx) {
    const connection = await activeConnection(ctx.auth.workspace.id, ctx.db);

    if (!connection) {
      // Failing here with a plain sentence beats letting the next step throw a
      // 401 from inside a Gmail client: the user can act on "connect Gmail".
      throw new AppError(
        "CHANNEL_NOT_CONNECTED",
        "No mailbox is connected. Connect Gmail from the dashboard, then start the run again.",
        { workspaceId: ctx.auth.workspace.id },
      );
    }

    await ctx.progress(`Reading from ${connection.provider} · ${connection.emailAddress}`);
    ctx.keep({ mailboxConnectionId: connection.id });
    ctx.summarize({ provider: connection.provider, mailbox: connection.emailAddress });
  },
};

const fetchMail: PipelineStep = {
  id: "fetch_mail",
  label: "Reading your mailbox",
  async run(ctx) {
    const connection = await getConnection(
      ctx.auth.workspace.id,
      String(ctx.state.mailboxConnectionId ?? ""),
      ctx.db,
    );

    // Read from state, not from a constant: the window is the user's choice and
    // a resumed run must use the one it started with.
    const lookbackDays = lookbackFromState(ctx.state);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - lookbackDays);
    await ctx.progress(
      `Searching ${connection.emailAddress} for receipts since ${shortDate(since)}`,
    );

    const messages = await fetchReceipts({
      connection,
      sinceDays: lookbackDays,
      limit: MESSAGE_LIMIT,
      db: ctx.db,
    });

    await ctx.progress(
      `Read ${messages.length} messages from the last ${lookbackLabel(lookbackDays)}`,
      { current: messages.length, total: messages.length },
    );

    // Persisted now, unclassified, so the next step has durable input and a
    // resumed run does not have to hit Gmail again.
    for (const message of messages) {
      await storeMessage(ctx, connection.id, message);
    }

    ctx.keep({ messageIds: messages.map((message) => message.providerMessageId) });
    ctx.summarize({
      messagesRead: messages.length,
      since: since.toISOString(),
      lookbackDays,
    });
  },
};

const classifyReceipts: PipelineStep = {
  id: "classify",
  label: "Sorting receipts from everything else",
  async run(ctx) {
    const rows = await batch(ctx);
    if (rows.length === 0) {
      await ctx.say("Nothing came back from that search, so there is nothing to sort.", "warn");
      ctx.summarize({ receipts: 0, skipped: 0 });
      return;
    }

    let receipts = 0;
    let skipped = 0;

    for (const [index, row] of rows.entries()) {
      if (index % 25 === 0 && (await ctx.cancelled())) return;

      const verdict = classify(toMessage(row));
      await ctx.db
        .update(mailReceipts)
        .set({
          parsed: { ...row.parsed, verdict: { ...verdict } },
          merchantCanonical: verdict.merchant ? canonicalizeMerchant(verdict.merchant) : null,
        })
        .where(eq(mailReceipts.id, row.id));

      if (verdict.isReceipt) {
        receipts += 1;
        await ctx.progress(
          `Receipt · ${verdict.merchant ?? senderName(row.fromAddr)} — ${title(row.subject)}`,
          { current: index + 1, total: rows.length },
        );
      } else {
        skipped += 1;
        // Skipped mail is counted rather than narrated one line at a time;
        // a hundred "not a receipt" lines would bury the ones that matter.
        if (index % 25 === 0) {
          await ctx.progress(`Checked ${index + 1} of ${rows.length}`, {
            current: index + 1,
            total: rows.length,
          });
        }
      }
    }

    await ctx.progress(`${receipts} receipts, ${skipped} messages set aside`);
    ctx.summarize({ receipts, skipped });
  },
};

const keepSaas: PipelineStep = {
  id: "filter_saas",
  label: "Keeping the active software subscriptions",
  async run(ctx) {
    const rows = (await batch(ctx)).filter((row) => verdictOf(row)?.isReceipt);
    const cutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86_400_000);

    let kept = 0;
    let oneOff = 0;
    let lapsed = 0;

    for (const row of rows) {
      const verdict = verdictOf(row);
      if (!verdict) continue;

      if (!verdict.isSaas) {
        oneOff += 1;
        await ctx.progress(`Set aside · ${senderName(row.fromAddr)} — ${verdict.reason}`);
        continue;
      }

      // "Active" is about the charge, not the mail: a receipt from five months
      // ago is evidence of a subscription that has since stopped being paid.
      if (row.receivedAt && row.receivedAt < cutoff) {
        lapsed += 1;
        await ctx.progress(
          `Lapsed · ${verdict.merchant ?? senderName(row.fromAddr)} — last charge ${shortDate(row.receivedAt)}`,
        );
        continue;
      }

      kept += 1;
      await ctx.db.update(mailReceipts).set({ isSaas: true }).where(eq(mailReceipts.id, row.id));
      await ctx.progress(
        `Subscription · ${verdict.merchant ?? senderName(row.fromAddr)} — ${verdict.reason}`,
      );
    }

    await ctx.progress(`${kept} active subscription charges to parse`);
    ctx.summarize({ activeSaas: kept, oneOff, lapsed });
  },
};

const parseReceipts: PipelineStep = {
  id: "parse",
  label: "Parsing the amounts and renewal dates",
  async run(ctx) {
    const rows = (await batch(ctx)).filter((row) => row.isSaas);

    // One charge per merchant, the newest, so a monthly receipt three times
    // over does not become three subscriptions.
    const newest = new Map<string, MailReceipt>();
    for (const row of rows) {
      const key = merchantKey(row);
      const seen = newest.get(key);
      if (!seen || (row.receivedAt?.getTime() ?? 0) > (seen.receivedAt?.getTime() ?? 0)) {
        newest.set(key, row);
      }
    }

    if (newest.size === 0) {
      await ctx.say("No active subscription charges survived the filter.", "warn");
      ctx.summarize({ parsed: 0 });
      return;
    }

    await ctx.progress(`${newest.size} merchants to parse`);
    let parsed = 0;

    for (const [index, row] of [...newest.values()].entries()) {
      if (await ctx.cancelled()) return;

      const outcome = await parseRenewalText(receiptText(row));
      const { amount, currency, billing_cycle: cycle, next_renewal_at: next } = outcome.parsed;

      await ctx.db
        .update(mailReceipts)
        .set({
          amount: amount && isValidAmount(amount) ? amount : null,
          currency: currency ?? null,
          billingCycle: cycle === "unknown" ? null : cycle,
          merchantCanonical: canonicalizeMerchant(outcome.parsed.merchant_name),
          parsed: { ...row.parsed, renewal: outcome.parsed, parser: outcome.parser },
        })
        .where(eq(mailReceipts.id, row.id));

      // The renewal event is the audited record of what was extracted and how
      // sure the parser was — the subscription row is a conclusion drawn from it.
      await recordRenewalEvent({
        auth: ctx.auth,
        rawText: receiptText(row),
        outcome,
        sourceType: "email",
        db: ctx.db,
      });

      parsed += 1;
      await ctx.progress(
        `${outcome.parsed.merchant_name} — ${money(amount, currency)} ${cycle}` +
          `${next ? `, next ${shortDate(new Date(next))}` : ""}` +
          ` (${Math.round(outcome.confidence * 100)}% sure, ${outcome.parser})`,
        { current: index + 1, total: newest.size },
      );
    }

    ctx.summarize({ merchantsParsed: parsed });
  },
};

const reconcile: PipelineStep = {
  id: "reconcile",
  label: "Reconciling with your subscription list",
  async run(ctx) {
    const rows = (await batch(ctx)).filter((row) => row.isSaas && renewalOf(row));

    let created = 0;
    let updated = 0;
    const annual: string[] = [];

    for (const row of rows) {
      const renewal = renewalOf(row);
      if (!renewal) continue;

      const canonical = canonicalizeMerchant(renewal.merchant_name);
      if (!canonical) continue;

      const amount =
        renewal.amount && isValidAmount(renewal.amount)
          ? normalizeAmount(renewal.amount, renewal.currency ?? "USD")
          : null;
      if (!amount) {
        await ctx.say(`Skipped ${renewal.merchant_name}: no amount could be read.`, "warn");
        continue;
      }

      const currency = (renewal.currency ?? ctx.auth.settings.currency).toUpperCase();
      const cycle = renewal.billing_cycle === "unknown" ? "monthly" : renewal.billing_cycle;
      const nextRenewalAt = renewal.next_renewal_at ? new Date(renewal.next_renewal_at) : null;

      const [existing] = await ctx.db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.workspaceId, ctx.auth.workspace.id),
            eq(subscriptions.merchantCanonical, canonical),
          ),
        );

      let subscriptionId: string;

      if (existing) {
        const changed = existing.amount !== amount;
        // A cancellation is a decision someone made, and a receipt that predates
        // it is not evidence against it. Only a charge dated *after* the cancel
        // reopens the subscription — that is the case where the money really is
        // still going out and the list would otherwise be wrong.
        const chargedSinceCancel =
          existing.cancelledAt !== null &&
          row.receivedAt !== null &&
          row.receivedAt > existing.cancelledAt;
        const reactivate = existing.status !== "cancelled" || chargedSinceCancel;

        if (existing.status === "cancelled" && !chargedSinceCancel) {
          await ctx.say(
            `${renewal.merchant_name} is cancelled and this receipt predates that, so I left it alone.`,
          );
        }

        await ctx.db
          .update(subscriptions)
          .set({
            amount,
            currency,
            billingCycle: cycle,
            ...(nextRenewalAt ? { nextRenewalAt } : {}),
            ...(row.receivedAt ? { lastPaidAt: row.receivedAt } : {}),
            lastSignalAt: new Date(),
            fieldConfidence: renewal.field_confidence,
            rawExcerpt: renewal.raw_excerpt,
            ...(changed && existing.amount
              ? { priceChangeNote: `Was ${money(existing.amount, existing.currency)}` }
              : {}),
            ...(reactivate ? { status: "active" as const, cancelledAt: null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.id, existing.id));

        subscriptionId = existing.id;
        updated += 1;
        await ctx.found("subscription_updated", {
          merchant: renewal.merchant_name,
          amount: money(amount, currency),
          cycle,
          ...(changed && existing.amount
            ? { priceChange: `${money(existing.amount, existing.currency)} → ${money(amount, currency)}` }
            : {}),
        });
      } else {
        subscriptionId = newId("sub");
        await ctx.db.insert(subscriptions).values({
          id: subscriptionId,
          workspaceId: ctx.auth.workspace.id,
          merchantName: renewal.merchant_name,
          merchantCanonical: canonical,
          planName: renewal.plan_name,
          amount,
          currency,
          billingCycle: cycle,
          nextRenewalAt,
          cancelByAt: renewal.cancel_by_at ? new Date(renewal.cancel_by_at) : null,
          status: "active",
          sourceType: "email",
          fieldConfidence: renewal.field_confidence,
          rawExcerpt: renewal.raw_excerpt,
          priceChangeNote: renewal.price_change_note,
          activeFrom: row.receivedAt,
          lastPaidAt: row.receivedAt,
          lastSignalAt: new Date(),
        });

        created += 1;
        await ctx.found("subscription_detected", {
          merchant: renewal.merchant_name,
          amount: money(amount, currency),
          cycle,
          annual: money(annualize(amount, cycle, currency), currency),
        });
      }

      annual.push(annualize(amount, cycle, currency));

      // Link the evidence to the conclusion, so the receipt behind a
      // subscription is still findable after the run.
      await ctx.db
        .update(mailReceipts)
        .set({ subscriptionId })
        .where(eq(mailReceipts.id, row.id));
    }

    const total = annual.length > 0 ? sum(annual, ctx.auth.settings.currency) : "0.00";
    await ctx.progress(
      `${created} new, ${updated} updated — ${money(total, ctx.auth.settings.currency)} a year`,
    );
    ctx.summarize({
      subscriptionsCreated: created,
      subscriptionsUpdated: updated,
      annualSpend: money(total, ctx.auth.settings.currency),
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Onboarding-only steps                                                      */
/* -------------------------------------------------------------------------- */

const welcome: PipelineStep = {
  id: "welcome",
  label: "Getting set up",
  async run(ctx) {
    const lookbackDays = lookbackFromState(ctx.state);
    await ctx.say(
      `Hello ${ctx.auth.user.email}. I am going to read the last ${lookbackLabel(lookbackDays)} of ` +
        "receipts, work out which are recurring software charges, and build your subscription list.",
    );
    ctx.summarize({ workspace: ctx.auth.workspace.name, lookbackDays });
  },
};

/**
 * The one place a run stops and waits for a person. It also demonstrates the
 * parking contract: `ask` returns null the first time through, the step returns
 * PARKED, and answering the question drives the same step again — this time
 * with the answer already recorded, so it falls straight through.
 */
const askBudget: PipelineStep = {
  id: "budget",
  label: "Setting your monthly software budget",
  async run(ctx) {
    if (ctx.auth.settings.aiMonthlyBudget) {
      await ctx.say(
        `Budget already set at ${money(ctx.auth.settings.aiMonthlyBudget, ctx.auth.settings.currency)} a month.`,
      );
      ctx.summarize({ budget: ctx.auth.settings.aiMonthlyBudget, asked: false });
      return;
    }

    const answer = await ctx.ask({
      key: "budget:monthly",
      question: "What should I treat as your monthly software budget?",
      options: [
        { value: "100.00", label: "$100 a month" },
        { value: "250.00", label: "$250 a month" },
        { value: "500.00", label: "$500 a month" },
      ],
      freeText: true,
      skippable: true,
    });
    if (answer === null) return PARKED;

    if (answer.trim().toLowerCase() === "skip") {
      await ctx.say("No budget set. I will still flag renewals, just not against a cap.");
      ctx.summarize({ budget: null, asked: true });
      return;
    }

    const amount = answer.replace(/[^0-9.]/g, "");
    if (!isValidAmount(amount)) {
      await ctx.say(`"${answer}" is not an amount I can use, so I am leaving the budget unset.`, "warn");
      ctx.summarize({ budget: null, asked: true });
      return;
    }

    const normalized = normalizeAmount(amount, ctx.auth.settings.currency);
    await ctx.db
      .update(workspaceSettings)
      .set({ aiMonthlyBudget: normalized, updatedAt: new Date() })
      .where(eq(workspaceSettings.workspaceId, ctx.auth.workspace.id));

    await ctx.say(`Budget set to ${money(normalized, ctx.auth.settings.currency)} a month.`);
    ctx.summarize({ budget: normalized, asked: true });
  },
};

/* -------------------------------------------------------------------------- */
/* Decision steps                                                             */
/* -------------------------------------------------------------------------- */

const decide: PipelineStep = {
  id: "decide",
  label: "Working out what to do about each renewal",
  async run(ctx) {
    const active = await ctx.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, ctx.auth.workspace.id),
          eq(subscriptions.status, "active"),
        ),
      )
      .orderBy(desc(subscriptions.nextRenewalAt));

    if (active.length === 0) {
      await ctx.say("No active subscriptions to weigh up yet.");
      ctx.summarize({ decisions: 0 });
      return;
    }

    await ctx.progress(`${active.length} subscriptions to weigh up`);
    let decided = 0;

    for (const [index, subscription] of active.entries()) {
      if (await ctx.cancelled()) return;

      try {
        const decision = await generateDecisionPackage({
          auth: ctx.auth,
          subscription,
          regenerate: false,
          db: ctx.db,
        });
        // The narrative lives in the payload; the row only carries the verdict.
        const packaged = decisionPackageSchema.parse(decision.payload);

        decided += 1;
        await ctx.found("decision", {
          merchant: subscription.merchantName,
          recommendation: decision.recommendation,
          headline: packaged.headline,
          saves: packaged.counterfactuals.recommended.savings_vs_do_nothing,
        });
        await ctx.progress(`${subscription.merchantName} — ${decision.recommendation}`, {
          current: index + 1,
          total: active.length,
        });
      } catch (error) {
        // One subscription the engine cannot judge must not lose the other
        // nineteen decisions; the failure is narrated and the run carries on.
        await ctx.say(
          `Could not decide on ${subscription.merchantName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warn",
        );
      }
    }

    ctx.summarize({ decisions: decided });
  },
};

/* -------------------------------------------------------------------------- */
/* Pipelines                                                                  */
/* -------------------------------------------------------------------------- */

const DETECT: Pipeline = [
  checkMailbox,
  fetchMail,
  classifyReceipts,
  keepSaas,
  parseReceipts,
  reconcile,
];

export const PIPELINES = {
  detect: DETECT,
  onboarding: [welcome, checkMailbox, askBudget, ...DETECT.slice(1)],
  decide: [decide],
  monthly_sweep: [...DETECT, decide],
} satisfies Record<string, Pipeline>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The rows this run is working on, oldest first. */
async function batch(ctx: StepContext): Promise<MailReceipt[]> {
  const ids = Array.isArray(ctx.state.messageIds)
    ? ctx.state.messageIds.filter((value): value is string => typeof value === "string")
    : [];
  if (ids.length === 0) return [];

  return ctx.db
    .select()
    .from(mailReceipts)
    .where(
      and(
        eq(mailReceipts.workspaceId, ctx.auth.workspace.id),
        inArray(mailReceipts.providerMessageId, ids),
      ),
    );
}

async function storeMessage(
  ctx: StepContext,
  connectionId: string,
  message: MailMessage,
): Promise<void> {
  await ctx.db
    .insert(mailReceipts)
    .values({
      id: newId("mrc"),
      workspaceId: ctx.auth.workspace.id,
      mailboxConnectionId: connectionId,
      providerMessageId: message.providerMessageId,
      subject: message.subject,
      fromAddr: message.from,
      receivedAt: message.receivedAt,
      snippet: message.snippet,
      parsed: { body: message.body.slice(0, BODY_LIMIT), sessionId: ctx.session.id },
    })
    // A re-run must refresh the message rather than collide with the unique
    // index on (workspace, provider message id).
    .onConflictDoUpdate({
      target: [mailReceipts.workspaceId, mailReceipts.providerMessageId],
      set: {
        subject: message.subject,
        fromAddr: message.from,
        receivedAt: message.receivedAt,
        snippet: message.snippet,
        parsed: { body: message.body.slice(0, BODY_LIMIT), sessionId: ctx.session.id },
      },
    });
}

interface StoredVerdict {
  isReceipt: boolean;
  isSaas: boolean;
  merchant: string | null;
  reason: string;
  confidence: number;
}

function verdictOf(row: MailReceipt): StoredVerdict | null {
  const raw = row.parsed.verdict;
  return raw && typeof raw === "object" ? (raw as StoredVerdict) : null;
}

interface StoredRenewal {
  merchant_name: string;
  plan_name: string | null;
  amount: string | null;
  currency: string | null;
  billing_cycle: "monthly" | "yearly" | "weekly" | "unknown";
  next_renewal_at: string | null;
  cancel_by_at: string | null;
  price_change_note: string | null;
  field_confidence: Record<string, number>;
  raw_excerpt: string;
}

function renewalOf(row: MailReceipt): StoredRenewal | null {
  const raw = row.parsed.renewal;
  if (!raw || typeof raw !== "object") return null;
  const renewal = raw as StoredRenewal;
  return renewal.merchant_name ? renewal : null;
}

/** Rebuilds the shape the classifier reads from a stored row. */
function toMessage(row: MailReceipt): MailMessage {
  return {
    providerMessageId: row.providerMessageId,
    subject: row.subject,
    from: row.fromAddr,
    receivedAt: row.receivedAt,
    snippet: row.snippet,
    body: typeof row.parsed.body === "string" ? row.parsed.body : "",
  };
}

/** Everything the parser should see, headers included — the sender is signal. */
function receiptText(row: MailReceipt): string {
  return [
    `From: ${row.fromAddr ?? "unknown"}`,
    `Subject: ${row.subject ?? ""}`,
    `Date: ${row.receivedAt?.toISOString() ?? ""}`,
    "",
    typeof row.parsed.body === "string" && row.parsed.body.length > 0
      ? row.parsed.body
      : (row.snippet ?? ""),
  ].join("\n");
}

function merchantKey(row: MailReceipt): string {
  return row.merchantCanonical || senderDomain(row.fromAddr) || row.providerMessageId;
}

function senderName(from: string | null): string {
  const domain = senderDomain(from);
  if (!domain) return from ?? "unknown sender";
  const root = domain.split(".").slice(-2, -1)[0] ?? domain;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

function title(subject: string | null): string {
  const value = (subject ?? "").trim();
  if (value.length === 0) return "no subject";
  return value.length > 70 ? `${value.slice(0, 67)}…` : value;
}

function money(amount: string | null, currency: string | null): string {
  if (!amount) return "an unknown amount";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
    }).format(Number(amount));
  } catch {
    return `${amount} ${currency ?? ""}`.trim();
  }
}

function shortDate(value: Date): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

/** Kept exported so a future step can reuse the active-window rule. */
export const activeWindowDays = ACTIVE_WINDOW_DAYS;

/** Narrow the pipeline map to the enum without importing it at module scope. */
export type PipelineName = keyof typeof PIPELINES;

/** Used by tests to assert a subscription row came out of a detect run. */
export type DetectedSubscription = Subscription;
