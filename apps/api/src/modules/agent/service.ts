import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  agentEvents,
  agentPrompts,
  agentSessions,
  type AgentEvent,
  type AgentEventType,
  type AgentPrompt,
  type AgentPromptOption,
  type AgentSession,
  type AgentSessionKind,
} from "../../db/schema.js";
import { AppError, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";

/**
 * The agent's transcript.
 *
 * Everything the terminal shows is an event in an append-only log with a
 * gap-free per-session sequence number. That one property buys three things
 * that a socket pushing ad-hoc frames cannot: a reconnecting client can say
 * "I have up to 41" and be certain it missed nothing, two tabs can watch the
 * same run, and a session that dies mid-step resumes without replaying work.
 *
 * The agent never writes to a connection. It writes rows; the stream tails them.
 */

/** Terminal statuses — a session in one of these will emit no further events. */
const FINISHED = ["completed", "failed", "cancelled"] as const;

export const isFinished = (session: AgentSession): boolean =>
  (FINISHED as readonly string[]).includes(session.status);

export interface StartSessionInput {
  workspaceId: string;
  userId: string;
  kind: AgentSessionKind;
  state?: Record<string, unknown>;
  db?: Database;
}

export async function startSession(input: StartSessionInput): Promise<AgentSession> {
  const db = input.db ?? getDb();

  const [session] = await db
    .insert(agentSessions)
    .values({
      id: newId("ags"),
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: input.kind,
      status: "running",
      state: input.state ?? {},
    })
    .returning();
  if (!session) throw new Error("agent session insert returned no row");

  await appendEvent({
    session,
    type: "session.started",
    payload: { kind: input.kind, sessionId: session.id },
    db,
  });

  return session;
}

export interface AppendEventInput {
  session: AgentSession;
  type: AgentEventType;
  payload?: Record<string, unknown>;
  step?: string;
  db?: Database;
}

/**
 * Allocates the next sequence number and writes the event.
 *
 * The allocation is `last_seq = last_seq + 1 RETURNING`, which Postgres performs
 * under a row lock, so two concurrent writers on the same session get 7 and 8
 * rather than both getting 7. The unique index on (session_id, seq) is the
 * backstop if that reasoning is ever wrong.
 */
export async function appendEvent(input: AppendEventInput): Promise<AgentEvent> {
  const db = input.db ?? getDb();

  const [bumped] = await db
    .update(agentSessions)
    .set({ lastSeq: sql`${agentSessions.lastSeq} + 1`, updatedAt: new Date() })
    .where(eq(agentSessions.id, input.session.id))
    .returning({ seq: agentSessions.lastSeq });
  if (!bumped) throw notFound("Agent session");

  const [event] = await db
    .insert(agentEvents)
    .values({
      id: newId("age"),
      sessionId: input.session.id,
      workspaceId: input.session.workspaceId,
      seq: bumped.seq,
      type: input.type,
      step: input.step ?? null,
      payload: input.payload ?? {},
    })
    .returning();
  if (!event) throw new Error("agent event insert returned no row");

  return event;
}

/* -------------------------------------------------------------------------- */
/* Step helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Thin wrappers so a pipeline step narrates itself in one line each. They exist
 * to keep the event vocabulary consistent — a step that invents its own type
 * names is a step the terminal cannot render.
 */

export async function stepStarted(
  session: AgentSession,
  step: string,
  label: string,
  db?: Database,
): Promise<AgentEvent> {
  const patch: Partial<typeof agentSessions.$inferInsert> = {
    currentStep: step,
    updatedAt: new Date(),
  };
  await (db ?? getDb()).update(agentSessions).set(patch).where(eq(agentSessions.id, session.id));
  return appendEvent({ session, type: "step.started", step, payload: { label }, ...(db ? { db } : {}) });
}

export async function stepProgress(
  session: AgentSession,
  step: string,
  payload: { message: string; current?: number; total?: number },
  db?: Database,
): Promise<AgentEvent> {
  return appendEvent({
    session,
    type: "step.progress",
    step,
    payload: { ...payload },
    ...(db ? { db } : {}),
  });
}

export async function stepCompleted(
  session: AgentSession,
  step: string,
  payload: Record<string, unknown> = {},
  db?: Database,
): Promise<AgentEvent> {
  return appendEvent({ session, type: "step.completed", step, payload, ...(db ? { db } : {}) });
}

export async function log(
  session: AgentSession,
  message: string,
  level: "info" | "warn" | "error" = "info",
  db?: Database,
): Promise<AgentEvent> {
  return appendEvent({ session, type: "log", payload: { message, level }, ...(db ? { db } : {}) });
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

export interface RaisePromptInput {
  session: AgentSession;
  promptKey: string;
  question: string;
  options?: AgentPromptOption[];
  freeText?: boolean;
  skippable?: boolean;
  step?: string;
  expiresAt?: Date;
  db?: Database;
}

/**
 * Asks the user something and parks the run. The session goes to
 * `awaiting_input`, which is what the worker checks before picking a job back
 * up — a parked session must never be resumed by a scheduler that only looked
 * at "is it running".
 */
export async function raisePrompt(input: RaisePromptInput): Promise<AgentPrompt> {
  const db = input.db ?? getDb();

  const existing = await findPrompt(input.session.id, input.promptKey, db);
  // Re-asking is how a resumed step behaves; return the open question rather
  // than raising a second one the user would see twice.
  if (existing && !existing.answeredAt) return existing;
  if (existing?.answeredAt) {
    throw new AppError("CONFLICT", "That question has already been answered", {
      promptKey: input.promptKey,
    });
  }

  const event = await appendEvent({
    session: input.session,
    type: "prompt",
    ...(input.step ? { step: input.step } : {}),
    payload: {
      promptKey: input.promptKey,
      question: input.question,
      options: input.options ?? [],
      freeText: input.freeText ?? false,
      skippable: input.skippable ?? false,
    },
    db,
  });

  const [prompt] = await db
    .insert(agentPrompts)
    .values({
      id: newId("agp"),
      sessionId: input.session.id,
      workspaceId: input.session.workspaceId,
      eventSeq: event.seq,
      promptKey: input.promptKey,
      question: input.question,
      options: input.options ?? [],
      freeText: input.freeText ?? false,
      skippable: input.skippable ?? false,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!prompt) throw new Error("agent prompt insert returned no row");

  await db
    .update(agentSessions)
    .set({ status: "awaiting_input", updatedAt: new Date() })
    .where(eq(agentSessions.id, input.session.id));

  return prompt;
}

export interface AnswerPromptInput {
  workspaceId: string;
  sessionId: string;
  promptKey?: string;
  answer: string;
  db?: Database;
}

export interface AnswerPromptResult {
  prompt: AgentPrompt;
  session: AgentSession;
}

/**
 * Records the user's answer and unparks the run. `promptKey` is optional
 * because a terminal answering the question it is currently showing should not
 * have to name it; when omitted the single open prompt is used, and an
 * ambiguous state is an error rather than a guess.
 */
export async function answerPrompt(input: AnswerPromptInput): Promise<AnswerPromptResult> {
  const db = input.db ?? getDb();
  const session = await getSession(input.workspaceId, input.sessionId, db);

  if (isFinished(session)) {
    throw new AppError("CONFLICT", `Session is already ${session.status}`, {
      sessionId: session.id,
    });
  }

  const open = await listOpenPrompts(session.id, db);
  if (open.length === 0) {
    throw new AppError("CONFLICT", "This session is not waiting for an answer", {
      sessionId: session.id,
    });
  }

  const prompt = input.promptKey
    ? open.find((row) => row.promptKey === input.promptKey)
    : open.length === 1
      ? open[0]
      : undefined;

  if (!prompt) {
    throw new AppError(
      "VALIDATION_ERROR",
      input.promptKey
        ? "No open question with that key"
        : "Several questions are open; name one with promptKey",
      { open: open.map((row) => row.promptKey) },
    );
  }

  if (prompt.expiresAt && prompt.expiresAt.getTime() <= Date.now()) {
    throw new AppError("APPROVAL_EXPIRED", "That question has expired", {
      promptKey: prompt.promptKey,
    });
  }

  // A closed option set means the answer has to be one of them; free text and
  // an explicit skip are the two ways out.
  const skipped = prompt.skippable && input.answer.trim().toLowerCase() === "skip";
  if (!skipped && !prompt.freeText && prompt.options.length > 0) {
    const allowed = prompt.options.some((option) => option.value === input.answer);
    if (!allowed) {
      throw new AppError("VALIDATION_ERROR", "Answer is not one of the offered options", {
        promptKey: prompt.promptKey,
        options: prompt.options.map((option) => option.value),
      });
    }
  }

  const [answered] = await db
    .update(agentPrompts)
    .set({ answer: input.answer, answeredAt: new Date() })
    .where(and(eq(agentPrompts.id, prompt.id), isNull(agentPrompts.answeredAt)))
    .returning();
  // Lost a race with another client answering the same question first.
  if (!answered) {
    throw new AppError("CONFLICT", "That question was just answered", {
      promptKey: prompt.promptKey,
    });
  }

  await appendEvent({
    session,
    type: "prompt.answered",
    ...(prompt.eventSeq ? { step: session.currentStep ?? undefined } : {}),
    payload: { promptKey: prompt.promptKey, answer: input.answer, skipped },
    db,
  });

  // Only resume if nothing else is still blocking.
  const remaining = await listOpenPrompts(session.id, db);
  const [resumed] = await db
    .update(agentSessions)
    .set({
      status: remaining.length > 0 ? "awaiting_input" : "running",
      updatedAt: new Date(),
    })
    .where(eq(agentSessions.id, session.id))
    .returning();

  return { prompt: answered, session: resumed ?? session };
}

export async function findPrompt(
  sessionId: string,
  promptKey: string,
  db: Database = getDb(),
): Promise<AgentPrompt | null> {
  const [row] = await db
    .select()
    .from(agentPrompts)
    .where(and(eq(agentPrompts.sessionId, sessionId), eq(agentPrompts.promptKey, promptKey)));
  return row ?? null;
}

export async function listOpenPrompts(
  sessionId: string,
  db: Database = getDb(),
): Promise<AgentPrompt[]> {
  return db
    .select()
    .from(agentPrompts)
    .where(and(eq(agentPrompts.sessionId, sessionId), isNull(agentPrompts.answeredAt)))
    .orderBy(asc(agentPrompts.eventSeq));
}

/** The answer a step is waiting on, or null if it has not arrived yet. */
export async function readAnswer(
  sessionId: string,
  promptKey: string,
  db: Database = getDb(),
): Promise<string | null> {
  const prompt = await findPrompt(sessionId, promptKey, db);
  return prompt?.answeredAt ? prompt.answer : null;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

export async function completeSession(
  session: AgentSession,
  summary: Record<string, unknown> = {},
  db: Database = getDb(),
): Promise<AgentSession> {
  await appendEvent({ session, type: "session.completed", payload: summary, db });
  return setTerminal(session.id, "completed", null, db);
}

export async function failSession(
  session: AgentSession,
  error: unknown,
  db: Database = getDb(),
): Promise<AgentSession> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";

  await appendEvent({
    session,
    type: "session.failed",
    payload: { message, code },
    db,
  });
  return setTerminal(session.id, "failed", message, db);
}

export async function cancelSession(
  workspaceId: string,
  sessionId: string,
  db: Database = getDb(),
): Promise<AgentSession> {
  const session = await getSession(workspaceId, sessionId, db);
  if (isFinished(session)) return session;

  await appendEvent({ session, type: "session.completed", payload: { cancelled: true }, db });
  return setTerminal(session.id, "cancelled", null, db);
}

async function setTerminal(
  sessionId: string,
  status: "completed" | "failed" | "cancelled",
  error: string | null,
  db: Database,
): Promise<AgentSession> {
  const [row] = await db
    .update(agentSessions)
    .set({ status, error, endedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentSessions.id, sessionId))
    .returning();
  if (!row) throw notFound("Agent session");
  return row;
}

/** Merges into the scratch state a resumed run reads back. */
export async function patchState(
  sessionId: string,
  patch: Record<string, unknown>,
  db: Database = getDb(),
): Promise<void> {
  const [current] = await db
    .select({ state: agentSessions.state })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId));
  if (!current) throw notFound("Agent session");

  await db
    .update(agentSessions)
    .set({ state: { ...current.state, ...patch }, updatedAt: new Date() })
    .where(eq(agentSessions.id, sessionId));
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export async function getSession(
  workspaceId: string,
  sessionId: string,
  db: Database = getDb(),
): Promise<AgentSession> {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.workspaceId, workspaceId)));
  if (!row) throw notFound("Agent session");
  return row;
}

/** Events after `afterSeq`, oldest first. `afterSeq = 0` replays from the start. */
export async function readEvents(
  sessionId: string,
  afterSeq: number,
  limit = 500,
  db: Database = getDb(),
): Promise<AgentEvent[]> {
  return db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, sessionId), gt(agentEvents.seq, afterSeq)))
    .orderBy(asc(agentEvents.seq))
    .limit(limit);
}

/** The newest session for a workspace, which is what a terminal reattaches to. */
export async function latestSession(
  workspaceId: string,
  db: Database = getDb(),
): Promise<AgentSession | null> {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.workspaceId, workspaceId));
  if (rows.length === 0) return null;
  // Ids are ULIDs, so the lexicographic maximum is the most recent.
  return rows.reduce((latest, row) => (row.id > latest.id ? row : latest));
}
