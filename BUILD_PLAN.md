# Renewly — Execution Blueprint

Three units of work. Each is independently shippable and independently testable.

1. **Pay link** — make the texted pay link work end to end without a session cookie
2. **Scheduler** — make the agent propose without being poked
3. **Duplicate detection** — a new decision rule

No seed data, no demo fixtures. Tests use the existing harness and factories.

**Build order is fixed:** Task 1 → Task 2 → Task 3. Task 2's acceptance test depends on nothing from Task 1, but Task 1 is the only one that is currently *broken* rather than *missing*.

---

## Preconditions

Verify before starting. Each blocks a different task.

| Requirement | Blocks | Check |
|---|---|---|
| `PRAVA_MODE=sandbox`, `PRAVA_SECRET_KEY=sk_test_…` | Task 1 manual verification | Key prefix is validated in `HttpPravaClient`'s constructor; a `sk_live_` key under sandbox throws `PRAVA_ERROR` at construction |
| `WORKER_ENABLED=true` | Task 2 | `env.ts:128` |
| Existing test suite green | All | `pnpm -C apps/api test` |

Automated tests for all three tasks run against the test doubles and need no live credentials.

---

## Task 1 — Pay link works without a session

### Problem

Two defects, both on the critical path of a payment:

1. **`GET /v1/approvals/:id/pay-bootstrap` and `POST /v1/approvals/:id/prava/complete` sit behind `requireAuth()`** (`approvals/routes.ts:24`). The pay token is checked *in addition to* the session, not instead of it. The link minted by `mintPayLink()` is opened on whatever device received the text, which has no session — so it 401s before the token is ever examined.

2. **There is no `/pay` route in the web app.** No `apps/web/src/app/pay` directory exists and nothing in `apps/web/src` references `pay-bootstrap`. The texted URL 404s.

### 1a. Backend — token-authenticated pay routes

**`apps/api/src/modules/approvals/service.ts`**

Add two functions:

```
getApprovalByIdUnscoped(id, db): Promise<ApprovalRequest>
```
Selects on `approvalRequests.id` only. Throws `notFound("Approval request")`. Needed because the caller has no workspace id yet.

```
authorizeByPayToken(approvalId, token, db): Promise<{ approval, auth }>
```
1. `getApprovalByIdUnscoped(approvalId)`
2. If `approval.payTokenHash` is null → throw `AppError("UNAUTHORIZED", "This approval has no pay link")`
3. If `!token || !verifyPayToken(approval, token)` → throw `AppError("UNAUTHORIZED", "Invalid or missing pay token")`
4. Load the workspace, then `resolveAuthContext(workspace.ownerUserId, approval.workspaceId, db)`

Step 4 is the mechanism: `resolveAuthContext` asserts `workspace.ownerUserId === user.id`, so passing the owner is the only value that satisfies it. `approvalRequests` carries no `userId` column — the workspace owner is the correct principal.

**Token is mandatory here.** The existing authed route treats it as optional when `payTokenHash` is null; the unauthenticated router must not.

**`apps/api/src/modules/approvals/routes.ts`**

Export a second router, `payLinkRoutes`, with **no `requireAuth`**:

- `GET /:id/pay-bootstrap` — same response body as the current authed handler
- `POST /:id/prava/complete` — same response body as the current authed handler

Both read `token` from the query string and call `authorizeByPayToken` first. Both keep `assertNotExpired`. `prava/complete` keeps the `forceDecline` + `isTest()` guard.

Leave the existing authed handlers in place — they are used by the dashboard and by `apps/api/e2e/message-pay-happy-path.test.ts`.

**`apps/api/src/app.ts`**

Mount `payLinkRoutes` at `/v1/approvals` **immediately before** line 98 (`app.route("/v1/approvals", approvalRoutes)`). Hono matches routers in registration order and falls through on no match, so the two token routes resolve first and every other approval path still reaches the authed router.

### 1b. Frontend — the pay page

**`apps/web/src/app/pay/[id]/page.tsx`**

1. Read `id` from route params, `token` from `searchParams`
2. `GET /v1/approvals/{id}/pay-bootstrap?token={token}` → `{ approvalId, sessionId, hostedUrl, amount, currency, merchantName, expiresAt }`
3. Render a summary card: merchant, amount, expiry
4. Mount `hostedUrl` in an `<iframe>`
5. On completion, `POST /v1/approvals/{id}/prava/complete?token={token}`
6. Render the result: amount, `cardBrand`, `cardLast4`, `receiptId`

**Error states to handle explicitly** — each maps to a distinct backend code:
- `UNAUTHORIZED` → "This link is not valid."
- `APPROVAL_EXPIRED` → "This link has expired."
- `INVALID_STATE_TRANSITION` → "This payment has already been completed." (also the correct render for an already-`proved` approval, which `executeApproval` returns with `executed: false` rather than throwing)

**Iframe embedding risk.** Prava's hosted page may set `X-Frame-Options` or a restrictive `frame-ancestors` CSP. Test this early. If it refuses to embed, open `hostedUrl` via `window.open` and leave a "I've completed payment" button on the page that calls `prava/complete`. Both paths are acceptable; the fallback is not a lesser implementation.

