import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { createLifecycleWorker } from "../modules/agent-lifecycle/application/worker.js";
import { issueService } from "../services/issues.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { noticeParkedAssignment } from "../services/recovery/unanswered-person-message.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping paused assignee new task tests: ${recoveryPostgresSupport.reason}`);

describePostgres("new task for a manually paused assignee", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const dispatched: string[] = [];
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("heartbeat-paused-assignee-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-paused-assignee-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        dispatched.push(input.runId);
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seed(holds: string[], status = "todo") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = `paused-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Board user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paused assignee fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Morgan", adapterType, adapterConfig: {},
      status: "paused", lifecycleState: "paused", lifecycleHolds: holds, pauseReason: holds[0] ?? null, pausedAt: new Date() });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task created while Morgan is paused", status,
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId };
  }

  const runs = (f: { companyId: string; agentId: string }) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));

  it("keeps the task waiting while the pause lasts and starts it once on resume", async () => {
    const f = await seed(["manual"]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(waiting.status).toBe("todo");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    expect(await runs(f)).toHaveLength(0);

    await db.update(agents).set({ status: "idle", lifecycleState: "ready", lifecycleHolds: [], pauseReason: null, pausedAt: null })
      .where(eq(agents.id, f.agentId));
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    const ids = new Set((await runs(f)).map(run => run.id));
    expect(dispatched.filter(id => ids.has(id))).toHaveLength(1);
    const [finished] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(finished.status).toBe("done");
  }, 180_000);

  // Keep: case 8b's real catch. Two recovery owners must explain a parked
  // assignment once without treating an absent person comment as absent work.
  it("notices a parked Stop assignment once across racing owners without un-parking", async () => {
    const f = await seed([]);
    await db.update(agents).set({ lifecycleState: "pausing",
      lifecycleOperation: { id: randomUUID(), attempts: 5, stopFailures: 5, retryRequired: true,
        hostComplete: false, completedPluginIds: [], resumeState: "ready" },
      lifecycleError: "Automatic stop work is paused. Recheck the stop evidence, then use Retry." })
      .where(eq(agents.id, f.agentId));
    const other = heartbeatService(db);
    await Promise.all([
      heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId }),
      other.reconcileStrandedAssignedIssues({ companyId: f.companyId }),
    ]);
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(waiting.status).toBe("todo");
    expect(await runs(f)).toHaveLength(0);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "paused", lifecycleState: "pausing",
      lifecycleOperation: { retryRequired: true, stopFailures: 5 } });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "system", authorAgentId: null, authorUserId: null,
      body: "Morgan is stopping and can't take this task yet. Automatic stop work is paused. "
        + "A board user or Morgan's manager must check the outstanding stop or cleanup, then use Retry on the agent. "
        + "Paperclip will reconsider this task when the agent is ready." });
    expect(comments[0].metadata?.authorizationReason).toMatch(/^parked_assignment:/);
    console.log("PARKED_ASSIGNMENT_ONCE", JSON.stringify({ issueId: f.issueId, agentId: f.agentId,
      issueStatus: waiting.status, lifecycleState: agent.lifecycleState, comments, runCount: 0 }));
  }, 180_000);

  it.each(["ready", "reassigned", "done", "other-company"] as const)(
    "does not publish a stale parked-assignment note after %s", async change => {
      const f = await seed([]);
      await db.update(agents).set({ lifecycleState: "pausing",
        lifecycleOperation: { id: randomUUID(), attempts: 5, stopFailures: 5, retryRequired: true,
          hostComplete: false, completedPluginIds: [] } })
        .where(eq(agents.id, f.agentId));
      if (change === "ready") await db.update(agents).set({ status: "idle", lifecycleState: "ready" })
        .where(eq(agents.id, f.agentId));
      if (change === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      if (change === "done") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      await noticeParkedAssignment(db, { ...f, companyId: change === "other-company" ? randomUUID() : f.companyId });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    }, 180_000);

  // Keep reason: SMAA-1873. The real pause/resume command removes the hold
  // before Stop settles; the recovery sweep must not escalate that admission wait.
  it("keeps a never-run assignment todo when Resume races an unfinished Pause, then runs once ready", async () => {
    const f = await seed([]);
    await db.delete(issues).where(eq(issues.id, f.issueId));
    await db.update(agents).set({ status: "idle", lifecycleState: "ready", lifecycleHolds: [], pauseReason: null,
      adapterType: "process", adapterConfig: { command: process.execPath, args: [], cwd: process.cwd() } })
      .where(eq(agents.id, f.agentId));
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.pauseAgent(f.agentId);
    const resumedAt = Date.now();
    await lifecycle.resumeAgent(f.agentId);
    const [resuming] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(resuming).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleHolds: [], pauseReason: null });
    const issue = await issueService(db).create(f.companyId, {
      title: "Assign immediately after Resume", status: "todo", assigneeAgentId: f.agentId,
    });
    expect(Date.now() - resumedAt).toBeLessThan(3_000);
    const sweep = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [waiting] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    console.log("SMAA-1873 pause/resume/assign sweep", JSON.stringify({
      assignmentDelayMs: issue.createdAt.getTime() - resumedAt,
      agent: { status: resuming.status, lifecycleState: resuming.lifecycleState, holds: resuming.lifecycleHolds },
      issueStatus: waiting.status, runs: (await runs(f)).length,
      recovery: actions.map(action => ({ kind: action.kind, ownerType: action.ownerType, status: action.status })), sweep,
    }));
    expect(waiting.status).toBe("todo");
    expect(actions).toHaveLength(0);
    expect(await runs(f)).toHaveLength(0);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("todo");

    // The real process adapter completes this controlled task through the issue
    // service. No adapter, lifecycle step, or recovery sweep is mocked here.
    const providerErrors: unknown[] = [];
    const completion = createServer((request, response) => {
      void (async () => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { runId } = JSON.parse(body) as { runId: string };
        const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.agentId, f.agentId), eq(heartbeatRuns.companyId, f.companyId)));
        expect(run.contextSnapshot?.issueId).toBe(issue.id);
        await issueService(db).update(issue.id, { status: "done" });
        response.end("ok");
      })().catch(error => { providerErrors.push(error); response.statusCode = 500; response.end("completion failed"); });
    });
    await new Promise<void>(resolve => completion.listen(0, "127.0.0.1", resolve));
    const port = (completion.address() as { port: number }).port;
    const worker = createLifecycleWorker(createLifecycleStore(db, createAgentLifecycleEffects()),
      createLifecycleDriver(db, {} as never), (_context, error) => { throw error; });
    try {
      const script = `fetch("http://127.0.0.1:${port}/complete", {method:"POST", body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async response=>{if(!response.ok)throw new Error(await response.text());console.log("strand-ready-proof")}).catch(error=>{console.error(error);process.exitCode=1})`;
      await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd: process.cwd() } })
        .where(eq(agents.id, f.agentId));
      await worker.process(f.agentId);
      const [ready] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(ready).toMatchObject({ status: "idle", lifecycleState: "ready", lifecycleHolds: [] });
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
      const completed = await runs(f);
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe("succeeded");
      expect(completed[0].stdoutExcerpt).toContain("strand-ready-proof");
      expect(providerErrors).toEqual([]);
      expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("done");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id))).toHaveLength(0);
      console.log("SMAA-1873 ready", JSON.stringify({ lifecycleState: ready.lifecycleState, issueStatus: "done", runStatus: completed[0].status,
        runCount: completed.length, stdout: completed[0].stdoutExcerpt }));
    } finally {
      await worker.stop();
      await heartbeat.drainActiveRunExecutions();
      completion.closeAllConnections();
      await new Promise<void>(resolve => completion.close(() => resolve()));
    }
  }, 180_000);

  it("leaves in-progress work of a manually paused assignee alone instead of blocking it", async () => {
    const f = await seed(["manual"], "in_progress");
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved.status).toBe("in_progress");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    expect(await runs(f)).toHaveLength(0);
  }, 180_000);

  it("explains a stopped task in plain words when the assignee cannot run", async () => {
    const f = await seed(["budget"], "in_progress");
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved.status).toBe("blocked");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments.map(comment => comment.body)).toEqual([
      "Morgan can't run right now, so Paperclip stopped this task instead of retrying it. It is still assigned to them. To continue, resume or fix the agent, or assign the task to someone else.",
    ]);
  }, 180_000);

  it("still escalates a new task whose assignee is paused by something other than a person", async () => {
    const f = await seed(["budget"]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved.status).not.toBe("todo");
    expect(await runs(f)).toHaveLength(0);
  }, 180_000);
});
