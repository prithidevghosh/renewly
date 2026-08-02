# Renewly API — frontend integration guide

Everything the web app needs to talk to the backend: auth, the agent terminal, and the
subscription → decision → approval → payment loop behind it.

> **Read this first.** Sections are marked **[LIVE]** or **[PLANNED]**.
> **[LIVE]** exists today and is covered by tests — build against it now.
> **[PLANNED]** is designed and the contract is settled, but the endpoint does not exist yet;
> calling it returns 404. Stub those and swap when they land.
>
> Nothing in this document is aspirational about **[LIVE]** endpoints. If it says an endpoint
> behaves a certain way, there is a test asserting it.

---

## 1. Conventions

**Base URL** `http://localhost:4000` in dev. All application routes are under `/v1`.

**Money is always a decimal string** — `"20.00"`, never a number. Floats lose cents, and the backend
does all arithmetic in integer minor units. Send strings, render strings, never `parseFloat` for
anything but display.

**Timestamps** are ISO-8601 UTC strings. **Ids** are prefixed ULIDs (`sub_01J...`, `ags_01J...`) and
sort lexicographically by creation time — so `a.id > b.id` means `a` is newer.

**Pagination** is cursor-based:

```http
GET /v1/subscriptions?limit=50&cursor=sub_01J...
→ { "subscriptions": [...], "nextCursor": "sub_01J..." | null }
```

`nextCursor: null` means the end. Pass it back as `?cursor=` for the next page.

**Rate limits** — 600 req/min globally per IP; `/v1/auth/*` has a tighter 10/min window.
A `429` carries `RATE_LIMITED`.

### Error envelope

Every failure has the same shape:

```json
{ "error": { "code": "CONFIRMATION_REQUIRED", "message": "Confirm the parsed renewal details before paying", "details": { "subscriptionId": "sub_01J...", "fields": ["next_renewal_at"] } } }
```

**Switch on `code`, never on `message`** — messages are for humans and will be reworded.

| Code | HTTP | What the UI should do |
|---|---|---|
| `UNAUTHORIZED` | 401 | Bounce to login |
| `FORBIDDEN` | 403 | Show "no access" |
| `EMAIL_NOT_VERIFIED` | 403 | Send to the verify screen, **not** to login — the session is fine, the code is in their inbox |
| `NOT_FOUND` | 404 | Also returned for another workspace's resources — existence is itself information |
| `VALIDATION_ERROR` | 400 | Show field errors from `details` |
| `CONFLICT` | 409 | Usually a double-submit; refresh and re-read |
| `KILL_SWITCH_ENABLED` | 409 | Agent spend is off. Link to settings |
| `CONFIRMATION_REQUIRED` | 409 | Parsed fields need confirming; `details.fields` lists them |
| `APPROVAL_REQUIRED` | 409 | Policy needs an explicit human approval |
| `INVALID_DECISION_STATE` | 409 | Decision is stale, superseded, or the price moved — regenerate it |
| `APPROVAL_EXPIRED` | 409 | The approval window closed |
| `INVALID_STATE_TRANSITION` | 409 | The action does not apply in the current state |
| `PRAVA_ERROR` | 502 | Payment rail problem. Retryable |
| `CHECKOUT_DECLINED` | 402 | Card declined. **Nothing was charged** — say so |
| `CHANNEL_NOT_CONNECTED` | 409 | No messaging channel; prompt to connect |
| `RATE_LIMITED` | 429 | Back off |
| `INTERNAL_ERROR` | 500 | Generic failure |

---

## 1a. Modes: real, off, or fake

Every integration has a mode, and the client should read `/v1/auth/config` rather than assume.

| Mode | Meaning |
|---|---|
| `live` | Talks to the real provider |
| `disabled` | The feature is off. Endpoints return `400 VALIDATION_ERROR` saying so — **hide the button** |
| `mock` | Fake responses for local development and tests |

**Production refuses to boot on `mock`.** `OAUTH_MODE` and `MAILBOX_MODE` have no opt-out at all,
because mock auth accepts any identity without a credential and a mock mailbox serves fixture data
as if it were the user's own mail. Payments and messaging may run mocked in a deliberate demo
deployment, but only with `ALLOW_MOCK_INTEGRATIONS=true` set explicitly.

