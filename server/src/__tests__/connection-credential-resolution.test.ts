import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companySecretBindings, connectionGrants, createDb, toolConnections,
  startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport,
} from "@paperclipai/db";
import { createToolConnectionSchema } from "@paperclipai/shared";
import { connectionGrantCredentialRef } from "../services/connection-credentials.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { createListingFixture } from "./helpers/tool-gateway-listing-fixture.js";

// Keep: credential projection is a trust boundary. This reproduces the real
// bare-header / headers.* grant mismatch without accessing live credentials.
describe("connection grant credential names", () => {
  it("resolves bare header names without changing explicit credential paths", () => {
    const header = { configPath: "headers.Authorization", secretId: "header-secret" };
    const credential = { configPath: "credentials.Authorization", secretId: "credential-secret" };
    expect(connectionGrantCredentialRef({ credentialSecretRefs: [header] },
      { name: "Authorization", placement: "header" })).toEqual(header);
    expect(connectionGrantCredentialRef({ credentialSecretRefs: [header, credential] },
      { name: "credentials.Authorization", placement: "header" })).toEqual(credential);
    expect(connectionGrantCredentialRef({ credentialSecretRefs: [credential] },
      { name: "Authorization", placement: "header" })).toEqual(credential);
    expect(connectionGrantCredentialRef({ credentialSecretRefs: [header] },
      { name: "Authorization", placement: "env" })).toBeUndefined();
    expect(connectionGrantCredentialRef({ credentialSecretRefs: [header] },
      { name: "missing", placement: "header" })).toBeUndefined();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("connection credentials through MCP HTTP", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-credential-resolution-");
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(unresolvable = false) {
    const result = await createListingFixture(db, 6);
    const expected = {
      Authorization: "Bearer fixture-token",
      "CF-Access-Client-Id": "fixture-client-id",
      "CF-Access-Client-Secret": "fixture-client-secret",
    };
    const credentialSecretRefs = [];
    const credentialRefs = [];
    for (const [name, value] of Object.entries(expected)) {
      const secret = await secretService(db).create(result.company.id, {
        provider: "local_encrypted", name, key: `credential.${randomUUID()}`, value,
      });
      const configPath = `headers.${name}`;
      await db.insert(companySecretBindings).values({ companyId: result.company.id,
        secretId: secret.id, targetType: "tool_connection", targetId: result.connection.id, configPath });
      credentialSecretRefs.push({ configPath, secretId: secret.id, versionSelector: "latest" as const });
      credentialRefs.push({ name: unresolvable && name === "Authorization" ? "Unmapped-Authorization" : name,
        placement: "header" as const, key: name, secretId: secret.id, version: "latest" as const });
    }
    await db.update(toolConnections).set({ authKind: "api_key", credentialRefs, credentialSecretRefs })
      .where(eq(toolConnections.id, result.connection.id));
    await db.insert(connectionGrants).values({ companyId: result.company.id, connectionId: result.connection.id,
      kind: "organization", status: "active", isDefault: true, credentialSecretRefs });
    return { ...result, expected, credentialRefs, credentialSecretRefs };
  }

  it("sends all three legacy bare-named headers on tools/call and discovery", async () => {
    const f = await fixture();
    const methods: string[] = [];
    const remoteHttpRequest = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(f.expected)) expect(headers.get(name), `${body.method}: ${name}`).toBe(value);
      methods.push(body.method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
        : body.method === "tools/list" ? { tools: [{ name: "tool_0004", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "authenticated fixture result" }] } }),
      { headers: { "content-type": "application/json" } });
    };
    const gateway = createToolGatewayService(db, { remoteHttpRequest });
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));
    const post = (method: string, params?: unknown) => request(app)
      .post(`/mcp/gateways/${f.namedGateway.gatewayPublicId}`)
      .set("Authorization", `Bearer ${f.token.token}`).send({ jsonrpc: "2.0", id: 1, method, params });
    const listed = await post("tools/list").expect(200);
    const descriptors = await gateway.listToolsForNamedGateway({ gatewayId: f.namedGateway.id, bearerToken: f.token.token });
    const tool = descriptors.find(entry => entry.catalogEntryId === f.entries[4]!.id)!;
    expect(listed.body.result.tools.some((entry: { name: string }) => entry.name === tool.name)).toBe(true);
    const called = await post("tools/call", { name: tool.name, arguments: {} });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    expect(called.body.result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("authenticated fixture result") }),
    ]));
    expect(methods).toContain("tools/call");
    await toolAccessService(db, { remoteHttpRequest }).refreshCatalog(f.connection.id);
    expect(methods).toContain("tools/list");
  });

  it("fails closed with grant_credential_invalid on tools/call before dispatch", async () => {
    const f = await fixture(true);
    let dispatches = 0;
    const remoteHttpRequest = async () => { dispatches += 1; throw new Error("must not dispatch without credentials"); };
    const gateway = createToolGatewayService(db, { remoteHttpRequest });
    const tools = await gateway.listToolsForNamedGateway({ gatewayId: f.namedGateway.id, bearerToken: f.token.token });
    const tool = tools.find(entry => entry.catalogEntryId === f.entries[4]!.id)!;
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));
    const called = await request(app).post(`/mcp/gateways/${f.namedGateway.gatewayPublicId}`)
      .set("Authorization", `Bearer ${f.token.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: {} } });
    expect(called.status, JSON.stringify(called.body)).toBe(422);
    expect(called.body.error.data.reasonCode).toBe("grant_credential_invalid");
    expect(dispatches).toBe(0);
  });

  it("does not bypass an unmappable organization grant during shared-credential discovery", async () => {
    const f = await fixture(true);
    let dispatches = 0;
    const remoteHttpRequest = async () => { dispatches += 1; throw new Error("must not dispatch without credentials"); };
    await expect(toolAccessService(db, { remoteHttpRequest }).refreshCatalog(f.connection.id))
      .rejects.toMatchObject({ status: 422, details: { code: "grant_credential_invalid" } });
    expect(dispatches).toBe(0);
  });

  it("stores canonical header names on create and PATCH", async () => {
    const f = await fixture();
    const service = toolAccessService(db);
    const created = await service.createConnection(f.company.id, createToolConnectionSchema.parse({
      name: "Canonical credential connection", applicationId: f.application.id,
      transport: "mcp_remote", config: { url: "https://8.8.8.8/mcp" },
      credentialRefs: f.credentialRefs, credentialSecretRefs: f.credentialSecretRefs,
    }));
    const names = f.credentialSecretRefs.map(ref => ref.configPath);
    expect(created.credentialRefs?.map(ref => ref.name)).toEqual(names);
    const updated = await service.updateConnection(created.id, { credentialRefs: f.credentialRefs });
    expect(updated.credentialRefs?.map(ref => ref.name)).toEqual(names);
    const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, created.id));
    expect(stored!.credentialRefs.map(ref => ref.name)).toEqual(names);
  });
});
