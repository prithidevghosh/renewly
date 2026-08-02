import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessions, subscriptions, type AgentSession } from "../src/db/schema.js";
import { getSession, readEvents, startSession } from "../src/modules/agent/service.js";
import {
  isDriving,
  reapStaleSessions,
  runSession,
  setAutoKickoff,
} from "../src/modules/agent/runner.js";
import { saveGrant } from "../src/modules/mailbox/service.js";
import { signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * The runner, which is the part that was missing.
 *
 * Every piece around it already worked: sessions were created, the sequence
 * allocator was correct, the SSE stream tailed the log faithfully. Nothing ever
 * wrote a second event, so a run sat at `running` with `lastSeq: 1` until
 * someone cancelled it. The first test here is the regression that catches it
 * coming back — a started session must reach a terminal status on its own.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

interface Workspace {
  client: ApiClient;
  workspaceId: string;
  userId: string;
  email: string;
}

/** A verified account whose Gmail is connected to the fixture-backed mailbox. */
async function workspaceWithMailbox(): Promise<Workspace> {
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

  return { client, workspaceId: user.workspaceId, userId: user.userId, email: user.email };
}

async function run(kind: AgentSession["kind"], workspace: Workspace): Promise<AgentSession> {
  const session = await startSession({
    workspaceId: workspace.workspaceId,
    userId: workspace.userId,
    kind,
  });
  await runSession(session.id, workspace.workspaceId);
  return getSession(workspace.workspaceId, session.id);
}

async function transcript(session: AgentSession) {
  const events = await readEvents(session.id, 0);
  return {
    types: events.map((event) => event.type),
    steps: events.filter((event) => event.type === "step.started").map((event) => event.step),
    messages: events
      .map((event) => event.payload.message)
      .filter((value): value is string => typeof value === "string"),
    events,
  };
}

describe("agent runner", () => {
  it("drives a detect session to completion with nobody watching it", async () => {
    const workspace = await workspaceWithMailbox();
    const session = await run("detect", workspace);

    expect(session.status).toBe("completed");
    expect(session.endedAt).not.toBeNull();
    // The bug: the log stopped at the single session.started event.
    expect(session.lastSeq).toBeGreaterThan(1);
  });

  it("narrates every stage, so the terminal has something to render", async () => {
    const workspace = await workspaceWithMailbox();
    const session = await run("detect", workspace);
    const { types, steps } = await transcript(session);

    expect(steps).toEqual([
      "mailbox",
      "fetch_mail",
      "classify",
      "filter_saas",
      "parse",
      "reconcile",
    ]);
    expect(types).toContain("step.progress");
    expect(types).toContain("finding");
    expect(types.at(-1)).toBe("session.completed");
  });

  it("says which messages it read, which are receipts and what it parsed", async () => {
    const workspace = await workspaceWithMailbox();
    const session = await run("detect", workspace);
    const { messages } = await transcript(session);
    const all = messages.join("\n");

    expect(all).toMatch(/Read \d+ messages/);
    expect(all).toContain("Receipt · Anthropic");
    expect(all).toContain("Subscription · Anthropic");
    // The parse line carries the number a person is looking for.
    expect(all).toMatch(/Anthropic — \$20\.00 monthly/);
  });

  it("turns the receipts it kept into subscriptions", async () => {
    const workspace = await workspaceWithMailbox();
    await run("detect", workspace);

    const rows = await harness.handle.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspace.workspaceId));

    const merchants = rows.map((row) => row.merchantCanonical);
    expect(merchants).toContain("anthropic");
    expect(rows.every((row) => row.sourceType === "email")).toBe(true);

    const anthropic = rows.find((row) => row.merchantCanonical === "anthropic");
    expect(anthropic?.amount).toBe("20.00");
    expect(anthropic?.billingCycle).toBe("monthly");
  });

  it("does not create a second subscription when the same mailbox is swept twice", async () => {
    const workspace = await workspaceWithMailbox();
    await run("detect", workspace);
    await run("detect", workspace);

    const rows = await harness.handle.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspace.workspaceId),
          eq(subscriptions.merchantCanonical, "anthropic"),
        ),
      );

    expect(rows).toHaveLength(1);
  });

  it("leaves a cancelled subscription cancelled when the receipt predates the cancellation", async () => {
    const workspace = await workspaceWithMailbox();
    await run("detect", workspace);

    // Cancel it now: every fixture receipt is older than this instant.
    await harness.handle.db
      .update(subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(subscriptions.workspaceId, workspace.workspaceId),
          eq(subscriptions.merchantCanonical, "anthropic"),
        ),
      );

    await run("detect", workspace);

    const [row] = await harness.handle.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspace.workspaceId),
          eq(subscriptions.merchantCanonical, "anthropic"),
        ),
      );

    expect(row!.status).toBe("cancelled");
    expect(row!.cancelledAt).not.toBeNull();
  });

  it("reopens a cancelled subscription when a charge lands after the cancellation", async () => {
    const workspace = await workspaceWithMailbox();
    await run("detect", workspace);

    // Cancelled long before the fixture receipts were sent, so the charges are
    // evidence that the money is still going out.
    await harness.handle.db
      .update(subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date("2020-01-01T00:00:00Z") })
      .where(
        and(
          eq(subscriptions.workspaceId, workspace.workspaceId),
          eq(subscriptions.merchantCanonical, "anthropic"),
        ),
      );

    await run("detect", workspace);

    const [row] = await harness.handle.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspace.workspaceId),
          eq(subscriptions.merchantCanonical, "anthropic"),
        ),
      );

    expect(row!.status).toBe("active");
    expect(row!.cancelledAt).toBeNull();
  });

  it("fails with something the user can act on when no mailbox is connected", async () => {
    const client = new ApiClient(harness.app);
    const user = await signUp(client);

    const session = await run("detect", {
      client,
      workspaceId: user.workspaceId,
      userId: user.userId,
      email: user.email,
    });

    expect(session.status).toBe("failed");
    expect(session.error).toContain("No mailbox is connected");

    const { types } = await transcript(session);
    expect(types).toContain("session.failed");
  });

  it("records finished steps so a resumed run does not redo them", async () => {
    const workspace = await workspaceWithMailbox();
    const session = await run("detect", workspace);

    expect(session.state.completedSteps).toEqual([
      "mailbox",
      "fetch_mail",
      "classify",
      "filter_saas",
      "parse",
      "reconcile",
    ]);
  });

  it("refuses to drive the same session from two loops at once", async () => {
    const workspace = await workspaceWithMailbox();
    const session = await startSession({
      workspaceId: workspace.workspaceId,
      userId: workspace.userId,
      kind: "detect",
    });

    // Both resolve; only one of them may write the transcript. A second driver
    // would duplicate every step and break the gap-free sequence contract.
    await Promise.all([
      runSession(session.id, workspace.workspaceId),
      runSession(session.id, workspace.workspaceId),
    ]);

    const finished = await getSession(workspace.workspaceId, session.id);
    const { steps } = await transcript(finished);

    expect(finished.status).toBe("completed");
    expect(new Set(steps).size).toBe(steps.length);
    expect(isDriving(session.id)).toBe(false);
  });
});

