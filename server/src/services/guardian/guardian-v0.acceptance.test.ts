import { randomUUID } from "node:crypto";
import {
  agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueComments, issues, type Db,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { GUARDIAN_PLUGIN_ID, startRealPluginLoader } from "../../__tests__/helpers/plugin-real-loader.js";
import { createAgentLifecycle } from "../agent-lifecycle.js";

// Keep reason: real loader/RPC/DB trust boundary plus RFL R6-STRAND's persisted
// parked-task failure. These are ordinary failing tests, NOT it.fails/expected failures.
// SQL builds stuck states; the person posts and reads through the real board API.
// No provider is called: the agent's ordinary wake-on-demand setting is disabled.
describe("conversation guardian v0 — real server + Postgres", () => {
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
    // Build RFL's parked lifecycle before starting the app's lifecycle worker;
    // it must never race Pause/Resume while the saved Stop failure is incomplete.
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
    // This pinned host predates R6's Stop retryRequired guard: its unrelated
    // lifecycle worker would consume the saved pausing state on app startup.
    // Hold ONLY that agent's row against mutation. Normal MVCC reads (including
    // the actual plugin RPC) see RFL's committed seed unchanged. No extra lease,
    // retry date, hold, fake worker, or guardian-specific state is introduced.
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

  it("8 / R6-STRAND F1 / REQUEST-SCOPE: no-comment todo parked behind failed Stop gets Retry notice", async () => {
    // RFL judge-r6-strand.test.ts:155-183: Pause -> Resume, then the saved
    // terminal Stop-budget result (seeded before app startup in beforeAll).
    const f = parkedFixture;
    expect(await runtime.comments(f.issue.id)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(0);
    await sweep(f);
    const rows = await notes(f, "8 / parked Stop");
    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    const [agentAfter] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    console.log("GUARDIAN_PARKED", JSON.stringify({ issueStatus: issueAfter.status, assigneeAgentId: issueAfter.assigneeAgentId,
      lifecycleState: agentAfter.lifecycleState, lifecycleHolds: agentAfter.lifecycleHolds, lifecycleOperation: agentAfter.lifecycleOperation }));
    expect(issueAfter).toMatchObject({ status: "todo", assigneeAgentId: f.agent.id });
    expect(agentAfter).toMatchObject({ lifecycleState: "pausing", lifecycleHolds: [], lifecycleOperation: { retryRequired: true, stopFailures: 5 } });
    expect(rows).toHaveLength(1);
    expect(rows[0].authorAgentId).toBeNull();
    expect(rows[0].authorUserId).toBeNull();
    expect(rows[0].body).toContain("conversation-guardian:");
    expect(rows[0].body).toMatch(/stop/i);
    expect(rows[0].body).toMatch(/failed|failure|incomplete|stuck/i);
    expect(rows[0].body).toContain("5");
    expect(rows[0].body).toContain("Retry");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
