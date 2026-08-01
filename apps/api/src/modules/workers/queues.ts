import { and, asc, eq, lte } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { jobs, type Job, type JobType } from "../../db/schema.js";
import { newId } from "../../lib/id.js";
import { logger } from "../../lib/logger.js";

/**
 * A jobs table rather than Redis. V1 runs as a single process and the work is
 * low-volume; a database queue means one fewer service to operate and the job
 * state is visible in the same place as the data it acts on.
 *
 * Delivery is at-least-once, so every processor must be idempotent.
 */

export interface EnqueueInput {
  type: JobType;
  payload?: Record<string, unknown>;
  workspaceId?: string | null;
  runAt?: Date;
  /** Collapses repeat enqueues of the same logical work. */
  dedupeKey?: string | null;
  maxAttempts?: number;
}

export async function enqueueJob(
  input: EnqueueInput,
  db: Database = getDb(),
): Promise<{ id: string; deduped: boolean }> {
  if (input.dedupeKey) {
    const [existing] = await db.select().from(jobs).where(eq(jobs.dedupeKey, input.dedupeKey));
    if (existing) return { id: existing.id, deduped: true };
  }

  const [row] = await db
    .insert(jobs)
    .values({
      id: newId("job"),
      workspaceId: input.workspaceId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      status: "pending",
      runAt: input.runAt ?? new Date(),
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? 5,
    })
    .returning();
  if (!row) throw new Error("job insert returned no row");

  return { id: row.id, deduped: false };
}

/**
 * Claims one due job. The compare-and-set on status is what keeps two workers
 * from running the same job; a single process does not need it, but a second
 * instance would, and getting it wrong later is expensive.
 */
export async function claimNextJob(
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<Job | null> {
  const candidates = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, now)))
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .limit(5);

  for (const candidate of candidates) {
    const [claimed] = await db
      .update(jobs)
      .set({ status: "running", attempts: candidate.attempts + 1, updatedAt: new Date() })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "pending")))
      .returning();
    if (claimed) return claimed;
  }

  return null;
}

export async function completeJob(id: string, db: Database = getDb()): Promise<void> {
  await db.update(jobs).set({ status: "done", updatedAt: new Date() }).where(eq(jobs.id, id));
}

/** Exponential backoff, then park the job as failed for a human to look at. */
export async function failJob(
  job: Job,
  error: unknown,
  db: Database = getDb(),
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  const backoffMs = Math.min(60_000, 2 ** job.attempts * 500);

  await db
    .update(jobs)
    .set({
      status: exhausted ? "failed" : "pending",
      lastError: message.slice(0, 1000),
      runAt: new Date(Date.now() + backoffMs),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));

  logger.warn(
    { jobId: job.id, type: job.type, attempts: job.attempts, exhausted },
    "job attempt failed",
  );
}

export async function listJobs(
  options: { status?: Job["status"]; limit?: number } = {},
  db: Database = getDb(),
): Promise<Job[]> {
  const filters = options.status ? [eq(jobs.status, options.status)] : [];
  return db
    .select()
    .from(jobs)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(jobs.id))
    .limit(options.limit ?? 100);
}
