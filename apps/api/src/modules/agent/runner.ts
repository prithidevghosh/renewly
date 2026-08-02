import type { Logger } from "pino";
import { and, eq, lt } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  agentSessions,
  type AgentSession,
  type AgentSessionKind,
  type AgentPromptOption,
} from "../../db/schema.js";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";
import type { AuthContext } from "../../types/context.js";
import { resolveAuthContext } from "../auth/service.js";
import {
  appendEvent,
  completeSession,
  failSession,
  getSession,
  isFinished,
  patchState,
  raisePrompt,
  readAnswer,
  stepCompleted,
  stepProgress,
  stepStarted,
} from "./service.js";

/**
 * The thing that actually runs an agent session.
 *
 * Until this existed, `POST /v1/agent/sessions` wrote a row, emitted
 * `session.started` and returned — and nothing ever ran. Sessions sat at
 * `running` with `lastSeq: 1` forever, the SSE stream dutifully tailed an empty
 * log, and the terminal showed a spinner with no second event. The transcript
 * machinery was complete; the part that writes to it was missing.
 *
 * Two properties matter here:
 *
 *   Resumable. Every finished step is recorded in `state.completedSteps`, so a
 *   run that parked on a question — or died with the process — picks up at the
 *   next unfinished step rather than re-reading a mailbox it already read.
 *
 *   Single-writer. A session is driven by at most one loop at a time. Without
 *   the guard, answering a prompt while the previous drive is still winding
 *   down would run two loops over the same steps and double every event.
 */

/** Return this from a step to stop the run cleanly; a question is open. */
export const PARKED = "parked" as const;

export interface StepContext {
  readonly session: AgentSession;
  readonly auth: AuthContext;
  readonly db: Database;
  /** Already bound to this user, workspace, session and step. */
  readonly log: Logger;
  /** Scratch carried between steps, read from `session.state`. */
  readonly state: Record<string, unknown>;

  /** A line in the transcript, optionally with an "N of M" counter. */
  progress(message: string, counts?: { current?: number; total?: number }): Promise<void>;
  /** A plain narration line. */
  say(message: string, level?: "info" | "warn" | "error"): Promise<void>;
  /** Something the run discovered and the UI should surface. */
  found(kind: string, payload: Record<string, unknown>): Promise<void>;
  /**
   * Asks the user something. Returns their answer if it is already in, and
   * `null` after raising the question — a step that gets null must return
   * `PARKED` so the run stops until the answer arrives.
   */
  ask(input: {
    key: string;
    question: string;
    options?: AgentPromptOption[];
    freeText?: boolean;
    skippable?: boolean;
  }): Promise<string | null>;
  /** Merged into session state when the step finishes. */
  keep(patch: Record<string, unknown>): void;
  /** What `step.completed` reports. */
  summarize(payload: Record<string, unknown>): void;
  /** True once the session was cancelled elsewhere; long loops should bail. */
  cancelled(): Promise<boolean>;
}

export interface PipelineStep {
  /** Stable id. Renaming one makes in-flight sessions redo that step. */
  id: string;
  /** Human label, shown as the step's headline in the terminal. */
  label: string;
  run(ctx: StepContext): Promise<void | typeof PARKED>;
}

export type Pipeline = PipelineStep[];

/**
 * Loaded on first use rather than imported at the top, because the pipelines
 * import the step contract from this file. Same trick the mailbox registry uses
 * for its provider clients: a dynamic import breaks the cycle at module-eval
 * time without a registration step that someone can forget to call.
 */
async function pipelineFor(kind: AgentSessionKind): Promise<Pipeline | undefined> {
  const { PIPELINES } = await import("./pipelines.js");
  return (PIPELINES as Partial<Record<AgentSessionKind, Pipeline>>)[kind];
}

