import { createDatabase, setDatabaseHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { logger } from "../src/lib/logger.js";
import { seedMerchants } from "../src/modules/merchants/service.js";

/**
 * Seeds reference data, and nothing else.
 *
 * The merchant graph is a catalogue of real vendors — names, canonical forms and
 * cancellation URLs — that the decision and payment paths look things up in. It
 * describes the world rather than claiming anything about this workspace, so
 * loading it invents nothing.
 *
 * What used to be here as well: a demo account, two sample subscriptions and an
 * open approval waiting in the simulator thread, behind SEED_SAMPLE_SUBS and
 * SEED_DEMO_FLOW. All of it is gone. Sample rows are indistinguishable from a
 * user's own once they are in the table — they have the same shape, they total
 * into the same savings figure, and nothing on the screen marks them as
 * invented. An empty account is the honest starting state; the first real
 * subscription should arrive through intake.
 */
async function main(): Promise<void> {
  const handle = createDatabase();
  setDatabaseHandle(handle);
  await runMigrations(handle);

  const merchantsSeeded = await seedMerchants(handle.db);

  logger.info({ merchantsSeeded, driver: handle.kind }, "seed complete");

  await handle.close();
}

main().catch((error) => {
  logger.error({ err: error }, "seed failed");
  process.exit(1);
});
