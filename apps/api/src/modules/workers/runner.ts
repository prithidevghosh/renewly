import { and, asc, eq, lte, lt, ne } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  approvalRequests,
  outboxMessages,
  type Job,
  type OutboxMessage,
} from "../../db/schema.js";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../audit/service.js";
import { transition } from "../approvals/service.js";
import { deliverOutbound } from "../conversations/runtime.js";
import { isExpirable } from "../conversations/stateMachine.js";
import { claimNextJob, completeJob, failJob } from "./queues.js";
import { sweepForProposals } from "./sweep.js";

/**
 * The worker loop. Four responsibilities: sweep for renewals worth proposing,
 * drain the outbox, retire approvals whose window has closed, and run queued
 * jobs. All four are safe to run repeatedly, which is the only property that
 * matters for at-least-once delivery.
 */

export interface TickResult {
  outboxSent: number;
  outboxFailed: number;
  approvalsExpired: number;
  jobsProcessed: number;
  proposalsQueued: number;
}

/**
 * The sweep runs the decision engine per subscription, so it paces itself on
 * SWEEP_INTERVAL_MS rather than riding every 2-second tick.
 */
let lastSweepAt = 0;

export async function runTick(db: Database = getDb()): Promise<TickResult> {
  let proposalsQueued = 0;
  if (Date.now() - lastSweepAt >= env.SWEEP_INTERVAL_MS) {
    lastSweepAt = Date.now();
    const sweep = await sweepForProposals(db);
    proposalsQueued = sweep.queued;
  }

  const [outbox, expired, jobsRun] = [
    await drainOutbox(db),
    await expireApprovals(db),
    await processJobs(db),
  ];

  return {
    outboxSent: outbox.sent,
    outboxFailed: outbox.failed,
    approvalsExpired: expired,
    jobsProcessed: jobsRun,
    proposalsQueued,
  };
}

/* -------------------------------------------------------------------------- */
/* Outbox                                                                     */
/* -------------------------------------------------------------------------- */

export async function drainOutbox(
  db: Database = getDb(),
  limit = 25,
): Promise<{ sent: number; failed: number }> {
  const now = new Date();
  const due = await db
    .select()
    .from(outboxMessages)
    .where(and(eq(outboxMessages.status, "pending"), lte(outboxMessages.nextAttemptAt, now)))
    .orderBy(asc(outboxMessages.id))
    .limit(limit);

  let sent = 0;
  let failed = 0;

  for (const message of due) {
    // Claim first, so a second worker cannot send the same message. The status
    // stays `pending` for the duration of the send, so `status = 'pending'`
    // alone does not make this exclusive — two overlapping drains would both
    // match and both deliver. Comparing `attempts` as well turns it into a
    // compare-and-set: both readers saw the same count, only one write lands,
    // and the loser skips.
    const [claimed] = await db
      .update(outboxMessages)
      .set({ attempts: message.attempts + 1, updatedAt: new Date() })
      .where(
        and(
          eq(outboxMessages.id, message.id),
          eq(outboxMessages.status, "pending"),
          eq(outboxMessages.attempts, message.attempts),
        ),
      )
      .returning();
    if (!claimed) continue;

    try {
      await deliverOutbound(
        {
          id: claimed.id,
          workspaceId: claimed.workspaceId,
          threadId: claimed.threadId,
          channel: claimed.channel,
          destination: claimed.destination,
          body: claimed.body,
          payload: claimed.payload,
        },
        db,
      );

      await db
        .update(outboxMessages)
        .set({ status: "sent", lastError: null, updatedAt: new Date() })
        .where(eq(outboxMessages.id, claimed.id));
      sent += 1;
    } catch (error) {
      failed += 1;
      await handleOutboxFailure(claimed, error, db);
    }
  }

  return { sent, failed };
}

