import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentHash, rawContentHash } from "../src/lib/crypto.js";
import { idempotencyKeyFor, once } from "../src/lib/idempotency.js";
import {
  learnAlias,
  resolveCancelUrl,
  resolveMerchant,
  resolveOrCreateMerchant,
} from "../src/modules/merchants/service.js";
import { signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

let harness: TestHarness;
let client: ApiClient;
let workspaceId: string;

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  const user = await signUp(client);
  workspaceId = user.workspaceId;
});

afterAll(async () => {
  await harness.close();
});

describe("merchant resolution", () => {
  it("resolves an exact canonical name", async () => {
    const merchant = await resolveMerchant(workspaceId, "Anthropic", harness.handle.db);
    expect(merchant?.canonicalName).toBe("Anthropic");
  });

  it("resolves a statement descriptor through its aliases", async () => {
    const merchant = await resolveMerchant(
      workspaceId,
      "ANTHROPIC*CLAUDE.AI SUBSCR",
      harness.handle.db,
    );
    expect(merchant?.canonicalName).toBe("Anthropic");
  });

  it("resolves a product name to its vendor", async () => {
    expect((await resolveMerchant(workspaceId, "Claude Pro", harness.handle.db))?.canonicalName).toBe(
      "Anthropic",
    );
    expect((await resolveMerchant(workspaceId, "ChatGPT Plus", harness.handle.db))?.canonicalName).toBe(
      "OpenAI",
    );
  });

  it("resolves case and punctuation variants to the same row", async () => {
    const forms = ["midjourney", "MIDJOURNEY INC", "Midjourney, Inc.", "MidJourney Standard"];
    const resolved = await Promise.all(
      forms.map((form) => resolveMerchant(workspaceId, form, harness.handle.db)),
    );
    const ids = new Set(resolved.map((row) => row?.id));
    expect(ids.size).toBe(1);
    expect(resolved[0]?.canonicalName).toBe("Midjourney");
  });

  it("returns null for a vendor it has never seen", async () => {
    expect(await resolveMerchant(workspaceId, "Zzyzx Widgets", harness.handle.db)).toBeNull();
  });

  it("creates a workspace-local row for an unknown vendor", async () => {
    const created = await resolveOrCreateMerchant(
      workspaceId,
      "Zzyzx Widgets",
      harness.handle.db,
    );
    expect(created?.canonicalName).toBe("Zzyzx Widgets");
    // Workspace-scoped, so one user's vendor cannot pollute the shared catalog.
    expect(created?.workspaceId).toBe(workspaceId);

    const again = await resolveMerchant(workspaceId, "Zzyzx Widgets", harness.handle.db);
    expect(again?.id).toBe(created?.id);
  });

  it("does not leak a workspace-local vendor to another workspace", async () => {
    const other = new ApiClient(harness.app);
    const otherUser = await signUp(other);
    expect(
      await resolveMerchant(otherUser.workspaceId, "Zzyzx Widgets", harness.handle.db),
    ).toBeNull();
  });

  it("learns a new spelling so the next sighting resolves exactly", async () => {
    const merchant = await resolveOrCreateMerchant(workspaceId, "Loom", harness.handle.db);
    expect(merchant).not.toBeNull();

    await learnAlias(merchant!.id, "LOOM VIDEO MESSAGING", harness.handle.db);
    const resolved = await resolveMerchant(workspaceId, "loom video messaging", harness.handle.db);
    expect(resolved?.id).toBe(merchant!.id);
  });

  it("returns a verified cancel URL for a curated vendor", async () => {
    const anthropic = await resolveCancelUrl(workspaceId, "anthropic", harness.handle.db);
    expect(anthropic.url).toBe("https://claude.ai/settings/billing");
    expect(anthropic.verified).toBe(true);
  });

  it("says it has no URL rather than guessing one", async () => {
    const unknown = await resolveCancelUrl(workspaceId, "zzyzx widgets", harness.handle.db);
    expect(unknown.url).toBeNull();
    expect(unknown.verified).toBe(false);
  });
});

describe("content hashing for dedupe", () => {
  it("is stable for the same renewal facts", () => {
    const a = contentHash({
      merchantCanonical: "anthropic",
      amount: "20.00",
      currency: "USD",
      billingCycle: "monthly",
      nextRenewalAt: "2026-08-12T12:00:00.000Z",
    });
    const b = contentHash({
      merchantCanonical: "Anthropic",
      amount: "20.00",
      currency: "usd",
      billingCycle: "monthly",
      // Same calendar day, different time: a re-send, not a new renewal.
      nextRenewalAt: "2026-08-12T23:59:00.000Z",
    });
    expect(a).toBe(b);
  });

  it("changes when the amount changes, which is the case that matters", () => {
    const base = { merchantCanonical: "anthropic", currency: "USD", billingCycle: "monthly" };
    expect(contentHash({ ...base, amount: "20.00" })).not.toBe(
      contentHash({ ...base, amount: "25.00" }),
    );
  });

  it("changes when the merchant changes", () => {
    const base = { amount: "20.00", currency: "USD" };
    expect(contentHash({ ...base, merchantCanonical: "anthropic" })).not.toBe(
      contentHash({ ...base, merchantCanonical: "openai" }),
    );
  });

  it("ignores whitespace and case in raw bodies", () => {
    expect(rawContentHash("Total:  $20.00\n\nThanks")).toBe(rawContentHash("total: $20.00 thanks"));
  });

  it("distinguishes genuinely different bodies", () => {
    expect(rawContentHash("Total: $20.00")).not.toBe(rawContentHash("Total: $30.00"));
  });
});

describe("idempotency", () => {
  it("runs the work once and replays the stored result", async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      return { value: runs };
    };

    const first = await once(
      { scope: "test", key: "k1", workspaceId },
      work,
      harness.handle.db,
    );
    const second = await once(
      { scope: "test", key: "k1", workspaceId },
      work,
      harness.handle.db,
    );

    expect(first.executed).toBe(true);
    expect(second.executed).toBe(false);
    expect(runs).toBe(1);
    expect(second.value).toEqual(first.value);
  });

  it("runs concurrent callers exactly once", async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { runs };
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        once({ scope: "test", key: "concurrent", workspaceId }, work, harness.handle.db),
      ),
    );

    expect(runs).toBe(1);
    expect(results.filter((r) => r.executed)).toHaveLength(1);
  });

  it("scopes keys so the same key in another scope still runs", async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      return { runs };
    };

    await once({ scope: "scope-a", key: "shared" }, work, harness.handle.db);
    await once({ scope: "scope-b", key: "shared" }, work, harness.handle.db);
    expect(runs).toBe(2);
  });

  it("releases the claim when the work throws, so it can be retried", async () => {
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return { attempts };
    };

    await expect(
      once({ scope: "test", key: "flaky" }, flaky, harness.handle.db),
    ).rejects.toThrow("transient");

    const retry = await once({ scope: "test", key: "flaky" }, flaky, harness.handle.db);
    expect(retry.executed).toBe(true);
    expect(attempts).toBe(2);
  });

  it("builds a composite key, skipping absent parts", () => {
    expect(idempotencyKeyFor(["apr_1", "sess_2"])).toBe("apr_1:sess_2");
    expect(idempotencyKeyFor(["apr_1", null, undefined, "x"])).toBe("apr_1:x");
  });
});
