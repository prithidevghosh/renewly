# Renewly

**The agentic CFO for founders.** Renewly reads your billing mail, works out what each renewal is
worth, and texts you a proposal before it acts — then executes the payment and proves it in the
same thread.

```
gmail receipts  →  decision  →  text message  →  you reply  →  Prava  →  receipt in-thread
```

Live: **[renewly.live](https://renewly.live)** · API: **[api.renewly.live](https://api.renewly.live)**

---

## Why this exists

Most founders don't have a spending problem. They have an attention problem.

You pay for Notion. You also pay for Coda. They do the same job, and you noticed three weeks after
the renewal cleared. The information was always available — it was sitting in your inbox, in a
receipt you didn't read.

The category answer to this is a SaaS management platform: Torii, Zylo, Productiv. They plug into
your SSO and your expense feed and they render a very good dashboard of everything you pay for.
They work — if you employ someone whose job is to act on what the dashboard says. Torii will tell
you Coda renews Thursday. A human still has to go and cancel it.

A founder is not that human. So the dashboard becomes one more tab nobody opens, and the renewal
goes through anyway.

Renewly is built on the opposite bet: **the last mile isn't knowing, it's doing.** So it doesn't
render a dashboard and wait. It decides, it proposes on the channel you already read, and on a
one-word reply it acts — inside limits you set in advance.

> A mandate. Never a blank cheque.

---

## What it actually does

### 1. Detect — read the mail, cheaply

An agent run connects to Gmail read-only and pulls a lookback window (15, 30, 60 or 90 days).
A deterministic pass sorts receipts from everything else **before** the model sees anything — a
typical run reads 200 messages, keeps 4, and discards 196. The model never bills for reading Uber
receipts, and because a heuristic verdict costs nothing to produce, the transcript can narrate
every message and say *why* it was kept or dropped.

The SaaS gate is deliberately strict. Being wrong here is recoverable in one direction only: a
missed subscription is invisible, while a one-off purchase promoted to a recurring one puts a wrong
number in someone's budget.

### 2. Decide — a rules engine, not a prompt

Amounts, cycles and renewal dates are parsed, reconciled against the known subscription list, then
run through a deterministic engine that emits one of six recommendations:

| Recommendation | Fires when |
| --- | --- |
| `cancel` | Unused 30+ days, or budget pressure with no cheaper path |
| `rightsize_seats` | The invoice bills more seats than the workspace has people |
| `switch_vendor` | A peer subscription covers the same catalog category — duplicate spend |
| `switch_term` | Annual billing is materially cheaper than monthly |
| `renew` | Nothing better is available |
| `snooze` | Not enough evidence to act on |

Rules are strictly ordered — cancel beats rightsize beats switch beats term beats renew — so two
decisions can never contradict each other. Duplicate detection only ever fires on the *pricier*
half of a pair, which means a Notion/Coda pair can never end with you losing both tools.

Every decision pins the `policyVersion` it was judged under, so an approval executed later is
provably judged against the policy in force when it was made.

### 3. Propose — on a channel you actually read

A background sweep finds every active subscription renewing inside the horizon
(`RENEWAL_HORIZON_DAYS`, default 7), makes sure a decision exists, and queues the proposal. **Renewals are acted on because they are
due, not because an HTTP request happened to ask.** The sweep is safe to run repeatedly: it reuses
a live decision and a live approval rather than texting you hourly.

The proposal goes out over iMessage via [Linq](https://docs.linqapp.com). The whole thing is in the
message — what it wants to do, what it saves, what happens if you ignore it.

### 4. Execute — a link that works on the phone that got the text

Reply to approve. Paying actions open a payment through
[Prava](https://docs.prava.space) on a tokenised link.

That link opens on whatever device received the text, which holds no session — so the token in the
link *is* the credential, single-use, stored only as a hash. A leaked database row cannot be
replayed into a payment page.

### 5. Prove — in the same thread

Receipt, state transition and a savings ledger entry, all in the thread where the decision was
made. Every action is written to an audit log.

---

## Guardrails

An agent holding a card needs limits, and these are enforced server-side, not in the UI:

- **Spend ceiling** — any action above it waits for explicit approval
- **Monthly budget** — the envelope the engine reasons inside
- **Kill switch** — decisions still generate; paying is blocked
- **Quiet hours** — outbound is deferred, never dropped
- **Approval TTL** — an unanswered proposal expires rather than lingering as a live authorisation
- **Audit log + policy pinning** — every action, against the policy version it was judged under

Approval states are an explicit machine, not a boolean:

```
drafted → notified → awaiting_intent → awaiting_payment_auth → executing → proved
                                    ↘ failed · expired · cancelled_by_user
```

---

## Architecture

A pnpm + Turborepo monorepo.

```
apps/
  api/    Hono + Drizzle + Postgres — the agent, engine, workers and adapters
  web/    Next.js 15 App Router — control plane, onboarding, and the pay page
```

**API** — Hono, Drizzle ORM, Postgres (PGlite in dev and test, so a laptop needs no Docker), pino,
zod, ULIDs. Background work runs on a database-backed job queue with exponential backoff:
`notify_decision`, `send_outbound`, `poll_prava`, `expire_approvals`, `parse_inbound_email`.

**Web** — Next.js 15, React 19, Tailwind 4. A control plane and a ledger view. The pay page sits
outside the app shell because it must render without a session.

### One implementation per adapter

There are no mock adapters in shipped code. Every fake lives in `apps/api/src/test/doubles/` and is
installed by the suite through a registry override.

This was a deliberate correction. Adapters used to carry a `mock` mode reachable in any
environment, and it lied convincingly — the mock mailbox answered `authorizeUrl` by redirecting
straight back with `code=mock:gmail:demo@example.com`, so connecting an inbox appeared to succeed
and then served fixture receipts as the user's own mail, with nothing in the UI able to tell the
difference.

A feature without credentials is now switched off honestly: it answers `503 FEATURE_DISABLED`
rather than pretending, and every disabled integration is named in the startup log.

---

## Quick start

Requires Node 22+ and pnpm 11.

```bash
pnpm install
cd apps/api
cp .env.example .env          # defaults work as-is — PGlite, no Docker needed
pnpm run db:migrate
pnpm run dev                  # http://localhost:4000
```

In a second terminal:

```bash
cd apps/web
pnpm run dev                  # http://localhost:3000
```

The web app runs on **3000** and the API on **4000**. Both over plain `http` in development — the
API deliberately does not send HSTS outside production, because HSTS is remembered per host and
ignores the port, so one request to the dev API would otherwise force `https` on `localhost:3000`
where there is no certificate.

### Postgres instead of PGlite

```bash
cd apps/api
docker compose up -d          # publishes on 127.0.0.1:5433
# set DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/renewly
pnpm run db:migrate
```

`5433`, not `5432` — the conventional port is usually already taken by another project's container.

---

## Configuration

Every integration has a mode. `mock` is not a value any of them accepts.

| Variable | Values | Notes |
| --- | --- | --- |
| `OAUTH_MODE` | `live` · `disabled` | `live` needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` |
| `MAILBOX_MODE` | `live` · `disabled` | Gmail read-only |
| `LINQ_MODE` | `live` · `disabled` | `live` needs `LINQ_API_KEY` + `LINQ_FROM_NUMBER` |
| `PRAVA_MODE` | `sandbox` · `live` · `disabled` | Requires `PRAVA_SECRET_KEY` unless disabled |
| `MAIL_MODE` | `live` · `disabled` | Inbound mail; `live` needs `MAIL_WEBHOOK_SECRET` |
| `MAIL_OUTBOUND_MODE` | `live` · `disabled` | Transactional mail via Resend |
| `CHECKOUT_ADAPTER_MODE` | `http` · `disabled` | |

A mode claiming to be live without its credentials fails at boot, not at the first charge.

**Webhooks** are unauthenticated by necessity and verified by signature. Linq follows the
[Standard Webhooks](https://www.standardwebhooks.com/) spec — HMAC-SHA256 over
`{id}.{timestamp}.{body}` with a `whsec_`-prefixed secret, timestamps older than five minutes
rejected. Point Linq at `POST /v1/webhooks/linq`.

---

## Testing

```bash
cd apps/api
pnpm test                     # unit + integration — 672 tests
pnpm run test:e2e             # full journeys
pnpm run typecheck
```

Integration tests boot the real app against PGlite. E2E journeys drive complete flows — renewal
happy path, message-to-pay, inbound mail, Prava decline, and the token-only pay link with a client
carrying no bearer token at all, which also proves the texted link is well formed.

Production guard tests boot a real process, because the rule they cover is enforced while parsing
the environment; importing `env.ts` inside the suite would read the test environment and prove
nothing.

---

## Deployment

- **API** → Railway. Build `pnpm --filter @renewly/api build`, pre-deploy `db:migrate`, health
  check `/health`. Node is pinned to 22 via `RAILPACK_NODE_VERSION`.
- **Web** → Vercel. Needs `NEXT_PUBLIC_API_URL` pointing at the API origin.

Put the API on a **subdomain of the web app's domain** (`api.renewly.live` alongside
`renewly.live`). The session cookie is `SameSite=Lax`, so a cross-site API origin means the browser
will not send it on fetches and every request arrives unauthenticated.

---

## Project layout

```
apps/api/src/
  modules/
    agent/          mailbox sweep — classify, lookback, pipelines, runner
    decisions/      the rules engine and tool catalog
    approvals/      approval lifecycle, pay-link minting and token auth
    conversations/  threads, intent parsing, composed replies
    channels/       Linq adapter and webhook verification
    mailbox/        Gmail client and provider registry
    payments/       Prava execution and checkout adapters
    workers/        job queue, runner, renewal sweep
    settings/       mandate, ceilings, kill switch
  test/doubles/     every fake, reachable only from the suite
apps/web/src/
  app/(app)/        dashboard, agent, ledger, opportunities, radar, settings
  app/onboarding/   account → mailbox → mandate
  app/pay/[id]/     tokenised pay page, outside the app shell
```

---

## Known gaps

Stated plainly, because a README that only lists strengths is not much use:

- **No Settings screen for the messaging channel.** Onboarding collects a number, but there is no
  way to view or change it afterwards without an API call.
- **Gmail scope is restricted.** `gmail.readonly` requires Google verification plus a CASA security
  assessment before the unverified-app warning goes away for users outside the test list.
- **One channel.** iMessage via Linq. The WhatsApp adapter was removed rather than left as a stub
  that never worked.
- **Inbound mail is off** in the reference deployment; forwarding receipts to an inbound address is
  built but not enabled.

---

## License

Private. Built for the Prava hackathon.
