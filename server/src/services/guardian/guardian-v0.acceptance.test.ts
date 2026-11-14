import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  activityLog, agentApiKeys, agentWakeupRequests, boardApiKeys, heartbeatRunEvents, heartbeatRuns,
  issueComments, issueRecoveryActions, issueThreadInteractions, issues, nativeRunFinalizations, pluginDatabaseNamespaces, type Db,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { GUARDIAN_PLUGIN_ID, startRealPluginLoader } from "../../__tests__/helpers/plugin-real-loader.js";
import { createAgentLifecycle } from "../agent-lifecycle.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";
import { filterZombieCoalesceTarget, heartbeatService } from "../heartbeat.js";
import { createWakeQueue } from "../../modules/wake-queue/index.js";
import { createHeartbeatRunPreparation, mergeCoalescedContextSnapshot } from "../heartbeat/run-preparation.js";
import { createHeartbeatRunState } from "../heartbeat/run-state.js";
import { shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "../heartbeat/queue.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { currentControllerProcessStamp } from "../controller-process-identity.js";

// Keep: real loader/RPC/DB trust boundary and durable input safety (RFL F2/F3).
// Ordinary failing tests, never it.fails. The API admits person messages; real
// heartbeat admission/claim/drain paths hit scoped PostgreSQL fault triggers.
// No provider is called: execution uses only the local /bin/true process adapter.
// Non-timing fixtures age persisted rows, NOT the clock. Case 1 alone measures
// real minute-cron delivery. The old locked 8u is explicitly outside v0.
describe.each(["unlocked", "locked"] as const)("conversation guardian v0 — real server + Postgres (%s)", mode => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let runtime: Awaited<ReturnType<typeof startRealPluginLoader>>;
  let pluginId: string;
  let core: ReturnType<typeof heartbeatService>;
  const optedIn = new Set<string>();
  let parkedFixture: Fixture;
  let releaseParkedSeed = () => {};
  let parkedSeedLock: Promise<void> | undefined;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("guardian-v0-acceptance-");
    db = createDb(database.connectionString, { maxConnections: 6 });
    await db.insert(authUsers).values({ id: "local-board", name: "Guardian judge", email: "guardian-judge@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    core = heartbeatService(db);
    if (mode === "locked") {
      // Retained only for skipped 8u; no obsolete no-person seed in v0.
      parkedFixture = await seed(false, true, false);
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
      // 8u only: normal MVCC/plugin reads still see the committed seed.
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

  afterEach(async () => {
    // Old intentionally unanswered fixtures must not take part in later jobs.
    for (const companyId of optedIn) await runtime.setCompanyConfig(pluginId, companyId, { enabled: false });
    optedIn.clear();
  });

  async function guardianNamespace() {
    const [record] = await db.select().from(pluginDatabaseNamespaces).where(eq(pluginDatabaseNamespaces.pluginId, pluginId));
    if (!record || !/^[a-z0-9_]+$/.test(record.namespaceName)) throw new Error("Invalid guardian namespace metadata");
    return record.namespaceName;
  }

  async function readEnabledAt(companyId: string) {
    const namespace = await guardianNamespace();
    const rows = await db.$client.unsafe(`SELECT enabled_at FROM "${namespace}".configured_companies WHERE company_id = $1::uuid AND enabled = true`, [companyId]);
    expect(rows).toHaveLength(1);
    return new Date(rows[0].enabled_at);
  }

  async function enableFixtureCompany(companyId: string, testClock: boolean) {
    await runtime.setCompanyConfig(pluginId, companyId, { enabled: true });
    optedIn.add(companyId);
    if (testClock) {
      const namespace = await guardianNamespace();
      // TEST CLOCK: backdate enabled_at by 10 min so backdated messages are eligible
      const updated = await db.$client.unsafe(`UPDATE "${namespace}".configured_companies SET enabled_at = now() - interval '10 minutes' WHERE company_id = $1::uuid AND enabled = true RETURNING company_id`, [companyId]);
      expect(updated).toHaveLength(1);
    }
  }

  async function seed(personComment = true, backdate = true, configure = true) {
    const suffix = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({ name: `Guardian judge ${suffix}`, issuePrefix: `G${suffix}`,
      defaultResponsibleUserId: "local-board" }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "local-board",
      status: "active", membershipRole: "operator" });
    if (configure) await enableFixtureCompany(company.id, backdate);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Guardian assignee", role: "engineer",
      adapterType: "process", adapterConfig: { command: "/bin/true" }, status: "idle", lifecycleState: "ready",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } } }).returning();
    const old = new Date(Date.now() - (backdate ? 180_000 : 0));
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Please review this task", status: "todo",
      assigneeAgentId: agent.id, responsibleUserId: "local-board", createdAt: old, updatedAt: old }).returning();
    let request: typeof issueComments.$inferSelect | undefined;
    if (personComment) {
      const posted = await runtime.api<{ id: string; authorType: string }>(`/issues/${issue.id}/comments`, {
        body: "Please review this and tell me the result.",
      });
      expect(posted.authorType).toBe("user");
      if (backdate) {
        [request] = await db.update(issueComments).set({ createdAt: old, updatedAt: old })
          .where(eq(issueComments.id, posted.id)).returning();
      } else {
        [request] = await db.select().from(issueComments).where(eq(issueComments.id, posted.id));
      }
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
    const createdAt = new Date(f.old.getTime() + (f.request ? 1_000 : -1_000));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status,
      runtimeMode: "native", nativeIssueId: f.issue.id, issueId: f.issue.id, scopeKind: "issue",
      responsibleUserId: "local-board", invocationSource: "assignment", triggerDetail: "system",
      createdAt, updatedAt: createdAt, startedAt: status === "queued" ? null : createdAt,
      finishedAt: ["failed", "succeeded"].includes(status) ? new Date(f.old.getTime() + 5_000) : null,
      error: status === "failed" ? "Judge-seeded run failure" : null,
      contextSnapshot: { issueId: f.issue.id, wakeCommentIds: f.request ? [f.request.id] : [] },
    }).returning();
    return run;
  }

  async function sweep(f: Fixture, count = 1) {
    // Fixture setup opts in before person messages; later sweeps never reset enabled_at.
    if (!optedIn.has(f.company.id)) await enableFixtureCompany(f.company.id, false);
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

  async function readRun(id: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0];
  }

  async function readWake(id: string) {
    return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];
  }

  async function enableCoreWake(f: Fixture) {
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true,
      intervalSec: 0, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agent.id));
  }

  async function postFollowup(f: Fixture) {
    const posted = await runtime.api<{ id: string; authorType: string }>(`/issues/${f.issue.id}/comments`,
      { body: "M2: please review this saved follow-up and answer it." });
    expect(posted.authorType).toBe("user");
    [f.request] = await db.update(issueComments).set({ createdAt: f.old, updatedAt: f.old })
      .where(eq(issueComments.id, posted.id)).returning();
    // The comment route owns admission; wait for its persisted receipt, never
    // substitute a test-inserted wake. This observes asynchronous route effects.
    const wakes = await runtime.waitFor("person-message wake admission", () => db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.agent.id)), rows => rows.some(row => row.payload?.commentId === posted.id));
    const wake = wakes.find(row => row.payload?.commentId === posted.id)!;
    await db.update(agentWakeupRequests).set({ createdAt: f.old, updatedAt: f.old }).where(eq(agentWakeupRequests.id, wake.id));
    return wake;
  }

  async function deferredFollowup() {
    const f = await seed(false);
    const old = new Date(f.old.getTime() - 60_000);
    const stamp = currentControllerProcessStamp();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: f.issue.id, scopeKind: "issue", runtimeMode: "native", nativeIssueId: f.issue.id,
      status: "running", invocationSource: "assignment", responsibleUserId: "local-board",
      createdAt: old, updatedAt: old, startedAt: old, controllerBootId: stamp.bootId, controllerProcess: stamp,
      controllerLeaseExpiresAt: new Date(Date.now() + 600_000),
      contextSnapshot: { issueId: f.issue.id, taskId: f.issue.id } }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: source.id, companyId: f.company.id, issueId: f.issue.id, phase: "observed" });
    await db.update(issues).set({ status: "in_progress", executionRunId: source.id, checkoutRunId: source.id,
      executionAgentNameKey: f.agent.name, executionLockedAt: old }).where(eq(issues.id, f.issue.id));
    await enableCoreWake(f);
    const wake = await postFollowup(f);
    expect(await readWake(wake.id), "real core admission deferred M2 behind the owner").toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(source.createdAt.getTime()).toBeLessThan(f.request!.createdAt.getTime());
    expect((await readRun(source.id)).contextSnapshot?.wakeCommentIds ?? []).not.toContain(f.request!.id);
    console.log("GUARDIAN_DEFERRED_ADMISSION", JSON.stringify({ source, request: f.request, wake: await readWake(wake.id) }));
    return { f, source, wake };
  }

  async function queuedAtCapacity() {
    const f = await seed(false);
    const [holder] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "running", invocationSource: "assignment", responsibleUserId: "local-board",
      startedAt: new Date(), contextSnapshot: {} }).returning();
    await enableCoreWake(f);
    const wake = await postFollowup(f);
    const rows = await runtime.waitFor("queued person-message run", () => db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, f.agent.id)), rows => rows.some(row => row.id !== holder.id && row.status === "queued"));
    const queued = rows.find(row => row.id !== holder.id)!;
    expect(queued.contextSnapshot?.wakeCommentIds).toContain(f.request!.id);
    expect(await core.resumeQueuedRunsForAgent(f.company.id, f.agent.id), "real dispatcher refuses at full concurrency").toEqual([]);
    expect(await readRun(queued.id)).toMatchObject({ status: "queued", startedAt: null });
    console.log("GUARDIAN_CAPACITY_REFUSAL", JSON.stringify({ holder, queued: await readRun(queued.id), wake: await readWake(wake.id) }));
    return { f, holder, queued, wake };
  }

  // Same wake-queue release path as g3-core-progress.patch. Production resolver,
  // session and routine readers, no fake queue or plugin. Escalation is not part
  // of this suppressed-recovery release; reaching it is a fixture error.
  function deferredDrain() {
    const prep = createHeartbeatRunPreparation(db), state = createHeartbeatRunState(db);
    return createWakeQueue(db, {
      resolveResponsibleUserId: input => prep.resolveResponsibleUserIdForRunSeed({ ...input,
        issueContext: input.issue, source: input.source as "automation",
        triggerDetail: input.triggerDetail as "system",
        routineEnvContext: input.routineEnvContext as Awaited<ReturnType<typeof prep.getRoutineEnvForExecutionIssue>> }),
      getRoutineEnv: input => prep.getRoutineEnvForExecutionIssue(input.companyId, input.issue),
      resolveSessionBeforeForWakeup: async input => {
        const agent = await state.getAgent(input.agentId);
        return agent?.companyId === input.companyId ? state.resolveSessionBeforeForWakeup(agent, input.taskKey) : null;
      },
      wakeAdmissionHelpers: { filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: {
        escalateStrandedAssignedIssue: async () => { throw new Error("Unexpected C35 escalation"); },
        escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("Unexpected C35 escalation"); },
      },
    });
  }

  async function failRunWrite(f: Fixture, kind: "C35" | "E3.05") {
    const name = `guardian_fault_${randomUUID().replaceAll("-", "")}`;
    const transition = kind === "C35" ? "TG_OP = 'INSERT' AND NEW.status = 'queued'"
      : "TG_OP = 'UPDATE' AND OLD.status = 'queued' AND NEW.status = 'running'";
    // A sequence survives transaction rollback, proving that the REAL path hit
    // the injected persistence exception (not merely that the row stayed put).
    await db.execute(sql.raw(`CREATE SEQUENCE ${name}_hits`));
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.company_id = '${f.company.id}'::uuid AND ${transition} THEN
        PERFORM nextval('${name}_hits'); RAISE EXCEPTION '${kind} guardian injected persistence failure';
      END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON heartbeat_runs FOR EACH ROW EXECUTE FUNCTION ${name}()`));
    return {
      hits: async () => {
        const [row] = await db.execute<{ last_value: string; is_called: boolean }>(sql.raw(`SELECT last_value, is_called FROM ${name}_hits`));
        return row.is_called ? Number(row.last_value) : 0;
      },
      close: async () => {
        await db.execute(sql.raw(`DROP TRIGGER ${name} ON heartbeat_runs`));
        await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
        await db.execute(sql.raw(`DROP SEQUENCE ${name}_hits`));
      },
    };
  }

  async function agentHeaders(f: Fixture) {
    // Disposable in-database test identity only; no host/production credentials.
    const token = `guardian-test-${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: f.company.id, agentId: f.agent.id, name: "Guardian API fixture",
      keyHash: createHash("sha256").update(token).digest("hex"), responsibleUserId: "local-board" });
    return { authorization: `Bearer ${token}` };
  }

  if (mode === "locked") {
    it.skip("case 8u / older locked shape, LATER (RFL)", async () => {
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

  it("1 / I1 timing: real cron posts at 60–150 seconds, no manual trigger", async () => {
    const f = await seed(true, false);
    // Minute cron drives delivery; bounded API reads only observe it. No TEST CLOCK or message backdate.
    const enabledAt = await readEnabledAt(f.company.id);
    const start = f.request!.createdAt.getTime();
    expect(start).toBeGreaterThanOrEqual(enabledAt.getTime());
    const deadline = start + 150_000;
    let seen = await runtime.comments(f.issue.id);
    while (!seen.some(row => row.authorType === "system") && Date.now() < deadline) {
      await delay(Math.min(500, Math.max(0, deadline - Date.now())));
      seen = await runtime.comments(f.issue.id);
    }
    const evidence = await runtime.jobRunEvidence(pluginId);
    const jobs = evidence.runs.filter(run => new Date(run.createdAt).getTime() >= start);
    console.log("GUARDIAN_CRON_TIMING", JSON.stringify({ requestId: f.request!.id, enabledAt: enabledAt.toISOString(),
      messageAt: f.request!.createdAt, observedAt: new Date().toISOString(), jobProofPath: evidence.path, jobs, comments: seen }));
    expect(jobs.some(run => run.trigger === "schedule" && run.status === "succeeded"), "real scheduled job completed").toBe(true);
    const note = await oneNote(f, "hasn't been picked up", "1 / real cron");
    const elapsedMs = new Date(note.createdAt).getTime() - start;
    console.log("GUARDIAN_CRON_ELAPSED", JSON.stringify({ elapsedMs, requestId: f.request!.id, noteId: note.id,
      enabledAt: enabledAt.toISOString(), messageAt: f.request!.createdAt, noteAt: note.createdAt, jobProofPath: evidence.path }));
    expect(elapsedMs).toBeGreaterThanOrEqual(60_000);
    expect(elapsedMs).toBeLessThanOrEqual(150_000);
  }, 165_000);

  it("0.0.2 cutoff: pre-enable message stays uncovered; post-enable message gets one note", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({ name: `Guardian cutoff ${suffix}`, issuePrefix: `C${suffix}`,
      defaultResponsibleUserId: "local-board" }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "local-board",
      status: "active", membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Cutoff assignee", role: "engineer",
      adapterType: "process", adapterConfig: { command: "/bin/true" }, status: "idle", lifecycleState: "ready",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Backlog cutoff", status: "todo",
      assigneeAgentId: agent.id, responsibleUserId: "local-board" }).returning();
    const oldMessage = await runtime.api<{ id: string; authorType: string; createdAt: string }>(`/issues/${issue.id}/comments`, {
      body: "This request predates guardian enablement.",
    });
    expect(oldMessage.authorType).toBe("user");
    await enableFixtureCompany(company.id, false);
    const enabledAt = await readEnabledAt(company.id);
    const newMessage = await runtime.api<{ id: string; authorType: string; createdAt: string }>(`/issues/${issue.id}/comments`, {
      body: "This request follows guardian enablement.",
    });
    expect(newMessage.authorType).toBe("user");
    const oldAt = new Date(oldMessage.createdAt);
    const newAt = new Date(newMessage.createdAt);
    expect(oldAt.getTime()).toBeLessThan(enabledAt.getTime());
    expect(newAt.getTime()).toBeGreaterThanOrEqual(enabledAt.getTime());
    await delay(Math.max(0, newAt.getTime() + 60_000 - Date.now()));
    expect(Date.now() - newAt.getTime()).toBeGreaterThanOrEqual(60_000);
    const completed = await runtime.runJob(pluginId);
    const evidence = await runtime.jobRunEvidence(pluginId);
    expect(completed.status).toBe("succeeded");
    const comments = await runtime.comments(issue.id);
    const oldMarker = `<!-- conversation-guardian:note:${oldMessage.id} -->`;
    const newMarker = `<!-- conversation-guardian:note:${newMessage.id} -->`;
    const oldNotes = comments.filter(row => row.body.includes(oldMarker));
    const newNotes = comments.filter(row => row.body.includes(newMarker));
    console.log("GUARDIAN_BACKLOG_CUTOFF_REAL", JSON.stringify({ enabledAt: enabledAt.toISOString(),
      oldMessageAt: oldMessage.createdAt, oldMessageId: oldMessage.id, newMessageAt: newMessage.createdAt,
      newMessageId: newMessage.id, jobId: completed.id, jobStatus: completed.status,
      jobProofPath: evidence.path, jobRuns: evidence.runs.map(run => ({ id: run.id, trigger: run.trigger, status: run.status })),
      oldMarkerPresent: oldNotes.length > 0, newNotes: newNotes.map(note => ({ id: note.id, createdAt: note.createdAt, authorType: note.authorType })) }));
    expect(oldNotes, "pre-enable backlog must remain untouched after a successful durable job").toHaveLength(0);
    expect(newNotes, "post-enable message must receive exactly one note after its real 60s age").toHaveLength(1);
    expect(newNotes[0].authorType).toBe("system");
    expect(newNotes[0].body).toContain(newMarker);
  }, 120_000);

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
    const run = await seedRun(f, "succeeded");
    const before = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    await sweep(f, 2);
    const note = await oneNote(f, "read this and finished without a reply", "4 / succeeded task");
    expect(note.body).toContain(f.agent.name);
    expect(note.body).toContain(`/agents/${f.agent.id}/runs/${run.id}`);
    expect(note.body).not.toMatch(/nothing to add|sending it again|use retry/i);
    await runtime.runJob(pluginId);
    const after = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    expect(after.map(row => row.id).sort(), "successful TASK must never be rerun").toEqual(before.map(row => row.id).sort());
    expect(await notes(f, "4 / no rerun after note")).toHaveLength(1);
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

  it("C35 / real drain rolls back: one note, original wake remains deferred", async () => {
    const { f, source, wake } = await deferredFollowup();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(f.old.getTime() + 5_000) })
      .where(eq(heartbeatRuns.id, source.id));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, source.id));
    const fault = await failRunWrite(f, "C35");
    try {
      const drain = deferredDrain();
      await expect(drain.releaseIssueExecution({ companyId: f.company.id, runId: source.id, now: new Date(),
        suppressImmediateRecovery: true })).rejects.toThrow();
      expect(await fault.hits(), "release must reach the injected persistence failure").toBeGreaterThan(0);
      expect(await readWake(wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
      expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].executionRunId).toBe(source.id);
      await sweep(f, 2);
      // Check preservation before the intentionally RED ABSENT oracle.
      expect(await readWake(wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(1);
      console.log("GUARDIAN_C35_ROLLBACK", JSON.stringify({ hits: await fault.hits(), wake: await readWake(wake.id) }));
      const note = await oneNote(f, "read this and finished without a reply", "C35 / rollback");
      expect(note.body).toContain(f.agent.name);
      expect(note.body).toContain(`/agents/${f.agent.id}/runs/${source.id}`);
    } finally { await fault.close(); }
  });

  it("E3.01 / stalled execution lock: deferred message receives one note with the actual owner/run link", async () => {
    const { f, source, wake } = await deferredFollowup();
    const staleAt = new Date(Date.now() - 6 * 60_000);
    await db.update(heartbeatRuns).set({ lastOutputAt: staleAt, lastUsefulActionAt: staleAt, updatedAt: staleAt })
      .where(eq(heartbeatRuns.id, source.id));
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, source.id))).toHaveLength(0);
    const stalled = await readRun(source.id);
    expect(stalled.status).toBe("running");
    expect(stalled.lastOutputAt?.getTime()).toBe(staleAt.getTime());
    expect(stalled.lastUsefulActionAt?.getTime()).toBe(staleAt.getTime());
    expect(stalled.updatedAt.getTime()).toBe(staleAt.getTime());
    expect(Date.now() - Math.max(stalled.lastOutputAt!.getTime(), stalled.lastUsefulActionAt!.getTime(), stalled.updatedAt.getTime()))
      .toBeGreaterThan(5 * 60_000);
    await sweep(f, 2);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(issue.executionRunId).toBe(source.id);
    expect(await readRun(source.id)).toMatchObject({ status: "running", updatedAt: staleAt, lastOutputAt: staleAt, lastUsefulActionAt: staleAt });
    expect(await readWake(wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    const note = await oneNote(f, /hasn't been picked up|waiting/, "E3.01 / stalled lock");
    expect(note.body).toContain(f.agent.name);
    expect(note.body).toContain(`/agents/${f.agent.id}/runs/${source.id}`);
  });

  it("E3.01 / I3 control: event-emitting live lock-holder gets no note across three jobs", async () => {
    const { f, source, wake } = await deferredFollowup();
    for (let i = 0; i < 3; i++) {
      await appendHeartbeatRunEvent(db, { companyId: f.company.id, agentId: f.agent.id, runId: source.id,
        eventType: "stdout", stream: "stdout", level: "info", message: `Still working on the task, progress ${i}` });
      await sweep(f);
      expect.soft(await notes(f, `E3.01 / live lock job ${i + 1}`)).toHaveLength(0);
    }
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, source.id))).toHaveLength(3);
    expect(await readRun(source.id)).toMatchObject({ status: "running" });
    expect(await readWake(wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].executionRunId).toBe(source.id);
  });

  it("E3.04 / real concurrency refusal: waiting note, same queued run starts when slot frees", async () => {
    const { f, holder, queued, wake } = await queuedAtCapacity();
    await sweep(f);
    // Continue the free-slot control even in ABSENT, retaining both receipts.
    const first = await notes(f, "E3.04 / refused at capacity");
    expect.soft(first).toHaveLength(1);
    if (first[0]) expect.soft(first[0].body).toContain("waiting to start");
    expect(await readRun(queued.id)).toMatchObject({ status: "queued", startedAt: null });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holder.id));
    await core.resumeQueuedRunsForAgent(f.company.id, f.agent.id);
    const started = await runtime.waitFor("same queued run starts", () => readRun(queued.id), run => run.startedAt !== null);
    // Observe local /bin/true completion before teardown, not just claim time.
    // Ordinary core missing-comment continuation is not a guardian rerun.
    const settled = await runtime.waitFor("local process execution settles", () => db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, f.agent.id)), rows => rows.every(run => !["running", "queued"].includes(run.status)));
    for (const run of settled) await core.waitForRunExecutionDrain(run.id, { timeoutMs: 30_000 });
    await sweep(f, 2);
    expect(started.id).toBe(queued.id);
    expect(settled.filter(run => run.wakeupRequestId === wake.id).map(run => run.id)).toEqual([queued.id]);
    const final = await notes(f, "E3.04 / same run started");
    expect(final.map(note => note.id)).toEqual(first.map(note => note.id));
    console.log("GUARDIAN_E304_STARTED", JSON.stringify({ queuedRunId: queued.id, startedAt: started.startedAt,
      run: await readRun(queued.id), notes: final }));
  }, 60_000);

  it("E3.05 / real claim throws: queued row survives and gets one note", async () => {
    const { f, holder, queued } = await queuedAtCapacity();
    const fault = await failRunWrite(f, "E3.05");
    try {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holder.id));
      await expect(core.resumeQueuedRunsForAgent(f.company.id, f.agent.id)).rejects.toThrow();
      expect(await fault.hits(), "claim must reach the injected exception").toBeGreaterThan(0);
      expect(await readRun(queued.id)).toMatchObject({ status: "queued", startedAt: null, finishedAt: null });
      await sweep(f, 2);
      expect(await readRun(queued.id)).toMatchObject({ status: "queued", startedAt: null, finishedAt: null });
      console.log("GUARDIAN_E305_CLAIM", JSON.stringify({ hits: await fault.hits(), run: await readRun(queued.id) }));
      await oneNote(f, "waiting to start", "E3.05 / claim exception");
    } finally { await fault.close(); }
  });

  it("E3.09 / running follow-up: no note in three jobs, one after unanswered end + 60s", async () => {
    const { f, source, wake } = await deferredFollowup();
    for (let i = 0; i < 3; i++) {
      await sweep(f);
      expect.soft(await notes(f, `E3.09 / running job ${i + 1}`)).toHaveLength(0);
    }
    // Persist the missed-finalizer outcome; do not invent a successor or mutate
    // the run's input to pretend it carried a comment that arrived later.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, source.id));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, source.id));
    await runtime.runJob(pluginId);
    expect.soft(await notes(f, "E3.09 / before terminal + 60s")).toHaveLength(0);
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 61_000) }).where(eq(heartbeatRuns.id, source.id));
    await runtime.runJob(pluginId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(1);
    expect(await readWake(wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await oneNote(f, /hasn't been picked up|finished without a reply/, "E3.09 / unanswered end");
  });

  it("E3.09 / I3 control: running turn answers follow-up through API, no note", async () => {
    const { f, source } = await deferredFollowup();
    const headers = { ...await agentHeaders(f), "x-paperclip-run-id": source.id };
    const answer = await runtime.api<{ id: string; authorType: string; authorAgentId: string }>(`/issues/${f.issue.id}/comments`,
      { body: "Reviewed your follow-up: the requested result is complete." }, "POST", headers);
    expect(answer).toMatchObject({ authorType: "agent", authorAgentId: f.agent.id });
    const ended = new Date(Date.now() - 61_000);
    await db.update(issueComments).set({ createdAt: new Date(ended.getTime() - 1_000) }).where(eq(issueComments.id, answer.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: ended })
      .where(eq(heartbeatRuns.id, source.id));
    await sweep(f, 3);
    expect(await notes(f, "E3.09 / answered by already-running turn")).toHaveLength(0);
    expect(await runtime.comments(f.issue.id)).toHaveLength(2);
  });

  it("I3 / agent creates an interaction card through API: no note", async () => {
    const f = await seed();
    const source = await seedRun(f, "running");
    const headers = { ...await agentHeaders(f), "x-paperclip-run-id": source.id };
    const card = await runtime.api<{ id: string; createdByAgentId: string }>(`/issues/${f.issue.id}/interactions`, {
      kind: "ask_user_questions", resolverPolicy: "human_only",
      payload: { version: 1, questions: [{ id: "scope", prompt: "Which result should I deliver?",
        selectionMode: "single", options: [{ id: "full", label: "Full review" }, { id: "summary", label: "Summary" }] }] },
    }, "POST", headers);
    expect(card.createdByAgentId).toBe(f.agent.id);
    // Age the completed sequence coherently: request < card < terminal < due.
    const ended = new Date(Date.now() - 61_000);
    await db.update(issueThreadInteractions).set({ createdAt: new Date(ended.getTime() - 1_000) })
      .where(eq(issueThreadInteractions.id, card.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: ended }).where(eq(heartbeatRuns.id, source.id));
    const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
    expect(saved.createdAt.getTime()).toBeGreaterThan(f.request!.createdAt.getTime());
    expect(await runtime.comments(f.issue.id), "card is the only answer; no agent comment masks a card bug").toHaveLength(1);
    await sweep(f, 3);
    console.log("GUARDIAN_CARD", JSON.stringify(saved));
    expect(await notes(f, "I3 / answered with card")).toHaveLength(0);
  });

  it.each(["agent", "board-key agent", "system"] as const)("person-only / %s comment gets no note", async kind => {
    const f = await seed(false);
    let posted: { id: string; authorType: string | null };
    if (kind === "agent") {
      const source = await seedRun(f, "running");
      posted = await runtime.api(`/issues/${f.issue.id}/comments`, { body: "Agent-authored progress, not a person request." },
        "POST", { ...await agentHeaders(f), "x-paperclip-run-id": source.id });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(f.old.getTime() + 5_000) })
        .where(eq(heartbeatRuns.id, source.id));
    } else if (kind === "board-key agent") {
      // Host forbids authorType=agent for a board key (HTTP 422). Preserve its
      // real API-authored user-id provenance, then seed the closest persisted
      // agent shape. This is NOT proof the host can detect a disguised caller.
      const token = `guardian-board-fixture-${randomUUID()}`;
      await db.insert(boardApiKeys).values({ userId: "local-board", name: "Guardian board fixture",
        keyHash: createHash("sha256").update(token).digest("hex") });
      posted = await runtime.api(`/issues/${f.issue.id}/comments`, { body: "Agent progress via board key." },
        "POST", { authorization: `Bearer ${token}` });
      expect(posted.authorType).toBe("user");
      [posted] = await db.update(issueComments).set({ authorType: "agent", authorAgentId: f.agent.id })
        .where(eq(issueComments.id, posted.id)).returning();
    } else {
      [posted] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
        authorType: "system", body: "System progress, not a person request." }).returning();
    }
    expect(posted.authorType).toBe(kind === "system" ? "system" : "agent");
    await db.update(issueComments).set({ createdAt: f.old, updatedAt: f.old }).where(eq(issueComments.id, posted.id));
    await sweep(f, 3);
    const comments = await runtime.comments(f.issue.id);
    console.log("GUARDIAN_PERSON_ONLY", JSON.stringify({ kind, comments }));
    expect(comments.map(row => row.id)).toEqual([posted.id]);
    expect(comments.some(row => row.body.includes("conversation-guardian:"))).toBe(false);
  });

  it.each([true, false])("B′ / same comment = %s: suppress only the exact person-message notice", async same => {
    const f = await seed();
    let otherId = f.request!.id;
    if (!same) {
      // Real second person comment on the SAME issue; B′ covers that one only.
      const other = await runtime.api<{ id: string }>(`/issues/${f.issue.id}/comments`, { body: "A different request, already covered by B-prime." });
      otherId = other.id;
      await db.update(issueComments).set({ createdAt: f.old }).where(eq(issueComments.id, otherId));
    }
    const [bprime] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
      authorType: "system", body: "Core: your message is waiting; check the agent.",
      metadata: { version: 1, sections: [], authorizationReason: `unanswered_message:${otherId}` } }).returning();
    await sweep(f, 3);
    const comments = await runtime.comments(f.issue.id);
    const guardian = comments.filter(row => row.body.includes("conversation-guardian:"));
    console.log("GUARDIAN_BPRIME", JSON.stringify({ same, requestId: f.request!.id, bprime, comments }));
    expect(guardian).toHaveLength(same ? 0 : 1);
    if (!same) {
      expect(guardian[0].authorType).toBe("system");
      expect(guardian[0].body).toContain(`conversation-guardian:note:${f.request!.id}`);
      expect(guardian[0].body).not.toContain(`conversation-guardian:note:${otherId}`);
    }
  });

  it("I4 / racing triggers through real host: exactly one note", async () => {
    const f = await seed(true, false);
    await sweep(f, 0);
    // Config reload reconciles at startup. Arm a fresh request first so that
    // startup cannot post before the two racing jobs under test.
    f.old = new Date(Date.now() - 180_000);
    await db.update(issueComments).set({ createdAt: f.old }).where(eq(issueComments.id, f.request!.id));
    expect(await notes(f, "I4 / before racing triggers")).toHaveLength(0);
    const results = await Promise.all([0, 1].map(async () => {
      try { return { run: await runtime.runJob(pluginId) }; }
      catch (error) { return { error: String(error) }; }
    }));
    console.log("GUARDIAN_RACING_JOBS", JSON.stringify(results));
    // Host may reject the second trigger at its single-job admission guard.
    // That is not proof of overlapping plugin workers; keep the receipt explicit.
    expect(results.some(result => result.run?.status === "succeeded")).toBe(true);
    for (const result of results) if (result.error) expect(result.error).toMatch(/already running|no longer available/);
    await oneNote(f, "hasn't been picked up", "I4 / concurrent triggers");
  });

  it("I4 / mid-post worker restart: blocked real comment insert reconciles to at most one note", async () => {
    const f = await seed(true, false);
    await sweep(f, 0);
    f.old = new Date(Date.now() - 180_000);
    await db.update(issueComments).set({ createdAt: f.old }).where(eq(issueComments.id, f.request!.id));
    expect(await notes(f, "I4 / before mid-post trigger")).toHaveLength(0);
    if (!process.env.GUARDIAN_PLUGIN_PATH) {
      // The inert ABSENT worker cannot enter a post window. Still run the same
      // one-note delivery oracle; do not call a missing fault hit a behavior RED.
      await sweep(f);
      await runtime.restartWorker(pluginId);
      await runtime.runJob(pluginId);
      console.log("GUARDIAN_MIDPOST_WINDOW", "ABSENT: no post to interrupt");
      await oneNote(f, "hasn't been picked up", "I4 / absent mid-post control");
      return;
    }
    const name = `guardian_post_${randomUUID().replaceAll("-", "")}`;
    const lockClass = 194235, lockId = 1;
    let release = () => {};
    let acquired!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.issue_id = '${f.issue.id}'::uuid AND NEW.body LIKE '%conversation-guardian:note:%' THEN
        PERFORM pg_advisory_xact_lock(${lockClass}, ${lockId});
      END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON issue_comments FOR EACH ROW EXECUTE FUNCTION ${name}()`));
    const holding = db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockClass}, ${lockId})`);
      acquired();
      await gate;
    });
    void holding.catch(failed);
    try {
      await ready;
      await sweep(f, 0);
      const before = await runtime.dashboard(pluginId);
      const receipt = await runtime.triggerJob(pluginId);
      const blocked = await runtime.waitFor("real comment insert blocked before commit", () => db.execute<{ pid: number }>(sql`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = ${lockClass}::oid
          AND objid = ${lockId}::oid AND NOT granted`), rows => rows.length > 0);
      const running = (await runtime.jobRuns(pluginId)).find(run => run.id === receipt.runId);
      expect(running?.status).toBe("running");
      expect((await runtime.comments(f.issue.id)).filter(row => row.authorType === "system")).toHaveLength(0);
      console.log("GUARDIAN_MIDPOST_WINDOW", JSON.stringify({ blocked, running, worker: before.worker }));
      // Disable while the host comment RPC is blocked, not after a clean post.
      await runtime.api(`/plugins/${pluginId}/disable`, {});
      const stopped = await runtime.dashboard(pluginId);
      expect(stopped.worker?.status).not.toBe("running");
      release();
      await holding;
      await runtime.waitFor("old host insert settles", () => db.execute<{ pid: number }>(sql`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = ${lockClass}::oid
          AND objid = ${lockId}::oid AND NOT granted`), rows => rows.length === 0);
      await runtime.api(`/plugins/${pluginId}/enable`, {});
      const after = await runtime.waitFor("new worker after mid-post stop", () => runtime.dashboard(pluginId),
        value => value.worker?.status === "running" && !!value.worker.pid && value.worker.pid !== before.worker?.pid);
      await runtime.runJob(pluginId);
      await runtime.runJob(pluginId);
      console.log("GUARDIAN_MIDPOST_RECONCILED", JSON.stringify({ before, stopped, after,
        interruptedJob: await runtime.waitForJob(pluginId, receipt.runId), comments: await runtime.comments(f.issue.id) }));
      expect(await notes(f, "I4 / reconciled mid-post"), "no duplicate across the forced post/stop window").toHaveLength(1);
    } finally {
      release();
      await holding;
      await db.execute(sql.raw(`DROP TRIGGER ${name} ON issue_comments`));
      await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
    }
  }, 120_000);

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

    optedIn.add(company.id);
    await runtime.setCompanyConfig(pluginId, company.id, { enabled: true });
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
    // Assignment/lifecycle events own pickup. Guardian is enabled throughout;
    // exercise it during pickup and after the 180s observation, not just ABSENT.
    for (let tick = 0; tick <= 18; tick++) {
      await delay(Math.max(0, started + tick * 10_000 - Date.now()));
      if (tick === 0 || tick === 9 || tick === 18) await runtime.runJob(pluginId);
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
