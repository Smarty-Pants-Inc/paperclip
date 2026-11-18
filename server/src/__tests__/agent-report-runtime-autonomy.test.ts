import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentApiKeys, agentConfigRevisions, approvals, authUsers, budgetPolicies, companies, companyMemberships,
  companySecretBindings, createDb, heartbeatRuns, principalPermissionGrants, projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { costRoutes } from "../routes/costs.js";
import { secretService } from "../services/secrets.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { boardAuthService } from "../services/board-auth.js";
import { parseHeartbeatPolicy } from "../services/heartbeat/timer-policy.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";

// Trust boundary/data safety: real bearer auth, authorization, routes and Postgres persistence.
// Mirrors tl-autonomy-0610 without touching its live gate or starting agent runs.
describe("manager report runtime autonomy", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "report-runtime-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "report-runtime-synthetic-jwt-fixture";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(home, "fixture-master.key");
    database = await startEmbeddedPostgresTestDatabase("report-runtime-");
    db = createDb(database.connectionString);
    closeProcessRunAdmission();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end(); await database?.cleanup();
    resetProcessRunAdmissionForTests();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
  });
  async function seed() {
    const companyId = randomUUID(), userId = randomUUID();
    const ids = { primary: randomUUID(), lead: randomUUID(), worker: randomUUID(), outside: randomUUID(), local: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Report runtime", issuePrefix: `R${companyId.slice(0, 7)}`, budgetMonthlyCents: 50_000, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    for (const name of ["primary", "outside", "lead", "worker", "local"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId, name, role: "engineer", adapterType: name === "local" ? "pi_local" : "paperclip_runner",
        adapterConfig: name === "local" ? {} : { provider: "pi_rpc", model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "high" },
        status: "idle", lifecycleState: "ready", budgetMonthlyCents: 100,
        reportsTo: name === "worker" ? ids.lead : name === "lead" || name === "local" ? ids.primary : null,
        permissions: { canCreateAgents: true, canAssignTasks: true }, runtimeConfig: { heartbeat: { enabled: false } } });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...Object.values(ids).map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(principalPermissionGrants).values([
      ...(["agents:configure", "agents:read", "agents:create", "agents:configure-reports-runtime"] as const).map(permissionKey => ({ companyId, principalType: "user" as const, principalId: userId, permissionKey })),
      ...Object.values(ids).flatMap(principalId => [
        { companyId, principalType: "agent" as const, principalId, permissionKey: "agents:configure", scope: { subtreeRootAgentId: principalId } },
        { companyId, principalType: "agent" as const, principalId, permissionKey: "agents:configure-reports-runtime", scope: null },
      ]),
    ]);
    const tokens = {} as Record<keyof typeof ids, string>;
    for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
      tokens[name] = randomUUID();
      await db.insert(agentApiKeys).values({ companyId, agentId: ids[name], name, responsibleUserId: userId, keyHash: createHash("sha256").update(tokens[name]).digest("hex") });
    }
    const api = express(); api.use(express.json()); api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", costRoutes(db)); api.use("/api", agentRoutes(db)); api.use(errorHandler);
    const call = (method: "patch" | "post" | "delete" | "get", url: string, body: object = {}, actor: keyof typeof ids = "primary") =>
      request(api)[method](`/api${url}`).set("Authorization", `Bearer ${tokens[actor]}`).send(body);
    const patchEnv = (id: string, env: object) => call("patch", `/agents/${id}`, { adapterConfig: { env } });
    const readAgent = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
    return { ids, companyId, userId, call, patchEnv, readAgent, api };
  }
  const refusal = "Agent keys cannot configure host-executed local adapter settings (env).";

  it("a: a manager persists a plain env value on its runner report", async () => {
    const f = await seed(); const response = await f.patchEnv(f.ids.lead, { ROW_VAR: "hello" });
    expect(response.status, response.text).toBe(200);
    expect((await f.readAgent(f.ids.lead)).adapterConfig.env).toEqual({ ROW_VAR: { type: "plain", value: "hello" } });
  });
  it("b: a manager binds a secret it can resolve, with reference readback", async () => {
    const f = await seed(); const svc = secretService(db);
    const secret = await svc.create(f.companyId, { name: "row-demo", provider: "local_encrypted", value: "non-sensitive-fixture" });
    const binding = { type: "secret_ref", secretId: secret.id, version: "latest" };
    await svc.createBinding({ companyId: f.companyId, secretId: secret.id, targetType: "agent", targetId: f.ids.primary, configPath: "env.ROW_DEMO_TOKEN" });
    // Prove the existing own-run resolution admits the caller, not just a grant row.
    expect((await svc.resolveAdapterConfigForRuntime(f.companyId, { env: { ROW_DEMO_TOKEN: binding } }, { consumerType: "agent", consumerId: f.ids.primary })).secretKeys.has("ROW_DEMO_TOKEN")).toBe(true);
    const response = await f.patchEnv(f.ids.lead, { ROW_DEMO_TOKEN: binding });
    expect(response.status, response.text).toBe(200);
    const normalizedBinding = { ...binding, projectionClass: "unclassified", projectionAllowlistKey: null };
    expect((await f.readAgent(f.ids.lead)).adapterConfig.env).toEqual({ ROW_DEMO_TOKEN: normalizedBinding });
    expect((await f.call("get", `/agents/${f.ids.lead}`)).body.adapterConfig.env.ROW_DEMO_TOKEN).toEqual(normalizedBinding);
    expect(await db.select().from(companySecretBindings).where(and(eq(companySecretBindings.targetId, f.ids.lead), eq(companySecretBindings.secretId, secret.id))))
      .toEqual([expect.objectContaining({ configPath: "env.ROW_DEMO_TOKEN" })]);
  });
  it("c: an unresolvable secret is refused by id, atomically with plain env values", async () => {
    const f = await seed(); const svc = secretService(db);
    const secret = await svc.create(f.companyId, { name: "unavailable-row-demo", provider: "local_encrypted", value: "unavailable-fixture-value" });
    const before = await f.readAgent(f.ids.lead);
    const response = await f.patchEnv(f.ids.lead, { ROW_VAR: "must-not-stick", ROW_DEMO_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } });
    expect(response.status, response.text).toBe(403);
    expect(response.body.error).toContain(secret.id);
    expect(response.text).not.toContain("unavailable-fixture-value");
    expect(await f.readAgent(f.ids.lead)).toEqual(before);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, f.ids.lead))).toEqual([]);
  });
  for (const inherited of [true, false]) {
    it(`b/c run-bound: a project secret ${inherited ? "in" : "outside"} the current run manifest`, async () => {
      const f = await seed(); const svc = secretService(db); const runId = randomUUID();
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Runtime manifest project" });
      const secret = await svc.create(f.companyId, { name: "inherited-fixture", provider: "local_encrypted", value: "synthetic-inherited-value" });
      const binding = await svc.createBinding({ companyId: f.companyId, secretId: secret.id, targetType: "project", targetId: projectId, configPath: "env.INHERITED_TOKEN" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.ids.primary, responsibleUserId: f.userId,
        status: "running", contextSnapshot: { paperclipSecrets: { manifest: inherited ? [{ bindingId: binding.id }] : [] } } });
      const token = createLocalAgentJwt(f.ids.primary, f.companyId, "paperclip_runner", runId, f.userId)!;
      const response = await request(f.api).patch(`/api/agents/${f.ids.lead}`).set("Authorization", `Bearer ${token}`)
        .send({ adapterConfig: { env: { INHERITED_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } } } });
      expect(response.status, response.text).toBe(inherited ? 200 : 403);
      if (!inherited) { expect(response.body.error).toContain(secret.id); expect((await f.readAgent(f.ids.lead)).adapterConfig.env).toBeUndefined(); }
      else {
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
        const stopped = await request(f.api).patch(`/api/agents/${f.ids.worker}`).set("Authorization", `Bearer ${token}`)
          .send({ adapterConfig: { env: { INHERITED_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } } } });
        expect(stopped.status, stopped.text).toBe(403);
        expect((await f.readAgent(f.ids.worker)).adapterConfig.env).toBeUndefined();
      }
    });
  }
  it("d: the same plain env update is allowed two reporting levels down", async () => {
    const f = await seed(); const response = await f.patchEnv(f.ids.worker, { ROW_VAR: "grand-report" });
    expect(response.status, response.text).toBe(200);
    expect((await f.readAgent(f.ids.worker)).adapterConfig.env).toEqual({ ROW_VAR: { type: "plain", value: "grand-report" } });
  });
  for (const [label, target] of [["e", "outside"], ["f", "primary"], ["h", "local"]] as const) {
    it(`${label}: ${target} keeps today's env refusal and persisted state`, async () => {
      const f = await seed(); const before = await f.readAgent(f.ids[target]);
      const response = await f.patchEnv(f.ids[target], { ROW_VAR: "no" });
      expect(response.status, response.text).toBe(403); expect(response.body.error).toBe(refusal);
      expect(await f.readAgent(f.ids[target])).toEqual(before);
    });
  }
  for (const key of ["command", "hermesCommand", "args", "extraArgs", "cwd", "filesystemSandboxCommand"] as const) {
    it(`g: ${key} remains refused even together with runner report env`, async () => {
      const f = await seed(); const before = await f.readAgent(f.ids.lead);
      const response = await f.call("patch", `/agents/${f.ids.lead}`, { adapterConfig: { [key]: key === "args" || key === "extraArgs" ? ["--unsafe"] : "/tmp/unsafe", env: { ROW_VAR: "no" } } });
      expect(response.status, response.text).toBe(403);
      expect(response.body.error).toContain("Agent keys cannot configure host-executed local adapter settings");
      expect(response.body.error).toContain(key); expect(await f.readAgent(f.ids.lead)).toEqual(before);
    });
  }
  it("i: removing the company-scoped runtime permission restores today's env refusal", async () => {
    const f = await seed();
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, f.companyId), eq(principalPermissionGrants.permissionKey, "agents:configure-reports-runtime")));
    for (const id of [f.ids.lead, f.ids.worker]) {
      const response = await f.patchEnv(id, { ROW_VAR: "no" });
      expect(response.status, response.text).toBe(403); expect(response.body.error).toBe(refusal);
      expect((await f.readAgent(id)).adapterConfig.env).toBeUndefined();
    }
  });
  for (const target of ["lead", "worker"] as const) for (const amount of [0, 1, 100_000]) {
    it(`j-agent: hirer sets ${target} budget to ${amount} through both aliases`, async () => {
      const f = await seed();
      for (const suffix of ["/budgets", ""]) {
        const response = await f.call("patch", `/agents/${f.ids[target]}${suffix}`, { budgetMonthlyCents: amount });
        expect(response.status, response.text).toBe(200); expect((await f.readAgent(f.ids[target])).budgetMonthlyCents).toBe(amount);
      }
      expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]!.budgetMonthlyCents).toBe(50_000);
    });
  }
  for (const leader of ["primary", "lead", "outside"] as const) {
    it(`j-project: primary may set a project led by ${leader} only inside its subtree`, async () => {
      const f = await seed(); const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Autonomy project", leadAgentId: f.ids[leader] });
      for (const amount of [100_000, 0]) {
        const response = await f.call("post", `/companies/${f.companyId}/budgets/policies`, { scopeType: "project", scopeId: projectId, amount });
        expect(response.status, response.text).toBe(leader === "outside" ? 403 : 200);
      }
      const rows = await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, projectId));
      expect(rows).toHaveLength(leader === "outside" ? 0 : 1);
      if (rows.length) expect(rows[0]).toMatchObject({ amount: 0, isActive: false });
    });
  }
  for (const alias of ["budgets", "budgets/policies"] as const) for (const linked of [true, false]) {
    it(`j-company: primary sets ${alias} with ${linked ? "linked principal ask" : "explicit missing-link audit"}`, async () => {
      const f = await seed(); const principalRequestUrl = `https://paperclip.example/tasks/${randomUUID()}#comment-${randomUUID()}`;
      const response = await f.call(alias === "budgets" ? "patch" : "post", `/companies/${f.companyId}/${alias}`,
        { ...(alias === "budgets" ? { budgetMonthlyCents: 0 } : { scopeType: "company", scopeId: f.companyId, amount: 0 }), ...(linked ? { principalRequestUrl } : {}) });
      expect(response.status, response.text).toBe(200);
      const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "budget.policy_upserted")));
      expect(audit).toMatchObject({ actorType: "agent", actorId: f.ids.primary, details: expect.objectContaining({ principalRequestUrl: linked ? principalRequestUrl : "no principal request linked" }) });
      expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]!.budgetMonthlyCents).toBe(0);
    });
  }
  for (const actor of ["lead", "worker"] as const) {
    it(`j-company: ${actor} cannot set company budgets through either alias or resolve incidents`, async () => {
      const f = await seed();
      for (const [method, suffix, body] of [["patch", "budgets", { budgetMonthlyCents: 0 }], ["post", "budgets/policies", { scopeType: "company", scopeId: f.companyId, amount: 0 }],
        ["post", `budget-incidents/${randomUUID()}/resolve`, { action: "keep_paused" }]] as const) {
        expect((await f.call(method, `/companies/${f.companyId}/${suffix}`, body, actor)).status).toBe(403);
      }
      expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]!.budgetMonthlyCents).toBe(50_000);
    });
  }
  for (const [actor, target] of [["primary", "lead"], ["lead", "worker"]] as const) {
    it(`daily cap: ${actor} cannot stop ${target} by setting maxDailyCostCents to zero`, async () => {
      const f = await seed(); const before = await f.readAgent(f.ids[target]);
      const response = await f.call("patch", `/agents/${f.ids[target]}`, {
        name: "must-not-stick", budgetMonthlyCents: 123_456,
        adapterConfig: { env: { ROW_VAR: "must-not-stick" } },
        runtimeConfig: { heartbeat: { enabled: false, maxDailyCostCents: 0 } },
      }, actor);
      expect(response.status, response.text).toBe(422);
      expect(response.body.error).toBe("maxDailyCostCents 0 stops the agent; omit the field (or send null) to remove the daily cap");
      expect(await f.readAgent(f.ids[target])).toEqual(before);
      expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, f.ids[target]))).toEqual([]);
      expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, f.ids[target]))).toEqual([]);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.ids[target]))).toEqual([]);
    });
  }
  for (const amount of [250, null, undefined]) {
    it(`daily cap: a manager can send ${amount === undefined ? "an absent field" : amount}`, async () => {
      const f = await seed();
      await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, maxDailyCostCents: 500 } } }).where(eq(agents.id, f.ids.worker));
      const heartbeat = { enabled: false, ...(amount === undefined ? {} : { maxDailyCostCents: amount }) };
      const response = await f.call("patch", `/agents/${f.ids.worker}`, { runtimeConfig: { heartbeat } }, "lead");
      expect(response.status, response.text).toBe(200);
      const saved = await f.readAgent(f.ids.worker);
      expect(saved.runtimeConfig.heartbeat).toEqual(heartbeat);
      expect(parseHeartbeatPolicy(saved).maxDailyCostCents).toBe(amount ?? null);
    });
  }
  it("daily cap: a board user retains zero, positive, null and absent behavior", async () => {
    const f = await seed();
    const key = await boardAuthService(db).createNamedBoardApiKey({ userId: f.userId, name: "Daily cap fixture" });
    for (const amount of [0, 250, null, undefined]) {
      const heartbeat = { enabled: false, ...(amount === undefined ? {} : { maxDailyCostCents: amount }) };
      const response = await request(f.api).patch(`/api/agents/${f.ids.worker}`)
        .set("Authorization", `Bearer ${key.token}`).send({ runtimeConfig: { heartbeat } });
      expect(response.status, response.text).toBe(200);
      const saved = await f.readAgent(f.ids.worker);
      expect(saved.runtimeConfig.heartbeat).toEqual(heartbeat);
      expect(parseHeartbeatPolicy(saved).maxDailyCostCents).toBe(amount ?? null);
    }
  });
  for (const [route, requiresApproval] of [["agents", false], ["agent-hires", false], ["agent-hires", true]] as const) {
    function hireBody(reportsTo: string, amount: number | null | undefined) {
      return { name: "Daily cap hire", role: "engineer", reportsTo,
        adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "high" },
        runtimeConfig: { heartbeat: { enabled: false, ...(amount === undefined ? {} : { maxDailyCostCents: amount }) } } };
    }
    it(`daily cap create: agent ${route} (approval ${requiresApproval}) refuses zero without persisting an agent, hire or approval`, async () => {
      const f = await seed();
      await db.update(companies).set({ requireBoardApprovalForNewAgents: requiresApproval }).where(eq(companies.id, f.companyId));
      const before = await db.select().from(agents).where(eq(agents.companyId, f.companyId)).orderBy(agents.id);
      const response = await f.call("post", `/companies/${f.companyId}/${route}`, hireBody(f.ids.primary, 0));
      expect(response.status, response.text).toBe(422);
      expect(response.body.error).toBe("maxDailyCostCents 0 stops the agent; omit the field (or send null) to remove the daily cap");
      expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId)).orderBy(agents.id)).toEqual(before);
      expect(await db.select().from(approvals).where(eq(approvals.companyId, f.companyId))).toEqual([]);
    });
    for (const amount of [250, null, undefined]) {
      it(`daily cap create: agent ${route} (approval ${requiresApproval}) accepts ${amount === undefined ? "an absent field" : amount}`, async () => {
        const f = await seed();
        await db.update(companies).set({ requireBoardApprovalForNewAgents: requiresApproval }).where(eq(companies.id, f.companyId));
        const response = await f.call("post", `/companies/${f.companyId}/${route}`, hireBody(f.ids.primary, amount));
        expect(response.status, response.text).toBe(201);
        const saved = await f.readAgent(response.body.agent?.id ?? response.body.id);
        expect(saved.runtimeConfig.heartbeat).toEqual({ ...hireBody(f.ids.primary, amount).runtimeConfig.heartbeat, maxConcurrentRuns: 20 });
        expect(parseHeartbeatPolicy(saved).maxDailyCostCents).toBe(amount ?? null);
        expect(saved.status).toBe(requiresApproval ? "pending_approval" : "paused");
        expect(await db.select().from(approvals).where(eq(approvals.companyId, f.companyId))).toHaveLength(requiresApproval ? 1 : 0);
      });
    }
    it(`daily cap create: board ${route} (approval ${requiresApproval}) retains explicit zero`, async () => {
      const f = await seed();
      await db.update(companies).set({ requireBoardApprovalForNewAgents: requiresApproval }).where(eq(companies.id, f.companyId));
      const key = await boardAuthService(db).createNamedBoardApiKey({ userId: f.userId, name: "Daily cap hire fixture" });
      const response = await request(f.api).post(`/api/companies/${f.companyId}/${route}`)
        .set("Authorization", `Bearer ${key.token}`).send(hireBody(f.ids.primary, 0));
      expect(response.status, response.text).toBe(201);
      const saved = await f.readAgent(response.body.agent?.id ?? response.body.id);
      expect(saved.runtimeConfig.heartbeat).toMatchObject({ enabled: false, maxDailyCostCents: 0 });
      expect(parseHeartbeatPolicy(saved).maxDailyCostCents).toBe(0);
      expect(saved.status).toBe(requiresApproval ? "pending_approval" : "paused");
      expect(await db.select().from(approvals).where(eq(approvals.companyId, f.companyId))).toHaveLength(requiresApproval ? 1 : 0);
    });
  }
  it("l: retirement is pause then terminate; DELETE never opens for reports", async () => {
    const f = await seed();
    expect((await f.call("delete", `/agents/${f.ids.lead}`)).status).toBe(403);
    expect((await f.call("post", `/agents/${f.ids.worker}/pause`)).status).toBe(200);
    expect((await f.readAgent(f.ids.worker)).status).toBe("paused");
    // As in agent-lifecycle-subtree-scope, complete external host/plugin work
    // explicitly; an accepted resume request is not a finished transition.
    const lifecycle = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async () => "complete" as const, runPlugin: async () => "complete" as const });
    try {
      expect((await f.call("post", `/agents/${f.ids.worker}/resume`)).status).toBe(200);
      await lifecycle.process(f.ids.worker);
      expect((await f.readAgent(f.ids.worker)).lifecycleState).toBe("ready");
      for (const id of [f.ids.worker, f.ids.lead]) {
        expect((await f.call("post", `/agents/${id}/pause`)).status).toBe(200);
        await lifecycle.process(id);
        expect((await f.call("post", `/agents/${id}/terminate`)).status).toBe(200);
        await lifecycle.process(id);
        expect((await f.readAgent(id)).lifecycleState).toBe("terminated");
        expect((await f.call("delete", `/agents/${id}`)).status).toBe(403);
      }
    } finally { await lifecycle.stop(); }
  });
});
