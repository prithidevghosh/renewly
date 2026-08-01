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

// Same reasoning, and the same trap: a developer running with a live mail key
// must not have the suite send real email — or bill their Resend account — the
// moment they type `pnpm test`. Assignment, not `??=`: .env must lose here.
process.env.MAIL_OUTBOUND_MODE = "mock";
process.env.MAIL_OUTBOUND_API_KEY = "";
process.env.MAIL_FROM = "Renewly <test@renewly.test>";
