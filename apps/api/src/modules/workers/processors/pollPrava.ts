import { eq } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { approvalRequests, type Job } from "../../../db/schema.js";
import { AppError } from "../../../lib/errors.js";
import { logger } from "../../../lib/logger.js";
import { resolveAuthContext } from "../../auth/service.js";
import { executeApproval } from "../../payments/executor.js";

/**
 * Completes a payment the user authorised but never came back from. The pay
 * page normally calls complete itself; this is the safety net for a closed tab,
 * and it is idempotent with that call because both go through `executeApproval`.
 */
export async function pollPravaJob(job: Job, db: Database): Promise<void> {
  const approvalId = job.payload.approvalId;
  if (typeof approvalId !== "string") {
    throw new Error("poll_prava job has no approvalId");
  }

  const [approval] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId));
  if (!approval) return;

  // Only an approval still waiting on the rail is worth polling.
  if (approval.state !== "awaiting_payment_auth") return;
  if (approval.expiresAt.getTime() <= Date.now()) return;

  const [ownerId] = [job.payload.userId];
  if (typeof ownerId !== "string") throw new Error("poll_prava job has no userId");

  const auth = await resolveAuthContext(ownerId, approval.workspaceId, db);

  try {
    await executeApproval({ auth, approvalId, db });
  } catch (error) {
    // A card that has not been entered yet is the expected case, not a failure.
    if (error instanceof AppError && error.code === "PRAVA_ERROR") {
      logger.debug({ approvalId }, "prava credentials not ready yet");
      return;
    }
    throw error;
  }
}
