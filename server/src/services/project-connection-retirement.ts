import type { Db, toolConnections } from "@paperclipai/db";
import type { ActorInfo, DbTransaction } from "./tool-access/types.js";

type Connection = typeof toolConnections.$inferSelect;

/** Lane D: both run admission (C) and destructive writers lock the same lifecycle row. */
export async function lockProjectConnectionLifecycle(
  _tx: Db | DbTransaction,
  _input: Readonly<{ companyId: string; projectId: string }>,
): Promise<void> {
  throw new Error("Project connection lifecycle lock not implemented (Stage 0, lane D)");
}

/** The actual caller supplies confirmation; manager status never implies it. */
export async function assertProjectConnectionNotInUse(
  _tx: Db | DbTransaction,
  _input: Readonly<{ companyId: string; projectId: string; connectionId: string; actor?: ActorInfo; projectDoneConfirmation?: Readonly<{ projectId: string; connectionId: string }> }>,
): Promise<void> {
  throw new Error("Project connection running-work gate not implemented (Stage 0, lane D)");
}

/** Caller composes state/grant/install effects and this value-free receipt on ONE tx. */
export async function writeProjectConnectionReceipt(
  _tx: Db | DbTransaction,
  _input: Readonly<{
    connection: Connection;
    actor?: ActorInfo;
    action: "tool_connection.project_taken" | "tool_connection.archived" | "tool_connection.updated";
    reason?: string;
    targetAgentIds?: readonly string[];
    verifiedRepositoryIds?: readonly number[];
  }>,
): Promise<{ activityId: string }> {
  throw new Error("Project connection transactional receipt not implemented (Stage 0, lane D)");
}

/** B's existing finish writer calls this only AFTER external verification, under its tx. */
export async function activateProjectConnectionMigration(
  _tx: Db | DbTransaction,
  _input: Readonly<{ connection: Connection; actor?: ActorInfo; targetAgentIds: readonly string[]; verifiedRepositoryIds: readonly number[]; verifiedSecretVersion: number }>,
): Promise<void> {
  throw new Error("Project connection migration activation not implemented (Stage 0, lane D)");
}
