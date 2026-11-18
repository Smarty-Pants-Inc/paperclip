import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { completionContracts, heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints, nativeRunResults } from "@paperclipai/db";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { loadNativeRunnerCheckpoint, registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";

// #20825 custody: a finished warm owner's connection-lease renewal flushes its
// checkpoint first. When the owner fence refuses that flush, the renewal must
// not touch the run's saved checkpoint, and the next message must still find
// the same session there. The fence breaks below are stand-ins: what made the
// live fence throw is being read separately and is not assumed here.
describeEmbeddedPostgres("finished warm owner checkpoint custody under a refused renewal flush", () => {
  const environment = nativeRestartFixture();

  it.each(["generation_moved", "task_moved_to_foreign_run"] as const)(
    "keeps the prior checkpoint rows byte-identical and resumable: %s", async fenceBreak => {
      const { db, runId, issueId, native } = await environment.seedRun(`CUSTODY-${fenceBreak}`);
      const { companyId, agentId, successor, runtimeRoot } = environment.current;
      const binding = { companyId, issueId, runId };
      await db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
        leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
      const core = new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, runId), identity: {
        runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId, runId,
        normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId },
        expectedRunnerVersion: "fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      const rows = () => db.select({ part: nativeRunnerCheckpoints.part, material: nativeRunnerCheckpoints.material,
        updatedAt: nativeRunnerCheckpoints.updatedAt }).from(nativeRunnerCheckpoints)
        .where(and(eq(nativeRunnerCheckpoints.companyId, companyId), eq(nativeRunnerCheckpoints.runId, runId)))
        .orderBy(asc(nativeRunnerCheckpoints.part)).then(found => JSON.stringify(found));
      try {
        await registerNativeRunnerCheckpoint({ db, authority: core, bootId: successor.bootId, binding });
        core.queueCommand("turn.start", { prompt: "the finished run's work" });
        await core.flushCheckpoint();
        // The run finishes with an accepted result; its warm owner stays retained.
        const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
        const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
          completionContractId: contract!.id, serverFingerprint: "custody-fixture", schemaStatus: "accepted",
          resultJson: { summary: "Completed" }, canonicalSha256: "custody-fixture" }).returning();
        await db.update(nativeRunFinalizations).set({ resultId: result!.id, phase: "committed", leaseOwner: null,
          leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
        core.issueBootstrapTicket();
        await expect(core.flushCheckpoint()).resolves.toBeUndefined();
        const prior = await rows();
        expect(JSON.parse(prior).length).toBeGreaterThan(0);

        if (fenceBreak === "generation_moved") {
          await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, runId));
        } else {
          const foreign = randomUUID();
          await db.insert(heartbeatRuns).values({ id: foreign, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running" });
          await db.update(issues).set({ executionRunId: foreign }).where(eq(issues.id, issueId));
        }
        // The renewal: the authority saves the extended lease, then flushes
        // before it may answer lease_renewed. The fence refuses the flush.
        core.issueBootstrapTicket();
        await expect(core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
        expect(await rows()).toBe(prior);

        // The next message restores this run's saved session from the same rows.
        const saved = await loadNativeRunnerCheckpoint(db, binding);
        expect(saved?.runId).toBe(runId);
        expect(saved?.recoveryEvidence.normalizedSessionId).toBe(native.normalizedSessionId);
        expect(saved?.recoveryEvidence.runnerInstanceId).toBe(native.runnerInstanceId);
        expect([...saved!.records.values()].some(value => value.includes("the finished run's work"))).toBe(true);
      } finally { await core.stop(); }
    });
});
