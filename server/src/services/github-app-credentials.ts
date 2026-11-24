import { createHash } from "node:crypto";
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";
import { resolveConnectionGrantSecret } from "./connection-credentials.js";

type Connection = typeof toolConnections.$inferSelect;
type Grant = typeof connectionGrants.$inferSelect;
const cache = new Map<string, { token: string; expiresAt: number }>();
const margin = 5 * 60_000;
const profiles = {
  read: { contents: "read", pull_requests: "read", issues: "read" },
  author: { contents: "write", pull_requests: "write", issues: "read" },
  reviewer: { contents: "read", pull_requests: "write", issues: "read" },
} as const;
export function isGitHubAppConnection(connection: Pick<Connection, "config">) {
  return connection.config.sourceTemplateKey === "github" && connection.config.connectionMethodKey === "app-installation";
}

/** Callers select/authorize the grant; stock vault ownership checks also run on cache hits. */
export async function resolveGitHubAppCredential(db: Db, connection: Connection, grant: Grant, options: { forceRefresh?: boolean; allowDraft?: boolean } = {}) {
  const config = connection.config.methodConfig as Record<string, unknown> | undefined;
  // The connect-time health check runs on the still-draft connection (seam 0169 follow-up).
  if ((options.allowDraft ? connection.status !== "draft" : (!connection.enabled || connection.status !== "active")) || grant.status !== "active" || !config
    || grant.kind !== (connection.credentialPolicy === "per_user" ? "user" : connection.credentialPolicy === "per_agent" ? "agent" : "organization")
    || (config.version !== undefined && config.version !== 1 && config.version !== "1")
    || !/^(?:[1-9]\d*|Iv[0-9][A-Za-z0-9.]{1,97})$/.test(String(config.appId ?? ""))
    || !/^[1-9]\d*$/.test(String(config.installationId ?? "")) || typeof config.repositories !== "string")
    throw unprocessable("The GitHub App installation configuration is invalid or inactive");
  const repositories = [...new Set(config.repositories.split(/[,\n]/).map(repo => repo.trim().toLowerCase()).filter(Boolean))].sort();
  if (!repositories.length || repositories.length > 500 || repositories.some(repo => !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/.test(repo)))
    throw unprocessable("The GitHub App repository selection is invalid");
  let permissions: Record<string, string>;
  try {
    permissions = config.permissionProfile === "custom" ? JSON.parse(String(config.customPermissions)) : profiles[config.permissionProfile as keyof typeof profiles];
    if (!permissions || Array.isArray(permissions) || typeof permissions !== "object" || !Object.keys(permissions).length
      || Object.entries(permissions).some(([key, level]) => !/^[a-z][a-z0-9_]*$/.test(key) || !["read", "write", "admin"].includes(level))) throw new Error();
  } catch { throw unprocessable("The GitHub App permissions are invalid"); }
  const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "credentials.privateKey");
  if (!ref) throw unprocessable("The GitHub App private key is unavailable");
  const secret = await resolveConnectionGrantSecret(db, connection, grant, ref, { actorType: "system", consumerType: "tool_connection", consumerId: connection.id });
  const key = createHash("sha256").update(JSON.stringify([connection.companyId, connection.id, grant, config, ref, secret.latestVersion, secret.value])).digest("hex");
  const cached = cache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now() + margin) return cached;
  cache.delete(key);
  let jwt: string;
  try { jwt = githubAppJwt(String(config.appId), secret.value); }
  catch { throw unprocessable("The GitHub App private key is invalid"); }
  const installation = await githubBotRequest<{ account?: { login?: string }; suspended_at?: string | null }>(fetch, jwt, `/app/installations/${config.installationId}`);
  if (installation.suspended_at || !installation.account?.login || repositories.some(repo => repo.split("/")[0] !== installation.account!.login!.toLowerCase()))
    throw unprocessable("The GitHub App installation does not match the selected repositories");
  const minted = await githubBotRequest<{ token?: string; expires_at?: string }>(fetch, jwt, `/app/installations/${config.installationId}/access_tokens`, {
    method: "POST", body: { repositories: repositories.map(repo => repo.split("/")[1]), permissions },
  });
  const credential = { token: minted.token ?? "", expiresAt: Date.parse(minted.expires_at ?? "") };
  if (!credential.token.trim() || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now() + margin)
    throw unprocessable("GitHub returned an invalid installation access token");
  for (const [entry, value] of cache) if (value.expiresAt <= Date.now() + margin) cache.delete(entry);
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, credential);
  return credential;
}