The practical consequence for the frontend: a deployment may legitimately have **no** Google button
and **no** mailbox step. `/v1/auth/config` tells you which are usable; render from that, never from
a hardcoded assumption.

---

## 2. Auth

### 2.1 Password signup and verification **[LIVE]**

```http
POST /v1/auth/signup
{ "email": "ada@example.com", "password": "min8chars", "name": "Ada", "workspaceName": "Northwind" }

→ 201 {
  "user": { "id", "email", "name", "emailVerified": false, "avatarUrl": null, "createdAt" },
  "workspaceId": "wsp_01J...", "token": "<jwt>", "expiresAt": "...",
  "verificationRequired": true,
  "verificationCode": "048042"   // mock mail mode ONLY — always null in production
}
```

**The account is created unverified and reaches almost nothing until the emailed code is entered.**
A token is still issued so the "check your email" screen has a session to work with, but every
protected route answers `403 EMAIL_NOT_VERIFIED` until verification completes.

```http
POST /v1/auth/verify       { "email", "code": "048042" }  → 200 { user, alreadyVerified }
POST /v1/auth/resend-code  { "email" }                    → 200 { ok, retryAfterSeconds }
POST /v1/auth/login        { "email", "password" }        → 200, same shape as signup
POST /v1/auth/logout                                      → 200 { "ok": true }
GET  /v1/me                                               → 200 { user, workspace, settings }
```

Behaviour worth building around:

- **No new token after verifying.** The gate reads `emailVerifiedAt` from the database on every
  request, so the token the client already holds starts working the moment `/verify` returns.
  Do not force a re-login.
- **`/verify` is idempotent.** A second call returns `200` with `alreadyVerified: true`.
- **Wrong codes are counted.** Five failures and even the correct code returns `429 RATE_LIMITED` —
  the user has to request a new one. `details.attemptsRemaining` tells you how many are left.
- **Codes expire** (15 min default) and **asking for a new one kills the old one**.
- **`/resend-code` is throttled** (60s) and returns the same `200 { ok: true }` whether or not the
  address exists — it must not become an account-enumeration oracle. Never render it as
  "no such account".
- **`verificationCode` in the signup response is a local-development affordance.** It is populated
  only when `MAIL_OUTBOUND_MODE=mock`. In production it is `null` and the code only exists in the
  user's inbox. Do not build a flow that depends on it.

`409 CONFLICT` on a duplicate email. Login returns `401` for both "no such user" and "wrong
password", deliberately and in constant time — do not try to distinguish them in the UI. An account
created through Google or Microsoft has no password, and login against it also returns `401`.

Signing up also creates the workspace, the owner membership, and default settings in one call —
there is no separate "create workspace" step.

#### Which routes work while unverified

Only these three. Everything else is `403 EMAIL_NOT_VERIFIED`:

| Route | Why |
|---|---|
| `GET /v1/me` | So the wait screen can poll `user.emailVerified` |
| `POST /v1/auth/resend-code` | So the user can ask for another code |
| `POST /v1/auth/logout` | So they can back out |

### 2.2 Google One Tap / popup **[LIVE]** — the path with credentials today

Google Identity Services. The browser gets an **ID token** straight from Google and posts it here;
the backend verifies its signature against Google's public keys. **No client secret, and no
redirect URI to register** — which is why this is the flow that works right now with the client id
already in `.env`.

```http
GET  /v1/auth/config                → { googleClientId, providers, oauthMode }
POST /v1/auth/google/id-token       { "credential": "<ID token from GIS>" }
                                    → 200 { user, workspaceId, token, expiresAt }
```

Call `/v1/auth/config` first — it tells you the client id and which buttons to draw:

```jsonc
{
  "googleClientId": "4101931…apps.googleusercontent.com",
  "providers": {
    "password": true,
    "googleOneTap": true,        // needs only a client id
    "googleRedirect": true,      // needs a client secret too
    "microsoftRedirect": true
  },
  "oauthMode": "mock"
}
```

Frontend, using the GIS script (`https://accounts.google.com/gsi/client`):

