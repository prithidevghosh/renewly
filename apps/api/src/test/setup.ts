/**
 * Test environment. Set before any module reads `env`, because env.ts parses
 * process.env at import time.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "pglite://memory";
process.env.AUTH_SECRET ??= "test-auth-secret-that-is-definitely-long-enough-32";
process.env.PRAVA_MODE ??= "mock";
process.env.CHECKOUT_ADAPTER_MODE ??= "mock";
process.env.PRAVA_POLL_INTERVAL_MS ??= "0";
// Never let a stray key send test traffic to a real model. Blanked rather than
// deleted: env.ts loads .env after this file runs, and dotenv fills in any key
// that is absent — but not one that is already present and empty. env.ts reads
// "" as unset.
process.env.LLM_API_KEY = "";
process.env.MOCK_PRAVA_FAIL = "";
process.env.MOCK_PRAVA_RESULT = "";