### Acceptance tests — `apps/api/e2e/pay-link.test.ts`

Use `createHarness`, `signUpWithChannel`, `createDecisionAndNotify`, `sendInbound`. Drive an approval to `awaiting_payment_auth` by sending an `APPROVE` inbound, exactly as `message-pay-happy-path.test.ts` does.

The pay token is not returned by any API — capture it from the `composeAuthLink` body of the outbound message (`lastOutbound`), parsing the `?token=` off the URL. **This also asserts the link is actually well-formed**, which nothing currently covers.

| # | Case | Expect |
|---|---|---|
| 1 | `GET pay-bootstrap?token={valid}` with **no auth header** | `200`, body carries `hostedUrl`, `amount`, `merchantName` |
| 2 | `GET pay-bootstrap` with no token | `401`, code `UNAUTHORIZED` |
| 3 | `GET pay-bootstrap?token=wrong` | `401`, code `UNAUTHORIZED` |
| 4 | `GET pay-bootstrap?token={valid}` for a **different workspace's** approval id | `401` or `404` — never another workspace's data |
| 5 | `POST prava/complete?token={valid}` unauthenticated | `200`, approval state `proved`, `transactionId` present |
| 6 | Case 5 repeated with the same token | `200`, `executed: false`, still exactly **one** transaction row |
| 7 | `POST prava/complete?token={valid}` after forcing expiry | `401`/`409` per `assertNotExpired`, approval **not** `proved` |
| 8 | `GET pay-bootstrap?token={valid}` on an approval in `awaiting_intent` (no session yet) | `409`, code `INVALID_STATE_TRANSITION` |

Case 6 is the important one — it proves the `once()` idempotency wrapper still holds on the unauthenticated path.

Case 4 is the security regression test. Write it first.

---

## Task 2 — Scheduler

### Problem

`notifyDecisionJob` is implemented and wired into `runJob`'s switch (`workers/runner.ts:245`). `enqueueJob` is implemented (`workers/queues.ts:25`) and supports `dedupeKey` and `runAt`.

**Nothing in the codebase calls `enqueueJob`.** Confirmed across `src`, `test`, and `e2e`. Both ends of the wire exist and are unconnected: no proposal is ever sent unless an HTTP request asks for one.

### Implementation

**`apps/api/src/modules/workers/sweep.ts`** (new)

```
sweepForProposals(db): Promise<{ scanned: number; queued: number }>
```

Per workspace:

1. Select active subscriptions where `nextRenewalAt` is non-null and within `RENEWAL_HORIZON_DAYS`
2. Resolve auth via `resolveAuthContext(workspace.ownerUserId, workspace.id, db)`
3. `generateDecisionPackage({ auth, subscription, regenerate: false, db })` — the `regenerate: false` path returns an existing live decision rather than rebuilding, so repeat sweeps are cheap
4. Skip when `decision.recommendation === "snooze"` — `createApproval` throws on snooze, and the job would fail every attempt
5. Skip when `findLiveApprovalForDecision(workspace.id, decision.id, db)` returns non-null — already proposed
6. `enqueueJob({ type: "notify_decision", payload: { decisionId, userId }, workspaceId, dedupeKey: \`notify:${decision.id}\` })`

**The `dedupeKey` is mandatory.** Without it every worker tick queues another job for the same decision and the user is texted on a loop. `enqueueJob` collapses on it (`queues.ts:29-31`).

**Failure isolation:** wrap each subscription in try/catch and log. One workspace with a broken decision must not stop the sweep.

**`apps/api/src/modules/workers/runner.ts`**

Call `sweepForProposals` from `runTick`, rate-limited by a module-level `lastSweepAt` timestamp against `SWEEP_INTERVAL_MS`. `runTick` fires every `WORKER_POLL_INTERVAL_MS` (default 2s) and the sweep runs the decision engine — it must not run every tick.

Add `proposalsQueued` to `TickResult`.

**`apps/api/src/env.ts`**

- `RENEWAL_HORIZON_DAYS` — int, default `7`
- `SWEEP_INTERVAL_MS` — int, default `300000` (5 min)

**`apps/api/src/modules/agent/routes.ts`**

`POST /v1/agent/sweep` (authed) → runs one `sweepForProposals` pass immediately, returns `{ scanned, queued }`. Needed for testing and operations; the loop must not be the only trigger.

### Acceptance tests — `apps/api/test/sweep.integration.test.ts`

| # | Case | Expect |
|---|---|---|
| 1 | Active sub renewing in 3 days, no approval | One `notify_decision` job queued |
| 2 | Run sweep twice in a row | Still exactly **one** job — dedupe holds |
| 3 | Sub renewing in 90 days | Nothing queued (outside horizon) |
| 4 | `nextRenewalAt` null | Nothing queued, no throw |
| 5 | Sub whose decision is `snooze` | Nothing queued |
| 6 | Sub with a live approval already | Nothing queued |
| 7 | Cancelled subscription in the window | Nothing queued |
| 8 | Sweep → `processJobs` → `drainOutbox` | Outbound proposal exists on the thread, approval state `awaiting_intent` |
| 9 | Two workspaces, one with a subscription that throws | Other workspace still queues |

