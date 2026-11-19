// Import first: installs the named sandbox/provider injections, not a mock executor.
import { box, liveScenario, openClassicLiveContext, resetClassicLiveBox } from "../../__tests__/helpers/classic-live-scenario.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues,
  nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { deliverExecutionStatuses } from "../execution-status-delivery.js";
import { buildIssueMonitorTriggeredPatch, normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { heartbeatService } from "../heartbeat.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("native terminal status projection", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-terminal-status-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    await deliverExecutionStatuses(db, { publish: vi.fn() });
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Monitor status", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved check", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await authority.execute({ tool: "set_task_monitor", callId: randomUUID(), arguments: {
      idempotencyKey: "saved-monitor", monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString(), notes: "Check the saved result." },
    } });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", criteria: [] }, canonicalSha256: randomUUID(),
      createdByActorType: "system", createdByActorId: "test" });
    const accepted = { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
      summary: "Wait for the saved check.", completionClaim: { contractRevision: "test", objectiveSatisfied: false,
        criteria: [], remainingWork: [{ description: "Check again", blocksCompletion: true }] },
      continuation: { kind: "monitor", summary: "Wait for the check", idempotencyKey: "provider-selected" },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } };
    const finishedAt = new Date("2020-01-01T00:00:00Z");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt, completionContractId: contractId }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), canonicalSha256: randomUUID(), schemaStatus: "accepted", resultJson: accepted });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "retryable_failure", resultId });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.update(issues).set({ ...buildIssueMonitorTriggeredPatch({ issue: task!,
      policy: normalizeIssueExecutionPolicy(task!.executionPolicy), triggeredAt: new Date() }), executionRunId: null, checkoutRunId: null,
    }).where(eq(issues.id, issueId));
    const finalize = () => finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const read = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
    return { runId, companyId, issueId, finishedAt, resultId, accepted, finalize, read };
  }

  it("preserves the original completion time while retrying an accepted monitor result", async () => {
    const f = await fixture();
    await f.finalize();
    expect((await f.read()).finishedAt).toEqual(f.finishedAt);
    await f.finalize();
    expect((await f.read()).finishedAt).toEqual(f.finishedAt);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "retryable_failure", failureCode: "monitor_wait_authority_lost", resultId: f.resultId });
    expect(coordinator.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, f.resultId)))[0].resultJson).toEqual(f.accepted);
  });

  it("retains an unacknowledged status delivery across unchanged finalization retries", async () => {
    const f = await fixture();
    await f.finalize();
    const before = await f.read();
    expect(before.executionStatusDeliveryId).toBeTruthy();
    await f.finalize();
    expect((await f.read()).executionStatusDeliveryId).toBe(before.executionStatusDeliveryId);
    const publish = vi.fn();
    await expect(deliverExecutionStatuses(db, { publish, failpoint: () => { throw new Error("after publish"); } })).rejects.toThrow("after publish");
    await f.finalize();
    expect((await f.read()).executionStatusDeliveryId).toBe(before.executionStatusDeliveryId);
    await deliverExecutionStatuses(db, { publish });
    const deliveries = publish.mock.calls.filter(([event]) => event.payload.runId === f.runId);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0][0].payload.deliveryId).toBe(deliveries[1][0].payload.deliveryId);
  });

  it("preserves a pending status notification created by another producer", async () => {
    const f = await fixture();
    await f.finalize();
    const newer = randomUUID();
    await db.update(heartbeatRuns).set({ executionStatusDeliveryId: newer }).where(eq(heartbeatRuns.id, f.runId));
    await f.finalize();
    expect((await f.read()).executionStatusDeliveryId).toBe(newer);
  });

  it("broadcasts a changed terminal projection after acknowledgement (status)", async () => {
    // REAL producers: comments route -> queue/claim -> heartbeat executor -> its own
    // failure write, then finalizeNativeRun commits the accepted result.
    // SCRIPTED: provider turn accepts via PaperclipControlPlanePort, then reports
    // EXECUTOR-FAILS (as K12 EXECUTOR-FAILED); CLASSIC-STALL-1 holds teardown until
    // the accepted result is pending. PLANTED: harness company/user/task/environment
    // configuration only; no terminal run, accepted result or finalization row.
    const context = await openClassicLiveContext("terminal-status-executor-");
    const s = await liveScenario(context);
    const heartbeat = heartbeatService(context.db, { nativeSessionBackendFactory: () => ({}) as never });
    const errors: unknown[] = [];
    const delivery = createDeliveryWorkCoordinator({ owner: context.db, canRun: () => true, onError: error => errors.push(error) });
    const receipts = heartbeat.registerDeferredReceiptWork(delivery, () => true);
    const failure = { errorCode: "provider_transport_failed", errorMessage: "provider_transport_failed: runner did not durably suspend before checkpoint" };
    const providerTurn = box.session!;
    let turns = 0;
    box.session = async input => {
      const result = await providerTurn(input);
      return ++turns === 2 ? { exitCode: 1, signal: null, timedOut: false, ...failure } : result;
    };
    try {
      await receipts.ready;
      await s.say("Please write the report.");
      await vi.waitFor(async () => {
        await heartbeat.resumeQueuedRuns();
        await reconcileNativeFinalizations(context.db, (await s.runs()).map(run => run.id), { environmentRuntime: {} as never });
        expect((await s.runs())[0]).toMatchObject({ status: "succeeded" });
      }, { timeout: 60_000, interval: 250 });
      await heartbeat.drainActiveRunExecutions();
      await s.say("Please rewrite the report.");
      let stalled = false;
      void s.stallReached.then(() => { stalled = true; });
      await vi.waitFor(async () => {
        await heartbeat.resumeQueuedRuns();
        expect(stalled).toBe(true);
      }, { timeout: 60_000, interval: 250 });
      const runId = (await s.runs())[1].id;
      const read = async () => (await context.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
      const coordinator = async () => (await context.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!;
      expect(await coordinator()).toMatchObject({ phase: "workspace_finalizing", resultId: expect.any(String) });
      s.releaseStall();
      await heartbeat.drainActiveRunExecutions();
      const ended = await read();
      expect(ended).toMatchObject({ status: "failed", errorCode: failure.errorCode, error: failure.errorMessage, finishedAt: expect.any(Date) });
      expect((await coordinator()).phase).not.toBe("committed");
      // NAMED INJECTION: report an unsuccessful workspace barrier to the real
      // finalizer, publishing the failed projection while its result is pending.
      await finalizeNativeRun({ db: context.db, runId, workspaceFinalizeStatus: "failed", projectRunStatus: true });
      const publish = vi.fn();
      await deliverExecutionStatuses(context.db, { publish });
      expect((await read()).executionStatusDeliveryId).toBeNull();
      // The real finalizer now commits with the successful workspace barrier
      // (R's actual teardown saved its files). It changes the terminal projection,
      // not the failed executor's truthful status/error/end time (K12).
      await finalizeNativeRun({ db: context.db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect(await coordinator()).toMatchObject({ phase: "committed" });
      expect(await read()).toMatchObject({ status: "failed", errorCode: ended.errorCode, error: ended.error, finishedAt: ended.finishedAt,
        resultJson: { endedRunKept: { schema: "paperclip.ended-run-kept.v1", status: "failed" }, finalizationPhase: "committed" } });
      await deliverExecutionStatuses(context.db, { publish });
      const notifications = publish.mock.calls.filter(([event]) => event.payload.runId === runId);
      expect(notifications).toHaveLength(2);
      expect(notifications.map(([event]) => event.payload.status)).toEqual(["failed", "failed"]);
      expect(notifications[1][0].payload.deliveryId).not.toBe(notifications[0][0].payload.deliveryId);
      await reconcileNativeFinalizations(context.db, [runId], { environmentRuntime: {} as never });
      await deliverExecutionStatuses(context.db, { publish });
      expect(publish.mock.calls.filter(([event]) => event.payload.runId === runId)).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      s.releaseStall(); receipts.stop?.(); await delivery.stop();
      await heartbeat.drainActiveRunExecutions();
      resetClassicLiveBox(); await context.close();
    }
  }, 180_000);

  it.each(["metadata", "missing_completion_time"])("broadcasts a changed terminal projection after acknowledgement (%s)", async change => {
    const f = await fixture();
    await f.finalize();
    const publish = vi.fn();
    await deliverExecutionStatuses(db, { publish });
    if (change === "metadata") {
      await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "failed", projectRunStatus: true });
      expect((await f.read()).resultJson?.workspaceFinalizeStatus).toBe("failed");
    } else {
      // PLANTED: a legacy terminal row missing its completion time (repair coverage).
      await db.update(heartbeatRuns).set({ finishedAt: null })
        .where(eq(heartbeatRuns.id, f.runId));
      await f.finalize();
      expect(await f.read()).toMatchObject({ status: "succeeded", finishedAt: expect.any(Date) });
    }
    await deliverExecutionStatuses(db, { publish });
    expect(publish.mock.calls.filter(([event]) => event.payload.runId === f.runId)).toHaveLength(2);
  });

  it("does not broadcast an unchanged terminal projection after acknowledgement or a new DB client", async () => {
    const f = await fixture();
    await f.finalize();
    const publish = vi.fn();
    await deliverExecutionStatuses(db, { publish });
    await f.finalize();
    await deliverExecutionStatuses(db, { publish });
    const reopened = createDb(temporary.connectionString);
    try {
      await finalizeNativeRun({ db: reopened, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      await deliverExecutionStatuses(reopened, { publish });
    } finally { await reopened.$client.end(); }
    expect(publish.mock.calls.filter(([event]) => event.payload.runId === f.runId)).toHaveLength(1);
    expect((await f.read()).executionStatusDeliveryId).toBeNull();
  });
});
