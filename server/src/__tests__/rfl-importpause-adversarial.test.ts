import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, budgetPolicies, costEvents, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { createAgentSchema, updateAgentSchema, createIssueSchema, updateIssueSchema } from "@paperclipai/shared";
import { and, eq, isNull } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

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
    return { companyId, agentId, tasks, actor };
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

  it.each(["manual", "import-then-manual", "manual-then-import"])("true paused note exactly once across repeat sweeps: %s", async order => {
    const f = await fixture();
    if (order !== "import-then-manual") await ready(f);
    await createAgentLifecycle(db).pauseAgent(f.agentId, "manual");
    // The internal import caller uses this same lifecycle operation. This
    // exercises hold order, not a public API forgery.
    if (order === "manual-then-import") await createAgentLifecycle(db).pauseAgent(f.agentId, "import");
    for (let i = 0; i < 3; i++) {
      await heartbeatService(db, options).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.tasks[0]!.id });
      await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.tasks[0]!.id, now: new Date(Date.now() + 60 * 60_000) });
    }
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    console.log(JSON.stringify({ check: order, holds: agent!.lifecycleHolds, pauseReason: agent!.pauseReason, notes: (await noteRows(f.tasks[0]!.id)).map(n => n.body) }));
    expect((await noteRows(f.tasks[0]!.id)).map(n => n.body)).toEqual([
      "RFL worker is paused. Your message is saved, and it will run when RFL worker is resumed. A board user or RFL worker's manager can resume RFL worker.",
    ]);
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
    const scope = { companyId: f.companyId, issueId: f.tasks[0]!.id, unanswered: false };
    const peerHeartbeat = heartbeatService(peer, options);
    const localHeartbeat = heartbeatService(db, options);
    let crossed = false;
    const recovery = recoveryService(db, {
      enqueueWakeup: (agentId, opts) => localHeartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async ({ runId }) => {
        expect(runId).toBeNull(); expect(crossed).toBe(false); crossed = true;
        // A second connection commits the normal admission while this sweep
        // retains the older no-run snapshot. Cancel through real heartbeat Stop,
        // not SQL: this models the operator stopping a queued initial run.
        await peerHeartbeat.reconcileStrandedAssignedIssues(scope);
        const [first] = await runRows(f.companyId); expect(first).toBeDefined();
        await peerHeartbeat.cancelRun(first!.id, "RFL operator stopped queued import run", {
          suppressImmediateRecovery: true,
          resultJson: { cancelledByActorType: "user", cancelledByUserId: f.actor },
        });
        const [stopped] = await runRows(f.companyId);
        expect(stopped!.status).toBe("cancelled");
      },
    });
    await recovery.reconcileStrandedAssignedIssues(scope);
    const runs = await runRows(f.companyId);
    console.log(JSON.stringify({ check: "stale-initial-import-admission", runs: runs.map(r => ({ id: r.id, status: r.status, reason: r.contextSnapshot?.wakeReason, source: r.contextSnapshot?.source })) }));
    expect(runs).toHaveLength(1);
  });

  it.each(["done", "unassigned"])("a stale initial-import snapshot does not override %s", async mutation => {
    const f = await fixture(); await ready(f);
    const heartbeat = heartbeatService(db, options);
    const recovery = recoveryService(db, {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async () => {
        await peer.update(issues).set(mutation === "done" ? { status: "done" } : { assigneeAgentId: null }).where(eq(issues.id, f.tasks[0]!.id));
      },
    });
    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.tasks[0]!.id });
    expect(await runRows(f.companyId)).toHaveLength(0);
    const [current] = await db.select().from(issues).where(eq(issues.id, f.tasks[0]!.id));
    if (mutation === "done") expect(current!.status).toBe("done");
    else expect(current!.assigneeAgentId).toBeNull();
  });

  it("a monitor armed after recovery's snapshot retains timer admission, not immediate assignment admission", async () => {
    const f = await fixture(); await ready(f);
    const due = new Date(Date.now() + 60 * 60_000);
    const heartbeat = heartbeatService(db, options);
    const recovery = recoveryService(db, {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async () => {
        await peer.update(issues).set({ monitorNextCheckAt: due, monitorScheduledBy: "agent", monitorNotes: "Judge armed monitor" }).where(eq(issues.id, f.tasks[0]!.id));
      },
    });
    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.tasks[0]!.id });
    const [current] = await db.select().from(issues).where(eq(issues.id, f.tasks[0]!.id));
    expect(current!.monitorNextCheckAt).toEqual(due);
    console.log(JSON.stringify({ check: "concurrently-armed-monitor", runCount: (await runRows(f.companyId)).length, due: current!.monitorNextCheckAt }));
    expect(await runRows(f.companyId)).toHaveLength(0);
  });

  it("an exhausted invocation budget admits zero imported issues", async () => {
    const f = await fixture(3); await ready(f);
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId, windowKind: "calendar_month_utc", amount: 1 });
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, provider: "local-test", biller: "local-test", billingType: "metered_api", model: "no-provider", inputTokens: 1, outputTokens: 1, costCents: 2, occurredAt: new Date() });
    await heartbeatService(db, options).reconcileStrandedAssignedIssues({ companyId: f.companyId, unanswered: false });
    expect(await runRows(f.companyId)).toHaveLength(0);
  });

  it("an existing queued wake prevents an extra import admission", async () => {
    const f = await fixture(); await ready(f);
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment", reason: "issue_assigned", status: "queued", payload: { issueId: f.tasks[0]!.id } });
    await heartbeatService(peer, options).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.tasks[0]!.id, unanswered: false });
    expect(await runRows(f.companyId)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
  });

  async function peerProcess(f: Awaited<ReturnType<typeof fixture>>, stop = false, crash = false) {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import",
      fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
      fileURLToPath(new URL("./rfl-importpause-peer.ts", import.meta.url))], {
      timeout: 60_000,
      env: { ...process.env, RFL_LOCAL_DATABASE_URL: database.connectionString, RFL_COMPANY_ID: f.companyId,
        RFL_ISSUE_ID: f.tasks[0]!.id, RFL_ACTOR_ID: f.actor, RFL_STOP_FIRST: stop ? "1" : "0", RFL_CRASH_BEFORE_QUEUE: crash ? "1" : "0" },
    });
    console.log(stdout.trim());
  }

  it("separate controller exits and restarts without duplicating the saved queued admission", async () => {
    const f = await fixture(); await ready(f);
    await peerProcess(f);
    await peerProcess(f);
    expect(await runRows(f.companyId)).toHaveLength(1);
  }, 150_000);

  it("a separate controller crash after resume but before admission is recovered once by its replacement", async () => {
    const f = await fixture(); await ready(f);
    await expect(peerProcess(f, false, true)).rejects.toMatchObject({ code: 77 });
    expect(await runRows(f.companyId)).toHaveLength(0);
    await peerProcess(f);
    await peerProcess(f);
    expect(await runRows(f.companyId)).toHaveLength(1);
  }, 180_000);

  it("a separate controller's real Stop cannot be undone by a stale initial-import sweep", async () => {
    const f = await fixture(); await ready(f);
    const heartbeat = heartbeatService(db, options);
    const recovery = recoveryService(db, {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async ({ runId }) => {
        expect(runId).toBeNull();
        await peerProcess(f, true);
      },
    });
    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.tasks[0]!.id });
    const runs = await runRows(f.companyId);
    console.log(JSON.stringify({ check: "separate-controller-stop-race", localPid: process.pid, runs: runs.map(r => ({ id: r.id, status: r.status })) }));
    expect(runs).toHaveLength(1);
  }, 90_000);

  it("five qualifying imported tasks produce exactly five ordinary durable assignment admissions", async () => {
    const f = await fixture(5); await ready(f);
    await heartbeatService(db, options).reconcileStrandedAssignedIssues({ companyId: f.companyId, unanswered: false });
    const runs = await runRows(f.companyId);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    console.log(JSON.stringify({ check: "burst-five", runCount: runs.length, wakeCount: wakes.length, sources: wakes.map(w => w.source) }));
    expect(runs).toHaveLength(5); expect(wakes).toHaveLength(5);
    expect(new Set(runs.map(r => r.contextSnapshot?.issueId)).size).toBe(5);
    for (const run of runs) expect(run).toMatchObject({ status: "queued", invocationSource: "assignment", contextSnapshot: { wakeReason: "issue_assigned" } });
    for (const wake of wakes) expect(wake).toMatchObject({ status: "queued", source: "assignment", reason: "issue_assigned" });
  });
});
