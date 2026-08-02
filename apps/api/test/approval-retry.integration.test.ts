import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { approvalRequests } from "../src/db/schema.js";
import { createApproval, transition } from "../src/modules/approvals/service.js";
import { resolveAuthContext } from "../src/modules/auth/service.js";
import { getDecision } from "../src/modules/decisions/service.js";
import { getSubscription } from "../src/modules/subscriptions/service.js";
import { createDecision, createSubscription, signUpWithChannel } from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * A proposal whose send failed has to be sendable again.
 *
 * The approval's idempotency key used to be the decision id and policy version
 * alone, which is unique for all time — so once an approval expired or its
 * outbox exhausted, every later attempt died on the unique index. The notify
 * job then failed on all five retries with a constraint violation, and the
 * renewal went quiet permanently.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

interface Fixture {
  client: ApiClient;
  workspaceId: string;
  userId: string;
  subscriptionId: string;
  decisionId: string;
}

async function fixture(): Promise<Fixture> {
  const client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client);
  const subscription = await createSubscription(client, {
    merchantName: "Anthropic",
    amount: "20.00",
    billingCycle: "monthly",
  });
  const decision = await createDecision(client, subscription.id);

  return {
    client,
    workspaceId: user.workspaceId,
    userId: user.userId,
    subscriptionId: subscription.id,
    decisionId: decision.id,
  };
}

async function makeApproval(f: Fixture) {
  const auth = await resolveAuthContext(f.userId, f.workspaceId);
  const subscription = await getSubscription(f.workspaceId, f.subscriptionId);
  const decision = await getDecision(f.workspaceId, f.decisionId);
  return createApproval({ auth, subscription, decision });
}

describe("re-proposing a decision after a terminal approval", () => {
  it("returns the existing approval while one is still live", async () => {
    const f = await fixture();

    const first = await makeApproval(f);
    const second = await makeApproval(f);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.approval.id).toBe(first.approval.id);
  });

  it("creates a fresh approval once the previous one has expired", async () => {
    const f = await fixture();
    const first = await makeApproval(f);

    await transition({ approval: first.approval, to: "expired", data: { reason: "test" } });

    // This is the regression: the unique index used to refuse this insert.
    const second = await makeApproval(f);

    expect(second.created).toBe(true);
    expect(second.approval.id).not.toBe(first.approval.id);
    expect(second.approval.state).toBe("drafted");
  });

  it("creates a fresh approval after a send failed", async () => {
    const f = await fixture();
    const first = await makeApproval(f);

    // What an exhausted outbox does to the approval it belonged to.
    await transition({
      approval: first.approval,
      to: "failed",
      patch: { failureCode: "CHANNEL_SEND_FAILED" },
      data: { reason: "outbox exhausted" },
    });

    const second = await makeApproval(f);
    expect(second.created).toBe(true);
  });

  it("survives repeated failures rather than only the first retry", async () => {
    const f = await fixture();
    const ids = new Set<string>();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { approval, created } = await makeApproval(f);
      expect(created).toBe(true);
      ids.add(approval.id);
      await transition({ approval, to: "expired", data: { attempt } });
    }

    expect(ids.size).toBe(4);
  });

  it("gives each attempt its own idempotency key", async () => {
    const f = await fixture();
    const first = await makeApproval(f);
    await transition({ approval: first.approval, to: "expired", data: { reason: "test" } });
    const second = await makeApproval(f);

    const rows = await getDb()
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.decisionId, f.decisionId));

    const keys = rows.map((row) => row.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // The decision and policy version still anchor the key; only the attempt
    // ordinal moves, so the index goes on catching concurrent double-creates.
    expect(keys.every((key) => key.startsWith(`approval:${f.decisionId}:`))).toBe(true);
    expect(second.approval.idempotencyKey.endsWith(":1")).toBe(true);
  });
});
