import { randomUUID } from "node:crypto";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
  plugins, pluginCompanySettings, type Db,
} from "@paperclipai/db";
import type { PluginStatus } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { withConversationReadState } from "../agent-chat-read-state.js";

// Keep reason: durable wake data safety and the plugin identity trust boundary.
// Exercise normal release admission and persisted effects with real PostgreSQL;
// release stops at queueing, so no provider is dispatched by these tests.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Plugin wake DB checks unavailable: ${support.reason}`);
describe.skipIf(!support.supported)("plugin follow-up stopped at release", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-wake-stopped-");
    db = createDb(database.connectionString, { maxConnections: 6 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies, plugins restart identity cascade`); });

  async function seed() {
    const userId = `stopped-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Follow-up owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Follow-up regression", issuePrefix: "STP", defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue owner", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Pending follow-up", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "succeeded", runtimeMode: "native", nativeIssueId: issue.id,
      invocationSource: "assignment", startedAt: new Date(100), finishedAt: new Date(200), contextSnapshot: { issueId: issue.id } }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: source.id, companyId: company.id, issueId: issue.id, phase: "committed" });
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    const release = createReleaseIssueExecution({ issueLock: adapter,
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
    const drain = () => release({ companyId: company.id, runId: source.id, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true });
    return { company, agent, issue, source, userId, adapter, drain };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  async function plugin(status: PluginStatus, displayName = "Follow-up plugin") {
    const id = randomUUID(), pluginKey = `stopped.plugin.${id}`;
    const [p] = await db.insert(plugins).values({ id, pluginKey, packageName: pluginKey, version: "1.0.0", status,
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName, description: "Fixture", author: "Test", categories: ["automation"], capabilities: ["issues.wakeup"], entrypoints: { worker: "./worker.js" } } }).returning();
    return p;
  }
  type Plugin = Awaited<ReturnType<typeof plugin>>;
  async function receipt(f: Seed, p: Plugin, extra: Partial<typeof agentWakeupRequests.$inferInsert> = {}) {
    const [r] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "assignment", triggerDetail: "system",
      status: "deferred_issue_execution", requestedByActorType: "system", requestedByActorId: p.id,
      payload: { issueId: f.issue.id, mutation: "plugin_wakeup", pluginId: p.id, pluginKey: p.pluginKey,
        _paperclipWakeContext: { issueId: f.issue.id, taskId: f.issue.id, wakeReason: "plugin_issue_wakeup_requested", pluginId: p.id, pluginKey: p.pluginKey } }, ...extra }).returning();
    return r;
  }
  async function readReceipt(id: string) { return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]; }
  async function queued(f: Seed) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).filter(r => r.status === "queued"); }
  async function notes(f: Seed) { return db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id)); }
  async function wakes(f: Seed) { return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id)); }

  it.each([
    ["A", "upgrade_pending", "is waiting for an admin to approve its update"],
    ["B", "installed", "is still being set up"],
  ] as const)("%s: release cancels %s with exactly one explanatory system note", async (_case, status, wording) => {
    const f = await seed(), p = await plugin(status), r = await receipt(f, p);
    await f.drain();
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable", runId: null,
      finishedAt: expect.any(Date) });
    const comments = await notes(f);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ companyId: f.company.id, issueId: f.issue.id, authorType: "system",
      authorAgentId: null, authorUserId: null, createdByRunId: null,
      presentation: { kind: "system_notice", tone: "warning", title: "Plugin follow-up stopped", density: "compact" },
      metadata: { authorizationReason: `plugin_wakeup_stopped:${r.id}` },
      body: `Follow-up plugin ${wording}, so its follow-up here was stopped. [Plugin settings](/instance/settings/plugins/${p.id})` });
    expect(await queued(f)).toHaveLength(0);
  });

  it("C: a second release neither duplicates the note nor creates another wake or queued run", async () => {
    const f = await seed(), p = await plugin("upgrade_pending"), r = await receipt(f, p);
    await f.drain();
    const stopped = await readReceipt(r.id), firstNotes = await notes(f);
    await f.drain();
    expect(await readReceipt(r.id)).toEqual(stopped);
    expect(await notes(f)).toHaveLength(1);
    expect(await notes(f)).toEqual(firstNotes);
    expect(await wakes(f)).toHaveLength(1);
    expect(await queued(f)).toHaveLength(0);
  });

  it("D: concurrent drains commit exactly one cancellation and one note", async () => {
    const f = await seed(), p = await plugin("upgrade_pending"), r = await receipt(f, p);
    await Promise.all([f.drain(), f.drain()]);
    expect(await wakes(f)).toMatchObject([{ id: r.id, status: "cancelled", error: "plugin_wakeup_origin_unavailable" }]);
    expect(await notes(f)).toHaveLength(1);
    expect((await notes(f))[0].metadata).toEqual({ authorizationReason: `plugin_wakeup_stopped:${r.id}` });
    expect(await queued(f)).toHaveLength(0);
  });

  it.each(["disabled", "error", "uninstalled"] as const)("E: %s plugin is cancelled without a note", async status => {
    const f = await seed(), p = await plugin(status), r = await receipt(f, p);
    await f.drain();
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
    expect(await notes(f)).toHaveLength(0);
    expect(await queued(f)).toHaveLength(0);
  });

  it.each(["ready", "installed", "upgrade_pending"] as const)("E: company-disabled %s plugin is cancelled without a note", async status => {
    const f = await seed(), p = await plugin(status), r = await receipt(f, p);
    await db.insert(pluginCompanySettings).values({ pluginId: p.id, companyId: f.company.id, enabled: false });
    await f.drain();
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
    expect(await notes(f)).toHaveLength(0);
  });

  it.each(["missing", "wrong-key"] as const)("E: %s plugin stays on the existing cancellation path without a note", async kind => {
    const f = await seed(), p = await plugin("upgrade_pending"), r = await receipt(f, p);
    if (kind === "missing") await db.delete(plugins).where(eq(plugins.id, p.id));
    else await db.update(plugins).set({ pluginKey: "different.plugin" }).where(eq(plugins.id, p.id));
    await f.drain();
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
    expect(await notes(f)).toHaveLength(0);
  });

  it("F: ready plugin is promoted, not cancelled", async () => {
    const f = await seed(), p = await plugin("ready"), r = await receipt(f, p);
    await f.drain();
    expect(await queued(f)).toHaveLength(1);
    expect(await readReceipt(r.id)).toMatchObject({ status: "queued", error: null, runId: (await queued(f))[0].id });
    expect(await notes(f)).toHaveLength(0);
  });

  it("G: prior delivered event with the same idempotency key is coalesced", async () => {
    const f = await seed(), p = await plugin("ready");
    await receipt(f, p, { status: "completed", idempotencyKey: "event:1", runId: f.source.id, finishedAt: new Date() });
    const r = await receipt(f, p, { idempotencyKey: "event:1" });
    await f.drain();
    expect(await readReceipt(r.id)).toMatchObject({ status: "coalesced", error: "plugin_wakeup_already_delivered" });
    expect(await queued(f)).toHaveLength(0);
    expect(await notes(f)).toHaveLength(0);
  });

  it.each(["installed", "upgrade_pending"] as const)("H: ordinary assignment behind %s still promotes", async status => {
    const f = await seed(), p = await plugin(status);
    await receipt(f, p, { requestedAt: new Date(1000) });
    const [ordinary] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "assignment", reason: "issue_assigned",
      status: "deferred_issue_execution", payload: { issueId: f.issue.id, mutation: "assignment", _paperclipWakeContext: { issueId: f.issue.id, wakeReason: "issue_assigned" } } }).returning();
    await f.drain();
    expect(await readReceipt(ordinary.id)).toMatchObject({ status: "queued" });
    expect(await queued(f)).toHaveLength(1);
  });

  it.each(["installed", "upgrade_pending"] as const)("I: %s note is not an answer, unread message, or issue_commented wake", async status => {
    const f = await seed(), p = await plugin(status), r = await receipt(f, p);
    await f.drain();
    expect(await notes(f)).toHaveLength(1);
    expect(await withConversationReadState(db, f.company.id, f.userId, [f.issue])).toMatchObject([
      { isUnreadForMe: false, unreadMessageCount: 0, lastExternalCommentAt: null },
    ]);
    expect(await wakes(f)).toMatchObject([{ id: r.id, status: "cancelled" }]);
    expect(await wakes(f)).toHaveLength(1);
    expect(await queued(f)).toHaveLength(0);
    // Positive control: this same read model does count an actual agent answer.
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "agent", authorAgentId: f.agent.id, body: "An actual answer" });
    expect(await withConversationReadState(db, f.company.id, f.userId, [f.issue])).toMatchObject([
      { isUnreadForMe: true, unreadMessageCount: 1, lastExternalCommentAt: expect.anything() },
    ]);
  });

  it.each(["installed", "upgrade_pending"] as const)("uses pluginKey when %s displayName is blank", async status => {
    const f = await seed(), p = await plugin(status, "  ");
    await receipt(f, p);
    await f.drain();
    expect(await notes(f)).toHaveLength(1);
    expect((await notes(f))[0].body).toContain(`${p.pluginKey} is `);
  });

  it("guards a preexisting note by authorizationReason", async () => {
    const f = await seed(), p = await plugin("upgrade_pending"), r = await receipt(f, p);
    const [existing] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "system", body: "Already recorded",
      metadata: sql`${JSON.stringify({ authorizationReason: `plugin_wakeup_stopped:${r.id}` })}::jsonb` }).returning();
    await f.drain();
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
    expect(await notes(f)).toEqual([existing]);
  });

  it("rolls back the cancellation and note together", async () => {
    const f = await seed(), p = await plugin("upgrade_pending"), r = await receipt(f, p);
    await expect(f.adapter.withIssueExecutionLock({ companyId: f.company.id, runId: f.source.id, now: new Date() }, async (_locked, ports) => {
      await ports.transaction.findNextDeferredWake({ companyId: f.company.id, issueId: f.issue.id });
      throw new Error("abort release");
    })).rejects.toThrow("abort release");
    expect(await readReceipt(r.id)).toMatchObject({ status: "deferred_issue_execution", error: null });
    expect(await notes(f)).toHaveLength(0);
    await f.drain();
    expect(await readReceipt(r.id)).toMatchObject({ status: "cancelled", error: "plugin_wakeup_origin_unavailable" });
    expect(await notes(f)).toHaveLength(1);
  });
});
