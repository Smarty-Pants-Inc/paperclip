import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, environmentLeases,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recordNativeLocalProcessStop } from "../services/native-local-process-stop.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { environmentService } from "../services/environments.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_NO_RUN_TEXT } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// catch: SUPERSEDE-WAITNOTE-UPSTREAM-HEADER-1119, S10-1 / E3.04.
// Actions use the real comment, Stop and pause routes; admission, not a fixture,
// produces every wake / executionWait. The initial historical execution and
// environment are explicitly planted preconditions, never the observed outcome.
const support = await getEmbeddedPostgresTestSupport();
const samples: unknown[] = [];
// RFL 01:31Z / rf-5: literals deliberately independent of production constants.
const REMOTE_WORDS = "Your message is saved. The run you stopped is still shutting down, so your message hasn't started yet.";
const REMOTE_EXPIRED_WORDS = "Your message is saved, but the run you stopped still hasn't shut down, so it can't start yet. You can delete it if you no longer need it.";
const reasons = ["remote_cleanup", "execution_recovery", "execution_active", "agent.not_invokable"] as const;
const words: Record<typeof reasons[number], string> = {
  remote_cleanup: REMOTE_WORDS,
  execution_recovery: "Your message is saved. It's waiting until the previous run is recovered.",
  execution_active: "Your message is saved. It's waiting for the current run to finish.",
  "agent.not_invokable": "Your message is saved. This agent is paused, so it starts when the agent is resumed.",
};

