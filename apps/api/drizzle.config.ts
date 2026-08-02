import { defineConfig } from "drizzle-kit";

/**
 * Schema is authored for PostgreSQL. Migrations generated here are applied by
 * `src/db/migrate.ts` against either node-postgres or PGlite (in-process
 * Postgres), so the same SQL runs in dev, test and production.
 */
const configured = process.env.DATABASE_URL ?? "";
const isServer = configured.startsWith("postgres://") || configured.startsWith("postgresql://");

/**
 * drizzle-kit connects over TCP, so it can reach a Postgres server but not a
 * `pglite://` directory — there is nothing listening on a port to connect to.
 * When DATABASE_URL names a directory, fall back to the compose Postgres, which
 * `db:studio` and `db:push` need anyway. Falling back rather than throwing keeps
 * `db:generate` — which opens no connection at all — working either way.
 */
const url = isServer ? configured : "postgresql://postgres:postgres@127.0.0.1:5433/renewly";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
