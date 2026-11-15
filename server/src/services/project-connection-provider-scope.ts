import type { GitHubAppConfig } from "./github-app-client.js";
import type { ProjectConnectionIdentity } from "./project-connection-arbitration.js";

/** Lane C: normalized provider facts for B; no provider payload or token escapes. */
export type VerifiedProjectConnectionProviderScope = Readonly<{
  identity: ProjectConnectionIdentity;
  repositoryIds: readonly number[];
  secretVersion: number;
}>;

/** B authorizes the exact references FIRST. Call outside DB locks. Server-only key input. */
export async function verifyProjectConnectionGitHubScope(
  _input: Readonly<{ companyId: string; namespace: string; config: GitHubAppConfig; privateKey: string; secretVersion: number }>,
): Promise<VerifiedProjectConnectionProviderScope> {
  throw new Error("Project connection provider verification not implemented (Stage 0, lane C)");
}
