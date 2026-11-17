import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { createAgentSchema, updateAgentSchema, createIssueSchema, updateIssueSchema } from "@paperclipai/shared";
import { and, eq, isNull } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";

// Independent RFL acceptance checks. Keep reason: trust boundary and durable
// admission race, specifically RFL asks A-D. Real local PG and importBundle;
// providers are never launched. The raced terminal transition is explicit below.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("RFL importpause adversarial acceptance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let peer: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("rfl-importpause-");
    db = createDb(database.connectionString);
    peer = createDb(database.connectionString); // independent connection pool
  }, 90_000);
  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await heartbeatService(peer).drainActiveRunExecutions();
    await peer?.$client.end(); await db?.$client.end(); await database?.cleanup();
  });
  const options = { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } };
  const noteRows = (id: string) => db.select().from(issueComments).where(and(eq(issueComments.issueId, id), eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));
  const runRows = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
  async function fixture(count = 1) {
    const companyId = randomUUID();
    const actor = `rfl-${randomUUID()}`;
    await db.insert(authUsers).values({ id: actor, name: "RFL local tester", email: `${actor}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "RFL local import", issuePrefix: companyId.slice(0, 8), requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: actor });
    await db.insert(companyMemberships).values({ companyId, principalId: actor, principalType: "user", status: "active", membershipRole: "owner" });
    const files: Record<string, string> = {
      "COMPANY.md": '---\nname: "RFL local import"\n---\n',
      "agents/worker/AGENTS.md": '---\nname: "RFL worker"\nslug: worker\nrole: engineer\n---\n\nDo the task.\n',
    };
    let manifest = 'schemaVersion: 7\ntasks:\n';
    for (let i = 0; i < count; i++) {
      files[`tasks/task${i}/TASK.md`] = `---\nname: "RFL carried ${i}"\nkind: task\nassignee: worker\n---\n\nPreserve this task.\n`;
      manifest += `  task${i}:\n    status: in_progress\n    startedAt: "2026-03-19T00:00:00.000Z"\n    comments:\n      -\n        body: "Please continue this saved task ${i}."\n        authorType: user\n`;
    }
    files['.paperclip.yaml'] = manifest;
    const result = await companyPortabilityService(db).importBundle({ source: { type: "inline", rootPath: "rfl", files },
      include: { company: false, agents: true, projects: false, issues: true, skills: false },
      target: { mode: "existing_company", companyId }, agents: "all", collisionStrategy: "rename",
      adapterOverrides: { worker: { adapterType: "process", adapterConfig: { command: "true" } } },
    }, actor, { pauseAutomations: true });
    const agentId = result.agents.find(a => a.slug === "worker")!.id!;
    const tasks = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(tasks).toHaveLength(count);
    await db.update(issueComments).set({ createdAt: new Date(Date.now() - 10 * 60_000) }).where(and(eq(issueComments.companyId, companyId), eq(issueComments.authorType, "user")));
    return { companyId, agentId, tasks };
  }
  async function ready(f: Awaited<ReturnType<typeof fixture>>) {
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      await worker.process(f.agentId);
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await worker.process(f.agentId);
    } finally { await worker.stop(); }
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "idle", lifecycleHolds: [], pauseReason: null });
  }

  it("public create/update schemas discard forged pause/origin fields", () => {
    const forged = { pauseReason: "import", lifecycleHolds: ["import"], lifecycleState: "paused" };
    expect(createAgentSchema.parse({ name: "Forged", adapterType: "process", ...forged })).not.toHaveProperty("pauseReason");
    const agentPatch = updateAgentSchema.parse({ status: "paused", ...forged });
    expect(agentPatch).not.toHaveProperty("pauseReason");
    expect(agentPatch).not.toHaveProperty("lifecycleHolds");
    expect(agentPatch).not.toHaveProperty("lifecycleState");
    expect(createIssueSchema.parse({ title: "Forged", originKind: "company_import" })).not.toHaveProperty("originKind");
    expect(updateIssueSchema.parse({ title: "Forged", originKind: "company_import" })).not.toHaveProperty("originKind");
  });


  it("two independent DB clients and repeated resume admit only one queued run", async () => {
    const f = await fixture(); await ready(f);
    await Promise.all([createAgentLifecycle(db).resumeAgent(f.agentId), createAgentLifecycle(peer).resumeAgent(f.agentId)]);
    const scope = { companyId: f.companyId, issueId: f.tasks[0]!.id };
    await Promise.all([heartbeatService(db, options).reconcileStrandedAssignedIssues(scope), heartbeatService(peer, options).reconcileStrandedAssignedIssues(scope)]);
    await heartbeatService(peer, options).reconcileStrandedAssignedIssues(scope);
    expect(await runRows(f.companyId)).toHaveLength(1);
    console.log(JSON.stringify({ check: "two-clients-queued", runs: (await runRows(f.companyId)).map(r => ({ id: r.id, status: r.status })) }));
  });

  it("stale no-run snapshot cannot re-admit initial import after a peer's first run becomes terminal", async () => {
    const f = await fixture(); await ready(f);
    const scope = { companyId: f.companyId, issueId: f.tasks[0]!.id };
    const peerHeartbeat = heartbeatService(peer, options);
    const localHeartbeat = heartbeatService(db, options);
    let crossed = false;
    const recovery = recoveryService(db, {
      enqueueWakeup: (agentId, opts) => localHeartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async ({ runId }) => {
        expect(runId).toBeNull(); expect(crossed).toBe(false); crossed = true;
        // A second connection commits the normal admission while this sweep
        // retains the older no-run snapshot. Model its fast terminal finish
        // without executing an external provider, preserving all durable rows.
        await peerHeartbeat.reconcileStrandedAssignedIssues(scope);
        const [first] = await runRows(f.companyId); expect(first).toBeDefined();
        await peer.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_cancelled", finishedAt: new Date(), updatedAt: new Date() }).where(eq(heartbeatRuns.id, first!.id));
        await peer.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() }).where(eq(agentWakeupRequests.id, first!.wakeupRequestId!));
      },
    });
    await recovery.reconcileStrandedAssignedIssues(scope);
    const runs = await runRows(f.companyId);
    console.log(JSON.stringify({ check: "stale-initial-import-admission", runs: runs.map(r => ({ id: r.id, status: r.status, reason: r.contextSnapshot?.wakeReason, source: r.contextSnapshot?.source })) }));
    expect(runs).toHaveLength(1);
  });

  it("five qualifying imported tasks produce exactly five ordinary durable assignment admissions", async () => {
    const f = await fixture(5); await ready(f);
    await heartbeatService(db, options).reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const runs = await runRows(f.companyId);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    console.log(JSON.stringify({ check: "burst-five", runCount: runs.length, wakeCount: wakes.length, sources: wakes.map(w => w.source) }));
    expect(runs).toHaveLength(5); expect(wakes).toHaveLength(5);
    expect(new Set(runs.map(r => r.contextSnapshot?.issueId)).size).toBe(5);
    for (const run of runs) expect(run).toMatchObject({ status: "queued", invocationSource: "assignment", contextSnapshot: { wakeReason: "issue_assigned" } });
    for (const wake of wakes) expect(wake).toMatchObject({ status: "queued", source: "assignment", reason: "issue_assigned" });
  });
});
