import { Hono } from "hono";
import { env } from "../../../env.js";
import { AppError } from "../../../lib/errors.js";
import { logger } from "../../../lib/logger.js";
import { requireAuth } from "../../../middleware/auth.js";
import type { AppEnv } from "../../../types/context.js";
import { resolveAuthContext } from "../../auth/service.js";
import { findWorkspaceForUser } from "../../workspaces/service.js";
import { getDb } from "../../../db/client.js";
import { workspaces } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  extractRoutingToken,
  inboundAddressFor,
  ingestInboundEmail,
  normalizeInboundEmail,
  resolveWorkspaceByToken,
} from "./service.js";
import { parseMailPayload, verifyMailWebhook } from "./verify.js";

export const mailWebhookRoutes = new Hono<AppEnv>();

/**
 * Inbound mail from any provider. The workspace is resolved from the
 * plus-address token on the recipient, never from the sender — the From header
 * is attacker-controlled and routing on it would let anyone write into any
 * workspace.
 */
mailWebhookRoutes.post("/:provider", async (c) => {
  const provider = c.req.param("provider");
  const rawBody = await c.req.text();

  // Mailgun signs fields inside the payload, so the body is parsed first and
  // the raw text is kept for the providers that sign it.
  const payload = parseMailPayload(rawBody, c.req.header("content-type"), provider);

  if (env.MAIL_MODE === "live") {
    if (!env.MAIL_WEBHOOK_SECRET) {
      throw new AppError("WEBHOOK_INVALID_SIGNATURE", "MAIL_WEBHOOK_SECRET is not configured");
    }
    verifyMailWebhook({
      provider,
      rawBody,
      payload,
      headers: {
        "svix-id": c.req.header("svix-id"),
        "svix-timestamp": c.req.header("svix-timestamp"),
        "svix-signature": c.req.header("svix-signature"),
        "webhook-id": c.req.header("webhook-id"),
        "webhook-timestamp": c.req.header("webhook-timestamp"),
        "webhook-signature": c.req.header("webhook-signature"),
        "x-webhook-signature": c.req.header("x-webhook-signature"),
        "x-renewly-signature": c.req.header("x-renewly-signature"),
      },
      secret: env.MAIL_WEBHOOK_SECRET,
    });
  }

  const email = normalizeInboundEmail(payload, provider);

  const token =
    extractRoutingToken(email.to) ??
    (typeof payload.workspaceToken === "string" ? payload.workspaceToken : null) ??
    c.req.header("x-renewly-workspace-token") ??
    null;

  if (!token) {
    // Nothing to route on. Acknowledge so the provider stops retrying.
    logger.warn({ provider, to: email.to }, "inbound mail with no routing token");
    return c.json({ ok: true, ignored: true, reason: "NO_ROUTING_TOKEN" });
  }

  const workspaceId = await resolveWorkspaceByToken(token);
  if (!workspaceId) {
    logger.warn({ provider, token }, "inbound mail for unknown workspace token");
    return c.json({ ok: true, ignored: true, reason: "UNKNOWN_WORKSPACE" });
  }

  const [workspace] = await getDb().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return c.json({ ok: true, ignored: true, reason: "UNKNOWN_WORKSPACE" });

  const auth = await resolveAuthContext(workspace.ownerUserId, workspaceId);
  const result = await ingestInboundEmail({ auth, email });

  return c.json(
    {
      ok: true,
      status: result.status,
      inboundEmailId: result.inboundEmail.id,
      subscriptionId: result.subscriptionId,
      renewalEventId: result.renewalEventId,
    },
    result.status === "duplicate" ? 200 : 201,
  );
});

/** Where to forward renewal mail for this workspace. */
export const mailAddressRoutes = new Hono<AppEnv>();

mailAddressRoutes.use("*", requireAuth());

mailAddressRoutes.get("/", async (c) => {
  const { user, workspace } = c.get("auth");
  const owned = await findWorkspaceForUser(user.id);
  const id = owned?.id ?? workspace.id;

  return c.json({
    address: inboundAddressFor(id, env.MAIL_INBOUND_DOMAIN),
    domain: env.MAIL_INBOUND_DOMAIN,
    mode: env.MAIL_MODE,
  });
});