```ts
const { googleClientId } = await fetch(`${API}/v1/auth/config`).then((r) => r.json());

window.google.accounts.id.initialize({
  client_id: googleClientId,
  ux_mode: "popup",
  callback: async (resp) => {
    const res = await fetch(`${API}/v1/auth/google/id-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ credential: resp.credential }),
    });
    const { token } = await res.json();   // also set as the session cookie
  },
});
window.google.accounts.id.renderButton(el, { theme: "outline", size: "large" });
```

Accounts created this way are **verified immediately** and skip the code entirely. Sign-in through
this flow and the redirect flow below resolve to the **same account** for the same Google subject —
they are two doors to one identity, not two accounts.

In `OAUTH_MODE=mock` the credential is `mock:<subject>:<email>`, so the whole flow is testable with
`curl` and no Google involvement. **Mock is a local and test mode only — production refuses to
boot with it**, because it authenticates any identity without a credential.

### 2.3 Google and Microsoft sign-in **[LIVE]**

```http
GET /v1/auth/oauth/google/start?redirectTo=/dashboard      → 302 to Google
GET /v1/auth/oauth/microsoft/start?redirectTo=/dashboard   → 302 to Microsoft
GET /v1/auth/oauth/:provider/callback                      → 302 back to APP_URL + redirectTo
```

**This flow needs a client *secret* and a registered redirect URI**, which One Tap above does not.
`providers.googleRedirect` / `providers.microsoftRedirect` in `/v1/auth/config` tell you whether it
is actually usable, so hide the buttons when they are false.

**This is a browser redirect, not an API call.** Point a link or `window.location` at `/start`; do
not fetch it. The callback sets the `renewly_session` cookie and redirects to
`APP_URL + redirectTo`, so the app is already signed in when it loads.

- `redirectTo` must be a **same-origin path** beginning with `/`. Anything else is silently replaced
  with `/`, so it cannot be used as an open redirect.
- **Cancelling at the provider is not an error.** The callback redirects to
  `APP_URL/login?error=access_denied`. Handle that query parameter.
- **OAuth accounts are verified immediately** — the provider already proved the address, so no code
  is sent and no gate applies.
- **An unknown provider is `404`.** Only `google` and `microsoft` exist.

#### Account linking — what the frontend should expect

Signing in with a provider whose email matches an existing account **links to that account** rather
than creating a second one. The user keeps their workspace, their subscriptions and their history.
A user can therefore hold `password` + `google` + `microsoft` identities simultaneously, and any of
them lands in the same place.

One deliberate refusal: if the provider will not vouch for the address (`email_verified: false`),
linking is rejected with `401` rather than performed. Otherwise anyone able to obtain a provider
token for an address could take over an account they never owned.

Linking also **settles verification** — an unverified password account becomes verified the moment
its owner signs in with a provider that has confirmed the address.

#### Local development

`OAUTH_MODE=mock` (the local default) needs no Google or Microsoft credentials. `/start` redirects
straight to the callback with a synthetic code of the form `mock:<subject>:<email>`, so the whole
flow — including linking — is exercisable locally. Set `OAUTH_MODE=live` plus
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and/or `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`
for the real thing.

### 2.4 Sessions

The token comes back **two ways** and either works:

- `Authorization: Bearer <jwt>` — use this for normal API calls
- `renewly_session` cookie — `httpOnly`, `sameSite=Lax`, set automatically by signup/login

The cookie matters for the SSE stream (see §3.3), because `EventSource` cannot set headers.
For cross-origin dev, send `credentials: "include"` and make sure your origin is in `CORS_ORIGINS`.

The JWT carries the workspace id. **A token is scoped to one workspace** — there is no
workspace-switching header.

### 2.5 What is still missing

No password reset and no change-password endpoint yet. An account that signs up with a password and
forgets it currently has no self-service recovery — worth knowing before you ship a "forgot
password?" link that goes nowhere.

---

## 3. The agent terminal **[LIVE]**

After auth the user lands on a terminal. Everything it renders is an event from an append-only log.

### 3.1 Model

```
agent_sessions   one run          (status, currentStep)
agent_events     the transcript   (seq, type, step, payload)   ← append-only, gap-free seq
agent_prompts    blocking asks    (promptKey, options, answer)
```

The agent never writes to a connection; it writes rows and the stream tails them. Every event has a
**gap-free `seq` scoped to its session**, so a client holding `41` knows the next thing it needs is
`42`. That gives you free refresh-recovery, multi-tab, and survival across a backend restart.

### 3.2 Endpoints

```http
POST /v1/agent/sessions                  { "kind": "onboarding" }  → 201 { session }
GET  /v1/agent/sessions/latest           → { session | null, openPrompts[] }
GET  /v1/agent/sessions/:id              → { session, openPrompts[] }
GET  /v1/agent/sessions/:id/events?after=41&limit=200   → { session, events[] }
GET  /v1/agent/sessions/:id/stream?after=41             → SSE
POST /v1/agent/sessions/:id/input        { "promptKey"?, "answer" }
POST /v1/agent/sessions/:id/cancel
```

`kind` is `onboarding | detect | decide | monthly_sweep`.

**On boot, call `/sessions/latest`.** `session: null` → show your empty state and offer to start one.
Otherwise reattach: replay events from 0, then stream.

Session `status` drives the whole UI:

| Status | UI |
|---|---|
| `running` | Spinner on `currentStep` |
| `awaiting_input` | **Blocked on the user.** Render the open prompt, focus the input |
| `completed` | Done — stream sends `stream.close` and ends |
| `failed` | `error` holds the message |
| `cancelled` | User stopped it |

### 3.3 The SSE stream

```http
GET /v1/agent/sessions/ags_01J.../stream?after=41
Accept: text/event-stream
```

**The SSE `id` is the sequence number**, deliberately — the browser's native reconnect then resumes
correctly with no code from you.

```
event: step.progress
id: 42
data: {"seq":42,"type":"step.progress","step":"classify","payload":{"message":"Parsing 214 receipts","current":87,"total":214},"at":"2026-08-02T09:14:22.031Z"}
```

**Resuming**, in precedence order: `?after=<seq>` → `Last-Event-ID` header (sent automatically by
`EventSource`) → neither, which replays from the start.

First frame is always `stream.open`:

```json
{ "sessionId": "ags_01J...", "resumedFrom": 41, "status": "running" }
```

Compare `resumedFrom` to your cursor. Lower than expected → you will get duplicates (dedupe on
`seq`). Higher → there is a gap; do not render the transcript as if it were whole.

`stream.close` is sent when the session is finished **and drained**, so a fast run never loses its
own completion event. `reason` is `completed | failed | cancelled | timeout`.

Streams are capped at **30 minutes** — reconnect with `?after=lastSeq` and you lose nothing. A
session parked in `awaiting_input` stays parked indefinitely; only the socket is bounded.
Heartbeats are `: keep-alive` comment frames every 15s; ignore lines starting with `:`.

**Auth on the stream:** `EventSource` cannot set an `Authorization` header. Either use the session
cookie with `withCredentials: true` (and get automatic reconnect free), or use `fetch` +
`ReadableStream` and own reconnection. There is deliberately no `?token=` fallback — tokens end up
in access logs.

### 3.4 Event types

**A client that meets an unknown `type` must ignore it, not throw.** New steps will add types
without a version bump.

| Type | Payload |
|---|---|
| `session.started` | `{ kind, sessionId }` — always `seq: 1` |
| `step.started` | `{ label }` — render as a heading |
| `step.progress` | `{ message, current?, total? }` — progress bar when `total` present |
| `step.completed` | step-specific summary, e.g. `{ found: 214 }` |
| `log` | `{ message, level: "info" \| "warn" \| "error" }` |
| `finding` | `{ kind, subjectIds, impactAnnual, ... }` |
| `prompt` | `{ promptKey, question, options[], freeText, skippable }` |
| `prompt.answered` | `{ promptKey, answer, skipped }` |
| `proposal.sent` | `{ channel, approvalId }` — same proposal also went to iMessage |
| `session.completed` | run summary |
| `session.failed` | `{ message, code }` |
| `error` | `{ message, code }` — recoverable, run continues |

Every event also carries a nullable `step`, so you can group the transcript into collapsible
sections.

### 3.5 Prompts

The agent parks in `awaiting_input` until answered.

```json
{ "promptKey": "cap:coding", "question": "What's your monthly cap for coding tools?",
  "options": [], "freeText": true, "skippable": true }
