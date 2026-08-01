import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../db/client.js";
import { idempotencyKeys } from "../db/schema.js";
import { newId } from "./id.js";
import { sha256 } from "./crypto.js";

/**
 * At-least-once delivery is a fact of webhooks and job queues, so every handler
 * with a side effect runs inside `once`. The unique index on (scope, key) is the
 * actual guarantee: two concurrent callers race to insert, and exactly one wins.
 */

export interface OnceResult<T> {
  /** False when a previous run already did the work. */
  executed: boolean;
  value: T;
}

export class DuplicateRequest extends Error {
  constructor(readonly scope: string, readonly key: string) {
    super(`Duplicate request for ${scope}:${key}`);
    this.name = "DuplicateRequest";
  }
}

/**
 * Runs `fn` at most once per (scope, key). A repeat call returns the stored
 * response rather than re-running the work.
 */
export async function once<T extends Record<string, unknown>>(
  options: { scope: string; key: string; workspaceId?: string | null },
  fn: () => Promise<T>,
  db: Database = getDb(),
): Promise<OnceResult<T>> {
  const existing = await findRecord(options.scope, options.key, db);
  if (existing) {
    return { executed: false, value: (existing.responseBody ?? {}) as T };
  }

  // Claim the key before doing the work. If two callers arrive together the
  // loser's insert violates the unique index and it reads the winner's result.
  try {
    await db.insert(idempotencyKeys).values({
      id: newId("idm"),
      workspaceId: options.workspaceId ?? null,
      scope: options.scope,
      key: options.key,
      responseHash: null,
      responseBody: null,
    });
  } catch {
    const winner = await findRecord(options.scope, options.key, db);
    return { executed: false, value: (winner?.responseBody ?? {}) as T };
  }

  let value: T;
  try {
    value = await fn();
  } catch (error) {
    // A failed attempt must be retryable, so the claim is released.
    await db
      .delete(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.scope, options.scope), eq(idempotencyKeys.key, options.key)),
      );
    throw error;
  }

  await db
    .update(idempotencyKeys)
    .set({ responseBody: value, responseHash: sha256(JSON.stringify(value)) })
    .where(and(eq(idempotencyKeys.scope, options.scope), eq(idempotencyKeys.key, options.key)));

  return { executed: true, value };
}

async function findRecord(scope: string, key: string, db: Database) {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
  return row ?? null;
}

/** True when this (scope, key) has already been claimed. */
export async function hasRun(
  scope: string,
  key: string,
  db: Database = getDb(),
): Promise<boolean> {
  return (await findRecord(scope, key, db)) !== null;
}

export function idempotencyKeyFor(parts: (string | number | null | undefined)[]): string {
  return parts.filter((part) => part !== null && part !== undefined).join(":");
}
