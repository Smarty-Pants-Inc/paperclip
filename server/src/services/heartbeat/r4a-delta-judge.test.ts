import { randomUUID } from "node:crypto";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, nativeRunFinalizations,
  plugins, pluginCompanySettings, type Db,
} from "@paperclipai/db";
import type { PluginStatus } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies as callbacks } from "../../__tests__/helpers/heartbeat-queue.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createHeartbeatQueue } from "./queue.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { callbacks as runControlCallbacks } from "./__tests__/run-control-fixtures.js";
import { pluginLifecycleManager } from "../plugin-lifecycle.js";

// Independent persisted-input regression tests. Provider execution is held, while
// actual queue recovery, run-control, release admission and PostgreSQL are used.
// Keep reason: plugin identity trust boundary and durable wake data safety.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Judge DB checks unavailable: ${support.reason}`);
describe.skipIf(!support.supported)("R4-a delta independent judge", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("r4a-delta-independent");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function seed() {
    const userId = `judge-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Judge fixture", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Independent queue check", issuePrefix: "JDG", defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue owner", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Parked task", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
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
    return { company, agent, issue, source, queue, deps };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  async function plugin(status = "ready") {
    const id = randomUUID();
    const pluginKey = `judge.plugin.${id}`;
    const [p] = await db.insert(plugins).values({ id, pluginKey, packageName: pluginKey, version: "1.0.0", status: status as PluginStatus,
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Judge fixture", description: "Fixture", author: "Judge", categories: ["automation"], capabilities: ["issues.wakeup"], entrypoints: { worker: "./worker.js" } } }).returning();
    return p;
  }
  type Plugin = Awaited<ReturnType<typeof plugin>>;
  function payload(f: Seed, p: Plugin) {
    return { issueId: f.issue.id, mutation: "plugin_wakeup", pluginId: p.id, pluginKey: p.pluginKey,
      _paperclipWakeContext: { issueId: f.issue.id, taskId: f.issue.id, wakeReason: "plugin_issue_wakeup_requested", pluginId: p.id, pluginKey: p.pluginKey } };
  }
  async function receipt(f: Seed, p: Plugin, extra: Partial<typeof agentWakeupRequests.$inferInsert> = {}) {
    const [r] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "assignment", triggerDetail: "system",
      status: "deferred_issue_execution", requestedByActorType: "system", requestedByActorId: p.id, payload: payload(f, p), ...extra }).returning();
    return r;
  }
  async function readReceipt(id: string) { return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]; }
  async function queued(f: Seed) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).filter(r => r.status === "queued"); }
  async function delivered(f: Seed, p: Plugin, key: string, extra: Partial<typeof agentWakeupRequests.$inferInsert> = {}) {
    return receipt(f, p, { status: "completed", idempotencyKey: key, runId: f.source.id, finishedAt: new Date(), ...extra });
  }

  it("control: a ready plugin's own unconsumed event promotes exactly once across repeated sweeps", async () => {
    const f = await seed(), p = await plugin();
    const r = await receipt(f, p, { idempotencyKey: "event:1" });
    await f.queue.resumeQueuedRuns(); await f.queue.resumeQueuedRuns();
    expect(await queued(f)).toHaveLength(1);
    expect(await readReceipt(r.id)).toMatchObject({ status: "queued", runId: (await queued(f))[0].id });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["disabled", "uninstalled", "error"])("F1 control: isolated %s plugin receipt is cancelled", async status => {
    const f = await seed(), p = await plugin(status), r = await receipt(f, p);
    await f.queue.resumeQueuedRuns();
    expect(await queued(f)).toHaveLength(0);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
  });

  it("F1 control: company-disabled plugin receipt is cancelled", async () => {
    const f = await seed(), p = await plugin();
    await db.insert(pluginCompanySettings).values({ pluginId: p.id, companyId: f.company.id, enabled: false });
    const r = await receipt(f, p);
    await f.queue.resumeQueuedRuns();
    expect(await queued(f)).toHaveLength(0);
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
  });

  it("F1: validating one ready receipt must not promote an older disabled plugin's receipt", async () => {
    const f = await seed(), disabled = await plugin("disabled"), ready = await plugin();
    // Sweep order is updatedAt, but release admission selects requestedAt.
    const blocked = await receipt(f, disabled, { requestedAt: new Date(1000), updatedAt: new Date(3000) });
    await receipt(f, ready, { requestedAt: new Date(2000), updatedAt: new Date(0) });
    await f.queue.resumeQueuedRuns();
    const runs = await queued(f);
    console.log("JUDGE F1 mixed", JSON.stringify({ blocked: await readReceipt(blocked.id), queued: runs.map(r => ({ id: r.id, pluginId: r.contextSnapshot?.pluginId })) }));
    expect(await readReceipt(blocked.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
    expect(runs.every(r => r.contextSnapshot?.pluginId !== disabled.id)).toBe(true);
  });

  it("F1: a wake held during upgrade_pending must survive enable and a second sweep", async () => {
    const f = await seed(), p = await plugin();
    const r = await receipt(f, p, { idempotencyKey: "pre-upgrade-event" });
    const lifecycle = pluginLifecycleManager(db);
    await lifecycle.markUpgradePending(p.id);
    expect((await db.select().from(plugins).where(eq(plugins.id, p.id)))[0].status).toBe("upgrade_pending");
    await f.queue.resumeQueuedRuns();
    const during = await readReceipt(r.id);
    expect(await queued(f)).toHaveLength(0);
    await lifecycle.enable(p.id);
    expect((await db.select().from(plugins).where(eq(plugins.id, p.id)))[0].status).toBe("ready");
    await f.queue.resumeQueuedRuns();
    console.log("JUDGE F1 upgrade", JSON.stringify({ during, after: await readReceipt(r.id), queued: (await queued(f)).length }));
    expect(await queued(f)).toHaveLength(1);
    expect(await readReceipt(r.id)).toMatchObject({ status: "queued" });
  });

  it.each(["timer mutation", "foreign requester", "context key mismatch"])("F2 control: %s does not newly qualify", async kind => {
    const f = await seed(), p = await plugin();
    const data = payload(f, p);
    if (kind === "timer mutation") data.mutation = "timer";
    if (kind === "context key mismatch") data._paperclipWakeContext.pluginKey = "some-other-plugin";
    const r = await receipt(f, p, { payload: data, ...(kind === "foreign requester" ? { requestedByActorId: randomUUID() } : {}) });
    await f.queue.resumeQueuedRuns();
    expect(await queued(f)).toHaveLength(0);
    expect(await readReceipt(r.id)).toMatchObject({ status: "deferred_issue_execution" });
  });

  it("F3 control: the SAME plugin and SAME event key coalesces", async () => {
    const f = await seed(), p = await plugin();
    await delivered(f, p, "event:1");
    const r = await receipt(f, p, { idempotencyKey: "event:1" });
    await f.queue.resumeQueuedRuns();
    expect(await queued(f)).toHaveLength(0);
    expect(await readReceipt(r.id)).toMatchObject({ status: "coalesced", error: "plugin_wakeup_already_delivered" });
  });

  it("F3 control: DIFFERENT event keys from the same plugin are not dropped", async () => {
    const f = await seed(), p = await plugin();
    await delivered(f, p, "event:1");
    const r = await receipt(f, p, { idempotencyKey: "event:2" });
    await f.queue.resumeQueuedRuns();
    expect(await queued(f)).toHaveLength(1);
    expect(await readReceipt(r.id)).toMatchObject({ status: "queued" });
  });

  it.each(["another plugin", "non-plugin caller"])("F3: the same raw key used by %s must not consume this plugin's DIFFERENT event", async kind => {
    const f = await seed(), own = await plugin(), other = await plugin();
    await delivered(f, other, "event:1", kind === "non-plugin caller" ? {
      requestedByActorType: "user", requestedByActorId: "unrelated-user", payload: { issueId: f.issue.id, mutation: "update" },
    } : {});
    const r = await receipt(f, own, { idempotencyKey: "event:1" });
    await f.queue.resumeQueuedRuns();
    console.log("JUDGE F3 collision", JSON.stringify({ kind, receipt: await readReceipt(r.id), queued: (await queued(f)).length }));
    expect(await queued(f)).toHaveLength(1);
    expect(await readReceipt(r.id)).toMatchObject({ status: "queued" });
  });

  it("F3: a new event's sweep must not release an older already-delivered event", async () => {
    const f = await seed(), p = await plugin();
    await delivered(f, p, "event:1");
    const duplicate = await receipt(f, p, { idempotencyKey: "event:1", requestedAt: new Date(1000), updatedAt: new Date(3000) });
    const fresh = await receipt(f, p, { idempotencyKey: "event:2", requestedAt: new Date(2000), updatedAt: new Date(0) });
    await f.queue.resumeQueuedRuns();
    console.log("JUDGE F3 mixed", JSON.stringify({ duplicate: await readReceipt(duplicate.id), fresh: await readReceipt(fresh.id) }));
    expect(await readReceipt(duplicate.id)).toMatchObject({ status: "coalesced", error: "plugin_wakeup_already_delivered" });
    expect(await readReceipt(fresh.id)).toMatchObject({ status: "queued" });
  });
});
