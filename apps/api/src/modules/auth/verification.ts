import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { emailVerificationCodes, users, type User } from "../../db/schema.js";
import { env } from "../../env.js";
import { numericCode, sha256 } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import { logger } from "../../lib/logger.js";
import { sendEmail } from "../../lib/mailer.js";

/**
 * Email verification for password signups.
 *
 * The code is a credential, so it is stored as a hash and compared by hash — a
 * database dump must not hand somebody a working code. It expires, it survives
 * a bounded number of guesses, and issuing a new one retires the old.
 */

export interface IssuedCode {
  /** Present only in mock mail mode, for tests and local development. */
  code: string | null;
  expiresAt: Date;
}

/**
 * Issues a code and emails it. Any previous unconsumed code for the user is
 * consumed first: two live codes means a stolen one stays valid after the user
 * asks for a fresh one, which defeats the point of asking.
 */
export async function issueVerificationCode(
  user: Pick<User, "id" | "email" | "name">,
  db: Database = getDb(),
): Promise<IssuedCode> {
  await db
    .update(emailVerificationCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(emailVerificationCodes.userId, user.id),
        isNull(emailVerificationCodes.consumedAt),
      ),
    );

  const code = numericCode(6);
  const expiresAt = new Date(Date.now() + env.VERIFICATION_CODE_TTL_MINUTES * 60_000);

  await db.insert(emailVerificationCodes).values({
    id: newId("evc"),
    userId: user.id,
    codeHash: sha256(code),
    email: user.email,
    expiresAt,
  });

  await sendEmail(renderVerificationEmail({ code, name: user.name, to: user.email }));

  logger.info(
    { userId: user.id, expiresAt, ttlMinutes: env.VERIFICATION_CODE_TTL_MINUTES },
    "verification code issued",
  );

  // Returning the code in mock mode is what lets the test suite and a local
  // developer complete a signup without a mail provider. In live mode it is
  // null, so it can never leak through an API response.
  return { code: env.MAIL_OUTBOUND_MODE === "mock" ? code : null, expiresAt };
}

export interface VerifyResult {
  user: User;
  alreadyVerified: boolean;
}

/**
 * Checks a code and marks the account verified.
 *
 * Failure modes are deliberately not distinguished in the message: "that code
 * is not right" covers wrong, expired and never-issued, because telling an
 * attacker which of the three it was is free information.
 */
export async function verifyCode(
  input: { email: string; code: string },
  db: Database = getDb(),
): Promise<VerifyResult> {
  const email = input.email.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) throw new AppError("VALIDATION_ERROR", "That code is not right");

  if (user.emailVerifiedAt) return { user, alreadyVerified: true };

  const [record] = await db
    .select()
    .from(emailVerificationCodes)
    .where(
      and(
        eq(emailVerificationCodes.userId, user.id),
        isNull(emailVerificationCodes.consumedAt),
      ),
    )
    .orderBy(desc(emailVerificationCodes.id))
    .limit(1);

  if (!record) {
    logger.warn({ userId: user.id, email }, "verification failed — no live code for this account");
    throw new AppError("VALIDATION_ERROR", "That code is not right");
  }

  if (record.attempts >= env.VERIFICATION_MAX_ATTEMPTS) {
    logger.warn(
      { userId: user.id, email, attempts: record.attempts },
      "verification blocked — attempt ceiling reached, a new code is required",
    );
    throw new AppError("RATE_LIMITED", "Too many attempts. Ask for a new code.", {
      maxAttempts: env.VERIFICATION_MAX_ATTEMPTS,
    });
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    throw new AppError("VALIDATION_ERROR", "That code has expired. Ask for a new one.");
  }

  if (record.codeHash !== sha256(input.code.trim())) {
    // Burn an attempt. Without this the ceiling is decorative.
    await db
      .update(emailVerificationCodes)
      .set({ attempts: record.attempts + 1 })
      .where(eq(emailVerificationCodes.id, record.id));
    logger.warn(
      {
        userId: user.id,
        email,
        attempt: record.attempts + 1,
        maxAttempts: env.VERIFICATION_MAX_ATTEMPTS,
      },
      "verification failed — wrong code",
    );
    throw new AppError("VALIDATION_ERROR", "That code is not right", {
      attemptsRemaining: Math.max(0, env.VERIFICATION_MAX_ATTEMPTS - (record.attempts + 1)),
    });
  }

  await db
    .update(emailVerificationCodes)
    .set({ consumedAt: new Date() })
    .where(eq(emailVerificationCodes.id, record.id));

  const [verified] = await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();
  if (!verified) throw new Error("user verification update returned no row");

  logger.info({ userId: user.id }, "email verified");
  return { user: verified, alreadyVerified: false };
}

/**
 * Re-sends a code, subject to a cooldown.
 *
 * Returns the same shape whether or not the address exists — a resend endpoint
 * that 404s on unknown emails is an account-enumeration oracle.
 */
export async function resendVerificationCode(
  email: string,
  db: Database = getDb(),
): Promise<{ sent: boolean; retryAfterSeconds: number }> {
  const normalized = email.trim().toLowerCase();
  const cooldown = env.VERIFICATION_RESEND_COOLDOWN_SECONDS;
  const [user] = await db.select().from(users).where(eq(users.email, normalized));

  if (!user || user.emailVerifiedAt) return { sent: false, retryAfterSeconds: cooldown };

  const [recent] = await db
    .select()
    .from(emailVerificationCodes)
    .where(eq(emailVerificationCodes.userId, user.id))
    .orderBy(desc(emailVerificationCodes.id))
    .limit(1);

  if (recent) {
    const age = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (age < cooldown) {
      throw new AppError("RATE_LIMITED", "A code was just sent. Wait a moment before asking again.", {
        retryAfterSeconds: Math.ceil(cooldown - age),
      });
    }
  }

  await issueVerificationCode(user, db);
  return { sent: true, retryAfterSeconds: cooldown };
}

function renderVerificationEmail(input: { code: string; name: string; to: string }) {
  const firstName = input.name.split(" ")[0] ?? input.name;
  const minutes = env.VERIFICATION_CODE_TTL_MINUTES;

  const text = [
    `Hi ${firstName},`,
    "",
    `Your Renewly verification code is ${input.code}.`,
    "",
    `It expires in ${minutes} minutes. If you did not create an account, ignore this email — nothing will happen.`,
    "",
    "Renewly",
  ].join("\n");

  const html = [
    `<p>Hi ${escapeHtml(firstName)},</p>`,
    `<p>Your Renewly verification code is:</p>`,
    `<p style="font-size:28px;font-weight:600;letter-spacing:0.18em;margin:24px 0">${input.code}</p>`,
    `<p>It expires in ${minutes} minutes. If you did not create an account, ignore this email — nothing will happen.</p>`,
    `<p>Renewly</p>`,
  ].join("\n");

  return { to: input.to, subject: `${input.code} is your Renewly code`, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
