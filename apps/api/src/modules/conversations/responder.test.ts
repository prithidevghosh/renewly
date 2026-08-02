import { afterEach, describe, expect, it, vi } from "vitest";
import { setLlmClient } from "../../lib/llm.js";
import type { ChatReply, LlmClient } from "../../lib/llm.js";

/**
 * The guard rails around the reply writer.
 *
 * The model never authorises anything — the deterministic parser does — so the
 * cases that matter here are the ones where the model believes otherwise, or
 * writes as if an action had already happened.
 */

const { composeFallbackReply } = await import("./responder.js");

function llm(reply: ChatReply | null, calls: ChatReply[] = []): LlmClient {
  return {
    available: true,
    modelId: "test-model",
    async extractRenewalFromText() {
      return null;
    },
    async explainDecision() {
      return null;
    },
    async chatReply() {
      if (reply) calls.push(reply);
      return reply;
    },
  };
}

/** The responder reads subscriptions and thread history; both are empty here. */
vi.mock("./service.js", () => ({ listMessages: async () => [] }));
vi.mock("../../db/client.js", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: async () => [] }) }) }),
}));

const input = {
  auth: { workspace: { id: "wsp_1" } },
  thread: { id: "thr_1" },
  open: null,
} as unknown as Parameters<typeof composeFallbackReply>[0];

afterEach(() => {
  setLlmClient(null);
  vi.restoreAllMocks();
});

describe("composeFallbackReply", () => {
  it("sends what the model wrote for ordinary conversation", async () => {
    setLlmClient(llm({ intent: "smalltalk", reply: "Nothing needs you right now." }));

    const result = await composeFallbackReply({ ...input, text: "hi" });

    expect(result.body).toBe("Nothing needs you right now.");
    expect(result.source).toBe("llm");
  });

  it("falls back to the command list when the model is unavailable", async () => {
    setLlmClient({
      available: false,
      modelId: null,
      async extractRenewalFromText() {
        return null;
      },
      async explainDecision() {
        return null;
      },
      async chatReply() {
        return null;
      },
    });

    const result = await composeFallbackReply({ ...input, text: "hi" });

    expect(result.source).toBe("static");
    expect(result.body).toContain("APPROVE");
  });

  it("falls back when the model returns nothing", async () => {
    setLlmClient(llm(null));
    const result = await composeFallbackReply({ ...input, text: "hi" });
    expect(result.source).toBe("static");
  });

  it("never sends a model reply for an intent that would act", async () => {
    // The model reading "go on then" as approval must not produce a reply that
    // sounds like approval happened. Nothing in this path acts.
    setLlmClient(llm({ intent: "approve", reply: "Great, I've approved that for you." }));

    const result = await composeFallbackReply({ ...input, text: "go on then" });

    expect(result.body).not.toMatch(/approved/i);
    expect(result.source).toBe("static");
  });

  it("asks for the exact word when a proposal is open", async () => {
    setLlmClient(llm({ intent: "approve", reply: "Approving now." }));

    const result = await composeFallbackReply({
      ...input,
      text: "yeah go for it i guess",
      open: {
        approval: {},
        subscription: { merchantName: "Coda", amount: "47.00", currency: "USD", billingCycle: "monthly" },
        decision: {
          payload: {
            recommendation: "cancel",
            headline: "Cancel Coda",
            amount_due: "0.00",
            counterfactuals: {
              do_nothing: { annual_cost: "564.00" },
              recommended: { annual_cost: "0.00", savings_vs_do_nothing: "564.00" },
            },
            inputs_used: [],
            diagnosis: "d",
          },
        },
      },
    } as unknown as Parameters<typeof composeFallbackReply>[0]);

    expect(result.body).toContain("APPROVE");
  });

  it("discards a reply that claims an action already happened", async () => {
    setLlmClient(llm({ intent: "smalltalk", reply: "All done, payment sent." }));

    const result = await composeFallbackReply({ ...input, text: "thanks" });

    expect(result.source).toBe("static");
    expect(result.body).not.toMatch(/payment sent/i);
  });

  it("falls back rather than throwing when the model errors", async () => {
    setLlmClient({
      available: true,
      modelId: "test-model",
      async extractRenewalFromText() {
        return null;
      },
      async explainDecision() {
        return null;
      },
      async chatReply() {
        throw new Error("upstream exploded");
      },
    });

    const result = await composeFallbackReply({ ...input, text: "hi" });

    expect(result.source).toBe("static");
    expect(result.body).toContain("APPROVE");
  });

  it("does not send an empty reply", async () => {
    setLlmClient(llm({ intent: "smalltalk", reply: "   " }));
    const result = await composeFallbackReply({ ...input, text: "hi" });
    expect(result.source).toBe("static");
  });
});