```

```http
POST /v1/agent/sessions/:id/input
{ "promptKey": "cap:coding", "answer": "200" }
```

Rules the server enforces so you don't have to:

- **`promptKey` is optional when exactly one question is open.** With several open it is required —
  the server refuses to guess rather than answering the wrong one (`400`).
- **Closed option sets are enforced.** Non-empty `options` + `freeText: false` → the answer must be
  one of the `value`s, else `400`.
- **`skippable`** accepts the literal answer `"skip"`. On a non-skippable prompt that is a `400`.
- **Answering twice is a `409`.** First answer wins; a double-tap cannot overwrite.
- **Several prompts can be open.** The session returns to `running` only when the last is answered.
- A resumed step re-raising the same key returns the existing question — the user never sees it twice.

Decision proposals arrive as prompts with options:

```json
{ "promptKey": "overlap:figma-penpot",
  "question": "Figma and Penpot do the same job. Penpot is free. Cancel Figma?",
  "options": [ { "value": "cancel", "label": "Cancel Figma", "description": "Saves $180/yr" },
               { "value": "keep",   "label": "Keep both" } ],
  "freeText": false, "skippable": false }
```

**The same proposal also goes to iMessage.** Either surface can answer it; whichever lands first
wins, and the other sees a `409`. Handle that gracefully — it means the user replied on their phone.

### 3.6 Worked client

```ts
type AgentEvent = { seq: number; type: string; step: string | null;
                    payload: Record<string, unknown>; at: string };

