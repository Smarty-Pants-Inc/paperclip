import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db, toolConnections } from "@paperclipai/db";
import { createToolCatalogDiscovery, forgetRemoteToolListCache } from "./discovery.js";
import { createConnectionHealth } from "./health.js";
import { forgetMcpProtocolVersion, mcpEraKey, MCP_MODERN_PROTOCOL_VERSION } from "../../mcp-http.js";

vi.mock("../../github-app-credentials.js", async () => {
  const client = await import("../../github-app-client.js");
  return {
    isGitHubAppConnection: client.isGitHubAppConnection,
    parseGitHubAppConfig: client.parseGitHubAppConfig,
    getGitHubAppGrant: vi.fn(),
    resolveGitHubAppCredential: vi.fn(),
    refreshGitHubAppAccess: vi.fn(async () => ({ token: "fixture-token" })),
  };
});
vi.mock("../../tool-connection-health-notifications.js", () => ({
  writeToolConnectionHealthChange: vi.fn(async (_db: Db, connection: Connection) => [connection]),
}));

type Connection = typeof toolConnections.$inferSelect;
const endpoint = "https://api.githubcopilot.com/mcp/";
const connections: Connection[] = [];

function fixture(method: "mcp-key" | "own-oauth" | "app-installation") {
  const connection: Connection = {
    id: randomUUID(), companyId: randomUUID(), projectId: null, applicationId: randomUUID(), uid: randomUUID(),
    name: "Protocol regression fixture", transport: "mcp_remote", connectionPurpose: "tool",
    connectionKind: "managed", ownership: "customer", agentInstructions: null,
    authKind: method === "own-oauth" ? "oauth" : "api_key",
    credentialSource: "paperclip_vault", externalCredential: null,
    credentialPolicy: "shared", status: "active", enabled: true,
    config: { sourceTemplateKey: "github", connectionMethodKey: method, mcpProtocolVersion: MCP_MODERN_PROTOCOL_VERSION },
    transportConfig: {}, credentialRefs: [], credentialSecretRefs: [],
    healthStatus: "unchecked", healthMessage: null, healthCheckedAt: null,
    lastHealthAt: null, lastCatalogRefreshAt: null, lastError: null,
    createdByAgentId: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date(),
  };
  connections.push(connection);
  let token = "fixture-token";
  const resolveCredentialHeaders = vi.fn(async (_connection?: unknown, _actor?: unknown, options?: { forceRefresh?: boolean }) => {
    if (options?.forceRefresh) token = "refreshed-fixture-token";
    return { Authorization: `Bearer ${token}` };
  });
  const requestRemoteHttpEndpoint = vi.fn(async (_url: URL, init: RequestInit) => {
    const rpc = JSON.parse(String(init.body));
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
      tools: [{ name: "get_me", inputSchema: { type: "object" } }, { name: "read_repository", inputSchema: { type: "object" } }],
      ttlMs: 60_000, cacheScope: "public",
    } });
  });
  const setupPolicy = { assertConnectorConnectionSetupEnabled: vi.fn(async () => {}) };
  const discovery = createToolCatalogDiscovery({} as Db, {
    now: () => new Date(), audit: vi.fn(async () => {}), secrets: {},
    credentials: { resolveCredentialHeaders, resolvedRemoteEndpoint: vi.fn(async () => endpoint) },
    vercel: {}, vercelConnect: null, setupPolicy, requestRemoteHttpEndpoint,
    resolveOAuthGrantSecret: vi.fn(), discoverOAuthEndpoints: vi.fn(), localTools: vi.fn(),
  } as unknown as Parameters<typeof createToolCatalogDiscovery>[1]);
  return { connection, discovery, requestRemoteHttpEndpoint, resolveCredentialHeaders, setupPolicy };
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    forgetRemoteToolListCache(connection.id);
    forgetMcpProtocolVersion(mcpEraKey(connection.id, endpoint));
  }
  vi.clearAllMocks();
});

describe("GitHub App port preserves modern MCP discovery", () => {
  it.each(["mcp-key", "app-installation"] as const)("honors an explicit live listing after a cached %s listing", async method => {
    const { connection, discovery, requestRemoteHttpEndpoint } = fixture(method);
    await discovery.discoverTools(connection);
    expect(requestRemoteHttpEndpoint).toHaveBeenCalledTimes(1);
    await discovery.discoverTools(connection);
    expect(requestRemoteHttpEndpoint).toHaveBeenCalledTimes(1);
    await discovery.discoverTools(connection, undefined, undefined, [], { live: true });
    expect(requestRemoteHttpEndpoint).toHaveBeenCalledTimes(2);
  });

  it.each(["own-oauth", "app-installation"] as const)("retains negotiated protocol metadata after a %s credential refresh", async method => {
    const { connection, discovery, requestRemoteHttpEndpoint, resolveCredentialHeaders } = fixture(method);
    requestRemoteHttpEndpoint.mockImplementation(async (_url, init) => {
      const headers = new Headers(init.headers);
      const rpc = JSON.parse(String(init.body));
      if (headers.get("Authorization") === "Bearer fixture-token") return Response.json({}, { status: 401 });
      if (headers.get("MCP-Protocol-Version") !== MCP_MODERN_PROTOCOL_VERSION) return Response.json({}, { status: 400 });
      expect(rpc.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(MCP_MODERN_PROTOCOL_VERSION);
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
        tools: [{ name: "read_repository", inputSchema: { type: "object" } }], ttlMs: 60_000,
      } });
    });
    await expect(discovery.discoverTools(connection)).resolves.toEqual([expect.objectContaining({ name: "read_repository" })]);
    expect(resolveCredentialHeaders).toHaveBeenLastCalledWith(connection, undefined, { forceRefresh: true });
    expect(requestRemoteHttpEndpoint).toHaveBeenCalledTimes(2);
  });

  it("does not restore get_me from a public catalog cached before switching to an App identity", async () => {
    const { connection, discovery, requestRemoteHttpEndpoint } = fixture("mcp-key");
    expect((await discovery.discoverTools(connection)).map(tool => tool.name)).toContain("get_me");
    connection.config = { ...connection.config, connectionMethodKey: "app-installation" };
    expect((await discovery.discoverTools(connection)).map(tool => tool.name)).toEqual(["read_repository"]);
    expect(requestRemoteHttpEndpoint).toHaveBeenCalledTimes(1);
  });

  it("probes the App MCP server during health checks even when its public catalog is cached", async () => {
    const { connection, discovery, requestRemoteHttpEndpoint, resolveCredentialHeaders, setupPolicy } = fixture("app-installation");
    await discovery.discoverTools(connection);
    expect(requestRemoteHttpEndpoint).toHaveBeenCalledTimes(1);
    const health = createConnectionHealth({} as Db, {
      now: () => new Date(), audit: vi.fn(async () => {}),
      getConnectionRow: vi.fn(async () => connection), discovery, setupPolicy,
      resolveCredentialHeaders, refreshManagedGitHubGrantAccess: vi.fn(),
      ensureRuntimeSlot: vi.fn(async () => null), stdioTemplateId: vi.fn(),
    } as unknown as Parameters<typeof createConnectionHealth>[1]);
    await health.checkConnectionHealth(connection.id);
    expect(requestRemoteHttpEndpoint).toHaveBeenCalledTimes(2);
  });
});
