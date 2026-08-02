import { eq } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { decisionPackages, subscriptions, type Job } from "../../../db/schema.js";
import { logger } from "../../../lib/logger.js";
import { resolveAuthContext } from "../../auth/service.js";
import { createApproval } from "../../approvals/service.js";
import { hasActiveConnection } from "../../conversations/service.js";
import { notifyApproval } from "../../conversations/runtime.js";

/**
 * Turns a decision into a proposal in the user's thread. Split out as a job so
 * the endpoint that generates a decision returns immediately rather than
 * blocking on a messaging provider.
 */
export async function notifyDecisionJob(job: Job, db: Database): Promise<void> {
  const decisionId = job.payload.decisionId;
  const userId = job.payload.userId;
  if (typeof decisionId !== "string" || typeof userId !== "string") {
    throw new Error("notify_decision job needs decisionId and userId");
  }

  const [decision] = await db
    .select()
    .from(decisionPackages)
    .where(eq(decisionPackages.id, decisionId));
  if (!decision || decision.supersededAt) return;

  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, decision.subscriptionId));
  if (!subscription) return;

  const auth = await resolveAuthContext(userId, decision.workspaceId, db);

  /*
   * Checked before the approval exists, not after: a missing channel is not a
   * transient fault, so retrying cannot fix it, and failing here five times
   * would leave a drafted approval waiting on a message that can never be
   * sent. The sweep makes the same check before queueing; this one covers the
   * race where the connection was revoked in between.
   */
  if (!(await hasActiveConnection(decision.workspaceId, auth.settings.primaryChannel, db))) {
    logger.warn(
      { decisionId, workspaceId: decision.workspaceId, channel: auth.settings.primaryChannel },
      "notify_decision dropped — no active channel connection for this workspace",
    );
    return;
  }

  const { approval, created } = await createApproval({
    auth,
    subscription,
    decision,
    db,
  });

  // An approval that already exists has already been notified.
  if (!created && approval.state !== "drafted") return;

  await notifyApproval({ auth, approval, subscription, decision, db });
}
