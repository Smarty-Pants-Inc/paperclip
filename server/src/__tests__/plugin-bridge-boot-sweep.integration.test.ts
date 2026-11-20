import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issues, pluginJobs, pluginJobRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startRealPluginLoader } from "./helpers/plugin-real-loader.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";

// Explicit cross-repository journey. Supply the BUILT fleet-bridge directory;
// there is no copied worker implementation or mocked SDK/worker/host boundary.
const pluginRoot = process.env.BRIDGEWAKE_PLUGIN_ROOT;
const journey = pluginRoot ? describe : describe.skip;
const namespace = "plugin_fleet_bridge_fdc24bcfdc";
journey("persisted bridge reply at real app boot and scheduled sweep", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Awaited<ReturnType<typeof startRealPluginLoader>> | undefined;
  let plugin: Awaited<ReturnType<Awaited<ReturnType<typeof startRealPluginLoader>>["install"]>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("bridge-boot-sweep-");
    db = createDb(tempDb.connectionString);
    // Negatives must never admit even a queued run. Closing dispatch does not
    // suppress admission or the row we count; it prevents an erroneous baseline
    // admission from launching an unrelated process while we inspect it.
    closeProcessRunAdmission();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    server = await startRealPluginLoader(db, { recoverDeferredWakes: true });
    plugin = await server.install(pluginRoot!);
  }, 120_000);
  afterAll(async () => {
    try { await server?.close({ preserveInstall: true }); }
    finally { resetProcessRunAdmissionForTests(); await tempDb?.cleanup(); }
  }, 120_000);

  async function storedReply(kind: "old" | "answered") {
    const companyId = randomUUID(), agentId = randomUUID(), fleetId = randomUUID();
    const userId = `bridge-boot-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Chat owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Bridge persisted-input journey",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 7)}`, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "member" });
    await db.insert(agents).values([agentId, fleetId].map(id => ({ id, companyId, name: id === agentId ? "Chat agent" : "Fleet",
      role: "engineer" as const, status: "idle" as const, adapterType: "process", adapterConfig: { command: "true" },
      runtimeConfig: {}, permissions: {} })));
    const [issue] = await db.insert(issues).values({ companyId, title: "Paul's resting chat",
      status: "in_review", conversationState: "waiting", conversationAgentId: agentId, conversationUserId: userId,
      assigneeAgentId: agentId, responsibleUserId: userId }).returning();
    await server!.api(`/plugins/${plugin.id}/config`, { companyId,
      configJson: { enabled: true, fleetAgentId: fleetId } });
    const services = buildHostServices(db, plugin.id, plugin.pluginKey, {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as never);
    const comment = await services.issues.createComment({ companyId, issueId: issue.id, body: `[from fleet] ${kind} reply` });
    const notice = await services.issues.createComment({ companyId, issueId: issue.id,
      body: "reply posted; no wake: deferred_issue_execution" });
    const historicalAt = new Date(Date.now() - (kind === "old" ? 25 * 60 * 60_000 : 10_000));
    await db.update(issueComments).set({ createdAt: historicalAt }).where(eq(issueComments.id, comment.id));
    // Historical terminal input is fixture setup, NOT an executed-answer claim.
    // It gives the real deferred owner an exact terminal predecessor to release.
    const [prior] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "legacy",
      startedAt: historicalAt, finishedAt: new Date(historicalAt.getTime() + 1),
      contextSnapshot: { issueId: issue.id, wakeCommentId: comment.id, wakeCommentIds: [comment.id] } }).returning();
    if (kind === "answered") await db.insert(issueComments).values({ companyId, issueId: issue.id,
      authorType: "agent", authorAgentId: agentId, createdByRunId: prior.id,
      body: "This bridge reply already has its answer.", createdAt: new Date(historicalAt.getTime() + 2) });
    const context = { issueId: issue.id, taskId: issue.id, wakeReason: "fleet_reply", pluginId: plugin.id,
      pluginKey: plugin.pluginKey, sourceCommentId: comment.id, wakeCommentId: comment.id, wakeCommentIds: [comment.id] };
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
      triggerDetail: "system", reason: "fleet_reply", status: "deferred_issue_execution",
      requestedByActorType: "system", requestedByActorId: plugin.id, idempotencyKey: `fleet-reply:${comment.id}`,
      requestedAt: historicalAt, updatedAt: historicalAt,
      payload: { issueId: issue.id, mutation: "plugin_wakeup", pluginId: plugin.id, pluginKey: plugin.pluginKey,
        commentId: comment.id, _paperclipWakeContext: context } }).returning();
    await db.execute(sql.raw(`INSERT INTO ${namespace}.pending_wakes
      (comment_id, company_id, task_id, created_at, attempts, last_attempt_at)
      VALUES ('${comment.id}', '${companyId}', '${issue.id}', now(), 1, now() - interval '10 minutes')`));
    return { companyId, agentId, issueId: issue.id, commentId: comment.id, noticeId: notice.id,
      priorRunId: prior.id, receiptId: receipt.id };
  }

  for (const stage of ["boot", "sweep"] as const) for (const kind of ["old", "answered"] as const) {
    it(`${stage}: ${kind} persisted bridge reply admits NO new run`, async () => {
      const [job] = await db.select().from(pluginJobs).where(and(eq(pluginJobs.pluginId, plugin.id), eq(pluginJobs.jobKey, "retry-wakes")));
      expect(job).toBeTruthy();
      await db.update(pluginJobs).set({ nextRunAt: new Date(Date.now() + 86_400_000) }).where(eq(pluginJobs.id, job.id));
      const previousJobs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, job.id));
      const input = await storedReply(kind);
      if (stage === "boot") {
        await server!.close({ preserveInstall: true }); server = undefined;
        await db.update(pluginJobs).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(pluginJobs.id, job.id));
        server = await startRealPluginLoader(db, { recoverDeferredWakes: true });
      } else {
        await server!.api(`/plugins/${plugin.id}/jobs/${job.id}/trigger`, {});
        server!.recheckDeferredWakes();
      }
      let completed: typeof pluginJobRuns.$inferSelect | undefined;
      const until = Date.now() + 45_000;
      do {
        const runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, job.id));
        completed = runs.find(row => !previousJobs.some(old => old.id === row.id) && ["succeeded", "failed"].includes(row.status));
        if (completed) break;
        await delay(50);
      } while (Date.now() < until);
      expect(completed, "the production plugin scheduler must really execute its retry job").toMatchObject({ status: "succeeded" });
      // Recheck both owners twice: repeated scans/restarts do not create a turn.
      server!.recheckDeferredWakes();
      let inspected: typeof agentWakeupRequests.$inferSelect | undefined;
      // The production coordinator deliberately bounds unscoped reconstruction
      // to 30 seconds. Do not mistake its normal deadline for an unrun sweep.
      const inspectionDeadline = Date.now() + 45_000;
      do {
        [inspected] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.receiptId));
        if (inspected.status !== "deferred_issue_execution") break;
        await delay(50);
      } while (Date.now() < inspectionDeadline);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId));
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, input.agentId));
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, input.issueId));
      const pending = await db.execute(sql.raw(`SELECT * FROM ${namespace}.pending_wakes WHERE comment_id = '${input.commentId}'`));
      const take = { stage, kind, input, job: completed, runs, receipts, comments, pending };
      if (process.env.ARTIFACTS_DIR) await writeFile(path.join(process.env.ARTIFACTS_DIR, `bridge-${stage}-${kind}.json`), JSON.stringify(take, null, 2));
      expect(inspected).toMatchObject({ status: "skipped", runId: null, error: `${kind === "old" ? "stale" : "answered"}_comment_cause` });
      expect(runs.map(run => run.id)).toEqual([input.priorRunId]);
      expect(receipts.every(row => row.runId === null)).toBe(true);
      expect(comments.filter(row => row.body.startsWith("reply posted; no wake:")).map(row => row.id)).toEqual([input.noticeId]);
    }, 120_000);
  }
});
