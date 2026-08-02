/**
 * Test environment. Set before any module reads `env`, because env.ts parses
 * process.env at import time.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "pglite://memory";
process.env.AUTH_SECRET ??= "test-auth-secret-that-is-definitely-long-enough-32";
process.env.PRAVA_POLL_INTERVAL_MS ??= "0";

/*
 * Every integration is switched off, and the harness installs doubles instead.
 *
 * There is no longer a `mock` mode to select here: the application contains no
 * mock adapter, so a test that needs one constructs it from src/test/doubles
 * and injects it (see helpers.ts). Leaving these `disabled` means anything the
 * harness forgot to double raises FEATURE_DISABLED rather than quietly
 * reaching a real service.
 *
 * Assignment, not `??=`: env.ts loads .env after this file runs, so a developer
 * whose .env is pointed at live credentials must not have the suite send real
 * mail, charge a real card, or bill their Resend account on `pnpm test`.
 */
/*
 * Social sign-in is configured as live, with credentials that are obviously not
 * real, because the doubles plug in below the mode rather than beside it: the
 * redirect flow gets a client injected through setOAuthClient, and the One Tap
 * flow gets a local key set through setGoogleKeySet and then does its genuine
 * signature, issuer, audience and expiry checks. Marking it `disabled` here
 * would switch the feature off before either seam was reached, and testing it
 * through a mode that skips verification is what this change exists to remove.
 */
process.env.OAUTH_MODE = "live";
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.MAILBOX_MODE = "disabled";
process.env.PRAVA_MODE = "disabled";
process.env.CHECKOUT_ADAPTER_MODE = "disabled";
process.env.LINQ_MODE = "disabled";
process.env.MAIL_MODE = "disabled";
process.env.MAIL_OUTBOUND_MODE = "disabled";

// Never let a stray key send test traffic to a real model. Blanked rather than
// deleted: dotenv fills in any key that is absent — but not one that is already
// present and empty. env.ts reads "" as unset.
process.env.LLM_API_KEY = "";
process.env.MAIL_OUTBOUND_API_KEY = "";
process.env.MAIL_FROM = "Renewly <test@renewly.test>";
process.env.WAITLIST_NOTIFY_TO = "waitlist-notify@renewly.test";
process.env.CONTACT_NOTIFY_TO = "contact-notify@renewly.test";
