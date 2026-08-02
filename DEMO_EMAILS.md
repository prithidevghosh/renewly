# Demo emails

Four messages to send **from another account** to the Gmail you connect to Renewly.
Send each as a **separate plain-text email**. Copy the subject and body exactly —
every line in them is load-bearing.

Dates assume a demo on **2 August 2026**. If you demo on another day, shift the
`Next billing date` values so Anthropic and Coda stay **within 7 days** and
Notion and Figma stay **beyond 7 days but within 60**.

---

## Why the wording is not free-form

Each message has to clear four gates. Changing a line can silently drop a
subscription from the run.

| Gate | What it needs |
|---|---|
| Gmail search | one of `receipt` · `receipts` · `invoice` · `subscription` · `billing` anywhere |
| Classifier — is it a receipt | a currency amount **and** receipt-or-recurring wording |
| Classifier — is it a vendor | the vendor's domain or brand name in the text (see note below) |
| Parser | amount beside a context word, a cycle word, and a date after a cue phrase |

**Words that will kill a message.** The classifier treats these as "money did not
move" and drops the mail entirely: *refund, chargeback, failed, declined,
unsuccessful, free trial, trial ending, estimate, quote, reminder to pay,
**payment due**, cancelled your, has been cancelled*. Note `payment due` — write
`Next billing date` instead.

**On the sender.** Because all four arrive from one address, the classifier can't
use the sender to tell vendors apart. It reads the vendor from the body instead,
which is why every message below names its vendor's domain (`anthropic.com`,
`notion.so`, `coda.io`, `figma.com`). Keep those lines. Without them all four
receipts collapse into a single subscription.

---

## 1 · Anthropic — the one you pay

Renews inside the horizon, so the scheduler proposes it. Recommendation will be
**switch to annual**, which is a paying action, so this is the message that ends
in a Prava charge.

**Subject**

```
Anthropic — your subscription receipt
```

**Body**

```
Receipt from Anthropic (anthropic.com)

Plan: Claude Pro
Billing period: Monthly
Total charged: $20.00 USD

Next billing date: 2026-08-05

Thank you for your payment. This receipt is for your records.
Manage your subscription in billing settings.
```

Amount is $20.00 rather than something larger on purpose: it matches the Claude
Pro price in the catalog, so the annual saving the agent quotes is arithmetic
the numbers actually support. A $100 line here would make it quote a catalog
saving against a price the catalog has never seen.

---

## 2 · Coda — the duplicate that fires

The pricier half of the duplicate pair, so this is the one the rule fires on.
Renews inside the horizon, so it gets texted. Recommendation will be **cancel**,
which is attested — no money moves.

**Subject**

```
Coda — subscription receipt
```

**Body**

```
Receipt from Coda (coda.io)

Plan: Team
Billing period: Monthly
Amount charged: $47.00 USD

Next billing date: 2026-08-06

Thanks for being a Coda subscriber.
```

The subject has to *start* with `Coda`. Coda is not in the parser's vendor list,
so the merchant name is taken from the first word of the subject.

---

## 3 · Notion — the duplicate's other half

The cheaper half. The rule never fires on it — it exists so Coda has something
to be a duplicate *of*. Renewal is deliberately outside the 7-day horizon so it
is detected but not texted.

**Subject**

```
Notion — invoice for your workspace
```

**Body**

```
Invoice from Notion (notion.so)

Plan: Plus
Billing period: Monthly
Amount billed: $20.00 USD

Next billing date: 2026-09-08

Your workspace subscription renewed successfully.
```

---

## 4 · Figma — volume

Makes the sweep look like a real inbox rather than a two-item fixture. Detected,
not texted.

**Subject**

```
Figma — your monthly receipt
```

**Body**

```
Receipt from Figma (figma.com)

Plan: Professional
Billing period: Monthly
Total charged: $45.00 USD

Next billing date: 2026-09-12

Payment received. Thanks for using Figma.
```

---

## Optional 5 · a message that should be ignored

Worth sending if you want to show the classifier refusing something. It has an
amount and the word *receipt*, and it is still dropped — Amazon is a marketplace
and the wording is a one-off order.

**Subject**

```
Your Amazon.in order receipt
```

**Body**

```
Order confirmation from amazon.in

Order total: $34.99 USD
Delivery expected Thursday.
```

On camera: *"It read this, decided it was a purchase rather than a subscription,
and set it aside. It says so in the transcript."*

---

## After sending

1. Wait for all messages to land in the connected inbox.
2. In the dashboard, pick a lookback of **15 days** or **1 month** — everything
   was sent today, so the narrow window is faster and reads better on camera.
3. **Begin a sweep.**

### What you should see

| Merchant | Detected as | Then |
|---|---|---|
| Anthropic | $20.00/mo, renews 5 Aug | proposed → switch to annual → **APPROVE → Prava** |
| Coda | $47.00/mo, renews 6 Aug | proposed → cancel, "you already pay for Notion" |
| Notion | $20.00/mo, renews 8 Sep | detected only |
| Figma | $45.00/mo, renews 12 Sep | detected only |
| Amazon | — | set aside, with a reason |

Two proposals, so two texts. Notion and Figma sit outside the renewal horizon on
purpose — a demo where every subscription texts you at once is noise.

### If something doesn't appear

- **Nothing at all** — the Gmail query needs one of the five keywords. Every body
  above has one; check the mail didn't arrive as HTML-only with the text mangled.
- **All four merged into one subscription** — the vendor domain lines were
  dropped from the bodies. That is exactly the case they prevent.
- **Detected but not texted** — its renewal date is outside 7 days, or the worker
  isn't running (`WORKER_ENABLED=true`). `POST /v1/agent/sweep` forces a pass.
- **Anthropic says the details need confirming** — the parser scored a field
  under 0.7. Confirm it in the dashboard and the pay flow proceeds; it's one
  click and it's honest behaviour to show.
- **Coda came out named something else** — its subject didn't start with `Coda`.

---

## One thing to know before you record

Nothing here re-reads incrementally. Every sweep re-fetches the whole window, so
running it three times in rehearsal costs three full reads. That's fine at this
size — just don't be surprised by repeated `renewal_events` rows, which are
written once per parse and never deduplicated.