async function handleOutboxFailure(
  message: OutboxMessage,
  error: unknown,
  db: Database,
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  const exhausted = message.attempts >= 5;

  await db
    .update(outboxMessages)
    .set({
      status: exhausted ? "failed" : "pending",
      lastError: reason.slice(0, 1000),
      nextAttemptAt: new Date(Date.now() + Math.min(60_000, 2 ** message.attempts * 500)),
      updatedAt: new Date(),
    })
    .where(eq(outboxMessages.id, message.id));

  await recordAudit(
    {
      workspaceId: message.workspaceId,
      type: "message.send_failed",
      entityType: "outbox_message",
      entityId: message.id,
      data: { reason, attempts: message.attempts, exhausted },
    },
    db,
  );

  // A proposal that can never be delivered must not leave the approval waiting
  // on a reply that will never come.
  if (exhausted && message.approvalRequestId) {
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, message.approvalRequestId));
    if (approval && isExpirable(approval.state)) {
      await transition({
        approval,
        to: "failed",
        patch: { failureCode: "CHANNEL_SEND_FAILED" },
        data: { reason: "outbox exhausted" },
        db,
      }).catch(() => undefined);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Expiry                                                                     */
/* -------------------------------------------------------------------------- */

export async function expireApprovals(db: Database = getDb()): Promise<number> {
  const now = new Date();

  const stale = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        lt(approvalRequests.expiresAt, now),
        // Executing is deliberately excluded: money may already be in flight.
        ne(approvalRequests.state, "executing"),
        ne(approvalRequests.state, "proved"),
        ne(approvalRequests.state, "failed"),
        ne(approvalRequests.state, "expired"),
        ne(approvalRequests.state, "cancelled_by_user"),
      ),
    )
    .limit(50);

  let expired = 0;
  for (const approval of stale) {
    if (!isExpirable(approval.state)) continue;
    try {
      await transition({
        approval,
        to: "expired",
        data: { reason: "ttl", expiresAt: approval.expiresAt.toISOString() },
        db,
      });
      expired += 1;
    } catch {
      // Lost a race with a user reply; the other path already moved it.
    }
  }

  return expired;
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

export async function processJobs(db: Database = getDb(), limit = 10): Promise<number> {
  let processed = 0;

  for (let i = 0; i < limit; i += 1) {
    const job = await claimNextJob(new Date(), db);
    if (!job) break;

    try {
      await runJob(job, db);
      await completeJob(job.id, db);
      processed += 1;
    } catch (error) {
      await failJob(job, error, db);
      await recordAudit(
        {
          workspaceId: job.workspaceId ?? "",
          type: "job.failed",
          entityType: "job",
          entityId: job.id,
          data: {
            type: job.type,
            attempts: job.attempts,
            reason: error instanceof Error ? error.message : String(error),
          },
        },
        db,
      ).catch(() => undefined);
    }
  }

  return processed;
}

async function runJob(job: Job, db: Database): Promise<void> {
  switch (job.type) {
    case "send_outbound":
      await drainOutbox(db);
      return;

    case "expire_approvals":
      await expireApprovals(db);
      return;

    case "poll_prava": {
      const { pollPravaJob } = await import("./processors/pollPrava.js");
      await pollPravaJob(job, db);
      return;
    }

    case "notify_decision": {
      const { notifyDecisionJob } = await import("./processors/notifyDecision.js");
      await notifyDecisionJob(job, db);
      return;
    }

    case "parse_inbound_email": {
      const { parseInboundEmailJob } = await import("./processors/parseEmail.js");
      await parseInboundEmailJob(job, db);
      return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Loop                                                                       */
/* -------------------------------------------------------------------------- */

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startWorker(db: Database = getDb()): void {
  if (!env.WORKER_ENABLED || timer) return;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runTick(db);
      if (
        result.outboxSent + result.jobsProcessed + result.approvalsExpired + result.proposalsQueued >
        0
      ) {
        logger.debug(result, "worker tick");
      }
    } catch (error) {
      logger.error({ err: error }, "worker tick failed");
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), env.WORKER_POLL_INTERVAL_MS);
  // Do not hold the process open purely for the worker.
  timer.unref?.();
  logger.info({ intervalMs: env.WORKER_POLL_INTERVAL_MS }, "worker started");
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
