import { randomUUID } from "node:crypto";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
  plugins, pluginCompanySettings, pluginLogs, type Db,
} from "@paperclipai/db";
import type { PluginStatus } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies as callbacks } from "../../__tests__/helpers/heartbeat-queue.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createHeartbeatQueue } from "./queue.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { callbacks as runControlCallbacks } from "./__tests__/run-control-fixtures.js";
import { pluginRegistryService } from "../plugin-registry.js";
import { registerDeferredReceiptWork } from "./deferred-receipt-work.js";
import type { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { DeferredExecutionScope } from "../deferred-execution-notifications.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { withConversationReadState } from "../agent-chat-read-state.js";

type Entry = { id: string; companyId: string; dueAt: number; immediate: boolean };
type Options = Parameters<typeof registerScopedDeadlineWork<Entry, DeferredExecutionScope>>[1];
const registered = vi.hoisted(() => new Map<string, Options>());
// Capture the existing deadline owner's load/check boundary, not its SQL or
// recovery implementation. Provider dispatch stays off; queue, release admission,
// transactions and persisted effects are real. Keep reason: durable wake data
// safety and a 30-minute failure path that a live flow cannot reach cheaply.
vi.mock("../scoped-deadline-work.js", () => ({
  registerScopedDeadlineWork: (_coordinator: unknown, options: Options) => {
    registered.set(options.queue, options);
    return { ready: Promise.resolve(), refresh() {}, invalidate() {}, async stop() {} };
  },
}));

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Plugin hold DB checks unavailable: ${support.reason}`);
describe.skipIf(!support.supported)("plugin wake hold deadline", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-wake-hold-");
    db = createDb(database.connectionString, { maxConnections: 6 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies, plugins restart identity cascade`);
    registered.clear();
  });

  async function seed() {
    const userId = `hold-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Hold owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Hold regression", issuePrefix: "HLD", defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue owner", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Quiet task", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "succeeded", runtimeMode: "native", nativeIssueId: issue.id,
      invocationSource: "assignment", startedAt: new Date(100), finishedAt: new Date(200), contextSnapshot: { issueId: issue.id } }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: source.id, companyId: company.id, issueId: issue.id, phase: "committed" });
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.canStartNewExternalBotWork.mockResolvedValue(false);
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
    const controls = runControlCallbacks(db);
    vi.mocked(controls.wakeQueue.releaseIssueExecution).mockImplementation(release);
    deps.releaseIssueExecutionAndPromote.mockImplementation(createHeartbeatRunControl(db, controls).releaseIssueExecutionAndPromote);
    const queue = createHeartbeatQueue(db, deps);
    registerDeferredReceiptWork(db, {} as Parameters<typeof registerDeferredReceiptWork>[1], {
      resume: queue.resumeDeferredExecutionReceipts,
      settleTaskChat: async () => undefined,
      createNativeBatch: () => async () => undefined,
      schedulingSuppressed: async () => false,
    }, () => true);
    const worker = registered.get(DELIVERY_QUEUES.deferredExecutionReceipts)!;
    await worker.beforePass?.();
    return { company, agent, issue, source, queue, deps, worker, userId };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  async function plugin(status: PluginStatus, minutes: number, transition = true) {
    const id = randomUUID(), pluginKey = `hold.plugin.${id}`;
    const entered = new Date(Date.now() - minutes * 60_000);
    const [p] = await db.insert(plugins).values({ id, pluginKey, packageName: pluginKey, version: "1.0.0", status, updatedAt: entered,
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Follow-up plugin", description: "Fixture", author: "Test", categories: ["automation"], capabilities: ["issues.wakeup"], entrypoints: { worker: "./worker.js" } } }).returning();
    if (transition) await db.insert(pluginLogs).values({ pluginId: id, companyId: null, level: "info", message: `status → ${status}`,
      meta: { kind: "status_transition", from: "ready", to: status }, createdAt: entered });
    return p;
  }
  type Plugin = Awaited<ReturnType<typeof plugin>>;
  async function receipt(f: Seed, p: Plugin) {
    const [r] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "assignment", triggerDetail: "system",
      status: "deferred_issue_execution", requestedByActorType: "system", requestedByActorId: p.id,
      payload: { issueId: f.issue.id, mutation: "plugin_wakeup", pluginId: p.id, pluginKey: p.pluginKey,
        _paperclipWakeContext: { issueId: f.issue.id, taskId: f.issue.id, wakeReason: "plugin_issue_wakeup_requested", pluginId: p.id, pluginKey: p.pluginKey } } }).returning();
    return r;
  }
  async function readReceipt(id: string) { return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]; }
  async function queued(f: Seed) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).filter(r => r.status === "queued"); }
  async function entries(f: Seed) {
    const loaded = await f.worker.load({ companyId: f.company.id });
    return Array.isArray(loaded) ? loaded : loaded.rows ?? [];
  }
  async function check(f: Seed, r: { id: string }) {
    return f.worker.check({ id: r.id, companyId: f.company.id, dueAt: Date.now(), immediate: true });
  }
  async function transitions(p: Plugin) {
    return db.select().from(pluginLogs).where(and(eq(pluginLogs.pluginId, p.id), sql`${pluginLogs.meta}->>'kind' = 'status_transition'`))
      .orderBy(pluginLogs.createdAt);
  }

  it.each(["upgrade_pending", "installed"] as const)("a/b: one worker check expires a quiet %s wake entered 31 min ago", async status => {
    const f = await seed(), p = await plugin(status, 31), r = await receipt(f, p);
    await check(f, r);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_hold_expired" });
    expect(await queued(f)).toHaveLength(0);
  });
  it("a-load: startup reconstructs the quiet expired plugin receipt without a new event", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31), r = await receipt(f, p);
    const entry = (await entries(f)).find(e => e.id === r.id);
    expect(entry).toMatchObject({ id: r.id, immediate: true });
    await f.worker.check(entry!);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_hold_expired" });
  });
  it("c-control: a five-minute pending wake stays deferred", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 5), r = await receipt(f, p);
    await check(f, r);
    expect(await readReceipt(r.id)).toMatchObject({ status: "deferred_issue_execution" });
  });
  it("c-deadline: load and check retain entered + 30 min as the next due time", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 5), r = await receipt(f, p);
    const expected = p.updatedAt.getTime() + 30 * 60_000;
    expect((await entries(f)).find(e => e.id === r.id)).toMatchObject({ dueAt: expected, immediate: false });
    expect(await check(f, r)).toMatchObject({ dueAt: expected, immediate: false });
  });
  it("c-prime: an unrelated updated_at bump cannot extend the transition's expired hold", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31), r = await receipt(f, p);
    await db.update(plugins).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(plugins.id, p.id));
    await check(f, r);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_hold_expired" });
  });
  it("d: an ordinary assignment behind a held plugin wake is still promoted", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 5), r = await receipt(f, p);
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(1000) }).where(eq(agentWakeupRequests.id, r.id));
    const [ordinary] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "assignment", reason: "issue_assigned",
      status: "deferred_issue_execution", payload: { issueId: f.issue.id, mutation: "assignment", _paperclipWakeContext: { issueId: f.issue.id, wakeReason: "issue_assigned" } } }).returning();
    await f.queue.resumeQueuedRuns();
    expect(await readReceipt(ordinary.id)).toMatchObject({ status: "queued" });
    expect(await readReceipt(r.id)).toMatchObject({ status: "deferred_issue_execution" });
    expect(await queued(f)).toHaveLength(1);
  });
  it("e: ready within the window promotes rather than cancelling", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 5), r = await receipt(f, p);
    await check(f, r);
    await pluginRegistryService(db).updateStatus(p.id, { status: "ready" });
    expect((await entries(f)).find(e => e.id === r.id)).toMatchObject({ immediate: true });
    await check(f, r);
    expect(await readReceipt(r.id)).toMatchObject({ status: "queued", error: null });
    expect(await queued(f)).toHaveLength(1);
  });
  it("f: timeout writes exactly one system note and no answer or agent wake, even on a second pass", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31), r = await receipt(f, p);
    await check(f, r); await check(f, r);
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ authorType: "system", authorAgentId: null, authorUserId: null, createdByRunId: null,
      presentation: { kind: "system_notice" }, metadata: { authorizationReason: `plugin_wake_hold_expired:${r.id}` },
      body: `Follow-up plugin couldn't continue here: it has been waiting 31 min for an admin to approve its update, so its follow-up was stopped. [Plugin settings](/instance/settings/plugins/${p.id})` });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id))).toHaveLength(1);
    expect(await queued(f)).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    expect(await withConversationReadState(db, f.company.id, f.userId, [f.issue])).toMatchObject([
      { isUnreadForMe: false, unreadMessageCount: 0, lastExternalCommentAt: null },
    ]);
  });
  it("f-concurrent: concurrent worker checks commit only one cancellation and notice", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31), r = await receipt(f, p);
    await Promise.all([check(f, r), check(f, r)]);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_hold_expired" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id))).toHaveLength(1);
  });
  it("f-guard: a preexisting authorization reason is not inserted again", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31), r = await receipt(f, p);
    const [existing] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
      authorType: "system", body: "Already recorded",
      metadata: sql`${JSON.stringify({ authorizationReason: `plugin_wake_hold_expired:${r.id}` })}::jsonb` }).returning();
    await check(f, r);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_hold_expired" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toMatchObject([{ id: existing.id }]);
  });
  it("f-rollback: timeout cancellation and its system note roll back together", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31), r = await receipt(f, p);
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => f.userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    await expect(adapter.withIssueExecutionLock({ companyId: f.company.id, runId: f.source.id, now: new Date() }, async (_locked, ports) => {
      await ports.transaction.findNextDeferredWake({ companyId: f.company.id, issueId: f.issue.id });
      throw new Error("abort release");
    })).rejects.toThrow("abort release");
    expect(await readReceipt(r.id)).toMatchObject({ status: "deferred_issue_execution", error: null });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(0);
    await check(f, r);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_hold_expired" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(1);
  });
  it("g: missing transition backfills the old timestamp and expires", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31, false), r = await receipt(f, p);
    await check(f, r);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_hold_expired" });
    const rows = await transitions(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: null, createdAt: p.updatedAt, meta: { kind: "status_transition", from: null, to: p.status, backfilled: true } });
  });
  it("g2: backfill fixes a young hold's deadline across unrelated updated_at bumps", async () => {
    const f = await seed(), p = await plugin("installed", 5, false), r = await receipt(f, p);
    const expected = p.updatedAt.getTime() + 30 * 60_000;
    expect((await entries(f)).find(e => e.id === r.id)).toMatchObject({ dueAt: expected });
    expect(await transitions(p)).toHaveLength(1);
    await db.update(plugins).set({ updatedAt: new Date() }).where(eq(plugins.id, p.id));
    expect((await entries(f)).find(e => e.id === r.id)).toMatchObject({ dueAt: expected });
    expect(await check(f, r)).toMatchObject({ dueAt: expected });
    expect(await readReceipt(r.id)).toMatchObject({ status: "deferred_issue_execution" });
    expect(await transitions(p)).toHaveLength(1);
  });
  it("g2-concurrent: concurrent loads backfill exactly once", async () => {
    const f = await seed(), p = await plugin("installed", 5, false), r = await receipt(f, p);
    const loads = await Promise.all([entries(f), entries(f)]);
    for (const rows of loads) expect(rows.find(e => e.id === r.id)).toMatchObject({ dueAt: p.updatedAt.getTime() + 30 * 60_000 });
    expect(await transitions(p)).toHaveLength(1);
  });
  it("latest: use the latest matching transition, not another status or updated_at", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31), r = await receipt(f, p);
    const latest = new Date(Date.now() - 5 * 60_000);
    await db.insert(pluginLogs).values([
      { pluginId: p.id, message: "status → upgrade_pending", meta: { kind: "status_transition", from: "ready", to: p.status }, createdAt: latest },
      { pluginId: p.id, message: "different status", meta: { kind: "status_transition", from: "installed", to: "ready" }, createdAt: new Date() },
    ]);
    await db.update(plugins).set({ updatedAt: new Date() }).where(eq(plugins.id, p.id));
    expect(await check(f, r)).toMatchObject({ dueAt: latest.getTime() + 30 * 60_000, immediate: false });
    expect(await readReceipt(r.id)).toMatchObject({ status: "deferred_issue_execution" });
  });
  it("h: updateStatus logs one real transition and none for an unchanged status", async () => {
    const p = await plugin("ready", 0, false), registry = pluginRegistryService(db);
    await registry.updateStatus(p.id, { status: "upgrade_pending" });
    await registry.updateStatus(p.id, { status: "upgrade_pending", lastError: "same state" });
    const rows = await transitions(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: null, level: "info", message: "status → upgrade_pending", meta: { kind: "status_transition", from: "ready", to: "upgrade_pending" } });
  });
  it("writers: update and conditional status writes log only successful changes", async () => {
    const p = await plugin("ready", 0, false), registry = pluginRegistryService(db);
    await registry.update(p.id, { status: "upgrade_pending" });
    await registry.update(p.id, { version: "2.0.0" });
    expect(await registry.updateStatusIf(p.id, { status: "ready" }, { status: "error" })).toBeNull();
    await registry.updateStatusIf(p.id, { status: "upgrade_pending" }, { status: "installed" });
    await registry.updateStatusIf(p.id, { status: "installed" }, { status: "installed" });
    const rows = await transitions(p);
    expect(rows.map(r => r.meta)).toEqual([
      { kind: "status_transition", from: "ready", to: "upgrade_pending" },
      { kind: "status_transition", from: "upgrade_pending", to: "installed" },
    ]);
  });
  it("writers: install, soft uninstall and reinstall each record their actual transition", async () => {
    const p = await plugin("ready", 0, false), registry = pluginRegistryService(db);
    await db.delete(plugins).where(eq(plugins.id, p.id));
    const installed = (await registry.install({ packageName: p.packageName }, p.manifestJson))!;
    await registry.install({ packageName: p.packageName }, p.manifestJson, { idempotent: true });
    await registry.uninstall(installed.id);
    await registry.install({ packageName: p.packageName }, p.manifestJson);
    expect((await transitions(installed)).map(r => r.meta)).toEqual([
      { kind: "status_transition", from: null, to: "installed" },
      { kind: "status_transition", from: "installed", to: "uninstalled" },
      { kind: "status_transition", from: "uninstalled", to: "installed" },
    ]);
  });
  it("writers-concurrent: concurrent same-status writes record only one transition", async () => {
    const p = await plugin("ready", 0, false), registry = pluginRegistryService(db);
    await Promise.all([registry.updateStatus(p.id, { status: "upgrade_pending" }), registry.updateStatus(p.id, { status: "upgrade_pending" })]);
    expect(await transitions(p)).toMatchObject([{ meta: { from: "ready", to: "upgrade_pending" } }]);
  });
  it("writers-rollback: a rolled-back change leaves no transition and a failed error-prefix CAS logs nothing", async () => {
    const p = await plugin("ready", 0, false), registry = pluginRegistryService(db);
    expect(await registry.updateStatusIf(p.id, { status: "ready", lastErrorPrefix: "missing" }, { status: "upgrade_pending" })).toBeNull();
    expect(await transitions(p)).toHaveLength(0);
    await expect(db.transaction(async tx => {
      await pluginRegistryService(tx as unknown as Db).updateStatus(p.id, { status: "upgrade_pending" });
      throw new Error("abort status");
    })).rejects.toThrow("abort status");
    expect(await registry.getById(p.id)).toMatchObject({ status: "ready" });
    expect(await transitions(p)).toHaveLength(0);
  });
  it("disabled: even an old pending plugin uses the unchanged unavailable cancellation without a timeout note", async () => {
    const f = await seed(), p = await plugin("upgrade_pending", 31), r = await receipt(f, p);
    await db.insert(pluginCompanySettings).values({ pluginId: p.id, companyId: f.company.id, enabled: false });
    expect((await entries(f)).find(e => e.id === r.id)).toMatchObject({ immediate: true });
    await check(f, r);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
    expect(await db.select().from(issueComments)).toHaveLength(0);
  });
});