describe.skipIf(!support.supported)("SUPERSEDE-WAITNOTE-UPSTREAM-HEADER-1119 real routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("m10-one-line-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { vi.useRealTimers(); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => {
    if (process.env.M10_CAPTURE_DIR) {
      await mkdir(process.env.M10_CAPTURE_DIR, { recursive: true });
      await writeFile(path.join(process.env.M10_CAPTURE_DIR, "real-route-rows.json"), JSON.stringify(samples, null, 2) + "\n");
    }
    await db?.$client.end(); await database?.cleanup();
  });

  function api(companyId: string, agentActor?: { agentId: string; runId: string }) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = agentActor
      ? { type: "agent", source: "api_key", companyId, ...agentActor }
      : { type: "board", source: "session", userId: "m10-person",
        companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any, {})); app.use("/api", agentRoutes(db));
    app.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => { console.error("M10 unexpected route error", error); next(error); });
    app.use(errorHandler);
    return app;
  }

  async function plantedHistory(chat: boolean, legacy = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceId = randomUUID();
    // planted execution identity: a foreground child actually exits. No signal
    // is sent to an unowned process; the real stop-evidence producer observes it.
    // `detached` is honoured by Node at run time (child_process normalizeSpawnArguments passes it to spawnSync, so
    // the child leads its own process group and its pid is that group's id) but @types/node's SpawnSyncOptions does
    // not declare it: the option is kept, typed here, so the planted identity is unchanged.
    const exitedOptions: SpawnSyncOptions & { detached: boolean } = { detached: true, stdio: "ignore" };
    const exited = spawnSync(process.execPath, ["-e", ""], exitedOptions);
    expect(exited.status).toBe(0);
    await db.insert(companies).values({ id: companyId, name: "M10 route fixture", issuePrefix: "WAIT", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "m10-person", name: "Planted route actor", email: "m10-person@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "m10-person", status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "M10 saved input", status: "in_progress", assigneeAgentId: agentId,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: "m10-person", conversationState: "active" } : {}) });
    // planted: the prior execution has started, but owns no host process.
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: legacy ? "legacy" : "native", status: "running", startedAt: new Date(Date.now() - 60_000),
      processPid: exited.pid, processGroupId: exited.pid, processStartedAt: new Date(),
      contextSnapshot: { issueId }, ...(legacy ? { runnerProfileJson: { adapterDispatch: { adapterType: "pi_local" } } } : {}) });
    await db.update(issues).set({ executionRunId: sourceId }).where(eq(issues.id, issueId));
    if (!legacy) await db.insert(nativeRunFinalizations).values({ runId: sourceId, companyId, issueId, phase: "session_running" });
    // planted: the agent's other task occupies its only slot. No test dispatches
    // a provider or signals a process. The queued-run row below exercises the
    // real admission producer for this exact busy-agent shape.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    return { companyId, agentId, issueId, sourceId, legacy, chat, client: api(companyId) };
  }

  async function send(f: Awaited<ReturnType<typeof plantedHistory>>) {
    const sent = await request(f.client).post(`/api/issues/${f.issueId}/comments`).send({ body: "Use this new direction, please.", clientRequestId: randomUUID() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    let wake: typeof agentWakeupRequests.$inferSelect | undefined;
    await vi.waitFor(async () => {
      wake = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
        .find(row => JSON.stringify(row.payload).includes(sent.body.id));
      expect(wake).toBeTruthy();
    }, { timeout: 5_000, interval: 25 });
    return { message: sent.body, wake: wake! };
  }

  async function stop(f: Awaited<ReturnType<typeof plantedHistory>>) {
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceId));
    const response = await request(f.client).post(`/api/heartbeat-runs/${f.sourceId}/cancel`).send(f.legacy ? {} : { cancellationRequestId: randomUUID() });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    if (!f.legacy) expect(await db.transaction(tx => recordNativeLocalProcessStop(tx as unknown as typeof db, source!))).toBe(true);
    expect((await request(f.client).get(`/api/heartbeat-runs/${f.sourceId}`).expect(200)).body.status).toBe("cancelled");
  }

  async function recoverableSource(f: Awaited<ReturnType<typeof plantedHistory>>) {
    // The real recovery-action producer owns this gate; do not plant its row.
    const service = issueRecoveryActionService(db);
    const action = await service.upsertSourceScoped({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", fingerprint: f.sourceId,
      ownerType: "system", evidence: { runId: f.sourceId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } }, nextAction: "Waiting for stopped execution cleanup." });
    await service.resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: f.issueId, actionId: action.id,
      status: "resolved", outcome: "blocked" });
  }

  for (const chat of [false, true]) for (const reason of reasons) {
    it(`${chat ? "chat" : "task"}: ${reason}, real GET at +10s/+2m/+599999ms/+10m/+11m has one bounded wait and no no-run notice`, async () => {
      const f = await plantedHistory(chat, reason === "execution_recovery");
      await stop(f);
      if (reason === "remote_cleanup" || reason === "execution_recovery" || reason === "agent.not_invokable") {
        // planted: a remote environment which has not supplied a stop receipt.
        await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceId,
          provider: "daytona", providerLeaseId: `planted-${randomUUID()}`, status: "pending_cleanup", leasePolicy: "ephemeral" });
      }
      if (reason === "remote_cleanup" || reason === "execution_active" || reason === "agent.not_invokable") await recoverableSource(f);
      if (reason === "execution_active") {
        // planted: an earlier queued turn on this task, not carrying M. M's
        // admission must defer, rather than invent a run for the new input.
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
          runtimeMode: "legacy", status: "queued", contextSnapshot: { issueId: f.issueId } });
      }
      const issueBeforeSend = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
      let { message, wake } = await send(f);
      const issueAfterSend = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
      if (reason === "agent.not_invokable") {
        // Pause WHILE this real saved wake is waiting, then let its actual
        // admission producer persist the new gate on that same receipt.
        await request(f.client).post(`/api/agents/${f.agentId}/pause`).send({}).expect(200);
        const [paused] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        const gate = await evaluateAgentInvokabilityFromDb(db, paused);
        if (gate.invokable) throw new Error("Real pause did not close admission");
        // The invokability error is a machine-facing contract, NOT panel copy.
        expect(gate.message).toBe("Agent is not invokable in its current state");
        // A planted remote provider response is normalized by the real cleanup
        // producer. Its real consumer re-enters admission, which observes the
        // actual pause and stores the panel line on this very receipt.
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceId));
        const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" });
        await environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success", remoteExecutionTermination: receipt });
        await expect(heartbeatService(db).resumeRemoteStopComments((await heartbeatService(db).getRun(f.sourceId))!))
          .rejects.toThrow("Agent is not invokable in its current state");
        wake = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0];
      }
      expect(wake.status).toBe("deferred_issue_execution");
      expect(wake.runId).toBeNull();
      expect(wake.payload?.executionWait).toMatchObject({ reason });
      const t0 = wake.requestedAt.getTime();
      vi.useFakeTimers({ toFake: ["Date"] });
      // Establish the sweep's durable bound at the same T0 as submission.
      await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(t0) });
      for (const elapsed of [10_000, 120_000, 599_999, 600_000, 660_000]) {
        vi.setSystemTime(t0 + elapsed);
        await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
        const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
        const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
        samples.push({ producer: reason === "agent.not_invokable" ? "POST /issues/:id/comments; POST /agents/:id/pause; remoteTerminationReceipt (planted provider response) -> environmentService.releaseLease -> heartbeatService.resumeRemoteStopComments -> enqueueWakeup" : "POST /issues/:id/comments -> heartbeat enqueueWakeup", surface: chat ? "chat" : "task", reason,
          elapsed, readAt: new Date().toISOString(), expectedLine: reason === "remote_cleanup" && elapsed >= 600_000 ? REMOTE_EXPIRED_WORDS : words[reason],
          issueBeforeSend, issueAfterSend, messageId: message.id, queue, comments });
        expect.soft(queue.executionWait).toEqual({ reason, message: reason === "remote_cleanup" && elapsed >= 600_000 ? REMOTE_EXPIRED_WORDS : words[reason] });
        expect.soft(queue.queueId).toBe(wake.id); // Same saved receipt; never a second notice/queue.
        expect.soft(queue.entries.map((entry: any) => entry.comment.id)).toContain(message.id);
        expect.soft(comments.filter((row: any) => row.authorType === "system" && row.metadata?.recoveryResponsibility !== "system")).toEqual([]);
      }
      if (reason === "execution_active") {
        // E3.04: end the planted earlier holder through the REAL cancel route.
        // M has not started: the agent's other task still occupies its slot.
        const [holder] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          eq(heartbeatRuns.nativeIssueId, f.issueId), eq(heartbeatRuns.status, "queued")));
        expect(holder.contextSnapshot).not.toHaveProperty("wakeCommentId", message.id);
        await request(f.client).post(`/api/heartbeat-runs/${holder.id}/cancel`).send({}).expect(200);
        await heartbeatService(db).resumeRemoteStopComments((await heartbeatService(db).getRun(f.sourceId))!);
        const after = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
        expect(after.executionWait?.message).not.toBe(words.execution_active);
        const delivered = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
          .filter(run => JSON.stringify(run.contextSnapshot).includes(message.id));
        expect(delivered).toHaveLength(1);
        expect(delivered[0].status).toBe("queued");
        expect(delivered[0].startedAt).toBeNull();
        samples.push({ producer: "REAL POST /heartbeat-runs/:holder/cancel -> heartbeatService.resumeRemoteStopComments -> enqueueWakeup; GET queued-comments",
          surface: chat ? "chat" : "task", reason: "holder_ended", messageId: message.id, queue: after,
          comments: (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body,
          holder: (await request(f.client).get(`/api/heartbeat-runs/${holder.id}`).expect(200)).body,
          run: delivered[0], admittedRunCount: delivered.length });
      }
    });
  }

  for (const chat of [false]) {
    it(`${chat ? "chat" : "task"}: real pause -> saved panel -> POST resume runs the message once and retires the line`, async () => {
      const f = await plantedHistory(chat, true);
      // Planted successful history, with no live process or execution holder.
      // The observed message, pause, resume, dispatch and result are all real.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.companyId, f.companyId));
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
      await db.update(agents).set({ adapterType: "process", adapterConfig: { command: process.execPath,
        args: ["-e", "console.log('m10c-resumed-message-ran'); setTimeout(() => {}, 3000)"], cwd: process.cwd() } }).where(eq(agents.id, f.agentId));
      const lifecycle = configureAgentLifecycle(db, createLifecycleDriver(db, {} as never));
      const heartbeat = heartbeatService(db);
      try {
        await request(f.client).post(`/api/agents/${f.agentId}/pause`).send({}).expect(200);
        await lifecycle.process(f.agentId);
        const { message, wake } = await send(f);
        expect(wake.runId).toBeNull();
        const before = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
        expect(before.executionWait).toEqual({ reason: "agent.not_invokable", message: words["agent.not_invokable"] });
        const resumed = await request(f.client).post(`/api/agents/${f.agentId}/resume`).send({}).expect(200);
        await lifecycle.process(f.agentId);
        // Real production saved-receipt and dispatch producers, twice, to prove
        // adoption is idempotent. The controlled process really exits 0.
        await heartbeat.resumeQueuedRuns();
        let executing: typeof heartbeatRuns.$inferSelect | undefined;
        await vi.waitFor(async () => {
          executing = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
            .find(run => JSON.stringify(run.contextSnapshot).includes(message.id) && run.status === "running");
          expect(executing).toBeTruthy();
        }, { timeout: 10_000 });
        // A process adapter cannot author task replies on stdout. Exercise the
        // REAL agent comment route for its reply while this run is still live;
        // otherwise unfinished-task recovery correctly asks it to answer again.
        const agentClient = api(f.companyId, { agentId: f.agentId, runId: executing!.id });
        await request(agentClient).post(`/api/issues/${f.issueId}/comments`).send({ body: "I used your saved direction." }).expect(201);
        await request(agentClient).patch(`/api/issues/${f.issueId}`).send({ status: "done" }).expect(200);
        await vi.waitFor(async () => expect((await heartbeat.getRun(executing!.id))?.status).toBe("succeeded"), { timeout: 15_000 });
        await heartbeat.drainActiveRunExecutions();
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        const delivered = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
          .filter(run => JSON.stringify(run.contextSnapshot).includes(message.id));
        expect(delivered).toHaveLength(1);
        expect(delivered[0], JSON.stringify(delivered[0])).toMatchObject({ status: "succeeded", stdoutExcerpt: expect.stringContaining("m10c-resumed-message-ran") });
        expect(delivered[0].startedAt).not.toBeNull();
        const after = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
        expect(after.executionWait).toBeFalsy();
        samples.push({ producer: "REAL POST /agents/:id/pause; lifecycle.process (createLifecycleDriver); POST /issues/:id/comments; POST /agents/:id/resume; lifecycle.process; heartbeat.resumeQueuedRuns (twice) -> real process adapter; GET queued-comments",
          surface: chat ? "chat" : "task", reason: "agent_resumed", messageId: message.id, queue: after, beforeQueue: before,
          comments: (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body,
          resumeResponse: resumed.body, run: delivered[0], admittedRunCount: delivered.length,
          completionProducer: "REAL agent POST /issues/:id/comments and PATCH /issues/:id (done) while the controlled process runs" });
      } finally {
        await lifecycle.stop();
        await heartbeat.drainActiveRunExecutions();
      }
    }, 45_000);
  }

  async function savedBehindCleanup(chat: boolean) {
    const f = await plantedHistory(chat);
    await stop(f);
    // planted missing remote provider response. Admission below, not this
    // precondition, produces the observed deferred receipt on each surface.
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceId,
      issueId: f.issueId, provider: "daytona", providerLeaseId: `planted-${randomUUID()}`,
      status: "pending_cleanup", leasePolicy: "ephemeral" }).returning();
    await recoverableSource(f);
    const issueBeforeSend = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
    const sent = await send(f);
    expect(sent.wake).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: { executionWait: { reason: "remote_cleanup" } } });
    const issueAfterSend = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
    return { ...f, ...sent, lease, issueBeforeSend, issueAfterSend };
  }

  async function finishCleanup(f: Awaited<ReturnType<typeof savedBehindCleanup>>) {
    // planted remote provider stop response; REAL receipt normalizer and lease
    // settlement producer persist it and notify deferred admission. No remote
    // provider or host process is contacted, and no lease outcome is hand-written.
    const receipt = remoteTerminationReceipt(f.lease, { providerLeaseId: f.lease.providerLeaseId, state: "destroyed" });
    expect(receipt).toBeTruthy();
    const released = await environmentService(db).releaseLease(f.lease.id, "released", {
      cleanupStatus: "success", remoteExecutionTermination: receipt,
    });
    expect(released?.cleanupStatus).toBe("success");
    const heartbeat = heartbeatService(db);
    const source = (await heartbeat.getRun(f.sourceId))!;
    // Actual cleanup-consumer producer, twice: the same saved input is adopted once.
    await heartbeat.resumeRemoteStopComments(source);
    await heartbeat.resumeRemoteStopComments(source);
  }

  async function readSaved(f: Awaited<ReturnType<typeof savedBehindCleanup>>, reason: string, elapsed: number) {
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
    const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
    const row = { producer: "POST /heartbeat-runs/:id/cancel; recordNativeLocalProcessStop; issueRecoveryActionService.upsertSourceScoped/resolveActiveForIssue; POST /issues/:id/comments -> heartbeat enqueueWakeup; reconcileStrandedAssignedIssues; GET queued-comments/comments",
      surface: f.chat ? "chat" : "task", reason, elapsed, readAt: new Date().toISOString(), messageId: f.message.id,
      issueBeforeSend: f.issueBeforeSend, issueAfterSend: f.issueAfterSend, queue, comments };
    expect(comments.filter((c: any) => c.authorType === "system" && c.metadata?.recoveryResponsibility !== "system")).toEqual([]);
    return row;
  }

  for (const chat of [false, true]) {
    it(`${chat ? "chat" : "task"}: cleanup inside bound retires the first line and admits M once`, async () => {
      const f = await savedBehindCleanup(chat);
      const t0 = f.wake.requestedAt.getTime(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t0 + 10_000);
      const before = await readSaved(f, "remote_cleanup", 10_000);
      expect(before.queue.executionWait).toEqual({ reason: "remote_cleanup", message: REMOTE_WORDS });
      samples.push({ ...before, expectedLine: REMOTE_WORDS });
      vi.setSystemTime(t0 + 120_000);
      await finishCleanup(f);
      const after = await readSaved(f, "cleanup_finished", 120_000);
      expect(after.queue.executionWait).toBeFalsy();
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter(run => JSON.stringify(run.contextSnapshot).includes(f.message.id));
      expect(runs).toHaveLength(1);
      const run = (await request(f.client).get(`/api/heartbeat-runs/${runs[0].id}`).expect(200)).body;
      expect(run.status).toBe("queued"); // Real admission, not a claim of provider execution.
      samples.push({ ...after, producer: "remoteTerminationReceipt (planted provider response) -> environmentService.releaseLease -> heartbeatService.resumeRemoteStopComments (twice); GET run/queued-comments/comments",
        run, admittedRunCount: runs.length });
    });

    for (const deleteRoute of ["queued-panel", "comment"] as const) {
      it(`${chat ? "chat" : "task"}: at bound REAL ${deleteRoute} Delete removes M from queue and wake forever`, async () => {
        const f = await savedBehindCleanup(chat);
        const t0 = f.wake.requestedAt.getTime(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t0 + 600_000);
        const before = await readSaved(f, "remote_cleanup", 600_000);
        expect(before.queue.executionWait).toEqual({ reason: "remote_cleanup", message: REMOTE_EXPIRED_WORDS });
        const deletion = deleteRoute === "queued-panel"
          ? `/api/issues/${f.issueId}/queued-comments/${f.message.id}` : `/api/issues/${f.issueId}/comments/${f.message.id}`;
        const response = await request(f.client).delete(deletion).send(deleteRoute === "queued-panel"
          ? { queueId: before.queue.queueId, revision: before.queue.revision } : {});
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const after = await readSaved(f, "message_deleted", 600_000);
        expect(after.queue.entries).toEqual([]);
        expect(after.queue.executionWait).toBeFalsy();
        expect(after.comments.some((c: any) => c.id === f.message.id)).toBe(false);
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
        expect(wake.status).toBe("cancelled");
        expect(wake.runId).toBeNull();
        expect(JSON.stringify(wake.payload)).not.toContain(f.message.id);
        // There is NO wake input left for M, active or cancelled. Cleanup's
        // actual consumer must never resurrect the deleted message.
        expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
          sql`${agentWakeupRequests.status} in ('queued','deferred_issue_execution','claimed')`,
          sql`${agentWakeupRequests.payload}::text like ${`%${f.message.id}%`}`))).toEqual([]);
        vi.setSystemTime(t0 + 660_000); await finishCleanup(f);
        const later = await readSaved(f, "message_deleted", 660_000);
        expect(later.queue.entries).toEqual([]);
        expect(later.queue.executionWait).toBeFalsy();
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
          .filter(run => JSON.stringify(run.contextSnapshot).includes(f.message.id))).toEqual([]);
        samples.push({ ...after, producer: `REAL DELETE ${deletion}; GET queued-comments/comments; remoteTerminationReceipt (planted provider response) -> environmentService.releaseLease -> heartbeatService.resumeRemoteStopComments (twice); later GET queued-comments/comments`,
          deleteRoute, deletion, beforeQueue: before.queue, beforeComments: before.comments, laterQueue: later.queue,
          wakeStatus: wake.status, wakePayload: wake.payload, laterAdmittedRunCount: 0 });
      });
    }
  }

  it("deferral ends with no run: real cancellation producer cancels the wake, then the notice fires exactly once", async () => {
    const f = await plantedHistory(false, true); await stop(f);
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceId,
      provider: "daytona", providerLeaseId: `planted-${randomUUID()}`, status: "pending_cleanup", leasePolicy: "ephemeral" });
    const { message, wake } = await send(f);
    expect(wake.payload?.executionWait).toMatchObject({ reason: "execution_recovery" });
    const t0 = Date.now(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t0 + 660_000);
    await heartbeatService(db).cancelInvocationsForAgents([f.agentId], "M10 cancellation ends the saved wake");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("cancelled");
    for (let repeat = 0; repeat < 2; repeat++) {
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
      const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
      const notices = comments.filter((row: any) => row.authorType === "system" && row.metadata?.recoveryResponsibility !== "system");
      expect(notices.map((row: any) => row.body)).toEqual([UNANSWERED_MESSAGE_NO_RUN_TEXT]);
      samples.push({ producer: "heartbeatService.cancelInvocationsForAgents -> cancelPendingWakeupsForAgents", surface: "task", reason: "deferral_ended",
        messageId: message.id, elapsed: 660_000, repeat, comments });
    }
  });

  it.each([false, true])("queued run (chat=%s): real comment admission behind a planted busy agent exposes upstream's header, never a waiting/no-run note", async (chat) => {
    const f = await plantedHistory(chat);
    // The planted historical run has no message to answer. Its successful
    // precondition is not this row's outcome; the new run below is real admission.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.sourceId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.sourceId));
    const { message, wake } = await send(f);
    expect(wake.runId).toBeTruthy();
    const t0 = Date.now(); vi.useFakeTimers({ toFake: ["Date"] });
    await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(t0) });
    for (const elapsed of [10_000, 120_000, 600_000, 660_000]) {
      vi.setSystemTime(t0 + elapsed);
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
      const run = (await request(f.client).get(`/api/heartbeat-runs/${wake.runId}`).expect(200)).body;
      const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
      const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
      samples.push({ producer: "POST /issues/:id/comments -> heartbeat enqueueWakeup", surface: chat ? "chat" : "task", reason: "queued_run", elapsed,
        readAt: new Date().toISOString(), messageId: message.id, run, queue, comments });
      expect(run.status).toBe("queued");
      expect.soft(comments.filter((row: any) => row.authorType === "system" && row.metadata?.recoveryResponsibility !== "system")).toEqual([]);
    }
  });
  // RFL 06:11Z / rf-3 06:10Z (merged10 finding): a saved wake that waits behind the sender's own STANDING Stop hold
  // counts as waiting whatever its deferred status. The hold rule (unanswered-person-message.ts
  // STOP_HOLD_YIELDS_TO_SENDER_STOP) read only "queued" and "deferred_issue_execution", so a wake in status
  // "deferred" (the S10-1 record's status) was not waiting: the sweep said "no run started" at once.
  // REAL: the sender's Stop (POST /heartbeat-runs/:runId/cancel), which leaves its board-owned hold STANDING (it is
  // asserted, and NOT resolved here, unlike the rows above whose recoverableSource ends it), then the comment route
  // (POST /issues/:id/comments -> heartbeat enqueueWakeup), whose admission saves the wake and its remote_cleanup
  // wait. Outcomes are read from the real GETs. planted, as in the rows above: the prior execution and the remote
  // environment without a stop receipt. PLANTED, and named so, beside the real-route reads of the same shape: the
  // saved wake's status "deferred" (no admission path on this line writes that status; the real one is
  // "deferred_issue_execution") and, last, that wake without its stored wait.
  // The TASK surface is not this shape: under the same standing hold its real admission queues a RUN that carries
  // the message (upstream's header is its one line; row "queued run stays in the upstream header" above).
  it("chat: a deferred remote_cleanup wake behind the sender's own STANDING Stop hold is waiting: no 'no run started' line (real Stop + real comment admission)", async () => {
    const f = await plantedHistory(true);
    await stop(f);
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceId,
      provider: "daytona", providerLeaseId: `planted-${randomUUID()}`, status: "pending_cleanup", leasePolicy: "ephemeral" });
    const standingHold = async () => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .filter(hold => ["active", "escalated"].includes(hold.status))
      .map(hold => [hold.kind, hold.status, hold.ownerType, (hold.evidence as Record<string, unknown> | null)?.runId]);
    expect(await standingHold(), "the real Stop route left its board-owned hold standing").toEqual([["active_run_watchdog", "active", "board", f.sourceId]]);
    const stopped = (await request(f.client).get(`/api/heartbeat-runs/${f.sourceId}`).expect(200)).body;
    expect(stopped, "the real Stop route recorded the sender").toMatchObject({ status: "cancelled",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "m10-person" } });
    const { message, wake } = await send(f);
    expect(message.authorUserId).toBe("m10-person");
    expect([wake.status, wake.runId, wake.payload?.executionWait], "what real admission saved").toEqual([
      "deferred_issue_execution", null, expect.objectContaining({ reason: "remote_cleanup", message: REMOTE_WORDS })]);
    const t0 = wake.requestedAt.getTime();
    const read = async (shape: string) => {
      const kinds: string[] = [];
      for (const elapsed of [0, 10_000, 120_000, 599_999, 660_000]) {
        kinds.push((await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(t0 + elapsed) })).kind);
        const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
        expect.soft(comments.filter((row: any) => row.authorType === "system" && row.metadata?.recoveryResponsibility !== "system")
          .map((row: any) => row.body), `${shape}, +${elapsed} ms: no notice, and never the no-run words`).toEqual([]);
      }
      const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
      expect(await standingHold(), `${shape}: the Stop's hold still stands`).toHaveLength(1);
      return { kinds, queue };
    };
    // The real saved wake: kept by the sender's own Stop at every read; its stored wait is the one line.
    const real = await read("real deferred_issue_execution wake");
    expect(real.kinds).toEqual(Array(5).fill("person_stopped"));
    expect(real.queue.entries.map((entry: any) => entry.comment.id), "the message is still saved in the queue").toContain(message.id);
    expect(real.queue.executionWait, "the stored wait is the one line (this GET is read at the real clock)").toEqual({ reason: "remote_cleanup", message: REMOTE_WORDS });
    // PLANTED status "deferred" on that same saved wake (its stored remote_cleanup wait untouched): the same outcome.
    await db.update(agentWakeupRequests).set({ status: "deferred" }).where(eq(agentWakeupRequests.id, wake.id));
    const plantedDeferred = (await read("PLANTED status deferred")).kinds;
    // PLANTED: the "deferred" wake without its stored wait. Before the fix this is the false "no run started" line at
    // once (the hold rule did not count it, and no stored wait kept it pending).
    await db.update(agentWakeupRequests).set({ payload: sql`${agentWakeupRequests.payload} - 'executionWait'` }).where(eq(agentWakeupRequests.id, wake.id));
    const plantedNoWait = (await read("PLANTED status deferred, no stored wait")).kinds;
    expect({ plantedDeferred, plantedNoWait }, "kept by the sender's own Stop, like the real wake").toEqual({
      plantedDeferred: Array(5).fill("person_stopped"), plantedNoWait: Array(5).fill("person_stopped") });
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"),
      eq(issueComments.body, UNANSWERED_MESSAGE_NO_RUN_TEXT))), "no 'no run started' notice was ever written").toEqual([]);
  });
});
