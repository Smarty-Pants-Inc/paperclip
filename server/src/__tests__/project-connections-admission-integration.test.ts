import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { materializeNativeProviderCapacityRetry } from "../services/native-runtime/native-provider-capacity-retry.js";
import * as gitCredentials from "../services/git-credentials.js";
import { prepareHeartbeatExecutionConfiguration, type HeartbeatExecutionConfigurationInput } from "../services/heartbeat/execution-configuration.js";
import { heartbeatService } from "../services/heartbeat.js";
import { readProjectConnectionRunContext } from "../services/project-connection-run-context.js";
import { lockProjectConnectionLifecycle } from "../services/project-connection-retirement.js";
import { projectConnectionFixture } from "./helpers/project-connections-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Production enqueue, real PostgreSQL task/project locks, no fixture.run/capture
// and no mocked admission/credential/retirement implementation. The established
// handover seam deliberately leaves runs queued rather than starting a worker.
describe("integration J17/J18 production run admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-project-queue-integration-");
    db = createDb(database.connectionString, { maxConnections: 8 });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);
  const service = () => heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: () => null } });

  it("J17/J18: the real task enqueue commits a server-derived pair before any credential read", async () => {
    const f = await projectConnectionFixture(db);
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Real queue binding", status: "in_progress",
      assigneeAgentId: f.leadA.id, responsibleUserId: f.human, projectId: f.a.id }).returning();
    const run = await service().wakeup(f.leadA.id, { source: "on_demand", triggerDetail: "manual", manualUserWake: true,
      requestedByActorType: "user", requestedByActorId: f.human,
      contextSnapshot: { issueId: issue!.id, taskId: issue!.id, projectId: f.b.id,
        projectConnectionRunContext: { version: 1, issueId: issue!.id, projectId: f.b.id } } });
    expect(run).not.toBeNull();
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(stored!.status).toBe("queued");
    expect(stored!.contextSnapshot?.projectConnectionRunContext).toEqual({ version: 1, issueId: issue!.id, projectId: f.a.id });
    expect(await readProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: run!.id }))
      .toMatchObject({ issueId: issue!.id, projectId: f.a.id });
    await db.update(issues).set({ projectId: f.b.id }).where(eq(issues.id, issue!.id));
    await expect(readProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: run!.id }))
      .rejects.toMatchObject({ details: { code: "project_connection_run_context_invalid" } });
  });

  it("J17: production taskless admission waits for D's real installed-project lifecycle lock", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection();
    let release!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>(done => { acquired = done; });
    const proceed = new Promise<void>(done => { release = done; });
    const holder = db.transaction(async tx => {
      await lockProjectConnectionLifecycle(tx, { companyId: f.companyId, projectId: f.a.id });
      acquired(); await proceed;
    });
    await locked;
    const pending = service().wakeup(f.leadA.id, { source: "on_demand", triggerDetail: "manual", manualUserWake: true,
      requestedByActorType: "user", requestedByActorId: f.human, contextSnapshot: { projectId: f.b.id } });
    let finished = false;
    const observed = pending.then(value => { finished = true; return value; });
    let waited = false;
    try {
      const deadline = Date.now() + 5_000;
      while (!finished && Date.now() < deadline) {
        const locks = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query like '%projects%' and pid <> pg_backend_pid()`);
        if (locks.length) { waited = true; break; }
        await new Promise(done => setTimeout(done, 10));
      }
    } finally { release(); await holder; }
    const run = await observed;
    expect(waited, "real taskless enqueue must reach the lifecycle wait").toBe(true);
    expect(run).not.toBeNull();
    const [stored] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run!.id), eq(heartbeatRuns.companyId, f.companyId)));
    expect(stored!.contextSnapshot?.projectConnectionRunContext).toEqual({ version: 1, issueId: null, projectId: null });
  });

  it("J14/A07: a real admitted legacy-only run still bypasses managed selection in explicit agent_env mode", async () => {
    const f = await projectConnectionFixture(db);
    const run = await service().wakeup(f.leadA.id, { source: "on_demand", triggerDetail: "manual", manualUserWake: true,
      requestedByActorType: "user", requestedByActorId: f.human });
    expect(run?.contextSnapshot?.projectConnectionRunContext).toEqual({ version: 1, issueId: null, projectId: null });
    const selection = vi.spyOn(gitCredentials, "resolveManagedGitHubIdentitySelection");
    const reachedSecrets = new Error("reached-explicit-agent-secret-boundary");
    try {
      const input = {
        run, agent: { ...f.leadA, adapterConfig: { githubAuthenticationMode: "agent_env" } },
        task: { issueId: null, context: {}, responsibleUserId: f.human, acceptedPlanContinuationWake: false,
          acceptedPlanWakeRoutingDecision: null, taskProjectContext: null, routineEnvContext: { routineId: null, env: null } },
        config: { sourceWorkspaceConfig: { env: {} }, aiBinding: undefined },
        policy: { trustPreset: { kind: "standard" } }, environment: { selectedEnvironmentForConfig: { driver: "boat" } },
        services: { secretsSvc: { resolveAdapterConfigForRuntime: async () => { throw reachedSecrets; } }, companySkills: {},
          appendRunEvent: async () => undefined, finalizeAiConnectionBusyDeferral: async () => undefined },
        onFailureSecretsResolved: () => undefined, onManagedAiRuntimeAcquired: () => undefined, onIdentityRedactorPrepared: () => undefined,
      } as unknown as HeartbeatExecutionConfigurationInput;
      await expect(prepareHeartbeatExecutionConfiguration(db, input)).rejects.toBe(reachedSecrets);
      expect(selection).not.toHaveBeenCalled();
    } finally { selection.mockRestore(); }
  });

  it("C-2/J17/J18: actual native-capacity successor admits its task project before scheduled-retry commit", async () => {
    const f = await projectConnectionFixture(db);
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Capacity successor",
      assigneeAgentId: f.leadA.id, responsibleUserId: f.human, projectId: f.a.id }).returning();
    const [predecessor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id,
      nativeIssueId: issue!.id, runtimeMode: "native", status: "failed", responsibleUserId: f.human,
      contextSnapshot: { issueId: issue!.id, projectId: f.b.id,
        projectConnectionRunContext: { version: 1, issueId: issue!.id, projectId: f.b.id } } }).returning();
    const retryId = await db.transaction(tx => materializeNativeProviderCapacityRetry({ tx: tx as unknown as typeof db,
      companyId: f.companyId, agentId: f.leadA.id, issueId: issue!.id, runId: predecessor!.id }));
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
    expect(retry!.status).toBe("scheduled_retry");
    expect(retry!.contextSnapshot?.projectConnectionRunContext).toEqual({ version: 1, issueId: issue!.id, projectId: f.a.id });
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, retryId));
    expect(await readProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: retryId }))
      .toMatchObject({ issueId: issue!.id, projectId: f.a.id });
  });
});