/* -------------------------------------------------------------------------- */
/* Logging                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One tag that says whose agent is talking: `detect·ada@example.com·a1b2c3d4`.
 *
 * The email is the part a person scans for, the short session id is what
 * distinguishes two runs by the same user, and pino-pretty renders the whole
 * thing as a prefix so a line reads as a sentence rather than a bag of fields.
 * The full ids stay on the object for grepping.
 */
function bindLogger(session: AgentSession, auth: AuthContext): Logger {
  return logger.child({
    agentTag: `${session.kind}·${auth.user.email}·${session.id.slice(-8)}`,
    sessionId: session.id,
    kind: session.kind,
    userId: auth.user.id,
    userEmail: auth.user.email,
    workspaceId: session.workspaceId,
  });
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

/** Sessions with a live drive loop in this process. */
const driving = new Set<string>();

/**
 * Off under test for the same reason the worker loop is: a run that starts
 * itself the moment a route returns makes every assertion about the transcript
 * a race against it. Tests call `runSession` directly and await it, or opt back
 * in when the detached path is the thing under test.
 */
let autoKickoff = env.NODE_ENV !== "test";

export function setAutoKickoff(enabled: boolean): void {
  autoKickoff = enabled;
}

/**
 * Starts a run without making the caller wait for it.
 *
 * The HTTP request that starts a session must return the session immediately —
 * the client needs the id to open the stream, and the run itself takes as long
 * as reading a mailbox takes. Failures are handled inside `drive`, so the catch
 * here is only for the pathological case of the driver itself throwing.
 */
export function kickoff(session: AgentSession): void {
  if (!autoKickoff) return;
  void runSession(session.id, session.workspaceId).catch((error: unknown) => {
    logger.error(
      { err: error, sessionId: session.id, kind: session.kind },
      "agent driver crashed outside its own error handling",
    );
  });
}

export async function runSession(
  sessionId: string,
  workspaceId: string,
  db: Database = getDb(),
): Promise<void> {
  if (driving.has(sessionId)) return;
  driving.add(sessionId);
  try {
    await drive(sessionId, workspaceId, db);
  } finally {
    driving.delete(sessionId);
  }
}

/** True while this process is running the session. Tests wait on it. */
export const isDriving = (sessionId: string): boolean => driving.has(sessionId);

/**
 * A run only exists inside the process that is driving it, so a restart leaves
 * `running` rows that nobody owns. They are indistinguishable from a live run
 * to the terminal, which reattaches to the newest session and waits forever on
 * a stream that will never emit — exactly the shape of the bug this driver was
 * written to fix, arriving by a different route.
 *
 * Reaped by staleness rather than "everything running at boot", so a second API
 * instance does not shoot down the first one's work. `awaiting_input` is left
 * alone: it is parked on a person, not on a process, and resumes on an answer.
 */
export async function reapStaleSessions(
  db: Database = getDb(),
  olderThanMs = 10 * 60_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);

  const stale = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.status, "running"), lt(agentSessions.updatedAt, cutoff)));

  for (const session of stale) {
    await failSession(
      session,
      new Error("This run stopped when the server restarted. Start a new one."),
      db,
    );
    logger.warn(
      { sessionId: session.id, kind: session.kind, workspaceId: session.workspaceId },
      `reaped an abandoned ${session.kind} run from before the restart`,
    );
  }

  if (stale.length > 0) {
    logger.info({ reaped: stale.length }, `closed ${stale.length} abandoned agent run(s)`);
  }
  return stale.length;
}

