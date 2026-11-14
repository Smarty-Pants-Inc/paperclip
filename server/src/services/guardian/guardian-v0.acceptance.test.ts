import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { GUARDIAN_PLUGIN_ID, startRealPluginLoader } from "../../__tests__/helpers/plugin-real-loader.js";
import { createAgentLifecycle } from "../agent-lifecycle.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";

// Keep reason: real loader/RPC/DB trust boundary plus RFL R6-STRAND's persisted
// parked-task failure. These are ordinary failing tests, NOT it.fails/expected failures.
// SQL builds stuck states; the person posts and reads through the real board API.
// No provider is called: original fixtures disable wake-on-demand; case 8b
// keeps the runtime defaults and uses only a local /bin/true process adapter.
describe.each(["unlocked", "locked"] as const)("conversation guardian v0 — real server + Postgres (%s)", mode => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let runtime: Awaited<ReturnType<typeof startRealPluginLoader>>;
  let pluginId: string;
  let parkedFixture: Fixture;
  let releaseParkedSeed = () => {};
  let parkedSeedLock: Promise<void> | undefined;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("guardian-v0-acceptance-");
    db = createDb(database.connectionString, { maxConnections: 6 });
    await db.insert(authUsers).values({ id: "local-board", name: "Guardian judge", email: "guardian-judge@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    // Persist the same RFL seed before boot; do not fence the production worker.
    parkedFixture = await seed(false);
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.pauseAgent(parkedFixture.agent.id);
    await lifecycle.resumeAgent(parkedFixture.agent.id);
    const [pausing] = await db.select().from(agents).where(eq(agents.id, parkedFixture.agent.id));
    const parkedOperation = { ...pausing.lifecycleOperation!, retryRequired: true, stopFailures: 5 };
    await db.update(agents).set({ lifecycleOperation: parkedOperation,
      lifecycleError: "Automatic stop work is paused after 5 incomplete attempts. Recheck the stop evidence, then use Retry." })
      .where(eq(agents.id, parkedFixture.agent.id));
    const old = new Date(Date.now() - 86_400_000);
    await db.update(issues).set({ createdAt: old, updatedAt: old }).where(eq(issues.id, parkedFixture.issue.id));
    const initial = await snapshot(parkedFixture, "seed-before-boot", 0);
    expect(initial.agent).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleHolds: [],
      lifecycleOperation: { retryRequired: true, stopFailures: 5 },
      lifecycleError: "Automatic stop work is paused after 5 incomplete attempts. Recheck the stop evidence, then use Retry." });
    expect(initial.task).toMatchObject({ status: "todo", assigneeAgentId: parkedFixture.agent.id });
    expect(initial.runs).toHaveLength(0);
    expect(initial.comments).toHaveLength(0);
    expect(initial.recoveryActions).toHaveLength(0);
    if (mode === "locked") {
      // case 8u (unit, LOCKED: hides the lifecycle worker)
      // Separate database/runtime: this lock cannot block case 8's real worker.
      // Normal MVCC reads, including plugin RPC, still see the committed seed.
      const gate = new Promise<void>(resolve => { releaseParkedSeed = resolve; });
      let locked!: () => void;
      let lockFailed!: (error: unknown) => void;
      const acquired = new Promise<void>((resolve, reject) => { locked = resolve; lockFailed = reject; });
      parkedSeedLock = db.transaction(async tx => {
        await tx.select().from(agents).where(eq(agents.id, parkedFixture.agent.id)).for("no key update");
        locked();
        await gate;
      });
      void parkedSeedLock.catch(lockFailed);
      await acquired;
    }
    runtime = await startRealPluginLoader(db);
    const plugin = await runtime.install();
    expect(plugin.pluginKey).toBe(GUARDIAN_PLUGIN_ID);
    pluginId = plugin.id;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    releaseParkedSeed();
    try { await parkedSeedLock; }
    finally {
      try { await runtime?.close(); }
      finally { await db?.$client.end(); await database?.cleanup(); }
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  async function seed(personComment = true) {
    const suffix = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({ name: `Guardian judge ${suffix}`, issuePrefix: `G${suffix}`,
      defaultResponsibleUserId: "local-board" }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "local-board",
      status: "active", membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Guardian assignee", role: "engineer",
      adapterType: "process", adapterConfig: {}, status: "idle", lifecycleState: "ready",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } } }).returning();
    const old = new Date(Date.now() - 180_000);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Please review this task", status: "todo",
      assigneeAgentId: agent.id, responsibleUserId: "local-board", createdAt: old, updatedAt: old }).returning();
    let request: typeof issueComments.$inferSelect | undefined;
    if (personComment) {
      const posted = await runtime.api<{ id: string; authorType: string }>(`/issues/${issue.id}/comments`, {
        body: "Please review this and tell me the result.",
      });
      expect(posted.authorType).toBe("user");
      [request] = await db.update(issueComments).set({ createdAt: old, updatedAt: old })
        .where(eq(issueComments.id, posted.id)).returning();
      expect(request.authorUserId).toBe("local-board");
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toHaveLength(0);
    return { company, agent, issue, request, old };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  async function snapshot(f: Fixture, phase: string, elapsedMs: number) {
    const [agent] = await db.select({ status: agents.status, lifecycleState: agents.lifecycleState,
      lifecycleHolds: agents.lifecycleHolds, lifecycleOperation: agents.lifecycleOperation,
      lifecycleError: agents.lifecycleError, pauseReason: agents.pauseReason })
      .from(agents).where(eq(agents.id, f.agent.id));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
    const recoveryActions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issue.id));
    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    const value = { timestamp: new Date().toISOString(), mode, phase, elapsedMs, companyId: f.company.id,
      agentId: f.agent.id, issueId: f.issue.id, agent, task, runs, comments, recoveryActions, wakeups, activity };
    console.log("GUARDIAN_CASE8_SNAPSHOT", JSON.stringify(value));
    return value;
  }

  async function seedRun(f: Fixture, status: "queued" | "running" | "failed" | "succeeded") {
    const createdAt = new Date(f.old.getTime() + 1_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status,
      runtimeMode: "native", nativeIssueId: f.issue.id, invocationSource: "assignment", triggerDetail: "system",
      createdAt, updatedAt: createdAt, startedAt: status === "queued" ? null : createdAt,
      finishedAt: ["failed", "succeeded"].includes(status) ? new Date(f.old.getTime() + 5_000) : null,
      error: status === "failed" ? "Judge-seeded run failure" : null,
      contextSnapshot: { issueId: f.issue.id, wakeCommentIds: [f.request!.id] },
    }).returning();
    return run;
  }

  async function sweep(f: Fixture, count = 1) {
    // Opt in only AFTER every input is persisted: startup reconciliation must
    // not observe a half-seeded running/answered control and post a false note.
    await runtime.setCompanyConfig(pluginId, f.company.id, { enabled: true });
    for (let i = 0; i < count; i++) await runtime.runJob(pluginId);
  }

  async function notes(f: Fixture, label: string) {
    const comments = await runtime.comments(f.issue.id);
    console.log("GUARDIAN_COMMENTS", JSON.stringify({ label, companyId: f.company.id, issueId: f.issue.id,
      requestId: f.request?.id ?? null, comments }));
    return comments.filter(comment => comment.authorType === "system");
  }

  async function oneNote(f: Fixture, reason: string | RegExp, label: string) {
    const rows = await notes(f, label);
    expect(rows, `${label}: exactly one persisted system note`).toHaveLength(1);
    const note = rows[0];
    expect(note.authorAgentId).toBeNull();
    expect(note.authorUserId).toBeNull();
    expect(new Date(note.createdAt).getTime()).toBeGreaterThan(f.old.getTime());
    expect(note.body).toContain(`conversation-guardian:note:${f.request!.id}`);
    if (typeof reason === "string") expect(note.body).toContain(reason);
    else expect(note.body).toMatch(reason);
    return note;
  }

  if (mode === "locked") {
    it("case 8u (unit, LOCKED: hides the lifecycle worker)", async () => {
      // Retain the original locked Stop/Retry assertions, not production proof.
      const f = parkedFixture;
      expect(await runtime.comments(f.issue.id)).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(0);
      await sweep(f);
      const rows = await notes(f, "8u / parked Stop (LOCKED unit)");
      const after = await snapshot(f, "after-guardian-job", 0);
      expect(after.task).toMatchObject({ status: "todo", assigneeAgentId: f.agent.id });
      expect(after.agent).toMatchObject({ lifecycleState: "pausing", lifecycleHolds: [],
        lifecycleOperation: { retryRequired: true, stopFailures: 5 } });
      expect(rows).toHaveLength(1);
      expect(rows[0].authorAgentId).toBeNull();
      expect(rows[0].authorUserId).toBeNull();
      expect(rows[0].body).toContain("conversation-guardian:");
      expect(rows[0].body).toMatch(/stop/i);
      expect(rows[0].body).toMatch(/failed|failure|incomplete|stuck/i);
      expect(rows[0].body).toContain("5");
      expect(rows[0].body).toContain("Retry");
    }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
    return;
  }

  it("1 / I1: nothing took the person's message", async () => {
    const f = await seed();
    await sweep(f);
    await oneNote(f, "hasn't been picked up", "1 / nothing took it");
  });

  it("2 / I1: queued run never started", async () => {
    const f = await seed();
    await seedRun(f, "queued");
    await sweep(f);
    await oneNote(f, "waiting to start", "2 / queued");
  });

  it("3 / I1: failed run left no answer", async () => {
    const f = await seed();
    await seedRun(f, "failed");
    await sweep(f);
    await oneNote(f, /wasn't answered[\s\S]*run failed/, "3 / failed");
  });

  it("4 / I1: succeeded TASK run left no answer — one neutral note", async () => {
    const f = await seed();
    expect(f.issue.conversationAgentId).toBeNull();
    await seedRun(f, "succeeded");
    await sweep(f);
    // Shared v0 spec and G3 use two neutral phrasings; neither is a retry prompt.
    const note = await oneNote(f, /read[\s\S]*(nothing to add|finished without a reply)/i, "4 / succeeded task");
    expect(note.body).not.toMatch(/sending it again|use retry/i);
  });

  it("5 / I3: running run took it — zero notes after three jobs", async () => {
    const f = await seed();
    await seedRun(f, "running");
    await sweep(f, 3);
    expect(await notes(f, "5 / running")).toHaveLength(0);
    // A falsely agent-attributed guardian note must not evade the I3 control.
    expect(await runtime.comments(f.issue.id)).toHaveLength(1);
  });

  it("6 / I3: assignee answered after the message — zero notes", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "agent",
      authorAgentId: f.agent.id, body: "Reviewed: the result is ready.", createdAt: new Date(f.old.getTime() + 5_000) });
    await sweep(f);
    expect(await notes(f, "6 / answered")).toHaveLength(0);
    expect(await runtime.comments(f.issue.id)).toHaveLength(2);
  });

  it("7 / I4: six jobs and an actual worker restart still leave exactly one note", async () => {
    const f = await seed();
    await sweep(f);
    const first = await notes(f, "7 / first sweep");
    for (let i = 0; i < 3; i++) await runtime.runJob(pluginId);
    await runtime.restartWorker(pluginId);
    for (let i = 0; i < 2; i++) await runtime.runJob(pluginId);
    // Assert only after exercising all dispatches and the restart, even ABSENT.
    const final = await notes(f, "7 / six sweeps plus restart");
    expect(first).toHaveLength(1);
    expect(final).toHaveLength(1);
    expect(final[0].id).toBe(first[0].id);
    expect(final[0].body).toContain(`conversation-guardian:note:${f.request!.id}`);
  });

  it("8 / R6-STRAND F1 / REQUEST-SCOPE: UNLOCKED worker clears Stop; no-comment todo still needs a pickup note", async () => {
    const f = parkedFixture;
    // The real lifecycle delivery worker owns progress. This read-only 10s
    // sampling is bounded to three minutes; no forced core sweep or retry.
    const started = Date.now();
    for (let tick = 0; tick <= 18; tick++) {
      await delay(Math.max(0, started + tick * 10_000 - Date.now()));
      await snapshot(f, "worker-observation", Date.now() - started);
    }
    await sweep(f);
    const after = await snapshot(f, "after-guardian-job", Date.now() - started);
    const rows = await notes(f, "8 / UNLOCKED ready but no pickup");
    // Observed on ba8b96aa: the real worker consumes pausing despite
    // retryRequired. No explicit Retry, core sweep, or driver mock is used.
    // This is NOT proof of a durable parked-Stop state. Wake-on-demand remains
    // disabled, as in the original seed, so readiness alone produces no run.
    expect(after.agent).toMatchObject({ status: "idle", lifecycleState: "ready", lifecycleHolds: [],
      lifecycleError: null, pauseReason: null });
    expect(after.agent.lifecycleOperation).not.toHaveProperty("retryRequired");
    expect(after.agent.lifecycleOperation).not.toHaveProperty("stopFailures");
    expect(after.task).toMatchObject({ status: "todo", assigneeAgentId: f.agent.id, assigneeUserId: null });
    expect(after.runs).toHaveLength(0);
    expect(after.recoveryActions).toHaveLength(0);
    expect(rows, "8 / UNLOCKED: exactly one persisted system pickup note").toHaveLength(1);
    expect(rows[0].authorAgentId).toBeNull();
    expect(rows[0].authorUserId).toBeNull();
    expect(rows[0].body).toContain("conversation-guardian:");
    expect(rows[0].body).toContain("hasn't been picked up");
    expect(rows[0].body).not.toMatch(/\bstop\b|\bretry\b/i);
  }, 180_000 + EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("case 8b / default agent: UNLOCKED Stop clears and task starts; no guardian note needed after 180s", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({ name: `Guardian default judge ${suffix}`,
      issuePrefix: `D${suffix}`, defaultResponsibleUserId: "local-board",
      requireBoardApprovalForNewAgents: false }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user",
      principalId: "local-board", status: "active", membershipRole: "operator" });
    // Normal board creation, NOT seed(): omit runtimeConfig entirely. The local
    // process adapter cannot call a provider even if ordinary assignment runs.
    const created = await runtime.api<{ id: string }>(`/companies/${company.id}/agents`, {
      name: "Fresh default assignee", role: "engineer", adapterType: "process",
      adapterConfig: { command: "/bin/true" },
    });
    let [agent] = await db.select().from(agents).where(eq(agents.id, created.id));
    const readyDeadline = Date.now() + 30_000;
    // Hiring/lifecycle notifications drive setup; bounded reads only observe it.
    while (agent.lifecycleState !== "ready" && Date.now() < readyDeadline) {
      await delay(100);
      [agent] = await db.select().from(agents).where(eq(agents.id, created.id));
    }
    expect(agent.lifecycleState, "fresh API-created agent must finish ordinary setup").toBe("ready");
    console.log("GUARDIAN_CASE8B_DEFAULT", JSON.stringify({ timestamp: new Date().toISOString(),
      companyId: company.id, agentId: agent.id, runtimeConfig: agent.runtimeConfig,
      resolvedWakeOnDemand: isHeartbeatWakeOnDemandEnabled(agent) }));
    expect(agent.runtimeConfig.heartbeat).not.toHaveProperty("wakeOnDemand");
    expect(isHeartbeatWakeOnDemandEnabled(agent)).toBe(true);

    // Use the same pause/resume producer as case 8 so real lifecycle delivery
    // is notified. Persist its exact parked-Stop shape in one unlocked update;
    // no retry, forced worker sweep, driver mock, or held row lock. Bump the
    // version to fence any old operation already claimed during live setup.
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.pauseAgent(agent.id);
    await lifecycle.resumeAgent(agent.id);
    const parkedOperation = { id: randomUUID(), attempts: 0,
      pauseCause: { holds: ["manual"], companyPauseReason: null }, resumeState: "ready" as const,
      hostComplete: false, completedPluginIds: [], retryRequired: true, stopFailures: 5 };
    const [seeded] = await db.update(agents).set({ status: "paused", lifecycleState: "pausing",
      lifecycleHolds: [], pauseReason: null, lifecycleVersion: sql`${agents.lifecycleVersion} + 1`,
      lifecycleOperation: parkedOperation,
      lifecycleError: "Automatic stop work is paused after 5 incomplete attempts. Recheck the stop evidence, then use Retry.",
      updatedAt: new Date(),
    }).where(eq(agents.id, agent.id)).returning();
    console.log("GUARDIAN_CASE8B_SEED", JSON.stringify({ timestamp: new Date().toISOString(), agent: seeded }));
    expect(seeded).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleHolds: [],
      lifecycleOperation: { retryRequired: true, stopFailures: 5 } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toHaveLength(0);

    // A person assigns a new todo through the board API, while the Stop seed
    // is live. Do not insert the task in SQL, backdate it, or suppress its wake.
    const createdIssue = await runtime.api<{ id: string }>(`/companies/${company.id}/issues`, {
      title: "Please review this default-agent task", status: "todo", assigneeAgentId: agent.id,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, createdIssue.id));
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: agent.id, createdByUserId: "local-board" });
    const f: Fixture = { company, agent, issue, request: undefined, old: issue.createdAt };
    const started = Date.now();
    const samples: Awaited<ReturnType<typeof snapshot>>[] = [];
    // Assignment/lifecycle events own progress. Read-only observation is bounded
    // to 180s with 10s samples; no guardian job or other intervention during it.
    for (let tick = 0; tick <= 18; tick++) {
      await delay(Math.max(0, started + tick * 10_000 - Date.now()));
      samples.push(await snapshot(f, "case8b-worker-observation", Date.now() - started));
    }
    const after = samples.at(-1)!;
    const unparked = samples.some(value => value.agent.lifecycleState === "ready");
    const taskRuns = after.runs.filter(run => run.nativeIssueId === issue.id || run.contextSnapshot?.issueId === issue.id);
    const outcome = unparked && taskRuns.length > 0 ? 1
      : unparked && after.task.status === "todo" && after.runs.length === 0 ? 2 : 3;
    const rows = await notes(f, "case 8b / default runtime after 180s");
    const [finalAgent] = await db.select().from(agents).where(eq(agents.id, agent.id));
    console.log("GUARDIAN_CASE8B_OUTCOME", JSON.stringify({ outcome, elapsedMs: Date.now() - started,
      unparked, taskStatus: after.task.status, taskRuns: taskRuns.map(run => ({ id: run.id, status: run.status })),
      wakeups: after.wakeups, comments: after.comments, recoveryActions: after.recoveryActions,
      runtimeConfig: finalAgent.runtimeConfig, resolvedWakeOnDemand: isHeartbeatWakeOnDemandEnabled(finalAgent) }));
    expect(finalAgent.runtimeConfig).toEqual(agent.runtimeConfig);
    // Observed on ba8b96aa with the guardian absent: outcome 1, unlike case 8.
    // Pin that result rather than allowing a later no-run regression to pass.
    expect(outcome, "default-agent observation must match pinned outcome 1").toBe(1);
    expect(after.agent).toMatchObject({ status: "idle", lifecycleState: "ready", lifecycleHolds: [],
      lifecycleError: null, pauseReason: null });
    expect(after.agent.lifecycleOperation).not.toHaveProperty("retryRequired");
    expect(after.agent.lifecycleOperation).not.toHaveProperty("stopFailures");
    expect(after.task).toMatchObject({ assigneeAgentId: agent.id, assigneeUserId: null });
    expect(taskRuns.length, "the API-assigned task starts without guardian intervention").toBeGreaterThan(0);
    expect(taskRuns.some(run => run.startedAt !== null), "a task run actually starts, not just queues").toBe(true);
    expect(rows, "case 8b: no system guardian pickup note is needed after 180s").toHaveLength(0);
    expect(after.comments.some(comment => comment.body.includes("conversation-guardian:"))).toBe(false);
  }, 210_000 + EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
