import { JsonRpcCallError, environmentResumeErrorData } from "@paperclipai/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  agents,
  agentTaskSessions,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaceSnapshots,
  executionWorkspaces,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issues,
  nativeRunnerCheckpoints,
  nativeRunFinalizations,
  plugins,
  projects,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { createReusableLeaseHandoff, retiredReusableLeasePredecessors } from "../services/environment-lease-handoff.js";
import { parseEnvironmentDriverConfig } from "../services/environment-config.js";
import { buildReusableSandboxLeaseFingerprint8237, buildReusableSandboxLeaseScope8237 } from "./fixtures/reusable-lease-minter-8237cf02.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

import * as nativeExecutor from "../services/native-runtime/native-session-executor.js";
import * as controllerIdentity from "../services/controller-process-identity.js";
import { createNativeHarnessBackupStamp } from "../services/native-runtime/native-harness-backup-stamp.js";
import { createNativeControllerRecovery } from "../services/native-runtime/native-controller-recovery.js";
import { insertMigratedNativeRunnerCheckpoint, loadNativeRunnerCheckpoint } from "../services/native-runtime/native-runner-checkpoint.js";
import { nativeHarnessBackupCoversProviderEvents, retiredSourceAuthorizesNativeBackupRestore } from "../services/native-runtime/native-retired-backup-source.js";
import { captureLegacyDurablePrpCheckpoint, DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";

// The older resume-refusal rows use a lease-bound stub stamp. Fence rows below
// have complete manifests and MUST pass the real bytes + source verification.
vi.mock("../services/native-runtime/native-harness-backup-storage.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-harness-backup-storage.js")>();
  return { ...actual, verifyRecoverableNativeHarnessBackup: vi.fn(async (input: Parameters<typeof actual.verifyRecoverableNativeHarnessBackup>[0]) =>
    (input.stamp as { manifestSha256?: unknown } | undefined)?.manifestSha256
      ? actual.verifyRecoverableNativeHarnessBackup(input)
      : Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId)) };
});

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The staging failure: Daytona kept the idle sandbox in a state transition past
// its five-minute start deadline, and the worker reported it with no status.
const STAGING_REFUSAL = "Daytona sandbox 0f6c1e52-3d1a-4b7e-9c2a-5e8f7a1b2c3d is still stopping at its start deadline";