async function drive(sessionId: string, workspaceId: string, db: Database): Promise<void> {
  let session = await getSession(workspaceId, sessionId, db);
  if (isFinished(session)) return;

  const pipeline = await pipelineFor(session.kind);
  const auth = await resolveAuthContext(session.userId, session.workspaceId, db);
  const log = bindLogger(session, auth);

  if (!pipeline || pipeline.length === 0) {
    log.error({ kind: session.kind }, `no pipeline is registered for a ${session.kind} run`);
    await failSession(session, new Error(`No pipeline is registered for "${session.kind}" runs`), db);
    return;
  }

  const done = new Set(completedSteps(session));
  log.info(
    { steps: pipeline.length, resuming: done.size },
    done.size > 0
      ? `resuming — ${done.size} of ${pipeline.length} steps already done`
      : `starting — ${pipeline.length} steps`,
  );

  const summary: Record<string, unknown> = {};

  for (const step of pipeline) {
    if (done.has(step.id)) continue;

    // Re-read rather than trust the cached row: a cancel or an answer may have
    // landed while the previous step was running.
    session = await getSession(workspaceId, sessionId, db);
    if (isFinished(session)) {
      log.info({ status: session.status }, `stopping — the session is ${session.status}`);
      return;
    }

    const stepLog = log.child({ step: step.id });
    const started = Date.now();
    await stepStarted(session, step.id, step.label, db);

    const patch: Record<string, unknown> = {};
    let stepSummary: Record<string, unknown> = {};
    const ctx = makeContext(session, auth, db, stepLog, step.id, patch, (value) => {
      stepSummary = value;
    });

    let outcome: void | typeof PARKED;
    try {
      outcome = await step.run(ctx);
    } catch (error) {
      stepLog.error({ err: error }, `failed at ${step.id} — ${describe(error)}`);
      await failSession(session, error, db);
      return;
    }

    if (outcome === PARKED) {
      // Persist what the step learned before it asked, or the answer would
      // arrive to a run that had forgotten why it asked.
      if (Object.keys(patch).length > 0) await patchState(sessionId, patch, db);
      stepLog.info(`parked at ${step.id} — waiting for the user to answer`);
      return;
    }

    done.add(step.id);
    await patchState(sessionId, { ...patch, completedSteps: [...done] }, db);
    await stepCompleted(session, step.id, stepSummary, db);
    Object.assign(summary, stepSummary);

    stepLog.info(
      { ...stepSummary, durationMs: Date.now() - started },
      `${step.id} done in ${Date.now() - started}ms${describeSummary(stepSummary)}`,
    );
  }

  session = await getSession(workspaceId, sessionId, db);
  if (isFinished(session)) return;
  await completeSession(session, summary, db);
  log.info(summary, `run complete${describeSummary(summary)}`);
}

function makeContext(
  session: AgentSession,
  auth: AuthContext,
  db: Database,
  log: Logger,
  step: string,
  patch: Record<string, unknown>,
  setSummary: (value: Record<string, unknown>) => void,
): StepContext {
  return {
    session,
    auth,
    db,
    log,
    state: session.state,

    async progress(message, counts) {
      log.info(counts ?? {}, message);
      await stepProgress(session, step, { message, ...(counts ?? {}) }, db);
    },

    async say(message, level = "info") {
      log[level](message);
      await appendEvent({ session, type: "log", step, payload: { message, level }, db });
    },

    async found(kind, payload) {
      log.info({ finding: kind, ...payload }, `found ${kind}${describeSummary(payload)}`);
      await appendEvent({ session, type: "finding", step, payload: { kind, ...payload }, db });
    },

    async ask(input) {
      const existing = await readAnswer(session.id, input.key, db);
      if (existing !== null) return existing;
      await raisePrompt({
        session,
        promptKey: input.key,
        question: input.question,
        step,
        ...(input.options ? { options: input.options } : {}),
        ...(input.freeText === undefined ? {} : { freeText: input.freeText }),
        ...(input.skippable === undefined ? {} : { skippable: input.skippable }),
        db,
      });
      return null;
    },

    keep(next) {
      Object.assign(patch, next);
    },

    summarize(payload) {
      setSummary(payload);
    },

    async cancelled() {
      const fresh = await getSession(session.workspaceId, session.id, db);
      return isFinished(fresh);
    },
  };
}

function completedSteps(session: AgentSession): string[] {
  const raw = session.state.completedSteps;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** " — found: 12 · saas: 9", or "" when there is nothing worth appending. */
function describeSummary(payload: Record<string, unknown>): string {
  const parts = Object.entries(payload)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
}
