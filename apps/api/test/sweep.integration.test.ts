import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, subscriptions, workspaceSettings } from "../src/db/schema.js";
import { sweepForProposals } from "../src/modules/workers/sweep.js";
import { processJobs } from "../src/modules/workers/runner.js";
import {
  createDecision,
  createDecisionAndNotify,
  createSubscription,
  lastOutbound,
  signUpWithChannel,
} from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * The sweep is the agent's initiative: nothing here drives it over HTTP except
 * where the endpoint itself is under test. Every workspace lives in the same
 * database and the sweep is global, so each case asserts on its own
 * workspace's job rows rather than on global counters.
 */

let harness: TestHarness;

async function notifyJobsFor(workspaceId: string) {
  return harness.handle.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, "notify_decision")));
}

/** A workspace with a simulator channel and one subscription. */
async function workspaceWithSubscription(overrides: Record<string, unknown> = {}) {
  const client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client);
  const subscription = await createSubscription(client, overrides);
  return { client, user, subscription };
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("sweepForProposals", () => {
  it("1. queues one notify_decision job for a renewal inside the horizon", async () => {
    const { user } = await workspaceWithSubscription({ nextRenewalAt: inDays(3) });

    const result = await sweepForProposals(harness.handle.db);

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    const queued = await notifyJobsFor(user.workspaceId);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload.userId).toBe(user.userId);

    // 2. Run it again immediately: the dedupe key must hold, or the worker
    // tick would text the user about the same renewal on a loop.
    await sweepForProposals(harness.handle.db);
    expect(await notifyJobsFor(user.workspaceId)).toHaveLength(1);
  });

  it("3. ignores a renewal outside the horizon", async () => {
    const { user } = await workspaceWithSubscription({ nextRenewalAt: inDays(90) });

    await sweepForProposals(harness.handle.db);

    expect(await notifyJobsFor(user.workspaceId)).toHaveLength(0);
  });

  it("4. ignores a subscription with no renewal date, without throwing", async () => {
    const { user } = await workspaceWithSubscription({ nextRenewalAt: null });

    await expect(sweepForProposals(harness.handle.db)).resolves.toBeTruthy();

    expect(await notifyJobsFor(user.workspaceId)).toHaveLength(0);
  });

  it("5. skips a subscription whose live decision is snooze", async () => {
    // A snooze only exists for a distant renewal, so the decision is generated
    // while the date is far out, then the date moves into the horizon while
    // the decision stays live — exactly the shape the guard exists for.
    const { client, user, subscription } = await workspaceWithSubscription({
      merchantName: "Some Bespoke Vendor",
      criticality: "nice_to_have",
      nextRenewalAt: inDays(90),
    });

    const decision = await createDecision(client, subscription.id, { regenerate: true });
    expect(decision.recommendation).toBe("snooze");

    await harness.handle.db
      .update(subscriptions)
      .set({ nextRenewalAt: new Date(Date.now() + 3 * 86_400_000) })
      .where(eq(subscriptions.id, subscription.id));

    await sweepForProposals(harness.handle.db);

    expect(await notifyJobsFor(user.workspaceId)).toHaveLength(0);
  });

  it("6. skips a decision that already has a live approval", async () => {
    const { client, user, subscription } = await workspaceWithSubscription({
      nextRenewalAt: inDays(3),
    });
    const { approval } = await createDecisionAndNotify(client, subscription.id);
    expect(approval.state).toBe("awaiting_intent");

    await sweepForProposals(harness.handle.db);

    expect(await notifyJobsFor(user.workspaceId)).toHaveLength(0);
  });

  it("7. ignores a cancelled subscription inside the window", async () => {
    const { client, user, subscription } = await workspaceWithSubscription({
      nextRenewalAt: inDays(3),
    });
    const cancelled = await client.patch<{ subscription: { status: string } }>(
      `/v1/subscriptions/${subscription.id}`,
      { status: "cancelled" },
    );
    expect(cancelled.body.subscription.status).toBe("cancelled");

    await sweepForProposals(harness.handle.db);

    expect(await notifyJobsFor(user.workspaceId)).toHaveLength(0);
  });

  it("8. sweep → processJobs → drainOutbox lands a proposal on the thread", async () => {
    const { client, user } = await workspaceWithSubscription({ nextRenewalAt: inDays(3) });

    await sweepForProposals(harness.handle.db);
    await processJobs(harness.handle.db, 50);
    await harness.flushOutbox();

    const outbound = await lastOutbound(client);
    expect(outbound).not.toBeNull();
    expect(outbound!.body).toContain("Anthropic");
    expect(outbound!.payload.kind).toBe("proposal");

    const approvals = await client.get<{ approvals: Array<{ state: string }> }>("/v1/approvals");
    expect(approvals.body.approvals.some((a) => a.state === "awaiting_intent")).toBe(true);

    expect(await notifyJobsFor(user.workspaceId)).toHaveLength(1);
  });

  it("9. one broken workspace does not stop the sweep for the others", async () => {
    const broken = await workspaceWithSubscription({ nextRenewalAt: inDays(3) });
    const healthy = await workspaceWithSubscription({ nextRenewalAt: inDays(3) });

    // Deleting the settings row makes resolveAuthContext throw for this
    // workspace, which stands in for any per-subscription failure.
    await harness.handle.db
      .delete(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, broken.user.workspaceId));

    await expect(sweepForProposals(harness.handle.db)).resolves.toBeTruthy();

    expect(await notifyJobsFor(broken.user.workspaceId)).toHaveLength(0);
    expect(await notifyJobsFor(healthy.user.workspaceId)).toHaveLength(1);
  });

  it("POST /v1/agent/sweep runs one pass and reports it", async () => {
    const { client } = await workspaceWithSubscription({ nextRenewalAt: inDays(3) });

    const response = await client.post<{ scanned: number; queued: number }>("/v1/agent/sweep");

    expect(response.status).toBe(200);
    expect(response.body.scanned).toBeGreaterThanOrEqual(1);
    expect(typeof response.body.queued).toBe("number");
  });
});
