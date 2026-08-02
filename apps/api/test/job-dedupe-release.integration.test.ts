import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs } from "../src/db/schema.js";
import { enqueueJob, failJob } from "../src/modules/workers/queues.js";
import { createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * A job that died must not keep its claim on the work.
 *
 * `enqueueJob` collapses against `dedupeKey` in any status, so a failed job
 * went on owning its key and every later enqueue of the same work was deduped
 * into a corpse. It was not theoretical: the sweep keys on the number of
 * approvals for a decision, and the approval is created by the very job that
 * failed — so the count stayed at zero, the key was recomputed identically
 * forever, and two renewals were never proposed again until the rows were
 * deleted by hand.
 *
 * The row itself is kept. It is the record of what went wrong; only its hold
 * over future work is released.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

const KEY = "notify:dec_permanently_stuck:0";

describe("a terminal job releases its dedupe key", () => {
  it("lets the same work be queued again once the job has given up", async () => {
    const db = harness.handle.db;

    const first = await enqueueJob({ type: "notify_decision", dedupeKey: KEY, maxAttempts: 1 }, db);
    expect(first.deduped).toBe(false);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, first.id));
    if (!row) throw new Error("enqueued job vanished");

    // While it is still retryable the key is held: a second enqueue must not
    // put a duplicate of live work on the queue.
    const whileAlive = await enqueueJob({ type: "notify_decision", dedupeKey: KEY }, db);
    expect(whileAlive.deduped).toBe(true);
    expect(whileAlive.id).toBe(first.id);

    await failJob({ ...row, attempts: row.maxAttempts }, new Error("channel was unreachable"), db);

    const [dead] = await db.select().from(jobs).where(eq(jobs.id, first.id));
    expect(dead?.status).toBe("failed");
    // The record survives, with the reason still on it.
    expect(dead?.lastError).toContain("channel was unreachable");
    expect(dead?.dedupeKey).toBeNull();

    const retry = await enqueueJob({ type: "notify_decision", dedupeKey: KEY }, db);
    expect(retry.deduped).toBe(false);
    expect(retry.id).not.toBe(first.id);
  });
});
