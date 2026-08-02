import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";
import {
  completeSession,
  log,
  startSession,
  stepCompleted,
  stepStarted,
} from "../src/modules/agent/service.js";
import type { AgentSession } from "../src/db/schema.js";

/**
 * The SSE contract the terminal is built against. These assert the two things a
 * client cannot work around if they are wrong: that frames carry the sequence
 * number as the SSE id (so the browser's own reconnect resumes correctly), and
 * that a stream opened late still receives everything it missed.
 */

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

interface Frame {
  id: string | null;
  event: string | null;
  data: Record<string, unknown> | null;
}

/** Parses SSE wire format into frames, stopping once `stopOn` is seen. */
function parseFrames(raw: string): Frame[] {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const frame: Frame = { id: null, event: null, data: null };
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const field = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (field === "id") frame.id = value;
        if (field === "event") frame.event = value;
        if (field === "data") frame.data = JSON.parse(value) as Record<string, unknown>;
      }
      return frame;
    })
    .filter((frame) => frame.event !== null);
}

/** Reads the stream until it closes or the budget runs out. */
async function readStream(
  path: string,
  token: string,
  budgetMs = 8000,
): Promise<Frame[]> {
  const response = await harness.app.request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let buffer = "";

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // stream.close is the server saying the session is finished and drained.
      if (buffer.includes("event: stream.close")) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return parseFrames(buffer);
}

async function newSession(): Promise<AgentSession> {
  return startSession({ workspaceId, userId, kind: "detect" });
}

describe("agent SSE stream", () => {
  it("replays a finished session from the beginning and closes itself", async () => {
    const session = await newSession();
    await stepStarted(session, "fetch_mail", "Reading your mailbox");
    await stepCompleted(session, "fetch_mail", { found: 214 });
    await completeSession(session, { subscriptionsFound: 9 });

    const frames = await readStream(
      `/v1/agent/sessions/${session.id}/stream`,
      client.getToken()!,
    );

    expect(frames[0]!.event).toBe("stream.open");
    expect(frames[0]!.data).toMatchObject({ sessionId: session.id, resumedFrom: 0 });

    const types = frames.map((frame) => frame.event);
    expect(types).toContain("session.started");
    expect(types).toContain("step.started");
    expect(types).toContain("step.completed");
    expect(types).toContain("session.completed");
    // The socket must not close before the completion event has gone out.
    expect(types[types.length - 1]).toBe("stream.close");
  });

  it("carries the sequence number as the SSE id, which is what makes resume work", async () => {
    const session = await newSession();
    await log(session, "one");
    await log(session, "two");
    await completeSession(session);

    const frames = await readStream(
      `/v1/agent/sessions/${session.id}/stream`,
      client.getToken()!,
    );

    const events = frames.filter(
      (frame) => frame.event !== "stream.open" && frame.event !== "stream.close",
    );
    expect(events.map((frame) => frame.id)).toEqual(["1", "2", "3", "4"]);
    for (const frame of events) {
      // A client keying off `data.seq` and one keying off the SSE id must agree.
      expect(String(frame.data!.seq)).toBe(frame.id);
    }
  });

  it("sends only what was missed when resuming from a sequence number", async () => {
    const session = await newSession();
    await log(session, "first");
    await log(session, "second");
    await log(session, "third");
    await completeSession(session);

    const frames = await readStream(
      `/v1/agent/sessions/${session.id}/stream?after=2`,
      client.getToken()!,
    );

    expect(frames[0]!.data).toMatchObject({ resumedFrom: 2 });
    const seqs = frames
      .filter((frame) => frame.data?.seq !== undefined)
      .map((frame) => frame.data!.seq);
    expect(seqs).toEqual([3, 4, 5]);
  });

  it("honours Last-Event-ID, so a browser reconnect resumes with no client code", async () => {
    const session = await newSession();
    await log(session, "a");
    await log(session, "b");
    await completeSession(session);

    const response = await harness.app.request(
      `http://localhost/v1/agent/sessions/${session.id}/stream`,
      {
        headers: {
          authorization: `Bearer ${client.getToken()!}`,
          "last-event-id": "3",
        },
      },
    );

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: stream.close")) break;
    }
    await reader.cancel().catch(() => undefined);

    const frames = parseFrames(buffer);
    expect(frames[0]!.data).toMatchObject({ resumedFrom: 3 });
    const seqs = frames
      .filter((frame) => frame.data?.seq !== undefined)
      .map((frame) => frame.data!.seq);
    expect(seqs).toEqual([4]);
  });

  it("delivers events written after the stream is already open", async () => {
    const session = await newSession();

    const streaming = readStream(`/v1/agent/sessions/${session.id}/stream`, client.getToken()!);

    // Write after a beat, so these can only arrive through the live tail rather
    // than the initial replay.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stepStarted(session, "classify", "Sorting receipts");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await completeSession(session);

    const frames = await streaming;
    const types = frames.map((frame) => frame.event);

    expect(types).toContain("step.started");
    expect(types).toContain("session.completed");
    expect(types[types.length - 1]).toBe("stream.close");
  });

  it("refuses another workspace's stream", async () => {
    const session = await newSession();

    const intruder = new ApiClient(harness.app);
    await signUp(intruder, { email: `stream-intruder-${Date.now()}@example.com` });

    const response = await harness.app.request(
      `http://localhost/v1/agent/sessions/${session.id}/stream`,
      { headers: { authorization: `Bearer ${intruder.getToken()!}` } },
    );
    expect(response.status).toBe(404);
  });
});
