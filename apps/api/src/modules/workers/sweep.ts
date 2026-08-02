import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  approvalRequests,
  subscriptions,
  workspaces,
  type ApprovalRequest,
} from "../../db/schema.js";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { findLiveApprovalForDecision } from "../approvals/service.js";
import { resolveAuthContext } from "../auth/service.js";
import { generateDecisionPackage } from "../decisions/service.js";
import { enqueueJob } from "./queues.js";

/**
 * The agent's own initiative. Finds every active subscription whose renewal is
 * inside the horizon, makes sure a decision exists, and queues the proposal —
 * so a renewal is acted on because it is due, not because an HTTP request
 * happened to ask.
 *
 * Safe to run repeatedly: `regenerate: false` reuses a live decision, a live
 * approval short-circuits, and the job dedupe key collapses whatever is left.
 * That last line is what keeps a 2-second worker tick from texting a user in a
 * loop about the same renewal.
 */
export async function sweepForProposals(
  db: Database = getDb(),
): Promise<{ scanned: number; queued: number }> {
  const horizon = new Date(Date.now() + env.RENEWAL_HORIZON_DAYS * 86_400_000);

  const due = await db
    .select({ subscription: subscriptions, workspace: workspaces })
    .from(subscriptions)
    .innerJoin(workspaces, eq(workspaces.id, subscriptions.workspaceId))
    .where(
      and(
        eq(subscriptions.status, "active"),
        isNotNull(subscriptions.nextRenewalAt),
        lte(subscriptions.nextRenewalAt, horizon),
      ),
    );

  let scanned = 0;
  let queued = 0;

  for (const { subscription, workspace } of due) {
    scanned += 1;
    // One broken subscription must not stop the sweep for everyone else.
    try {
      const auth = await resolveAuthContext(workspace.ownerUserId, workspace.id, db);

      const decision = await generateDecisionPackage({
        auth,
        subscription,
        regenerate: false,
        db,
      });

      // A snooze has nothing to approve, and createApproval would refuse it on
      // every attempt the job made.
      if (decision.recommendation === "snooze") continue;

      const live = await findLiveApprovalForDecision(workspace.id, decision.id, db);
      if (live) continue;

      /*
       * No live approval means either this decision has never been proposed, or
       * every proposal for it is finished with. "Finished" covers two very
       * different things: the user answered, or nobody ever saw it. Only the
       * second is worth repeating, and only after a decent pause.
       */
      const previous = await approvalsForDecision(workspace.id, decision.id, db);
      const last = previous[0];

      if (last && isAnswered(last.state)) continue;
      if (last && withinCooldown(last.updatedAt)) continue;

      const result = await enqueueJob(
        {
          type: "notify_decision",
          payload: { decisionId: decision.id, userId: workspace.ownerUserId },
          workspaceId: workspace.id,
          // Keyed per attempt, not per decision. A key that never changes
          // collapses the retry as well as the duplicate, which is how a
          // renewal went permanently quiet after one failed send.
          dedupeKey: `notify:${decision.id}:${previous.length}`,
        },
        db,
      );
      if (!result.deduped) queued += 1;
    } catch (error) {
      logger.warn(
        { err: error, subscriptionId: subscription.id, workspaceId: workspace.id },
        "sweep skipped a subscription",
      );
    }
  }

  if (queued > 0) {
    logger.info({ scanned, queued }, "sweep queued renewal proposals");
  }

  return { scanned, queued };
}

/** Every approval ever raised for a decision, newest first. */
async function approvalsForDecision(
  workspaceId: string,
  decisionId: string,
  db: Database,
): Promise<ApprovalRequest[]> {
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.decisionId, decisionId),
      ),
    )
    .orderBy(desc(approvalRequests.id));
}

/**
 * The user dealt with it. Re-proposing would be asking them to decide something
 * they have already decided.
 */
function isAnswered(state: ApprovalRequest["state"]): boolean {
  return state === "proved" || state === "cancelled_by_user";
}

/** True while the last attempt is too recent to repeat. */
function withinCooldown(updatedAt: Date): boolean {
  const cooldownMs = env.PROPOSAL_RETRY_COOLDOWN_MINUTES * 60_000;
  if (cooldownMs === 0) return false;
  return Date.now() - updatedAt.getTime() < cooldownMs;
}
