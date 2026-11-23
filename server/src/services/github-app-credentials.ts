import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { connectionGrants, toolConnections, toolConnectionInstalls, type Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";
import { resolveConnectionGrantSecret } from "./connection-credentials.js";

export const GITHUB_APP_MCP_URL = "https://api.githubcopilot.com/mcp/";
const KEY_PATH = "credentials.privateKey";
const REFRESH_MARGIN_MS = 5 * 60_000;
type Connection = typeof toolConnections.$inferSelect;
type Grant = typeof connectionGrants.$inferSelect;
type Credential = { token: string; expiresAt: number };
const cache = new Map<string, Credential>();
const profiles = {
  read: { contents: "read", pull_requests: "read", issues: "read" },
  author: { contents: "write", pull_requests: "write", issues: "read" },
  reviewer: { contents: "read", pull_requests: "write", issues: "read" },
} as const;

export function isGitHubAppConnection(connection: Pick<Connection, "config">) {
  return connection.config.sourceTemplateKey === "github" && connection.config.connectionMethodKey === "app-installation";
}

function configuration(connection: Connection) {
  const value = connection.config.methodConfig as Record<string, unknown> | undefined;
  if (!value || (value.version !== undefined && value.version !== 1 && value.version !== "1")
    || !/^(?:[1-9]\d*|Iv[0-9][A-Za-z0-9.]{1,97})$/.test(String(value.appId ?? ""))
    || !/^[1-9]\d*$/.test(String(value.installationId ?? "")) || typeof value.repositories !== "string") {
    throw unprocessable("The GitHub App installation configuration is invalid");
  }
  const repositories = [...new Set(value.repositories.split(/[,\n]/).map(repo => repo.trim().toLowerCase()).filter(Boolean))].sort();
  if (!repositories.length || repositories.length > 500 || repositories.some(repo => !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/.test(repo))) {
    throw unprocessable("The GitHub App repository selection is invalid");
  }
  let permissions: Record<string, string>;
  if (value.permissionProfile === "custom") {
    try {
      const parsed: unknown = JSON.parse(String(value.customPermissions));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length
        || Object.entries(parsed).some(([key, level]) => !/^[a-z][a-z0-9_]*$/.test(key) || !["read", "write", "admin"].includes(String(level)))) throw new Error();
      permissions = parsed as Record<string, string>;
    } catch { throw unprocessable("The GitHub App permissions are invalid"); }
  } else {
    if (!Object.hasOwn(profiles, String(value.permissionProfile))) throw unprocessable("The GitHub App permission profile is invalid");
    permissions = { ...profiles[value.permissionProfile as keyof typeof profiles] };
  }
  return { appId: String(value.appId), installationId: String(value.installationId), repositories, permissions };
}

/** Background discovery may use only the single active, policy-matching grant. */
export async function getGitHubAppGrant(db: Db, connection: Connection) {
  const grants = await db.select().from(connectionGrants).where(and(
    eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id),
    eq(connectionGrants.status, "active"),
  )).limit(2);
  if (grants.length !== 1) throw unprocessable("The GitHub App authorization is unavailable or ambiguous");
  return grants[0]!;
}

/** Shared by catalog discovery, governed tool calls and managed git. No tokens are persisted. */
export async function resolveGitHubAppCredential(
  db: Db, connection: Connection, grant: Grant,
  options: { forceRefresh?: boolean; agentId?: string | null } = {},
): Promise<Credential> {
  const assertCurrent = async () => {
    const [current] = await db.select().from(toolConnections).where(and(
      eq(toolConnections.companyId, connection.companyId), eq(toolConnections.id, connection.id),
    ));
    const [authorization] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.id, grant.id),
    ));
    const kind = connection.credentialPolicy === "per_user" ? "user" : connection.credentialPolicy === "per_agent" ? "agent" : "organization";
    if (!current || !authorization || !isGitHubAppConnection(current) || !current.enabled || current.status !== "active"
      || authorization.status !== "active" || authorization.connectionId !== current.id || authorization.kind !== kind
      || (kind === "user" && !authorization.subjectUserId) || (kind === "agent" && !authorization.subjectAgentId)
      || current.credentialPolicy !== connection.credentialPolicy || JSON.stringify(current.config) !== JSON.stringify(connection.config)
      || JSON.stringify(authorization) !== JSON.stringify(grant)) throw unprocessable("The GitHub App authorization changed or is unavailable");
    const installs = await db.select().from(toolConnectionInstalls).where(and(
      eq(toolConnectionInstalls.companyId, current.companyId), eq(toolConnectionInstalls.connectionId, current.id),
    ));
    const agentId = options.agentId ?? (kind === "agent" ? grant.subjectAgentId : null);
    if (!installs.some(install => (install.targetType === "company" && install.targetId === current.companyId)
      || (install.targetType === "agent" && (!agentId || install.targetId === agentId)))) throw unprocessable("The GitHub App connection is not installed for this caller");
  };
  await assertCurrent();
  const config = configuration(connection);
  const ref = grant.credentialSecretRefs.find(candidate => candidate.configPath === KEY_PATH);
  if (!ref) throw unprocessable("The GitHub App private key is unavailable");
  const secret = await resolveConnectionGrantSecret(db, connection, grant, ref, {
    actorType: "system", actorId: options.agentId ?? undefined,
    consumerType: "tool_connection", consumerId: connection.id,
  });
  const key = createHash("sha256").update(JSON.stringify([
    connection.companyId, connection.id, grant, config, ref, secret.latestVersion, secret.value,
  ])).digest("hex");
  const cached = cache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    await assertCurrent();
    return cached;
  }
  cache.delete(key);
  let jwt: string;
  try { jwt = githubAppJwt(config.appId, secret.value); }
  catch { throw unprocessable("The GitHub App private key is invalid"); }
  const installation = await githubBotRequest<{ account?: { login?: string }; suspended_at?: string | null }>(
    fetch, jwt, `/app/installations/${config.installationId}`,
  );
  if (installation.suspended_at || !installation.account?.login
    || config.repositories.some(repo => repo.split("/")[0] !== installation.account!.login!.toLowerCase())) {
    throw unprocessable("The GitHub App installation does not match the selected repositories");
  }
  const minted = await githubBotRequest<{ token?: string; expires_at?: string }>(
    fetch, jwt, `/app/installations/${config.installationId}/access_tokens`, {
      method: "POST", body: { repositories: config.repositories.map(repo => repo.split("/")[1]), permissions: config.permissions },
    },
  );
  const expiresAt = Date.parse(minted.expires_at ?? "");
  if (!minted.token?.trim() || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
    throw unprocessable("GitHub returned an invalid installation access token");
  }
  await assertCurrent();
  const credential = { token: minted.token, expiresAt };
  for (const [entry, value] of cache) if (value.expiresAt <= Date.now() + REFRESH_MARGIN_MS) cache.delete(entry);
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, credential);
  return credential;
}
