import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { authIdentities, users, type AuthIdentity, type User } from "../../db/schema.js";
import { env } from "../../env.js";
import { encryptSecret } from "../../lib/crypto.js";
import { AppError, conflict, unauthorized } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import { logger } from "../../lib/logger.js";
import { issueVerificationCode } from "./verification.js";
import type { OAuthExchange, SocialProvider } from "./oauth/types.js";
import { recordAudit } from "../audit/service.js";
import {
  createWorkspaceForUser,
  findWorkspaceForUser,
  getWorkspaceBundle,
} from "../workspaces/service.js";
import { signToken } from "./tokens.js";
import type { AuthContext } from "../../types/context.js";

const BCRYPT_ROUNDS = env.NODE_ENV === "test" ? 4 : 12;

/**
 * A real hash of a throwaway string. Comparing against it when no user exists
 * keeps the failure path's cost in the same order as the success path, so
 * response time does not disclose whether an address is registered.
 */
const DUMMY_HASH = "$2a$10$0EaCkauAaJSjoTFMfbT77.pTeVSGa8vTNQ1PrxUDQ7xRx8ccIvs6i";

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerifiedAt !== null,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface SignupInput {
  email: string;
  password: string;
  name: string;
  workspaceName?: string;
}

export interface AuthResult {
  user: PublicUser;
  workspaceId: string;
  token: string;
  expiresAt: string;
  /** Present on a password signup in mock mail mode only. */
  verificationCode?: string | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Password signup. The account is created unverified and a code is emailed; the
 * session token is issued immediately but only unlocks the verification routes
 * until the code is entered (see `requireAuth`). Withholding the token entirely
 * would mean the client has nothing to resend or check status with.
 */
export async function signup(input: SignupInput, db: Database = getDb()): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) throw conflict("An account with that email already exists", { email });

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const [user] = await db
    .insert(users)
    .values({ id: newId("usr"), email, passwordHash, name: input.name })
    .returning();
  if (!user) throw new Error("user insert returned no row");

  await db.insert(authIdentities).values({
    id: newId("aid"),
    userId: user.id,
    provider: "password",
    // A password account has no external subject; the address is the identity.
    providerAccountId: email,
    email,
  });

  const { workspace } = await createWorkspaceForUser(
    user.id,
    input.workspaceName?.trim() || `${input.name.split(" ")[0] ?? input.name}'s workspace`,
    db,
  );

  const issued = await issueVerificationCode(user, db);

  await recordAudit(
    {
      workspaceId: workspace.id,
      actorUserId: user.id,
      type: "auth.signup",
      entityType: "user",
      entityId: user.id,
      data: { email, provider: "password", verified: false },
    },
    db,
  );

  const { token, expiresAt } = await signToken({ userId: user.id, workspaceId: workspace.id });
  return {
    user: toPublicUser(user),
    workspaceId: workspace.id,
    token,
    expiresAt,
    verificationCode: issued.code,
  };
}

/**
 * Signs in or signs up through Google or Microsoft.
 *
 * Three cases, in order:
 *   1. Known provider identity      -> refresh its tokens, sign in
 *   2. Unknown identity, known email -> link it to that account
 *   3. Neither                       -> create the account and workspace
 *
 * Case 2 is the one worth being careful about. Linking on a *verified* email is
 * how a password user gets to click "Sign in with Google" and land in the same
 * workspace; linking on an unverified one would let anyone who can obtain a
 * provider token for an address take over an account they never owned. So an
 * unverified provider email is refused rather than linked.
 */
export async function signInWithProvider(
  input: { provider: SocialProvider; exchange: OAuthExchange },
  db: Database = getDb(),
): Promise<AuthResult> {
  const { profile, tokens } = input.exchange;
  const email = normalizeEmail(profile.email);

  const [identity] = await db
    .select()
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.provider, input.provider),
        eq(authIdentities.providerAccountId, profile.providerAccountId),
      ),
    );

  if (identity) {
    await storeIdentityTokens(identity.id, tokens, db);
    const [user] = await db.select().from(users).where(eq(users.id, identity.userId));
    if (!user) throw new AppError("INTERNAL_ERROR", "Identity points at a missing user");
    return sessionFor(user, "auth.login", input.provider, db);
  }

  const [byEmail] = await db.select().from(users).where(eq(users.email, email));

  if (byEmail) {
    if (!profile.emailVerified) {
      throw new AppError(
        "UNAUTHORIZED",
        `${input.provider} has not verified that address, so it cannot be linked to an existing account`,
        { email },
      );
    }

    const linked = await linkIdentity(byEmail.id, input.provider, profile, tokens, db);
    logger.info(
      { userId: byEmail.id, provider: input.provider, identityId: linked.id },
      "linked provider identity to existing account",
    );

    // Signing in through a provider that vouches for the address is at least as
    // strong as the emailed code, so it settles verification too.
    const user = byEmail.emailVerifiedAt ? byEmail : await markVerified(byEmail.id, db);
    return sessionFor(user, "auth.login", input.provider, db);
  }

  const [user] = await db
    .insert(users)
    .values({
      id: newId("usr"),
      email,
      // No password: this account can only be reached through the provider
      // until its owner sets one.
      passwordHash: null,
      name: profile.name?.trim() || (email.split("@")[0] ?? "There"),
      emailVerifiedAt: profile.emailVerified ? new Date() : null,
      avatarUrl: profile.avatarUrl,
    })
    .returning();
  if (!user) throw new Error("user insert returned no row");

  await linkIdentity(user.id, input.provider, profile, tokens, db);
  await createWorkspaceForUser(user.id, `${user.name.split(" ")[0] ?? user.name}'s workspace`, db);

  // A provider that will not vouch for the address still has to prove it.
  if (!profile.emailVerified) await issueVerificationCode(user, db);

  return sessionFor(user, "auth.signup", input.provider, db);
}

