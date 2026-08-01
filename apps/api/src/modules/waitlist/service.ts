import { count, eq, lte } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb, type Database } from "../../db/client.js";
import { waitlistEntries, type WaitlistEntry } from "../../db/schema.js";
import { env } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import { logger } from "../../lib/logger.js";
import { sendEmail } from "../../lib/mailer.js";
import { renderWaitlistNotice } from "./noticeEmail.js";
import { renderWaitlistWelcome } from "./welcomeEmail.js";

/**
 * Joining the waitlist is public and unauthenticated, which shapes every
 * decision here:
 *
 * - The address is the identity, so a repeat submission updates nothing and
 *   returns the original place in line. Someone who forgets they signed up
 *   should not be moved to the back, and must not be mailed twice. The reply
 *   does say the address was already on the list, which does disclose
 *   membership; for a pre-launch waitlist that is worth a form that can tell
 *   the truth, and it is the one place in this API where that trade is made.
 *
 * - Success means the whole loop finished: row written, position assigned,
 *   welcome delivered, internal notice delivered. Anything short of that is an
 *   error, so the caller is never told a signup completed when nobody was
 *   mailed.
 *
 * The row is kept even when the mail step fails. Deleting it would turn a
 * provider outage into a lost signup, and the two timestamps mean the next
 * attempt sends only what has not gone out yet — so a retry finishes the loop
 * rather than repeating it.
 */

export interface JoinWaitlistInput {
  email: string;
  name?: string;
  source?: string;
  referrer?: string;
}

export interface JoinWaitlistResult {
  entry: WaitlistEntry;
  /** 1-based, counting every entry created no later than this one. */
  position: number;
  alreadyJoined: boolean;
}

export async function joinWaitlist(
  input: JoinWaitlistInput,
  db: Database = getDb(),
  log: Logger = logger,
): Promise<JoinWaitlistResult> {
  const email = normalizeEmail(input.email);
  log.info(
    {
      email,
      normalizedFrom: input.email === email ? undefined : input.email,
      // Not `name`: pino reserves that for the logger's own name, and a
      // pretty-printed line would render it as "INFO (Ada Lovelace)".
      signupName: input.name ?? null,
      source: input.source ?? "web",
      referrer: input.referrer ?? null,
    },
    "waitlist join starting",
  );

  const existing = await findByEmail(email, db);
  if (existing) {
    const position = await positionOf(existing, db);

    // Already complete: nothing to send, nothing to change.
    if (existing.mailStatus === "sent") {
      log.info(
        { waitlistId: existing.id, email, position, joinedAt: existing.createdAt },
        "waitlist address already on the list — loop already complete, sending nothing",
      );
      return { entry: existing, position, alreadyJoined: true };
    }

    // A previous attempt did not finish. Finish it, or fail again.
    log.warn(
      {
        waitlistId: existing.id,
        email,
        position,
        mailStatus: existing.mailStatus,
        welcomeSentAt: existing.welcomeSentAt,
        noticeSentAt: existing.noticeSentAt,
        lastError: existing.mailError,
      },
      "waitlist address present but loop unfinished — resuming",
    );
    const entry = await deliver(existing, position, db, log);
    return { entry, position, alreadyJoined: true };
  }

  const created = await insertEntry({ email, input }, db);
  const position = await positionOf(created.entry, db);

  if (created.raced) {
    log.warn(
      { waitlistId: created.entry.id, email, mailStatus: created.entry.mailStatus },
      "waitlist insert lost a race — another request already claimed this address",
    );
    if (created.entry.mailStatus === "sent") {
      return { entry: created.entry, position, alreadyJoined: true };
    }
  } else {
    log.info(
      {
        waitlistId: created.entry.id,
        email,
        position,
        source: created.entry.source,
        referrer: created.entry.referrer,
      },
      "waitlist row inserted",
    );
  }

  const entry = await deliver(created.entry, position, db, log);
  log.info(
    { waitlistId: entry.id, email, position, source: entry.source },
    "waitlist signup complete — row written, both mails delivered",
  );
  return { entry, position, alreadyJoined: created.raced };
}

