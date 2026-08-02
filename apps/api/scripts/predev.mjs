import { createConnection } from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Runs before `dev`.
 *
 * PGlite is an in-process Postgres with no multi-process locking: two API
 * instances pointed at the same data directory corrupt it, and the failure
 * surfaces later as an opaque wasm `Aborted()` during initdb rather than
 * anything that names the real cause. So refuse to start a second one, and
 * clear the lock a previously killed instance left behind.
 */

const PORT = Number(process.env.PORT ?? 4000);

function readEnvFile() {
  const file = path.resolve(process.cwd(), ".env");
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(600);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

const env = { ...readEnvFile(), ...process.env };

if (await portInUse(PORT)) {
  console.error(
    [
      "",
      `  The API is already running on port ${PORT}.`,
      "",
      "  Starting a second instance would point two processes at the same PGlite",
      "  directory, which corrupts it. Stop the other one first:",
      "",
      `    lsof -ti:${PORT} | xargs kill`,
      "",
      "  Or run this one elsewhere:  PORT=4001 pnpm dev",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// Nothing is listening, so any lock left in the data directory is from an
// instance that died without cleaning up. Safe to clear.
const url = env.DATABASE_URL ?? "pglite://./.data/renewly";
if (url.startsWith("pglite://") && !url.includes("memory")) {
  const dir = path.resolve(process.cwd(), url.replace("pglite://", ""));
  for (const name of ["postmaster.pid", ".s.PGSQL.5432.lock", ".s.PGSQL.5432.lock.out"]) {
    const lock = path.join(dir, name);
    if (existsSync(lock)) {
      rmSync(lock, { force: true });
      console.log(`  cleared stale ${name} from a previous run`);
    }
  }
}
