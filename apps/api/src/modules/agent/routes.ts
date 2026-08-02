import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { readJson } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv } from "../../types/context.js";
import {
  answerPrompt,
  cancelSession,
  getSession,
  isFinished,
  latestSession,
  listOpenPrompts,
  readEvents,
  startSession,
} from "./service.js";
import type { AgentEvent, AgentSession } from "../../db/schema.js";

/**
 * The terminal's API surface. Three verbs and a stream:
 *   POST /v1/agent/sessions            start a run
 *   GET  /v1/agent/sessions/:id/stream tail it (SSE, resumable)
 *   POST /v1/agent/sessions/:id/input  answer whatever it asked
 *   POST /v1/agent/sessions/:id/cancel stop it
 */

export const agentRoutes = new Hono<AppEnv>();

agentRoutes.use("*", requireAuth());

/** How often the tailer looks for new rows. A terminal reads as fast as a
 *  person; sub-second is indistinguishable from instant and costs one index
 *  scan against a primary key range. */
const POLL_INTERVAL_MS = 400;
/** Proxies and load balancers close idle connections; a comment resets them. */
const HEARTBEAT_MS = 15_000;
/** A parked session can wait for a person indefinitely, but a socket should not. */
const MAX_STREAM_MS = 30 * 60_000;

function serializeSession(session: AgentSession) {
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    currentStep: session.currentStep,
    lastSeq: session.lastSeq,
    state: session.state,
    error: session.error,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
  };
}

function serializeEvent(event: AgentEvent) {
  return {
    seq: event.seq,
    type: event.type,
    step: event.step,
    payload: event.payload,
    at: event.createdAt.toISOString(),
  };
}

const startSchema = z.object({
  kind: z.enum(["onboarding", "detect", "decide", "monthly_sweep"]).default("onboarding"),
  state: z.record(z.string(), z.unknown()).optional(),
});

agentRoutes.post("/sessions", async (c) => {
  const { user, workspace } = c.get("auth");
  const input = await readJson(c, startSchema);

  const session = await startSession({
    workspaceId: workspace.id,
    userId: user.id,
    kind: input.kind,
    ...(input.state ? { state: input.state } : {}),
  });

  return c.json({ session: serializeSession(session) }, 201);
});

/** What a terminal calls on boot to decide whether to reattach or start fresh. */
agentRoutes.get("/sessions/latest", async (c) => {
  const { workspace } = c.get("auth");
  const session = await latestSession(workspace.id);
  if (!session) return c.json({ session: null, openPrompts: [] });

  const open = await listOpenPrompts(session.id);
  return c.json({
    session: serializeSession(session),
    openPrompts: open.map((prompt) => ({
      promptKey: prompt.promptKey,
      question: prompt.question,
      options: prompt.options,
      freeText: prompt.freeText,
      skippable: prompt.skippable,
      eventSeq: prompt.eventSeq,
    })),
  });
});

agentRoutes.get("/sessions/:id", async (c) => {
  const { workspace } = c.get("auth");
  const session = await getSession(workspace.id, c.req.param("id"));
  const open = await listOpenPrompts(session.id);

  return c.json({
    session: serializeSession(session),
    openPrompts: open.map((prompt) => ({
      promptKey: prompt.promptKey,
      question: prompt.question,
      options: prompt.options,
      freeText: prompt.freeText,
      skippable: prompt.skippable,
      eventSeq: prompt.eventSeq,
    })),
  });
});

/** A plain paginated read of the transcript, for clients that would rather
 *  poll than hold a stream open. */
agentRoutes.get("/sessions/:id/events", async (c) => {
  const { workspace } = c.get("auth");
  const session = await getSession(workspace.id, c.req.param("id"));
  const after = Number(c.req.query("after") ?? 0);
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);

  const events = await readEvents(session.id, Number.isFinite(after) ? after : 0, limit);
  return c.json({
    session: serializeSession(session),
    events: events.map(serializeEvent),
  });
});

