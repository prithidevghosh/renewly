import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEvents } from "../src/modules/agent/service.js";
import { runSession } from "../src/modules/agent/runner.js";
import { saveGrant } from "../src/modules/mailbox/service.js";
import { signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

/**
 * The mailbox window is the user's choice, and it costs real Gmail quota, so
 * it is validated at the edge and carried on the session rather than read from
 * a constant at the moment the fetch happens.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

interface SessionBody {
  session: { id: string; kind: string; status: string };
}

interface Account {
  client: ApiClient;
  workspaceId: string;
}

async function accountWithMailbox(): Promise<Account> {
  const client = new ApiClient(harness.app);
  const user = await signUp(client);

  await saveGrant({
    workspaceId: user.workspaceId,
    userId: user.userId,
    provider: "gmail",
    grant: {
      emailAddress: user.email,
      tokens: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresIn: 3_600,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    },
  });

  return { client, workspaceId: user.workspaceId };
}

/** The `since` the fetch step actually asked the mailbox for, in days back. */
async function daysBackAtFetch(sessionId: string): Promise<number> {
  const events = await readEvents(sessionId, 0);
  const fetched = events.find(
    (event) => event.type === "step.completed" && event.step === "fetch_mail",
  );
  if (typeof fetched?.payload.since !== "string") {
    throw new Error("fetch_mail did not report the window it read");
  }
  const since = new Date(fetched.payload.since);
  return Math.round((Date.now() - since.getTime()) / 86_400_000);
}

/** The window a session was started with, as stored on the row. */
async function storedLookback(client: ApiClient, sessionId: string): Promise<unknown> {
  const { body } = await client.get<{ session: { state?: Record<string, unknown> } }>(
    `/v1/agent/sessions/${sessionId}`,
  );
  return body.session.state?.lookbackDays;
}

describe("mailbox lookback window", () => {
  it("defaults to one month when the client asks for nothing", async () => {
    const { client } = await accountWithMailbox();

    const { status, body } = await client.post<SessionBody>("/v1/agent/sessions", {
      kind: "detect",
    });

    expect(status).toBe(201);
    expect(await storedLookback(client, body.session.id)).toBe(30);
  });

  it("carries each offered window onto the session", async () => {
    for (const days of [15, 30, 60, 90]) {
      const { client } = await accountWithMailbox();
      const { status, body } = await client.post<SessionBody>("/v1/agent/sessions", {
        kind: "detect",
        lookbackDays: days,
      });

      expect(status).toBe(201);
      expect(await storedLookback(client, body.session.id)).toBe(days);
    }
  });

  it("refuses a window nobody offered", async () => {
    const { client } = await accountWithMailbox();

    const { status, body } = await client.post("/v1/agent/sessions", {
      kind: "detect",
      lookbackDays: 365,
    });

    expect(status).toBe(400);
    expect(expectErrorCode(body)).toBe("VALIDATION_ERROR");
  });

  it("refuses a window that is not a number", async () => {
    const { client } = await accountWithMailbox();

    const { status } = await client.post("/v1/agent/sessions", {
      kind: "detect",
      lookbackDays: "3 months",
    });

    expect(status).toBe(400);
  });

  it("lets the validated field win over the same key smuggled through state", async () => {
    const { client } = await accountWithMailbox();

    const { body } = await client.post<SessionBody>("/v1/agent/sessions", {
      kind: "detect",
      lookbackDays: 15,
      state: { lookbackDays: 3650 },
    });

    expect(await storedLookback(client, body.session.id)).toBe(15);
  });

  it("reports the chosen window on the step that read the mailbox", async () => {
    const { client, workspaceId } = await accountWithMailbox();

    const { body } = await client.post<SessionBody>("/v1/agent/sessions", {
      kind: "detect",
      lookbackDays: 90,
    });
    await runSession(body.session.id, workspaceId);

    // The value only means anything if it reached the fetch, not just the row.
    const events = await readEvents(body.session.id, 0);
    const fetched = events.find(
      (event) => event.type === "step.completed" && event.step === "fetch_mail",
    );

    expect(fetched?.payload.lookbackDays).toBe(90);
    // 90 days back, not the three calendar months the old constant meant.
    expect(await daysBackAtFetch(body.session.id)).toBe(90);
  });

  it("narrows the window the fetch asks for when the user picks a fortnight", async () => {
    const { client, workspaceId } = await accountWithMailbox();

    const { body } = await client.post<SessionBody>("/v1/agent/sessions", {
      kind: "detect",
      lookbackDays: 15,
    });
    await runSession(body.session.id, workspaceId);

    expect(await daysBackAtFetch(body.session.id)).toBe(15);
  });

  it("reads a month when the client asked for nothing", async () => {
    const { client, workspaceId } = await accountWithMailbox();

    const { body } = await client.post<SessionBody>("/v1/agent/sessions", {
      kind: "detect",
    });
    await runSession(body.session.id, workspaceId);

    expect(await daysBackAtFetch(body.session.id)).toBe(30);
  });
});