describe("abandoned runs", () => {
  it("closes a run left behind by a restart, so the terminal stops waiting on it", async () => {
    const workspace = await workspaceWithMailbox();
    const session = await startSession({
      workspaceId: workspace.workspaceId,
      userId: workspace.userId,
      kind: "detect",
    });

    // Backdate it to look like it was mid-flight when the process died.
    await harness.handle.db
      .update(agentSessions)
      .set({ updatedAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(agentSessions.id, session.id));

    const reaped = await reapStaleSessions(harness.handle.db);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const closed = await getSession(workspace.workspaceId, session.id);
    expect(closed.status).toBe("failed");
    expect(closed.error).toContain("server restarted");
  });

  it("leaves a run that is merely waiting on a person alone", async () => {
    const workspace = await workspaceWithMailbox();
    const session = await startSession({
      workspaceId: workspace.workspaceId,
      userId: workspace.userId,
      kind: "onboarding",
    });
    await runSession(session.id, workspace.workspaceId);

    const parked = await getSession(workspace.workspaceId, session.id);
    expect(parked.status).toBe("awaiting_input");

    await harness.handle.db
      .update(agentSessions)
      .set({ updatedAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(agentSessions.id, session.id));

    await reapStaleSessions(harness.handle.db);

    // Parked on a person, not a process: a restart does not invalidate it.
    const after = await getSession(workspace.workspaceId, session.id);
    expect(after.status).toBe("awaiting_input");
  });
});

describe("agent runner prompts", () => {
  it("parks on a question and finishes once it is answered", async () => {
    const workspace = await workspaceWithMailbox();

    const started = await startSession({
      workspaceId: workspace.workspaceId,
      userId: workspace.userId,
      kind: "onboarding",
    });
    await runSession(started.id, workspace.workspaceId);

    const parked = await getSession(workspace.workspaceId, started.id);
    expect(parked.status).toBe("awaiting_input");
    expect(parked.currentStep).toBe("budget");

    const open = await workspace.client.get<{ openPrompts: Array<{ promptKey: string }> }>(
      `/v1/agent/sessions/${started.id}`,
    );
    expect(open.body.openPrompts[0]!.promptKey).toBe("budget:monthly");

    // Answering through the route is what a terminal does, and the route is
    // responsible for restarting the driver the parked step returned from.
    // That restart is detached, so this is the one test that wants the
    // fire-and-forget path rather than an awaited run.
    setAutoKickoff(true);
    try {
      const answered = await workspace.client.post(`/v1/agent/sessions/${started.id}/input`, {
        promptKey: "budget:monthly",
        answer: "250.00",
      });
      expect(answered.status).toBe(200);

      // Wait for it the way a client watching the stream would.
      await settle(started.id, workspace.workspaceId);
    } finally {
      setAutoKickoff(false);
    }

    const finished = await getSession(workspace.workspaceId, started.id);
    expect(finished.status).toBe("completed");

    const { steps } = await transcript(finished);
    // The parked step ran once to ask and once to consume the answer, but it is
    // only recorded as started once more — never duplicated across the resume.
    expect(steps.filter((step) => step === "budget")).toHaveLength(2);
    expect(steps).toContain("reconcile");
  });
});

/** Waits for a detached run to reach a terminal status. */
async function settle(sessionId: string, workspaceId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await getSession(workspaceId, sessionId);
    if (["completed", "failed", "cancelled"].includes(session.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session ${sessionId} did not finish within ${timeoutMs}ms`);
}
