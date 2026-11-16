import type { Db, toolConnections } from "@paperclipai/db";
import type { ActorInfo, DbTransaction } from "./tool-access/types.js";

/** Lane B: stored in existing config.projectScope, never caller-authored authority. */
export type ProjectConnectionScope = Readonly<{
  version: 1;
  installationKey: string;
  registrationId: string;
  exclusive: boolean;
  approvedLeadAgentId: string;
  approvedByAgentId: string;
  responsibleUserId: string;
  approvedRepositoryIds: readonly number[];
  approvedSecretRefs: readonly Readonly<{ secretId: string; configPath: string }>[];
  migrationPending?: boolean;
  legacyConnectionId?: string;
}>;

type Connection = typeof toolConnections.$inferSelect;
export type ProjectConnectionOperation = "create" | "finish" | "install" | "update" | "disable" | "retire" | "use" | "project_update" | "reconnect";

/** Parse/version-check the protected envelope; malformed owned rows fail closed. */
export function readProjectConnectionScope(_connection: Pick<Connection, "projectId" | "config">): ProjectConnectionScope | null {
  throw new Error("Project connection metadata not implemented (Stage 0, lane B)");
}

/** Existing authorization remains necessary; this is the additional common guard. */
export async function assertProjectConnectionAdmission(
  _db: Db | DbTransaction,
  _input: Readonly<{
    companyId: string;
    projectId: string | null;
    operation: ProjectConnectionOperation;
    actor?: ActorInfo;
    connection?: Connection;
    targetAgentIds?: readonly string[];
    proposedSecretRefs?: readonly Readonly<{ secretId: string; configPath: string }>[];
    proposedRepositoryIds?: readonly number[];
  }>,
): Promise<void> {
  throw new Error("Project connection admission not implemented (Stage 0, lane B)");
}
