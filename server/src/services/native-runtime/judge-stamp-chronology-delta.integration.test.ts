import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createReusableLeaseHandoff } from "../environment-lease-handoff.js";
import { retiredSourceAuthorizesNativeBackupRestore } from "./native-retired-backup-source.js";

// Independent supplemental tests. The seven supplied RFL tests remain byte-identical.
// Keep: recorded SMAA-143 regression plus data-safety/trust-boundary proof.
const describeDb = recoveryPostgresSupport.supported ? describe : describe.skip;
describeDb("RFL C9 newly admitted chronology delta (unstamped tip)", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startRecoveryPostgres("rfl-c9-smaa143");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(options: { newerPredecessor?: boolean; idle?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const environmentId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), currentRunId = randomUUID();
    const providerLeaseId = "bx_4np79mj7";
    const completedAt = "2026-11-13T17:29:16.000Z";
    // Only the production digest prefix and lease-ID prefixes were supplied.
    // Remaining bytes, intermediate owner IDs and times are fixture data, NOT a prod export.
    const manifestSha256 = `sha256:37e2f${"a".repeat(59)}`;
    const start = Date.parse(completedAt) - 30_000;
    await db.insert(companies).values({ id: companyId, name: "RFL SMAA-143 fixture", issuePrefix: `C${companyId.slice(0, 5)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "SMAA-143 fixture", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(issues).values({ id: issueId, companyId, title: "SMAA-143" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "SMAA-143 workspace" });
    const runs = Array.from({ length: 12 }, () => randomUUID());
    for (const [index, id] of [...runs, currentRunId].entries()) await db.insert(heartbeatRuns).values({ id, companyId, agentId,
      status: id === currentRunId ? "running" : index === 11 ? "failed" : "succeeded", runtimeMode: "native", nativeSessionId: sessionId,
      invocationSource: "assignment", triggerDetail: "system" });
    const stamp = { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: sessionId,
      runnerInstanceId, sessionScopeSha256: "c".repeat(64), sourceProviderLeaseId: providerLeaseId,
      authorizedProviderLeaseId: providerLeaseId, manifestSha256, completedAt };
    const history: Array<typeof environmentLeases.$inferInsert> = runs.map((heartbeatRunId, index) => ({
      id: index === 0 ? `0a251f64${randomUUID().slice(8)}` : index === 11 ? `2fc8c3b6${randomUUID().slice(8)}` : randomUUID(),
      companyId, heartbeatRunId, environmentId, issueId, executionWorkspaceId: workspaceId,
      provider: "daytona", providerLeaseId, leasePolicy: "reuse_by_environment", status: index === 11 ? "released" : "expired",
      cleanupStatus: "success", acquiredAt: new Date(start + index * 60_000), releasedAt: new Date(start + (index + 1) * 60_000),
      metadata: { agentId },
    }));
    for (let index = 1; index < history.length; index++) {
      const previous = history[index - 1]!, current = history[index]!;
      const proof = createReusableLeaseHandoff(previous as typeof environmentLeases.$inferSelect,
        current as typeof environmentLeases.$inferSelect);
      previous.metadata = { ...previous.metadata, reusableLeaseSuccessor: proof };
      current.metadata = { ...current.metadata, reusableLeasePredecessor: proof };
    }
    history[0]!.metadata!.nativeHarnessBackup = stamp;
    const tip = history[11]!;
    const pluginId = randomUUID(), confirmedAt = new Date(start + 12 * 60_000).toISOString();
    tip.metadata = { ...tip.metadata, pluginId, reusableSandboxLease: { version: 1, provider: "daytona" },
      remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId,
        runId: tip.heartbeatRunId, leaseId: tip.id, provider: "daytona", providerLeaseId, state: "stopped", confirmedAt },
      sandboxStopAndRetainReceipt: { schema: "paperclip.sandbox-stop-and-retain-receipt.v1", requestId: randomUUID(),
        companyId, runId: tip.heartbeatRunId, leaseId: tip.id, provider: "daytona", providerLeaseId, pluginId,
        method: "environmentStopLease", confirmedAt } };
    if (options.newerPredecessor) {
      // Older A on a later owner; newer B on a verified earlier owner. Both stamps
      // complete before their owners release. Owner order alone is not timestamp order.
      history[10]!.metadata!.nativeHarnessBackup = stamp;
      // Tip is unstamped: C8 refuses. C9 now examines this middle owner and must
      // still refuse because the first owner's checkpoint completed later.
      history[0]!.metadata!.nativeHarnessBackup = { ...stamp, manifestSha256: `sha256:${"b".repeat(64)}`,
        completedAt: new Date(start + 45_000).toISOString() };
      if (!options.idle) {
        tip.status = "expired";
        tip.metadata.remoteExecutionTermination = { ...(tip.metadata.remoteExecutionTermination as object), state: "destroyed" };
        delete tip.metadata.reusableSandboxLease;
        delete tip.metadata.sandboxStopAndRetainReceipt;
      }
    }
    await db.insert(environmentLeases).values(history);
    await db.insert(heartbeatRunEvents).values({ companyId, runId: runs[0]!, agentId, seq: 1, eventType: "turn.started",
      createdAt: new Date(start + 1_000) });
    const rows = () => db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId));
    const input = { companyId, currentRunId, normalizedSessionId: sessionId,
      manifest: { sourceProviderLeaseId: providerLeaseId, runnerInstanceId, normalizedSessionId: sessionId },
      manifestSha256, targetProviderLeaseId: randomUUID() };
    return { gate: () => retiredSourceAuthorizesNativeBackupRestore(db, input), rows, completedAt, manifestSha256 };
  }

  it("continues to authorize the sole first-owner SMAA-143 checkpoint", async () => {
    const f = await fixture();
    const before = await f.rows();
    expect(before).toHaveLength(12);
    expect(before.every(row => row.providerLeaseId === "bx_4np79mj7")).toBe(true);
    const stamped = before.filter(row => row.metadata?.nativeHarnessBackup);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.id.startsWith("0a251f64")).toBe(true);
    expect(stamped[0]!.metadata!.nativeHarnessBackup).toMatchObject({ completedAt: f.completedAt, manifestSha256: f.manifestSha256 });
    const tip = before.find(row => row.id.startsWith("2fc8c3b6"))!;
    expect(tip.metadata).not.toHaveProperty("nativeHarnessBackup");
    expect(before.filter(row => row.metadata?.reusableLeaseSuccessor)).toHaveLength(11);
    const [tipRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, tip.heartbeatRunId!));
    expect(tipRun!.status).toBe("failed");
    expect(await f.gate()).toBe(true);
    const after = await f.rows();
    const superseded = after.filter(row => row.metadata?.reusableSandboxLeaseSuperseded);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.id).toBe(tip.id);
  });

  it("refuses older matching middle-owner A when first-owner B is chronologically newer and the destroyed tip is unstamped", async () => {
    const f = await fixture({ newerPredecessor: true });
    expect(await f.gate()).toBe(false);
  });

  it("refuses older matching middle-owner A without idle-tip supersession when first-owner B is chronologically newer and the tip is unstamped", async () => {
    const f = await fixture({ newerPredecessor: true, idle: true });
    expect.soft(await f.gate()).toBe(false);
    const tip = (await f.rows()).find(row => row.id.startsWith("2fc8c3b6"))!;
    expect.soft(tip.metadata).toHaveProperty("reusableSandboxLease");
    expect.soft(tip.metadata).not.toHaveProperty("reusableSandboxLeaseSuperseded");
  });
});
