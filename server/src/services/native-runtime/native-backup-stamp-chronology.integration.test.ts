import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createReusableLeaseHandoff } from "../environment-lease-handoff.js";
import type { NativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { retiredSourceAuthorizesNativeBackupRestore } from "./native-retired-backup-source.js";

// Keep: data safety and the restore-authority trust boundary. Timestamp ties
// cannot select a checkpoint arbitrarily or mutate an idle source's reuse scope.
const describeDb = recoveryPostgresSupport.supported ? describe : describe.skip;
describeDb("native backup checkpoint chronology and ambiguity", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startRecoveryPostgres("backup-chronology");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(options: {
    stamps: (stamp: NativeHarnessBackupStamp) => Array<Partial<NativeHarnessBackupStamp> | null>;
    idle?: boolean;
    providerEventAt?: string;
  }) {
    const companyId = randomUUID(), agentId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const environmentId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const providerLeaseId = randomUUID(), currentRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Checkpoint chronology fixture", issuePrefix: `T${companyId.slice(0, 5)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chronology fixture", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Checkpoint chronology" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Checkpoint chronology workspace" });
    const runs = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [...runs, currentRunId]) await db.insert(heartbeatRuns).values({ id, companyId, agentId,
      status: id === currentRunId ? "running" : "succeeded", runtimeMode: "native", nativeSessionId: sessionId,
      invocationSource: "assignment", triggerDetail: "system" });
    const stamp: NativeHarnessBackupStamp = { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: sessionId,
      runnerInstanceId, sessionScopeSha256: "a".repeat(64), sourceProviderLeaseId: providerLeaseId,
      authorizedProviderLeaseId: providerLeaseId, manifestSha256: `sha256:${"b".repeat(64)}`, completedAt: "2026-11-13T12:00:30.000Z" };
    const stamps = options.stamps(stamp);
    const start = Date.parse("2026-11-13T12:00:00.000Z");
    const history: Array<typeof environmentLeases.$inferInsert> = runs.map((heartbeatRunId, index) => ({
      id: randomUUID(), companyId, heartbeatRunId, environmentId, issueId, executionWorkspaceId: workspaceId,
      provider: "daytona", providerLeaseId, leasePolicy: "reuse_by_environment", status: "expired", cleanupStatus: "success",
      acquiredAt: new Date(start + index * 60_000), releasedAt: new Date(start + (index + 1) * 60_000),
      metadata: { agentId, ...(stamps[index] === null ? {} : { nativeHarnessBackup: { ...stamp, ...stamps[index] } }) },
    }));
    for (let index = 1; index < history.length; index++) {
      const previous = history[index - 1]!, current = history[index]!;
      const handoff = createReusableLeaseHandoff(previous as typeof environmentLeases.$inferSelect,
        current as typeof environmentLeases.$inferSelect);
      previous.metadata = { ...previous.metadata, reusableLeaseSuccessor: handoff };
      current.metadata = { ...current.metadata, reusableLeasePredecessor: handoff };
    }
    const tip = history[2]!;
    tip.metadata = { ...tip.metadata, ...(options.idle
      ? { reusableSandboxLease: { version: 1, provider: "daytona" } }
      : { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId,
          runId: tip.heartbeatRunId, leaseId: tip.id, provider: "daytona", providerLeaseId,
          state: "destroyed", confirmedAt: new Date(start + 180_000).toISOString() } }) };
    if (options.idle) tip.status = "released";
    await db.insert(environmentLeases).values(history);
    if (options.providerEventAt) await db.insert(heartbeatRunEvents).values({ companyId, runId: runs[0]!, agentId,
      seq: 1, eventType: "session.resumed", createdAt: new Date(options.providerEventAt) });
    const authorized = await retiredSourceAuthorizesNativeBackupRestore(db, { companyId, currentRunId, normalizedSessionId: sessionId,
      manifest: { sourceProviderLeaseId: providerLeaseId, runnerInstanceId, normalizedSessionId: sessionId },
      manifestSha256: stamp.manifestSha256, targetProviderLeaseId: randomUUID() });
    const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, tip.id!));
    return { authorized, tip: after! };
  }

  it.each([false, true])("accepts identical latest stamps (idle=%s)", async (idle) => {
    const result = await fixture({ stamps: () => [{}, {}, {}], idle });
    expect(result.authorized).toBe(true);
    if (idle) expect(result.tip.metadata).toHaveProperty("reusableSandboxLeaseSuperseded");
  });

  it.each([
    ["manifestSha256", `sha256:${"c".repeat(64)}`],
    ["normalizedSessionId", "another-session"],
    ["runnerInstanceId", "another-runner"],
    ["sessionScopeSha256", "d".repeat(64)],
    ["sourceProviderLeaseId", "another-source"],
  ] as const)("refuses tied latest stamps differing in %s without supersession", async (key, value) => {
    const result = await fixture({ stamps: () => [{}, { [key]: value }, null], idle: true });
    expect(result.authorized).toBe(false);
    expect(result.tip.metadata).toHaveProperty("reusableSandboxLease");
    expect(result.tip.metadata).not.toHaveProperty("reusableSandboxLeaseSuperseded");
  });

  it("compares completion instants rather than timestamp spelling or owner order", async () => {
    const result = await fixture({ stamps: () => [{}, { manifestSha256: `sha256:${"c".repeat(64)}`,
      completedAt: "2026-11-13T13:00:30.000+01:00" }, null] });
    expect(result.authorized).toBe(false);
  });

  it("uses the latest first-owner checkpoint instead of an older conflicting tip checkpoint", async () => {
    const result = await fixture({ stamps: () => [{}, null, { manifestSha256: `sha256:${"c".repeat(64)}`,
      completedAt: "2026-11-13T12:00:10.000Z" }] });
    expect(result.authorized).toBe(true);
  });

  it("does not let conflicting older ties poison a unique latest checkpoint", async () => {
    const result = await fixture({ stamps: () => [{ completedAt: "2026-11-13T12:00:10.000Z" },
      { manifestSha256: `sha256:${"c".repeat(64)}`, completedAt: "2026-11-13T12:00:10.000Z" }, {}] });
    expect(result.authorized).toBe(true);
  });

  it.each(["normalizedSessionId", "runnerInstanceId"] as const)("never filters away a newer wrong %s", async (key) => {
    const result = await fixture({ stamps: () => [{ [key]: "different", completedAt: "2026-11-13T12:00:45.000Z" }, {}, null] });
    expect(result.authorized).toBe(false);
  });

  it("fences provider work after the chronologically latest checkpoint", async () => {
    const result = await fixture({ stamps: () => [{}, null, { completedAt: "2026-11-13T12:00:10.000Z" }],
      providerEventAt: "2026-11-13T12:00:40.000Z" });
    expect(result.authorized).toBe(false);
  });
});
