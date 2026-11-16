import { createGitHubAppClient, githubAppFailure, rethrowGitHubAppFailure, type GitHubAppConfig } from "./github-app-client.js";
import type { ProjectConnectionIdentity } from "./project-connection-arbitration.js";

/** Normalized provider facts only: no wire payload, key, JWT or exported token. */
export type VerifiedProjectConnectionProviderScope = Readonly<{
  identity: ProjectConnectionIdentity;
  repositoryIds: readonly number[];
  secretVersion: number;
}>;
const client = createGitHubAppClient();

/** B authorizes exact references first. Provider HTTP is outside DB locks. */
export async function verifyProjectConnectionGitHubScope(
  input: Readonly<{ companyId: string; namespace: string; config: GitHubAppConfig; privateKey: string; secretVersion: number }>,
): Promise<VerifiedProjectConnectionProviderScope> {
  if (!input.companyId || !input.namespace || !Number.isSafeInteger(input.secretVersion) || input.secretVersion < 1
    || !/^[1-9]\d*$/.test(input.config.installationId) || !input.config.repositories.length) githubAppFailure("configuration");
  try {
    // Force fresh verification for first bind/finish, never a health label/cache alone.
    const result = await client.acquire(`${input.companyId}:${input.namespace}:${input.secretVersion}`, input.config, input.privateKey, true);
    const registrationId = result.verifiedRegistrationId;
    const repositories = result.github.repositories ?? [];
    const ids = repositories.map(repo => Number(repo.id));
    if (!registrationId || !/^[1-9]\d*$/.test(registrationId)
      || result.github.installationIds?.length !== 1 || result.github.installationIds[0] !== input.config.installationId
      || ids.length !== input.config.repositories.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
      || new Set(ids).size !== ids.length
      || repositories.some(repo => repo.installationId !== input.config.installationId
        || !input.config.repositories.includes(repo.fullName.toLowerCase()))) githubAppFailure("repositories");
    return { identity: { companyId: input.companyId, providerHost: "github.com", verifiedRegistrationId: registrationId,
      canonicalInstallationKey: `github.com/github-app-installation/${input.config.installationId}` },
      repositoryIds: ids.sort((a, b) => a - b), secretVersion: input.secretVersion };
  } catch (error) { rethrowGitHubAppFailure(error); }
}
