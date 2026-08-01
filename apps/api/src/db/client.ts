import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import { env } from "../env.js";
import * as schema from "./schema.js";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DriverKind = "postgres" | "pglite";

export interface DatabaseHandle {
  db: Database;
  kind: DriverKind;
  close: () => Promise<void>;
}

export function driverKindFor(url: string): DriverKind {
  return url.startsWith("postgres://") || url.startsWith("postgresql://") ? "postgres" : "pglite";
}

/**
 * PGlite accepts either "memory://" or a data directory. We accept a
 * `pglite://` scheme for symmetry with DATABASE_URL and strip it.
 */
function pgliteTarget(url: string): string {
  const withoutScheme = url.replace(/^pglite:\/\//, "");
  if (withoutScheme === "" || withoutScheme === "memory" || withoutScheme === "memory://") {
    return "memory://";
  }
  return withoutScheme;
}

export function createDatabase(url: string = env.DATABASE_URL): DatabaseHandle {
  const kind = driverKindFor(url);

  if (kind === "postgres") {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    return {
      db: drizzleNode(pool, { schema }) as unknown as Database,
      kind,
      close: async () => {
        await pool.end();
      },
    };
  }

  const target = pgliteTarget(url);
  if (target !== "memory://") {
    // PGlite's mkdir is not recursive; create the parent chain ourselves.
    mkdirSync(target, { recursive: true });
  }
  const client = new PGlite(target);
  return {
    db: drizzlePglite(client, { schema }) as unknown as Database,
    kind,
    close: async () => {
      await client.close();
    },
  };
}

let handle: DatabaseHandle | null = null;

export function getDatabaseHandle(): DatabaseHandle {
  if (!handle) handle = createDatabase();
  return handle;
}

export function getDb(): Database {
  return getDatabaseHandle().db;
}

/** Tests install an isolated in-process database before importing the app. */
export function setDatabaseHandle(next: DatabaseHandle | null): void {
  handle = next;
}

export async function closeDatabase(): Promise<void> {
  if (handle) {
    await handle.close();
    handle = null;
  }
}

export { schema };
