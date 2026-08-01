import { eq } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { decisionPackages, subscriptions, type Job } from "../../../db/schema.js";
import { resolveAuthContext } from "../../auth/service.js";
import { createApproval } from "../../approvals/service.js";
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
