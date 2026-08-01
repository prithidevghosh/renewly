import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixture, signUp } from "../src/test/factories.js";
import {
  ApiClient,
  createHarness,
  expectErrorCode,
  textFile,
  type TestHarness,
} from "../src/test/helpers.js";

let harness: TestHarness;
let client: ApiClient;

interface DraftShape {
  merchantName: string;
  amount: string | null;
  currency: string;
  billingCycle: string;
  nextRenewalAt: string | null;
  fieldConfidence: Record<string, number>;
  requiresConfirmation: boolean;
  parser: string;
  confidence: number;
}

interface IntakeResponse {
  renewalEvent: { id: string; parseConfidence: number; parserUsed: string; sourceType: string };
  draft: DraftShape;
}

interface CandidateShape {
  id: string;
  merchantGuess: string;
  merchantCanonical: string;
  amount: string;
  occurrences: number;
  confidence: number;
  status: string;
  linkedSubscriptionId: string | null;
}

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  await signUp(client);
});

afterAll(async () => {
  await harness.close();
});

describe("email intake", () => {
  it("parses a renewal email into a draft and a renewal event", async () => {
    const response = await client.post<IntakeResponse>("/v1/intake/email", {
      text: fixture("emails/claude-pro-renewal.txt"),
    });

    expect(response.status).toBe(201);
    expect(response.body.draft.merchantName).toBe("Anthropic");
    expect(response.body.draft.amount).toBe("20.00");
    expect(response.body.draft.billingCycle).toBe("monthly");
    expect(response.body.draft.nextRenewalAt).toContain("2026-08-12");
    // No LLM key in tests, so this must go through the heuristic path.
    expect(response.body.draft.parser).toBe("heuristic");
    expect(response.body.renewalEvent.parserUsed).toBe("heuristic");
    expect(response.body.renewalEvent.sourceType).toBe("email");
  });

  it("flags a vague email as needing confirmation before it can be paid", async () => {
    const response = await client.post<IntakeResponse>("/v1/intake/email", {
      text: "hey do we still pay for that design thing? think it's about 15 bucks",
    });

    expect(response.status).toBe(201);
    expect(response.body.draft.requiresConfirmation).toBe(true);
    expect(response.body.renewalEvent.parseConfidence).toBeLessThan(0.7);
  });

  it("rejects an empty body", async () => {
    const response = await client.post("/v1/intake/email", { text: "hi" });
    expect(response.status).toBe(400);
    expect(expectErrorCode(response.body)).toBe("VALIDATION_ERROR");
  });

  it("requires authentication", async () => {
    const response = await client.post("/v1/intake/email", { text: "x".repeat(20) }, null);
    expect(response.status).toBe(401);
  });
});

describe("file intake", () => {
  it("accepts a .eml upload and parses it", async () => {
    const form = new FormData();
    form.append(
      "file",
      textFile("midjourney.eml", fixture("emails/midjourney-receipt.txt"), "message/rfc822"),
    );

    const response = await client.upload<IntakeResponse>("/v1/intake/file", form);
    expect(response.status).toBe(201);
    expect(response.body.draft.merchantName).toBe("Midjourney");
    expect(response.body.draft.amount).toBe("30.00");
    expect(response.body.renewalEvent.sourceType).toBe("file");
  });

  it("rejects a binary file type", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0, 1, 2, 3])], "photo.png", { type: "image/png" }));

    const response = await client.upload("/v1/intake/file", form);
    expect(response.status).toBe(400);
  });

  it("rejects a file above the size limit", async () => {
    const form = new FormData();
    form.append("file", textFile("huge.txt", "x".repeat(1_100_000)));

    const response = await client.upload("/v1/intake/file", form);
    expect(response.status).toBe(413);
    expect(expectErrorCode(response.body)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a non-multipart request", async () => {
    const response = await client.post("/v1/intake/file", { file: "nope" });
    expect(response.status).toBe(400);
  });
});

describe("csv intake", () => {
  let importId: string;
  let candidates: CandidateShape[];

  it("imports a statement and detects the recurring charges", async () => {
    const form = new FormData();
    form.append("file", textFile("small-bank.csv", fixture("csv/small-bank.csv"), "text/csv"));

    const response = await client.upload<{
      import: { id: string; rowCount: number };
      candidates: CandidateShape[];
    }>("/v1/intake/csv", form);

    expect(response.status).toBe(201);
    expect(response.body.import.rowCount).toBe(17);
    expect(response.body.candidates).toHaveLength(3);

    importId = response.body.import.id;
    candidates = response.body.candidates;

    const merchants = candidates.map((c) => c.merchantCanonical).sort();
    expect(merchants).toEqual(["anthropic claude ai", "midjourney", "notion"]);
    expect(candidates.every((c) => c.status === "pending")).toBe(true);
  });

  it("lists the candidates for the import", async () => {
    const response = await client.get<{ candidates: CandidateShape[] }>(
      `/v1/intake/csv/${importId}/candidates`,
    );
    expect(response.status).toBe(200);
    expect(response.body.candidates).toHaveLength(3);
  });

  it("returns 404 for an import in another workspace", async () => {
    const other = new ApiClient(harness.app);
    await signUp(other);
    const response = await other.get(`/v1/intake/csv/${importId}/candidates`);
    expect(response.status).toBe(404);
  });

  it("accepts a candidate into a subscription that still needs confirmation", async () => {
    const candidate = candidates.find((c) => c.merchantCanonical === "midjourney")!;

    const response = await client.post<{
      subscription: {
        id: string;
        merchantName: string;
        amount: string;
        sourceType: string;
        requiresConfirmation: boolean;
        confirmedAt: string | null;
        nextRenewalAt: string | null;
      };
    }>(`/v1/intake/csv/candidates/${candidate.id}/accept`, { criticality: "experimental" });

    expect(response.status).toBe(201);
    expect(response.body.subscription.amount).toBe("30.00");
    expect(response.body.subscription.sourceType).toBe("csv");
    // A statement guesses the renewal date, so payment stays gated.
    expect(response.body.subscription.requiresConfirmation).toBe(true);
    expect(response.body.subscription.confirmedAt).toBeNull();
    // The next charge is projected one cycle past the last one seen (2026-07-05).
    expect(response.body.subscription.nextRenewalAt).toContain("2026-08-05");
  });

  it("refuses to accept the same candidate twice", async () => {
    const candidate = candidates.find((c) => c.merchantCanonical === "midjourney")!;
    const response = await client.post(`/v1/intake/csv/candidates/${candidate.id}/accept`, {});
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("CONFLICT");
  });

  it("rejects a candidate without creating a subscription", async () => {
    const candidate = candidates.find((c) => c.merchantCanonical === "notion")!;
    const before = await client.get<{ subscriptions: unknown[] }>("/v1/subscriptions");

    const response = await client.post<{ candidate: CandidateShape }>(
      `/v1/intake/csv/candidates/${candidate.id}/reject`,
    );
    expect(response.status).toBe(200);
    expect(response.body.candidate.status).toBe("rejected");

    const after = await client.get<{ subscriptions: unknown[] }>("/v1/subscriptions");
    expect(after.body.subscriptions).toHaveLength(before.body.subscriptions.length);
  });

  it("writes the audit chain for the import", async () => {
    const response = await client.get<{ events: Array<{ type: string }> }>("/v1/audit?limit=200");
    const types = response.body.events.map((e) => e.type);
    expect(types).toContain("csv.imported");
    expect(types).toContain("csv.candidate_accepted");
    expect(types).toContain("csv.candidate_rejected");
    expect(types).toContain("renewal.parsed");
  });
});
