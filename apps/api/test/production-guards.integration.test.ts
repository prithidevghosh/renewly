import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing may run on fakes, in any environment.
 *
 * Adapters used to default to `mock`, which was correct for a test and
 * catastrophic once deployed: it turned real requests into theatre. It was not
 * hypothetical — with OAUTH_MODE unset, a GET to the Google callback carrying
 * `code=mock:x:ceo@company.com` returned a valid session for that address, with
 * no password, no Google and no consent.
 *
 * The guard that listed forbidden modes is gone because the modes are gone.
 * What is asserted here now is stronger and simpler: `mock` is not a value any
 * integration accepts, so a stale .env carrying one cannot start the process at
 * all; unconfigured means `disabled`, which fails loudly at the call rather than
 * answering with something invented; and defaults are safe.
 *
 * These boot a real process, because the rule is enforced while parsing the
 * environment. Importing env.ts inside the suite would read the test
 * environment and prove nothing.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(here, "..");

interface BootResult {
  ok: boolean;
  output: string;
}

/** Boots just the env module under a given environment and reports the outcome. */
function boot(overrides: Record<string, string>): BootResult {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    AUTH_SECRET: "a-real-looking-production-secret-of-sufficient-length",
    // dotenv would otherwise read the developer's own .env and mask the case
    // under test.
    DOTENV_CONFIG_PATH: path.join(API_ROOT, ".env.nonexistent"),
    ...overrides,
  };

  try {
    const output = execFileSync(
      "npx",
      ["tsx", "-e", 'import("./src/env.ts").then(() => console.log("BOOT_OK"))'],
      { cwd: API_ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    return { ok: output.includes("BOOT_OK"), output };
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${shaped.stdout ?? ""}${shaped.stderr ?? ""}` };
  }
}

/** Everything real except the modes under test. */
const CONFIGURED = {
  OAUTH_MODE: "live",
  GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "secret",
  MAILBOX_MODE: "live",
  PRAVA_MODE: "sandbox",
  PRAVA_SECRET_KEY: "sk_test_x",
  CHECKOUT_ADAPTER_MODE: "http",
  CHECKOUT_ADAPTER_URL: "https://checkout.example.com",
  LINQ_MODE: "live",
  LINQ_API_KEY: "k",
  LINQ_FROM_NUMBER: "+15550000000",
  MAIL_MODE: "live",
  MAIL_WEBHOOK_SECRET: "s",
  MAIL_OUTBOUND_MODE: "live",
  MAIL_OUTBOUND_API_KEY: "re_x",
};

describe("mock is not a configurable state", () => {
  const MOCKABLE = [
    "OAUTH_MODE",
    "MAILBOX_MODE",
    "PRAVA_MODE",
    "LINQ_MODE",
    "MAIL_MODE",
    "MAIL_OUTBOUND_MODE",
    "CHECKOUT_ADAPTER_MODE",
  ];

  for (const key of MOCKABLE) {
    it(`refuses to start with ${key}=mock`, () => {
      const result = boot({ ...CONFIGURED, [key]: "mock" });

      expect(result.ok).toBe(false);
      // The schema names the legal values, so an operator upgrading from an old
      // .env is told what to write instead of being left with "invalid".
      expect(result.output).toContain(key);
      expect(result.output).toMatch(/Invalid enum value|Expected/);
    });
  }

  it("refuses mock even in development, where it used to be the default", () => {
    const result = boot({ ...CONFIGURED, NODE_ENV: "development", OAUTH_MODE: "mock" });
    expect(result.ok).toBe(false);
  });
});

describe("unconfigured means off, not invented", () => {
  it("boots with everything disabled, so a laptop still needs no keys", () => {
    const result = boot({
      NODE_ENV: "development",
      AUTH_SECRET: "a-development-secret-of-entirely-sufficient-length",
    });
    expect(result.ok).toBe(true);
  });

  it("defaults every integration to disabled rather than to a stand-in", () => {
    // Nothing is set beyond the essentials, and the process starts. What it
    // must not do is start with something pretending to be Google or Prava.
    const result = boot({
      NODE_ENV: "development",
      AUTH_SECRET: "a-development-secret-of-entirely-sufficient-length",
    });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("mock");
  });

  it("boots in production with social sign-in and mailbox switched off", () => {
    const result = boot({ ...CONFIGURED, OAUTH_MODE: "disabled", MAILBOX_MODE: "disabled" });
    expect(result.ok).toBe(true);
  });
});

describe("a mode claiming to be live must have the credentials to be live", () => {
  it("refuses OAUTH_MODE=live with no Google credentials", () => {
    const result = boot({
      ...CONFIGURED,
      OAUTH_MODE: "live",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("GOOGLE_CLIENT_ID");
  });

  it("refuses a half-configured Google", () => {
    const result = boot({ ...CONFIGURED, GOOGLE_CLIENT_SECRET: "" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("must be set together");
  });

  it("refuses a payment rail switched on without a key", () => {
    const result = boot({ ...CONFIGURED, PRAVA_MODE: "sandbox", PRAVA_SECRET_KEY: "" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("PRAVA_SECRET_KEY");
  });

  it("refuses outbound mail switched on without a key", () => {
    const result = boot({ ...CONFIGURED, MAIL_OUTBOUND_MODE: "live", MAIL_OUTBOUND_API_KEY: "" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("MAIL_OUTBOUND_API_KEY");
  });

  it("still refuses a development AUTH_SECRET in production", () => {
    const result = boot({ ...CONFIGURED, AUTH_SECRET: "renewly-development-secret-do-not-use-x" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("AUTH_SECRET");
  });

  it("accepts real credentials for everything", () => {
    const result = boot(CONFIGURED);
    expect(result.ok).toBe(true);
  });
});
