import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createReusableLeaseHandoff } from "../environment-lease-handoff.js";
import { retiredSourceAuthorizesNativeBackupRestore } from "./native-retired-backup-source.js";

// Independent RFL cases, not edits to the builder's test or expectations.
// Keep reason: trust boundary/data safety. An available older manifest must not
// win by skipping evidence of a newer backup on the same verified owner chain.
const describeDb = recoveryPostgresSupport.supported ? describe : describe.skip;
describeDb("RFL independent backup freshness", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startRecoveryPostgres("rfl-stamp-freshness");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  async function setup(options: {
    newerAt?: "tip" | "middle";
    idle?: boolean;
    laterProviderWork?: boolean;
    wrongSession?: boolean;
    foreignAllocation?: boolean;
  } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const environmentId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const providerLeaseId = randomUUID(), currentRunId = randomUUID();
    const oldSha = `sha256:${"a".repeat(64)}`, newSha = `sha256:${"b".repeat(64)}`;
    const start = Date.parse("2026-11-13T12:00:00Z");
    const oldCompleted = new Date(start + 30_000).toISOString();
    const newCompleted = new Date(start + 150_000).toISOString();
    await db.insert(companies).values({ id: companyId, name: "RFL isolated data-safety fixture", issuePrefix: `J${companyId.slice(0, 5)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "RFL fixture", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Checkpoint freshness gate" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "RFL fixture workspace" });
    const runs = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [...runs, currentRunId]) await db.insert(heartbeatRuns).values({ id, companyId, agentId,
      status: id === currentRunId ? "running" : "succeeded", runtimeMode: "native", nativeSessionId: sessionId,
      invocationSource: "assignment", triggerDetail: "system" });
    const stamp = { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: sessionId,
      runnerInstanceId, sessionScopeSha256: "c".repeat(64), sourceProviderLeaseId: providerLeaseId,
      authorizedProviderLeaseId: providerLeaseId, manifestSha256: oldSha, completedAt: oldCompleted };
    const history: Array<typeof environmentLeases.$inferInsert> = runs.map((heartbeatRunId, index) => ({
      id: randomUUID(), companyId, heartbeatRunId, environmentId, issueId, executionWorkspaceId: workspaceId,
      provider: "daytona", providerLeaseId, leasePolicy: "reuse_by_environment", status: "expired", cleanupStatus: "success",
      acquiredAt: new Date(start + index * 60_000), releasedAt: new Date(start + (index + 1) * 60_000),
      metadata: { agentId },
    }));
    for (let index = 1; index < history.length; index++) {
      const previous = history[index - 1]!, current = history[index]!;
      const proof = createReusableLeaseHandoff(previous as typeof environmentLeases.$inferSelect,
        current as typeof environmentLeases.$inferSelect);
      previous.metadata = { ...previous.metadata, reusableLeaseSuccessor: proof };
      current.metadata = { ...current.metadata, reusableLeasePredecessor: proof };
    }
    history[0]!.metadata!.nativeHarnessBackup = {
      ...stamp, ...(options.wrongSession ? { normalizedSessionId: randomUUID() } : {}),
    };
    const tip = history[2]!;
    tip.metadata = { ...tip.metadata, ...(options.idle
      ? { reusableSandboxLease: { version: 1, provider: "daytona" } }
      : { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId,
          runId: tip.heartbeatRunId, leaseId: tip.id, provider: "daytona", providerLeaseId,
          state: "destroyed", confirmedAt: new Date(start + 180_000).toISOString() } }) };
    if (options.idle) tip.status = "released";
    if (options.newerAt) history[options.newerAt === "tip" ? 2 : 1]!.metadata!.nativeHarnessBackup = {
      ...stamp, manifestSha256: newSha, completedAt: newCompleted,
    };
    if (options.foreignAllocation) {
      delete history[0]!.metadata!.nativeHarnessBackup;
      const foreign = randomUUID();
      await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runs[0]!, provider: "daytona",
        providerLeaseId: foreign, status: "expired", cleanupStatus: "success", metadata: {
          nativeHarnessBackup: { ...stamp, sourceProviderLeaseId: foreign, authorizedProviderLeaseId: foreign },
        } });
    }
    await db.insert(environmentLeases).values(history);
    if (options.laterProviderWork) await db.insert(heartbeatRunEvents).values({ companyId, runId: runs[1]!, agentId,
      seq: 1, eventType: "session.resumed", createdAt: new Date(start + 90_000) });
    const input = { companyId, currentRunId, normalizedSessionId: sessionId,
      manifest: { sourceProviderLeaseId: providerLeaseId, runnerInstanceId, normalizedSessionId: sessionId },
      manifestSha256: oldSha, targetProviderLeaseId: randomUUID() };
    const gate = () => retiredSourceAuthorizesNativeBackupRestore(db, input);
    const tipAfter = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, tip.id!)))[0]!;
    return { gate, tipAfter };
  }

  it("refuses older matching predecessor when the destroyed tip carries a newer nonmatching backup", async () => {
    const fixture = await setup({ newerAt: "tip" });
    expect(await fixture.gate()).toBe(false);
  });

  it("refuses older matching predecessor when another verified predecessor carries a newer nonmatching backup", async () => {
    const fixture = await setup({ newerAt: "middle" });
    expect(await fixture.gate()).toBe(false);
  });

  it("refuses older matching predecessor without superseding an idle tip carrying a newer nonmatching backup", async () => {
    const fixture = await setup({ newerAt: "tip", idle: true });
    const authorized = await fixture.gate();
    const tip = await fixture.tipAfter();
    expect.soft(authorized).toBe(false);
    expect.soft(tip.metadata).toHaveProperty("reusableSandboxLease");
    expect.soft(tip.metadata).not.toHaveProperty("reusableSandboxLeaseSuperseded");
  });

  it("continues to reject a matching predecessor checkpoint with later provider work", async () => {
    const fixture = await setup({ laterProviderWork: true });
    expect(await fixture.gate()).toBe(false);
  });

  it("never grants authority from a predecessor stamp for a different session", async () => {
    const fixture = await setup({ wrongSession: true });
    expect(await fixture.gate()).toBe(false);
  });

  it("never grants authority from a stamp on a different allocation", async () => {
    const fixture = await setup({ foreignAllocation: true });
    expect(await fixture.gate()).toBe(false);
  });

  it("accepts the sole current checkpoint on the original owner of the verified chain", async () => {
    const fixture = await setup();
    expect(await fixture.gate()).toBe(true);
  });
});
