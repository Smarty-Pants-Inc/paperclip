import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";

// Keep reason: recorded M12 dress failure, imported blocked work starts on resume.
// Real portability, PostgreSQL, lifecycle and both existing recovery owners;
// the ordinary handover gate holds all admitted runs without launching a provider.
const support = await getEmbeddedPostgresTestSupport();
const statuses = ["blocked", "in_review", "done", "cancelled", "todo", "in_progress"] as const;
const options = { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } };
describe.skipIf(!support.supported)("import resume preserves source waiting statuses", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("import-resume-status-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client.end();
    await database?.cleanup();
  });

  async function imported() {
    const companyId = randomUUID();
    const actor = `import-status-${randomUUID()}`;
    await db.insert(authUsers).values({ id: actor, name: "Import operator", email: `${actor}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Imported status regression", issuePrefix: companyId.slice(0, 8),
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: actor });
    await db.insert(companyMemberships).values({ companyId, principalId: actor, principalType: "user", status: "active", membershipRole: "owner" });
    const files: Record<string, string> = {
      "COMPANY.md": '---\nname: "Imported status regression"\n---\n',
      "agents/worker/AGENTS.md": '---\nname: "Imported worker"\nslug: worker\nrole: engineer\n---\n\nContinue only ready work.\n',
    };
    let manifest = "schemaVersion: 7\ntasks:\n";
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const updatedAt = new Date().toISOString();
    for (const status of statuses) {
      const slug = status.replaceAll("_", "-");
      files[`tasks/${slug}/TASK.md`] = `---\nname: "Imported ${status}"\nkind: task\nassignee: worker\n---\n\nPreserve source status ${status}.\n`;
      manifest += `  ${slug}:\n    status: ${status}\n    createdAt: "${createdAt}"\n    updatedAt: "${updatedAt}"\n`;
      if (status === "in_progress") manifest += `    startedAt: "${createdAt}"\n`;
    }
    files[".paperclip.yaml"] = manifest;
    const result = await companyPortabilityService(db).importBundle({
      source: { type: "inline", rootPath: "import-status", files },
      include: { company: false, agents: true, projects: false, issues: true, skills: false },
      target: { mode: "existing_company", companyId }, agents: "all", collisionStrategy: "rename",
      adapterOverrides: { worker: { adapterType: "process", adapterConfig: { command: "true" } } },
    }, actor, { pauseAutomations: true });
    const agentId = result.agents.find(agent => agent.slug === "worker")!.id!;
    const tasks = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(tasks).toHaveLength(statuses.length);
    for (const status of statuses) expect(tasks.find(task => task.title === `Imported ${status}`)).toMatchObject({ status, originKind: "company_import", assigneeAgentId: agentId });
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toMatchObject([{ status: "paused", pauseReason: "import" }]);
    return { companyId, agentId, actor, tasks };
  }
  const runRows = (companyId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  const wakeRows = (companyId: string) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  async function ready(f: Awaited<ReturnType<typeof imported>>) {
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      await worker.process(f.agentId);
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await worker.process(f.agentId);
      expect(await db.select().from(agents).where(eq(agents.id, f.agentId))).toMatchObject([{ status: "idle", pauseReason: null, lifecycleHolds: [] }]);
    } finally { await worker.stop(); }
  }

  it.each(["recovery", "assignment-candidate"] as const)("real import + safety pause + resume: only todo/in_progress admit once (%s)", async owner => {
    const f = await imported();
    const heartbeat = heartbeatService(db, options);
    async function recover() {
      if (owner === "assignment-candidate") {
        // A saved/stale ordinary assignment must recheck current imported state
        // inside queue admission, not rely on a caller's earlier status snapshot.
        for (const task of f.tasks) await heartbeat.wakeup(f.agentId, { source: "assignment", triggerDetail: "system",
          reason: "issue_assigned", payload: { issueId: task.id }, requestedByActorType: "system",
          contextSnapshot: { issueId: task.id } });
      }
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, unanswered: false });
      for (const task of f.tasks) await heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId: task.id });
    }
    try {
      console.log(JSON.stringify({ check: "immediately-imported", owner, runs: await runRows(f.companyId), wakes: await wakeRows(f.companyId) }));
      // Real owners see the paused import before Resume. Assignment candidates
      // are submitted only after readiness; no fabricated import-time receipt.
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, unanswered: false });
      for (const task of f.tasks) await heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId: task.id });
      expect(await runRows(f.companyId)).toHaveLength(0);
      await ready(f);
      await recover();
      await recover();
      const runs = await runRows(f.companyId);
      const current = await db.select().from(issues).where(eq(issues.companyId, f.companyId));
      const counts = Object.fromEntries(statuses.map(status => {
        const task = f.tasks.find(task => task.title === `Imported ${status}`)!;
        return [status, runs.filter(run => run.contextSnapshot?.issueId === task.id).length];
      }));
      console.log(JSON.stringify({ check: "resumed-status-matrix", owner, counts,
        statuses: current.map(task => ({ title: task.title, status: task.status })),
        runs: runs.map(run => ({ id: run.id, status: run.status, context: run.contextSnapshot })), wakes: await wakeRows(f.companyId) }));
      expect(counts).toEqual({ blocked: 0, in_review: 0, done: 0, cancelled: 0, todo: 1, in_progress: 1 });
      for (const task of f.tasks) expect(current.find(row => row.id === task.id)!.status).toBe(task.status);
      for (const run of runs) expect(run).toMatchObject({ status: "queued", contextSnapshot: { wakeReason: "issue_assigned" } });
    } finally { await heartbeat.drainActiveRunExecutions(); }
  });

  it.each(["blocked", "in_review", "done", "cancelled"] as const)("a stale imported todo snapshot cannot admit after status changes to %s", async status => {
    const f = await imported(); await ready(f);
    const task = f.tasks.find(task => task.status === "todo")!;
    const heartbeat = heartbeatService(db, options);
    const recovery = recoveryService(db, {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async ({ issueId, runId }) => {
        expect(issueId).toBe(task.id); expect(runId).toBeNull();
        await db.update(issues).set({ status }).where(eq(issues.id, task.id));
      },
    });
    try {
      await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: task.id });
      expect(await runRows(f.companyId)).toHaveLength(0);
      expect(await db.select().from(issues).where(eq(issues.id, task.id))).toMatchObject([{ status }]);
    } finally { await heartbeat.drainActiveRunExecutions(); }
  });

  it.each(["todo", "in_progress"])("a separate controller's real Stop fences stale imported %s recovery", async status => {
    const f = await imported(); await ready(f);
    const task = f.tasks.find(task => task.status === status)!;
    const heartbeat = heartbeatService(db, options);
    let peerPid: number | undefined;
    const recovery = recoveryService(db, {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async ({ issueId, runId }) => {
        expect(issueId).toBe(task.id); expect(runId).toBeNull();
        const { stdout } = await promisify(execFile)(process.execPath, ["--import",
          fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
          fileURLToPath(new URL("./rfl-importpause-peer.ts", import.meta.url))], {
          timeout: 60_000,
          env: { ...process.env, RFL_LOCAL_DATABASE_URL: database.connectionString, RFL_COMPANY_ID: f.companyId,
            RFL_ISSUE_ID: task.id, RFL_ACTOR_ID: f.actor, RFL_STOP_FIRST: "1", RFL_CRASH_BEFORE_QUEUE: "0" },
        });
        console.log(stdout.trim());
        const receipt = JSON.parse(stdout.trim().split("\n").at(-1)!);
        peerPid = receipt.pid;
        expect(peerPid).not.toBe(process.pid);
      },
    });
    try {
      await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: task.id });
      const runs = await runRows(f.companyId);
      console.log(JSON.stringify({ check: "separate-controller-import-stop", status, localPid: process.pid, peerPid,
        runs: runs.map(run => ({ id: run.id, status: run.status })) }));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "cancelled", contextSnapshot: { issueId: task.id } });
    } finally { await heartbeat.drainActiveRunExecutions(); }
  }, 90_000);

  it("stale imported todo recovery cannot undo a peer's completed initial admission and Stop", async () => {
    const f = await imported(); await ready(f);
    const task = f.tasks.find(task => task.status === "todo")!;
    const heartbeat = heartbeatService(db, options);
    const scope = { companyId: f.companyId, issueId: task.id };
    const peer = createDb(database.connectionString);
    const peerHeartbeat = heartbeatService(peer, options);
    const recovery = recoveryService(db, {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async ({ runId }) => {
        expect(runId).toBeNull();
        await peerHeartbeat.reconcileStrandedAssignedIssues({ ...scope, unanswered: false });
        const [first] = await runRows(f.companyId); expect(first).toBeDefined();
        await peerHeartbeat.cancelRun(first!.id, "Operator stopped imported todo", {
          suppressImmediateRecovery: true, resultJson: { cancelledByActorType: "user", cancelledByUserId: f.actor },
        });
      },
    });
    try {
      await recovery.reconcileStrandedAssignedIssues(scope);
      const runs = await runRows(f.companyId);
      console.log(JSON.stringify({ check: "todo-peer-stop-race", runs: runs.map(run => ({ id: run.id, status: run.status })) }));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("cancelled");
    } finally { await heartbeat.drainActiveRunExecutions(); await peerHeartbeat.drainActiveRunExecutions(); await peer.$client.end(); }
  });
});
