import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalRequests, jobs } from "../src/db/schema.js";
import { createApproval, transition } from "../src/modules/approvals/service.js";
import { resolveAuthContext } from "../src/modules/auth/service.js";
import { getDecision } from "../src/modules/decisions/service.js";
import { getSubscription } from "../src/modules/subscriptions/service.js";
import { sweepForProposals } from "../src/modules/workers/sweep.js";
import { createDecision, createSubscription, signUpWithChannel } from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * When the sweep is allowed to propose a renewal a second time.
 *
 * The key used to be the decision id alone, so a decision was proposable
 * exactly once for all time. A proposal lost to a channel outage was lost
 * permanently, and the renewal went quiet with nothing in the logs to say why.
 * The opposite failure is just as bad: without a floor the sweep would put the
 * same proposal in front of someone every five minutes.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

interface Fixture {
  workspaceId: string;
  userId: string;
  decisionId: string;
  subscriptionId: string;
}

async function fixture(): Promise<Fixture> {
  const client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client);
  const subscription = await createSubscription(client, {
    merchantName: "Coda",
    amount: "47.00",
    billingCycle: "monthly",
    nextRenewalAt: inDays(3),
  });
  const decision = await createDecision(client, subscription.id);
  return {
    workspaceId: user.workspaceId,
    userId: user.userId,
    decisionId: decision.id,
    subscriptionId: subscription.id,
  };
}

async function raiseApproval(f: Fixture) {
  const auth = await resolveAuthContext(f.userId, f.workspaceId);
  const subscription = await getSubscription(f.workspaceId, f.subscriptionId);
  const decision = await getDecision(f.workspaceId, f.decisionId);
  const { approval } = await createApproval({ auth, subscription, decision });
  return approval;
}

async function notifyJobs(workspaceId: string) {
  return harness.handle.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, "notify_decision")));
}

/** Backdates the last attempt so the cooldown has demonstrably elapsed. */
async function age(approvalId: string, minutes: number) {
  await harness.handle.db
    .update(approvalRequests)
    .set({ updatedAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(approvalRequests.id, approvalId));
}

describe("re-proposing a renewal", () => {
  it("proposes a decision nobody has seen", async () => {
    const f = await fixture();
    await sweepForProposals();
    expect(await notifyJobs(f.workspaceId)).toHaveLength(1);
  });

  it("does not propose again while an approval is still live", async () => {
    const f = await fixture();
    await raiseApproval(f);

    await sweepForProposals();
    expect(await notifyJobs(f.workspaceId)).toHaveLength(0);
  });

  it("does not repeat a proposal the user answered", async () => {
    const f = await fixture();
    const approval = await raiseApproval(f);
    await transition({ approval, to: "cancelled_by_user", data: { intent: "KEEP" } });
    await age(approval.id, 60 * 24);

    await sweepForProposals();

    // They said no. Asking again a day later is nagging, not diligence.
    expect(await notifyJobs(f.workspaceId)).toHaveLength(0);
  });

  it("holds off while the last attempt is inside the cooldown", async () => {
    const f = await fixture();
    const approval = await raiseApproval(f);
    await transition({ approval, to: "expired", data: { reason: "ttl" } });

    await sweepForProposals();

    expect(await notifyJobs(f.workspaceId)).toHaveLength(0);
  });

  it("proposes again once the cooldown has passed", async () => {
    const f = await fixture();
    const approval = await raiseApproval(f);
    await transition({ approval, to: "expired", data: { reason: "ttl" } });
    await age(approval.id, 120);

    await sweepForProposals();

    expect(await notifyJobs(f.workspaceId)).toHaveLength(1);
  });

  it("retries a proposal whose send failed", async () => {
    const f = await fixture();
    const approval = await raiseApproval(f);
    await transition({
      approval,
      to: "failed",
      patch: { failureCode: "CHANNEL_SEND_FAILED" },
      data: { reason: "outbox exhausted" },
    });
    await age(approval.id, 120);

    await sweepForProposals();

    // The exact case that went permanently silent before.
    expect(await notifyJobs(f.workspaceId)).toHaveLength(1);
  });

  it("gives each attempt its own dedupe key", async () => {
    const f = await fixture();
    const first = await raiseApproval(f);
    await transition({ approval: first, to: "expired", data: { reason: "ttl" } });
    await age(first.id, 120);

    await sweepForProposals();
    const second = await raiseApproval(f);
    await transition({ approval: second, to: "expired", data: { reason: "ttl" } });
    await age(second.id, 120);
    await sweepForProposals();

    const keys = (await notifyJobs(f.workspaceId)).map((job) => job.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("still collapses two sweeps in the same window into one job", async () => {
    const f = await fixture();

    await sweepForProposals();
    await sweepForProposals();

    expect(await notifyJobs(f.workspaceId)).toHaveLength(1);
  });
});
