import { defineConfig } from "drizzle-kit";

/**
 * Schema is authored for PostgreSQL. Migrations generated here are applied by
 * `src/db/migrate.ts` against either node-postgres or PGlite (in-process
 * Postgres), so the same SQL runs in dev, test and production.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/renewly",
  },
  strict: true,
  verbose: true,
});
