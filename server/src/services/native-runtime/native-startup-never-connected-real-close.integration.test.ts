import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunnerCheckpoints,
} from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

// Row B (rowb-read.md): r104c's never-connected lane, driven through the REAL
// failed-open close. A run.prepare whose Runner never connects times out; the
// real Codex driver then awaits its transport's close, which queues the
// lifecycle cleanup (runner.drain / runner.suspend) into the controller journal
// and persists it through the real checkpoint writer. Nothing authenticated,
// no ticket was used and no provider event exists, so the real recovery
// classifier (nativeRunnerNeverAuthenticated is NOT mocked here) must still
// see a bootstrap retry. Only the provider call itself is replaced: it drives
// the real transport and driver and rethrows their own failure.
const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { createNativeSessionBackend, createRunnerdCodexTransport, createRunnerProviderLaunch, decodeDurablePrpCheckpoint,
  DurablePrpControlPlane, type RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { executePaperclipNativeSession, nativeProviderRecoveryEvidence, nativeSessionFailureSourceCode } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter, registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { FRESH_THREAD_STARTED_NOTE } from "./fresh-thread-stop-gate.js";
import { selectFreshContinuationThread } from "./pi-conversation-record.js";
import { settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";

const NEVER_CONNECTED = /^runner_ingress_unavailable: PRP command run\.prepare timed out \(runner never connected; pending ahead 0; last runner event none\)$/;
const TRUTHFUL = "Provider startup failed 3 times before any work began; starting again in a fresh run.";

describe("a never-connected run.prepare whose real failed open queued its cleanup command (Row B)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const companyId = randomUUID();
  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-never-connected-real-close-");
    db = createDb(temporary.connectionString);
    root = await mkdtemp(join(tmpdir(), "native-never-connected-real-close-"));
    await db.insert(companies).values({ id: companyId, name: "Never connected real close", issuePrefix: "NRC" });
  });
  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function seed() {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: `Agent ${agentId.slice(0, 8)}`, status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    const issueId = randomUUID();
    const runId = randomUUID();
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Please do this first task",
      status: "in_progress", workMode: "standard", assigneeAgentId: agentId }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
      body: "Please do this first task." }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
      runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system",
      startedAt: new Date(), contextSnapshot: { issueId, wakeCommentId: comment!.id } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run: run!, issue: issue!, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "gpt-5.6-luna" },
      task: { identifier: issueId, title: issue!.title, description: null, prompt: "Continue the task.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) },
      interactionResponses: [],
      credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeExecutionInput: execution })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const identity = { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
      environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId };
    return { agentId, issueId, runId, execution, identity, runnerInstanceId: native.runnerInstanceId,
      stateDirectory: join(root, runId), binding: { companyId, issueId, runId } };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  /**
   * The real failed open: the real Codex driver over the real runnerd
   * transport, whose controller journal is persisted by the real checkpoint
   * registration. The launched Runner process never dials in, so it never
   * authenticates or uses its ticket. Returns the driver's own error.
   */
  async function realFailedOpen(seeded: Seeded, bootId: string): Promise<Error> {
    // A same-run retry first restores this run's persisted controller journal
    // (native-session-executor.ts restorePerTurnRunnerdController) into the
    // controller root; each attempt here gets a fresh local root for its
    // controller-side provider home.
    const stateDirectory = join(seeded.stateDirectory, randomUUID());
    (await loadNativeRunnerCheckpoint(db, seeded.binding))?.restoreSessionDirectory(stateDirectory);
    const launch = vi.fn((spec: RunnerProcessLaunchSpec) => {
      // A Runner that never connects: alive until contained, silent.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: {} });
      children.add(child);
      void spec;
      return {
        child,
        completion: new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveExit, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => { children.delete(child); resolveExit({ code, signal, stdout: "", stderr: "" }); });
        }),
        isExitConfirmed: () => child.exitCode !== null || child.signalCode !== null,
      };
    });
    // A remote box's prepared launch (paths on the Runner host, never on this controller).
    const prepareLaunch = async (requirements: Parameters<typeof createRunnerProviderLaunch>[0]) => ({
      configurationId: `never-connected-${requirements.identity.runId}`,
      requirementsDigest: `sha256:${createHash("sha256").update(JSON.stringify(requirements, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest("hex")}`,
      provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: [] }, root: "/remote", cwd: "/remote/workspace",
        codexHome: "/remote/codex-home", codexCommand: "/remote/bin/codex", providerNodeCommand: "/remote/bin/node",
        opencodeProxyPath: "", acpxSidecarPath: "" }),
    });
    const backend = createNativeSessionBackend(seeded.execution, {
      runnerInstanceId: seeded.runnerInstanceId, environment: {}, workingDirectoryAuthority: "runner_prepared_launch",
      codexTransportFactory: () => createRunnerdCodexTransport({
        provider: "codex", stateDirectory, prpIdentity: seeded.identity, prepareLaunch, externallySandboxed: true,
        runnerArtifact: { version: "never-connected-fixture", digest: `sha256:${"b".repeat(64)}` },
        runnerProcessLauncher: launch, closeGraceMs: 2_000, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        controlPlaneRegistration: async (authority) => {
          await registerNativeRunnerCheckpoint({ db, binding: seeded.binding, bootId, authority });
          await authority.start();
          return { release: () => undefined, startupFailureCode: "runner_ingress_unavailable" as const };
        },
      }).transport,
    } as never);
    const failure = await backend.openSession({ identity: { runId: seeded.runId, sessionId: seeded.identity.normalizedSessionId,
      companyId, issueId: seeded.issueId, agentId: seeded.agentId }, workingDirectory: "/remote/workspace" } as never)
      .then(() => null, (error: unknown) => error);
    expect(launch, String((failure as Error)?.stack)).toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    return failure as Error;
  }

  async function commandTypes(seeded: Seeded) {
    const checkpoint = await loadNativeRunnerCheckpoint(db, seeded.binding);
    const records = checkpoint!.records;
    const header = JSON.parse(records.get("header")!) as { state: Record<string, any> };
    const commands = [...records].filter(([key]) => key.startsWith("command:"))
      .sort(([left], [right]) => Number(left.slice(8)) - Number(right.slice(8)))
      .map(([, value]) => JSON.parse(value) as { type: string; status: string; result: unknown });
    return { records, header, commands };
  }

  async function read(seeded: Seeded) {
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId));
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, seeded.issueId),
      eq(issueComments.authorType, "system")));
    const continued = await db.select().from(activityLog).where(and(eq(activityLog.entityId, seeded.issueId),
      eq(activityLog.action, "issue.continued_from_saved_work")));
    return { coordinator: coordinator!, notes: notes.filter(note => !note.deletedAt), continued };
  }

  async function claimRetry(seeded: Seeded) {
    const { coordinator } = await read(seeded);
    expect(coordinator.nextAttemptAt).toBeInstanceOf(Date);
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "never-connected-real-close", runIds: [seeded.runId],
      now: new Date(coordinator.nextAttemptAt!.getTime() + 1), deferIneligible: false });
    expect(claims).toHaveLength(1);
    return claims[0]!.leaseOwner;
  }

  /** One executor attempt whose provider call is the real failed open. */
  async function attempt(seeded: Seeded, leaseOwner?: string) {
    let driverFailure: Error | null = null;
    provider.execute.mockReset().mockImplementation(async () => {
      const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId));
      driverFailure = await realFailedOpen(seeded, owner!.controllerBootId!);
      throw driverFailure;
    });
    const rejected = await executePaperclipNativeSession({ db, execution: seeded.execution, runnerInstanceId: seeded.runnerInstanceId,
      ...(leaseOwner ? { leaseOwner } : {}),
      backend: { descriptor: async () => { throw new Error("Unexpected provider descriptor call"); },
        openSession: async () => { throw new Error("Unexpected provider session call"); } } }).then(() => null, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect(driverFailure, String(rejected)).not.toBeNull();
    return driverFailure!;
  }

  it("classifies bootstrap_retry on every attempt, exhausts after 3 and continues in a fresh run with the one truthful note", async () => {
    const seeded = await seed();
    for (const number of [1, 2, 3]) {
      const failure = await attempt(seeded, number === 1 ? undefined : await claimRetry(seeded));
      expect(failure.message, `attempt ${number}`).toMatch(NEVER_CONNECTED);
      expect(nativeSessionFailureSourceCode(failure)).toBe("runner_ingress_startup_failed");
      // The real close's journal: nothing authenticated, no ticket used, every
      // command still pending, and the close queued its lifecycle cleanup.
      const { records, header, commands } = await commandTypes(seeded);
      expect(header.state.connectionCount).toBe(0);
      expect(Object.values<{ usedAt: unknown }>(header.state.tickets).every(ticket => ticket.usedAt === null)).toBe(true);
      // No committed provider event part: only the header, cursor and commands.
      expect([...records.keys()].filter(key => !key.startsWith("command:")).sort()).toEqual(["cursor", "header"]);
      expect(commands.every(command => command.status === "pending" && command.result === null)).toBe(true);
      expect(commands[0]!.type).toBe("run.prepare");
      expect(commands.some(command => command.type === "runner.suspend" || command.type === "runner.drain"), `attempt ${number}`).toBe(true);
      const { coordinator } = await read(seeded);
      expect(coordinator, `attempt ${number}: ${JSON.stringify(commands.map(command => command.type))}`).toMatchObject(number < 3
        ? { phase: "retryable_failure", attempt: number,
          failureDetail: expect.objectContaining({ originalFailureCode: "runner_ingress_startup_failed", recoveryMode: "bootstrap_retry" }) }
        : { phase: "terminal_failure", failureCode: "native_session_retry_exhausted", attempt: 3,
          failureDetail: expect.objectContaining({ originalFailureCode: "runner_ingress_startup_failed", recoveryMode: "bootstrap_retry",
            providerSessionEstablished: false, providerEventsExist: false, checkpointExists: false }) });
    }

    // r104c's lane (continuation-cause.ts): the automatic fresh continuation and its one truthful note.
    const unanswered = (now: Date) => settleUnansweredPersonMessage(db, { companyId, issueId: seeded.issueId, now });
    await unanswered(new Date(Date.now() + 16_000));
    await settleUnrecoverableExecutions(db, new Date(Date.now() + 20_000));
    await unanswered(new Date(Date.now() + 60_000));
    let state = await read(seeded);
    expect(state.continued).toHaveLength(1);
    expect(state.continued[0]!.details).toMatchObject({ failureCode: "runner_ingress_startup_failed" });
    const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, seeded.issueId),
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
    expect(action!.evidence).toMatchObject({ freshContinuation: { sourceRunId: seeded.runId },
      freshContinuationSettlement: { decision: "continue_in_fresh_run" } });
    const recordedAt = String((action!.evidence.freshContinuation as { recordedAt: string }).recordedAt);
    const [next] = await db.insert(heartbeatRuns).values({ companyId, agentId: seeded.agentId, status: "running",
      runtimeMode: "native", nativeIssueId: seeded.issueId, invocationSource: "automation", triggerDetail: "system",
      retryOfRunId: seeded.runId, createdAt: new Date(new Date(recordedAt).getTime() + 1_000), startedAt: new Date(),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId, recoveryActionId: action!.id, previousRunId: seeded.runId,
        retryOfRunId: seeded.runId, forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" },
    }).returning();
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
      { continuationDelivery: "delivered", continuationRunId: next!.id })}::jsonb` }).where(eq(issueRecoveryActions.id, action!.id));
    const input = { companyId, agentId: seeded.agentId, issueId: seeded.issueId, runId: next!.id };
    const selected = await selectFreshContinuationThread(db, input);
    expect(selected).toEqual(expect.any(String));
    // Reprocessing never posts a second note.
    expect(await selectFreshContinuationThread(db, input)).toBe(selected);
    await unanswered(new Date(Date.now() + 10 * 60_000));
    state = await read(seeded);
    expect(state.continued).toHaveLength(1);
    expect(state.notes.map(note => note.body)).toEqual([TRUTHFUL]);
    expect(state.notes.filter(note => note.body.includes(FRESH_THREAD_STARTED_NOTE))).toEqual([]);
  }, 300_000);

  it("guards: the same real post-close journal with an authenticated connection, a used ticket or a non-cleanup command stays ambiguous_state", async () => {
    const seeded = await seed();
    const bootId = randomUUID(), leaseOwner = randomUUID();
    await db.update(nativeRunFinalizations).set({ controllerBootId: bootId, controllerGeneration: 1, leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 10 * 60_000) }).where(eq(nativeRunFinalizations.runId, seeded.runId));
    const failure = await realFailedOpen(seeded, bootId);
    expect(failure.message).toMatch(NEVER_CONNECTED);
    const evidence = () => nativeProviderRecoveryEvidence({ db, runId: seeded.runId, executionTargetKind: "remote",
      sourceFailureCode: nativeSessionFailureSourceCode(failure) });
    const real = await commandTypes(seeded);
    expect(real.commands.map(command => command.type)).toContain("runner.suspend");
    // The unmutated real post-close journal is a bootstrap retry.
    expect((await evidence()).recoveryMode).toBe("bootstrap_retry");

    type Records = Map<string, string>;
    const editJson = (records: Records, key: string, edit: (value: Record<string, any>) => void) => {
      const value = JSON.parse(records.get(key)!); edit(value); records.set(key, JSON.stringify(value));
    };
    const owner = { companyId, issueId: seeded.issueId, runId: seeded.runId, authorityRunId: seeded.runId, bootId, generation: 1, leaseOwner };
    const persist = async (records: Records, act?: (core: InstanceType<typeof DurablePrpControlPlane>) => void) => {
      const directory = join(root, `${seeded.runId}-${randomUUID()}`);
      decodeDurablePrpCheckpoint(records).restoreSessionDirectory(directory);
      const core = new DurablePrpControlPlane({ stateDirectory: join(directory, "control-plane"), identity: seeded.identity,
        expectedRunnerVersion: "never-connected-fixture", expectedRunnerDigest: `sha256:${"b".repeat(64)}` });
      core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
      try { act?.(core); await core.flushCheckpoint(); } finally { await core.stop(); }
      const saved = (await commandTypes(seeded)).records;
      if (!act) for (const [key, value] of records) expect(saved.get(key), key).toBe(value);
      return saved;
    };
    const mutations: Array<[string, (records: Records) => void]> = [
      ["delivered cleanup command", records => {
        const command = [...records].filter(([key]) => key.startsWith("command:")).map(([,value]) => JSON.parse(value)).find(command => command.type === "runner.suspend");
        editJson(records, "header", header => { header.state.commandDeliveryCounts[command.commandId] = 1; });
      }],
      ["non-empty cleanup payload", records => {
        const key = [...records.keys()].find(candidate => candidate.startsWith("command:") && JSON.parse(records.get(candidate)!).type === "runner.suspend")!;
        editJson(records, key, command => { command.payload = { reason: "judge nonempty guard" }; });
      }],
      ["authenticated connection", records => editJson(records, "header", header => { header.state.connectionCount = 1; })],
      ["used ticket", records => editJson(records, "header", header => {
        for (const ticket of Object.values<Record<string, unknown>>(header.state.tickets)) ticket.usedAt = new Date().toISOString();
      })],
      ["answered cleanup command", records => {
        const key = [...records.keys()].find(candidate => candidate.startsWith("command:")
          && JSON.parse(records.get(candidate)!).type === "runner.suspend")!;
        editJson(records, key, command => { command.status = "completed"; command.result = { status: "completed" }; });
      }],
    ];
    for (const [name, mutate] of mutations) {
      const records = new Map(real.records);
      mutate(records);
      await persist(records);
      expect((await evidence()).recoveryMode, name).toBe("ambiguous_state");
    }
    // A non-cleanup command queued after the real cleanup (never delivered either).
    const extra = await persist(new Map(real.records), core => { core.queueCommand("turn.start", { prompt: "not a cleanup command" }); });
    expect([...extra.keys()].filter(key => key.startsWith("command:"))).toHaveLength(real.commands.length + 1);
    expect((await evidence()).recoveryMode, "non-cleanup extra command").toBe("ambiguous_state");
    // Even with an empty payload, only the close's own cleanup types qualify.
    await persist(new Map(real.records), core => { core.queueCommand("turn.start", {}); });
    expect((await evidence()).recoveryMode, "empty-payload non-cleanup command").toBe("ambiguous_state");
    // Restoring the real journal restores the proof (the guards above are not vacuous).
    await persist(new Map(real.records));
    expect((await evidence()).recoveryMode).toBe("bootstrap_retry");
  }, 120_000);
});
