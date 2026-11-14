import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { completionContracts, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { registerNativeRunnerCheckpoint, restoreNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";

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

  it.each(["valid", "new_work", "wrong_boot", "wrong_generation", "no_result", "active_owner"] as const)(
    "reconnects only maintenance of the completed source checkpoint: %s", async scenario => {
      const { db, runId, issueId, native } = await environment.seedRun(`RECONNECT-MAINTENANCE-${scenario}`);
      const { companyId, successor, runtimeRoot } = environment.current;
      const root = join(runtimeRoot, runId), leaseOwner = randomUUID();
      await db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
        leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
      const options = { stateDirectory: join(root, "control-plane"), identity: { runnerInstanceId: native.runnerInstanceId,
        environmentLeaseId: native.environmentLeaseId, runId, normalizedSessionId: native.normalizedSessionId,
        turnId: native.turnId, itemId: native.itemId }, expectedRunnerVersion: "fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` };
      const original = new DurablePrpControlPlane(options);
      await registerNativeRunnerCheckpoint({ db, authority: original, bootId: successor.bootId, binding: { companyId, issueId, runId } });
      original.queueCommand("turn.start", { prompt: "historical work" }); await original.flushCheckpoint();
      await original.stop();
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
        completionContractId: contract!.id, serverFingerprint: "maintenance-fixture", schemaStatus: "accepted", resultJson: { summary: "Completed" },
        canonicalSha256: "maintenance-fixture" }).returning();
      await db.update(nativeRunFinalizations).set({ resultId: scenario === "no_result" ? null : result!.id, phase: "committed",
        leaseOwner: scenario === "active_owner" ? leaseOwner : null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      await restoreNativeRunnerCheckpoint(db, { companyId, issueId, runId }, root, native.normalizedSessionId);
      const recreated = new DurablePrpControlPlane(options);
      try {
        if (scenario === "new_work") recreated.queueCommand("turn.start", { prompt: "reconnected source must not dispatch this" });
        else {
          recreated.queueCommand("session.goal.get", {}); // RecoverSession's read is maintenance too.
          recreated.queueCommand("runner.suspend", { reason: "checkpoint before replacement" });
        }
        const register = () => registerNativeRunnerCheckpoint(Object.assign({ db, authority: recreated,
          bootId: scenario === "wrong_boot" ? randomUUID() : successor.bootId, binding: { companyId, issueId, runId } },
          { checkpointMaintenanceOnly: { generation: scenario === "wrong_generation" ? 2 : 1 } }));
        if (scenario === "valid") {
          await expect(register()).resolves.toBeUndefined();
          recreated.queueCommand("turn.start", { prompt: "not granted by maintenance registration" });
          await expect(recreated.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
        } else await expect(register()).rejects.toThrow("native_runner_checkpoint_owner_lost");
      } finally { await recreated.stop(); }
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
});