describeEmbeddedPostgres("reusable sandbox resume failure replacement", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString: string;
  let fixtureRoot: string;
  const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("environment-runtime-resume-replacement");
      stopDb = started.cleanup;
      connectionString = started.connectionString;
    }
  });
  beforeEach(async () => {
    db = createDb(connectionString);
    fixtureRoot = await mkdtemp(join(tmpdir(), "replacement-fence-"));
    process.env.PAPERCLIP_RUNNER_STATE_DIR = fixtureRoot;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(executionWorkspaceSnapshots);
    await db.delete(environmentLeases);
    await db.delete(nativeRunFinalizations);
    await db.delete(nativeRunnerCheckpoints);
    await db.delete(heartbeatRunEvents);
    await db.delete(issueComments);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(projects);
    await db.delete(companies);
    await db.$client.end({ timeout: 1 });
    await rm(fixtureRoot, { recursive: true, force: true });
    if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
    else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
  });
  afterAll(async () => { await stopDb?.(); });

  type Shape = {
    leaseStatus?: "retained" | "released";
    previousRunStatus?: "succeeded" | "running";
    dirty?: boolean;
    snapshot?: "committed" | "pending" | null;
    backupStamp?: boolean;
    providerConfig?: Record<string, unknown>;
  };

  async function seed(shape: Shape = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const previousRunId = randomUUID();
    const runId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const providerLeaseId = "0f6c1e52-3d1a-4b7e-9c2a-5e8f7a1b2c3d";
    // The staging environment's provider settings, including its 300s start deadline.
    const providerConfig = { provider: "fake-plugin", image: "fake:test", timeoutMs: 300_000, reuseLease: true, ...shape.providerConfig };
    const provider = String(providerConfig.provider);
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Paperclip Sandbox", driver: "sandbox", status: "active",
      config: providerConfig });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: "acme.reusable-sandbox-provider", packageName: "@acme/reusable-sandbox-provider",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: {
        id: "acme.reusable-sandbox-provider", apiVersion: 1, version: "1.0.0", displayName: "Reusable Sandbox Provider",
        description: "Test provider", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, timeoutMs: { type: "number" }, reuseLease: { type: "boolean" } } } }],
      },
    } as never);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "active" });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, mode: "isolated_workspace",
      strategyType: "project_primary", name: "Task workspace", status: "active", providerType: "cloud_sandbox",
      cwd: `/workspaces/${executionWorkspaceId}` });
    await db.insert(heartbeatRuns).values([
      { id: previousRunId, companyId, agentId, invocationSource: "assignment", status: "running" },
      { id: runId, companyId, agentId, invocationSource: "assignment", status: "running" },
    ]);
    const environment: Environment = { id: environmentId, name: "Paperclip Sandbox", description: null, driver: "sandbox",
      status: "active", config: providerConfig, envVars: {}, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    // The previous run creates the sandbox through the real acquisition path,
    // so the preserved lease carries exactly the identity production records.
    const priming = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true,
      call: async (_pluginId: string, method: string) => {
        if (method !== "environmentAcquireLease") throw new Error(`Unexpected plugin method: ${method}`);
        return { providerLeaseId, metadata: { ...providerConfig, sandboxId: providerLeaseId, remoteCwd: "/home/daytona/paperclip-workspace" } };
      },
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const created = await priming.acquireRunLease({ companyId, environment, issueId: null, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: previousRunId, persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "isolated_workspace" } });
    // The run then ended after a clean final save and left its lease-bound
    // harness backup stamp. A lease saved by an older release has no
    // acquisition outcome and may predate the backup stamp.
    // The allocation RPC is doubled, but its reusable identity is always minted
    // by the frozen deployed code, never by today's lease-fingerprint function.
    const deployedInput = { companyId, environment, environmentId, executionWorkspaceId, issueId: null,
      agentId, adapterType: "paperclip_runner", provider, config: { ...parseEnvironmentDriverConfig(environment).config },
      providerPlugin: { id: pluginId, pluginKey: "acme.reusable-sandbox-provider",
        packageName: "@acme/reusable-sandbox-provider", version: "1.0.0" } };
    const leaseFingerprint = buildReusableSandboxLeaseFingerprint8237({ ...deployedInput, providerConfig: deployedInput.config });
    const reusableSandboxLease = buildReusableSandboxLeaseScope8237({ ...deployedInput, leaseFingerprint,
      providerMetadata: created.lease.metadata });
    const { sandboxLeaseAcquisition: _outcome, ...metadata } = created.lease.metadata ?? {};
    const lease = (await environmentService(db).updateLeaseMetadata(created.lease.id, {
      ...(shape.leaseStatus === "released" ? metadata : created.lease.metadata), reusableSandboxLease,
      remoteWorkspaceId: executionWorkspaceId,
      ...(shape.backupStamp === false ? {} : { nativeHarnessBackup: {
        schema: "paperclip.native-harness-backup-stamp.v2", sourceProviderLeaseId: providerLeaseId,
        authorizedProviderLeaseId: providerLeaseId,
      } }),
    }))!;
    await db.update(environmentLeases).set({ status: shape.leaseStatus ?? "retained" }).where(eq(environmentLeases.id, lease.id));
    await db.update(heartbeatRuns).set({ status: shape.previousRunStatus ?? "succeeded" }).where(eq(heartbeatRuns.id, previousRunId));
    const snapshotId = randomUUID();
    if (shape.snapshot !== null) {
      await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId,
        sourceOperationId: randomUUID(), sourceRunId: previousRunId, generation: 1, epoch: 1, status: shape.snapshot ?? "committed" });
    }
    // This run already holds the workspace writer slot (reserved before the
    // environment is acquired); the saved version is the previous run's save.
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: {
      schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId: shape.snapshot === null ? null : snapshotId,
      source: { kind: "empty" }, writerRunId: runId, dirty: shape.dirty ?? false,
      location: { environmentId, leaseId: lease.id, providerLeaseId, remoteCwd: "/home/daytona/paperclip-workspace/.paperclip-workspaces/w" },
    } } }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { companyId, agentId, environment, pluginId, runId, previousRunId, executionWorkspaceId, lease, providerLeaseId };
  }

  function worker(seeded: Awaited<ReturnType<typeof seed>>, resume: (attempt: number, timeoutMs: number) => Promise<unknown>,
    options: { acquireFails?: boolean } = {}) {
    let attempts = 0;
    const call = vi.fn(async (_pluginId: string, method: string, _params: unknown, timeoutMs?: number) => {
      if (method === "environmentResumeLease") return await resume(++attempts, timeoutMs ?? 0);
      if (method === "environmentAcquireLease") {
        if (options.acquireFails) throw new JsonRpcCallError({ code: -32000, message: "create refused" });
        return { providerLeaseId: "replacement-sandbox", metadata: { provider: "fake-plugin", image: "fake:test",
          timeoutMs: 300_000, reuseLease: true, remoteCwd: "/home/daytona/paperclip-workspace" } };
      }
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const manager = { isRunning: vi.fn((id: string) => id === seeded.pluginId), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    return { call, runtime: environmentRuntimeService(db, { pluginWorkerManager: manager }) };
  }

  function acquire(seeded: Awaited<ReturnType<typeof seed>>, runtime: ReturnType<typeof environmentRuntimeService>,
    runId = seeded.runId) {
    return runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment, issueId: null,
      agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "isolated_workspace" } });
  }

  // Each refused resume consumes 40s of the run's clock, so the in-run retry
  // budget is exercised without real waiting.
  function stepClock() {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    return () => { clock += 40_000; };
  }

  // Real PostgreSQL acquisition/cleanup/execute paths; only provider I/O is a
  // deterministic conversation store. Destroy erases the source-only answer.
  async function conversationFixture(config: Record<string, unknown> = {}) {
    const seeded = await seed({ backupStamp: false, providerConfig: config });
    const issueId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const remembered = randomUUID();
    const identity = { runId: seeded.previousRunId, normalizedSessionId: sessionId, runnerInstanceId,
      environmentLeaseId: seeded.lease.id, turnId: randomUUID(), itemId: randomUUID() };
    const execution = { provider: { kind: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous" },
      binding: { companyId: seeded.companyId, agentId: seeded.agentId, issueId, runId: seeded.previousRunId,
        executionWorkspaceId: seeded.executionWorkspaceId },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: sessionId, driverKind: "pi_rpc", protocolVersion: 1,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 } } };
    const snapshot = { backendKind: "runner", driverKind: "pi_rpc", sessionId, providerSessionId: sessionId,
      identity: { companyId: seeded.companyId, agentId: seeded.agentId, issueId, runId: seeded.previousRunId, sessionId } };
    await db.insert(issues).values({ id: issueId, companyId: seeded.companyId, title: "Remember the source-only answer", status: "in_progress" });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId, runnerProfileJson: { nativeExecutionInput: execution, sessionCheckpoint: snapshot } })
      .where(eq(heartbeatRuns.id, seeded.previousRunId));
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: randomUUID() }).where(eq(heartbeatRuns.id, seeded.runId));
    type Conversation = { sessionId: string; remembered: string };
    type Source = Conversation & { runId: string; issueId: string; runnerInstanceId: string; leaseId: string };
    const defaultSource: Source = { sessionId, remembered, runId: seeded.previousRunId, issueId, runnerInstanceId, leaseId: seeded.lease.id };
    const conversations = new Map<string, Map<string, Conversation>>([
      [seeded.providerLeaseId, new Map<string, Conversation>([[sessionId, { sessionId, remembered }]])],
    ]);
    const backups = new Map<string, { stamp: ReturnType<typeof createNativeHarnessBackupStamp>; root: string; source: Source }>();
    const stoppedAllocations = new Set<string>();
    let backupRoot: string | undefined;
    function registerConversation(conversation: Conversation) { conversations.get(seeded.providerLeaseId)!.set(conversation.sessionId, conversation); }
    async function preserve(options: { controller?: boolean; completedAt?: string; source?: Source; legacyManifest?: boolean } = {}) {
      const source = options.source ?? defaultSource;
      const savedIdentity = { ...identity, runId: source.runId, normalizedSessionId: source.sessionId,
        runnerInstanceId: source.runnerInstanceId, environmentLeaseId: source.leaseId };
      const savedExecution = { ...execution, binding: { ...execution.binding, runId: source.runId, issueId: source.issueId },
        session: { ...execution.session, normalizedSessionId: source.sessionId } };
      const savedSnapshot = { ...snapshot, sessionId: source.sessionId, providerSessionId: source.sessionId,
        identity: { ...snapshot.identity, issueId: source.issueId, runId: source.runId, sessionId: source.sessionId } };
      const scope = `${seeded.companyId}:${source.issueId}:${source.sessionId}`;
      const root = join(fixtureRoot, createHash("sha256").update(scope).digest("hex"), "failover-backups", "current");
      if (!options.source) backupRoot = root;
      await mkdir(join(root, "runner"), { recursive: true });
      await writeFile(join(root, "runner", "conversation.json"), JSON.stringify(conversations.get(seeded.providerLeaseId)!.get(source.sessionId)));
      await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ ...savedIdentity, lifecycle: "ready", nextSourceSeq: 1 }));
      const [cursor] = await db.select({ seq: sql<number>`coalesce(max(${heartbeatRunEvents.seq}), -1)` })
        .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, seeded.companyId),
          eq(heartbeatRunEvents.runId, source.runId)));
      const manifest = nativeExecutor.buildNativeHarnessBackupManifest({ backupRoot: root, execution: savedExecution as never,
        ...(options.legacyManifest ? {} : { providerEventCursors: Number(cursor.seq) >= 0 ? [{ runId: source.runId, seq: Number(cursor.seq) }] : [] }),
        runnerInstanceId: source.runnerInstanceId, providerSessionIdentity: { providerSessionId: source.sessionId, providerBackendSessionId: source.sessionId },
        sourceProviderLeaseId: seeded.providerLeaseId, completedAt: options.completedAt });
      const manifestPath = join(root, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const stamp = createNativeHarnessBackupStamp({ manifestPath, sessionScopeId: scope,
        authorizedProviderLeaseId: seeded.providerLeaseId, normalizedSessionId: source.sessionId,
        runnerInstanceId: source.runnerInstanceId, completedAt: manifest.completedAt });
      backups.set(source.sessionId, { stamp, root, source });
      const lease = (await environmentService(db).getLeaseById(source.leaseId))!;
      await environmentService(db).updateLeaseMetadata(lease.id, { ...lease.metadata, nativeHarnessBackup: stamp });
      if (options.controller !== false) {
        const artifact = { version: "fence-fixture", digest: `sha256:${"a".repeat(64)}` };
        const core = new DurablePrpControlPlane({ stateDirectory: join(fixtureRoot, "controller", source.sessionId), identity: savedIdentity,
          expectedRunnerVersion: artifact.version, expectedRunnerDigest: artifact.digest });
        try {
          const checkpoint = captureLegacyDurablePrpCheckpoint(JSON.stringify(core.store.state), savedIdentity, artifact);
          await db.transaction(tx => insertMigratedNativeRunnerCheckpoint(tx, {
            companyId: seeded.companyId, issueId: source.issueId, runId: source.runId }, checkpoint));
        } finally { await core.stop(); }
        await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: savedExecution, sessionCheckpoint: savedSnapshot,
          nativeControllerRecovery: createNativeControllerRecovery(savedSnapshot as never,
            { configDigest: `sha256:${"b".repeat(64)}`, processConfigDigest: null }, savedIdentity) } })
          .where(eq(heartbeatRuns.id, source.runId));
      }
      return stamp;
    }
    const call = vi.fn(async (_pluginId: string, method: string, params: any) => {
      if (method === "environmentResumeLease") {
        stoppedAllocations.delete(params.providerLeaseId);
        // Real Boat echoes retained metadata on resume (plugin.ts:141,156-157).
        return { providerLeaseId: params.providerLeaseId, metadata: {
          ...(config.provider === "boat" ? params.leaseMetadata : {}), remoteCwd: "/workspace" } };
      }
      if (method === "environmentStopLease") {
        stoppedAllocations.add(params.providerLeaseId);
        return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      }
      if (method === "environmentAcquireLease") return { providerLeaseId: "replacement-sandbox", metadata: { remoteCwd: "/workspace" } };
      if (method === "environmentDestroyLease") {
        conversations.delete(params.providerLeaseId);
        return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      }
      if (method === "environmentExecute") {
        if (stoppedAllocations.has(params.lease.providerLeaseId)) throw new Error("stopped allocation must resume before execution");
        const wantedSessionId = params.args?.[1] ?? sessionId;
        let conversation = conversations.get(params.lease.providerLeaseId)?.get(wantedSessionId);
        const backup = backups.get(wantedSessionId);
        // This provider-I/O double uses real retired-source authorization and
        // encrypted controller recovery; it never opens a fresh conversation.
        if (!conversation && backup && await retiredSourceAuthorizesNativeBackupRestore(db, {
          companyId: seeded.companyId, currentRunId: params.lease.heartbeatRunId ?? seeded.runId, normalizedSessionId: wantedSessionId,
          manifest: backup.stamp, manifestSha256: backup.stamp.manifestSha256, targetProviderLeaseId: params.lease.providerLeaseId,
        }) && await loadNativeRunnerCheckpoint(db, { companyId: seeded.companyId, issueId: backup.source.issueId, runId: backup.source.runId })) {
          conversation = JSON.parse(await readFile(join(backup.root, "runner", "conversation.json"), "utf8"));
          if (!conversations.has(params.lease.providerLeaseId)) conversations.set(params.lease.providerLeaseId, new Map());
          conversations.get(params.lease.providerLeaseId)!.set(wantedSessionId, conversation!);
        }
        if (!conversation) throw new Error("PRP provider resume state is unavailable");
        return { stdout: JSON.stringify({ sessionId: conversation.sessionId, answer: conversation.remembered }), stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
    } as unknown as PluginWorkerManager });
    async function answer(acquired: Awaited<ReturnType<typeof acquire>>) {
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
        JSON.stringify({ phase: "attempt", row: expect.getState().currentTestName, runId: seeded.runId,
          sourceRunId: seeded.previousRunId, sourceLeaseId: seeded.lease.id, selectedLeaseId: acquired.lease.id,
          sourceAllocation: seeded.providerLeaseId, selectedAllocation: acquired.lease.providerLeaseId, sessionId,
          destroys: call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length }) + "\n");
      const result = await runtime.execute({ environment: seeded.environment, lease: acquired.lease,
        command: "fixture-pi-rpc", args: ["recall"] });
      expect(JSON.parse(result.stdout!)).toEqual({ sessionId, answer: remembered });
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(current.nativeSessionId).toBe(sessionId);
      const evidence = { row: expect.getState().currentTestName, companyId: seeded.companyId, sourceRunId: seeded.previousRunId,
        runId: seeded.runId, sourceLeaseId: seeded.lease.id, selectedLeaseId: acquired.lease.id,
        sourceAllocation: seeded.providerLeaseId, selectedAllocation: acquired.lease.providerLeaseId,
        sessionId, replyMatchedSourceOnlyAnswer: true,
        destroys: call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length,
        acquisition: acquired.lease.metadata?.sandboxLeaseAcquisition,
        baselineModule: "fixtures/reusable-lease-minter-8237cf02.ts", baselineCommit: "8237cf027401ae16b4aa1236491325e5e3a4c74f" };
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS, JSON.stringify(evidence) + "\n");
    }
    async function change(config: Record<string, unknown>) {
      seeded.environment.config = { ...seeded.environment.config, ...config };
      await db.update(environments).set({ config: seeded.environment.config }).where(eq(environments.id, seeded.environment.id));
    }
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ phase: "prepared", row: expect.getState().currentTestName, companyId: seeded.companyId,
        sourceRunId: seeded.previousRunId, runId: seeded.runId, sourceLeaseId: seeded.lease.id,
        sourceAllocation: seeded.providerLeaseId, sessionId }) + "\n");
    return { ...seeded, runtime, call, preserve, answer, change, sessionId, issueId, runnerInstanceId, remembered,
      backupRoot: () => backupRoot, stoppedAllocations, registerConversation,
      clearConversations: () => conversations.clear() };
  }

  // RED catch: authoritative loss used to rethrow source_resume_failed forever.
  it.each(["empty", "expired", "not-found"] as const)("fence11: deferred held source %s settles without a backup and never allocates on three runs", async shape => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    f.clearConversations();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (pluginId, method, params) => {
      if (method === "environmentResumeLease") {
        if (shape === "not-found") throw new Error("Sandbox not found");
        return shape === "expired" ? { metadata: { expired: true } } : {};
      }
      return original(pluginId, method, params);
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const runId = attempt === 0 ? f.runId : randomUUID();
      if (attempt) await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
        invocationSource: "assignment", status: "running", runtimeMode: "native", nativeIssueId: f.issueId,
        sessionIdBefore: f.sessionId, runnerInstanceId: randomUUID() });
      await expect(acquire(f, f.runtime, runId)).rejects.toMatchObject({ code: "held_box_lost", retryable: false,
        message: expect.stringContaining("The sandbox holding this task's conversation is gone and no backup could be restored. Retry starts a fresh conversation; the earlier messages stay on the task.") });
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "held_box_lost" }).where(eq(heartbeatRuns.id, runId));
    }
    const source = (await environmentService(db).getLeaseById(f.lease.id))!;
    expect(source).toMatchObject({ status: "expired", failureReason: "held_box_lost" });
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(1);
    expect(f.call.mock.calls.some(([, method]) => method === "environmentAcquireLease" || method === "environmentDestroyLease")).toBe(false);
  });

  it.each(["empty", "expired", "not-found"] as const)("fence11: deferred held source %s restores the exact verified session", async shape => {
    const f = await conversationFixture();
    await f.preserve({ controller: false }); // a save alone cannot retire a live held box
    await f.change({ image: "fake:changed" });
    f.clearConversations();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (pluginId, method, params) => {
      if (method === "environmentResumeLease") {
        if (shape === "not-found") throw new Error("Sandbox not found");
        return shape === "expired" ? { metadata: { expired: true } } : {};
      }
      return original(pluginId, method, params);
    });
    const acquired = await acquire(f, f.runtime);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ outcome: "replacement" });
    expect((await environmentService(db).getLeaseById(f.lease.id))!.failureReason).toBe("held_box_lost");
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    // Restore authorization must preserve session/provider identity, not merely permit a new box.
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const stamp = source.metadata!.nativeHarnessBackup as ReturnType<typeof createNativeHarnessBackupStamp>;
    expect(await retiredSourceAuthorizesNativeBackupRestore(db, { companyId: f.companyId, currentRunId: f.runId,
      normalizedSessionId: f.sessionId, manifest: stamp, manifestSha256: stamp.manifestSha256,
      targetProviderLeaseId: acquired.lease.providerLeaseId })).toBe(true);
    expect(JSON.parse(await readFile(join(f.backupRoot()!, "runner/conversation.json"), "utf8")))
      .toEqual({ sessionId: f.sessionId, remembered: f.remembered });
  });

  it.each(["uncovered-event", "corrupt-bytes", "another-session"] as const)("fence11: lost held source refuses %s backup rather than losing newer memory", async fault => {
    const f = await conversationFixture();
    await f.preserve({ controller: false });
    if (fault === "uncovered-event") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
      runId: f.previousRunId, agentId: f.agentId, seq: 2, eventType: "provider.event" });
    if (fault === "corrupt-bytes") await writeFile(join(f.backupRoot()!, "runner/conversation.json"), "corrupt");
    if (fault === "another-session") {
      const lease = (await environmentService(db).getLeaseById(f.lease.id))!;
      await environmentService(db).updateLeaseMetadata(lease.id, { ...lease.metadata,
        nativeHarnessBackup: { ...(lease.metadata!.nativeHarnessBackup as Record<string, unknown>), normalizedSessionId: randomUUID() } });
    }
    await f.change({ image: "fake:changed" });
    f.clearConversations();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (pluginId, method, params) => method === "environmentResumeLease" ? {} : original(pluginId, method, params));
    await expect(acquire(f, f.runtime)).rejects.toMatchObject({ code: "held_box_lost", retryable: false });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentAcquireLease" || method === "environmentDestroyLease")).toBe(false);
  });

  it.each([true, false])("fence11: a cleanup-expired source settles before native session selection and before another acquisition (backup=%s)", async saved => {
    const f = await conversationFixture();
    if (saved) await f.preserve({ controller: false });
    f.clearConversations();
    await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", failureReason: "pending_cleanup_retry" })
      .where(eq(environmentLeases.id, f.lease.id));
    // Real acquisition precedes runtime selection: only admission's session is set.
    await db.update(heartbeatRuns).set({ nativeSessionId: null, sessionIdBefore: f.sessionId }).where(eq(heartbeatRuns.id, f.runId));
    if (saved) {
      const next = await acquire(f, f.runtime);
      expect(next.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ outcome: "replacement" });
      expect(next.lease.metadata?.nativeHarnessBackup).toMatchObject({ normalizedSessionId: f.sessionId });
      expect(JSON.parse(await readFile(join(f.backupRoot()!, "runner/conversation.json"), "utf8")))
        .toEqual({ sessionId: f.sessionId, remembered: f.remembered });
    } else {
      for (let attempt = 0; attempt < 3; attempt++) await expect(acquire(f, f.runtime))
        .rejects.toMatchObject({ code: "held_box_lost", retryable: false });
      expect(f.call.mock.calls.some(([, method]) => method === "environmentAcquireLease")).toBe(false);
    }
    expect(f.call.mock.calls.some(([, method]) => method === "environmentResumeLease" || method === "environmentDestroyLease")).toBe(false);
  });

  it.each([false, true])("fence11: failed empty successor allocations do not hide the source's verified session (backup=%s)", async saved => {
    const f = await conversationFixture();
    if (saved) await f.preserve({ controller: false });
    const emptyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: emptyRunId, companyId: f.companyId, agentId: f.agentId,
      status: "failed", runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId: f.sessionId,
      errorCode: "native_session_interrupted", finishedAt: new Date() });
    const source = (await environmentService(db).getLeaseById(f.lease.id))!;
    await db.insert(environmentLeases).values({ ...source, id: randomUUID(), heartbeatRunId: emptyRunId,
      providerLeaseId: "empty-successor", status: "expired", cleanupStatus: "success", failureReason: "pending_cleanup_retry" });
    await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", failureReason: "pending_cleanup_retry" })
      .where(eq(environmentLeases.id, f.lease.id));
    f.clearConversations();
    if (saved) {
      const next = await acquire(f, f.runtime);
      expect(next.lease.metadata?.nativeHarnessBackup).toMatchObject({ normalizedSessionId: f.sessionId,
        sourceProviderLeaseId: f.providerLeaseId });
      expect(next.lease.providerLeaseId).toBe("replacement-sandbox");
    } else await expect(acquire(f, f.runtime)).rejects.toMatchObject({ code: "held_box_lost", retryable: false });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentResumeLease" || method === "environmentDestroyLease")).toBe(false);
  });

  it("fence11: a consumer's terminal lost state blocks later messages before another empty box", async () => {
    const f = await conversationFixture();
    await f.preserve({ controller: false });
    await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", failureReason: "pending_cleanup_retry" })
      .where(eq(environmentLeases.id, f.lease.id));
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId: f.agentId,
      status: "failed", runtimeMode: "native", nativeIssueId: f.issueId, sessionIdBefore: f.sessionId,
      errorCode: "held_box_lost", finishedAt: new Date() });
    await expect(acquire(f, f.runtime)).rejects.toMatchObject({ code: "held_box_lost", retryable: false });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentAcquireLease" || method === "environmentResumeLease")).toBe(false);
  });

  it("fence11: a thrown ambiguous held resume records the attempt without claiming loss", async () => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    f.call.mockImplementation(async () => { throw new Error("DNS lookup failed"); });
    await expect(acquire(f, f.runtime)).rejects.toThrow("source_resume_failed");
    expect(await environmentService(db).getLeaseById(f.lease.id)).toMatchObject({ status: "retained",
      failureReason: "source_resume_failed", metadata: expect.objectContaining({ heldSourceResumeAttempts: 1 }) });
  });

  it("replacement fence v7 Q: legacy manifest does not authorize destruction even for events before save", async () => {
    const f = await conversationFixture();
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.previousRunId,
      agentId: f.agentId, seq: 1, eventType: "provider.event", createdAt: new Date(Date.now() - 60_000) });
    await f.preserve({ legacyManifest: true });
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(0);
  });

  it.each(["legacy", "uncovered-v6"] as const)("replacement fence v7 Q: already retired %s backup preserves restore compatibility", async mode => {
    const f = await conversationFixture();
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.previousRunId,
      agentId: f.agentId, seq: 1, eventType: "provider.event", createdAt: new Date(Date.now() - 60_000) });
    await f.preserve({ legacyManifest: mode === "legacy" });
    const saved = JSON.parse(await readFile(join(f.backupRoot()!, "manifest.json"), "utf8"));
    expect(Object.hasOwn(saved, "providerEventCursors")).toBe(mode !== "legacy");
    if (mode === "uncovered-v6") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
      runId: f.previousRunId, agentId: f.agentId, seq: 2, eventType: "provider.event", createdAt: new Date(0) });
    // This box was retired by the OLD release, not by the candidate's destroy
    // fence. Reproduce its durable receipt and absent provider state on upgrade.
    const lease = (await environmentService(db).getLeaseById(f.lease.id))!;
    await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", releasedAt: new Date(), metadata: {
      ...lease.metadata, remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId: f.companyId,
        runId: f.previousRunId, leaseId: f.lease.id, provider: lease.provider, providerLeaseId: f.providerLeaseId,
        state: "destroyed", confirmedAt: new Date().toISOString() },
    } }).where(eq(environmentLeases.id, f.lease.id));
    f.clearConversations();
    const acquired = await acquire(f, f.runtime);
    expect(acquired.lease.providerLeaseId).not.toBe(f.providerLeaseId);
    if (mode === "legacy") await f.answer(acquired);
    else {
      await expect(f.runtime.execute({ environment: f.environment, lease: acquired.lease,
        command: "fixture-pi-rpc", args: ["recall"] })).rejects.toThrow("provider resume state is unavailable");
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
        JSON.stringify({ row: expect.getState().currentTestName, refusedUncoveredSeq: 2,
          savedCursors: saved.providerEventCursors, sourceAllocation: f.providerLeaseId,
          selectedAllocation: acquired.lease.providerLeaseId, destroys: 0 }) + "\n");
    }
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(0);
  });

  it.each(["unchanged timeout present", "bridge changed", "timeout changed", "bridge newly present", "bridge removed"])(
    "replacement fence: deploy old-shape hash, %s resumes the exact allocation and conversation", async mode => {
      const f = await conversationFixture(mode === "bridge newly present" ? {} : { bridgeRequestTimeoutMs: 30_000 });
      if (mode.startsWith("bridge")) await f.change({ bridgeRequestTimeoutMs: mode === "bridge removed" ? undefined : 90_000 });
      if (mode === "timeout changed") await f.change({ timeoutMs: 600_000 });
      const acquired = await acquire(f, f.runtime);
      await f.answer(acquired);
      expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(0);
      expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    });

  it.each(["spares", "spareIdleMinutes", "spareCreateCapPerHour", "hydrationWaitMs"])(
    "replacement fence: Boat %s policy edit keeps the deployed allocation and session", async key => {
      const f = await conversationFixture({ provider: "boat", spares: 0, spareIdleMinutes: 0,
        spareCreateCapPerHour: 6, hydrationWaitMs: 120_000 });
      await f.change({ [key]: key === "spares" ? 1 : key === "hydrationWaitMs" ? 240_000 : 12 });
      const acquired = await acquire(f, f.runtime);
      await f.answer(acquired);
      expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
      expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
      expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    });

  it("replacement fence v3: Boat echoed metadata survives two exempt edits and a timeout edit", async () => {
    const f = await conversationFixture({ provider: "boat", spares: 0, hydrationWaitMs: 120_000 });
    const saved: Record<string, unknown>[] = [];
    for (const edit of [{ spares: 1 }, { hydrationWaitMs: 240_000 }, { timeoutMs: 600_000 }]) {
      await f.change(edit);
      const acquired = await acquire(f, f.runtime);
      await f.answer(acquired);
      expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
      expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
      saved.push(acquired.lease.metadata ?? {});
      await environmentService(db).releaseLease(acquired.lease.id, "released");
    }
    expect(saved[0]!.spares).toBe(1);
    expect(saved[1]!.hydrationWaitMs).toBe(240_000);
    expect(saved[2]!.timeoutMs).toBe(600_000);
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  // Real reusable lease history is one receipt-linked chain, not independent
  // tips. The real restore authorizer below validates these same handoffs.
  async function linkHistory(f: Awaited<ReturnType<typeof conversationFixture>>,
    history: (typeof environmentLeases.$inferSelect)[]) {
    const [tip] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const chain = [...history].sort((a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime()).concat(tip);
    const metadata = chain.map(row => ({ ...row.metadata }));
    for (let index = 0; index < chain.length - 1; index++) {
      const receipt = createReusableLeaseHandoff(chain[index]!, chain[index + 1]!);
      metadata[index]!.reusableLeaseSuccessor = receipt;
      metadata[index + 1]!.reusableLeasePredecessor = receipt;
    }
    await db.transaction(async tx => {
      for (let index = 0; index < chain.length; index++) await tx.update(environmentLeases).set({
        metadata: metadata[index], ...(index < chain.length - 1
          ? { cleanupStatus: "success", releasedAt: chain[index + 1]!.acquiredAt } : {}),
      }).where(eq(environmentLeases.id, chain[index]!.id));
    });
    const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, f.providerLeaseId));
    expect(retiredReusableLeasePredecessors(rows.find(row => row.id === tip.id)!, rows.filter(row => row.id !== tip.id)))
      .toHaveLength(history.length);
  }

  async function addOtherConversation(f: Awaited<ReturnType<typeof conversationFixture>>,
    options: { sameTask?: boolean; reset?: boolean; explicitFresh?: boolean } = {}) {
    const otherRunId = randomUUID(), otherIssueId = options.sameTask ? f.issueId : randomUUID(), otherSessionId = randomUUID();
    const otherRunnerInstanceId = randomUUID(), remembered = randomUUID();
    f.registerConversation({ sessionId: otherSessionId, remembered });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.previousRunId));
    const profile = source.runnerProfileJson as any;
    if (!options.sameTask) await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId,
      title: "Another task in the shared workspace", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "assignment", status: "succeeded", runtimeMode: "native", nativeIssueId: otherIssueId,
      nativeSessionId: otherSessionId, runnerInstanceId: otherRunnerInstanceId, createdAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId: otherIssueId, ...(options.reset ? { conversationReset: true } : {}),
        ...(options.explicitFresh ? { explicitFreshSession: true } : {}) },
      runnerProfileJson: { nativeExecutionInput: { ...profile.nativeExecutionInput,
        binding: { ...profile.nativeExecutionInput.binding, issueId: otherIssueId, runId: otherRunId },
        session: { ...profile.nativeExecutionInput.session, normalizedSessionId: otherSessionId } } } });
    const history = await db.insert(environmentLeases).values({ id: randomUUID(), companyId: f.companyId,
      environmentId: f.environment.id, issueId: otherIssueId,
      heartbeatRunId: otherRunId, executionWorkspaceId: f.executionWorkspaceId,
      // Historical per-run lease row; the allocation is still held by f.lease.
      provider: f.environment.config.provider as string, providerLeaseId: f.providerLeaseId, status: "expired",
      acquiredAt: new Date(f.lease.acquiredAt.getTime() - 60_000),
      leasePolicy: "reuse_by_environment", metadata: { ...f.lease.metadata, nativeHarnessBackup: undefined } }).returning();
    await linkHistory(f, history);
    return { otherRunId, otherIssueId, otherSessionId, otherLeaseId: history[0]!.id,
      source: { runId: otherRunId, issueId: otherIssueId, sessionId: otherSessionId,
        runnerInstanceId: otherRunnerInstanceId, leaseId: history[0]!.id, remembered } };
  }

  it.each([0, -1, "covered", "self"])("replacement fence v6 P9: durable event sequence beats clock delta %s", async delta => {
    const f = await conversationFixture();
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.previousRunId,
      agentId: f.agentId, seq: 1, eventType: "provider.event", message: "First saved answer" });
    const stamp = await f.preserve();
    const latestAnswer = randomUUID();
    f.registerConversation({ sessionId: f.sessionId, remembered: latestAnswer });
    const eventAt = new Date(Date.parse(stamp.completedAt) + (typeof delta === "number" ? delta : 0));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.previousRunId,
      agentId: f.agentId, seq: 2, eventType: "provider.event", message: "Provider advanced after save", createdAt: eventAt });
    if (delta === "covered") await f.preserve({ controller: false });
    await f.change({ image: "fake:changed" });
    if (delta === "self") await db.update(heartbeatRuns).set({ status: "running" })
      .where(eq(heartbeatRuns.id, f.previousRunId));
    const acquired = await acquire(f, f.runtime, delta === "self" ? f.previousRunId : f.runId);
    const reply = await f.runtime.execute({ environment: f.environment, lease: acquired.lease,
      command: "fixture-pi-rpc", args: ["recall", f.sessionId] });
    const received = JSON.parse(reply.stdout!);
    const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, delta, seq: 2, eventAt: eventAt.toISOString(),
        saveCompletedAt: stamp.completedAt, destroys, latestAnswer, receivedAnswer: received.answer,
        latestAnswerRetained: received.answer === latestAnswer, allocation: acquired.lease.providerLeaseId,
        acquisition: acquired.lease.metadata?.sandboxLeaseAcquisition }) + "\n");
    expect(destroys).toBe(delta === "covered" ? 1 : 0);
    expect(received.answer).toBe(latestAnswer);
  });

  it.each(["self-tip", "self-history", "other-running", "asking-finalizer"])(
    "replacement fence v6 P-SELF %s: same-run reacquire replaces once with no conversation, other owners stay fenced", async mode => {
      const f = await conversationFixture();
      // There is no continuous Pi conversation on this allocation. The asking
      // run remains running, as on the orchestrator's same-run resume path.
      f.clearConversations();
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {} })
        .where(sql`${heartbeatRuns.id} in (${f.previousRunId}, ${f.runId})`);
      if (mode === "self-tip" || mode === "asking-finalizer") {
        await db.update(environmentLeases).set({ heartbeatRunId: f.runId, issueId: f.issueId })
          .where(eq(environmentLeases.id, f.lease.id));
      } else {
        const history = await db.insert(environmentLeases).values({ id: randomUUID(), companyId: f.companyId,
          environmentId: f.environment.id, issueId: f.issueId, heartbeatRunId: f.runId,
          executionWorkspaceId: f.executionWorkspaceId, provider: f.environment.config.provider as string,
          providerLeaseId: f.providerLeaseId, status: "expired", leasePolicy: "reuse_by_environment",
          acquiredAt: new Date(f.lease.acquiredAt.getTime() - 60_000), metadata: { ...f.lease.metadata } }).returning();
        await linkHistory(f, history);
      }
      if (mode === "other-running") await db.update(heartbeatRuns).set({ status: "running" })
        .where(eq(heartbeatRuns.id, f.previousRunId));
      if (mode === "asking-finalizer") await db.insert(nativeRunFinalizations).values({
        runId: f.runId, companyId: f.companyId, issueId: f.issueId, phase: "pending",
        leaseOwner: "asking-run-finalizer", leaseExpiresAt: null });
      await f.change({ image: "fake:changed" });
      const attempts: { allocation: string | null; refusal: string | null; destroys: number }[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        let acquired: Awaited<ReturnType<typeof acquire>> | undefined, error: unknown;
        try { acquired = await acquire(f, f.runtime); } catch (caught) { error = caught; }
        const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
        attempts.push({ allocation: acquired?.lease.providerLeaseId ?? null,
          refusal: error instanceof Error ? error.message : null, destroys });
        if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
          JSON.stringify({ row: expect.getState().currentTestName, mode, askingRunId: f.runId,
            askingRunStatus: "running", conversations: 0, attempts }) + "\n");
        if (mode === "other-running" || mode === "asking-finalizer") {
          expect(String(error)).toContain("source_busy");
          expect(destroys).toBe(0);
        } else {
          expect(error).toBeUndefined();
          expect(acquired!.lease.providerLeaseId).toBe("replacement-sandbox");
          expect(destroys).toBe(1);
          await environmentService(db).releaseLease(acquired!.lease.id, "released");
        }
      }
    });

  it.each(["census", "claim"] as const)(
    "replacement fence v8 P-ACTIVE %s: asking run's other active allocation row blocks destruction", async boundary => {
      const f = await conversationFixture();
      f.clearConversations();
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {} })
        .where(sql`${heartbeatRuns.id} in (${f.previousRunId}, ${f.runId})`);
      await db.update(environmentLeases).set({ heartbeatRunId: f.runId, issueId: f.issueId })
        .where(eq(environmentLeases.id, f.lease.id));
      const activeId = randomUUID();
      const addActive = async () => { await db.insert(environmentLeases).values({ id: activeId,
        companyId: f.companyId, environmentId: f.environment.id, issueId: f.issueId, heartbeatRunId: f.runId,
        executionWorkspaceId: f.executionWorkspaceId, provider: f.environment.config.provider as string,
        providerLeaseId: f.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment", metadata: {} }); };
      if (boundary === "census") await addActive();
      else {
        const identity = controllerIdentity.currentControllerProcess;
        vi.spyOn(controllerIdentity, "currentControllerProcess").mockImplementationOnce(async () => {
          await addActive(); return identity();
        });
      }
      await f.change({ image: "fake:changed" });
      let error: unknown;
      try { await acquire(f, f.runtime); } catch (caught) { error = caught; }
      const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
      const active = await environmentService(db).getLeaseById(activeId);
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
        JSON.stringify({ row: expect.getState().currentTestName, boundary, destroys, active,
          refusal: error instanceof Error ? error.message : null }) + "\n");
      expect(String(error)).toContain(boundary === "census" ? "source_busy" : "source_ownership_changed");
      expect(destroys).toBe(0);
      expect(active).toMatchObject({ status: "active", heartbeatRunId: f.runId, providerLeaseId: f.providerLeaseId });
    });

  it.each([0, -1, "unchanged", "claim"] as const)(
    "replacement fence v8 R1 P-by-P9 %s: older asking run's new work always counts toward causal coverage", async delta => {
      const f = await conversationFixture();
      // A real task-bound history, not an unrelated taskless predecessor.
      await db.update(environmentLeases).set({ issueId: f.issueId }).where(eq(environmentLeases.id, f.lease.id));
      const older = await addOtherConversation(f, { sameTask: true });
      const [olderRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, older.otherRunId));
      const olderProfile = olderRun.runnerProfileJson as any;
      await db.update(heartbeatRuns).set({ nativeSessionId: f.sessionId, status: "running", runnerProfileJson: {
        ...olderProfile, nativeExecutionInput: { ...olderProfile.nativeExecutionInput,
          session: { ...olderProfile.nativeExecutionInput.session, normalizedSessionId: f.sessionId } },
      } }).where(eq(heartbeatRuns.id, older.otherRunId));
      const acquireOlder = () => f.runtime.acquireRunLease({ companyId: f.companyId, environment: f.environment,
        issueId: f.issueId, agentId: f.agentId, adapterType: "paperclip_runner", heartbeatRunId: older.otherRunId,
        persistedExecutionWorkspace: { id: f.executionWorkspaceId, mode: "isolated_workspace" } });
      await db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata},
        '{remoteWorkspace,writerRunId}', to_jsonb(${older.otherRunId}::text))` })
        .where(eq(executionWorkspaces.id, f.executionWorkspaceId));
      await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.previousRunId,
        agentId: f.agentId, seq: 1, eventType: "provider.event" });
      const stamp = await f.preserve();
      // Real same-run acquire/resume, then provider work on that allocation.
      // The immutable createdAt census still chooses f.previousRunId.
      const resumed = await acquireOlder();
      expect(resumed.lease.providerLeaseId).toBe(f.providerLeaseId);
      const newestAnswer = randomUUID();
      f.registerConversation({ sessionId: f.sessionId, remembered: newestAnswer });
      const advance = async () => { await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: older.otherRunId,
        agentId: f.agentId, seq: 2, eventType: "provider.event",
        createdAt: new Date(Date.parse(stamp.completedAt) + (typeof delta === "number" ? delta : 0)) }); };
      if (delta !== "claim") await advance();
      const first = await f.runtime.execute({ environment: f.environment, lease: resumed.lease,
        command: "fixture-pi-rpc", args: ["recall", f.sessionId] });
      expect(JSON.parse(first.stdout!).answer).toBe(newestAnswer);
      await environmentService(db).releaseLease(resumed.lease.id, "released");
      const history = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, f.providerLeaseId));
      expect(retiredReusableLeasePredecessors(history.find(row => row.id === resumed.lease.id)!,
        history.filter(row => row.id !== resumed.lease.id))).toHaveLength(2);
      const coversWhenAskerExcluded = await nativeHarnessBackupCoversProviderEvents(db, { companyId: f.companyId,
        sessionId: f.sessionId, currentRunId: older.otherRunId, stamp });
      const coversAllRuns = await nativeHarnessBackupCoversProviderEvents(db, { companyId: f.companyId,
        sessionId: f.sessionId, stamp });
      expect(coversWhenAskerExcluded).toBe(true);
      expect(coversAllRuns).toBe(delta === "claim");
      if (delta !== "unchanged") await f.change({ image: "fake:changed" });
      if (delta === "claim") {
        const identity = controllerIdentity.currentControllerProcess;
        vi.spyOn(controllerIdentity, "currentControllerProcess").mockImplementationOnce(async () => {
          await advance(); return identity();
        });
        let refusal: unknown;
        try { await acquireOlder(); } catch (error) { refusal = error; }
        const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
        if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
          JSON.stringify({ row: expect.getState().currentTestName, boundary: "claim", destroys,
            refusal: refusal instanceof Error ? refusal.message : null, newestAnswer }) + "\n");
        expect(destroys).toBe(0);
        expect(String(refusal)).toContain("source_ownership_changed");
      }
      const acquired = await acquireOlder();
      let answer: string | null = null, error: unknown;
      try {
        const reply = await f.runtime.execute({ environment: f.environment, lease: acquired.lease,
          command: "fixture-pi-rpc", args: ["recall", f.sessionId] });
        answer = JSON.parse(reply.stdout!).answer;
      } catch (caught) { error = caught; }
      const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
        JSON.stringify({ row: expect.getState().currentTestName, delta, askingRunId: older.otherRunId,
          representativeRunId: f.previousRunId, coversWhenAskerExcluded, coversAllRuns, destroys,
          allocation: acquired.lease.providerLeaseId, sessionId: f.sessionId, newestAnswer, answer,
          continuationError: error instanceof Error ? error.message : null }) + "\n");
      expect(destroys).toBe(0);
      expect(error).toBeUndefined();
      expect(answer).toBe(newestAnswer);
      expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    });

  it.each(["fingerprint", "fresh", "resume-empty", "saved", "explicit-reset-control", "unheld-control"] as const)(
    "replacement fence v9 generic acquisition release %s: no held conversation is released before provisioning", async mode => {
      const f = await conversationFixture();
      if (mode === "saved") await f.preserve();
      if (mode === "explicit-reset-control") await db.update(heartbeatRuns).set({ contextSnapshot: { conversationReset: true } })
        .where(eq(heartbeatRuns.id, f.runId));
      const pluginKey = "acme.reusable-sandbox-provider";
      f.environment.driver = "plugin";
      f.environment.config = { pluginKey, driverKey: "tasks", driverConfig: {}, runnerLifecycleMode: "warm" };
      await db.update(environments).set({ driver: "plugin", config: f.environment.config }).where(eq(environments.id, f.environment.id));
      const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
      await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, environmentDrivers: [{ driverKey: "tasks",
        kind: "sandbox_provider", supportsTasks: true, warmTaskVersion: 1, sessionHandoffVersion: 1 }] } as never })
        .where(eq(plugins.id, f.pluginId));
      const config = parseEnvironmentDriverConfig(f.environment).config;
      const fingerprint = createHash("sha256").update(JSON.stringify([config, f.agentId, []])).digest("hex");
      await db.update(environmentLeases).set({ issueId: f.issueId, metadata: { ...f.lease.metadata,
        pluginId: f.pluginId, pluginKey, driverKey: "tasks", driver: "plugin", agentId: f.agentId,
        runnerTaskLease: true, runnerTaskFingerprint: ["fingerprint", "saved", "explicit-reset-control", "unheld-control"].includes(mode) ? "old" : fingerprint,
        runnerTaskIdentity: { sessionId: f.sessionId }, environmentId: f.environment.id } })
        .where(eq(environmentLeases.id, f.lease.id));
      if (mode === "unheld-control") await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {} })
        .where(eq(heartbeatRuns.id, f.previousRunId));
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (id, method, params) => {
        if (method === "environmentResumeLease" && mode === "resume-empty" && (params as any).providerLeaseId === f.providerLeaseId) return {};
        if (method === "environmentReleaseLease") {
          f.clearConversations(); return { providerLeaseId: f.providerLeaseId, state: "destroyed" };
        }
        return original(id, method, params);
      });
      let acquired: Awaited<ReturnType<typeof acquire>> | undefined, error: unknown;
      try { acquired = await f.runtime.acquireRunLease({ companyId: f.companyId, environment: f.environment,
        issueId: f.issueId, agentId: f.agentId, heartbeatRunId: f.runId, adapterType: "paperclip_runner",
        ...(mode === "fresh" ? { runnerTaskResumeSessionId: null } : {}),
        persistedExecutionWorkspace: { id: f.executionWorkspaceId, mode: "isolated_workspace" } }); } catch (caught) { error = caught; }
      const releases = f.call.mock.calls.filter(([, method]) => method === "environmentReleaseLease").length;
      const creates = f.call.mock.calls.filter(([, method]) => method === "environmentAcquireLease").length;
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
        JSON.stringify({ row: expect.getState().currentTestName, mode, releases, creates,
          allocation: acquired?.lease.providerLeaseId, refusal: error instanceof Error ? error.message : null }) + "\n");
      if (mode === "unheld-control" || mode === "explicit-reset-control" || mode === "resume-empty") {
        expect(error).toBeUndefined(); expect(releases).toBe(1); expect(creates).toBe(1);
        if (mode === "resume-empty") {
          expect((await environmentService(db).getLeaseById(f.lease.id))?.status).toBe("released");
          await environmentService(db).releaseLease(acquired!.lease.id, "retained");
          await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
          const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
            issueId: f.issueId, status: "running" }).returning();
          const next = await f.runtime.acquireRunLease({ companyId: f.companyId, environment: f.environment,
            issueId: f.issueId, agentId: f.agentId, heartbeatRunId: nextRun.id, adapterType: "paperclip_runner",
            persistedExecutionWorkspace: { id: f.executionWorkspaceId, mode: "isolated_workspace" } });
          expect(next.lease.providerLeaseId).toBe(acquired!.lease.providerLeaseId);
          if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
            JSON.stringify({ row: expect.getState().currentTestName, turn: 2, runId: nextRun.id,
              allocation: next.lease.providerLeaseId, sourceStatus: (await environmentService(db).getLeaseById(f.lease.id))?.status }) + "\n");
        }
      } else {
        expect(error).toMatchObject({ code: "replacement_deferred_unexported_conversation" });
        expect(String(error)).toMatch(/conversation.*source sandbox/i);
        expect(String(error)).toMatch(/restore.*original configuration/i);
        expect(String(error)).toMatch(/reset.*conversation/i);
        expect(String(error)).not.toMatch(/operator.*handoff/i);
        expect(releases).toBe(0); expect(creates).toBe(0);
        const lease = (await environmentService(db).getLeaseById(f.lease.id))!;
        const result = await f.runtime.execute({ environment: { ...f.environment, driver: "sandbox" }, lease,
          command: "fixture-pi-rpc", args: ["recall", f.sessionId] });
        expect(JSON.parse(result.stdout!)).toEqual({ sessionId: f.sessionId, answer: f.remembered });
      }
    });

  it.each(["cancelled", "timed_out"] as const)(
    "replacement fence v10 live terminal %s: a live controller keeps its active allocation", async status => {
      const f = await conversationFixture();
      f.clearConversations();
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {}, status,
        controllerLeaseExpiresAt: new Date(Date.now() + 600_000) }).where(eq(heartbeatRuns.id, f.previousRunId));
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(environmentLeases).values({ id: randomUUID(), companyId: f.companyId,
        environmentId: f.environment.id, heartbeatRunId: f.previousRunId,
        provider: f.environment.config.provider as string, providerLeaseId: f.providerLeaseId,
        status: "active", leasePolicy: "reuse_by_environment", metadata: {} });
      await f.change({ image: "fake:changed" });
      let error: unknown;
      try { await acquire(f, f.runtime); } catch (caught) { error = caught; }
      const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
        JSON.stringify({ row: expect.getState().currentTestName, status, destroys,
          refusal: error instanceof Error ? error.message : null }) + "\n");
      expect(destroys).toBe(0);
      expect(String(error)).toContain("source_busy");
    });

  it("replacement fence v10 designer post-CAS event: releases the claim and answers on the same box", async () => {
    const f = await conversationFixture();
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.previousRunId,
      agentId: f.agentId, seq: 1, eventType: "provider.event" });
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const cleanup = await import("../services/environment-cleanup-notifications.js");
    const original = cleanup.writeEnvironmentCleanup;
    const newestAnswer = randomUUID();
    let afterCasAt = 0, publishedAt = 0;
    vi.spyOn(cleanup, "writeEnvironmentCleanup").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      const claimed = await environmentService(db).getLeaseById(f.lease.id);
      expect(claimed?.status).toBe("pending_cleanup");
      afterCasAt = performance.now();
      f.registerConversation({ sessionId: f.sessionId, remembered: newestAnswer });
      await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.previousRunId,
        agentId: f.agentId, seq: 2, eventType: "provider.event" });
      publishedAt = performance.now();
      return result;
    });
    const acquired = await acquire(f, f.runtime);
    let answer: string | null = null, error: string | null = null;
    try { const result = await f.runtime.execute({ environment: f.environment, lease: acquired.lease,
      command: "fixture-pi-rpc", args: ["recall", f.sessionId] }); answer = JSON.parse(result.stdout!).answer; }
    catch (caught) { error = String(caught); }
    const source = await environmentService(db).getLeaseById(f.lease.id);
    const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, sourceAllocation: f.providerLeaseId,
        selectedAllocation: acquired.lease.providerLeaseId, sessionId: f.sessionId, newestAnswer, answer, error, destroys,
        sourceStatus: source?.status, inFlight: source?.metadata?.pendingCleanupInFlight,
        eventCommitAfterCasMs: publishedAt-afterCasAt, observationAfterCasMs: performance.now()-afterCasAt })+"\n");
    expect(destroys).toBe(0);
    expect(answer).toBe(newestAnswer);
    expect(error).toBeNull();
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(source?.metadata?.pendingCleanupInFlight).not.toBe(true);
    expect(source?.status).not.toBe("pending_cleanup");
  });

  it("replacement fence v10 terminal-held CAS: a terminal origin is never reopened for destroy", async () => {
    const f = await conversationFixture();
    await f.preserve();
    await db.update(environmentLeases).set({ metadata: { ...(await environmentService(db).getLeaseById(f.lease.id))!.metadata,
      terminalPiSandboxOrigin: true } }).where(eq(environmentLeases.id, f.lease.id));
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, destroys,
        selectedAllocation: acquired.lease.providerLeaseId }) + "\n");
    expect(destroys).toBe(0);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    await f.answer(acquired);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const)(
    "replacement fence v9 stale active %s: terminal holding run does not refuse every turn", async status => {
      const f = await conversationFixture();
      f.clearConversations();
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {}, status })
        .where(eq(heartbeatRuns.id, f.previousRunId));
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {} })
        .where(eq(heartbeatRuns.id, f.runId));
      await db.insert(environmentLeases).values({ id: randomUUID(), companyId: f.companyId,
        environmentId: f.environment.id, heartbeatRunId: f.previousRunId,
        executionWorkspaceId: f.executionWorkspaceId, provider: f.environment.config.provider as string,
        providerLeaseId: f.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment", metadata: {} });
      await f.change({ image: "fake:changed" });
      for (let turn = 1; turn <= 2; turn++) {
        let selected: Awaited<ReturnType<typeof acquire>> | undefined, error: unknown;
        try { selected = await acquire(f, f.runtime); } catch (caught) { error = caught; }
        const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
        if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
          JSON.stringify({ row: expect.getState().currentTestName, turn, status, destroys,
            allocation: selected?.lease.providerLeaseId, error: error instanceof Error ? error.message : null }) + "\n");
        expect(error).toBeUndefined();
        expect(selected!.lease.providerLeaseId).toBe("replacement-sandbox");
        expect(destroys).toBe(1);
        await environmentService(db).releaseLease(selected!.lease.id, "released");
      }
    });

  it("replacement fence v9 stale active conversation: terminal row still needs normal preservation proof on both turns", async () => {
    const f = await conversationFixture();
    await db.insert(environmentLeases).values({ id: randomUUID(), companyId: f.companyId,
      environmentId: f.environment.id, heartbeatRunId: f.previousRunId,
      executionWorkspaceId: f.executionWorkspaceId, provider: f.environment.config.provider as string,
      providerLeaseId: f.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment", metadata: {} });
    await f.change({ image: "fake:changed" });
    for (let turn = 1; turn <= 2; turn++) {
      const acquired = await acquire(f, f.runtime);
      expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
      await f.answer(acquired);
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(0);
      await environmentService(db).releaseLease(acquired.lease.id, "released");
    }
  });

  it("replacement fence v9 nullable environment history: an unsaved other task on the allocation is still held", async () => {
    const f = await conversationFixture();
    await f.preserve();
    const other = await addOtherConversation(f);
    await db.update(environmentLeases).set({ environmentId: null }).where(eq(environmentLeases.id, other.otherLeaseId));
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    const result = await f.runtime.execute({ environment: f.environment, lease: acquired.lease,
      command: "fixture-pi-rpc", args: ["recall", other.otherSessionId] });
    expect(JSON.parse(result.stdout!)).toEqual({ sessionId: other.otherSessionId, answer: other.source.remembered });
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(0);
  });

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "replacement fence v9 terminal sibling at claim %s: stale active row does not block the CAS", async status => {
      const f = await conversationFixture();
      f.clearConversations();
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {}, status })
        .where(eq(heartbeatRuns.id, f.previousRunId));
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      const identity = controllerIdentity.currentControllerProcess;
      vi.spyOn(controllerIdentity, "currentControllerProcess").mockImplementationOnce(async () => {
        await db.insert(environmentLeases).values({ id: randomUUID(), companyId: f.companyId,
          environmentId: null, heartbeatRunId: f.previousRunId, provider: f.environment.config.provider as string,
          providerLeaseId: f.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment", metadata: {} });
        return identity();
      });
      await f.change({ image: "fake:changed" });
      const acquired = await acquire(f, f.runtime);
      expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
    });

  it.each(["census", "claim"] as const)(
    "replacement fence v9 nullable environment %s: allocation sibling is keyed by company and provider lease", async boundary => {
      const f = await conversationFixture();
      f.clearConversations();
      await db.update(heartbeatRuns).set({ nativeSessionId: null, runnerProfileJson: {} })
        .where(sql`${heartbeatRuns.id} in (${f.previousRunId}, ${f.runId})`);
      const insert = async () => { await db.insert(environmentLeases).values({ id: randomUUID(), companyId: f.companyId,
        environmentId: null, heartbeatRunId: null, provider: f.environment.config.provider as string,
        providerLeaseId: f.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment", metadata: {} }); };
      if (boundary === "census") await insert();
      else {
        const identity = controllerIdentity.currentControllerProcess;
        vi.spyOn(controllerIdentity, "currentControllerProcess").mockImplementationOnce(async () => { await insert(); return identity(); });
      }
      await f.change({ image: "fake:changed" });
      await expect(acquire(f, f.runtime)).rejects.toThrow(boundary === "census" ? "source_busy" : "source_ownership_changed");
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(0);
    });

  it.each(["PROBE1", "PROBE-A", "PROBE-B", "PROBE-C", "PROBE-K", "PROBE-L"])(
    "replacement fence v5 challenger %s: unsaved held conversation is never destroyed; census equals v3", async probe => {
      const f = await conversationFixture();
      if (["PROBE1", "PROBE-L"].includes(probe)) await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID(), createdAt: new Date(Date.now() + 1000) })
        .where(eq(heartbeatRuns.id, f.runId));
      if (probe === "PROBE-A") await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId,
        agentId: f.agentId, invocationSource: "assignment", status: "failed", runtimeMode: "native",
        nativeIssueId: f.issueId, nativeSessionId: randomUUID() }); // Never acquired this allocation or published a pointer.
      if (["PROBE-B", "PROBE-K"].includes(probe)) await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      if (probe === "PROBE-C") {
        const other = await addOtherConversation(f);
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, other.otherIssueId));
        await f.preserve();
      }
      if (["PROBE-K", "PROBE-L"].includes(probe)) await db.update(heartbeatRuns).set({ status: "running" })
        .where(eq(heartbeatRuns.id, f.previousRunId));
      // Verbatim v3 census shape and newest-per-conversation loop (no reset in these probes).
      const sources = await db.selectDistinct({ run: heartbeatRuns }).from(heartbeatRuns)
        .innerJoin(environmentLeases, and(eq(environmentLeases.heartbeatRunId, heartbeatRuns.id),
          eq(environmentLeases.companyId, heartbeatRuns.companyId)))
        .where(and(eq(environmentLeases.companyId, f.companyId), eq(environmentLeases.environmentId, f.environment.id),
          eq(environmentLeases.providerLeaseId, f.providerLeaseId), eq(heartbeatRuns.runtimeMode, "native"),
          isNotNull(heartbeatRuns.nativeSessionId),
          sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'kind' = 'pi_rpc'`,
          sql`coalesce(${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'sessionContinuity', 'continuous') = 'continuous'`))
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
      const v3 = new Map<string, string>();
      for (const { run } of sources) {
        const key = JSON.stringify([run.agentId, run.nativeIssueId, run.nativeSessionId]);
        if (!v3.has(key)) v3.set(key, run.id);
      }
      await f.change({ image: "fake:changed" });
      const queries: { sql: string; parameters: unknown[] }[] = [];
      const debug = db.$client.options.debug;
      db.$client.options.debug = (_connection, sql, parameters) => { queries.push({ sql, parameters }); };
      let acquired: Awaited<ReturnType<typeof acquire>> | undefined, error: unknown;
      try { acquired = await acquire(f, f.runtime); } catch (caught) { error = caught; }
      finally { db.$client.options.debug = debug; }
      const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
      const censusQueries = queries.filter(query => query.sql.includes("reusable_conversation_latest"));
      const rows = censusQueries.length === 1
        ? await db.$client.unsafe(censusQueries[0]!.sql, censusQueries[0]!.parameters as never) : [];
      const actualIds = rows.map(row => row.id).filter(Boolean).sort();
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
        JSON.stringify({ row: expect.getState().currentTestName, probe, destroys, allocation: acquired?.lease.providerLeaseId,
          refusal: error instanceof Error ? error.message : null, v3HeldRunIds: [...v3.values()].sort(), v5HeldRunIds: actualIds,
          censusQueries: censusQueries.length }) + "\n");
      expect(destroys).toBe(0);
      expect(censusQueries).toHaveLength(1);
      expect(actualIds).toEqual([...v3.values()].sort());
      if (["PROBE-K", "PROBE-L"].includes(probe)) expect(String(error)).toContain("source_busy");
      else { expect(error).toBeUndefined(); expect(acquired!.lease.providerLeaseId).toBe(f.providerLeaseId); }
    });

  it.each(["unbounded", "live", "expired"])("replacement fence v5 designer P3: older same-session %s finalizer is checked", async mode => {
    const f = await conversationFixture();
    const older = await addOtherConversation(f, { sameTask: true });
    await db.update(heartbeatRuns).set({ nativeSessionId: f.sessionId }).where(eq(heartbeatRuns.id, older.otherRunId));
    await f.preserve();
    await db.insert(nativeRunFinalizations).values({ runId: older.otherRunId, companyId: f.companyId,
      issueId: f.issueId, phase: "pending", leaseOwner: "older-turn-owner",
      leaseExpiresAt: mode === "unbounded" ? null : new Date(Date.now() + (mode === "live" ? 60_000 : -60_000)) });
    await f.change({ image: "fake:changed" });
    let acquired: Awaited<ReturnType<typeof acquire>> | undefined, error: unknown;
    try { acquired = await acquire(f, f.runtime); } catch (caught) { error = caught; }
    const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, sourceRun: f.previousRunId, olderRun: older.otherRunId,
        mode, destroys, refusal: error instanceof Error ? error.message : null }) + "\n");
    expect(destroys).toBe(mode === "expired" ? 1 : 0);
    if (mode === "expired") { expect(error).toBeUndefined(); await f.answer(acquired!); }
    else expect(String(error)).toContain("source_busy");
  });

  it.each(["archived", "reset"])("replacement fence v6: %s task cannot skip allocation ownership", async mode => {
    const f = await conversationFixture();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.previousRunId));
    if (mode === "archived") await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, f.issueId));
    else await db.update(heartbeatRuns).set({ contextSnapshot: { conversationReset: true } }).where(eq(heartbeatRuns.id, f.runId));
    await f.change({ image: "fake:changed" });
    await expect(acquire(f, f.runtime)).rejects.toThrow("source_busy");
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it("replacement fence v4: older session ended by conversationReset on the same task drops out, current verified session replaces and restores", async () => {
    const f = await conversationFixture();
    const older = await addOtherConversation(f, { sameTask: true, reset: true });
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, older, currentSession: f.sessionId,
        replacement: acquired.lease.providerLeaseId, destroys: 1, restoredSameSession: true }) + "\n");
  });

  it.each(["done", "cancelled", "archived"])("replacement fence v6: unsaved retained other task (%s) keeps the allocation", async status => {
    const f = await conversationFixture();
    const other = await addOtherConversation(f);
    await db.update(issues).set(status === "archived" ? { hiddenAt: new Date() } : { status })
      .where(eq(issues.id, other.otherIssueId));
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(0);
  });

  it("replacement fence v6: deleted task needs no conversation proof", async () => {
    const f = await conversationFixture();
    const other = await addOtherConversation(f);
    await db.delete(issues).where(eq(issues.id, other.otherIssueId));
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
  });

  it("replacement fence v5: a newer same-task session does not waive the unsaved older session", async () => {
    const f = await conversationFixture();
    await addOtherConversation(f, { sameTask: true });
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(0);
  });

  it.each(["done", "cancelled", "older same-task session", "archived"])(
    "replacement fence v5: proven %s save permits replacement, later continuation restores its exact session", async mode => {
      const f = await conversationFixture();
      const other = await addOtherConversation(f, { sameTask: mode === "older same-task session" });
      const state = createHeartbeatRunState(db);
      const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      if (mode !== "older same-task session") await db.update(issues).set({
        ...(mode === "archived" ? { hiddenAt: new Date() } : { status: mode }), assigneeAgentId: f.agentId,
      }).where(eq(issues.id, other.otherIssueId));
      const sourceFinishedAt = new Date(Date.now() - 1000);
      await db.update(heartbeatRuns).set({ sessionIdAfter: other.otherSessionId, finishedAt: sourceFinishedAt })
        .where(eq(heartbeatRuns.id, other.otherRunId));
      await state.upsertTaskSession({ companyId: f.companyId, agentId: f.agentId, adapterType: "paperclip_runner",
        taskKey: other.otherIssueId, sessionDisplayId: mode === "older same-task session" ? f.sessionId : other.otherSessionId,
        sessionParamsJson: { sessionId: mode === "older same-task session" ? f.sessionId : other.otherSessionId },
        lastRunId: mode === "older same-task session" ? f.previousRunId : other.otherRunId, lastError: null });
      const otherStamp = await f.preserve({ source: other.source });
      expect(Date.parse(otherStamp.completedAt)).toBeGreaterThan(sourceFinishedAt.getTime());
      await f.preserve();
      await f.change({ image: "fake:changed" });
      const acquired = await acquire(f, f.runtime);
      await f.answer(acquired);
      expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
      // Replay the post-comment wake boundary with the actual task-session
      // selector. Provider/Pi I/O is still doubled, not a live comment/API row.
      if (mode === "archived") {
        await db.update(issues).set({ hiddenAt: null }).where(eq(issues.id, other.otherIssueId));
        const [unarchived] = await db.select().from(issues).where(eq(issues.id, other.otherIssueId));
        expect(unarchived.hiddenAt).toBeNull();
      }
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: other.otherIssueId,
        authorUserId: "fixture-person", body: "Please continue and recall the source-only answer." }).returning();
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, other.otherIssueId));
      const selectedSession = mode === "older same-task session"
        ? (await state.resolveExplicitResumeSessionOverride(agent, { resumeFromRunId: other.otherRunId }, other.otherIssueId))!.sessionDisplayId
        : await state.resolveSessionBeforeForWakeup(agent, other.otherIssueId);
      expect(selectedSession).toBe(other.otherSessionId);
      const reopenedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: reopenedRunId, companyId: f.companyId, agentId: f.agentId,
        invocationSource: "assignment", status: "running", runtimeMode: "native", nativeIssueId: other.otherIssueId,
        nativeSessionId: selectedSession, runnerInstanceId: randomUUID(),
        contextSnapshot: { issueId: other.otherIssueId, wakeReason: "issue_continuation_needed", wakeCommentId: comment.id } });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await environmentService(db).releaseLease(acquired.lease.id, "released");
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.executionWorkspaceId));
      await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata,
        remoteWorkspace: { ...(workspace.metadata!.remoteWorkspace as Record<string, unknown>), writerRunId: reopenedRunId } } })
        .where(eq(executionWorkspaces.id, f.executionWorkspaceId));
      const resumed = await acquire(f, f.runtime, reopenedRunId);
      const reply = await f.runtime.execute({ environment: f.environment, lease: resumed.lease,
        command: "fixture-pi-rpc", args: ["recall", selectedSession!] });
      expect(JSON.parse(reply.stdout!)).toEqual({ sessionId: other.otherSessionId, answer: other.source.remembered });
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
      if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
        JSON.stringify({ row: expect.getState().currentTestName, commentId: comment.id, reopenedRunId,
          sourceRunId: other.otherRunId, sourceSession: other.otherSessionId, selectedSession,
          sourceFinishedAt: sourceFinishedAt.toISOString(), saveCompletedAt: otherStamp.completedAt,
          allocation: resumed.lease.providerLeaseId, destroys: 1, replyMatchedSourceOnlyAnswer: true,
          oldSessionExplicitlySelected: mode === "older same-task session", unarchivedBeforeComment: mode === "archived" }) + "\n");
    });

  it.each(["corrupt bytes", "missing controller", "save before last run", "save at last run finish", "later provider work", "unlinked history"])(
    "replacement fence v5: finished task with %s is not a proven save", async fault => {
      const f = await conversationFixture();
      const other = await addOtherConversation(f);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, other.otherIssueId));
      const stamp = await f.preserve({ source: other.source, controller: fault !== "missing controller",
        ...(fault === "save before last run" ? { completedAt: new Date(Date.now() - 120_000).toISOString() } : {}) });
      if (fault === "save at last run finish") await db.update(heartbeatRuns).set({ finishedAt: new Date(stamp.completedAt) })
        .where(eq(heartbeatRuns.id, other.otherRunId));
      if (fault === "corrupt bytes") await writeFile(join(fixtureRoot, stamp.sessionScopeSha256, "failover-backups", "current", "runner", "conversation.json"), "corrupt");
      if (fault === "later provider work") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
        runId: other.otherRunId, agentId: f.agentId, seq: 1, eventType: "provider.event", stream: "system", level: "info", message: "later work",
        createdAt: new Date(Date.parse(stamp.completedAt) + 1) });
      if (fault === "unlinked history") await db.update(environmentLeases).set({ metadata: { nativeHarnessBackup: stamp } })
        .where(eq(environmentLeases.id, other.otherLeaseId));
      await f.preserve();
      await f.change({ image: "fake:changed" });
      const acquired = await acquire(f, f.runtime);
      await f.answer(acquired);
      expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
      expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    });

  it.each(["explicit fresh"])("replacement fence v4: an older same-task session superseded by %s needs no proof", async mode => {
    const f = await conversationFixture();
    await addOtherConversation(f, { sameTask: true });
    if (mode === "explicit fresh") {
      // A past fresh request started the current session, not a fresh request now.
      const freshRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: freshRunId, companyId: f.companyId, agentId: f.agentId,
        invocationSource: "assignment", status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId,
        nativeSessionId: f.sessionId, contextSnapshot: { explicitFreshSession: true },
        createdAt: new Date(Date.now() - 30_000) });
    }
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
  });

  it("replacement fence v4: 400 historical runs use one held-set query and only the newest proof", async () => {
    const f = await conversationFixture();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.previousRunId));
    const historical = Array.from({ length: 400 }, (_, index) => ({ id: randomUUID(), companyId: f.companyId,
      agentId: f.agentId, invocationSource: "assignment", status: "succeeded", runtimeMode: "native",
      nativeIssueId: f.issueId, nativeSessionId: f.sessionId, runnerInstanceId: randomUUID(),
      runnerProfileJson: { ...source.runnerProfileJson, historyPadding: "x".repeat(20_000) },
      createdAt: new Date(Date.now() - 60_000 - index * 1000) }));
    await db.insert(heartbeatRuns).values(historical);
    const history = await db.insert(environmentLeases).values(historical.map(run => ({ companyId: f.companyId,
      environmentId: f.environment.id, heartbeatRunId: run.id, issueId: f.issueId, executionWorkspaceId: f.executionWorkspaceId,
      provider: "fake-plugin", providerLeaseId: f.providerLeaseId, status: "expired", leasePolicy: "reuse_by_environment",
      acquiredAt: run.createdAt, metadata: { agentId: f.agentId } }))).returning();
    await linkHistory(f, history);
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const queries: { sql: string; parameters: unknown[] }[] = [];
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, sql, parameters) => { queries.push({ sql, parameters }); };
    const started = performance.now();
    let acquired: Awaited<ReturnType<typeof acquire>>;
    try { acquired = await acquire(f, f.runtime); }
    finally { db.$client.options.debug = debug; }
    const elapsedMs = performance.now() - started;
    const census = queries.filter(q => q.sql.includes("reusable_conversation_latest")
      || q.sql.startsWith('select distinct ') || q.sql.startsWith('select "run_id" from "native_run_finalizations"'));
    // EXPLAIN is a second, evidence-only execution after acquisition; it is not
    // part of the counted census. Keep the natural planner's chosen index names.
    const queryPlan = census.length === 1 && census[0]!.sql.includes("reusable_conversation_latest")
      ? await db.$client.unsafe(`explain (analyze, buffers, format json) ${census[0]!.sql}`, census[0]!.parameters as never) : [];
    console.log("replacement-fence-v4-census", JSON.stringify({ historicalRuns: historical.length, censusQueries: census.length, acquisitionElapsedMs: elapsedMs }));
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, historicalRuns: historical.length,
        censusQueries: census.length, acquisitionElapsedMs: elapsedMs, query: census[0], queryPlan }) + "\n");
    expect(census).toHaveLength(1);
    await f.answer(acquired!);
    expect(acquired!.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
  });

  it("replacement fence v4: two genuinely held tasks, one verified and one unproven, keep the allocation", async () => {
    const f = await conversationFixture();
    const other = await addOtherConversation(f);
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, heldSessions: [f.sessionId, other.otherSessionId],
        verifiedSessions: [f.sessionId], allocation: acquired.lease.providerLeaseId, destroys: 0 }) + "\n");
  });

  it("replacement fence v4: a taskless reset cannot waive another task's held conversation", async () => {
    const f = await conversationFixture();
    const resetRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: resetRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "assignment", status: "running", runtimeMode: "native", contextSnapshot: { conversationReset: true } });
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime, resetRunId);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it("replacement fence v4: an unlinked historical lease keeps the allocation even with a verified current backup", async () => {
    const f = await conversationFixture();
    const older = await addOtherConversation(f, { sameTask: true, reset: true });
    await db.update(environmentLeases).set({ metadata: { agentId: f.agentId } })
      .where(eq(environmentLeases.id, older.otherLeaseId));
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it("replacement fence v4: a string reset flag is not permission to discard a held conversation", async () => {
    const f = await conversationFixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { conversationReset: "true" } })
      .where(eq(heartbeatRuns.id, f.previousRunId));
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it.each(["unbounded", "live", "expired"])("replacement fence v4: newest conversation's %s finalization owner is checked in the census", async mode => {
    const f = await conversationFixture();
    await f.preserve();
    await db.insert(nativeRunFinalizations).values({ runId: f.previousRunId, companyId: f.companyId,
      issueId: f.issueId, phase: "pending", leaseOwner: "fence-fixture",
      leaseExpiresAt: mode === "unbounded" ? null : new Date(Date.now() + (mode === "live" ? 60_000 : -60_000)) });
    await f.change({ image: "fake:changed" });
    if (mode !== "expired") {
      await expect(acquire(f, f.runtime)).rejects.toThrow("replacement_deferred_unexported_conversation: source_busy");
      expect(f.call).not.toHaveBeenCalled();
    } else {
      const acquired = await acquire(f, f.runtime);
      await f.answer(acquired);
      expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    }
  });

  it("replacement fence v3: two tasks, same agent and shared workspace, a different session cannot destroy the held source", async () => {
    const f = await conversationFixture();
    const other = await addOtherConversation(f);
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "assignment", status: "running", runtimeMode: "native",
      nativeIssueId: other.otherIssueId, nativeSessionId: other.otherSessionId, runnerInstanceId: randomUUID() });
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime, nextRunId);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, runId: nextRunId, sourceRunId: f.previousRunId,
        other, allocation: acquired.lease.providerLeaseId, destroys: 0 }) + "\n");
  });

  it("replacement fence v3: explicit fresh waives only its own conversation, another held task keeps the box", async () => {
    const f = await conversationFixture();
    const other = await addOtherConversation(f);
    await db.update(heartbeatRuns).set({ contextSnapshot: { explicitFreshSession: true } }).where(eq(heartbeatRuns.id, f.runId));
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, runId: f.runId, other,
        allocation: acquired.lease.providerLeaseId, destroys: 0 }) + "\n");
  });

  it("replacement fence v3: a proved newest conversation cannot waive an older unexported task", async () => {
    const f = await conversationFixture();
    await addOtherConversation(f);
    await f.preserve();
    await f.change({ image: "fake:changed" });
    const sweep = vi.spyOn(nativeExecutor, "closeWarmNativeSessionsForEnvironment");
    const acquired = await acquire(f, f.runtime);
    expect(sweep).toHaveBeenCalledWith(expect.objectContaining({ conversations: [{ companyId: f.companyId,
      agentId: f.agentId, issueId: f.issueId, normalizedSessionId: f.sessionId }] }));
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it("replacement fence: no warm owner after restart keeps the old allocation and the same conversation", async () => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.image).toBe("fake:test");
    expect(acquired.lease.metadata?.reusableSandboxLease).toEqual(f.lease.metadata?.reusableSandboxLease);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ outcome: "resumed", reason: "replacement_deferred_unexported_conversation" });
    const resume = f.call.mock.calls.find(([, method]) => method === "environmentResumeLease");
    expect(resume?.[2].config.image).toBe("fake:test");
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it("replacement fence: resumes the stopped source disk with a cut save, no proof, and a config mismatch", async () => {
    const f = await conversationFixture();
    await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.lease.id));
    const stopped = await f.runtime.releaseRunLeases(f.previousRunId, "released", undefined, "stop_and_retain");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.lease).toMatchObject({ status: "released", metadata: { remoteExecutionTermination: { state: "stopped" } } });
    expect(f.stoppedAllocations.has(f.providerLeaseId)).toBe(true);
    expect(stopped[0]!.lease.metadata?.nativeHarnessBackup).toBeUndefined();
    await f.change({ image: "fake:changed" });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(f.stoppedAllocations.has(f.providerLeaseId)).toBe(false);
    expect(acquired.lease.metadata?.remoteExecutionTermination).toBeUndefined();
    expect(acquired.lease.metadata?.sandboxStopAndRetainReceipt).toBeUndefined();
    expect(acquired.lease.metadata?.pendingCleanupAttemptId).toBeUndefined();
    expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentStopLease", "environmentResumeLease", "environmentExecute"]);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
  });

  it("replacement fence: export timeout keeps the source and this run answers on the same session", async () => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    vi.spyOn(nativeExecutor, "closeWarmNativeSessionsForEnvironment").mockResolvedValue({ closed: 0, busy: 0, failed: 1,
      failures: [{ runId: f.previousRunId, normalizedSessionId: f.sessionId, message: "Boat export timed out after 29000ms" }] } as never);
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ outcome: "resumed", reason: "replacement_deferred_unexported_conversation" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it("replacement fence: a failed close that still fences the native owner keeps the source and refuses the run", async () => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    vi.spyOn(nativeExecutor, "closeWarmNativeSessionsForEnvironment").mockResolvedValue({ closed: 0, busy: 0, failed: 1,
      failures: [{ runId: f.previousRunId, normalizedSessionId: f.sessionId, message: "export timed out" }] } as never);
    vi.spyOn(nativeExecutor, "warmNativeRetirementPending").mockReturnValue(true);
    await expect(acquire(f, f.runtime)).rejects.toThrow("replacement_deferred_unexported_conversation: source_retirement_unconfirmed");
    expect(f.call).not.toHaveBeenCalled();
    expect(await environmentService(db).getLeaseById(f.lease.id)).toMatchObject({ status: "retained" });
  });

  it("replacement fence: a provider cannot substitute a new allocation for the deferred source", async () => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    f.call.mockImplementation(async (_pluginId, method) => {
      if (method === "environmentResumeLease") return { providerLeaseId: "substituted-box", metadata: { remoteCwd: "/workspace" } };
      throw new Error(`unexpected ${method}`);
    });
    await expect(acquire(f, f.runtime)).rejects.toThrow("replacement_deferred_unexported_conversation: source_resume_failed");
    expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentResumeLease"]);
    expect(await environmentService(db).getLeaseById(f.lease.id)).toMatchObject({ status: "retained" });
  });

  it("replacement fence: a fresh session releases the deferred allocation change", async () => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    const kept = await acquire(f, f.runtime);
    await f.answer(kept);
    await environmentService(db).releaseLease(kept.lease.id, "released");
    // Releasing the lease alone does not end its run. A genuine later fresh
    // wake can discard the old conversation only after that owner has ended.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const freshRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: freshRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "assignment", status: "running", runtimeMode: "native", nativeIssueId: f.issueId,
      contextSnapshot: { explicitFreshSession: true } });
    const next = await acquire(f, f.runtime, freshRunId);
    expect(next.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
  });

  it("replacement fence: active legacy runtime digests also tolerate only deadline edits", async () => {
    const f = await conversationFixture({ bridgeRequestTimeoutMs: 30_000 });
    const { leaseFingerprint: _fingerprint, ...scope } = f.lease.metadata!.reusableSandboxLease as Record<string, unknown>;
    await db.update(environmentLeases).set({ status: "active", heartbeatRunId: f.runId,
      metadata: { ...f.lease.metadata, reusableSandboxLease: scope } }).where(eq(environmentLeases.id, f.lease.id));
    await f.change({ bridgeRequestTimeoutMs: 90_000 });
    const acquired = await acquire(f, f.runtime);
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it("replacement fence: a concurrent owner after proof prevents destructive provider dispatch", async () => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    vi.spyOn(nativeExecutor, "closeWarmNativeSessionsForEnvironment").mockImplementation(async () => {
      await f.preserve(); return { closed: 1, busy: 0, failed: 0, failures: [] };
    });
    const identity = controllerIdentity.currentControllerProcess;
    vi.spyOn(controllerIdentity, "currentControllerProcess").mockImplementationOnce(async () => {
      await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.lease.id));
      return identity();
    });
    await expect(acquire(f, f.runtime)).rejects.toThrow("replacement_deferred_unexported_conversation: source_ownership_changed");
    expect(f.call).not.toHaveBeenCalled();
    expect(await environmentService(db).getLeaseById(f.lease.id)).toMatchObject({ status: "active" });
  });

  it("replacement fence v3: another task acquires a historical row after proof, so provider destroy is refused", async () => {
    const f = await conversationFixture();
    const other = await addOtherConversation(f);
    // This task did not yet have a continuous provider conversation on the box.
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, other.otherRunId));
    await f.change({ image: "fake:changed" });
    vi.spyOn(nativeExecutor, "closeWarmNativeSessionsForEnvironment").mockImplementation(async () => {
      await f.preserve(); return { closed: 1, busy: 0, failed: 0, failures: [] };
    });
    const identity = controllerIdentity.currentControllerProcess;
    vi.spyOn(controllerIdentity, "currentControllerProcess").mockImplementationOnce(async () => {
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, other.otherRunId));
      return identity();
    });
    await expect(acquire(f, f.runtime)).rejects.toThrow("replacement_deferred_unexported_conversation: source_ownership_changed");
    expect(f.call).not.toHaveBeenCalled();
    expect(await environmentService(db).getLeaseById(f.lease.id)).toMatchObject({ status: "retained" });
  });

  it("replacement fence: awaits preservation publication, then permits a proved replacement and restore", async () => {
    const f = await conversationFixture();
    await f.change({ image: "fake:changed" });
    const providerIo = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (pluginId, method, params) => {
      if (method === "environmentDestroyLease") expect(await environmentService(db).getLeaseById(f.lease.id))
        .toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupInFlight: true } });
      return providerIo(pluginId, method, params);
    });
    let allow!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { allow = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(nativeExecutor, "closeWarmNativeSessionsForEnvironment").mockImplementation(async () => {
      reached(); await gate; await f.preserve(); return { closed: 1, busy: 0, failed: 0, failures: [] };
    });
    let settled = false;
    const acquiring = acquire(f, f.runtime).finally(() => { settled = true; });
    try {
      await entered;
      expect(settled).toBe(false);
      expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    } finally { allow(); }
    const acquired = await acquiring;
    await f.answer(acquired);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
    expect(await environmentService(db).getLeaseById(f.lease.id)).toMatchObject({ status: "expired", failureReason: "lease_fingerprint_mismatch" });
  });

  it.each(["controller missing", "backup corrupted", "backup stale"])(
    "replacement fence: %s is not permission to destroy", async mode => {
      const f = await conversationFixture();
      await f.preserve({ controller: mode !== "controller missing", completedAt: new Date(Date.now() - 60_000).toISOString() });
      if (mode === "backup corrupted") await writeFile(join(f.backupRoot()!, "runner", "conversation.json"), "corrupted");
      if (mode === "backup stale") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.previousRunId,
        agentId: f.agentId, seq: 1, eventType: "provider.event", payload: {}, createdAt: new Date() });
      await f.change({ image: "fake:changed" });
      const acquired = await acquire(f, f.runtime);
      await f.answer(acquired);
      expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
      expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ reason: "replacement_deferred_unexported_conversation" });
      expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    });

  it("replacement fence: a busy durable source is kept and refused, never shared with this run", async () => {
    const f = await conversationFixture();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.previousRunId));
    await f.change({ image: "fake:changed" });
    await expect(acquire(f, f.runtime)).rejects.toThrow("replacement_deferred_unexported_conversation: source_busy");
    expect(f.call).not.toHaveBeenCalled();
    expect(await environmentService(db).getLeaseById(f.lease.id)).toMatchObject({ status: "retained" });
  });

  it("replacement fence: no held conversation preserves stock mismatch destruction and creation", async () => {
    const seeded = await seed();
    seeded.environment.config = { ...seeded.environment.config, image: "fake:changed" };
    const { call, runtime } = worker(seeded, async () => { throw new Error("must create, not resume"); });
    call.mockImplementation(async (_id, method, params) => {
      if (method === "environmentDestroyLease") return { providerLeaseId: seeded.providerLeaseId, state: "destroyed" };
      if (method === "environmentAcquireLease") return { providerLeaseId: "replacement-sandbox", metadata: { remoteCwd: "/workspace" } };
      throw new Error(`Unexpected ${method}: ${JSON.stringify(params)}`);
    });
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(call.mock.calls.map(([, method]) => method)).toEqual(["environmentDestroyLease", "environmentAcquireLease"]);
    if (process.env.PAPERCLIP_REPLACEMENT_ROWS) await appendFile(process.env.PAPERCLIP_REPLACEMENT_ROWS,
      JSON.stringify({ row: expect.getState().currentTestName, runId: seeded.runId, sourceLeaseId: seeded.lease.id,
        selectedLeaseId: acquired.lease.id, methods: call.mock.calls.map(([, method]) => method) }) + "\n");
  });

  it("replaces a clean, saved sandbox that keeps refusing to resume, within a bounded budget (staging shape)", async () => {
    const seeded = await seed();
    const step = stepClock();
    const { call, runtime } = worker(seeded, async () => {
      step();
      throw new JsonRpcCallError({ code: -32000, message: STAGING_REFUSAL });
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
    const resumes = call.mock.calls.filter(([, method]) => method === "environmentResumeLease");
    // Retried inside the run, then stopped well short of the five-minute deadline.
    expect(resumes.length).toBeGreaterThan(1);
    for (const [, , , timeoutMs] of resumes) expect(timeoutMs).toBeLessThanOrEqual(90_000);
    // The old sandbox is handed to the cleanup sweep; no synchronous destroy
    // delays the first turn.
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "pending_cleanup", cleanupStatus: "failed", failureReason: "resume_failed",
    });
  });

  it("keeps the preserved lease when the replacement cannot be created, so the next attempt replaces it", async () => {
    const seeded = await seed();
    const refuse = async () => { throw new JsonRpcCallError({ code: -32000, message: STAGING_REFUSAL }); };
    const step = stepClock();
    const failing = worker(seeded, async () => { step(); return await refuse(); }, { acquireFails: true });
    await expect(acquire(seeded, failing.runtime)).rejects.toThrow();
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "retained", providerLeaseId: seeded.providerLeaseId,
    });

    // The bounded retry runs as a new run that reserves the same clean workspace.
    const retryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "assignment", status: "running" });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    await db.update(executionWorkspaces).set({ metadata: { ...workspace!.metadata,
      remoteWorkspace: { ...(workspace!.metadata!.remoteWorkspace as Record<string, unknown>), writerRunId: retryRunId } } })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const retry = worker(seeded, async () => { step(); return await refuse(); });
    const acquired = await acquire(seeded, retry.runtime, retryRunId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
    // The replacement carries the verified harness backup, so the session restores
    // without waiting for the old sandbox to be deleted.
    expect(acquired.lease.metadata?.nativeHarnessBackup).toMatchObject({ authorizedProviderLeaseId: seeded.providerLeaseId });
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({ status: "pending_cleanup" });
  });

  it("replaces a released lease saved by an older release in the same way", async () => {
    const seeded = await seed({ leaseStatus: "released" });
    const step = stepClock();
    const { runtime } = worker(seeded, async () => {
      step();
      throw new JsonRpcCallError({ code: -32000, message: "Sandbox state change in progress",
        data: environmentResumeErrorData(Object.assign(new Error("private"), { statusCode: 409 })) });
    });
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
  });

  // Staging: a run could not retire its predecessor's warm
  // Runner on this sandbox, did no provider work, and asked for a fresh one.
  async function markReplaceBeforeReuse(seeded: Awaited<ReturnType<typeof seed>>) {
    await environmentService(db).updateLeaseMetadata(seeded.lease.id, { ...seeded.lease.metadata,
      replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId: randomUUID(), predecessorRunId: randomUUID(),
        recordedAt: new Date().toISOString() } });
  }

  it("replaces a resumable sandbox whose previous Runner could not be retired, without resuming it", async () => {
    const seeded = await seed();
    await markReplaceBeforeReuse(seeded);
    const { call, runtime } = worker(seeded, async () => ({ providerLeaseId: seeded.providerLeaseId,
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } }));
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed",
      cause: "native_predecessor_retirement_unproven" });
    // The new sandbox restores the saved session from the verified backup.
    expect(acquired.lease.metadata?.nativeHarnessBackup).toMatchObject({ authorizedProviderLeaseId: seeded.providerLeaseId });
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentResumeLease", expect.anything(), expect.anything());
    // The old sandbox, with the Runner on it, is kept for the cleanup sweep.
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({ status: "pending_cleanup" });
  });

  it.each([
    ["unsaved work on the sandbox", { dirty: true }],
    ["no verified harness backup", { backupStamp: false }],
  ] as Array<[string, Shape]>)("resumes a sandbox marked for replacement as before when it holds %s", async (_label, shape) => {
    const seeded = await seed(shape);
    await markReplaceBeforeReuse(seeded);
    const { runtime } = worker(seeded, async () => ({ providerLeaseId: seeded.providerLeaseId,
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } }));
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
  });

  it.each([
    ["reply", "restoredFromSnapshotAt"], ["metadata", "restoredFromSnapshotAt"], ["lease", "restoredFromSnapshotAt"],
    ["metadata", "rebootedAt"], ["lease", "rebootedAt"],
  ] as const)("records process loss from %s.%s at both resume doors without replacing the disk", async (source, marker) => {
    const seeded = await seed();
    const restoredFromSnapshotAt = "2026-11-25T12:00:00.000Z";
    const signal = { [marker]: restoredFromSnapshotAt };
    if (source === "lease") seeded.lease.metadata = { ...seeded.lease.metadata, ...signal };
    const { call, runtime } = worker(seeded, async () => ({ providerLeaseId: seeded.providerLeaseId,
      ...(source === "reply" ? { restoredFromSnapshotAt } : {}),
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace", ...(source === "metadata" ? signal : {}) } }));
    if (source === "lease") await environmentService(db).updateLeaseMetadata(seeded.lease.id, seeded.lease.metadata!);
    const expected = { outcome: "resumed", ...signal };
    const resumed = await runtime.resumeRunLease({ environment: seeded.environment, lease: seeded.lease });
    expect(resumed).toMatchObject({ providerLeaseId: seeded.providerLeaseId, metadata: signal });
    const recorded = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(recorded?.metadata).toMatchObject({ ...seeded.lease.metadata, ...signal });
    // Repeated notification keeps the same provenance, workspace and backup.
    await runtime.resumeRunLease({ environment: seeded.environment, lease: recorded! });
    expect((await environmentService(db).getLeaseById(seeded.lease.id))?.metadata).toEqual(recorded?.metadata);
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata).toMatchObject({ ...signal, sandboxLeaseAcquisition: expected,
      nativeHarnessBackup: seeded.lease.metadata!.nativeHarnessBackup });
    expect(call.mock.calls.every(([, method]) => method === "environmentResumeLease")).toBe(true);
  });

  it.each(["restoredFromSnapshotAt", "rebootedAt"] as const)("carries handled %s through a later reusable lease and recognizes the next loss", async marker => {
    const seeded = await seed();
    const first = "2026-11-25T12:00:00.000Z";
    const handledProcessRestartKey = JSON.stringify(marker === "rebootedAt" ? [null, first] : [first, null]);
    seeded.lease.metadata = { ...seeded.lease.metadata, [marker]: first, handledProcessRestartKey };
    await environmentService(db).updateLeaseMetadata(seeded.lease.id, seeded.lease.metadata);
    let current = first;
    const { runtime } = worker(seeded, async () => ({ providerLeaseId: seeded.providerLeaseId,
      ...(marker === "restoredFromSnapshotAt" ? { restoredFromSnapshotAt: current } : {}),
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace", [marker]: current } }));
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.metadata?.handledProcessRestartKey).toBe(handledProcessRestartKey);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed", handledProcessRestartKey });
    current = "2026-11-25T13:00:00.000Z";
    const resumed = await runtime.resumeRunLease({ environment: seeded.environment, lease: acquired.lease });
    expect(resumed?.metadata).toMatchObject({ [marker]: current, handledProcessRestartKey });
    expect((await environmentService(db).getLeaseById(acquired.lease.id))?.metadata).toMatchObject({ [marker]: current, handledProcessRestartKey });
  });

  it("retries a sandbox state change inside the run and resumes the same sandbox", async () => {
    const seeded = await seed();
    const { call, runtime } = worker(seeded, async (attempt) => {
      if (attempt === 1) throw new JsonRpcCallError({ code: -32000, message: "Sandbox state change in progress" });
      return { providerLeaseId: seeded.providerLeaseId, metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } };
    });
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(2);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
  });

  it.each([
    ["unsaved work on the sandbox", { dirty: true }, undefined],
    ["no saved workspace version", { snapshot: null }, undefined],
    ["a saved version that never committed", { snapshot: "pending" }, undefined],
    ["a live owner", { previousRunStatus: "running" }, undefined],
    ["no verified harness backup (older lease)", { backupStamp: false }, undefined],
    ["a provider access refusal", {}, 403],
  ] as Array<[string, Shape, number | undefined]>)("keeps the sandbox and fails strictly with %s", async (_label, shape, status) => {
    const seeded = await seed(shape);
    const step = stepClock();
    const { call, runtime } = worker(seeded, async () => {
      step();
      throw new JsonRpcCallError({ code: -32000, message: STAGING_REFUSAL,
        ...(status ? { data: environmentResumeErrorData(Object.assign(new Error("private"), { statusCode: status })) } : {}) });
    });
    await expect(acquire(seeded, runtime)).rejects.toThrow(
      /could not be resumed \(cause=sandbox_state_transition( status=403)?\); the lease was preserved and no replacement was created\.$/,
    );
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: shape.leaseStatus ?? "retained", providerLeaseId: seeded.providerLeaseId,
    });
  });

  function rpcTimeoutClock() {
    let clock = Date.now();
    const startedAt = clock;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    return {
      elapsed: () => clock - startedAt,
      timeOut: (timeoutMs: number) => {
        clock += timeoutMs;
        return new JsonRpcCallError({ code: -32003,
          message: `RPC call "environmentResumeLease" timed out after ${timeoutMs}ms` });
      },
    };
  }

  it("keeps waiting for an idle sandbox whose resume timed out and resumes it in the same run (staging shape)", async () => {
    const seeded = await seed({ leaseStatus: "released", dirty: true });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (attempt, timeoutMs) => {
      if (attempt === 1) throw clock.timeOut(timeoutMs);
      return { providerLeaseId: seeded.providerLeaseId, metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } };
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    const resumes = call.mock.calls.filter(([, method]) => method === "environmentResumeLease");
    expect(resumes).toHaveLength(2);
    for (const [, , , timeoutMs] of resumes) expect(timeoutMs).toBeLessThanOrEqual(90_000);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
  });

  it("applies the idle-start extension to a provider liveness deadline named only by its errno", async () => {
    const seeded = await seed({ leaseStatus: "released", dirty: true });
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { call, runtime } = worker(seeded, async (attempt, timeoutMs) => {
      if (attempt === 1) {
        clock += timeoutMs;
        throw new JsonRpcCallError({ code: -32000,
          message: `Daytona sandbox liveness call "sandbox.refreshData" did not respond within ${timeoutMs} ms; the sandbox connection is unresponsive.`,
          data: environmentResumeErrorData(Object.assign(new Error("private"), { code: "ETIMEDOUT" })) });
      }
      return { providerLeaseId: seeded.providerLeaseId, metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } };
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(2);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
  });

  it("waits out the in-flight resume when a retry finds the stopped sandbox still settling", async () => {
    const seeded = await seed({ leaseStatus: "released", dirty: true });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (attempt, timeoutMs) => {
      if (attempt === 1) throw clock.timeOut(timeoutMs);
      if (attempt === 2) throw new JsonRpcCallError({ code: -32000,
        message: "The stopped Daytona sandbox is still settling cancelled work. Retry shortly." });
      return { providerLeaseId: seeded.providerLeaseId, metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } };
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(3);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
  });

  it("stops waiting at the provider start deadline and keeps the sandbox when every resume times out", async () => {
    const seeded = await seed({ leaseStatus: "released", dirty: true });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });

    await expect(acquire(seeded, runtime)).rejects.toThrow(
      /could not be resumed \(cause=transport_timeout\); the lease was preserved and no replacement was created\.$/,
    );

    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease").length).toBeGreaterThan(1);
    expect(clock.elapsed()).toBeLessThanOrEqual(330_000);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "released", providerLeaseId: seeded.providerLeaseId,
    });
  });

  it("continues on a new sandbox and keeps the old one when an idle sandbox never starts and has no harness backup (staging shape)", async () => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe("replacement-sandbox");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed" });
    expect(acquired.lease.metadata?.nativeHarnessBackup).toBeUndefined();
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease").length).toBeGreaterThan(1);
    expect(clock.elapsed()).toBeLessThanOrEqual(330_000);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept).toMatchObject({ status: "released", providerLeaseId: seeded.providerLeaseId, cleanupStatus: null });
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toMatchObject({
      runId: seeded.runId, replacementLeaseId: acquired.lease.id,
    });

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "assignment", status: "running" });
    await environmentService(db).releaseLease(acquired.lease.id, "released");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
    const next = worker(seeded, async () => ({ providerLeaseId: "replacement-sandbox",
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace" } }));
    const resumed = await acquire(seeded, next.runtime, nextRunId);
    expect(resumed.lease.providerLeaseId).toBe("replacement-sandbox");
    const nextResumes = next.call.mock.calls.filter(([, method]) => method === "environmentResumeLease");
    expect(nextResumes).toHaveLength(1);
    expect(nextResumes[0]![2]).toMatchObject({ providerLeaseId: "replacement-sandbox" });
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "released", providerLeaseId: seeded.providerLeaseId,
    });
  });

  it("never destroys a sandbox kept after replacement through the run or workspace teardown paths", async () => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });
    const acquired = await acquire(seeded, runtime);
    await environmentService(db).releaseLease(acquired.lease.id, "released");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
    const kept = (await environmentService(db).getLeaseById(seeded.lease.id))!;

    await expect(runtime.destroyRunLease({ environment: seeded.environment, lease: kept })).resolves.toBeNull();
    const destroyed = await runtime.destroyReusableSandboxLeases({ companyId: seeded.companyId,
      executionWorkspaceId: seeded.executionWorkspaceId });

    expect(destroyed.map(record => record.lease.id)).toEqual([acquired.lease.id]);
    expect(call.mock.calls.filter(([, method, params]) => method === "environmentDestroyLease"
      && (params as { providerLeaseId?: string }).providerLeaseId === seeded.providerLeaseId)).toHaveLength(0);
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({
      status: "released", providerLeaseId: seeded.providerLeaseId,
    });
  });

  it("destroys a sandbox kept after replacement when an operator approves the environment delete", async () => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false });
    const clock = rpcTimeoutClock();
    const { runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });
    const acquired = await acquire(seeded, runtime);
    await environmentService(db).releaseLease(acquired.lease.id, "released");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));

    const teardown = worker(seeded, async () => { throw new Error("no resume during delete"); });
    teardown.call.mockImplementation(async (_pluginId: string, method: string, params: unknown) => {
      if (method === "environmentDestroyLease") return { providerLeaseId: (params as { providerLeaseId: string }).providerLeaseId };
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const result = await teardown.runtime.destroyReusableSandboxLeasesForEnvironment({
      environmentId: seeded.environment.id, consentedBy: "operator" });

    expect(result).toMatchObject({ destroyed: 2, failed: 0 });
    expect(teardown.call.mock.calls.filter(([, method, params]) => method === "environmentDestroyLease"
      && (params as { providerLeaseId?: string }).providerLeaseId === seeded.providerLeaseId)).toHaveLength(1);
    const deleted = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(deleted?.status).not.toBe("pending_cleanup");
    expect(deleted?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  it("keeps an idle sandbox with no harness backup when some resume calls failed for another reason", async () => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (attempt, timeoutMs) => {
      if (attempt === 1) throw clock.timeOut(timeoutMs);
      throw Object.assign(clock.timeOut(timeoutMs), { message: "connection reset by peer (ECONNRESET)" });
    });

    await expect(acquire(seeded, runtime)).rejects.toThrow(/the lease was preserved and no replacement was created\.$/);
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease").length).toBeGreaterThan(1);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  it.each([
    ["unsaved work on the sandbox", { dirty: true }],
    ["no saved workspace version", { snapshot: null }],
  ] as Array<[string, Shape]>)("keeps an idle sandbox with no harness backup that never starts and fails strictly with %s", async (_label, shape) => {
    const seeded = await seed({ leaseStatus: "released", backupStamp: false, ...shape });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });

    await expect(acquire(seeded, runtime)).rejects.toThrow(
      /could not be resumed \(cause=transport_timeout\); the lease was preserved and no replacement was created\.$/,
    );
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept).toMatchObject({ status: "released", providerLeaseId: seeded.providerLeaseId });
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  it("does not extend the wait for a sandbox that a live run still holds", async () => {
    const seeded = await seed({ previousRunStatus: "running", dirty: true });
    const clock = rpcTimeoutClock();
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => { throw clock.timeOut(timeoutMs); });

    await expect(acquire(seeded, runtime)).rejects.toThrow(/could not be resumed \(cause=transport_timeout\)/);

    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(1);
    expect(clock.elapsed()).toBeLessThanOrEqual(90_000);
  });
});
