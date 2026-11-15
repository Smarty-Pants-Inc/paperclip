import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentApiKeys, agentConfigRevisions, authUsers, companies, companyMemberships,
  connectionGrants, createDb, heartbeatRuns, principalPermissionGrants, toolConnections, toolConnectionInstalls,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { aiConnectionService } from "../services/ai-connections.js";
import type { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { prepareHeartbeatExecutionConfiguration } from "../services/heartbeat/execution-configuration.js";
import { companySkillService } from "../services/company-skills.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import * as configuration from "../services/agent-configuration.js";
import * as connectionManagement from "../services/connection-management.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// #20724: trust boundary/data safety. Real bearer middleware, authorization,
// PATCH/GET and PostgreSQL; only the race scheduling seam is intercepted.
// All account material below is synthetic; no provider or live company is used.
describe("manager assigns a company AI connection to its own report", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const oldModel = "paperclip/claude-opus-5-5";
  const model = "paperclip/gpt-6.1-sol";
  const denyScope = "Permission agents:configure does not cover the requested scope.";
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "report-ai-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(home, "fixture-master.key"));
    database = await startEmbeddedPostgresTestDatabase("report-ai-");
    db = createDb(database.connectionString);
    closeProcessRunAdmission();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    resetProcessRunAdmissionForTests();
    vi.unstubAllEnvs();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID(), userId = randomUUID(), otherUserId = randomUUID();
    const ids = { root: randomUUID(), lead: randomUUID(), report: randomUUID(), outside: randomUUID(), local: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Report AI boundary", issuePrefix: `A${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values([userId, otherUserId].map(id => ({ id, name: "Fixture member", email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    for (const name of ["root", "outside", "lead", "report", "local"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId, name, role: "engineer", status: "idle", lifecycleState: "ready",
        adapterType: name === "local" ? "pi_local" : "paperclip_runner",
        adapterConfig: name === "local" ? {} : { provider: "pi_rpc", model: oldModel, piRpcThinkingLevel: "high", githubAuthenticationMode: "agent_env" },
        reportsTo: name === "report" || name === "local" ? ids.lead : name === "lead" ? ids.root : null,
        runtimeConfig: { heartbeat: { enabled: false } } });
    }
    await db.insert(companyMemberships).values([
      ...[userId, otherUserId].map(principalId => ({ companyId, principalType: "user" as const, principalId, membershipRole: "owner", status: "active" as const })),
      ...Object.values(ids).map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(principalPermissionGrants).values([
      ...["agents:configure", "agents:read", "tools:manage_profiles"].map(permissionKey => ({ companyId, principalType: "user" as const, principalId: userId, permissionKey })),
      { companyId, principalType: "agent", principalId: ids.lead, permissionKey: "agents:configure", scope: { subtreeRootAgentId: ids.lead } },
      ...["agents:read", "tools:manage_profiles", "agents:configure-reports-runtime"].map(permissionKey => ({ companyId, principalType: "agent" as const, principalId: ids.lead, permissionKey })),
    ]);
    const token = randomUUID();
    const [key] = await db.insert(agentApiKeys).values({ companyId, agentId: ids.lead, name: "lead fixture", responsibleUserId: userId,
      keyHash: createHash("sha256").update(token).digest("hex") }).returning();
    // Schedule committed authority changes after HTTP admission, immediately
    // before the lifecycle writer opens its company-locked transaction.
    let beforeWrite: (() => Promise<void>) | undefined;
    let onWriterExecute: (() => void) | undefined;
    const routeDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return async (...args: Parameters<typeof target.transaction>) => {
        const change = beforeWrite; beforeWrite = undefined;
        await change?.();
        return target.transaction(tx => args[0](new Proxy(tx, { get(transaction, property, proxyReceiver) {
          if (property !== "execute") return Reflect.get(transaction, property, proxyReceiver);
          return (...query: Parameters<typeof transaction.execute>) => {
            onWriterExecute?.();
            return transaction.execute(...query);
          };
        } })), args[1]);
      };
    } });
    const api = express(); api.use(express.json()); api.use(actorMiddleware(routeDb, { deploymentMode: "authenticated" }));
    api.use("/api", agentRoutes(routeDb)); api.use(errorHandler);
    const call = (method: "patch" | "get", id: string, body: object = {}) =>
      request(api)[method](`/api/agents/${id}`).set("Authorization", `Bearer ${token}`).send(body);
    const read = async (id = ids.report) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
    const account = async (ownership: "shared" | "personal" = "shared", owner = userId, allAgents = true) => {
      const saved = await aiConnectionService(db).save(companyId, owner, {
        provider: "openai", method: "api_key", ownership, name: "Company GPT fixture", allAgents, agentIds: allAgents ? [] : [ids.report],
        routing: { kind: "gateway", protocol: "responses", auth: "bearer", baseUrl: "https://gateway.example.invalid/v1", models: [{ id: model }, { id: oldModel }] },
      }, "synthetic-report-ai-key");
      return { provider: "openai", method: "api_key", mode: ownership === "shared" ? "shared" : "delegated", ...saved } as AiConnectionBinding & { connectionId: string; grantId: string };
    };
    const binding = await account();
    const prior = await aiConnectionService(db).save(companyId, userId, {
      provider: "anthropic", method: "api_key", ownership: "shared", name: "Inherited Anthropic fixture", allAgents: true, agentIds: [],
      routing: { kind: "gateway", protocol: "messages", auth: "bearer", baseUrl: "https://gateway.example.invalid/v1", models: [{ id: oldModel }, { id: model }] },
    }, "synthetic-old-ai-key");
    const oldBinding = { provider: "anthropic", method: "api_key", mode: "shared", ...prior } as const;
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false }, aiConnection: oldBinding } }).where(eq(agents.id, ids.report));
    const patch = (target = ids.report, selected: object = binding) => call("patch", target, { runtimeConfig: { heartbeat: { enabled: false }, aiConnection: selected } });
    const revoke = (permissionKey: string) => db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId),
      eq(principalPermissionGrants.principalId, ids.lead), eq(principalPermissionGrants.permissionKey, permissionKey)));
    return { companyId, userId, otherUserId, ids, key: key!, call, read, account, binding, oldBinding, patch, revoke,
      beforeWrite: (change: () => Promise<void>) => { beforeWrite = change; },
      onWriterExecute: (observe: () => void) => { onWriterExecute = observe; } };
  }

  function observeBindingAuthorization() {
    const original = connectionManagement.connectionManagementService;
    const operations: string[] = [];
    const spy = vi.spyOn(connectionManagement, "connectionManagementService").mockImplementation(database => {
      const service = original(database);
      return { ...service, authorize: async (...args: Parameters<typeof service.authorize>) => {
        operations.push(args[2].operation);
        return service.authorize(...args);
      } };
    });
    return { operations, restore: () => spy.mockRestore() };
  }

  async function proveSavedAndNextRuntime(f: Awaited<ReturnType<typeof seed>>, response: request.Response,
    beforeNextRun?: () => Promise<void>) {
    // Keep the exact pre-fix failure visible in RED, then require the fixed outcome.
    if (response.status === 403) {
      expect(response.body.error).toBe(denyScope);
      expect((await f.read()).runtimeConfig.aiConnection).toEqual(f.oldBinding);
      expect((await f.call("get", f.ids.report)).body.runtimeConfig.aiConnection).toEqual(f.oldBinding);
    }
    expect(response.status, response.text).toBe(200);
    expect(response.body.runtimeConfig.aiConnection).toEqual(f.binding);
    const fresh = await f.call("get", f.ids.report);
    expect(fresh.status, fresh.text).toBe(200);
    expect(fresh.body.runtimeConfig.aiConnection).toEqual(f.binding);
    expect((await f.read()).runtimeConfig.aiConnection).toEqual(f.binding);
    await beforeNextRun?.();
    const saved = await f.read(); // A new execution reads the report afresh.
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: saved.id,
      responsibleUserId: f.userId, status: "running", runtimeMode: "native", contextSnapshot: {} }).returning();
    let acquired: Awaited<ReturnType<typeof prepareManagedAiRuntime>> | undefined;
    const appendRunEvent = vi.fn(async () => {});
    const busy = vi.fn();
    try {
      const preparation = prepareHeartbeatExecutionConfiguration(db, {
        run, agent: saved,
        task: { issueId: null, context: {}, responsibleUserId: f.userId, acceptedPlanContinuationWake: false,
          acceptedPlanWakeRoutingDecision: null, taskProjectContext: null, routineEnvContext: { routineId: null, env: null, responsibleUserId: null } },
        config: { sourceWorkspaceConfig: saved.adapterConfig, aiBinding: saved.runtimeConfig.aiConnection as AiConnectionBinding },
        policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
          useIsolatedTaskDirectory: false, explicitTaskDirectory: false, requestedExecutionWorkspaceMode: "shared_workspace" },
        environment: { selectedEnvironmentId: null, selectedEnvironmentForConfig: null,
          resolvedInstanceSettings: await instanceSettingsService(db).get(), persistedNativeExecutionInput: null },
        services: { secretsSvc: secretService(db), companySkills: companySkillService(db), appendRunEvent, finalizeAiConnectionBusyDeferral: busy },
        onFailureSecretsResolved: () => {}, onManagedAiRuntimeAcquired: runtime => { acquired = runtime; }, onIdentityRedactorPrepared: () => {},
      });
      if (beforeNextRun) {
        await expect(preparation).rejects.toMatchObject({ name: "ConfigurationIncompleteFailure", code: "configuration_incomplete",
          resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable", agentId: saved.id } } });
        expect(acquired).toBeUndefined();
        expect(busy).not.toHaveBeenCalled(); // Unavailable is not a busy deferral.
        const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        expect(failedRun!.contextSnapshot?.aiConnection).toBeUndefined();
        expect((await f.read()).runtimeConfig.aiConnection).toEqual(f.binding); // No saved-binding fallback either.
        return;
      }
      const prepared = await preparation;
      expect(prepared.prepared).toBe(true); expect(busy).not.toHaveBeenCalled();
      if (!prepared.prepared) throw new Error("Fresh run unexpectedly deferred");
      expect(prepared.runtimeConfig).toMatchObject({ model, provider: "pi_rpc" });
      expect(prepared.useHostGitHub).toBe(false); // No ambient credentials enter this local proof.
      expect(acquired?.attribution).toMatchObject({ connectionId: f.binding.connectionId, grantId: f.binding.grantId, provider: "openai", responsibleUserId: f.userId });
      const [freshRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(freshRun!.contextSnapshot?.aiConnection).toMatchObject({ connectionId: f.binding.connectionId,
        grantId: f.binding.grantId, provider: "openai", responsibleUserId: f.userId });
    } finally {
      await acquired?.cleanup();
      // Preparation only: no Runner/provider request is launched in this fixture.
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
    }
    // Assignment changes no connection/grant/install ownership or access.
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.binding.connectionId)))
      .toEqual([expect.objectContaining({ targetType: "company", targetId: f.companyId })]);
  }

  it("R1: #20724 runtimeConfig binding PATCH persists and the next execution preparation records the chosen AI account", async () => {
    const f = await seed();
    expect((await f.call("patch", f.ids.report, { adapterConfig: { model } })).status).toBe(200);
    const observed = observeBindingAuthorization();
    try {
      await proveSavedAndNextRuntime(f, await f.patch());
      expect(observed.operations).toEqual(["agent.ai-binding.update", "agent.ai-binding.assign-shared-report", "agent.ai-binding.assign-shared-report"]);
    } finally { observed.restore(); }
    expect((await f.read()).adapterConfig.model).toBe(model);
  });
  it("run re-check RED: archiving the assigned account makes the report's next run fail closed without fallback", async () => {
    const f = await seed();
    // Both a second OpenAI account and the old Anthropic binding remain usable.
    // A failure must not silently select either of those healthy alternatives.
    const alternative = await f.account();
    for (const binding of [alternative, f.oldBinding]) {
      await expect(aiConnectionService(db).select({ companyId: f.companyId, userId: f.userId, agentId: f.ids.report,
        adapterType: "paperclip_runner", runnerProvider: "pi_rpc", model: oldModel, binding })).resolves.toBeTruthy();
    }
    await proveSavedAndNextRuntime(f, await f.patch(), async () => {
      await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, f.binding.connectionId));
    });
  });
  it("run re-check: an account that is no longer company-shared also fails the next run closed", async () => {
    const f = await seed();
    await proveSavedAndNextRuntime(f, await f.patch(), async () => {
      await db.update(connectionGrants).set({ kind: "user", subjectUserId: f.userId, isDefault: false }).where(eq(connectionGrants.id, f.binding.grantId));
    });
  });
  it("run re-check: a report moved out of the account's company cannot use the old binding", async () => {
    const f = await seed(); const other = await seed();
    await proveSavedAndNextRuntime(f, await f.patch(), async () => {
      await db.update(agents).set({ companyId: other.companyId, reportsTo: null }).where(eq(agents.id, f.ids.report));
    });
  });
  it("R1b: runtimeSettings converges on the same assignment with expected model/binding", async () => {
    const f = await seed();
    const response = await f.call("patch", f.ids.report, { runtimeSettings: { harness: "pi_rpc", model, aiConnection: f.binding,
      expected: { model: oldModel, aiConnection: f.oldBinding } } });
    await proveSavedAndNextRuntime(f, response);
    expect((await f.read()).adapterConfig.model).toBe(model);
  });
  it("R1c: model-only PATCH keeps the inherited binding and does not administer its consumers", async () => {
    const f = await seed();
    const response = await f.call("patch", f.ids.report, { adapterConfig: { model } });
    expect(response.status, response.text).toBe(200);
    expect((await f.read()).adapterConfig.model).toBe(model);
    expect((await f.read()).runtimeConfig.aiConnection).toEqual(f.oldBinding);
  });
  it("R1c scope refusal: model-only PATCH without target configure authority returns the exact reported 403", async () => {
    const f = await seed(); const before = await f.read();
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [f.ids.lead] } }).where(and(
      eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    const response = await f.call("patch", f.ids.report, { adapterConfig: { model } });
    expect(response.status, response.text).toBe(403); expect(response.body.error).toBe(denyScope);
    expect(await f.read()).toEqual(before);
  });
  it("FIX 8: legacy unscoped Claude manager assigns a non-routed OpenAI account to its Codex report", async () => {
    const f = await seed();
    await db.update(principalPermissionGrants).set({ scope: null }).where(and(
      eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    await db.update(agents).set({ adapterConfig: { provider: "claude", model: "claude-sonnet-4-5", githubAuthenticationMode: "agent_env" } })
      .where(eq(agents.id, f.ids.lead));
    await db.update(agents).set({ adapterConfig: { provider: "codex", model: "gpt-5.1-codex", githubAuthenticationMode: "agent_env" } })
      .where(eq(agents.id, f.ids.report));
    const saved = await aiConnectionService(db).save(f.companyId, f.userId, {
      provider: "openai", method: "api_key", ownership: "shared", name: "Non-routed legacy OpenAI", allAgents: true, agentIds: [],
    }, "synthetic-legacy-openai-key");
    const selected = { provider: "openai", method: "api_key", mode: "shared", ...saved } as const;
    // The report can use it, but the manager's Claude harness cannot. BASE
    // authorized this all-consumer assignment without resolving as the manager.
    await expect(aiConnectionService(db).select({ companyId: f.companyId, userId: f.userId, agentId: f.ids.lead,
      adapterType: "paperclip_runner", runnerProvider: "claude", model: "claude-sonnet-4-5", binding: selected })).rejects.toThrow();
    const observed = observeBindingAuthorization();
    try {
      const response = await f.patch(f.ids.report, selected);
      expect(response.status, response.text).toBe(200);
      expect((await f.read()).runtimeConfig.aiConnection).toEqual(selected);
      expect((await f.call("get", f.ids.report)).body.runtimeConfig.aiConnection).toEqual(selected);
      expect(observed.operations).toEqual(["agent.ai-binding.update"]);
    } finally { observed.restore(); }
  });
  for (const target of ["outside", "root", "lead"] as const) {
    it(`R2: ${target} is refused for the scoped lead`, async () => {
      const f = await seed(); const before = await f.read(f.ids[target]);
      const response = await f.patch(f.ids[target]);
      expect(response.status, response.text).toBe(403); expect(response.body.error).toBeTruthy();
      expect(await f.read(f.ids[target])).toEqual(before);
    });
    it(`legacy unscoped authority on ${target} never gets the new report-only operation`, async () => {
      const f = await seed();
      await db.update(principalPermissionGrants).set({ scope: null }).where(and(
        eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
      const observed = observeBindingAuthorization();
      try {
        const response = await f.patch(f.ids[target]);
        expect(response.status, response.text).toBe(200); // Existing legacy authority, not new report authority.
        expect(observed.operations).toEqual(["agent.ai-binding.update"]);
      } finally { observed.restore(); }
    });
  }
  for (const otherOwner of [false, true]) for (const mode of ["shared", "delegated"] as const) {
    it(`R3: personal grant never gains report admission (other owner: ${otherOwner}, mode: ${mode})`, async () => {
      const f = await seed(); const before = await f.read();
      const personal = await f.account("personal", otherOwner ? f.otherUserId : f.userId);
      const response = await f.patch(f.ids.report, { ...personal, mode });
      expect(response.status, response.text).toBe(403); expect(response.body.error).toBeTruthy();
      expect(await f.read()).toEqual(before);
    });
  }
  it("R4: the manager cannot assign a company credential outside its responsible user's audience", async () => {
    const f = await seed(); const before = await f.read();
    await toolAccessService(db).replaceConnectionGrantMembers(f.binding.connectionId, f.binding.grantId, [f.otherUserId], { actorType: "user", actorId: f.userId });
    await expect(aiConnectionService(db).select({ companyId: f.companyId, userId: f.userId, agentId: f.ids.lead,
      adapterType: "paperclip_runner", runnerProvider: "pi_rpc", model: oldModel, binding: f.binding })).rejects.toMatchObject({ status: 403 });
    const response = await f.patch();
    expect(response.status, response.text).toBe(403); expect(response.body.error).toBe("This credential is not shared with the responsible user");
    expect(await f.read()).toEqual(before);
  });
  it("R5: router bindings retain the existing all-consumer refusal", async () => {
    const f = await seed(); const before = await f.read();
    const response = await f.patch(f.ids.report, { mode: "router", connectionId: f.binding.connectionId });
    expect(response.status, response.text).toBe(403); expect(response.body.error).toBe(denyScope); expect(await f.read()).toEqual(before);
  });
  for (const permission of ["agents:configure-reports-runtime", "agents:configure", "tools:manage_profiles"]) {
    it(`missing ${permission} cannot take recipient-only admission`, async () => {
      const f = await seed(); const before = await f.read(); await f.revoke(permission);
      const response = await f.patch();
      expect(response.status, response.text).toBe(403); expect(response.body.error).toBeTruthy(); expect(await f.read()).toEqual(before);
    });
  }
  it("an agent-target install alone retains the existing operation, not company-report admission", async () => {
    const f = await seed(); const selected = await f.account("shared", f.userId, false);
    const observed = observeBindingAuthorization();
    try {
      const response = await f.patch(f.ids.report, selected);
      expect(response.status, response.text).toBe(200); // Already allowed when all consumers are in scope.
      expect(observed.operations).toEqual(["agent.ai-binding.update"]);
    } finally { observed.restore(); }
  });
  it("FIX 4: audience replacement overlapping the writer is serialized before selection", async () => {
    const f = await seed(); const before = await f.read();
    const audienceLocked = Promise.withResolvers<void>();
    const releaseAudience = Promise.withResolvers<void>();
    const writerLockAttempted = Promise.withResolvers<void>();
    // Hold the real audience-replacement transaction before its mutation. HTTP
    // admission can still read the old audience; the writer must wait and re-read.
    const audienceDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return (work: Parameters<typeof target.transaction>[0]) => target.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"paperclip.connection_grant_audience:" + f.binding.grantId}, 0))`);
        audienceLocked.resolve();
        await releaseAudience.promise;
        return work(tx);
      });
    } });
    const replacing = toolAccessService(audienceDb).replaceConnectionGrantMembers(f.binding.connectionId, f.binding.grantId,
      [f.otherUserId], { actorType: "user", actorId: f.userId });
    await audienceLocked.promise;
    f.onWriterExecute(() => writerLockAttempted.resolve());
    let pending: Promise<request.Response> | undefined;
    try {
      pending = f.patch().then(response => response);
      // Pre-fix the response wins (200 after stale selection). With the fix,
      // the writer reaches the audience mutex and waits for replacement commit.
      await Promise.race([pending, writerLockAttempted.promise]);
      releaseAudience.resolve();
      await replacing;
      const response = await pending;
      expect(response.status, response.text).toBe(403);
      expect(response.body.error).toBe("This credential is not shared with the responsible user");
      expect(await f.read()).toEqual(before);
      expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, f.ids.report))).toEqual([]);
    } finally {
      releaseAudience.resolve();
      await Promise.allSettled([replacing, ...(pending ? [pending] : [])]);
    }
  });
  for (const race of ["reparent", "runtime-grant", "configure-grant", "account-grant", "audience", "install", "key", "archive"] as const) {
    it(`R6: ${race} changes after route admission are refused by the locked writer`, async () => {
      const f = await seed(); const before = await f.read(); let reachedWriter = false, changedAuthority = false;
      f.beforeWrite(async () => {
        if (race === "reparent") await db.update(agents).set({ reportsTo: f.ids.outside }).where(eq(agents.id, f.ids.report));
        if (race === "runtime-grant" || race === "configure-grant") await f.revoke(race === "runtime-grant" ? "agents:configure-reports-runtime" : "agents:configure");
        if (race === "account-grant") await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.binding.grantId));
        if (race === "audience") await toolAccessService(db).replaceConnectionGrantMembers(f.binding.connectionId, f.binding.grantId, [f.otherUserId], { actorType: "user", actorId: f.userId });
        if (race === "install") await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.binding.connectionId));
        if (race === "key") await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.id, f.key.id));
        if (race === "archive") await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.id, f.binding.connectionId));
        changedAuthority = true;
      });
      const original = configuration.prepareAgentConfiguration;
      const seam = vi.spyOn(configuration, "prepareAgentConfiguration").mockImplementationOnce(async (...args) => {
        reachedWriter = true;
        return original(...args);
      });
      try {
        const response = await f.patch();
        expect(changedAuthority, response.text).toBe(true); expect(reachedWriter, response.text).toBe(true);
        expect([403, 422], response.text).toContain(response.status);
        expect(response.body.error).toBeTruthy();
        const saved = await f.read();
        expect(saved.runtimeConfig).toEqual(before.runtimeConfig); expect(saved.adapterConfig).toEqual(before.adapterConfig);
        expect(saved.reportsTo).toBe(race === "reparent" ? f.ids.outside : before.reportsTo);
        expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, f.ids.report))).toEqual([]);
      } finally { seam.mockRestore(); }
    });
  }
});
