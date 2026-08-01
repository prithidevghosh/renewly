import { eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  workspaceMembers,
  workspaceSettings,
  workspaces,
  type Workspace,
  type WorkspaceSettings,
} from "../../db/schema.js";
import { newId } from "../../lib/id.js";
import { notFound } from "../../lib/errors.js";

export interface WorkspaceBundle {
  workspace: Workspace;
  settings: WorkspaceSettings;
}

/** V1 gives every user exactly one workspace, created at signup. */
export async function createWorkspaceForUser(
  userId: string,
  name: string,
  db: Database = getDb(),
): Promise<WorkspaceBundle> {
  const [workspace] = await db
    .insert(workspaces)
    .values({ id: newId("wsp"), ownerUserId: userId, name })
    .returning();
  if (!workspace) throw new Error("workspace insert returned no row");

  await db
    .insert(workspaceMembers)
    .values({ id: newId("wmb"), workspaceId: workspace.id, userId, role: "owner" });

  const [settings] = await db
    .insert(workspaceSettings)
    .values({ workspaceId: workspace.id })
    .returning();
  if (!settings) throw new Error("workspace settings insert returned no row");

  return { workspace, settings };
}

export async function getWorkspaceBundle(
  workspaceId: string,
  db: Database = getDb(),
): Promise<WorkspaceBundle> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw notFound("Workspace");
  const settings = await getSettings(workspaceId, db);
  return { workspace, settings };
}

export async function getSettings(
  workspaceId: string,
  db: Database = getDb(),
): Promise<WorkspaceSettings> {
  const [settings] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  if (!settings) throw notFound("Workspace settings");
  return settings;
}

export async function findWorkspaceForUser(
  userId: string,
  db: Database = getDb(),
): Promise<Workspace | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.ownerUserId, userId));
  return row ?? null;
}
