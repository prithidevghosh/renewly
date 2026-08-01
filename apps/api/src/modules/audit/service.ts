import { and, desc, eq, lt } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { auditEvents, type AuditEvent } from "../../db/schema.js";
import { newId } from "../../lib/id.js";
import { toPage, type Page } from "../../lib/http.js";

/**
 * Canonical audit event types. Every mutating action writes one; the happy path
 * for a renewal produces the chain renewal.parsed -> subscription.confirmed ->
 * decision.generated -> payment.session_created -> payment.succeeded.
 */
export const AUDIT_TYPES = [
  "auth.signup",
  "auth.login",
  "auth.logout",
  "settings.updated",
  "kill_switch.enabled",
  "kill_switch.disabled",
  "subscription.created",
  "subscription.updated",
  "subscription.deleted",
  "subscription.confirmed",
  "subscription.cancelled",
  "renewal.parsed",
  "csv.imported",
  "csv.candidate_accepted",
  "csv.candidate_rejected",
  "decision.generated",
  "payment.session_created",
  "payment.blocked",
  "payment.credentials_received",
  "payment.succeeded",
  "payment.failed",
  "cancel.started",
  "cancel.confirmed",
  "savings.recorded",
  "channel.connected",
  "channel.revoked",
  "message.inbound",
  "message.outbound",
  "message.send_failed",
  "intent.parsed",
  "approval.created",
  "approval.notified",
  "approval.awaiting_intent",
  "approval.awaiting_payment_auth",
  "approval.executing",
  "approval.proved",
  "approval.failed",
  "approval.expired",
  "approval.cancelled_by_user",
  "mail.received",
  "mail.duplicate",
  "merchant.resolved",
  "job.failed",
] as const;

export type AuditType = (typeof AUDIT_TYPES)[number];

export interface AuditInput {
  workspaceId: string;
  actorUserId?: string | null;
  type: AuditType;
  entityType?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput, db: Database = getDb()): Promise<AuditEvent> {
  const [row] = await db
    .insert(auditEvents)
    .values({
      id: newId("evt"),
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId ?? null,
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      data: input.data ?? {},
    })
    .returning();
  if (!row) throw new Error("audit insert returned no row");
  return row;
}

export async function listAudit(
  workspaceId: string,
  options: { type?: string; limit: number; cursor?: string },
  db: Database = getDb(),
): Promise<Page<AuditEvent>> {
  const filters = [eq(auditEvents.workspaceId, workspaceId)];
  if (options.type) filters.push(eq(auditEvents.type, options.type));
  if (options.cursor) filters.push(lt(auditEvents.id, options.cursor));

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...filters))
    .orderBy(desc(auditEvents.id))
    .limit(options.limit + 1);

  return toPage(rows, options.limit);
}