/**
 * The live transcript.
 *
 * Resumption is the whole point: pass `?after=<seq>` (or let the browser send
 * `Last-Event-ID`, which EventSource does automatically on reconnect) and the
 * stream replays everything missed before going live. Because `seq` is gap-free
 * per session, a client that has seen N knows N+1 is the next thing it needs —
 * there is no window in which an event can be dropped silently.
 *
 * Note for the client: EventSource cannot send an Authorization header. Use
 * fetch with a ReadableStream reader, or rely on the session cookie.
 */
agentRoutes.get("/sessions/:id/stream", async (c) => {
  const { workspace } = c.get("auth");
  const session = await getSession(workspace.id, c.req.param("id"));

  const lastEventId = c.req.header("last-event-id");
  const fromQuery = Number(c.req.query("after") ?? Number.NaN);
  const resumeFrom = Number.isFinite(fromQuery)
    ? fromQuery
    : lastEventId !== undefined && Number.isFinite(Number(lastEventId))
      ? Number(lastEventId)
      : 0;

  return streamSSE(c, async (stream) => {
    let cursor = Math.max(0, resumeFrom);
    let lastBeat = Date.now();
    const startedAt = Date.now();

    // Tell the client where it actually resumed from, so a UI can show a gap
    // rather than silently rendering a partial transcript as if it were whole.
    await stream.writeSSE({
      event: "stream.open",
      data: JSON.stringify({
        sessionId: session.id,
        resumedFrom: cursor,
        status: session.status,
      }),
    });

    while (!stream.closed) {
      const batch = await readEvents(session.id, cursor);

      for (const event of batch) {
        await stream.writeSSE({
          // The SSE id becomes Last-Event-ID on reconnect, which is what makes
          // the browser's own retry resume correctly with no client code.
          id: String(event.seq),
          event: event.type,
          data: JSON.stringify(serializeEvent(event)),
        });
        cursor = event.seq;
        lastBeat = Date.now();
      }

      const current = await getSession(workspace.id, session.id);

      // Only stop once the log is drained, or a fast-finishing run would close
      // the socket before its own completion event went out.
      if (isFinished(current) && batch.length === 0 && cursor >= current.lastSeq) {
        await stream.writeSSE({
          event: "stream.close",
          data: JSON.stringify({ reason: current.status, lastSeq: cursor }),
        });
        break;
      }

      if (Date.now() - startedAt > MAX_STREAM_MS) {
        await stream.writeSSE({
          event: "stream.close",
          data: JSON.stringify({ reason: "timeout", lastSeq: cursor }),
        });
        break;
      }

      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        // A comment frame: keeps proxies from reaping an idle connection while
        // the agent is thinking or the user has not answered yet.
        await stream.write(": keep-alive\n\n");
        lastBeat = Date.now();
      }

      await stream.sleep(POLL_INTERVAL_MS);
    }
  });
});

const inputSchema = z.object({
  promptKey: z.string().min(1).max(200).optional(),
  answer: z.string().min(1).max(4000),
});

agentRoutes.post("/sessions/:id/input", async (c) => {
  const { workspace } = c.get("auth");
  const input = await readJson(c, inputSchema);

  const result = await answerPrompt({
    workspaceId: workspace.id,
    sessionId: c.req.param("id"),
    ...(input.promptKey ? { promptKey: input.promptKey } : {}),
    answer: input.answer,
  });

  return c.json({
    session: serializeSession(result.session),
    prompt: {
      promptKey: result.prompt.promptKey,
      answer: result.prompt.answer,
      answeredAt: result.prompt.answeredAt?.toISOString() ?? null,
    },
  });
});

agentRoutes.post("/sessions/:id/cancel", async (c) => {
  const { workspace } = c.get("auth");
  const session = await cancelSession(workspace.id, c.req.param("id"));
  return c.json({ session: serializeSession(session) });
});
