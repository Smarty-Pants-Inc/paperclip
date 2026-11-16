import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { hasConfirmedSandboxStopAndRetain, prepareSupersededWarmSandboxStop, settleStopOnlyCleanup } from "../sandbox-stop-and-retain.js";
import { retiredSourceAuthorizesNativeBackupRestore } from "./native-retired-backup-source.js";

const describeDb = recoveryPostgresSupport.supported ? describe : describe.skip;

/**
 * SMA-67 / review-fleet-3 F1 on real PostgreSQL. The source row is produced by the
 * real owners: Cut A's stop-and-keep (`prepareSupersededWarmSandboxStop`, reason
 * `sandbox_source_changed`) and, for the settled state, the sweep's confirmed stop
 * (`settleStopOnlyCleanup`), which removes the intent and writes a reasonless receipt.
 */
describeDb("retired native backup source after an image swap", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startRecoveryPostgres("retired-backup-source-image-swap");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  const manifestSha256 = `sha256:${"b".repeat(64)}`;
  const completedAt = new Date("2026-11-05T05:02:50.000Z");

  async function imageSwap(options: { stop: "requested" | "confirmed"; currentImage?: string; sourceRun?: string;
    stampSha?: string; providerWorkAfterBackup?: boolean }) {
    const companyId = randomUUID(), agentId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const sourceRunId = randomUUID(), currentRunId = randomUUID(), environmentId = randomUUID();
    const sourceProviderLeaseId = randomUUID(), targetProviderLeaseId = randomUUID(), pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Image swap", issuePrefix: `I${companyId.slice(0, 5)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    for (const id of [sourceRunId, currentRunId]) await db.insert(heartbeatRuns).values({ id, companyId, agentId,
      status: id === sourceRunId ? options.sourceRun ?? "succeeded" : "running", runtimeMode: "native", nativeSessionId: sessionId,
      invocationSource: "assignment", triggerDetail: "system" });
    // The warm source the previous run left retained, booted from the old image.
    const [retained] = await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: sourceRunId,
      status: "retained", leasePolicy: "reuse_by_environment", provider: "daytona", providerLeaseId: sourceProviderLeaseId,
      cleanupStatus: null, metadata: { pluginId, sandboxProviderPlugin: true, agentId, image: "boat-image:old", sandboxState: "started",
        reusableSandboxLease: { version: 1, provider: "daytona", environmentId, adapterType: "paperclip_runner" },
        nativeHarnessBackup: { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: sessionId, runnerInstanceId,
          sessionScopeSha256: "a".repeat(64), sourceProviderLeaseId, authorizedProviderLeaseId: sourceProviderLeaseId,
          manifestSha256: options.stampSha ?? manifestSha256, completedAt: completedAt.toISOString() } } }).returning();
    // The current run's created lease (the claimed spare) records the image the environment boots now.
    await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: currentRunId, status: "active",
      leasePolicy: "reuse_by_environment", provider: "daytona", providerLeaseId: targetProviderLeaseId,
      metadata: { pluginId, sandboxProviderPlugin: true, agentId, image: options.currentImage ?? "boat-image:new",
        sandboxLeaseAcquisition: { outcome: "created" } } });
    // Cut A: obsolete source without verified custody is stopped and kept.
    const requested = await prepareSupersededWarmSandboxStop(db, retained!, { reason: "sandbox_source_changed" });
    expect(requested).toMatchObject({ status: "pending_cleanup",
      metadata: { sandboxStopAndRetain: { reason: "sandbox_source_changed", leaseId: retained!.id } } });
    let source = requested!;
    if (options.stop === "confirmed") {
      source = (await settleStopOnlyCleanup(db, requested!, { attemptId: String(requested!.metadata!.pendingCleanupAttemptId),
        receipt: { providerLeaseId: sourceProviderLeaseId, state: "stopped" } }))!;
      // The settled row: the intent (and its reason) is gone; the receipt carries no reason.
      expect(source.status).toBe("released");
      expect(source.metadata).not.toHaveProperty("sandboxStopAndRetain");
      expect(source.metadata?.sandboxStopAndRetainReceipt).not.toHaveProperty("reason");
      expect(hasConfirmedSandboxStopAndRetain(source)).toBe(true);
    }
    await db.insert(heartbeatRunEvents).values({ companyId, runId: sourceRunId, agentId, seq: 1, eventType: "turn.started",
      createdAt: new Date(completedAt.getTime() - 60_000) });
    if (options.providerWorkAfterBackup) {
      const [later] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
        nativeSessionId: sessionId, invocationSource: "automation", triggerDetail: "system" }).returning();
      await db.insert(heartbeatRunEvents).values({ companyId, runId: later!.id, agentId, seq: 1, eventType: "session.resumed",
        createdAt: new Date(completedAt.getTime() + 60_000) });
    }
    const input = { companyId, currentRunId, normalizedSessionId: sessionId, manifestSha256, targetProviderLeaseId,
      manifest: { sourceProviderLeaseId, runnerInstanceId, normalizedSessionId: sessionId } };
    const authorized = await retiredSourceAuthorizesNativeBackupRestore(db, input);
    const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, retained!.id));
    return { authorized, before: source, after: after!, currentRunId, targetProviderLeaseId };
  }

  it("restores after the sweep CONFIRMED the stop (released, reasonless receipt) and claims the source", async () => {
    const { authorized, after, currentRunId, targetProviderLeaseId } = await imageSwap({ stop: "confirmed" });
    expect(authorized).toBe(true);
    expect(after.status).toBe("released");
    expect(after.metadata).not.toHaveProperty("reusableSandboxLease");
    expect(after.metadata?.reusableSandboxLeaseSuperseded).toMatchObject({ manifestSha256,
      supersededByRunId: currentRunId, supersededByProviderLeaseId: targetProviderLeaseId });
  });

  it("restores on the stop INTENT, claims the source, and the sweep still settles the stop afterwards", async () => {
    const { authorized, after } = await imageSwap({ stop: "requested" });
    expect(authorized).toBe(true);
    expect(after.status).toBe("pending_cleanup");
    expect(after.metadata).not.toHaveProperty("reusableSandboxLease");
    expect(after.metadata?.reusableSandboxLeaseSuperseded).toMatchObject({ manifestSha256 });
    const settled = await settleStopOnlyCleanup(db, after, { attemptId: String(after.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId: after.providerLeaseId, state: "stopped" } });
    expect(settled).toMatchObject({ status: "released", metadata: { reusableSandboxLeaseSuperseded: { manifestSha256 } } });
    expect(hasConfirmedSandboxStopAndRetain(settled!)).toBe(true);
  });

  it.each([
    ["provider work followed the backup (confirmed stop)", { stop: "confirmed" as const, providerWorkAfterBackup: true }],
    ["the stamp names another backup (confirmed stop)", { stop: "confirmed" as const, stampSha: `sha256:${"c".repeat(64)}` }],
    ["provider work followed the backup (stop intent)", { stop: "requested" as const, providerWorkAfterBackup: true }],
    ["the stamp names another backup (stop intent)", { stop: "requested" as const, stampSha: `sha256:${"c".repeat(64)}` }],
    ["the stop intent's source still matches the current image", { stop: "requested" as const, currentImage: "boat-image:old" }],
    ["the stop intent's source run is still running", { stop: "requested" as const, sourceRun: "running" }],
  ])("refuses and leaves the source unclaimed when %s", async (_label, options) => {
    const { authorized, before, after } = await imageSwap(options);
    expect(authorized).toBe(false);
    expect(after).toEqual(before);
  });

  // Not this class: a released source with a confirmed stop whose image still
  // matches is an idle warm source (SMAA-143) and is restored under that proof.
  it("leaves a confirmed stop whose source still matches to the idle warm proof", async () => {
    const { authorized, after } = await imageSwap({ stop: "confirmed", currentImage: "boat-image:old" });
    expect(authorized).toBe(true);
    expect(after.metadata?.reusableSandboxLeaseSuperseded).toMatchObject({ manifestSha256 });
  });
});
