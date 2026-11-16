import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentApiKeys, agentConfigRevisions, approvals, authUsers, companies, companyMemberships,
  createDb, principalPermissionGrants, toolConnectionInstalls, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Recorded catch: #20389 gate accepted cliproxyapi/gpt-6.1-sol, then native Pi
// failed with unknown provider. Exercise authenticated HTTP and real persistence.
describe("#20389 gate row: model prefix", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "model-prefix-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("model-prefix-db-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await rm(home, { recursive: true, force: true });
  });
  const config = (model: string) => ({ provider: "pi_rpc", model, piRpcThinkingLevel: "high" });
  async function fixture(managed: boolean | "claude" = false) {
    const companyId = randomUUID(), userId = randomUUID(), lead = randomUUID(), worker = randomUUID();
    const leadModel = managed === "claude" ? "paperclip/claude-opus-5-5" : "paperclip/gpt-6.1-sol";
    await db.insert(companies).values({ id: companyId, name: "Gate prefix", issuePrefix: `M${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values([
      { id: lead, companyId, name: "Lead", role: "engineer", status: "idle", lifecycleState: "ready", adapterType: "paperclip_runner", adapterConfig: config(leadModel), permissions: { canCreateAgents: true } },
      { id: worker, companyId, name: "Worker", role: "engineer", reportsTo: lead, status: "idle", lifecycleState: "ready", adapterType: "paperclip_runner", adapterConfig: config("paperclip/gpt-6.1-sol") },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...[lead, worker].map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(principalPermissionGrants).values([
      ...["agents:create", "agents:configure", "agents:read"].map(permissionKey => ({ companyId, principalType: "user" as const, principalId: userId, permissionKey })),
      { companyId, principalType: "agent", principalId: lead, permissionKey: "agents:configure", scope: { subtreeRootAgentId: lead } },
    ]);
    let runtimeConfig: { aiConnection?: AiConnectionBinding } = {};
    if (managed) {
      const claude = managed === "claude";
      const provider = claude ? "anthropic" : "openai";
      const account = await aiConnectionService(db).save(companyId, userId, {
        provider, method: "api_key", name: "Synthetic gateway", ownership: claude ? "shared" : "personal", apiKey: "synthetic-gate-fixture",
        agentIds: [lead, worker], allAgents: claude,
        routing: { kind: "gateway", protocol: claude ? "messages" : "responses", baseUrl: "https://gateway.example.test/v1", auth: "bearer", models: [{ id: claude ? "claude-sonnet-5" : "gpt-6.1-sol" }] },
      }, "synthetic-gate-fixture");
      runtimeConfig = { aiConnection: { provider, method: "api_key", mode: claude ? "shared" : "delegated", ...account } };
      await db.update(agents).set({ runtimeConfig })
        .where(and(eq(agents.companyId, companyId)));
    }
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: lead, name: "Lead", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express(); api.use(express.json()); api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentRoutes(db)); api.use(errorHandler);
    const call = (method: "post" | "patch", url: string, body: object) => request(api)[method](`/api${url}`).set("Authorization", `Bearer ${token}`).send(body);
    const read = async () => db.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(agents.id);
    const writes = async () => Promise.all([
      read(),
      db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.companyId, companyId)).orderBy(agentConfigRevisions.id),
      db.select().from(approvals).where(eq(approvals.companyId, companyId)).orderBy(approvals.id),
      db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id),
      db.select().from(companyMemberships).where(eq(companyMemberships.companyId, companyId)).orderBy(companyMemberships.id),
      db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId)).orderBy(principalPermissionGrants.id),
      db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId)).orderBy(toolConnectionInstalls.id),
    ]);
    return { companyId, lead, worker, call, read, writes, runtimeConfig, leadModel };
  }
  for (const endpoint of ["agents", "agent-hires", "patch"] as const) {
    for (const model of ["cliproxyapi/gpt-6.1-sol", "cliproxyapi-anthropic/claude-opus-5-5", "paperclip/gpt-6.1-sol"]) {
      it(`${endpoint}: ${model} is ${model.startsWith("paperclip/") ? "saved unchanged" : "refused before writes"}`, async () => {
        const f = await fixture(); const before = await f.writes();
        const response = endpoint === "patch"
          ? await f.call("patch", `/agents/${f.worker}`, { adapterConfig: config(model) })
          : await f.call("post", `/companies/${f.companyId}/${endpoint}`, { name: "Hire", role: "engineer", reportsTo: f.lead, adapterType: "paperclip_runner", adapterConfig: config(model) });
        if (model.startsWith("paperclip/")) {
          expect(response.status, response.text).toBe(endpoint === "patch" ? 200 : 201);
          expect((response.body.agent ?? response.body).adapterConfig.model).toBe(model);
        } else {
          expect(response.status, response.text).toBe(422);
          expect(response.body.error).toContain(`paperclip/${model.slice(model.indexOf("/") + 1)}`);
          expect(response.body.details?.code).toBe("pi_rpc_model_provider_unknown");
          expect(await f.writes()).toEqual(before);
          expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, f.worker))).toEqual([]);
          expect(await db.select().from(approvals).where(eq(approvals.companyId, f.companyId))).toEqual([]);
        }
      });
    }
    it(`${endpoint}: accepted managed catalog model is saved unchanged`, async () => {
      const f = await fixture(true);
      const model = "paperclip/gpt-6.1-sol";
      const response = endpoint === "patch"
        ? await f.call("patch", `/agents/${f.worker}`, { adapterConfig: config(model) })
        : await f.call("post", `/companies/${f.companyId}/${endpoint}`, { name: "Hire", role: "engineer", reportsTo: f.lead, adapterType: "paperclip_runner", adapterConfig: config(model), runtimeConfig: f.runtimeConfig });
      expect(response.status, response.text).toBe(endpoint === "patch" ? 200 : 201);
      const saved = response.body.agent ?? response.body;
      expect(saved.adapterConfig.model).toBe(model);
      expect(saved.runtimeConfig.aiConnection).toEqual(f.runtimeConfig.aiConnection);
      expect((await f.read()).find(agent => agent.id === saved.id)?.adapterConfig.model).toBe(model);
    });
    // Supersedes the over-broad catalog rejection; see NEEDS-RFL.md.
    it(`${endpoint}: ordinary managed writes do not enforce the model catalog`, async () => {
      const f = await fixture(true);
      const response = endpoint === "patch"
        ? await f.call("patch", `/agents/${f.worker}`, { adapterConfig: config("unknown/gpt-6.1-sol") })
        : await f.call("post", `/companies/${f.companyId}/${endpoint}`, { name: "Hire", role: "engineer", reportsTo: f.lead, adapterType: "paperclip_runner", adapterConfig: config("unknown/gpt-6.1-sol"), runtimeConfig: f.runtimeConfig });
      expect(response.status, response.text).toBe(endpoint === "patch" ? 200 : 201);
      const saved = response.body.agent ?? response.body;
      expect(saved.adapterConfig.model).toBe("unknown/gpt-6.1-sol");
      expect(saved.runtimeConfig.aiConnection).toEqual(f.runtimeConfig.aiConnection);
      expect((await f.read()).find(agent => agent.id === saved.id)?.adapterConfig.model).toBe("unknown/gpt-6.1-sol");
    });
  }

  it("agent-hires: an Opus lead inherits its Claude connection and model even when the catalog omits Opus", async () => {
    const f = await fixture("claude");
    const caller = (await f.read()).find(agent => agent.id === f.lead)!;
    const response = await f.call("post", `/companies/${f.companyId}/agent-hires`, {
      name: "Inherited Opus teammate", role: "engineer", reportsTo: f.lead,
      adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
      instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": "# Teammate\nReport findings to your lead.\n" } },
    });
    expect(response.status, response.text).toBe(201);
    expect(response.body.agent.adapterConfig).toMatchObject(caller.adapterConfig);
    expect(response.body.agent.runtimeConfig.aiConnection).toEqual(caller.runtimeConfig.aiConnection);
    const saved = (await f.read()).find(agent => agent.id === response.body.agent.id)!;
    expect(saved.adapterConfig.model).toBe(caller.adapterConfig.model);
    expect(saved.runtimeConfig.aiConnection).toEqual(caller.runtimeConfig.aiConnection);
    expect(await db.select().from(toolConnectionInstalls).where(and(
      eq(toolConnectionInstalls.targetId, saved.id),
      eq(toolConnectionInstalls.connectionId, f.runtimeConfig.aiConnection!.mode === "shared" ? f.runtimeConfig.aiConnection!.connectionId : ""),
    ))).toHaveLength(1);
  });

  for (const listed of [false, true]) {
    it(`runtime settings: a ${listed ? "listed" : "non-catalog"} Pi default model is ${listed ? "saved" : "refused before writes"}`, async () => {
      const f = await fixture(true); const before = await f.writes();
      const model = listed ? "paperclip/gpt-6.1-sol" : "paperclip/not-in-catalog";
      const response = await f.call("patch", `/agents/${f.worker}`, {
        runtimeSettings: { harness: "pi_rpc", expected: { model: "paperclip/gpt-6.1-sol", aiConnection: f.runtimeConfig.aiConnection }, model },
      });
      expect(response.status, response.text).toBe(listed ? 200 : 422);
      if (listed) {
        expect(response.body.adapterConfig.model).toBe(model);
      } else {
        expect(response.body.error).toContain("Choose a default model available on the selected connection");
        expect(await f.writes()).toEqual(before);
      }
    });
  }
});
