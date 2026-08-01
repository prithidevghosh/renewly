import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { requestId } from "./middleware/requestId.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { approvalRoutes } from "./modules/approvals/routes.js";
import { authRoutes, meRoutes } from "./modules/auth/routes.js";
import { channelRoutes, channelWebhookRoutes } from "./modules/channels/routes.js";
import { decisionRoutes } from "./modules/decisions/routes.js";
import { intakeRoutes } from "./modules/intake/routes.js";
import { mailAddressRoutes, mailWebhookRoutes } from "./modules/intake/mail/routes.js";
import {
  auditRoutes,
  paymentSessionRoutes,
  receiptRoutes,
  savingsRoutes,
} from "./modules/ledger/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { subscriptionRoutes } from "./modules/subscriptions/routes.js";
import { waitlistRoutes } from "./modules/waitlist/routes.js";
import type { AppEnv } from "./types/context.js";

export const API_VERSION = "1.1.0";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.use("*", requestId());
  app.use("*", securityHeaders());
  app.use(
    "*",
    cors({
      origin: env.CORS_ORIGINS,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "x-request-id"],
      exposeHeaders: ["x-request-id"],
      credentials: true,
      maxAge: 600,
    }),
  );
  // Generous global ceiling; the auth routes add their own tighter window.
  app.use("/v1/*", rateLimit({ limit: 600, windowMs: 60_000, key: (ip) => `global:${ip}` }));

  app.get("/health", (c) => c.json({ ok: true, version: API_VERSION, env: env.NODE_ENV }));

  app.get("/v1/demo/status", (c) =>
    c.json({
      // Booleans and modes only: never disclose which keys are configured.
      llmConfigured: Boolean(env.LLM_API_KEY),
      pravaMode: env.PRAVA_MODE,
      pravaConfigured: env.PRAVA_MODE === "mock" || Boolean(env.PRAVA_SECRET_KEY),
      linqMode: env.LINQ_MODE,
      linqConfigured: env.LINQ_MODE === "mock" || Boolean(env.LINQ_API_KEY),
      whatsappMode: env.WHATSAPP_MODE,
      whatsappConfigured:
        env.WHATSAPP_MODE === "mock" ||
        Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID),
      mailMode: env.MAIL_MODE,
      mailOutboundMode: env.MAIL_OUTBOUND_MODE,
      mailOutboundConfigured:
        env.MAIL_OUTBOUND_MODE === "mock" || Boolean(env.MAIL_OUTBOUND_API_KEY),
      checkoutAdapterMode: env.CHECKOUT_ADAPTER_MODE,
      workerEnabled: env.WORKER_ENABLED,
      version: API_VERSION,
      env: env.NODE_ENV,
    }),
  );

  // Webhooks are unauthenticated by necessity and verified by signature, so
  // they are mounted before anything that expects a session.
  app.route("/v1/webhooks", channelWebhookRoutes);
  app.route("/v1/webhooks/mail", mailWebhookRoutes);

  // Public, pre-account surface: no session exists yet by definition.
  app.route("/v1/waitlist", waitlistRoutes);

  app.route("/v1/auth", authRoutes);
  app.route("/v1/me", meRoutes);
  app.route("/v1/settings", settingsRoutes);
  app.route("/v1/channels", channelRoutes);
  app.route("/v1/subscriptions", subscriptionRoutes);
  app.route("/v1/intake", intakeRoutes);
  app.route("/v1/intake/mail-address", mailAddressRoutes);
  app.route("/v1/decisions", decisionRoutes);
  app.route("/v1/approvals", approvalRoutes);
  app.route("/v1/payment-sessions", paymentSessionRoutes);
  app.route("/v1/receipts", receiptRoutes);
  app.route("/v1/savings", savingsRoutes);
  app.route("/v1/audit", auditRoutes);

  return app;
}