async function insertEntry(
  args: { email: string; input: JoinWaitlistInput },
  db: Database,
): Promise<{ entry: WaitlistEntry; raced: boolean }> {
  const values = {
    id: newId("wlt"),
    email: args.email,
    name: args.input.name?.trim() || null,
    source: args.input.source?.trim() || "web",
    referrer: args.input.referrer?.trim() || null,
  };

  try {
    const [row] = await db.insert(waitlistEntries).values(values).returning();
    if (!row) throw new Error("waitlist insert returned no row");
    return { entry: row, raced: false };
  } catch (error) {
    // Two submissions of the same address in flight at once: the unique index
    // decides, and the loser reads back the winner's row.
    const winner = await findByEmail(args.email, db);
    if (!winner) throw error;
    return { entry: winner, raced: true };
  }
}

/**
 * Sends whatever the row still owes — the welcome note, then the internal
 * notice — and stamps each one as it lands. Throws if either fails, having
 * first recorded why, so the response can never claim a signup that nobody
 * was told about.
 */
async function deliver(
  entry: WaitlistEntry,
  position: number,
  db: Database,
  log: Logger = logger,
): Promise<WaitlistEntry> {
  let welcomeSentAt = entry.welcomeSentAt;
  let noticeSentAt = entry.noticeSentAt;
  // Named so the failure log says which message went missing.
  let stage: "welcome" | "notice" = "welcome";

  try {
    if (welcomeSentAt) {
      log.info(
        { waitlistId: entry.id, welcomeSentAt },
        "waitlist welcome already delivered — skipping",
      );
    } else {
      const welcome = renderWaitlistWelcome({
        email: entry.email,
        name: entry.name,
        position,
      });
      const result = await sendEmail(
        {
          to: entry.email,
          subject: welcome.subject,
          html: welcome.html,
          text: welcome.text,
        },
        log,
      );
      welcomeSentAt = new Date();
      log.info(
        { waitlistId: entry.id, to: entry.email, messageId: result.id, mode: result.mode },
        "waitlist welcome delivered",
      );
    }

    stage = "notice";

    if (noticeSentAt) {
      log.info({ waitlistId: entry.id, noticeSentAt }, "waitlist notice already delivered — skipping");
    } else {
      const notice = renderWaitlistNotice({
        email: entry.email,
        name: entry.name,
        source: entry.source,
        referrer: entry.referrer,
        position,
        joinedAt: entry.createdAt,
      });
      const result = await sendEmail(
        {
          to: env.WAITLIST_NOTIFY_TO,
          subject: notice.subject,
          html: notice.html,
          text: notice.text,
          replyTo: entry.email,
        },
        log,
      );
      noticeSentAt = new Date();
      log.info(
        {
          waitlistId: entry.id,
          to: env.WAITLIST_NOTIFY_TO,
          messageId: result.id,
          mode: result.mode,
        },
        "waitlist notice delivered",
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(
      {
        err: error,
        waitlistId: entry.id,
        email: entry.email,
        stage,
        reason,
        details: error instanceof AppError ? error.details : undefined,
        welcomeSentAt,
        noticeSentAt,
      },
      `waitlist ${stage} mail failed — signup will be reported as an error`,
    );

    // Persist how far we got before failing, so the retry resumes here.
    await patch(
      entry.id,
      {
        mailStatus: "failed",
        mailError: reason.slice(0, 1000),
        welcomeSentAt,
        noticeSentAt,
      },
      entry,
      db,
    );

    throw error instanceof AppError
      ? error
      : new AppError("CHANNEL_SEND_FAILED", "Could not send the waitlist email", {
          cause: reason,
        });
  }

  const done = await patch(
    entry.id,
    { mailStatus: "sent", mailError: null, welcomeSentAt, noticeSentAt },
    entry,
    db,
  );
  log.debug(
    { waitlistId: done.id, mailStatus: done.mailStatus, welcomeSentAt, noticeSentAt },
    "waitlist mail state persisted",
  );
  return done;
}

async function patch(
  id: string,
  values: Partial<typeof waitlistEntries.$inferInsert>,
  fallback: WaitlistEntry,
  db: Database,
): Promise<WaitlistEntry> {
  const [row] = await db
    .update(waitlistEntries)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(waitlistEntries.id, id))
    .returning();
  return row ?? fallback;
}

async function findByEmail(email: string, db: Database): Promise<WaitlistEntry | undefined> {
  const [row] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.email, email));
  return row;
}

/** Ids are ULIDs, so "created no later than this one" is an id comparison. */
async function positionOf(entry: WaitlistEntry, db: Database): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(waitlistEntries)
    .where(lte(waitlistEntries.id, entry.id));
  return Number(row?.value ?? 1);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