async function linkIdentity(
  userId: string,
  provider: SocialProvider,
  profile: OAuthExchange["profile"],
  tokens: OAuthExchange["tokens"],
  db: Database,
): Promise<AuthIdentity> {
  const [row] = await db
    .insert(authIdentities)
    .values({
      id: newId("aid"),
      userId,
      provider,
      providerAccountId: profile.providerAccountId,
      email: profile.email,
      accessToken: tokens.accessToken ? encryptSecret(tokens.accessToken) : null,
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      scopes: tokens.scopes,
      expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
    })
    .returning();
  if (!row) throw new Error("auth identity insert returned no row");
  return row;
}

async function storeIdentityTokens(
  identityId: string,
  tokens: OAuthExchange["tokens"],
  db: Database,
): Promise<void> {
  await db
    .update(authIdentities)
    .set({
      // Null on the GIS path, which issues no access token; keep whatever a
      // previous redirect sign-in stored rather than wiping it.
      ...(tokens.accessToken ? { accessToken: encryptSecret(tokens.accessToken) } : {}),
      // Providers omit the refresh token on repeat consents; keeping the stored
      // one is the difference between a working integration and a silent
      // re-auth prompt weeks later.
      ...(tokens.refreshToken ? { refreshToken: encryptSecret(tokens.refreshToken) } : {}),
      scopes: tokens.scopes,
      expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
      updatedAt: new Date(),
    })
    .where(eq(authIdentities.id, identityId));
}

async function markVerified(userId: string, db: Database): Promise<User> {
  const [row] = await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  if (!row) throw new Error("user verification update returned no row");
  return row;
}

async function sessionFor(
  user: User,
  auditType: "auth.login" | "auth.signup",
  provider: string,
  db: Database,
): Promise<AuthResult> {
  const workspace = await findWorkspaceForUser(user.id, db);
  if (!workspace) throw new AppError("INTERNAL_ERROR", "User has no workspace");

  await recordAudit(
    {
      workspaceId: workspace.id,
      actorUserId: user.id,
      type: auditType,
      entityType: "user",
      entityId: user.id,
      data: { provider, email: user.email },
    },
    db,
  );

  const { token, expiresAt } = await signToken({ userId: user.id, workspaceId: workspace.id });
  return { user: toPublicUser(user), workspaceId: workspace.id, token, expiresAt };
}

export async function login(
  input: { email: string; password: string },
  db: Database = getDb(),
): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const [user] = await db.select().from(users).where(eq(users.email, email));

  // An OAuth-only account has no hash. It still costs a full compare against the
  // dummy, so "this address exists but has no password" is not observable from
  // the response time.
  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !ok) throw unauthorized("Invalid email or password");

  const bundle = await requireWorkspaceForUser(user.id, db);

  await recordAudit(
    {
      workspaceId: bundle.workspaceId,
      actorUserId: user.id,
      type: "auth.login",
      entityType: "user",
      entityId: user.id,
    },
    db,
  );

  const { token, expiresAt } = await signToken({
    userId: user.id,
    workspaceId: bundle.workspaceId,
  });
  return { user: toPublicUser(user), workspaceId: bundle.workspaceId, token, expiresAt };
}

async function requireWorkspaceForUser(
  userId: string,
  db: Database,
): Promise<{ workspaceId: string }> {
  const workspace = await findWorkspaceForUser(userId, db);
  if (!workspace) throw new AppError("INTERNAL_ERROR", "User has no workspace");
  return { workspaceId: workspace.id };
}

export async function resolveAuthContext(
  userId: string,
  workspaceId: string,
  db: Database = getDb(),
): Promise<AuthContext> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw unauthorized("Session refers to a user that no longer exists");

  const { workspace, settings } = await getWorkspaceBundle(workspaceId, db);
  if (workspace.ownerUserId !== user.id) {
    throw unauthorized("Session is not valid for this workspace");
  }
  return { user, workspace, settings };
}
