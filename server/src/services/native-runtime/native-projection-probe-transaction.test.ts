import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, completionContracts, createDb, environmentLeases, environments,
  heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults,
} from "@paperclipai/db";
import { DurablePrpControlPlane, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { createNativeControllerRecovery } from "./native-controller-recovery.js";
import { buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const toolDefinitions = vi.hoisted(() => vi.fn());
vi.mock("../../runtime-api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../runtime-api.js")>(),
  resolveLocalRuntimeApiUrl: () => "http://127.0.0.1:43219",
}));
vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    readonly binding = {};
    definitions() { return toolDefinitions(); }
    close() {}
  },
}));
vi.mock("./current-wake-comments.js", async importOriginal => ({
  ...await importOriginal<typeof import("./current-wake-comments.js")>(),
  resolveCurrentWakeCommentsBinding: async () => null,
  assertCurrentWakeCommentsRead: async () => undefined,
}));
import { buildNativeHarnessBackupManifest, createRunnerdBackend, resolveNativeHarnessPersistenceProfile, scopedRunnerdStateRoot } from "./native-session-executor.js";

const ADMITTED = "projection refreshed and follow-up reached tool authority";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

// Real embedded PostgreSQL is mandatory here: a transaction spy cannot prove
// whether the server pool owns an open backend transaction during remote I/O.
describe("projection refresh remote probe transaction boundary (pg_stat_activity)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, observer: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>, stateDirectory: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  const companyId = randomUUID(), agentId = randomUUID();
  const serverApplication = `s099-server-${randomUUID()}`;
  const observerApplication = `s099-observer-${randomUUID()}`;

  beforeAll(async () => {
    home = createIsolatedTestHome();
    process.env.PAPERCLIP_HOME = home.home;
    stateDirectory = await mkdtemp(join(tmpdir(), "projection-probe-state-"));
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateDirectory;
    database = await startEmbeddedPostgresTestDatabase("projection-probe-pg-");
    db = createDb(database.connectionString, { applicationName: serverApplication });
    observer = createDb(database.connectionString, { applicationName: observerApplication, maxConnections: 1 });
    await db.insert(companies).values({ id: companyId, name: "Projection probe", issuePrefix: "PPT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" } });
    toolDefinitions.mockRejectedValue(new Error(ADMITTED));
  }, 90_000);

  afterAll(async () => {
    try { await database?.cleanup(); }
    finally {
      if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
      home?.cleanup();
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
    }
  });

  async function seedProjection(external: boolean) {
    const issueId = randomUUID(), workspaceId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue after recovery", assigneeAgentId: agentId, status: "in_progress" });
    const issue = { id: issueId, title: "Continue after recovery", description: null, reviewPolicy: null };
    let normalizedSessionId: string | undefined;
    async function prepare() {
      const [row] = await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, nativeSessionId: normalizedSessionId, contextSnapshot: { issueId } }).returning();
      const native = await prepareNativeHeartbeatRun({ db, run: row, issue, environmentLeaseId: randomUUID() });
      normalizedSessionId = native.normalizedSessionId;
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const execution = buildNativeExecutionInput({
        companyId, agentId, runId: row.id, provider: "codex", model: "gpt-6.1-sol",
        issue: { ...issue, identifier: "PPT-1", workMode: "standard" }, taskPrompt: "Continue the conversation.",
        workspace: { id: workspaceId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        normalizedSessionId: native.normalizedSessionId, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        runtimeContext: nativeRuntimeContextFixture(), completionContract: { id: contract.id, sha256: contract.canonicalSha256,
          schemaVersion: contract.schemaVersion, contract: contract.contractJson as never },
      });
      const identity = { runId: row.id, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
        environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId };
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: row.id, phase: "observed" });
      return { row, native, execution, identity };
    }
    async function settle(prior?: Awaited<ReturnType<typeof prepare>>) {
      const prepared = await prepare(), runId = prepared.row.id;
      // A successor checkpoint remains on the same Runner allocation, with a
      // new turn/run identity (the ordinary recovered-owner follow-up shape).
      if (prior) {
        prepared.identity.runnerInstanceId = prior.identity.runnerInstanceId;
        prepared.identity.environmentLeaseId = prior.identity.environmentLeaseId;
        await db.update(heartbeatRuns).set({ runnerInstanceId: prepared.identity.runnerInstanceId }).where(eq(heartbeatRuns.id, runId));
      }
      const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
      await db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId, controllerGeneration: 1,
        controllerPid: 2_147_483_000, controllerProcessStartedAt: new Date(Date.now() - 60_000),
        leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
      const scratch = await mkdtemp(join(tmpdir(), "projection-probe-controller-"));
      const controller = new DurablePrpControlPlane({ stateDirectory: scratch, identity: prepared.identity,
        expectedRunnerVersion: "projection-probe-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      try {
        controller.persistRunAttachTemplate({ provider: prepared.execution.provider, normalizedSessionId: prepared.native.normalizedSessionId });
        for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"]) {
          Object.assign(controller.queueCommand(type), { status: "completed", result: { status: "completed" } });
        }
        controller.store.state.committedEvents.push({ sourceSeq: 2, sourceEventId: `terminal-${runId}`, eventType: "run.terminal",
          priority: 0, envelope: { ...prepared.identity }, deliveryCount: 1, logicalEffectCount: 1 });
        controller.store.state.ackedSourceSeq = 2;
        controller.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
        await controller.flushCheckpoint();
      } finally {
        await controller.stop();
        await rm(scratch, { recursive: true, force: true });
      }
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const snapshot: PersistedNativeSession = { backendKind: "runner", sessionId: prepared.native.normalizedSessionId,
        providerSessionId: "retained-provider-session", activeTurnId: null, pendingRuntimeRequests: [],
        identity: { companyId, agentId, issueId, runId, sessionId: prepared.native.normalizedSessionId } };
      const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId, completionContractId: current.completionContractId!,
        serverFingerprint: runId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: runId }).returning();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: {
        ...current.runnerProfileJson, nativeExecutionInput: prepared.execution, sessionCheckpoint: snapshot,
        nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "codex"),
        nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: `sha256:${"b".repeat(64)}`, processConfigDigest: null },
          { runId, runnerInstanceId: prepared.identity.runnerInstanceId, normalizedSessionId: prepared.native.normalizedSessionId }),
      } }).where(eq(heartbeatRuns.id, runId));
      await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, runId));
      return prepared;
    }
    const prior = await settle(), latest = await settle(prior), followUp = await prepare();
    await db.update(issues).set({ executionRunId: followUp.row.id }).where(eq(issues.id, issueId));
    const selected = await findNativeSessionResumeRun(db, { companyId, agentId, issueId,
      normalizedSessionId: followUp.native.normalizedSessionId, currentRunId: followUp.row.id, beforeCreatedAt: followUp.row.createdAt });
    expect(selected?.id).toBe(latest.row.id);
    const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: followUp.native.normalizedSessionId,
      executionTargetKind: "remote", buildExecution: () => followUp.execution });
    expect(admission.checkpoint).not.toBeNull();
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, followUp.row.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...current.runnerProfileJson, nativeExecutionInput: followUp.execution,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "codex"), sessionCheckpoint: admission.checkpoint } })
      .where(eq(heartbeatRuns.id, followUp.row.id));
    const root = scopedRunnerdStateRoot(latest.execution), backupRoot = join(root, "failover-backups", "current");
    const oldCheckpoint = await loadNativeRunnerCheckpoint(db, { companyId, issueId, runId: prior.row.id });
    expect(oldCheckpoint).not.toBeNull();
    oldCheckpoint!.restoreSessionDirectory(root);
    const path = join(root, "control-plane", "control-plane-state.json");
    if (external) await writeFile(path, JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: prior.identity }));
    const retainedFiles = new Map<string, string>();
    for (const directory of resolveNativeHarnessPersistenceProfile(latest.execution).directories) {
      await mkdir(join(backupRoot, directory.name), { recursive: true });
      if (directory.name !== "runner") retainedFiles.set(join(backupRoot, directory.name, "retained-conversation.txt"), `conversation for ${latest.row.id}`);
    }
    const runnerState = { schema: "paperclip.runner.durable.state.v1", ...latest.identity, lifecycle: "suspended", outbox: [],
      pendingTerminalDelivery: null, pendingProviderCleanup: null, warmTransition: null };
    retainedFiles.set(join(backupRoot, "runner", "runner-state.json"), JSON.stringify(runnerState));
    for (const [file, bytes] of retainedFiles) await writeFile(file, bytes);
    const environmentId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${followUp.row.id}`;
    retainedFiles.set(join(backupRoot, "manifest.json"), JSON.stringify(buildNativeHarnessBackupManifest({ backupRoot,
      execution: latest.execution, runnerInstanceId: latest.identity.runnerInstanceId, sourceProviderLeaseId: providerLeaseId,
      providerSessionIdentity: { providerSessionId: "retained-provider-session", providerBackendSessionId: null, providerSessionIdentity: null } })));
    await writeFile(join(backupRoot, "manifest.json"), retainedFiles.get(join(backupRoot, "manifest.json"))!);
    await db.insert(environments).values({ id: environmentId, name: `retained-${environmentId}`, driver: "sandbox" });
    for (const previous of [prior, latest]) await db.insert(environmentLeases).values({ companyId, environmentId, issueId,
      heartbeatRunId: previous.row.id, provider: "daytona", providerLeaseId, status: "released", releasedAt: new Date(), metadata: { remoteCwd: "/workspace" } });
    return { prior, latest, followUp, root, path, retainedFiles, runnerState, environmentId, leaseId, providerLeaseId };
  }

  async function serverActivity() {
    return observer.execute<{ pid: number; application_name: string; state: string; xact_start: Date | null; query: string }>(sql`
      select pid, application_name, state, xact_start, left(query, 240) as query from pg_stat_activity
      where datname = current_database() and application_name = ${serverApplication}
        and pid <> pg_backend_pid() order by pid`);
  }

  it.each([false, true])("a hung resumed-owner probe holds NO DB transaction (external=%s)", async external => {
    const fixture = await seedProjection(external);
    const entered = deferred(), release = deferred();
    let checks = 0, probeBlocked = false;
    const remoteExecute = vi.fn(async (request: unknown) => {
      const text = JSON.stringify(request);
      if (text.includes("paperclip-runner-generation-marker")) return { exitCode: 0, timedOut: false,
        stdout: `nonce1\n4242\n2026-11-13T10:00:00.000Z\n${fixture.prior.native.runnerInstanceId}\nlinux:0b5e6c2a-1111-4222-8333-944455556666:12345\n`, stderr: "" };
      // The second generation check is the selected source owner's inspection
      // in refreshFinishedPerTurnRunnerdProjection, not an unrelated earlier read.
      if (text.includes("paperclip-runner-generation-check")) {
        if (++checks === 2) {
          probeBlocked = true;
          entered.resolve();
          await release.promise;
          probeBlocked = false;
        }
        return { exitCode: 45, timedOut: false, stdout: "", stderr: "" };
      }
      if (text.includes("runner-state.json")) return { exitCode: 0, timedOut: false,
        stdout: Buffer.from(JSON.stringify(fixture.runnerState)).toString("base64"), stderr: "" };
      throw new Error("admission must not execute provider work");
    });
    const pending = createRunnerdBackend({ db, execution: fixture.followUp.execution,
      runnerInstanceId: fixture.followUp.native.runnerInstanceId, onLog: async () => {},
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId: fixture.environmentId,
        leaseId: fixture.leaseId, remoteCwd: "/workspace", reusableLeaseConfigured: true, runner: { execute: remoteExecute },
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: fixture.providerLeaseId } } as never,
    }).then(() => "unexpected backend construction", (error: Error) => error.message);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered.promise,
        pending.then(outcome => { throw new Error(`refresh finished before the controlled hang: ${outcome}`); }),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("remote probe was not reached")), 15_000); }),
      ]);
      expect(probeBlocked).toBe(true);
      const activity = await serverActivity();
      process.stderr.write(`S099 blocked probe pg_stat_activity ${JSON.stringify({ external, checks, activity })}\n`);
      expect(activity.length, "must observe the real server pool, not an empty filter").toBeGreaterThan(0);
      const open = activity.filter(row => row.xact_start !== null && (row.state === "idle in transaction" || row.state === "active"));
      expect(open, "a hung remote probe must not leave any server-pool backend in a transaction").toEqual([]);
      expect(probeBlocked, "observation must finish before releasing remote I/O").toBe(true);
    } finally {
      if (deadline) clearTimeout(deadline);
      release.resolve();
      // Even RED unwinds the controlled remote wait and awaits the refresh.
      const outcome = await pending;
      process.stderr.write(`S099 released probe ${JSON.stringify({ external, checks, outcome })}\n`);
      expect(outcome).toBe(ADMITTED);
    }
    expect(JSON.parse(await readFile(fixture.path, "utf8")).identity).toEqual(fixture.latest.identity);
    const archives = await readdir(join(fixture.root, "continuity-breaks"));
    expect(archives).toHaveLength(1);
    expect(JSON.parse(await readFile(join(fixture.root, "continuity-breaks", archives[0]!, "control-plane", "control-plane-state.json"), "utf8")).identity)
      .toEqual(fixture.prior.identity);
    for (const [file, bytes] of fixture.retainedFiles) expect(await readFile(file, "utf8")).toBe(bytes);
  }, 60_000);
});
