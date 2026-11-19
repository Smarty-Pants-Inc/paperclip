import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, environmentLeases, nativeRunFinalizations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "../../__tests__/helpers/embedded-postgres.js";
// Importing the harness installs its module mocks: FIRST, before anything that loads the heartbeat service.
import { box, liveScenario, openClassicLiveContext, resetClassicLiveBox, SAVED } from "../../__tests__/helpers/classic-live-scenario.js";
import { heartbeatService } from "../heartbeat.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { reconcileRetainedWorkspaces } from "../workspace-recovery.js";
import { registerWorkspaceRecoveryWork } from "../workspace-recovery-work.js";
import { registerEnvironmentCleanupWork } from "../environment-cleanup-work.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { settleUnansweredPersonMessagesForTask } from "../recovery/unanswered-person-message.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { nativeWorkspaceFinalizationWork } from "./native-workspace-finalization-work.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";

// d2shared4: rf-5's two judge rows on bb/2d-shared3 (bf55be82), PORTED from its judge-drive.ts / judge.test.ts. The rows
// read only the real routes, the real sweep service and the real GETs; they import nothing from the fix.
//   PERSON CASE: a person's message M is held behind "Continue with the files as they are" after reply R's file save
//   partly landed on the SHARED project checkout.
//   F1  the unanswered sweep, run DURING that hold (+11 min, before any press), must not tell the person to send the
//       message again (settleUnansweredPersonMessagesForTask; rf-5: "+11min hold sweep must not advise send-again").
//   F2  the Inbox failed-run row presses POST /api/issues/:id/retry with what the Inbox's own GET
//       (GET /api/companies/:id/inbox/mine) says about the task; that press must start M (rf-5: a plain Retry is
//       accepted 202 and leaves M held, 0 runs).
// REAL: every run (the real queue, executor, copy-back, finalizer), the routes, the gate, the recovery and cleanup workers.
// SCRIPTED: the provider turns only; M's turn publishes an ATTRIBUTED answer through the real PaperclipControlPlanePort.
// NAMED INJECTIONS, each at its line: CLASSIC-STALL-1 (the harness), PARTIAL-EIO (the real copy-back publishes notes.md,
//   then the publication of report.md fails), CLOCK-SKIP (retry delays are moved to now; the sweep is given a later
//   clock), PLANTED BOX-STOPPED (R's box stop receipt).
// d2shared5: the SAME walk one step earlier, while R's box is STILL STOPPING (the automatic wait; row WAITING below, the
//   former PROBE of e2008042 turned into an asserting row). Every surface must say the ONE waiting line there:
//   (a) the +11 min unanswered sweep posts no "no run started ... Sending it again is safe" in that wait, so no such note
//       stands beside Continue once the hold forms;
//   (c) the Inbox's GET carries the wait (its row then shows the sentence and no button);
//   (f) the task and the queue never say a recovery's "... Your Retry is saved." for the person's message.
const WAITING = "Waiting for the previous environment to stop. Your message will start automatically.";
const LINE = "Your message is saved. The last reply's file changes couldn't be saved; your message starts now on the project's files as they are.";
const PARTLY = "The last reply's file changes couldn't be saved, and part of them may already be in the project's files. Your message will start once you choose Continue.";
const CONTINUE = "continue_with_files";
const M = "Also add a summary section to the report.";
const M_ANSWER = "M answer: the requested summary is added.";
const NO_RUN_NOTE = "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
const SEND_AGAIN = /no run started|Sending it again is safe|Send the message again|Your message wasn't answered/;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function files(root: string) {
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
const hash = (tree: Record<string, string>) => createHash("sha256").update(JSON.stringify(Object.entries(tree).sort())).digest("hex");
type Snapshot = { issue: any; queue: any; comments: any[]; inboxMine: any; inboxRuns: any[]; inboxRows: any[]; agents: any[]; providerTurns: number;
  carriers: Array<{ id: string; status: string }>; answerCount: number };

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("a message held for Continue on a SHARED project checkout: the unanswered sweep and the Inbox read the SAME hold", () => {
  let context: Awaited<ReturnType<typeof openClassicLiveContext>>;
  beforeEach(async () => { context = await openClassicLiveContext("native-shared-root-hold-"); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => { await context?.close(); resetClassicLiveBox(); }, 60_000);

  /** One walk (rf-5's drive): turn 0, R, M parked while R saves, R's save fails for good, R's box stops, the gate runs.
   * `partial`: the REAL partial apply. `parkM: false`: nobody sends M (an ordinary failed run, no message held). */
  async function drive(name: string, opts: { partial?: boolean; parkM?: boolean; holdSweep?: boolean; waitingSweep?: boolean; actions?: string[] } = {}) {
    const { db } = context;
    const s = await liveScenario(context, { sharedProjectRoot: true });
    const out: Record<string, any> = { name, ids: { companyId: s.companyId, agentId: s.agentId, issueId: s.issueId }, snapshots: {} as Record<string, Snapshot>,
      presses: [] as Array<{ action: string; route: string; sent: Record<string, unknown>; status: number; body: any }>, faults: [], errors: [], timing: [] as string[] };
    const startedAt = Date.now();
    const mark = (label: string) => { out.timing.push(`${label}@${((Date.now() - startedAt) / 1000).toFixed(1)}s`); };
    const h = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => out.errors.push(String(error)) });
    const receipts = h.registerDeferredReceiptWork(delivery, () => true);
    const work = nativeWorkspaceFinalizationWork(db, { environmentRuntime: {} as never, copyOutBound: { personWaitCapMs: 3_600_000 },
      onWorkspaceSettled: async () => undefined });
    let recovery: ReturnType<typeof registerWorkspaceRecoveryWork> | null = null;
    let renameSpy: { mockRestore: () => void } | null = null;
    let terminalR: { id: string } | null = null;
    const scripted = box.session;
    let turn = 0;
    // SCRIPTED PROVIDER: turns 1 and 2 are the harness's; the third (M's) publishes an attributed answer via the real control-plane port.
    box.session = async (input: any) => {
      turn += 1;
      if (turn < 3) return scripted!(input);
      const execution = input.execution, runId: string = execution.binding.runId, runner: string = input.runnerInstanceId, control = `${runner}:control`;
      const sessionId: string = execution.session.normalizedSessionId ?? `hold-${runId}`;
      const port = new PaperclipControlPlanePort(db, { companyId: s.companyId, issueId: s.issueId, agentId: s.agentId, runId, sessionId,
        completionContractId: execution.completionContract.id, completionContractSha256: execution.completionContract.sha256,
        sourceInstanceId: runner, controlPlaneSourceInstanceId: control });
      const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: M_ANSWER,
        completionClaim: { contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
          criteria: (execution.completionContract.contract.criteria ?? []).map((criterion: { id: string }) => ({ criterionId: criterion.id,
            status: "satisfied", evidenceRefs: ["session-goal:complete"], explanation: M_ANSWER })), remainingWork: [] },
        evidence: [{ kind: "session_goal_status", ref: "session-goal:complete" }], verification: [], attentionRequests: [], artifacts: [] };
      const terminal = { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" };
      const event = (seq: number, eventType: string, payload: unknown, kind = "runner") => ({ schema: "paperclip.prp.event.v1", schemaVersion: 1, runId,
        normalizedSessionId: sessionId, turnId: "answer-turn", itemId: "answer-item", sourceInstanceId: kind === "runner" ? runner : control,
        sourceEventId: `hold-${runId}-${kind}-${seq}`, sourceSeq: seq, sourceKind: kind, eventType, priority: 0, emittedAt: new Date().toISOString(), payload });
      await port.openRun({ identity: { companyId: s.companyId, issueId: s.issueId, agentId: s.agentId, runId, sessionId }, backendKind: "runner", sourceInstanceId: runner });
      await port.appendEvent(event(1, "item.delta", { kind: "agentMessage", channel: "final", text: M_ANSWER }) as never);
      await port.appendEvent(event(2, "item.completed", { kind: "agentMessage", channel: "final", providerPhase: "final", text: M_ANSWER }) as never);
      await port.appendEvent(event(1, "run.result.accepted", { result }, "control_plane") as never);
      await port.appendEvent(event(2, "run.terminal", terminal, "control_plane") as never);
      await port.completeRun({ result: result as never, terminal: terminal as never, turnId: "answer-turn",
        callerResultId: `${runId}:result`, callerDedupeKey: `${runId}:${execution.completionContract.sha256}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: M_ANSWER };
    };
    const copyBack = async () => { if (terminalR) for (const entry of await work.load({ companyId: s.companyId, runId: terminalR.id })) await work.check(entry); };
    const get = async (url: string) => { const got = await request(s.app).get(url); expect(got.status, `${url} ${JSON.stringify(got.body)}`).toBe(200); return got.body; };
    const present = async () => { const worker = nativeResponsePresentationWork(db);
      for (const entry of await worker.load({ companyId: s.companyId, issueId: s.issueId })) await worker.check(entry); };
    /** Every outcome below is a real GET: the task, its queue, its thread, and the GETs the Inbox page reads
     * (ui/src/pages/Inbox.tsx: issuesApi.inboxMine; heartbeatsApi.list summary+latestFailuresOnly; issuesApi.listCompact
     * rows; agentsApi.list). */
    const snap = async (label: string): Promise<Snapshot> => {
      await present();
      const comments = await get(`/api/issues/${s.issueId}/comments`);
      const snapshot: Snapshot = { issue: await get(`/api/issues/${s.issueId}`), queue: await get(`/api/issues/${s.issueId}/queued-comments`), comments,
        inboxMine: await get(`/api/companies/${s.companyId}/inbox/mine`),
        inboxRuns: await get(`/api/companies/${s.companyId}/heartbeat-runs?limit=200&summary=true&latestFailuresOnly=true`),
        inboxRows: await get(`/api/companies/${s.companyId}/issues?limit=100&includeRoutineExecutions=true&view=rows&ids=${s.issueId}`),
        agents: await get(`/api/companies/${s.companyId}/agents`),
        providerTurns: box.inputs.filter((input: any) => input.binding?.companyId === s.companyId).length - 2,
        carriers: out.ids.m ? (await s.runs()).filter(run => run.id !== terminalR?.id && JSON.stringify(run.contextSnapshot).includes(out.ids.m))
          .map(run => ({ id: run.id, status: run.status })) : [],
        answerCount: comments.filter((comment: any) => comment.authorType === "agent" && comment.body === M_ANSWER).length };
      out.snapshots[label] = snapshot;
      return snapshot;
    };
    const pump = async (ms = 3500) => {
      const until = Date.now() + ms;
      do {
        // NAMED CLOCK-SKIP: the deferred receipt's own 30 s scheduler wait is made due; the gate and the workers are real.
        await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 31_000) }).where(and(eq(agentWakeupRequests.agentId, s.agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution")));
        receipts.wake?.();
        if (recovery) await Promise.all((await reconcileRetainedWorkspaces(db, environmentRuntimeService(db), h.resumeRemoteStopComments, true)) ?? []);
        await settleUnrecoverableExecutions(db);
        await deliverReconciledExecutions(db, h.wakeup);
        await h.resumeQueuedRuns();
        await copyBack();
        await sleep(150);
      } while (Date.now() < until);
      await h.drainActiveRunExecutions();
      await present();
    };
    /** What the Inbox failed-run row presses (ui/src/pages/Inbox.tsx retryRunMutation -> issuesApi.retryTask): R's run id
     * from the Inbox's failed-run GET, and "Continue with the files as they are" (retryAction continue_with_files) only
     * when the Inbox's own task projection says the message is held for it. Read from the Inbox's GET at press time:
     * a list row carries no execution blocker, so the row can press only what its `interruption` says. */
    const inboxPress = async (stale?: Record<string, unknown>) => {
      const mine = await get(`/api/companies/${s.companyId}/inbox/mine`);
      const run = (mine.failureRuns as any[]).find(candidate => candidate.id === terminalR!.id);
      // Once M is answered the Inbox no longer lists R. A second press can then only come from a row that is still on
      // a stale screen: it sends what that row sent, under a new idempotency key.
      if (!run && stale) return { ...stale, idempotencyKey: randomUUID() };
      expect(run, "the Inbox lists R as a failed run").toBeTruthy();
      const held = inboxTask(mine, s.issueId)?.interruption?.savedMessageWait?.state === "continue_required";
      return { idempotencyKey: randomUUID(), observedRunId: run.id as string, ...(held ? { retryAction: CONTINUE } : {}) };
    };
    const press = async (action: string) => {
      const sent: Record<string, unknown> = action === "inbox" ? await inboxPress()
        : action === "inbox-again" ? await inboxPress(out.presses.find((earlier: { action: string }) => earlier.action === "inbox")?.sent)
        : { idempotencyKey: randomUUID(), observedRunId: terminalR!.id, ...(action.startsWith("continue") ? { retryAction: CONTINUE } : {}) };
      const got = await request(s.app).post(`/api/issues/${s.issueId}/retry`).send(sent);
      out.presses.push({ action, route: "POST /api/issues/:id/retry", sent, status: got.status, body: got.body });
    };
    try {
      await receipts.ready;
      await s.say("Please write the report.");
      await vi.waitFor(async () => { await h.resumeQueuedRuns();
        await reconcileNativeFinalizations(db, (await s.runs()).map(run => run.id), { environmentRuntime: {} as never });
        expect((await s.runs())[0]?.status).toBe("succeeded"); }, { timeout: 60_000, interval: 250 });
      await h.drainActiveRunExecutions();
      mark("turn0");
      out.savedHash = hash(await files(s.projectCheckout!));
      expect(await files(s.projectCheckout!)).toEqual(SAVED);
      await s.say("Please rewrite the report.");
      let stalled = false;
      void s.stallReached.then(() => { stalled = true; });
      await vi.waitFor(async () => { await h.resumeQueuedRuns(); expect(stalled).toBe(true); }, { timeout: 60_000, interval: 250 });
      terminalR = (await s.runs())[1];
      out.ids.r = terminalR.id;
      mark("R-stalled");
      if (opts.parkM !== false) {
        // REAL: M, posted while R saves.
        out.ids.m = await s.say(M);
        await vi.waitFor(async () => { const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId));
          expect(wakes.filter(wake => JSON.stringify(wake.payload).includes(out.ids.m)).map(wake => wake.status)).toEqual(["deferred_issue_execution"]); }, { timeout: 10_000 });
      }
      if (opts.partial) {
        // NAMED INJECTION PARTIAL-EIO (rf-5's REAL partial apply; no planted prefix): notes.md is written on the checkout by
        // the actual export/apply (mergeDirectoryWithBaseline); the publication of report.md then fails with EIO.
        const rename = fs.rename.bind(fs);
        renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from: any, to: any) => {
          if (String(from).includes(".paperclip-merge-") && String(to) === path.join(s.projectCheckout!, "report.md")) {
            out.faults.push({ injection: "EIO-on-report-publication", notes: await fs.readFile(path.join(s.projectCheckout!, "notes.md"), "utf8").catch(() => null) });
            throw Object.assign(new Error("injected EIO after notes.md was applied"), { code: "EIO" });
          }
          return rename(from, to);
        });
      } else s.fault.fail = true; // NAMED INJECTION SAVE-FAILS (the harness): R's box calls fail; nothing lands on the checkout.
      s.releaseStall();
      await vi.waitFor(async () => {
        // NAMED CLOCK-SKIP: the copy-back's retry delay is moved to now.
        await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date() }).where(and(eq(nativeRunFinalizations.runId, terminalR!.id),
          eq(nativeRunFinalizations.phase, "retryable_failure")));
        await copyBack();
        const r = (await s.runs())[1];
        expect(r.status).toBe("failed"); expect(r.errorCode).toBe("native_workspace_sync_out_retry_exhausted");
      }, { timeout: 90_000, interval: 250 });
      await h.drainActiveRunExecutions();
      renameSpy?.mockRestore(); renameSpy = null;
      mark("R-failed");
      out.endedHash = hash(await files(s.projectCheckout!));
      recovery = registerWorkspaceRecoveryWork(db, delivery, environmentRuntimeService(db), h.resumeRemoteStopComments);
      await recovery.ready;
      registerEnvironmentCleanupWork(db, delivery, { canRun: () => true, sweepPending: backoffMs => h.sweepPendingCleanupLeases({ backoffMs }), minimumSpacingMs: 1 });
      await pump(8000);
      if (opts.waitingSweep) {
        // R's box is NOT stopped yet (PLANTED BOX-STOPPED comes below): the automatic wait. Nothing is planted for it.
        await snap("waiting");
        // THE +11-minute sweep (NAMED CLOCK-SKIP: its clock only), DURING that wait.
        out.waitingSweep = await settleUnansweredPersonMessagesForTask(db, { companyId: s.companyId, issueId: s.issueId, now: new Date(Date.now() + 11 * 60_000) });
        await snap("waiting-after-11min-sweep");
        // The gate runs again in the SAME state (the box is still not stopped): its own words for this wait, now.
        await pump(3500);
        await snap("waiting-gate-reran");
      }
      // PLANTED BOX-STOPPED: R's box stop receipt, in the shape of the real termination-receipt producer (the harness's
      // fake provider cannot stop a box that is a local directory).
      for (const lease of await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, terminalR.id)))
        await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", failureReason: null,
          metadata: { ...(lease.metadata ?? {}), remoteExecutionTermination: remoteTerminationReceipt(lease as never, { providerLeaseId: lease.providerLeaseId!, state: "stopped" }) } })
          .where(eq(environmentLeases.id, lease.id));
      await pump(8000);
      mark("gate");
      await snap("hold");
      if (opts.holdSweep) {
        // THE +11-minute sweep (NAMED CLOCK-SKIP: its clock only), DURING the hold, BEFORE any press.
        out.holdSweep = await settleUnansweredPersonMessagesForTask(db, { companyId: s.companyId, issueId: s.issueId, now: new Date(Date.now() + 11 * 60_000) });
        await snap("hold-after-11min-sweep");
      }
      for (const action of opts.actions ?? []) { await press(action); await pump(action.endsWith("again") ? 1500 : 3500); await snap(`after-${action}`); }
      await snap("final");
      mark("final");
      out.checkout = await files(s.projectCheckout!);
      return out;
    } finally {
      s.releaseStall(); renameSpy?.mockRestore(); receipts.stop?.(); await recovery?.stop().catch(() => undefined); await delivery.stop(); await h.drainActiveRunExecutions();
      if (process.env.D2SHARED4_PROBE_DIR) await fs.writeFile(path.join(process.env.D2SHARED4_PROBE_DIR, `${name}.json`), JSON.stringify(out, null, 2));
    }
  }

  /** The hold as the task's card and the queue line say it, with nothing started. */
  function expectHeld(snapshot: Snapshot) {
    expect(snapshot.providerTurns, "a silent run on mixed files").toBe(0);
    expect(snapshot.carriers).toEqual([]);
    expect(snapshot.answerCount).toBe(0);
    expect(snapshot.issue.executionBlocker).toMatchObject({ nextAction: PARTLY, savedMessageWait: "continue_required" });
    expect(snapshot.queue).toMatchObject({ state: "deferred", executionWait: { reason: "checkout_continue_required", message: PARTLY } });
  }
  /** M answered ONCE: exactly one carrying run, exactly one attributed reply, nothing left queued. */
  function expectAnsweredOnce(snapshot: Snapshot) {
    expect(snapshot.carriers.map(run => run.status), "runs that carry M").toEqual(["succeeded"]);
    expect(snapshot.answerCount, "attributed replies to M").toBe(1);
    expect(snapshot.providerTurns).toBe(1);
    expect(snapshot.queue.entries ?? []).toEqual([]);
  }
  /** R's task as the Inbox's Mine snapshot carries it for a failed run (its failure context row). */
  function inboxTask(mine: any, issueId: string) {
    return [...mine.contextIssues, ...mine.issues].find((candidate: any) => candidate.id === issueId && candidate.interruption !== undefined);
  }
  const visibleNotes = (snapshot: Snapshot) => snapshot.comments.filter(comment => comment.authorType === "system")
    .map(comment => JSON.stringify([comment.body, comment.presentation ?? null, comment.metadata ?? null]));

  it("WAITING (a)(c)(f): while R's box is still stopping, the task, the queue and the Inbox's GET say the ONE waiting line (never a recovery's 'Your Retry is saved'); the +11 min sweep posts nothing in that wait, so no send-again note stands beside Continue once the hold forms; Continue then answers M exactly once", async () => {
    const out = await drive("waiting-sweep", { partial: true, waitingSweep: true, holdSweep: true, actions: ["continue"] });
    expect(out.faults.length).toBeGreaterThan(0);
    const waiting = out.snapshots.waiting as Snapshot;
    // The automatic wait: R's box is not stopped, nothing started, M is parked.
    expect([waiting.providerTurns, waiting.carriers, waiting.answerCount, waiting.queue.state]).toEqual([0, [], 0, "deferred"]);
    // (f) The task and the queue say the ONE waiting line. Red at 1334565e: both said the gate's answer from BEFORE R's
    // file line read LOST, "Paperclip refused to recover the saved files because a safety check on them cannot pass.
    // Your Retry is saved." (the person sent a message, not a Retry; the gate's own next run says the waiting line).
    expect.soft(waiting.issue.executionBlocker, "(f) the task's ONE sentence in the automatic wait").toMatchObject({ nextAction: WAITING, savedMessageWait: "waiting" });
    expect.soft(waiting.queue.executionWait, "(f) the queue's wait line in the automatic wait").toMatchObject({ message: WAITING });
    expect.soft(JSON.stringify([waiting.issue.executionBlocker?.nextAction, waiting.queue.executionWait]), "(f) a recovery's Retry words for a message").not.toMatch(/Your Retry is saved|refused to recover/);
    // (c) The Inbox's task projection says what the task says: the SAME sentence, an automatic wait (nothing to press).
    for (const row of [inboxTask(waiting.inboxMine, out.ids.issueId), waiting.inboxRows.find((candidate: { id: string }) => candidate.id === out.ids.issueId)])
      expect.soft(row?.interruption?.savedMessageWait, "(c) the Inbox's GET says nothing of the wait").toEqual({ state: "waiting", line: WAITING });
    expect(waiting.inboxMine.failureRuns.map((run: { id: string }) => run.id)).toContain(out.ids.r);
    // (a) The +11 min sweep in that wait. Red at 1334565e: noticed 1, "... no run started ... Sending it again is safe".
    expect.soft(out.waitingSweep.noticed, "(a) +11min sweep in the automatic wait must not advise send-again").toBe(0);
    expect.soft(visibleNotes(out.snapshots["waiting-after-11min-sweep"]).filter(note => SEND_AGAIN.test(note)), "(a) notes beside the waiting line").toEqual([]);
    // The gate's own next run in the same state (box still not stopped) names this very wait, in the same words.
    const reran = out.snapshots["waiting-gate-reran"] as Snapshot;
    expect(reran.queue).toMatchObject({ state: "deferred", executionWait: { reason: "remote_cleanup", message: WAITING } });
    expect(reran.issue.executionBlocker).toMatchObject({ nextAction: WAITING, savedMessageWait: "waiting" });
    expect([reran.providerTurns, reran.carriers, reran.answerCount]).toEqual([0, [], 0]);
    // R's box stops (PLANTED BOX-STOPPED) and the hold forms: the partial sentence and Continue, with NO send-again
    // note beside them; the sweep during the hold adds none (F1).
    expectHeld(out.snapshots.hold);
    expect.soft(visibleNotes(out.snapshots.hold).filter(note => SEND_AGAIN.test(note)), "(a) notes beside Continue once the hold forms").toEqual([]);
    expect(out.holdSweep.noticed, "+11min hold sweep must not advise send-again").toBe(0);
    expect.soft(visibleNotes(out.snapshots["hold-after-11min-sweep"]).filter(note => SEND_AGAIN.test(note))).toEqual([]);
    expectHeld(out.snapshots["hold-after-11min-sweep"]);
    // Continue (the card's ONE action): exactly one run, M answered once.
    expect(out.presses[0]).toMatchObject({ action: "continue", status: 202, body: { accepted: true } });
    expectAnsweredOnce(out.snapshots["after-continue"]);
    expectAnsweredOnce(out.snapshots.final);
    expect.soft(visibleNotes(out.snapshots.final).filter(note => SEND_AGAIN.test(note))).toEqual([]);
    expect(out.checkout).toMatchObject({ ...SAVED, "notes.md": "R's new notes (unsaved)\n" });
    expect(out.errors).toEqual([]);
  }, 300_000);

  it("F1 HOLD-SWEEP: the REAL partial apply holds M; the +11 min sweep DURING the hold posts nothing (noticed 0; no send-again note, no 'wasn't answered' line); the card and the queue still say the partial sentence; Continue then answers M exactly once", async () => {
    const out = await drive("f1-hold-sweep", { partial: true, holdSweep: true, actions: ["continue", "continue-again"] });
    expect(out.faults.length).toBeGreaterThan(0);
    expect(out.faults.every((fault: { notes: string }) => fault.notes === "R's new notes (unsaved)\n")).toBe(true);
    expect(out.endedHash).not.toBe(out.savedHash);
    expectHeld(out.snapshots.hold);
    // rf-5's red at bf55be82: "+11min hold sweep must not advise send-again: expected 1 to be 0".
    expect(out.holdSweep.noticed, "+11min hold sweep must not advise send-again").toBe(0);
    const after = out.snapshots["hold-after-11min-sweep"] as Snapshot;
    expect(visibleNotes(after).filter(note => SEND_AGAIN.test(note))).toEqual([]);
    // The hold is still what the person reads, and nothing started.
    expectHeld(after);
    // Continue (the card's ONE action): exactly one run, M answered once; a second press starts nothing.
    expect(out.presses[0]).toMatchObject({ action: "continue", status: 202, body: { accepted: true } });
    expectAnsweredOnce(out.snapshots["after-continue"]);
    expectAnsweredOnce(out.snapshots.final);
    expect(visibleNotes(out.snapshots.final).filter(note => SEND_AGAIN.test(note))).toEqual([]);
    expect(out.checkout).toMatchObject({ ...SAVED, "notes.md": "R's new notes (unsaved)\n" });
    expect(out.errors).toEqual([]);
  }, 300_000);

  it("F1 CONTROL (the sweep is not weakened): the same message on the same kind of task with NO hold and no run -> the sweep waits out its grace, then at +11 min posts its no-run note exactly ONCE; a later sweep adds none", async () => {
    const { db } = context;
    const s = await liveScenario(context, { sharedProjectRoot: true });
    const h = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    try {
      // CONFIGURATION (named; a person's setting on the agent): its on-demand wake is switched off, so the real
      // comment route saves M and starts no run for it. No reply failed, nothing holds the task.
      const [agent] = await db.select().from(agents).where(eq(agents.id, s.agentId));
      await db.update(agents).set({ runtimeConfig: { ...(agent.runtimeConfig as Record<string, unknown>),
        heartbeat: { ...((agent.runtimeConfig as { heartbeat?: Record<string, unknown> }).heartbeat ?? {}), wakeOnDemand: false } } }).where(eq(agents.id, s.agentId));
      await s.say(M);
      await h.drainActiveRunExecutions();
      expect(await s.runs(), "no run started for M").toEqual([]);
      const issue = (await request(s.app).get(`/api/issues/${s.issueId}`)).body;
      expect(issue.executionBlocker ?? null, "no hold on this task").toBeNull();
      // NAMED CLOCK-SKIP: the sweep's clock only.
      const sweep = (minutes: number) => settleUnansweredPersonMessagesForTask(db, { companyId: s.companyId, issueId: s.issueId, now: new Date(Date.now() + minutes * 60_000) });
      const passes = [await sweep(0), await sweep(11), await sweep(12)];
      expect(passes.map(pass => pass.noticed), "the +11 min pass posts the note; the passes before and after post none").toEqual([0, 1, 0]);
      expect(await s.runs()).toEqual([]);
      const comments = (await request(s.app).get(`/api/issues/${s.issueId}/comments`)).body as Array<{ authorType: string; body: string }>;
      expect(comments.filter(comment => comment.authorType === "system").map(comment => comment.body)).toEqual([NO_RUN_NOTE]);
    } finally { await h.drainActiveRunExecutions(); }
  }, 300_000);

  it("F2 INBOX-PRESS: while M is held, the Inbox's own GET names the hold's ONE sentence and its ONE action for R's task; the press the Inbox row sends through the real route answers M exactly once; a second press starts nothing", async () => {
    const out = await drive("f2-inbox-press", { partial: true, actions: ["inbox", "inbox-again"] });
    const hold = out.snapshots.hold as Snapshot;
    expectHeld(hold);
    // The Inbox's GETs list R as the failed run of this task.
    expect(hold.inboxMine.failureRuns.map((run: { id: string }) => run.id)).toContain(out.ids.r);
    expect(hold.inboxRuns.map((run: { id: string }) => run.id)).toContain(out.ids.r);
    // The Inbox's task projection says what the task's card says: the SAME sentence, held for the SAME one action.
    for (const row of [inboxTask(hold.inboxMine, out.ids.issueId), hold.inboxRows.find((candidate: { id: string }) => candidate.id === out.ids.issueId)])
      expect.soft(row?.interruption?.savedMessageWait, "the Inbox's GET says nothing of the hold").toEqual({ state: hold.issue.executionBlocker.savedMessageWait, line: hold.issue.executionBlocker.nextAction });
    // rf-5's red at bf55be82: the Inbox press is accepted (202) and leaves M held, 0 runs.
    expect(out.presses[0]).toMatchObject({ action: "inbox", status: 202, body: { accepted: true } });
    expectAnsweredOnce(out.snapshots["after-inbox"]);
    // The press was the hold's ONE action, the same the card sends.
    expect(out.presses[0].sent).toMatchObject({ observedRunId: out.ids.r, retryAction: CONTINUE });
    // Once answered, the Inbox's GET no longer lists R: the row is gone, with its action.
    expect(out.snapshots["after-inbox"].inboxMine.failureRuns.map((run: { id: string }) => run.id)).not.toContain(out.ids.r);
    // A second press (the same row, still on a stale screen) starts nothing: still exactly one run and one reply.
    expect(out.presses[1]).toMatchObject({ action: "inbox-again", status: 200, body: { accepted: false, stale: true } });
    expect(out.presses[1].sent).toMatchObject({ observedRunId: out.ids.r, retryAction: CONTINUE });
    expectAnsweredOnce(out.snapshots["after-inbox-again"]);
    expectAnsweredOnce(out.snapshots.final);
    expect(out.snapshots.final.comments.filter((comment: { body: string }) => comment.body === PARTLY || comment.body === LINE)).toEqual([]);
    expect(out.errors).toEqual([]);
  }, 300_000);

  it("F2 CONTROL (an ordinary failed run, no message held): R's save failed for good and nobody waits -> the Inbox's GET names no hold and no Continue; its Retry stays the plain Retry", async () => {
    const out = await drive("f2-control-no-hold", { parkM: false });
    const state = out.snapshots.hold as Snapshot;
    expect(state.issue.executionBlocker?.savedMessageWait ?? null).toBeNull();
    expect(state.inboxMine.failureRuns.map((run: { id: string }) => run.id)).toContain(out.ids.r);
    const task = inboxTask(state.inboxMine, out.ids.issueId);
    expect(task.interruption).toMatchObject({ state: "failed", canRetry: true, observedRunId: out.ids.r });
    expect(task.interruption.savedMessageWait ?? null).toBeNull();
    expect(task.interruption.retryWait ?? null).toBeNull();
    expect(JSON.stringify(task.interruption)).not.toContain(CONTINUE);
    expect(JSON.stringify([state.inboxMine, state.inboxRows])).not.toContain(PARTLY);
    expect(state.inboxRows.find((row: { id: string }) => row.id === out.ids.issueId)?.interruption).toEqual(task.interruption);
  }, 300_000);
});
