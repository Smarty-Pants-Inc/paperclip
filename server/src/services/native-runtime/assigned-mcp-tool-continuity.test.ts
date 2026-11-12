import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, connectionGrants, createDb, heartbeatRunEvents, heartbeatRuns, issues,
  toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolInvocations,
  toolProfileBindings, toolProfileEntries, toolProfiles,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { buildPaperclipRuntimeMcpServers } from "../heartbeat/run-preparation.js";
import { createToolGatewayService } from "../tool-gateway.js";
import { subscribeCompanyLiveEvents } from "../live-events.js";
import { createAssignedMcpTools } from "./assigned-mcp-tools.js";
import { resolveNativeRuntimeMcpSnapshot } from "./runtime-context.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

// Keep: the recorded 669f458a -> bebd5a14 incident lost the entire aggregate
// gateway after one failed app call. Exercise persistence, snapshot, handoff,
// named-gateway discovery and runner aliases, rather than a mocked catalog.
describePostgres("assigned MCP tools across failed calls and subsequent runs", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-tool-continuity-");
    db = createDb(database.connectionString);
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
  }, 20_000);

  afterAll(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await database?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: `MCP continuity ${randomUUID()}`, issuePrefix: `MC${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company.id, name: "MCP continuity agent", role: "engineer", adapterType: "paperclip_runner", adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id, applicationKey: `continuity-${randomUUID()}`, name: "Continuity MCP", type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id, applicationId: application.id, name: "HQ mail fixture", uid: `test/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared",
      config: { url: "https://8.8.8.8/mcp" },
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: company.id, connectionId: connection.id, kind: "organization", status: "active", isDefault: true, credentialSecretRefs: [],
    });
    await db.insert(toolCatalogEntries).values(["calendar_freebusy", "read_status"].map(name => ({
      companyId: company.id, applicationId: application.id, connectionId: connection.id, entryKind: "tool" as const,
      name, toolName: name, riskLevel: "read" as const, isReadOnly: true, status: "active" as const,
      versionHash: randomUUID(), schemaHash: randomUUID(),
    })));
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id, profileKey: `app:${connection.id}`, name: "Continuity access", defaultAction: "deny",
      metadata: { source: "app_gallery_finish", connectionId: connection.id },
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company.id, profileId: profile.id, selectorType: "connection", effect: "include",
      applicationId: application.id, connectionId: connection.id,
    });
    await db.insert(toolProfileBindings).values({
      companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id,
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: company.id, connectionId: connection.id, targetType: "agent", targetId: agent.id,
    });
    const newRun = async () => {
      const [issue] = await db.insert(issues).values({
        companyId: company.id, title: "Next MCP task", status: "in_progress", assigneeAgentId: agent.id,
      }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id },
      }).returning();
      return { run, issue };
    };
    const prepare = async (runId: string, gateway: ReturnType<typeof createToolGatewayService>) => {
      const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent, runId });
      const servers = await buildPaperclipRuntimeMcpServers({ db, agent, runId, expectedAssignmentDigest: snapshot.digest });
      expect(snapshot.bindingId).toBe(`native-mcp:${runId}`);
      expect(servers).toHaveLength(1);
      const server = servers[0];
      const assigned = await createAssignedMcpTools({
        gateway, gatewayPublicId: new URL(server.url).pathname.split("/").at(-1)!, bearerToken: server.token,
      });
      return { snapshot, assigned, names: assigned.definitions().map(tool => tool.name) };
    };
    return { company, agent, connection, newRun, prepare };
  }

  it.each([401, 403])("retains all app tools on a different issue after tools/call HTTP %s without replay", async status => {
    const f = await fixture();
    const provider = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init.body));
      return provider.mock.calls.length === 1 ? new Response("Action refused", { status })
        : Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "available" }] } });
    });
    const gateway = createToolGatewayService(db, { remoteHttpRequest: provider });
    const firstRun = await f.newRun();
    const first = await f.prepare(firstRun.run.id, gateway);
    expect(first.names).toHaveLength(2);
    expect(first.names.every(name => String(name).startsWith("app_"))).toBe(true);
    const failingName = first.names.find(name => String(name).includes("calendar_freebusy")) as string;
    expect(failingName).toMatch(/^app_/);
    await expect(first.assigned.execute({ tool: failingName, arguments: {} }))
      .rejects.toMatchObject({ reasonCode: "mcp_remote_status", details: { status } });
    expect(provider).toHaveBeenCalledTimes(1);
    const [failed] = await db.select().from(toolInvocations).where(eq(toolInvocations.runId, firstRun.run.id));
    expect(failed).toMatchObject({ status: "failed", errorCode: "mcp_remote_status" });
    const [afterFailure] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    expect(afterFailure).toMatchObject({ status: "active", enabled: true, healthStatus: "ok", updatedAt: f.connection.updatedAt });

    const nextRun = await f.newRun();
    expect(nextRun.issue.id).not.toBe(firstRun.issue.id);
    const next = await f.prepare(nextRun.run.id, gateway);
    expect(next.snapshot.digest).toBe(first.snapshot.digest);
    expect(next.names).toEqual(first.names);
    expect(next.names.filter(name => String(name).startsWith("app_"))).not.toHaveLength(0);
    await expect(next.assigned.execute({ tool: failingName, arguments: {} })).resolves.toBeDefined();
    expect(provider).toHaveBeenCalledTimes(2);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    expect(connection).toMatchObject({ status: "active", enabled: true, healthStatus: "ok" });
  });

  it.each([
    { enabled: false, status: "disabled", healthStatus: "ok" },
    { enabled: true, status: "active", healthStatus: "error" },
  ])("records a visible run diagnostic for an unavailable installed connection: $status / $healthStatus", async unavailable => {
    const f = await fixture();
    await db.update(toolConnections).set({ ...unavailable, healthMessage: "private-provider-diagnostic-canary" }).where(eq(toolConnections.id, f.connection.id));
    const { run } = await f.newRun();
    const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent: f.agent, runId: run.id });
    expect(snapshot.bindingId).toBeNull();
    const published: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeCompanyLiveEvents(f.company.id, event => {
      if (event.type === "heartbeat.run.event") published.push(event.payload);
    });
    try {
      await expect(buildPaperclipRuntimeMcpServers({ db, agent: f.agent, runId: run.id, expectedAssignmentDigest: null }))
        .resolves.toEqual([]);
    } finally {
      unsubscribe();
    }
    expect(published).toMatchObject([{
      runId: run.id, eventType: "tool_gateway.runtime_mcp_delivery", level: "warn", message: expect.stringContaining("HQ mail fixture"),
    }]);
    const diagnostics = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.eventType, "tool_gateway.runtime_mcp_delivery"),
    ));
    expect(diagnostics).toMatchObject([{
      level: "warn", stream: "system", message: expect.stringContaining("HQ mail fixture"),
      payload: { reasonCode: "assigned_connections_unavailable", unavailableConnections: [{ id: f.connection.id, ...unavailable }] },
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain("8.8.8.8");
    expect(JSON.stringify(diagnostics)).not.toContain("private-provider-diagnostic-canary");
  });

  it("keeps changed assignments fail-closed and explains the missing gateway in the run", async () => {
    const f = await fixture();
    const { run } = await f.newRun();
    await expect(buildPaperclipRuntimeMcpServers({ db, agent: f.agent, runId: run.id, expectedAssignmentDigest: "stale-assignment" }))
      .resolves.toEqual([]);
    const diagnostics = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.eventType, "tool_gateway.runtime_mcp_delivery"),
    ));
    expect(diagnostics).toMatchObject([{
      level: "warn", payload: { reasonCode: "native_mcp_assignment_changed", deliveredServerCount: 0 },
    }]);
  });
});
