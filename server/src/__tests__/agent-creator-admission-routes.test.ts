import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, approvals, budgetPolicies, builtInManagedResources, companies, companyMemberships,
  companyOnboardingSeeds, companySecretBindings, companySecrets, createDb, goals, invites, issues, joinRequests,
  pluginEntities, pluginManagedResources, plugins, principalPermissionGrants,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { builtInAgentRoutes } from "../routes/built-in-agents.js";
import { onboardingSeedRoutes } from "../routes/onboarding-seed.js";
import { accessRoutes } from "../routes/access.js";
import { getBuiltInAgentDefinition } from "../services/built-in-agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { withPluginInteractionOrigin } from "../services/plugin-interaction-context.js";
import * as runnerSelection from "../services/agent-runner-selection.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const command = "/tmp/importfence9-never-execute";
const refusal = "Agent keys cannot configure host-executed local adapter settings (command).";

describePg("RFL importfence8 FIX 2 agent-reachable creators", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("creator-admission-");
    db = createDb(fixture.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableBuiltInAgents: true });
  }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  async function seed(requireApproval = false, role = "ceo") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Creator admission", issuePrefix: `C${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: requireApproval });
    const [actorAgent] = await db.insert(agents).values({ companyId, name: "Caller", role, adapterType: "codex_local", permissions: { canCreateAgents: true } }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: actorAgent!.id, membershipRole: "member", status: "active" });
    await db.insert(principalPermissionGrants).values(["agents:create", "joins:approve"].map(permissionKey => ({ companyId, principalType: "agent" as const, principalId: actorAgent!.id, permissionKey })));
    const actor: Express.Request["actor"] = { type: "agent", agentId: actorAgent!.id, companyId, source: "agent_key", keyId: randomUUID() };
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", builtInAgentRoutes(db)); app.use("/api", onboardingSeedRoutes(db));
    app.use("/api", accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] }));
    app.use(errorHandler);
    return { companyId, actor, app };
  }
  async function snapshot(companyId: string) {
    const tables = { agents, approvals, budgetPolicies, principalPermissionGrants, activityLog, companyOnboardingSeeds,
      goals, issues, companySecrets, companySecretBindings, builtInManagedResources, pluginEntities, pluginManagedResources, joinRequests };
    const result: Record<string, unknown> = {};
    for (const [name, table] of Object.entries(tables)) {
      // The exact table union retains each table's company boundary at runtime.
      result[name] = await db.select().from(table).where(eq(table.companyId, companyId)).orderBy(table.id);
    }
    return result;
  }
  async function assertRefused(response: request.Response, before: unknown, companyId: string) {
    console.log(JSON.stringify({ row: "FIX2", status: response.status, error: response.body.error, companyId }));
    expect.soft(response.status, JSON.stringify(response.body)).toBe(403);
    expect.soft(response.body.error).toBe(refusal);
    expect.soft(await snapshot(companyId)).toEqual(before);
  }

  it.each([false, true])("RED builtin provision refuses local command, approvals=%s", async required => {
    const { companyId, app } = await seed(required);
    const before = await snapshot(companyId);
    const response = await request(app).post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", runner: "legacy", adapterConfig: { command } });
    await assertRefused(response, before, companyId);
  });
  it("RED builtin reconcile admits its resolved stock config before creating anything", async () => {
    const { companyId, app } = await seed();
    const definition = getBuiltInAgentDefinition("briefs")!;
    const previous = { adapterType: definition.defaultAdapterType, config: definition.defaultAdapterConfig };
    // Reconcile has no adapter body. Inject a stock-default fault at its real
    // registry seam, not a mocked admission or writer. Restore it in finally.
    definition.defaultAdapterType = "codex_local";
    definition.defaultAdapterConfig = { command };
    const selection = vi.spyOn(runnerSelection, "resolveNewAgentRunnerForCompany").mockResolvedValue({ adapterType: "codex_local", adapterConfig: { command } });
    try {
      const before = await snapshot(companyId);
      await assertRefused(await request(app).post(`/api/companies/${companyId}/built-in-agents/briefs/reconcile`).send({}), before, companyId);
    } finally {
      selection.mockRestore(); definition.defaultAdapterType = previous.adapterType; definition.defaultAdapterConfig = previous.config;
    }
  });
  it("RED onboarding seed refuses a resolved local command before its hire/content writes", async () => {
    const { companyId, app } = await seed(false, "engineer");
    // The seed schema accepts names/mission, not adapter config. This controlled
    // normalizer fault tests the resolved-config fence on the real route/DB.
    const selection = vi.spyOn(runnerSelection, "resolveNewAgentRunnerForCompany").mockResolvedValue({ adapterType: "codex_local", adapterConfig: { command } });
    try {
      const before = await snapshot(companyId);
      const response = await request(app).post(`/api/companies/${companyId}/onboarding-seed`).send({ revision: "a".repeat(32), agent: { name: "Seeded", role: "Chief of Staff" }, mission: "Must not stick" });
      await assertRefused(response, before, companyId);
    } finally { selection.mockRestore(); }
  });
  it("RED join approval with joins:approve refuses stored local command without approving or hiring", async () => {
    const { companyId, app } = await seed();
    const [invite] = await db.insert(invites).values({ companyId, tokenHash: randomUUID(), allowedJoinTypes: "agent", expiresAt: new Date(Date.now() + 60_000) }).returning();
    const [join] = await db.insert(joinRequests).values({ companyId, inviteId: invite!.id, requestType: "agent", status: "pending_approval", requestIp: "127.0.0.1", agentName: "Joiner", adapterType: "gemini_local", agentDefaultsPayload: { command } }).returning();
    const before = await snapshot(companyId);
    await assertRefused(await request(app).post(`/api/companies/${companyId}/join-requests/${join!.id}/approve`).send({}), before, companyId);
  });
  it.each(["managedReconcile", "managedReset"] as const)("RED plugin %s preserves agent invocation origin at managed creation", async method => {
    const { companyId, actor } = await seed();
    const pluginId = randomUUID();
    const manifest: PaperclipPluginManifestV1 = { id: `paperclip.creator-admission-${method}`, apiVersion: 1, version: "0.1.0", displayName: "Creator admission", description: "Fixture", author: "Paperclip", categories: ["automation"], capabilities: ["agents.managed"], entrypoints: { worker: "./worker.js" }, agents: [{ agentKey: "worker", displayName: "Plugin worker", role: "engineer", adapterType: "gemini_local", adapterConfig: { command }, budgetMonthlyCents: 0 }] };
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "@paperclipai/creator-admission-fixture", version: manifest.version, apiVersion: 1, categories: manifest.categories, manifestJson: manifest, status: "ready", installOrder: 1 });
    const services = buildHostServices(db, pluginId, manifest.id, { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as never, undefined, { manifest });
    try {
      const before = await snapshot(companyId);
      let error: unknown;
      try { await withPluginInteractionOrigin({ companyId, agentId: actor.agentId! }, () => services.agents[method]({ companyId, agentKey: "worker" })); }
      catch (caught) { error = caught; }
      expect.soft(error).toMatchObject({ status: 403, message: refusal });
      expect.soft(await snapshot(companyId)).toEqual(before);
    } finally { services.dispose(); }
  });
});
