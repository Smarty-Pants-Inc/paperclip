import type { ConnectionManagementContext } from "../connection-management.js";
import type { Db } from "@paperclipai/db";

export type ActorInfo = {
  managementContext?: ConnectionManagementContext;
  /** Original authenticated actor kind, never inferred from responsibleUserId. */
  authenticatedActorType?: "board" | "agent";
  /** Explicit scoped completion, never a generic force bypass. */
  projectDoneConfirmation?: Readonly<{ projectId: string; connectionId: string }>;
  responsibleUserId?: string | null;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  sessionId?: string | null;
  actorSource?:
    | "local_implicit"
    | "session"
    | "board_key"
    | "agent_key"
    | "agent_jwt"
    | "mcp_oauth"
    | "cloud_tenant";
};


export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ToolAccessMutationDb = Pick<
  Db | DbTransaction,
  "select" | "insert" | "update" | "delete"
>;
