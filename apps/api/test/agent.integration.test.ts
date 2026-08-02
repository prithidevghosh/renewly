import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";
import {
  answerPrompt,
  appendEvent,
  completeSession,
  getSession,
  raisePrompt,
  readAnswer,
  readEvents,
  startSession,
  stepCompleted,
  stepProgress,
  stepStarted,
} from "../src/modules/agent/service.js";
import type { AgentSession } from "../src/db/schema.js";

let harness: TestHarness;
let client: ApiClient;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  const user = await signUp(client);
  workspaceId = user.workspaceId;
  userId = user.userId;
});

afterAll(async () => {
  await harness.close();
});

interface SessionShape {
  id: string;
  kind: string;
  status: string;
  currentStep: string | null;
  lastSeq: number;
}

interface EventShape {
  seq: number;
  type: string;
  step: string | null;
  payload: Record<string, unknown>;
}

async function newSession(kind = "detect"): Promise<AgentSession> {
  return startSession({ workspaceId, userId, kind: kind as AgentSession["kind"] });
}

describe("agent sessions", () => {
  it("starts a session and records the opening event", async () => {
    const response = await client.post<{ session: SessionShape }>("/v1/agent/sessions", {
      kind: "onboarding",
    });

    expect(response.status).toBe(201);
    expect(response.body.session.status).toBe("running");
    expect(response.body.session.kind).toBe("onboarding");

    const events = await client.get<{ events: EventShape[] }>(
      `/v1/agent/sessions/${response.body.session.id}/events`,
    );
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0]!.type).toBe("session.started");
    // Sequence starts at 1, so a client holding 0 has genuinely seen nothing.
    expect(events.body.events[0]!.seq).toBe(1);
  });

  it("numbers events consecutively with no gaps", async () => {
    const session = await newSession();

    await stepStarted(session, "fetch_mail", "Reading your mailbox");
    await stepProgress(session, "fetch_mail", { message: "214 receipts", current: 214 });
    await stepCompleted(session, "fetch_mail", { found: 214 });

    const events = await readEvents(session.id, 0);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "step.started",
      "step.progress",
      "step.completed",
    ]);
  });

  it("allocates sequence numbers atomically under concurrent writes", async () => {
    const session = await newSession();

    // The terminal's whole resumption guarantee rests on this: if two steps
    // could ever be handed the same seq, a client would silently skip one.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        appendEvent({ session, type: "log", payload: { message: `line ${i}` } }),
      ),
    );

    const events = await readEvents(session.id, 0);
    const seqs = events.map((event) => event.seq);

    expect(seqs).toHaveLength(26);
    expect(new Set(seqs).size).toBe(26);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[seqs.length - 1]).toBe(26);
  });

  it("replays only what a client has not seen", async () => {
    const session = await newSession();
    await stepStarted(session, "a", "A");
    await stepStarted(session, "b", "B");
    await stepStarted(session, "c", "C");

    const response = await client.get<{ events: EventShape[] }>(
      `/v1/agent/sessions/${session.id}/events?after=2`,
    );

    expect(response.body.events.map((event) => event.seq)).toEqual([3, 4]);
  });

  it("tracks the current step on the session row", async () => {
    const session = await newSession();
    await stepStarted(session, "classify", "Sorting receipts");

    const reloaded = await getSession(workspaceId, session.id);
    expect(reloaded.currentStep).toBe("classify");
  });
});

