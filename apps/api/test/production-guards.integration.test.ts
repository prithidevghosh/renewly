import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Production must never run on fakes.
 *
 * Every adapter defaults to `mock` so the suite and a laptop need no keys. That
 * default is correct for a test and catastrophic in production, where it turns
 * real requests into theatre. It was not hypothetical: with OAUTH_MODE unset, a
 * GET to the Google callback carrying `code=mock:x:ceo@company.com` returned a
 * valid session for that address — no password, no Google, no consent.
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
  WHATSAPP_MODE: "live",
  WHATSAPP_TOKEN: "t",
  WHATSAPP_PHONE_NUMBER_ID: "p",
  MAIL_MODE: "live",
  MAIL_WEBHOOK_SECRET: "s",
  MAIL_OUTBOUND_MODE: "live",
  MAIL_OUTBOUND_API_KEY: "re_x",
};

describe("production refuses mock identity", () => {
  it("will not boot with mock sign-in", () => {
    const result = boot({ ...CONFIGURED, OAUTH_MODE: "mock" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("OAUTH_MODE");
    expect(result.output).toMatch(/without a password/i);
  });

  it("will not boot with a mock mailbox", () => {
    const result = boot({ ...CONFIGURED, MAILBOX_MODE: "mock" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("MAILBOX_MODE");
    expect(result.output).toMatch(/fixture data/i);
  });

  it("offers no opt-out for either, however loudly it is asked for", () => {
    // ALLOW_MOCK_INTEGRATIONS covers money and messaging. Identity is not
    // negotiable: no environment variable may re-enable it.
    const result = boot({
      ...CONFIGURED,
      OAUTH_MODE: "mock",
      MAILBOX_MODE: "mock",
      ALLOW_MOCK_INTEGRATIONS: "true",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no opt-out/i);
  });
});

describe("production refuses mock integrations unless asked", () => {
  it("will not boot with fake payments by default", () => {
    const result = boot({ ...CONFIGURED, PRAVA_MODE: "mock" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("PRAVA_MODE");
    expect(result.output).toContain("ALLOW_MOCK_INTEGRATIONS");
  });

  it("will not boot with undeliverable messaging by default", () => {
    const result = boot({ ...CONFIGURED, LINQ_MODE: "mock", MAIL_OUTBOUND_MODE: "mock" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("LINQ_MODE");
    expect(result.output).toContain("MAIL_OUTBOUND_MODE");
  });

  it("boots a demo deployment only when it says so explicitly", () => {
    const result = boot({
      ...CONFIGURED,
      PRAVA_MODE: "mock",
      LINQ_MODE: "mock",
      ALLOW_MOCK_INTEGRATIONS: "true",
    });

    expect(result.ok).toBe(true);
  });
});

describe("a fully configured production boots", () => {
  it("accepts real credentials for everything", () => {
    expect(boot(CONFIGURED).ok).toBe(true);
  });

  it("still refuses a development AUTH_SECRET", () => {
    const result = boot({
      ...CONFIGURED,
      AUTH_SECRET: "renewly-development-secret-do-not-use-in-production",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("AUTH_SECRET");
  });
});

describe("development is unaffected", () => {
  it("boots on defaults, so a laptop needs no keys", () => {
    const result = boot({
      NODE_ENV: "development",
      DATABASE_URL: "pglite://memory",
      AUTH_SECRET: "renewly-development-secret-do-not-use-in-production",
    });

    expect(result.ok).toBe(true);
  });
});

describe("a feature may be turned off honestly", () => {
  it("boots in production with social sign-in and mailbox disabled", () => {
    // The alternative to faking a feature is switching it off and saying so —
    // not pretending. A deployment with no Google secret is a legitimate
    // deployment; it simply has no Google button.
    const result = boot({
      ...CONFIGURED,
      OAUTH_MODE: "disabled",
      MAILBOX_MODE: "disabled",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    });

    expect(result.ok).toBe(true);
  });
});
