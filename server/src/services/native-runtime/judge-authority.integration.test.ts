import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints, heartbeatRunEvents } from "@paperclipai/db";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeCheckpointRetirement } from "./native-runner-checkpoint-retirement.js";

// Independent adversarial trust-boundary probes. Real PostgreSQL and production
// writer/port; fixture seeds a receipt, so these do NOT certify its issuer.
describeEmbeddedPostgres("RFL retained-idle authority", () => {
  const environment = nativeRestartFixture();
  async function setup(label: string, withReceipt = true) {
    const fixture = await environment.seedRun(`RFL-${label}`);
    const { db, runId, issueId, native, preparedProfile } = fixture;
    const { companyId, agentId, successor, runtimeRoot } = environment.current;
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: successor.bootId, generation: 1, leaseOwner: randomUUID() };
    await db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId, controllerGeneration: owner.generation,
      leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
    const core = new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, runId), identity: {
      runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId, runId,
      normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId },
      expectedRunnerVersion: "fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    await registerNativeRunnerCheckpoint({ db, authority: core, bootId: owner.bootId, binding: { companyId, issueId, runId } });
    core.queueCommand("turn.start", { prompt: "already admitted work" });
    await core.flushCheckpoint();
    const receipt = { schema: "paperclip.native-retained-idle-checkpoint.v1", companyId, issueId, runId,
      sessionId: native.normalizedSessionId, bootId: owner.bootId, generation: owner.generation };
    await db.update(heartbeatRuns).set({ status: "cancelled", nativeSessionId: native.normalizedSessionId,
      runnerProfileJson: { ...preparedProfile, ...(withReceipt ? { nativeRetainedIdleCheckpoint: receipt } : {}) },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "judge", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run", reasonCode: "cancellation_run_only",
        dispatchState: "acknowledged", dispatched: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } } })
      .where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled",
      resultId: null, leaseOwner: null, leaseExpiresAt: null, recoveryState: null }).where(eq(nativeRunFinalizations.runId, runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId: run.nativeSessionId!,
      completionContractId: run.completionContractId!, completionContractSha256: run.completionContractSha256!,
      sourceInstanceId: run.runnerInstanceId!, controlPlaneSourceInstanceId: randomUUID() }, {
      nativeRecovery: { owner, compatibility: { configDigest: `sha256:${"a".repeat(64)}`, processConfigDigest: null } },
    });
    return { ...fixture, core, owner, port, companyId, agentId, run };
  }

  it("permits idle maintenance only as a positive control", async () => {
    const f = await setup("maintenance");
    try { f.core.issueBootstrapTicket(); await expect(f.core.flushCheckpoint()).resolves.toBeUndefined(); }
    finally { await f.core.stop(); }
  });

  it("refuses new work after retained Stop", async () => {
    const f = await setup("new-work");
    try { f.core.queueCommand("turn.start", { prompt: "forbidden new work" });
      await expect(f.core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost"); }
    finally { await f.core.stop(); }
  });

  it.each([true, false])("cannot commit a result for cancelled run (receipt=%s)", async withReceipt => {
    const f = await setup(`result-${withReceipt}`, withReceipt);
    try {
      let rejected: unknown;
      try { await f.port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL }); }
      catch (error) { rejected = error; }
      const rows = await f.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
      const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      console.log("RFL_RESULT_PROBE", JSON.stringify({ withReceipt, rejection: String(rejected), resultCount: rows.length,
        phase: coordinator.phase, resultId: coordinator.resultId, runId: f.runId }));
      expect(rows, "maintenance authority must not mint a semantic result").toHaveLength(0);
      expect(rejected).toBeInstanceOf(Error);
    } finally { await f.core.stop(); }
  });

  it.each(["same-boot", "different-boot"])("refuses old writer after successor on a different runner: %s", async mode => {
    const f = await setup(`successor-${mode}`);
    try {
      const runB = randomUUID(), runnerB = randomUUID();
      await f.db.insert(heartbeatRuns).values({ id: runB, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, runtimeMode: "native", status: "running", runnerInstanceId: runnerB });
      await f.db.insert(nativeRunFinalizations).values({ runId: runB, companyId: f.companyId, issueId: f.issueId,
        phase: "observed", controllerBootId: mode === "same-boot" ? f.owner.bootId : randomUUID(),
        controllerGeneration: 1, leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) });
      await f.db.update(issues).set({ executionRunId: runB }).where(eq(issues.id, f.issueId));
      f.core.issueBootstrapTicket();
      let rejected: unknown;
      try { await f.core.flushCheckpoint(); } catch (error) { rejected = error; }
      console.log("RFL_SUCCESSOR_PROBE", JSON.stringify({ mode, rejection: String(rejected), oldRun: f.runId, newRun: runB, runnerB }));
      expect(rejected, "a successor on another runner must fence the old idle authority").toBeInstanceOf(Error);
    } finally { await f.core.stop(); }
  });

  it("cannot append an event into the NEXT run", async () => {
    const f = await setup("next-event");
    try {
      const next = randomUUID();
      await expect(f.port.appendEvent({ schema: "paperclip.prp.event.v1", schemaVersion: 1,
        sourceEventId: randomUUID(), sourceSeq: 1, sourceInstanceId: f.native.runnerInstanceId, sourceKind: "runner",
        runId: next, normalizedSessionId: f.native.normalizedSessionId, turnId: f.native.turnId, itemId: f.native.itemId,
        eventType: "turn.completed", priority: 0, emittedAt: new Date().toISOString(), payload: {} }))
        .rejects.toThrow("native_event_binding_mismatch");
      expect(await f.db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next))).toHaveLength(0);
    } finally { await f.core.stop(); }
  });

  it("refuses flush after checkpoint retirement", async () => {
    const f = await setup("retirement");
    try {
      await f.db.update(nativeRunnerCheckpoints).set({ material: nativeCheckpointRetirement({ companyId: f.companyId,
        agentId: f.agentId, sessionId: f.native.normalizedSessionId, runIds: [f.runId] }) })
        .where(eq(nativeRunnerCheckpoints.runId, f.runId));
      f.core.issueBootstrapTicket();
      await expect(f.core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_retired");
    } finally { await f.core.stop(); }
  });

  it("refuses flush after controller generation revocation", async () => {
    const f = await setup("generation");
    try {
      await f.db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      f.core.issueBootstrapTicket();
      await expect(f.core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
    } finally { await f.core.stop(); }
  });
});
