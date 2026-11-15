import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentApiKeys, agentConfigRevisions, approvals, authUsers, companies, companyMemberships,
  createDb, principalPermissionGrants, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
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
  async function fixture(managed = false) {
    const companyId = randomUUID(), userId = randomUUID(), lead = randomUUID(), worker = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Gate prefix", issuePrefix: `M${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values([
      { id: lead, companyId, name: "Lead", role: "engineer", status: "idle", lifecycleState: "ready", adapterType: "paperclip_runner", adapterConfig: config("paperclip/gpt-6.1-sol"), permissions: { canCreateAgents: true } },
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
    let runtimeConfig = {};
    if (managed) {
      const account = await aiConnectionService(db).save(companyId, userId, {
        provider: "openai", method: "api_key", name: "Synthetic gateway", ownership: "personal", apiKey: "synthetic-gate-fixture",
        agentIds: [lead, worker], allAgents: false,
        routing: { kind: "gateway", protocol: "responses", baseUrl: "https://gateway.example.test/v1", auth: "bearer", models: [{ id: "gpt-6.1-sol" }] },
      }, "synthetic-gate-fixture");
      runtimeConfig = { aiConnection: { provider: "openai", method: "api_key", mode: "delegated", ...account } };
      await db.update(agents).set({ runtimeConfig })
        .where(and(eq(agents.companyId, companyId)));
    }
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: lead, name: "Lead", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express(); api.use(express.json()); api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentRoutes(db)); api.use(errorHandler);
    const call = (method: "post" | "patch", url: string, body: object) => request(api)[method](`/api${url}`).set("Authorization", `Bearer ${token}`).send(body);
    const read = async () => db.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(agents.id);
    return { companyId, lead, worker, call, read, runtimeConfig };
  }
  for (const endpoint of ["agents", "agent-hires", "patch"] as const) {
    for (const model of ["cliproxyapi/gpt-6.1-sol", "paperclip/gpt-6.1-sol"]) {
      it(`${endpoint}: ${model} is ${model.startsWith("paperclip/") ? "saved unchanged" : "refused before writes"}`, async () => {
        const f = await fixture(); const before = await f.read();
        const response = endpoint === "patch"
          ? await f.call("patch", `/agents/${f.worker}`, { adapterConfig: config(model) })
          : await f.call("post", `/companies/${f.companyId}/${endpoint}`, { name: "Hire", role: "engineer", reportsTo: f.lead, adapterType: "paperclip_runner", adapterConfig: config(model) });
        if (model.startsWith("paperclip/")) {
          expect(response.status, response.text).toBe(endpoint === "patch" ? 200 : 201);
          expect((response.body.agent ?? response.body).adapterConfig.model).toBe(model);
        } else {
          expect(response.status, response.text).toBe(422);
          expect(response.body.error).toContain("paperclip/gpt-6.1-sol");
          expect(await f.read()).toEqual(before);
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
      expect((response.body.agent ?? response.body).adapterConfig.model).toBe(model);
    });
    it(`${endpoint}: authoritative managed model catalog rejects a different unknown provider`, async () => {
      const f = await fixture(true); const before = await f.read();
      const response = endpoint === "patch"
        ? await f.call("patch", `/agents/${f.worker}`, { adapterConfig: config("unknown/gpt-6.1-sol") })
        : await f.call("post", `/companies/${f.companyId}/${endpoint}`, { name: "Hire", role: "engineer", reportsTo: f.lead, adapterType: "paperclip_runner", adapterConfig: config("unknown/gpt-6.1-sol"), runtimeConfig: f.runtimeConfig });
      expect(response.status, response.text).toBe(422);
      expect(response.body.error).toContain("paperclip/gpt-6.1-sol");
      expect(await f.read()).toEqual(before);
    });
  }
});