async function tail(sessionId: string, token: string,
                    onEvent: (e: AgentEvent) => void, from = 0): Promise<void> {
  let cursor = from;

  for (;;) {                                  // reconnect forever; cursor prevents loss
    try {
      const res = await fetch(
        `${API}/v1/agent/sessions/${sessionId}/stream?after=${cursor}`,
        { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } },
      );
      if (res.status === 404) return;

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";           // keep the partial tail

        for (const block of blocks) {
          let name: string | null = null, data: string | null = null;
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;              // heartbeat
            if (line.startsWith("event:")) name = line.slice(6).trim();
            if (line.startsWith("data:"))  data = line.slice(5).trim();
          }
          if (!name || !data) continue;
          if (name === "stream.close") return;
          if (name === "stream.open") continue;

          const event = JSON.parse(data) as AgentEvent;
          cursor = event.seq;                  // advance before render, so a throw can't rewind
          onEvent(event);
        }
      }
    } catch { /* network blip — fall through and resume from cursor */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

---

## 4. Mailbox connection **[LIVE]**

Replaces "paste an email". Gmail and Outlook read-only consent, asked for **after** login — never on
the sign-in screen.

```http
GET    /v1/mailbox                      → { connections: [...] }
GET    /v1/mailbox/connect/:provider    → 302 to consent   (provider = gmail | outlook)
GET    /v1/mailbox/callback/:provider   → 302 back to APP_URL + redirectTo
GET    /v1/mailbox/:id/receipts?months=3&limit=50
DELETE /v1/mailbox/:id                  → revoke
```

```jsonc
{
  "connections": [{
    "id": "mbx_01KZ...", "provider": "gmail",
    "emailAddress": "founder@gmail.com",     // ← render "Gmail connected as …"
    "status": "active",                      // pending | active | revoked | error
    "scopes": ["https://www.googleapis.com/auth/gmail.readonly", "email", "openid"],
    "lastSyncAt": null, "lastError": null
  }]
}
```

**`/connect` is a browser redirect, not a fetch.** It requires auth, so link to it from a signed-in
page (the session cookie carries through) rather than calling it with a bearer token from JS. The
callback returns to `APP_URL + redirectTo` with `?mailbox=connected&address=…`, or
`?mailbox_error=access_denied` if the user declined — **declining is a normal answer, not a failure**.

`redirectTo` must be a same-origin path starting with `/`; anything else is replaced with `/`.

### Status, and what the UI should do

| `status` | Meaning |
|---|---|
| `active` | Usable. Detect runs will read from it |
| `error` | Token refresh failed — **show "reconnect your mailbox"**, `lastError` says why |
| `revoked` | User disconnected it. Tokens are erased, not just flagged |

A detect run refuses to start without an `active` connection. Surface that as an empty state with a
connect button, not an error toast.

### `/receipts` — the preview endpoint

Returns what the detector *would* read, without running the pipeline. Use it to confirm a fresh
connection works, and to drive the terminal's "found X receipts" step:

```jsonc
{ "count": 5, "monthsBack": 3,
  "receipts": [{ "providerMessageId", "subject", "from", "receivedAt", "snippet" }] }
```

`months` defaults to 3 (capped at 12), `limit` to 50 (capped at 200). Bodies are deliberately not
returned — they can be large and are only needed server-side.

### Local development

`MAILBOX_MODE=mock` (the local default) serves the repository's own email fixtures — real renewal notices
from Anthropic, Figma and Midjourney — so the entire connect → fetch → detect flow is demoable with
no real inbox and no Google review. The consent redirect goes straight to the callback with a code
of the form `mock:<provider>:<address>`.

> **Two things to know before going live.**
>
> **Gmail read is a restricted scope.** Until Google verifies the app only ~100 allow-listed test
> users can connect; verification involves a security assessment measured in weeks.
>
> **One Tap sign-in cannot grant mailbox access.** An ID token proves identity and carries no API
> authority, so `MAILBOX_MODE=live` needs `GOOGLE_CLIENT_SECRET` and
> `http://localhost:4000/v1/mailbox/callback/gmail` registered as a redirect URI. A workspace can
> legitimately be signed in with Google and still have no mailbox — treat them as separate states.

---

## 5. Subscriptions **[LIVE]**

```http
GET    /v1/subscriptions?limit=50&cursor=      → { subscriptions[], nextCursor }
POST   /v1/subscriptions                       → 201 { subscription }
GET    /v1/subscriptions/:id
PATCH  /v1/subscriptions/:id
DELETE /v1/subscriptions/:id
POST   /v1/subscriptions/:id/confirm           → clears the confidence gate
POST   /v1/subscriptions/:id/decisions         { regenerate?, notify? } → 201
GET    /v1/subscriptions/:id/decisions
```

Key fields on the DTO:

```jsonc
{
  "id": "sub_01J...", "merchantName": "Anthropic", "planName": "Claude Pro",
  "amount": "20.00", "currency": "USD", "billingCycle": "monthly",
  "annualCost": "240.00",                 // precomputed — don't recalculate client-side
  "nextRenewalAt": "2026-08-12T12:00:00.000Z", "cancelByAt": null,
  "status": "active",                     // active | pending_cancel | cancelled | paused
  "criticality": "must_keep",             // must_keep | nice_to_have | experimental
  "fieldConfidence": { "amount": 0.9, "next_renewal_at": 0.55 },
  "lowConfidenceFields": ["next_renewal_at"],
  "requiresConfirmation": true,           // ← blocks payment until confirmed
  "priceChangeNote": "price increasing to $36.00 per month"
}
```

### The confidence gate

Any parsed field below **0.7** sets `requiresConfirmation: true` and `lowConfidenceFields`.
**Payment is refused with `CONFIRMATION_REQUIRED` until `POST /:id/confirm`.** Show the uncertain
fields, let the user correct them, then confirm. This is the single most common blocker in the flow —
build the UI for it early.

A re-parsed email whose **price changed** re-arms the gate automatically.

---

## 6. Decisions **[LIVE]**

```http
POST /v1/subscriptions/:id/decisions
{ "regenerate": true, "notify": true }

→ 201 { decision: {...}, approval: { id, state, threadId } | null, notified: boolean }
```

`notify: true` also sends the proposal to the connected messaging channel and returns an approval.
`regenerate: false` returns the existing live package instead of computing a new one.

The package:

```jsonc
{
  "recommendation": "switch_term",   // renew | cancel | rightsize_seats | switch_term | switch_vendor | snooze
  "confidence": 0.8,
  "headline": "Switch Anthropic to annual billing and save 36.00 USD a year",
  "narrative": "…",
  "diagnosis": "Billed monthly; the annual term is 36.00 USD a year cheaper for the same tier.",
  "counterfactuals": {
    "do_nothing":  { "annual_cost": "240.00", "summary": "…" },
    "recommended": { "annual_cost": "204.00", "savings_vs_do_nothing": "36.00", "summary": "…" }
  },
  "alternatives": [ { "name", "annual_cost", "pros": [], "cons": [], "switch_friction": "low" } ],
  "inputs_used": ["subscription.amount=20.00 USD", "policy.team_size=1"],
  "policy_flags": ["ABOVE_SPEND_CEILING"],
  "amount_due": "204.00",            // what a pay action moves — NOT the monthly price
  "seats_target": null, "term_target": "yearly", "vendor_target": null,
  "narrative_source": "deterministic" // or "llm"
}
```

Three things to get right in the UI:

- **`amount_due` ≠ the subscription's `amount`.** A term switch charges the annual figure. Show
  today's price from the subscription and the charge amount from the decision, labelled distinctly.
- **`diagnosis` is the one-line "why".** It is written to only claim things the engine actually knew —
  render it verbatim, don't paraphrase.
- **`inputs_used` is the audit trail.** Good "why did you decide this?" disclosure.

**Actions split two ways.** `renew`, `switch_term`, `switch_vendor` move money → Prava (§7).
`cancel` and `rightsize_seats` are performed by the user and then attested (§8). `snooze` does
nothing and is never messaged.

---

## 7. Approvals and payment **[LIVE]**

### State machine

```
drafted → notified → awaiting_intent → awaiting_payment_auth → executing → proved
                                                                        ↘ failed
any non-terminal → expired | cancelled_by_user
```

`executing` **cannot** be cancelled — money is in flight. Attested actions skip
`awaiting_payment_auth` and go straight to `executing`.

```http
GET  /v1/approvals                         → { approvals[], nextCursor }
GET  /v1/approvals/:id
POST /v1/approvals/:id/intent              { "intent": "APPROVE" | "KEEP" | "LATER" | "WHY" }
POST /v1/approvals/:id/notify
GET  /v1/approvals/:id/pay-bootstrap?token=…
POST /v1/approvals/:id/prava/complete
```

### The pay page

1. User approves (in the terminal, or by replying on iMessage).
2. Backend opens a Prava session and mints a **single-use pay link**:
   `${APP_URL}/pay/:approvalId?token=…`. Only the token's hash is stored.
3. Your `/pay/:approvalId` page reads `?token=` and calls:

```http
GET /v1/approvals/:id/pay-bootstrap?token=<token>
→ { sessionId, hostedUrl, amount, currency, merchantName, publishableKey }
```

**`401` without the token** — the bearer session alone is not enough. Mount the Prava iframe from
`hostedUrl` / `publishableKey`.

4. User completes **passkey + card inside Prava**. Card details never touch Renewly.
5. Call `POST /v1/approvals/:id/prava/complete`:

```json
{ "approval": { "state": "proved" }, "transactionId": "txn_01J...",
  "receiptId": "rct_01J...", "executed": true }
```

`executed: false` means a previous call already completed it — **not an error**. The whole pipeline
is idempotent on `(approvalId, paymentSessionId)`, so a double-tap, a retried webhook and the poller
all converge on one charge. Treat `executed: false` as success.

On `CHECKOUT_DECLINED`, **lead with "nothing was charged"** — it is the user's first question, and
it is true.

---

## 8. Attested actions — cancel and rightsize **[LIVE]**

There is no universal cancellation API and the product does not pretend otherwise.

```http
POST /v1/approvals/:id/cancel/start    → { checklist[], portalUrl, status: "pending_cancel" }
POST /v1/approvals/:id/cancel/confirm  → { savingsEntryId, amountSaved, actionType }
```

`cancel/start` returns steps and a vendor portal link and moves the subscription to
`pending_cancel`. Nothing is counted as saved until the user confirms they did it. Copy should say
so plainly — "I can't do this one for you, there's no API" — rather than implying automation.

---

## 9. Settings and policy **[LIVE]**

```http
GET   /v1/settings
PATCH /v1/settings
POST  /v1/settings/kill-switch   { "enabled": true }
POST  /v1/settings/simulate      { "approvalMode"?, "spendCeiling"?, "killSwitch"? }
```

```jsonc
{
  "approvalMode": "always_ask",     // always_ask | ask_above_ceiling | auto_within_envelope
  "spendCeiling": "50.00",          // per-action ceiling, nullable
  "aiMonthlyBudget": "200.00",
  "categoryCeilings": { "ai": "80.00" },
  "teamSize": 1,                    // seats the workspace needs; drives the seat rule
  "killSwitch": false,
  "quietHours": { "start": "22:00", "end": "08:00", "tz": "UTC" },
  "primaryChannel": "simulator",    // imessage | whatsapp | simulator
  "policyVersion": 3,
  "currency": "USD"
}
```

**Every PATCH bumps `policyVersion`**, which invalidates decisions pinned to the old one. After
changing policy, expect open decisions to need regenerating.

`POST /settings/simulate` answers *"what would change if I loosened this?"* against open decisions
without executing anything — returns `{ counts: { auto, ask, blocked }, decisions[] }`. Good for a
policy-preview panel.

---

## 10. Channels **[LIVE]**

```http
GET    /v1/channels
POST   /v1/channels/connect   { "channel": "simulator", "externalId": "+15550100777" }
DELETE /v1/channels/:id
```

`channel` is `imessage | whatsapp | simulator`. **Connecting is unverified today** — the handle is
whatever the authenticated user types, with no OTP. Treat it as a setting, not a proven identity.

### Simulator — build and demo without a phone

```http
GET  /v1/channels/simulator/messages              → every message in the workspace
GET  /v1/channels/simulator/threads/:id/messages
POST /v1/webhooks/simulator                       → inject an inbound reply
```

This is how the e2e suite drives the whole loop. Use it for local development and demos: connect the
`simulator` channel, read what the agent "sent", and post replies back.

---

## 11. Ledger, receipts, audit **[LIVE]**

```http
GET /v1/savings/summary   → { identifiedTotal, realizedTotal, byActionType, ignoredCurrencies }
GET /v1/savings?recognition=identified|realized
GET /v1/receipts/:id      → { receipt, transaction }
GET /v1/audit?type=payment.succeeded
```

**Never sum `identifiedTotal` and `realizedTotal`.** Identified is what the agent *claims* is
available; realized is what was actually banked. Realizing a saving retires its identified estimate.
Display them as two separate numbers with distinct labels — merging them is how savings dashboards
start lying.

---

## 12. Dev helpers

```http
GET /health            → { ok, version, env }
GET /v1/demo/status    → which integrations are in mock vs live mode
```

`/v1/demo/status` returns booleans and modes only, never key values:

```jsonc
{ "llmConfigured": false, "pravaMode": "mock", "pravaConfigured": true,
  "linqMode": "mock", "mailOutboundMode": "mock", "workerEnabled": true, "env": "development" }
```

Useful for a dev banner — "running on mock rails" is worth showing so nobody demos a mock payment
believing it was real.

---

## 13. Realtime vs polling

| Data | How |
|---|---|
| Agent transcript | **SSE** — `/v1/agent/sessions/:id/stream` |
| Everything else | **Polling.** No websockets, no push |

After a mutation, re-read the affected resource. The agent stream is the only live channel; if you
need a subscription list to update during a detect run, poll it on `step.completed` events rather
than adding a second stream.

---

## 14. Build order suggestion

1. **Auth + `/v1/me`** — password + verify screen, plus Google and Microsoft buttons (all live)
2. **The terminal** — `/sessions/latest`, replay via `/events`, then the SSE tail, then prompts.
   This is the whole product surface; get it right before anything else
3. **Subscription list + the confirmation gate** — the most common blocker in the loop
4. **Decision detail + approve** — counterfactuals and `diagnosis`
5. **The `/pay/:approvalId` page** — bootstrap, Prava iframe, complete
6. **Settings, savings, audit**

Every endpoint in this document is **[LIVE]** and covered by tests. The detect, decision and
proposal pipeline that consumes §4 is the next thing being built; it will surface through the agent
terminal in §3 with no new endpoints.
