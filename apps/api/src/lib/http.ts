import type { Context } from "hono";
import { z, type ZodTypeAny } from "zod";
import { validationError } from "./errors.js";

/**
 * Parse a JSON body against a schema, mapping Zod issues to VALIDATION_ERROR.
 *
 * An absent body is passed through as `undefined` rather than rejected, so a
 * schema carrying a `.default()` still applies it. Several action endpoints take
 * no body at all in the common case.
 */
export async function readJson<T extends ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  if (text.trim() === "") return parseWith(schema, undefined);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw validationError("Request body must be valid JSON");
  }
  return parseWith(schema, raw);
}

export function parseWith<T extends ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw validationError("Request failed validation", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function readQuery<T extends ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query());
}

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * IDs are ULIDs, so "cursor" is simply the last id seen and paging is a
 * descending id scan. Stable under concurrent inserts.
 */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.length > 0 ? data[data.length - 1] : undefined;
  return { data, nextCursor: hasMore && last ? last.id : null };
}

export const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .transform((value) => new Date(value));

export const decimalString = z
  .string()
  .regex(/^-?\d{1,15}(\.\d{1,6})?$/, "must be a decimal string such as \"20.00\"");

export const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());
