import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "../../__tests__/helpers/embedded-postgres.js";
// Importing the harness installs its module mocks: FIRST, before anything that loads the heartbeat service.
import { box, liveScenario, openClassicLiveContext, resetClassicLiveBox, SAVED } from "../../__tests__/helpers/classic-live-scenario.js";
import { heartbeatService } from "../heartbeat.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { registerWorkspaceRecoveryWork } from "../workspace-recovery-work.js";
import { registerEnvironmentCleanupWork } from "../environment-cleanup-work.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { REPLY_FILES_NOT_SAVED_LINE } from "../system-recovery-state.js";
import { settleUnansweredPersonMessagesForTask } from "../recovery/unanswered-person-message.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { nativeWorkspaceFinalizationWork } from "./native-workspace-finalization-work.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";

// d2shared: a task on a SHARED project checkout (a root the task does not own), by the real routes. The reply's save
// fails for good (retry exhausted) while the person's next message M is parked. Rows SHARED-AUTO, SHARED-RETRY and
// SHARED-CONTROL assert; PROBE mode (D2SHARED_PRESSES) only writes every GET verbatim for a report.
//   the project root ............ the task's project has a primary local checkout (configuration, inserted); the REAL
//                                 workspace preparation gives every run that checkout
//   turn 0, R ................... real runs of the real executor (queue, claim, preparation, acquisition, sync)
//   R's save .................... its own teardown copy-back, then the copy-back worker's retries (load + check),
//                                 until the finalizer's one terminal write (retry exhausted)
//   M ........................... POST /api/issues/:id/comments while R saves
// NAMED INJECTIONS: CLASSIC-STALL-1 (R's box calls hang), SAVE-FAILS (they return a failure), CLOCK-SKIP (the 30 s
//   retry delay is moved to now; the disposition pass and the unanswered sweep are given a later clock).
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function listing(root: string) {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), relative = path.relative(root, full);
      if (relative.startsWith(".paperclip-runtime") || relative === ".git" || relative.startsWith(`.git${path.sep}`)) continue;
      if (entry.isDirectory()) await walk(full); else out[relative] = await fs.readFile(full, "utf8");
    }
  };
  await walk(root);
  return out;
}

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("the save fails for good on a SHARED project root while a person's message is parked", () => {
  let context: Awaited<ReturnType<typeof openClassicLiveContext>>;
  let db: Db;
  beforeAll(async () => { context = await openClassicLiveContext("native-shared-root-"); ({ db } = context); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => resetClassicLiveBox());
  afterAll(async () => { await context?.close(); });

  /** One walk: turn 0, R, M parked while R saves, the save fails for good, then `press` ("+"-joined) and the real workers. */
  async function drive(press: string) {
    const out: Record<string, any> = { press };
    const s = await liveScenario(context, { sharedProjectRoot: true });
    const errors: unknown[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const receipts = heartbeat.registerDeferredReceiptWork(delivery, () => true);
    const work = nativeWorkspaceFinalizationWork(db, { environmentRuntime: {} as never, copyOutBound: { personWaitCapMs: 3_600_000 },
      onWorkspaceSettled: async () => undefined });
    const sweep = async (runId: string) => { for (const entry of await work.load({ companyId: s.companyId, runId })) await work.check(entry); };
    let recoveryWorker: ReturnType<typeof registerWorkspaceRecoveryWork> | null = null;
    try {
      await receipts.ready;
      await s.say("Please write the report.");
      for (let waited = 0; waited < 60_000; waited += 250) {
        await heartbeat.resumeQueuedRuns();
        await reconcileNativeFinalizations(db, (await s.runs()).map(run => run.id), { environmentRuntime: {} as never }).catch(() => undefined);
        const [first] = await s.runs();
        if (first && first.status !== "running" && first.status !== "queued") break;
        await sleep(250);
      }
      await heartbeat.drainActiveRunExecutions();
      const [r0] = await s.runs();
      expect(r0).toMatchObject({ status: "succeeded" });
      const [rootRow] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await s.issue()).executionWorkspaceId!));
      out.root = { cwd: rootRow.cwd, isProjectCheckout: rootRow.cwd === s.projectCheckout, mode: rootRow.mode, strategyType: rootRow.strategyType,
        providerType: rootRow.providerType, sourceIssueId: rootRow.sourceIssueId === s.issueId ? "this task" : rootRow.sourceIssueId,
        projectWorkspaceId: rootRow.projectWorkspaceId ? "set" : null, filesAfterTurn0: await listing(rootRow.cwd!) };
      const m0 = await s.say("Please rewrite the report.");
      const hung = Promise.race([s.stallReached.then(() => "hung" as const), sleep(60_000).then(() => "R never reached its copy-back" as const)]);
      for (let waited = 0; waited < 60_000 && !(await Promise.race([hung, sleep(250).then(() => null)])); waited += 250) await heartbeat.resumeQueuedRuns();
      expect(await hung).toBe("hung");
      const [, r] = await s.runs();
      expect(r).toMatchObject({ status: "running", runtimeMode: "native" });
      expect(JSON.stringify(r.contextSnapshot)).toContain(m0);
      // REAL: M, posted while R saves.
      const m = await s.say("Also add a summary section to the report.");
      const wakesOf = async (commentId: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId)))
        .filter(wake => JSON.stringify(wake.payload).includes(commentId));
      await vi.waitFor(async () => expect((await wakesOf(m)).map(wake => wake.status)).toEqual(["deferred_issue_execution"]), { timeout: 10_000, interval: 50 });
      // REAL retry path: R's own teardown copy-back fails, then the worker's retries, until the terminal write.
      s.fault.fail = true;
      s.releaseStall();
      const trail: unknown[] = [];
      const startAt = Date.now();
      while ((await s.runs())[1].status === "running" && Date.now() - startAt < 60_000) {
        await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date() }).where(and(eq(nativeRunFinalizations.runId, r.id),
          eq(nativeRunFinalizations.phase, "retryable_failure")));
        await sweep(r.id);
        const [c] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, r.id));
        const last = JSON.stringify({ phase: c?.phase, failureCode: c?.failureCode, attempt: (c?.failureDetail as any)?.workspaceFinalizeAttempt });
        if (trail.at(-1) !== last) trail.push(last);
        await sleep(250);
      }
      await heartbeat.drainActiveRunExecutions();
      out.retryTrail = trail;
      const ended = (await s.runs())[1];
      out.R = { id: ended.id, status: ended.status, errorCode: ended.errorCode, error: ended.error };
      const present = async () => { const worker = nativeResponsePresentationWork(db);
        for (const entry of await worker.load({ companyId: s.companyId, issueId: s.issueId })) await worker.check(entry); };
      await present();
      const get = async (suffix: string) => { const got = await request(s.app).get(`/api/issues/${s.issueId}${suffix}`); return { status: got.status, body: got.body }; };
      const post = async (suffix: string, body: unknown) => { const got = await request(s.app).post(`/api/issues/${s.issueId}${suffix}`).send(body as object); return { status: got.status, body: got.body }; };
      const snapshot = async () => ({ issue: await get(""), recoveryActions: await get("/recovery-actions"), comments: await get("/comments"),
        queuedComments: await get("/queued-comments"), runs: await get("/runs"), servedLine: await s.servedLine(r.id),
        wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId))).map(w => ({ id: w.id, status: w.status, reason: w.reason, runId: w.runId, error: w.error, payload: w.payload })),
        actionsDb: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId))).map(a => ({ id: a.id, status: a.status, cause: a.cause, ownerType: a.ownerType, outcome: a.outcome, nextAction: a.nextAction, resolutionNote: a.resolutionNote, evidence: a.evidence })),
        allRuns: (await s.runs()).map(run => ({ id: run.id, status: run.status, errorCode: run.errorCode, error: run.error, ctx: run.contextSnapshot, retryOf: run.retryOfRunId })) });
      out.before = await snapshot();
      const leases = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, r.id))).map(l => ({ id: l.id, status: l.status,
        provider: l.provider, leasePolicy: l.leasePolicy, cleanupStatus: l.cleanupStatus, failureReason: l.failureReason, metadata: l.metadata }));
      out.leasesBefore = await leases();
      const active = out.before.recoveryActions.body.active;
      out.inspect = active ? await get(`/recovery-actions?inspectSourceRunId=${r.id}&inspectSourceActionId=${active.id}`) : null;
      const turnsBefore = box.inputs.length;
      const presses = press.split("+");
      out.pressed = {};
      for (const one of presses) {
        if (one === "recover") out.pressed[one] = await post("/recovery-actions/recover-workspace", { actionId: active?.id, runId: r.id, idempotencyKey: randomUUID() });
        if (one === "retry-export") out.pressed[one] = await post("/recovery-actions/retry-workspace-export", { actionId: active?.id, runId: r.id, repairNote: "The sandbox was checked and is reachable again now." });
        if (one === "retry") out.pressed[one] = await post("/retry", { idempotencyKey: randomUUID(), observedRunId: r.id });
        if (one === "move-forward") out.pressed[one] = await post("/retry", { idempotencyKey: randomUUID(), observedRunId: r.id, retryAction: "move_forward" });
        if (one === "send-again") out.pressed[one] = await post("/comments", { body: "Also add a summary section to the report.", clientRequestId: randomUUID() });
        if (one === "save-works") s.fault.fail = false;
        // PLANTED (named BOX-STOPPED): R's box stop receipt, as the cleanup worker records it once the provider stopped
        // the box (the harness's fake provider cannot destroy a box that is a local directory: destroy_failed).
        if (one === "stopped") for (const lease of await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, r.id)))
          await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", failureReason: null,
            metadata: { ...(lease.metadata ?? {}), remoteExecutionTermination: remoteTerminationReceipt(lease as never, { providerLeaseId: lease.providerLeaseId!, state: "stopped" }) } })
            .where(eq(environmentLeases.id, lease.id));
        // PLANTED (named LEASE-CWD): the harness's box is a local directory, so R's lease lacks the provider's recorded
        // working directory; a real provider records it. Planted so the saved-work recovery passes that binding check.
        if (one === "cwd") for (const lease of await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, r.id)))
          await db.update(environmentLeases).set({ metadata: { ...(lease.metadata ?? {}), remoteCwd: s.boxes[s.faultedBox.index].cwd } }).where(eq(environmentLeases.id, lease.id));
      }
      // REAL workers from here, for a bounded time: the saved-work recovery worker (real environment runtime), the
      // execution-disposition pass and the execution-continuation delivery, the copy-back worker, and the queue.
      recoveryWorker = registerWorkspaceRecoveryWork(db, delivery, environmentRuntimeService(db), heartbeat.resumeRemoteStopComments);
      await recoveryWorker.ready;
      // REAL: the environment cleanup worker (it stops R's box once saved-work recovery asked for the stop).
      registerEnvironmentCleanupWork(db, delivery, { canRun: () => true,
        sweepPending: backoffMs => heartbeat.sweepPendingCleanupLeases({ backoffMs }), minimumSpacingMs: 1 });
      out.timeline = [];
      const minutesList = presses.includes("wait") ? [0, 2, 11, 16, 31, 61] : [0];
      for (const minutes of minutesList) {
        const now = new Date(Date.now() + minutes * 60_000);
        const pass = await settleUnrecoverableExecutions(db, now).then(() => "ok").catch(error => String(error));
        const delivered = await deliverReconciledExecutions(db, heartbeat.wakeup).then(() => "ok").catch(error => String(error));
        const until = Date.now() + (minutes === minutesList.at(-1) ? 20_000 : 4_000);
        while (Date.now() < until && box.inputs.length === turnsBefore) {
          await heartbeat.resumeQueuedRuns();
          await sweep(r.id).catch(error => errors.push(String(error)));
          await sleep(500);
        }
        out.timeline.push({ minutes, pass, delivered, issue: (await s.issue()).status, turns: box.inputs.length - turnsBefore,
          actions: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId)))
            .map(a => ({ status: a.status, cause: a.cause, ownerType: a.ownerType, outcome: a.outcome, check: (a.evidence as any).freshContinuationCheck ?? null,
              fresh: (a.evidence as any).freshContinuation ?? null, delivery: (a.evidence as any).continuationDelivery ?? null,
              system: (a.evidence as any).systemRecovery ?? null, workspaceRecovery: (a.evidence as any).workspaceRecovery ?? null })) });
        if (box.inputs.length > turnsBefore) break;
      }
      await sleep(1500);
      await heartbeat.drainActiveRunExecutions();
      await present();
      out.providerTurns = box.inputs.length - turnsBefore;
      out.providerInputs = (box.inputs.slice(turnsBefore) as any[]).map(input => ({ carriesM: JSON.stringify(input).includes(m),
        runId: input?.binding?.runId ?? null, cwd: input?.binding?.cwd ?? input?.workspace?.cwd ?? null }));
      out.errors = errors.map(String);
      out.after = await snapshot();
      out.leasesAfter = await leases();
      out.sweep = await settleUnansweredPersonMessagesForTask(db, { companyId: s.companyId, issueId: s.issueId, now: new Date(Date.now() + 10 * 60_000) })
        .then(v => v ?? null).catch(error => String(error));
      out.afterSweep = { comments: await get("/comments"), queuedComments: await get("/queued-comments"), issue: await get("") };
      const taskRoot = (await s.issue()).executionWorkspaceId;
      const [rootAfter] = taskRoot ? await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, taskRoot)) : [];
      out.M = { id: m, wakes: (await wakesOf(m)).map(w => ({ status: w.status, runId: w.runId, error: w.error })),
        projectCheckoutFiles: await listing(s.projectCheckout!), taskRootAfter: rootAfter?.cwd ?? null,
        taskRootIsProjectCheckout: rootAfter?.cwd === s.projectCheckout, taskRootFiles: rootAfter?.cwd ? await listing(rootAfter.cwd).catch(() => null) : null,
        rBoxFiles: await listing(s.boxes[s.faultedBox.index].cwd).catch(() => null), SAVED };
      out.ids = { r: r.id, r0: r0.id, m, m0 };
      if (process.env.D2SHARED_PROBE_DIR) await fs.writeFile(path.join(process.env.D2SHARED_PROBE_DIR, `live-${press}.json`), JSON.stringify(out, null, 2));
      return out;
    } finally {
      s.releaseStall(); receipts.stop?.(); await recoveryWorker?.stop().catch(() => undefined); await delivery.stop(); await heartbeat.drainActiveRunExecutions();
    }
  }

  // PROBE mode (evidence only, no assertion): D2SHARED_PRESSES=none,retry,... writes every GET verbatim to D2SHARED_PROBE_DIR.
  it.skipIf(!process.env.D2SHARED_PRESSES).each((process.env.D2SHARED_PRESSES ?? "none").split(","))("D2SHARED live probe: press %s", async press => {
    await drive(press);
  }, 300_000);

  const LINE = "Your message is saved. The last reply's file changes couldn't be saved; Retry to continue.";
  const NOTICE = /^Paperclip could not recover the unsaved files from the previous run: .* Files that run did not save or push are not included\./;
  type Out = Awaited<ReturnType<typeof drive>>;
  const carriers = (out: Out) => (out.after.allRuns as Array<{ id: string; status: string; ctx: unknown }>)
    .filter(run => run.id !== out.ids.r && JSON.stringify(run.ctx).includes(out.ids.m));
  const systemNotes = (out: Out) => (out.after.comments.body as Array<{ authorType: string; body: string }>).filter(c => c.authorType === "system").map(c => c.body);
  /** What every row holds of R, the shared checkout and R's unsaved bytes. */
  function expectRUntouched(out: Out) {
    expect(out.root).toMatchObject({ isProjectCheckout: true });
    expect(out.R).toMatchObject({ status: "failed", errorCode: "native_workspace_sync_out_retry_exhausted" });
    expect(out.before.servedLine).toMatchObject({ state: "lost", shown: "The file changes from this reply couldn't be saved." });
    expect(out.before.issue.body).toMatchObject({ status: "blocked" });
    const rAfter = (out.after.allRuns as Array<{ id: string; status: string; errorCode: string | null }>).find(run => run.id === out.ids.r);
    expect(rAfter).toMatchObject({ status: "failed", errorCode: "native_workspace_sync_out_retry_exhausted" });
    expect(out.after.servedLine).toEqual(out.before.servedLine);
    // The shared checkout holds what was saved, never R's unsaved edits; those stay in R's box.
    expect(out.M.projectCheckoutFiles).toEqual(SAVED);
    expect(out.M.rBoxFiles).toMatchObject({ "report.md": "report, REWRITTEN BY R (unsaved)\n" });
  }

  // PLANTED in the next two rows (named BOX-STOPPED, at its line in drive()): R's box stop receipt. REAL: everything else.
  it("SHARED-AUTO: the save failed for good on a shared project checkout with a message parked -> once saved-work recovery is spent and R's box is stopped, the message is answered ONCE with the notice in the thread; R stays FAILED, its line stays LOST, the checkout is untouched", async () => {
    const out = await drive("stopped");
    expectRUntouched(out);
    expect(out.providerTurns, "the parked message never started").toBe(1);
    expect(out.providerInputs).toMatchObject([{ carriesM: true }]);
    expect(carriers(out).map(run => run.status)).toEqual(["succeeded"]);
    expect(out.M.wakes.map((wake: { status: string }) => wake.status)).not.toContain("deferred_issue_execution");
    expect(out.after.issue.body.status).not.toBe("blocked");
    expect(out.after.queuedComments.body.entries ?? []).toEqual([]);
    expect(systemNotes(out).filter(body => NOTICE.test(body))).toHaveLength(1);
    // 0 "no run started": the unanswered sweep, its clock 10 minutes on, has nothing to say.
    expect(out.sweep).toMatchObject({ noticed: 0 });
  }, 300_000);

  it("SHARED-RETRY: the same, and the person presses Retry (POST /api/issues/:id/retry) -> accepted; ONE run carries the message; no second answer", async () => {
    const out = await drive("stopped+retry");
    expectRUntouched(out);
    expect(out.pressed.retry).toMatchObject({ status: 202, body: { accepted: true } });
    expect(out.providerTurns, "Retry started nothing").toBe(1);
    expect(out.providerInputs).toMatchObject([{ carriesM: true }]);
    expect(carriers(out).map(run => run.status)).toEqual(["succeeded"]);
    expect((out.after.allRuns as unknown[]).length).toBe(3);
    expect(out.M.wakes.map((wake: { status: string }) => wake.status)).not.toContain("deferred_issue_execution");
    expect(out.after.issue.body.status).not.toBe("blocked");
    expect(systemNotes(out).filter(body => NOTICE.test(body))).toHaveLength(1);
    expect(out.sweep).toMatchObject({ noticed: 0 });
  }, 300_000);

  it("SHARED-CONTROL (never-OK): while R's box is NOT stopped, nothing starts beside it: the message stays parked with a wait line that names the wait", async () => {
    const out = await drive("none");
    expectRUntouched(out);
    expect(out.providerTurns).toBe(0);
    expect(carriers(out)).toEqual([]);
    expect(out.M.wakes.map((wake: { status: string }) => wake.status)).toEqual(["deferred_issue_execution"]);
    expect(out.after.queuedComments.body).toMatchObject({ state: "deferred",
      executionWait: { reason: "remote_cleanup", message: "Waiting for the previous environment to stop. Your message will start automatically." } });
    expect(out.after.queuedComments.body.executionWait.message).not.toMatch(/Your Retry is saved/);
    // The ONE proposed line (pending RFL). NOT reached by a real route in this file: it is the wait line of a message
    // whose own wake cannot continue by itself (explicit-native-continuation.ts, the LOST-line gate), where Retry does.
    expect(REPLY_FILES_NOT_SAVED_LINE).toBe(LINE);
  }, 300_000);
});
