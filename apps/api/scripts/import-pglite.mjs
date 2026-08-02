import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/**
 * Copies a PGlite data directory into a Postgres server, once.
 *
 * PGlite is the zero-infrastructure default, and a laptop that outgrows it —
 * usually because a GUI wants to connect, which an embedded database has no
 * port for — needs its existing rows carried over. Migrations must already be
 * applied on the target; this moves data, not schema.
 *
 *   node scripts/import-pglite.mjs <pglite-dir> <postgres-url>
 *
 * Nothing calls this during normal development. It is safe to delete once the
 * switch is made.
 */

const [, , dirArg, urlArg] = process.argv;

if (!dirArg || !urlArg) {
  console.error("usage: node scripts/import-pglite.mjs <pglite-dir> <postgres-url>");
  process.exit(1);
}

const dir = path.resolve(process.cwd(), dirArg.replace(/^pglite:\/\//, ""));
if (!existsSync(dir)) {
  console.error(`No PGlite directory at ${dir}`);
  process.exit(1);
}

// A lock left by a process that is no longer running would block the open.
for (const name of ["postmaster.pid", ".s.PGSQL.5432.lock", ".s.PGSQL.5432.lock.out"]) {
  const lock = path.join(dir, name);
  if (existsSync(lock)) rmSync(lock, { force: true });
}

const source = new PGlite(dir);
await source.waitReady;

const target = new pg.Client(urlArg);
await target.connect();

const { rows: tables } = await source.query(
  `select table_name from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE'
   order by table_name`,
);

/*
 * Foreign keys make the correct insert order a topological sort of the schema.
 * Suspending constraint triggers for the transaction is the same thing pg_dump
 * does and needs no such ordering — the data being copied already satisfied
 * these constraints in the source.
 */
await target.query("begin");
await target.query("set constraints all deferred");
await target.query("set session_replication_role = replica");

/**
 * node-postgres infers the wire format from the JavaScript value, and for an
 * array it infers a Postgres array — `{"openid","email"}`, which a json column
 * rejects. Only the column's declared type says which is meant, so ask, and
 * serialize by that rather than by what the value looks like.
 */
async function jsonColumnsOf(table) {
  const { rows } = await target.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1
        and data_type in ('json', 'jsonb')`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

let copied = 0;
const skipped = [];

for (const { table_name: table } of tables) {
  const { rows } = await source.query(`select * from "${table}"`);
  if (rows.length === 0) continue;

  const existing = await target.query(`select count(*)::int n from "${table}"`);
  if (existing.rows[0].n > 0) {
    skipped.push(`${table} (${existing.rows[0].n} rows already there)`);
    continue;
  }

  const jsonColumns = await jsonColumnsOf(table);
  const columns = Object.keys(rows[0]);
  const quoted = columns.map((c) => `"${c}"`).join(", ");

  for (const row of rows) {
    const values = columns.map((c) => {
      const value = row[c];
      if (value !== null && jsonColumns.has(c)) return JSON.stringify(value);
      return value;
    });
    const params = columns.map((_, i) => `$${i + 1}`).join(", ");
    await target.query(`insert into "${table}" (${quoted}) values (${params})`, values);
  }

  console.log(`  ${table}: ${rows.length}`);
  copied += rows.length;
}

await target.query("set session_replication_role = default");
await target.query("commit");

// Identity and serial columns carry their own counter, which insertion with an
// explicit value does not advance. Left alone, the next insert collides.
const { rows: sequences } = await target.query(
  `select sequence_schema, sequence_name from information_schema.sequences
   where sequence_schema = 'public'`,
);
for (const { sequence_name: name } of sequences) {
  const owner = await target.query(
    `select tab.relname as table_name, att.attname as column_name
       from pg_class seq
       join pg_depend dep on dep.objid = seq.oid and dep.deptype in ('a', 'i')
       join pg_class tab on tab.oid = dep.refobjid
       join pg_attribute att on att.attrelid = tab.oid and att.attnum = dep.refobjsubid
      where seq.relname = $1`,
    [name],
  );
  if (owner.rowCount === 0) continue;
  const { table_name: table, column_name: column } = owner.rows[0];
  await target.query(
    `select setval($1, coalesce((select max("${column}") from "${table}"), 0) + 1, false)`,
    [name],
  );
}

console.log(`\n  ${copied} rows copied into ${tables.length} tables.`);
if (skipped.length > 0) console.log(`  skipped: ${skipped.join(", ")}`);

await target.end();
await source.close();
