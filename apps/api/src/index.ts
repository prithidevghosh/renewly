import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getDatabaseHandle, closeDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { seedMerchants } from "./modules/merchants/service.js";
import { reapStaleSessions } from "./modules/agent/runner.js";
import { startWorker, stopWorker } from "./modules/workers/runner.js";

async function main(): Promise<void> {
  const handle = getDatabaseHandle();

  // Applying migrations at boot keeps `dev` a single command. A production
  // deploy should run db:migrate as its own release step instead.
  if (env.NODE_ENV !== "production") {
    await runMigrations(handle);
  }

  // The shared merchant catalog is reference data, not user data, so it is
  // installed on every boot rather than left to the seed script.
  await seedMerchants(handle.db);

  // In-process worker: drains the outbox, expires approvals and runs jobs. A
  // multi-instance deploy should run this as its own process with the API's
  // WORKER_ENABLED set to false.
  startWorker(handle.db);

  // An agent run lives in the process driving it, so a restart abandons any
  // that were mid-flight. Close them now rather than leave a terminal
  // reattaching to a run that will never emit another event.
  await reapStaleSessions(handle.db);

  // Say which integrations are switched off, on every boot. A disabled feature
  // is a deliberate state, but it is still one that makes calls fail, and
  // reading it off the startup log beats deducing it from a 503 later.
  const disabled = (
    [
      ["OAUTH_MODE", env.OAUTH_MODE],
      ["MAILBOX_MODE", env.MAILBOX_MODE],
      ["PRAVA_MODE", env.PRAVA_MODE],
      ["LINQ_MODE", env.LINQ_MODE],
      ["MAIL_MODE", env.MAIL_MODE],
      ["MAIL_OUTBOUND_MODE", env.MAIL_OUTBOUND_MODE],
      ["CHECKOUT_ADAPTER_MODE", env.CHECKOUT_ADAPTER_MODE],
    ] as const
  )
    .filter(([, mode]) => mode === "disabled")
    .map(([name]) => name);

  if (disabled.length > 0) {
    logger.warn(
      { disabled },
      `${disabled.length} integration(s) are switched off and will return ` +
        "FEATURE_DISABLED: " +
        disabled.join(", ") +
        ". Supply the credentials and set them live to enable.",
    );
  }

  const server = serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
    logger.info(
      {
        port: info.port,
        driver: handle.kind,
        pravaMode: env.PRAVA_MODE,
        linqMode: env.LINQ_MODE,
        mailMode: env.MAIL_MODE,
        mailOutboundMode: env.MAIL_OUTBOUND_MODE,
        mailFrom: env.MAIL_FROM,
        worker: env.WORKER_ENABLED,
        llm: env.LLM_API_KEY ? "configured" : "heuristic-fallback",
      },
      "renewly api listening",
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    stopWorker();
    server.close(() => {
      void closeDatabase().finally(() => process.exit(0));
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "failed to start");
  process.exit(1);
});