describe("prompts", () => {
  it("parks the session until the user answers", async () => {
    const session = await newSession();

    await raisePrompt({
      session,
      promptKey: "cap:coding",
      question: "What is your monthly cap for coding tools?",
      freeText: true,
      skippable: true,
    });

    const parked = await getSession(workspaceId, session.id);
    expect(parked.status).toBe("awaiting_input");

    const view = await client.get<{
      session: SessionShape;
      openPrompts: Array<{ promptKey: string; question: string; skippable: boolean }>;
    }>(`/v1/agent/sessions/${session.id}`);

    expect(view.body.openPrompts).toHaveLength(1);
    expect(view.body.openPrompts[0]!.promptKey).toBe("cap:coding");
    expect(view.body.openPrompts[0]!.skippable).toBe(true);
  });

  it("resumes the run once answered, and the step can read the answer back", async () => {
    const session = await newSession();
    await raisePrompt({ session, promptKey: "cap:design", question: "Cap?", freeText: true });

    const response = await client.post<{ session: SessionShape }>(
      `/v1/agent/sessions/${session.id}/input`,
      { promptKey: "cap:design", answer: "200" },
    );

    expect(response.status).toBe(200);
    expect(response.body.session.status).toBe("running");
    expect(await readAnswer(session.id, "cap:design")).toBe("200");

    const events = await readEvents(session.id, 0);
    const answered = events.find((event) => event.type === "prompt.answered");
    expect(answered?.payload.answer).toBe("200");
  });

  it("answers the only open question without being told which one", async () => {
    const session = await newSession();
    await raisePrompt({ session, promptKey: "only", question: "Cap?", freeText: true });

    const response = await client.post(`/v1/agent/sessions/${session.id}/input`, {
      answer: "150",
    });

    expect(response.status).toBe(200);
    expect(await readAnswer(session.id, "only")).toBe("150");
  });

  it("refuses to guess when several questions are open", async () => {
    const session = await newSession();
    await raisePrompt({ session, promptKey: "cap:a", question: "A?", freeText: true });
    await raisePrompt({ session, promptKey: "cap:b", question: "B?", freeText: true });

    const response = await client.post(`/v1/agent/sessions/${session.id}/input`, {
      answer: "100",
    });

    expect(response.status).toBe(400);
    expect(expectErrorCode(response.body)).toBe("VALIDATION_ERROR");
  });

  it("stays parked while any question is still open", async () => {
    const session = await newSession();
    await raisePrompt({ session, promptKey: "one", question: "1?", freeText: true });
    await raisePrompt({ session, promptKey: "two", question: "2?", freeText: true });

    await answerPrompt({ workspaceId, sessionId: session.id, promptKey: "one", answer: "x" });
    expect((await getSession(workspaceId, session.id)).status).toBe("awaiting_input");

    await answerPrompt({ workspaceId, sessionId: session.id, promptKey: "two", answer: "y" });
    expect((await getSession(workspaceId, session.id)).status).toBe("running");
  });

  it("enforces a closed option set", async () => {
    const session = await newSession();
    await raisePrompt({
      session,
      promptKey: "overlap:figma-penpot",
      question: "Cancel Figma?",
      options: [
        { value: "cancel", label: "Cancel it" },
        { value: "keep", label: "Keep both" },
      ],
    });

    const bad = await client.post(`/v1/agent/sessions/${session.id}/input`, {
      promptKey: "overlap:figma-penpot",
      answer: "maybe",
    });
    expect(bad.status).toBe(400);

    const good = await client.post(`/v1/agent/sessions/${session.id}/input`, {
      promptKey: "overlap:figma-penpot",
      answer: "cancel",
    });
    expect(good.status).toBe(200);
  });

  it("accepts skip only when the question allows it", async () => {
    const session = await newSession();
    await raisePrompt({
      session,
      promptKey: "cap:optional",
      question: "Cap?",
      options: [{ value: "100", label: "100" }],
      skippable: true,
    });
    const skipped = await client.post(`/v1/agent/sessions/${session.id}/input`, {
      answer: "skip",
    });
    expect(skipped.status).toBe(200);

    const other = await newSession();
    await raisePrompt({
      session: other,
      promptKey: "cap:required",
      question: "Cap?",
      options: [{ value: "100", label: "100" }],
    });
    const refused = await client.post(`/v1/agent/sessions/${other.id}/input`, { answer: "skip" });
    expect(refused.status).toBe(400);
  });

  it("rejects a second answer to the same question", async () => {
    const session = await newSession();
    await raisePrompt({ session, promptKey: "once", question: "Cap?", freeText: true });

    await client.post(`/v1/agent/sessions/${session.id}/input`, { answer: "100" });
    const again = await client.post(`/v1/agent/sessions/${session.id}/input`, { answer: "200" });

    expect(again.status).toBe(409);
    expect(await readAnswer(session.id, "once")).toBe("100");
  });

  it("returns the open question rather than asking twice when a step resumes", async () => {
    const session = await newSession();
    const first = await raisePrompt({ session, promptKey: "dup", question: "Cap?", freeText: true });
    const second = await raisePrompt({ session, promptKey: "dup", question: "Cap?", freeText: true });

    expect(second.id).toBe(first.id);
    const events = await readEvents(session.id, 0);
    expect(events.filter((event) => event.type === "prompt")).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("closes a completed session and refuses further input", async () => {
    const session = await newSession();
    await completeSession(session, { subscriptionsFound: 12 });

    const reloaded = await getSession(workspaceId, session.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.endedAt).toBeTruthy();

    const response = await client.post(`/v1/agent/sessions/${session.id}/input`, { answer: "x" });
    expect(response.status).toBe(409);
  });

  it("cancels a running session", async () => {
    const session = await newSession();
    const response = await client.post<{ session: SessionShape }>(
      `/v1/agent/sessions/${session.id}/cancel`,
      {},
    );

    expect(response.body.session.status).toBe("cancelled");
  });

  it("reattaches to the newest session on boot", async () => {
    const session = await newSession("monthly_sweep");

    const response = await client.get<{ session: SessionShape | null }>(
      "/v1/agent/sessions/latest",
    );
    expect(response.body.session?.id).toBe(session.id);
  });
});

describe("isolation", () => {
  it("will not show another workspace's session", async () => {
    const session = await newSession();

    const otherClient = new ApiClient(harness.app);
    await signUp(otherClient, { email: `intruder-${Date.now()}@example.com` });

    const response = await otherClient.get(`/v1/agent/sessions/${session.id}`);
    expect(response.status).toBe(404);

    const input = await otherClient.post(`/v1/agent/sessions/${session.id}/input`, {
      answer: "x",
    });
    expect(input.status).toBe(404);
  });

  it("requires authentication", async () => {
    const anonymous = new ApiClient(harness.app);
    const response = await anonymous.get("/v1/agent/sessions/latest");
    expect(response.status).toBe(401);
  });
});
