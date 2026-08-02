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
/** `--force` stops whatever is listening instead of refusing to start. */
const FORCE = process.argv.includes("--force");

/** The PID actually listening on the port, or null. Clients do not count. */
async function listenerPid() {
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync(`lsof -ti:${PORT} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out.split("\n").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

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

if ((await portInUse(PORT)) && FORCE) {
  const pid = await listenerPid();
  if (pid) {
    process.kill(Number(pid), "SIGTERM");
    console.log(`  stopped the API already on port ${PORT} (pid ${pid})`);
    // Give the old process a moment to release the port and its PGlite lock.
    for (let i = 0; i < 20 && (await portInUse(PORT)); i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

if (await portInUse(PORT)) {
  // pnpm wraps a non-zero exit in ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL, which
  // reads like a crash. Say plainly that nothing is broken, and name the
  // process so the fix is one copy-paste rather than a hunt.
  const pid = await listenerPid();
  const owner = pid ? `  It is process ${pid}.\n` : "";

  console.error(
    [
      "",
      "  ─────────────────────────────────────────────────────────────",
      `  Nothing is broken. The API is already running on port ${PORT},`,
      "  so this second copy stopped before it could start.",
      "  ─────────────────────────────────────────────────────────────",
      "",
      owner + "  Two instances would point at the same PGlite directory and",
      "  corrupt it, so only one may run at a time.",
      "",
      "  Use the one already running, or replace it:",
      "",
      "    pnpm --filter @renewly/api dev:restart",
      "",
      `  Or run this copy beside it:  PORT=4001 pnpm --filter @renewly/api dev`,
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
