import type { Logger } from "pino";
import type { User, Workspace, WorkspaceSettings } from "../db/schema.js";

export interface AuthContext {
  user: User;
  workspace: Workspace;
  settings: WorkspaceSettings;
}

export interface AppVariables {
  requestId: string;
  log: Logger;
  auth: AuthContext;
}

export interface AppEnv {
  Variables: AppVariables;
}
