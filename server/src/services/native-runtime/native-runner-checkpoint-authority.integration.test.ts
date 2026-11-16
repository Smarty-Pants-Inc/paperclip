import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { completionContracts, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";

describeEmbeddedPostgres("checkpoint writer business-authority handover", () => {
  const environment = nativeRestartFixture();
  // REG-30 / trust boundary: idle cancellation is maintenance authority, not
  // a result and not permission for a cancelled turn to admit new work.
  it.each(["valid", "missing", "foreign_run", "foreign_session", "wrong_generation", "unacknowledged", "recovery_blocked", "new_work"] as const)(
    "fences retained-idle Stop checkpoint maintenance: %s", async scenario => {
      const { db, runId, issueId, native, preparedProfile } = await environment.seedRun(`IDLE-STOP-${scenario}`);
      const { companyId, successor, runtimeRoot } = environment.current;
      const leaseOwner = randomUUID();
      await db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
        leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
      const core = new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, runId), identity: {
        runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId, runId,
        normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId },
        expectedRunnerVersion: "fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      try {
        await registerNativeRunnerCheckpoint({ db, authority: core, bootId: successor.bootId, binding: { companyId, issueId, runId } });
        core.queueCommand("turn.start", { prompt: "work admitted before Stop" });
        await core.flushCheckpoint();
        const receipt = { schema: "paperclip.native-retained-idle-checkpoint.v1", companyId, issueId,
          runId: scenario === "foreign_run" ? randomUUID() : runId,
          sessionId: scenario === "foreign_session" ? randomUUID() : native.normalizedSessionId,
          bootId: successor.bootId, generation: scenario === "wrong_generation" ? 2 : 1 };
        await db.update(heartbeatRuns).set({ status: "cancelled", nativeSessionId: native.normalizedSessionId,
          runnerProfileJson: { ...preparedProfile, ...(scenario === "missing" ? {} : { nativeRetainedIdleCheckpoint: receipt }) },
          resultJson: { cancelledByActorType: "user", cancelledByUserId: "fixture-owner", nativeCancellation: {
            schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run", reasonCode: "cancellation_run_only",
            dispatchState: scenario === "unacknowledged" ? "pending" : "acknowledged", dispatched: true,
            intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } } }).where(eq(heartbeatRuns.id, runId));
        await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled",
          resultId: null, leaseOwner: null, leaseExpiresAt: null, recoveryState: scenario === "recovery_blocked" ? "blocked" : null })
          .where(eq(nativeRunFinalizations.runId, runId));
        if (scenario === "new_work") core.queueCommand("turn.start", { prompt: "cancelled owner must not admit this" });
        else core.issueBootstrapTicket();
        if (scenario === "valid") await expect(core.flushCheckpoint()).resolves.toBeUndefined();
        else await expect(core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
      } finally { await core.stop(); }
    });

  it("refreshes the source writer under the validated successor and refuses stale authority", async () => {
    const { db, runId, issueId, native } = await environment.seedRun("WRITER-HANDOVER");
    const { companyId, agentId, successor, runtimeRoot } = environment.current;
    const leaseOwner = randomUUID();
    await db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
      leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
    const core = new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, runId), identity: {
      runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId, runId,
      normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId },
      expectedRunnerVersion: "fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const register = (authorityRunId: string) => registerNativeRunnerCheckpoint({ db, authority: core,
      bootId: successor.bootId, binding: { companyId, issueId, runId }, authorityRunId });
    try {
      await register(runId);
      core.queueCommand("turn.start", { prompt: "first work" }); await core.flushCheckpoint();
      await register(runId);
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
        completionContractId: contract!.id, serverFingerprint: "writer-fixture", schemaStatus: "accepted", resultJson: { summary: "Completed" },
        canonicalSha256: "writer-fixture" }).returning();
      await db.update(nativeRunFinalizations).set({ resultId: result!.id, phase: "committed", leaseOwner: null,
        leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      core.issueBootstrapTicket();
      await expect(core.flushCheckpoint()).resolves.toBeUndefined(); // Same-fence registration kept its existing-work history.
      const runB = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runB, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running" });
      await db.insert(nativeRunFinalizations).values({ runId: runB, companyId, issueId, phase: "observed", controllerBootId: successor.bootId,
        controllerGeneration: 2, leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) });
      await db.update(issues).set({ executionRunId: runB }).where(eq(issues.id, issueId));
      await register(runB);
      core.queueCommand("turn.start", { prompt: "successor work" });
      await expect(core.flushCheckpoint()).resolves.toBeUndefined();
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 3, leaseOwner: randomUUID() })
        .where(eq(nativeRunFinalizations.runId, runB));
      core.queueCommand("turn.start", { prompt: "old generation must not write" });
      await expect(core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
      await expect(register(runB)).resolves.toBeUndefined();
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, runB));
      await expect(register(runB)).rejects.toThrow("native_runner_checkpoint_owner_lost");
      core.queueCommand("turn.start", { prompt: "expired owner must not write" });
      await expect(core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
    } finally { await core.stop(); }
  });
  // #20825 R-c: an idle warm session's run has FINISHED (result committed, no
  // business lease). When the server redials it, the control plane's welcome
  // (CP:4156-4186: connectionCount++, store.save(), then a checkpoint flush
  // before the frame is sent) must pass the owner fence, or the reconnect can
  // never authenticate. No new work is admitted by a welcome.
  it.each(["finished_idle", "foreign_execution_run"] as const)("R-c: a finished idle warm run's reconnect welcome flush: %s", async scenario => {
    const { db, runId, issueId, native } = await environment.seedRun(`IDLE-WARM-RECONNECT-${scenario}`);
    const { companyId, agentId, successor, runtimeRoot } = environment.current;
    await db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
      leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
    const core = new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, runId), identity: {
      runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId, runId,
      normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId },
      expectedRunnerVersion: "fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      await registerNativeRunnerCheckpoint({ db, authority: core, bootId: successor.bootId, binding: { companyId, issueId, runId } });
      core.queueCommand("turn.start", { prompt: "the turn that finished" });
      await core.flushCheckpoint();
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
        completionContractId: contract!.id, serverFingerprint: "idle-warm-fixture", schemaStatus: "accepted", resultJson: { summary: "Completed" },
        canonicalSha256: "idle-warm-fixture" }).returning();
      await db.update(nativeRunFinalizations).set({ resultId: result!.id, phase: "committed", leaseOwner: null,
        leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      if (scenario === "foreign_execution_run") {
        // The issue moved on to another run that holds no live controller.
        const other = randomUUID();
        await db.insert(heartbeatRuns).values({ id: other, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded" });
        await db.update(issues).set({ executionRunId: other }).where(eq(issues.id, issueId));
      } else {
        await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      }
      // The welcome's own write (connectionCount++, lastLease*, store.save())
      // is maintenance with no new work. issueBootstrapTicket() makes the same
      // kind of save through the public surface; the flush is what is fenced.
      core.issueBootstrapTicket();
      if (scenario === "finished_idle") await expect(core.flushCheckpoint()).resolves.toBeUndefined();
      else await expect(core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
    } finally { await core.stop(); }
  });
});
