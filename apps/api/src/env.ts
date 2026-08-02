import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * DOTENV_CONFIG_PATH is dotenv's own convention, but it is only read by its
 * preload entry point — calling `config()` directly ignores it. Honouring it
 * here is what lets a test boot this module in isolation from whatever .env the
 * developer happens to have; without it the suite silently reads their file and
 * asserts against a configuration it did not choose.
 */
loadDotenv(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : undefined);

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * A key left blank in `.env` — `LINQ_API_KEY=` — reaches us as "" rather
 * than undefined. That is a template placeholder, not a value, so it means
 * unset. Without this a blank line in the shipped `.env.example` fails boot on
 * every schema stricter than a plain string.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1).default("pglite://./.data/renewly"),

  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000").transform(csv),

  AUTH_SECRET: z.string().min(32).default("renewly-development-secret-do-not-use-in-production"),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),

  /**
   * Every integration is `live` or `disabled`. There is no third mode.
   *
   * A mock adapter answers in the shape of the real thing while nothing behind
   * it is true: fixture mail presented as the user's inbox, a payment that
   * settles nothing, a message delivered to no one. Because it succeeds, there
   * is no failure anywhere to notice, and the fake reaches the screen wearing
   * the same clothes as the fact. So the code no longer contains one.
   *
   * `disabled` is the honest answer when a credential is missing: the feature
   * switches off, the UI says it is unavailable, and any call to it raises
   * FEATURE_DISABLED. Switched off is a state a user can understand and act on.
   * Pretending is not.
   */
  /** Google is the only social sign-in provider; Microsoft has been removed. */
  OAUTH_MODE: z.enum(["live", "disabled"]).default("disabled"),
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),

  /**
   * Microsoft credentials remain solely for reading an Outlook mailbox, which
   * is a different capability from signing in. Nothing authenticates with them.
   */
  MICROSOFT_CLIENT_ID: optional(z.string()),
  MICROSOFT_CLIENT_SECRET: optional(z.string()),
  /** `common` accepts both work and personal Microsoft accounts. */
  MICROSOFT_TENANT: z.string().default("common"),

  /**
   * Mailbox read access. Separate from OAUTH_MODE so sign-in can be live while
   * the inbox is off — Gmail's read scope is restricted and needs Google's
   * review, which arrives long after sign-in works.
   */
  MAILBOX_MODE: z.enum(["live", "disabled"]).default("disabled"),

  /** Six-digit code lifetime, and how many guesses it survives. */
  VERIFICATION_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Seconds a client must wait before asking for another code. */
  VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),

  LLM_API_KEY: optional(z.string()),
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().default("gpt-4o-mini"),

  PRAVA_MODE: z.enum(["sandbox", "live", "disabled"]).default("disabled"),
  PRAVA_SECRET_KEY: optional(z.string()),
  PRAVA_PUBLISHABLE_KEY: optional(z.string()),
  PRAVA_API_BASE: z.string().url().default("https://sandbox.api.prava.space"),
  PRAVA_POLL_ATTEMPTS: z.coerce.number().int().positive().default(20),
  PRAVA_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1500),
  /** merchant_details.url is required and must be https; used when the merchant
   *  graph has no website for the vendor. */
  PRAVA_MERCHANT_FALLBACK_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "must be an https URL")
    .default("https://renewly.app"),
  /** merchant_details.country_code_iso2, required by POST /v1/sessions. */
  PRAVA_MERCHANT_COUNTRY: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "must be a 2-letter ISO country code")
    .default("US")
    .transform((value) => value.toUpperCase()),

  LINQ_MODE: z.enum(["live", "disabled"]).default("disabled"),
  LINQ_API_KEY: optional(z.string()),
  LINQ_WEBHOOK_SECRET: optional(z.string()),
  LINQ_BASE_URL: z.string().url().default("https://api.linqapp.com/api/partner/v3"),
  /** A line provisioned on the Linq account; required to start a chat. */
  LINQ_FROM_NUMBER: optional(z.string()),

  MAIL_MODE: z.enum(["live", "disabled"]).default("disabled"),
  MAIL_WEBHOOK_SECRET: optional(z.string()),
  MAIL_INBOUND_DOMAIN: z.string().default("inbound.renewly.app"),

  /** Outbound mail, sent through Resend. Separate from MAIL_MODE, which is inbound. */
  MAIL_OUTBOUND_MODE: z.enum(["live", "disabled"]).default("disabled"),
  MAIL_OUTBOUND_API_KEY: optional(z.string()),
  /** RFC 5322 sender. The domain must be verified with the provider. */
  MAIL_FROM: z.string().min(3).default("Renewly <hello@renewly.app>"),
  MAIL_REPLY_TO: optional(z.string().email()),
  /** Where the internal "someone joined the waitlist" notice is sent. */
  WAITLIST_NOTIFY_TO: z.string().email().default("prithidevghosh@gmail.com"),
  /** Where contact-form messages are sent. */
  CONTACT_NOTIFY_TO: z.string().email().default("prithvi@renewly.live"),

  WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /** A renewal due within this many days is close enough to propose on. */
  RENEWAL_HORIZON_DAYS: z.coerce.number().int().positive().default(7),
  /** The proposal sweep runs the decision engine, so it paces itself far
   *  slower than the worker tick it rides on. */
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * How long to leave a renewal alone after a proposal for it ended without an
   * answer — expired, or the send failed. Without a floor the sweep would put
   * the same proposal back in front of someone every five minutes; without any
   * retry at all a proposal lost to a channel outage is lost for good.
   */
  PROPOSAL_RETRY_COOLDOWN_MINUTES: z.coerce.number().int().nonnegative().default(60),

  CHECKOUT_ADAPTER_MODE: z.enum(["http", "disabled"]).default("disabled"),
  CHECKOUT_ADAPTER_URL: optional(z.string().url()),
  CHECKOUT_ADAPTER_SECRET: optional(z.string()),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1_048_576),
  MAX_CSV_ROWS: z.coerce.number().int().positive().default(5000),

});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const value = parsed.data;

  if (value.NODE_ENV === "production") {
    if (value.AUTH_SECRET.startsWith("renewly-development-secret")) {
      throw new Error("AUTH_SECRET must be set to a real secret in production");
    }
    if (value.PRAVA_MODE !== "disabled" && !value.PRAVA_SECRET_KEY) {
      throw new Error("PRAVA_SECRET_KEY is required when PRAVA_MODE is sandbox or live");
    }
  }

  /*
   * There is no mock adapter left to refuse, in any environment.
   *
   * This guard used to list the modes production could not be started with,
   * because every adapter defaulted to `mock` and the default was catastrophic
   * once deployed. It was not hypothetical: with OAUTH_MODE unset, POSTing to
   * the Google callback with `code=mock:x:ceo@yourdomain.com` returned a valid
   * session for that address — no password, no Google, no consent.
   *
   * The fix is no longer a guard around a dangerous default; the dangerous
   * thing is gone. `mock` is not a value any mode accepts, so an old .env
   * carrying one fails schema parsing above with the list of legal values.
   * What remains below is the check that a mode claiming to be live actually
   * has the credentials to be live — a half-configured provider is a 500 on a
   * button the user can already see.
   */
  if (value.OAUTH_MODE === "live") {
    // A half-configured provider is a runtime 500 on a button the user can
    // already see, so it fails here instead.
    if (Boolean(value.GOOGLE_CLIENT_ID) !== Boolean(value.GOOGLE_CLIENT_SECRET)) {
      throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
    }
    if (!value.GOOGLE_CLIENT_ID) {
      throw new Error(
        'OAUTH_MODE=live needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Use "disabled" ' +
          "to turn social sign-in off; password sign-in is unaffected.",
      );
    }
  }
  // Outlook mail is read with these; they authenticate nobody.
  if (Boolean(value.MICROSOFT_CLIENT_ID) !== Boolean(value.MICROSOFT_CLIENT_SECRET)) {
    throw new Error("MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set together");
  }
  if (value.LINQ_MODE === "live" && !value.LINQ_API_KEY) {
    throw new Error("LINQ_API_KEY is required when LINQ_MODE is live");
  }
  if (value.LINQ_MODE === "live" && !value.LINQ_FROM_NUMBER) {
    throw new Error("LINQ_FROM_NUMBER is required when LINQ_MODE is live");
  }
  if (value.MAIL_MODE === "live" && !value.MAIL_WEBHOOK_SECRET) {
    throw new Error("MAIL_WEBHOOK_SECRET is required when MAIL_MODE is live");
  }
  if (value.MAIL_OUTBOUND_MODE === "live" && !value.MAIL_OUTBOUND_API_KEY) {
    throw new Error("MAIL_OUTBOUND_API_KEY is required when MAIL_OUTBOUND_MODE is live");
  }
  if (value.CHECKOUT_ADAPTER_MODE === "http" && !value.CHECKOUT_ADAPTER_URL) {
    throw new Error("CHECKOUT_ADAPTER_URL is required when CHECKOUT_ADAPTER_MODE is http");
  }
  // Checked in every environment, not just production: a payment rail that is
  // switched on without a key has no in-process fallback to quietly land on any
  // more, so the failure would otherwise arrive at the first charge instead of
  // at boot.
  if (value.PRAVA_MODE !== "disabled" && !value.PRAVA_SECRET_KEY) {
    throw new Error(`PRAVA_SECRET_KEY is required when PRAVA_MODE is ${value.PRAVA_MODE}`);
  }

  return value;
}

export const env: Env = parseEnv();

export const isTest = (): boolean => env.NODE_ENV === "test";
export const isProduction = (): boolean => env.NODE_ENV === "production";

/** Prava live traffic goes to the production host regardless of PRAVA_API_BASE. */
export function pravaApiBase(): string {
  if (env.PRAVA_MODE === "live") return "https://api.prava.space";
  return env.PRAVA_API_BASE;
}
