import { eq } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { inboundEmails, workspaces, type Job } from "../../../db/schema.js";
import { resolveAuthContext } from "../../auth/service.js";
import { ingestInboundEmail } from "../../intake/mail/service.js";

/**
 * Re-parses an inbound email that was stored but not yet processed. The webhook
 * parses inline for a fast round trip; this exists so a parser failure can be
 * retried without the provider having to redeliver.
 */
export async function parseInboundEmailJob(job: Job, db: Database): Promise<void> {
  const inboundEmailId = job.payload.inboundEmailId;
  if (typeof inboundEmailId !== "string") {
    throw new Error("parse_inbound_email job has no inboundEmailId");
  }

  const [email] = await db
    .select()
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundEmailId));
  if (!email || email.parseStatus === "parsed" || email.parseStatus === "duplicate") return;
  if (!email.workspaceId) return;

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, email.workspaceId));
  if (!workspace) return;

  const auth = await resolveAuthContext(workspace.ownerUserId, workspace.id, db);

  try {
    await ingestInboundEmail({
      auth,
      email: {
        messageId: email.messageId,
        from: email.fromAddr,
        to: email.toAddr,
        subject: email.subject,
        text: email.rawText,
        provider: email.provider,
      },
      db,
    });
  } catch (error) {
    await db
      .update(inboundEmails)
      .set({
        parseStatus: "failed",
        parseError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(inboundEmails.id, email.id));
    throw error;
  }
}
