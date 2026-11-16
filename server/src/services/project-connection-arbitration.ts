import type { Db } from "@paperclipai/db";
import type { DbTransaction } from "./tool-access/types.js";

/** Lane A. Provider verification belongs outside this transaction. */
export type ProjectConnectionIdentity = Readonly<{
  companyId: string;
  providerHost: string;
  verifiedRegistrationId: string;
  canonicalInstallationKey: string;
}>;

/** Registration -> sorted installation locks; fresh post-wait reads are required. */
export async function lockProjectConnectionIdentities(
  _tx: Db | DbTransaction,
  _identities: readonly ProjectConnectionIdentity[],
): Promise<void> {
  throw new Error("Project connection arbitration not implemented (Stage 0, lane A)");
}

/** All identity-affecting owned/null/alias writers use the same live-row arbiter. */
export async function assertProjectConnectionAvailability(
  _tx: Db | DbTransaction,
  _input: Readonly<{ identity: ProjectConnectionIdentity; projectId: string | null; exclusive: boolean; excludeConnectionId?: string }>,
): Promise<void> {
  throw new Error("Project connection availability not implemented (Stage 0, lane A)");
}
