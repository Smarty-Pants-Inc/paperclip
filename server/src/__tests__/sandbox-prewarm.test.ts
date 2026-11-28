import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, environmentLeases, environments, heartbeatRuns, issueComments, issues, issueTreeHolds, plugins } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { prewarmIssueSandbox } from "../services/sandbox-prewarm.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres, type BoardActor } from "./helpers/route-test-harness.js";

// Keep reason: issue/agent/company isolation and no-acquisition guards on speculative provider work.
describeEmbeddedPostgres("sandbox prewarm", () => {
  const ctx = useEmbeddedPostgres("paperclip-sandbox-prewarm-");
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_SANDBOX_PREWARM", "true");
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  async function seed(status = "released") {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Prewarm");
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: randomUUID(), role: "engineer", adapterType: "process" }).returning();
    const [issue] = await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Prewarm task", assigneeAgentId: agent!.id }).returning();
    await ctx.db.insert(issueComments).values({ companyId: f.companyId, issueId: issue!.id,
      authorType: "user", authorUserId: f.userId, body: "A person chats in this task." });
    const [environment] = await ctx.db.insert(environments).values({ name: randomUUID(), driver: "sandbox",
      config: { provider: "prewarm-test", reuseLease: true, timeoutMs: 300_000 } }).returning();
    const [run] = await ctx.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id,
      issueId: issue!.id, status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: issue!.id } }).returning();
    const pluginId = randomUUID();
    await ctx.db.insert(plugins).values({ id: pluginId, pluginKey: `prewarm-${pluginId}`, packageName: "@test/prewarm",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", manifestJson: {
        id: `prewarm-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Prewarm test", description: "Test provider",
        author: "Test", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "prewarm-test", kind: "sandbox_provider", displayName: "Test", supportsReusableLeases: true, configSchema: { type: "object" } }],
      } });
    const [lease] = await ctx.db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: environment!.id,
      issueId: issue!.id, heartbeatRunId: run!.id, status, leasePolicy: "reuse_by_environment", provider: "prewarm-test",
      providerLeaseId: randomUUID(), releasedAt: new Date(), metadata: { agentId: agent!.id, driver: "sandbox",
        sandboxProviderPlugin: true, pluginId, provider: "prewarm-test", reuseLease: true, timeoutMs: 300_000, remoteCwd: "/workspace/task" } }).returning();
    // Only the provider boundary is fake. Selection, resumeRunLease, config resolution and PG writes are real.
    const call = vi.fn(async (_pluginId: string, method: string, params: { providerLeaseId: string }) => {
      if (method !== "environmentResumeLease") throw new Error(`Forbidden speculative operation: ${method}`);
      return { providerLeaseId: params.providerLeaseId, metadata: {} };
    });
    const workerManager = { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager;
    const input = { db: ctx.db, companyId: f.companyId, issueId: issue!.id, agentId: agent!.id,
      actor: { actorType: "user" as const, actorId: f.userId }, environmentRuntime: environmentRuntimeService(ctx.db, { pluginWorkerManager: workerManager }) };
    return { ...f, input, issue: issue!, agent: agent!, environment: environment!, lease: lease!, run: run!, pluginId, workerManager, call };
  }

  function app(actor: BoardActor | Express.Request["actor"], workerManager?: PluginWorkerManager) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor as Express.Request["actor"]; next(); });
    result.use("/api", issueRoutes(ctx.db, {} as never, { pluginWorkerManager: workerManager }));
    result.use(errorHandler);
    return result;
  }

  it.each(["released", "retained"])("resumes the newest %s reusable lease through the exact lifecycle road without changing ownership", async status => {
    const f = await seed(status);
    const old = new Date(Date.now() - 60_000);
    await ctx.db.insert(environmentLeases).values({ ...f.lease, id: randomUUID(), providerLeaseId: "older-box", lastUsedAt: old, createdAt: old });
    const before = await ctx.db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId));
    expect(await prewarmIssueSandbox(f.input)).toMatchObject({ outcome: "resumed", ms: expect.any(Number) });
    expect(f.call).toHaveBeenCalledExactlyOnceWith(f.pluginId, "environmentResumeLease", expect.objectContaining({
      companyId: f.companyId, environmentId: f.environment.id, issueId: f.issue.id,
      providerLeaseId: f.lease.providerLeaseId, leaseStatus: status, requestedCwd: "/workspace/task",
      lastRun: expect.objectContaining({ id: f.run.id, status: "succeeded" }),
    }), 60_000);
    expect(await ctx.db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toEqual(before);
    expect(await ctx.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await ctx.db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual([
      expect.objectContaining({ action: "environment.sandbox_prewarmed", actorId: f.userId, entityId: f.lease.id }),
    ]);
  });

  it("skips an issue with no reusable lease", async () => {
    const f = await seed();
    await ctx.db.delete(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(await prewarmIssueSandbox(f.input)).toEqual({ outcome: "skipped", reason: "no_reusable_lease" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["running", "queued", "scheduled_retry"])("skips while any agent has a %s run of the issue", async status => {
    const f = await seed();
    const [otherAgent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Other", role: "engineer", adapterType: "process" }).returning();
    await ctx.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: otherAgent!.id, issueId: f.issue.id, status });
    expect(await prewarmIssueSandbox(f.input)).toEqual({ outcome: "skipped", reason: "live_run" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["issue", "agent", "company"])("never touches another %s's lease", async scope => {
    const f = await seed();
    const input = { ...f.input, ...(scope === "issue" ? { issueId: randomUUID() }
      : scope === "agent" ? { agentId: randomUUID() } : { companyId: randomUUID() }) };
    expect(await prewarmIssueSandbox(input)).toEqual({ outcome: "skipped", reason: "no_reusable_lease" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["reusableSandboxKeptAfterReplacement", "abandonedWorkspaceFilesParked"])("preserves the run-start %s exclusion", async marker => {
    const f = await seed();
    await ctx.db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, [marker]: {} } }).where(eq(environmentLeases.id, f.lease.id));
    expect(await prewarmIssueSandbox(f.input)).toEqual({ outcome: "skipped", reason: "no_reusable_lease" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("ignores newer leases for another task or agent while resuming this task's own box", async () => {
    const f = await seed();
    const [otherIssue] = await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
    const newer = new Date(Date.now() + 60_000);
    await ctx.db.insert(environmentLeases).values([
      { ...f.lease, id: randomUUID(), issueId: otherIssue!.id, providerLeaseId: "other-task-box", lastUsedAt: newer },
      { ...f.lease, id: randomUUID(), metadata: { ...f.lease.metadata, agentId: randomUUID() }, providerLeaseId: "other-agent-box", lastUsedAt: newer },
    ]);
    const before = await ctx.db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId));
    expect(await prewarmIssueSandbox(f.input)).toMatchObject({ outcome: "resumed" });
    expect(f.call).toHaveBeenCalledExactlyOnceWith(f.pluginId, "environmentResumeLease",
      expect.objectContaining({ providerLeaseId: f.lease.providerLeaseId }), 60_000);
    expect(await ctx.db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toEqual(before);
  });

  it.each(["active", "pending_cleanup", "failed", "expired"])("does not resume a %s lease", async status => {
    const f = await seed(status);
    expect(await prewarmIssueSandbox(f.input)).toEqual({ outcome: "skipped", reason: "no_reusable_lease" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["ephemeral", "retain_on_failure"])("does not resume a %s policy", async leasePolicy => {
    const f = await seed();
    await ctx.db.update(environmentLeases).set({ leasePolicy }).where(eq(environmentLeases.id, f.lease.id));
    expect(await prewarmIssueSandbox(f.input)).toEqual({ outcome: "skipped", reason: "no_reusable_lease" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("ignores repeats within 60 seconds, then permits a new readiness hint", async () => {
    const f = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await prewarmIssueSandbox(f.input)).toMatchObject({ outcome: "resumed" });
    vi.setSystemTime(Date.now() + 59_999);
    expect(await prewarmIssueSandbox(f.input)).toEqual({ outcome: "skipped", reason: "cooldown" });
    vi.setSystemTime(Date.now() + 1);
    expect(await prewarmIssueSandbox(f.input)).toMatchObject({ outcome: "resumed" });
    expect(f.call).toHaveBeenCalledTimes(2);
  });

  it("keeps a single in-flight resume even after the cooldown has elapsed", async () => {
    const f = await seed();
    let finish!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.call.mockImplementation(async () => { entered(); await held; return { providerLeaseId: f.lease.providerLeaseId!, metadata: {} }; });
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = prewarmIssueSandbox(f.input);
    try {
      await started;
      vi.setSystemTime(Date.now() + 60_001);
      expect(await prewarmIssueSandbox(f.input)).toEqual({ outcome: "skipped", reason: "in_flight" });
      expect(f.call).toHaveBeenCalledOnce();
    } finally { finish(); await first; }
  });

  it("returns failed without replacement or lease ownership writes when the provider refuses resume", async () => {
    const f = await seed();
    f.call.mockRejectedValue(new Error("Provider refused"));
    expect(await prewarmIssueSandbox(f.input)).toMatchObject({ outcome: "failed", ms: expect.any(Number) });
    expect(f.call).toHaveBeenCalledOnce();
    expect(await ctx.db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id))).toEqual([f.lease]);
  });

  it.each([undefined, "false", "TRUE", "1"])("is off unless the switch is exactly true (%s)", async value => {
    const f = await seed();
    vi.stubEnv("PAPERCLIP_SANDBOX_PREWARM", value);
    expect(await prewarmIssueSandbox(f.input)).toEqual({ outcome: "skipped", reason: "disabled" });
    await request(app(f.actor, f.workerManager)).post(`/api/issues/${f.issue.id}/wake-intent`).send({ reason: "open" }).expect(404);
    expect(f.call).not.toHaveBeenCalled();
  });

  it("answers 202 before the resume finishes and logs one settled outcome per accepted call", async () => {
    const f = await seed();
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    f.call.mockImplementation(async () => { await held; return { providerLeaseId: f.lease.providerLeaseId!, metadata: {} }; });
    let logged!: () => void;
    const settled = new Promise<void>(resolve => { logged = resolve; });
    const info = vi.spyOn(logger, "info").mockImplementation(((fields: { issueId?: string; outcome?: string }, message: string) => {
      if (message === "sandbox prewarm" && fields.issueId === f.issue.id && fields.outcome === "resumed") logged();
    }) as never);
    try {
      await request(app(f.actor, f.workerManager)).post(`/api/issues/${f.issue.id}/wake-intent`).send({ reason: "open" }).expect(202, { accepted: true });
    } finally { finish(); }
    await settled;
    expect(info.mock.calls.filter(args => args[1] === "sandbox prewarm")).toEqual([
      [expect.objectContaining({ issueId: f.issue.id, outcome: "resumed", ms: expect.any(Number) }), "sandbox prewarm"],
    ]);
  });

  async function hint(f: Awaited<ReturnType<typeof seed>>, outcome: string, reason?: string, intent: "open" | "typing" = "open") {
    let finish!: () => void;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    const info = vi.spyOn(logger, "info").mockImplementation(((fields: { issueId?: string }, message: string) => {
      if (message === "sandbox prewarm" && fields.issueId === f.issue.id) finish();
    }) as never);
    try {
      await request(app(f.actor, f.workerManager)).post(`/api/issues/${f.issue.id}/wake-intent`)
        .send({ reason: intent }).expect(202, { accepted: true });
      await settled;
      expect(info.mock.calls.filter(args => args[1] === "sandbox prewarm")).toEqual([
        [expect.objectContaining({ issueId: f.issue.id, outcome, ...(reason ? { reason } : {}), ms: expect.any(Number) }), "sandbox prewarm"],
      ]);
      if (outcome === "skipped") expect(f.call).not.toHaveBeenCalled();
    } finally { info.mockRestore(); }
  }

  it.each([{}, { reason: "hover" }, { reason: "OPEN" }, { reason: null }, { reason: 1 },
    { reason: true }, { reason: ["open"] }, { reason: "typing", agentId: "other" }])("rejects invalid wake intent %j with 400", async body => {
    const f = await seed();
    await request(app(f.actor, f.workerManager)).post(`/api/issues/${f.issue.id}/wake-intent`).send(body).expect(400);
    expect(f.call).not.toHaveBeenCalled();
  });

  it("retires the old sandbox-prewarm path", async () => {
    const f = await seed();
    await request(app(f.actor, f.workerManager)).post(`/api/issues/${f.issue.id}/sandbox-prewarm`).send({}).expect(404);
    expect(f.call).not.toHaveBeenCalled();
  });

  it("reuses the comment-create pause authorization without returning its error to the page", async () => {
    const f = await seed();
    await ctx.db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issue.id, mode: "pause" });
    await request(app(f.actor, f.workerManager)).post(`/api/issues/${f.issue.id}/comments`).send({ body: "Not allowed while paused" }).expect(409);
    await hint(f, "skipped", "comment_not_allowed");
  });

  it("does not wake another person's readable conversation", async () => {
    const f = await seed();
    await ctx.db.update(issues).set({ conversationAgentId: f.agent.id, conversationUserId: "another-person", conversationState: "active" })
      .where(eq(issues.id, f.issue.id));
    await hint(f, "skipped", "conversation_not_owned");
  });

  it.each(["done", "cancelled"])("does not wake a %s task", async status => {
    const f = await seed();
    await ctx.db.update(issues).set({ status }).where(eq(issues.id, f.issue.id));
    await hint(f, "skipped", "terminal_status");
  });

  it.each(["no_comments", "old_user", "agent", "agent_with_user_id", "system", "deleted_user", "other_task"] as const)
    ("does not wake a task without recent human chat: %s", async kind => {
      const f = await seed();
      await ctx.db.delete(issueComments).where(eq(issueComments.issueId, f.issue.id));
      if (kind !== "no_comments") {
        let issueId = f.issue.id;
        if (kind === "other_task") {
          const [other] = await ctx.db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
          issueId = other!.id;
        }
        await ctx.db.insert(issueComments).values({ companyId: f.companyId, issueId, body: "Not recent human chat on this task",
          authorType: kind === "agent" || kind === "agent_with_user_id" ? "agent" : kind === "system" ? "system" : "user",
          authorUserId: kind === "agent" || kind === "system" ? null : f.userId,
          authorAgentId: kind === "agent" || kind === "agent_with_user_id" ? f.agent.id : null,
          createdAt: new Date(Date.now() - (kind === "old_user" ? 7 * 24 * 60 * 60_000 + 1_000 : 0)),
          deletedAt: kind === "deleted_user" ? new Date() : null,
        });
      }
      await hint(f, "skipped", "no_recent_user_comment");
    });

  it("permits an owned conversation with no comments", async () => {
    const f = await seed();
    await ctx.db.delete(issueComments).where(eq(issueComments.issueId, f.issue.id));
    await ctx.db.update(issues).set({ conversationAgentId: f.agent.id, conversationUserId: f.userId, conversationState: "active" })
      .where(eq(issues.id, f.issue.id));
    await hint(f, "resumed");
    expect(f.call).toHaveBeenCalledOnce();
  });

  it("permits typing in a non-conversation with a user comment within seven days", async () => {
    const f = await seed();
    await ctx.db.update(issueComments).set({ createdAt: new Date(Date.now() - 6 * 24 * 60 * 60_000) }).where(eq(issueComments.issueId, f.issue.id));
    await hint(f, "resumed", undefined, "typing");
    expect(f.call).toHaveBeenCalledOnce();
  });

  it("checks comment permission before conversation ownership", async () => {
    const f = await seed();
    await ctx.db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issue.id, mode: "pause" });
    await ctx.db.update(issues).set({ conversationAgentId: f.agent.id, conversationUserId: "another-person", conversationState: "active" })
      .where(eq(issues.id, f.issue.id));
    await hint(f, "skipped", "comment_not_allowed");
  });

  it("checks terminal status before recent human chat", async () => {
    const f = await seed();
    await ctx.db.delete(issueComments).where(eq(issueComments.issueId, f.issue.id));
    await ctx.db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
    await hint(f, "skipped", "terminal_status");
  });

  it("keeps route repeats silent through 59,999 ms and allows another attempt at 60,000 ms", async () => {
    const f = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    await hint(f, "resumed");
    vi.setSystemTime(Date.now() + 30_000);
    // The previous attempt is the only provider call; cooldown hints cannot add another.
    f.call.mockClear();
    await hint(f, "skipped", "cooldown", "typing");
    vi.setSystemTime(Date.now() + 29_999);
    await hint(f, "skipped", "cooldown");
    vi.setSystemTime(Date.now() + 1);
    await hint(f, "resumed", undefined, "typing");
    expect(f.call).toHaveBeenCalledOnce();
  });

  it("requires a signed-in person and issue read access before doing speculative work", async () => {
    const f = await seed();
    const actor = { type: "agent", companyId: f.companyId, agentId: f.agent.id, keyId: "test-key", keyScope: { kind: "standard" } } as Express.Request["actor"];
    await request(app(actor, f.workerManager)).post(`/api/issues/${f.issue.id}/wake-intent`).send({ reason: "open" }).expect(403);
    await request(app({ ...f.actor, userId: undefined } as unknown as Express.Request["actor"], f.workerManager))
      .post(`/api/issues/${f.issue.id}/wake-intent`).send({ reason: "open" }).expect(401);
    const outsider = await seedCompanyWithBoardAccess(ctx.db, "Outsider");
    await request(app(outsider.actor, f.workerManager)).post(`/api/issues/${f.issue.id}/wake-intent`).send({ reason: "open" }).expect(404);
    await ctx.db.update(issues).set({ visibility: "private", privacyRootIssueId: f.issue.id, responsibleUserId: "someone-else" }).where(eq(issues.id, f.issue.id));
    await request(app(f.actor, f.workerManager)).post(`/api/issues/${f.issue.id}/wake-intent`).send({ reason: "open" }).expect(404);
    expect(f.call).not.toHaveBeenCalled();
  });
});
