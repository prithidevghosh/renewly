import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { logger } from "../lib/logger.js";
import { createDatabase, getDatabaseHandle, type DatabaseHandle } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Resolves to <package>/drizzle from both src (tsx) and dist (compiled). */
export const MIGRATIONS_FOLDER = path.resolve(here, "..", "..", "drizzle");

export async function runMigrations(handle: DatabaseHandle = getDatabaseHandle()): Promise<void> {
  const options = { migrationsFolder: MIGRATIONS_FOLDER };
  if (handle.kind === "postgres") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrator is driver-typed
    await migrateNode(handle.db as any, options);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrator is driver-typed
    await migratePglite(handle.db as any, options);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const handle = createDatabase();
  runMigrations(handle)
    .then(async () => {
      logger.info({ driver: handle.kind }, "migrations applied");
      await handle.close();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      logger.error({ err: error }, "migration failed");
      await handle.close().catch(() => undefined);
      process.exit(1);
    });
}