Case 2 is the one that protects the user's phone. Case 8 is the end-to-end proof that the wire is connected.

---

## Task 3 — Duplicate detection rule

### Problem

No rule fires on "you pay for two tools that do the same job." A cheaper alternative is only proposed under budget pressure or when a tool is flagged experimental *and* expensive.

### What already exists

`generateDecisionPackage` **already loads every other active subscription and passes them to the engine as `peers`** (`decisions/service.ts:142-163`). `EngineInput.peers` is documented as *"used for budget and duplicate reasoning"* (`engine.ts:139`). `decide()` already imports `findCatalogTool`.

**This is a rule addition inside `decide()`. No plumbing, no schema change, no refactor.**

Note `peers` carry `merchantName` and `jobCategory`, not `category`. Resolve category through `findCatalogTool(peer.merchantName)?.category` for both subject and peers — the catalog is authoritative, `jobCategory` is nullable free text.

### Implementation — `apps/api/src/modules/decisions/engine.ts` only

**Rule placement:** inside the existing `if / else if` cascade in `decide()`, **after** the `staleUsage` and seat rules, **before** the `must_keep` branch. A tool that is unused should still be cancelled outright; a duplicate should outrank budget reasoning because it is the more specific finding.

**Condition:**
- `catalogTool` resolves for the subject
- At least one peer resolves to a catalog tool in the **same category**
- The subject's `doNothingAnnual` is **greater than** that peer's annual cost — only ever recommend dropping the more expensive of the pair, never both

**Output:**
- `recommendation = "switch_vendor"`
- `switchTarget` = the peer's catalog tool
- `recommendedAnnual = "0.00"` — the peer is already paid for, so the incremental cost of the recommended path is zero. Savings therefore equal the subject's full annual cost.
- `confidence = 0.8`
- reason: `"You already pay for {peer} in the same category. {Subject} is {annual} {currency} a year on top."`
- push `derived.duplicate_of={peer.id}` to `inputsUsed`

**Consistency requirement:** `switch_vendor` is in `PAYING_ACTIONS`, so this recommendation routes through Prava on approve. Verify `amountDueFor` produces a sane figure for this case — if a duplicate should not move money, the correct fix is to make this rule emit `cancel` instead. **Decide this explicitly rather than letting `amountDueFor` decide by accident.** Recommended: emit `cancel` — dropping a duplicate is a cancellation, the user does it in the vendor's UI, and it routes through the attested flow with no payment leg.

### Acceptance tests — extend `apps/api/src/modules/decisions/engine.test.ts`

| # | Case | Expect |
|---|---|---|
| 1 | Notion $20/mo + peer Coda $47/mo, both `docs` | Deciding on **Coda** → duplicate rule fires, target Notion |
| 2 | Same pair, deciding on **Notion** (cheaper) | Duplicate rule does **not** fire |
| 3 | Two subs in different categories | Does not fire |
| 4 | Peer not in the catalog | Does not fire, no throw |
| 5 | No peers | Does not fire, no throw |
| 6 | Duplicate pair where subject is unused 60+ days | `cancel` wins — rule ordering holds |
| 7 | Duplicate pair also over budget | Duplicate wins over the budget rule |
| 8 | Fired outcome | `savingsAnnual` equals subject's `doNothingAnnual` |
| 9 | Fired outcome | `inputsUsed` contains `derived.duplicate_of=…` |

Cases 6 and 7 pin the ordering. Case 2 prevents the pathological outcome of recommending both halves of a pair be dropped.

---

## Verification

```
pnpm -C apps/api test          # unit + integration
pnpm -C apps/api test:e2e      # e2e
pnpm -C apps/api typecheck
pnpm -C apps/web build
```

Confirm the exact script names in `apps/api/package.json` before relying on them.

### Definition of done

**Task 1**
- [ ] All 8 cases in `pay-link.test.ts` pass
- [ ] `/pay/{id}?token=…` renders in a browser with no session cookie
- [ ] Prava hosted page loads (embedded or via the documented fallback)
- [ ] Completing a payment moves the approval to `proved` and writes a receipt
- [ ] Existing `message-pay-happy-path.test.ts` and `idempotency-double-approve.test.ts` still pass

**Task 2**
- [ ] All 9 cases in `sweep.integration.test.ts` pass
- [ ] Worker running for 60s against a due subscription produces exactly **one** outbound message
- [ ] `POST /v1/agent/sweep` returns `{ scanned, queued }`

**Task 3**
- [ ] All 9 engine cases pass
- [ ] Full existing `engine.test.ts` still passes — the cascade was reordered, so regressions land here

### Regression watch

The riskiest edit is the rule ordering in `decide()`. `engine.test.ts` is 681 lines and encodes the current cascade. Run it after **every** change to that function, not just at the end.
