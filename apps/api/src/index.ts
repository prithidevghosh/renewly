import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getDatabaseHandle, closeDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { seedMerchants } from "./modules/merchants/service.js";
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

  // A key is configured but nothing will be sent: the single most confusing
  // state this service can boot into, so it is said out loud rather than
  // inferred from an absence of mail.
  if (env.MAIL_OUTBOUND_MODE === "mock" && env.MAIL_OUTBOUND_API_KEY) {
    logger.warn(
      { mailOutboundMode: "mock", from: env.MAIL_FROM },
      "MAIL_OUTBOUND_API_KEY is set but MAIL_OUTBOUND_MODE=mock — outbound mail is captured " +
        "in memory and no message will reach anyone. Set MAIL_OUTBOUND_MODE=live to send.",
    );
  }

  const server = serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
    logger.info(
      {
        port: info.port,
        driver: handle.kind,
        pravaMode: env.PRAVA_MODE,
        linqMode: env.LINQ_MODE,
        whatsappMode: env.WHATSAPP_MODE,
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
