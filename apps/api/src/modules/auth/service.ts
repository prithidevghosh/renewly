import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { users, type User } from "../../db/schema.js";
import { env } from "../../env.js";
import { AppError, conflict, unauthorized } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
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
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
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
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

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

  const { workspace } = await createWorkspaceForUser(
    user.id,
    input.workspaceName?.trim() || `${input.name.split(" ")[0] ?? input.name}'s workspace`,
    db,
  );

  await recordAudit(
    {
      workspaceId: workspace.id,
      actorUserId: user.id,
      type: "auth.signup",
      entityType: "user",
      entityId: user.id,
      data: { email },
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

  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized("Invalid email or password");

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
