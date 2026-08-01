import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1).default("pglite://./.data/renewly"),

  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000").transform(csv),

  AUTH_SECRET: z.string().min(32).default("renewly-development-secret-do-not-use-in-production"),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),

  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().default("gpt-4o-mini"),

  PRAVA_MODE: z.enum(["mock", "sandbox", "live"]).default("mock"),
  PRAVA_SECRET_KEY: z.string().optional(),
  PRAVA_PUBLISHABLE_KEY: z.string().optional(),
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

  MOCK_PRAVA_FAIL: z.enum(["mandate", "card", "decline"]).optional(),
  MOCK_PRAVA_RESULT: z.enum(["success", "decline", "pending", "mandate_fail"]).optional(),

  LINQ_MODE: z.enum(["mock", "live"]).default("mock"),
  LINQ_API_KEY: z.string().optional(),
  LINQ_WEBHOOK_SECRET: z.string().optional(),
  LINQ_BASE_URL: z.string().url().default("https://api.linqapp.com/api/partner/v3"),
  /** A line provisioned on the Linq account; required to start a chat. */
  LINQ_FROM_NUMBER: z.string().optional(),

  WHATSAPP_MODE: z.enum(["mock", "live"]).default("mock"),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  /** Graph versions are supported for about two years from release. */
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "must look like v25.0")
    .default("v25.0"),

  MAIL_MODE: z.enum(["mock", "live"]).default("mock"),
  MAIL_WEBHOOK_SECRET: z.string().optional(),
  MAIL_INBOUND_DOMAIN: z.string().default("inbound.renewly.app"),

  WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(60),

  CHECKOUT_ADAPTER_MODE: z.enum(["mock", "http"]).default("mock"),
  CHECKOUT_ADAPTER_URL: z.string().url().optional(),
  CHECKOUT_ADAPTER_SECRET: z.string().optional(),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1_048_576),
  MAX_CSV_ROWS: z.coerce.number().int().positive().default(5000),

  SEED_SAMPLE_SUBS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Leaves the demo account with an open approval in the simulator thread. */
  SEED_DEMO_FLOW: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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
    if (value.PRAVA_MODE !== "mock" && !value.PRAVA_SECRET_KEY) {
      throw new Error("PRAVA_SECRET_KEY is required when PRAVA_MODE is sandbox or live");
    }
  }
  if (value.LINQ_MODE === "live" && !value.LINQ_API_KEY) {
    throw new Error("LINQ_API_KEY is required when LINQ_MODE is live");
  }
  if (value.LINQ_MODE === "live" && !value.LINQ_FROM_NUMBER) {
    throw new Error("LINQ_FROM_NUMBER is required when LINQ_MODE is live");
  }
  if (
    value.WHATSAPP_MODE === "live" &&
    (!value.WHATSAPP_TOKEN || !value.WHATSAPP_PHONE_NUMBER_ID)
  ) {
    throw new Error(
      "WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required when WHATSAPP_MODE is live",
    );
  }
  if (value.MAIL_MODE === "live" && !value.MAIL_WEBHOOK_SECRET) {
    throw new Error("MAIL_WEBHOOK_SECRET is required when MAIL_MODE is live");
  }
  if (value.CHECKOUT_ADAPTER_MODE === "http" && !value.CHECKOUT_ADAPTER_URL) {
    throw new Error("CHECKOUT_ADAPTER_URL is required when CHECKOUT_ADAPTER_MODE is http");
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
