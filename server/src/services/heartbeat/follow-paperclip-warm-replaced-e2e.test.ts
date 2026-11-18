/**
 * n-fallback E2E, CODEX warm row (RFL's rows; D-B5's second RED). The deployed
 * incident (562da3cc) is a Pi chat: its row is native-pi-rpc-replaced-box-followup.e2e.
 * A warm Codex conversation answers on controller C; its box is replaced (a
 * 'created' box at the SAME workspace path, empty disk, NO runner-state.json) and
 * there is no usable backup (no durable row; C's local failover backup moved
 * aside); C keeps its local warm envelope. The person follows up.
 *
 * (R)  plain policy 'allow_replacement_after_resume_failure' (the real selector
 *      computes it), default homeMode: the follow-up must ANSWER in a fresh
 *      provider thread from the earlier conversation (the fake provider names
 *      ALDER only if it was sent), with no stop notice, no structured refusal
 *      code and at most one note.
 *      RED on S1 74ccf170, observed: NativeProviderStateIncompatibleError "PRP
 *      provider resume state is unavailable" at native-session-runtime.ts:2668,
 *      because the warm rebind (loadWarmNativeCheckpoint) carries no
 *      providerRecoveryPolicy, so replacementAllowed (nsr:2593-2596) is false.
 *      Still RED after D-B1+D-B2 (observed). GREEN expected after D-B5.
 * The unfinished-goal control lives in the Pi row file and in D-B5's policy
 * equality rows: with the fake provider's active goal the Codex opening turn
 * never settles in this fixture (observed: 20 s turn timeout on S1).
 * (G)  governed wait, warm (prior 'yielded' + response_wake; the real selector
 *      gives 'allow_replacement_after_governed_wait'): the first follow-up on the
 *      created box must ANSWER, with at most one note and no FRESH_THREAD_* note.
 *      No history assertion: upstream's governed-wait fresh start carries no
 *      earlier context. D-B6's RED: the warm rebind keeps the prior cursor, so
 *      upstream's governed-wait fresh start refuses. If it fails, the row records
 *      a second person message (E2E-G-OBSERVATION) and fails naming the first error.
 *
 * REAL: embedded PG, lease fingerprints/acquisition, runtime selection, the
 * checkpoint policy (native-session-resume.ts), controller restoration,
 * createRunnerdBackend, runnerd transport, driver recoverSession, replacement
 * policy/openReplacementSession, the Rust paperclip-runnerd, PRP websocket
 * ingress, the bounded history loader, result checkpointing and finalization.
 * No backend, recovery-result or control-plane mocks; no hand-written recovery
 * envelope; no ensureFreshContinuation side door.
 * TRANSPORT: a remote target dials out over wss:, so a local TLS-terminating TCP
 * proxy (a throwaway CA, passed as the runner CA bundle, and its leaf) fronts the
 * fixture's real API server; bytes pass through unchanged.
 * FAKED I/O ONLY: the provider plugin's allocation RPC; a box command transport
 * that runs REAL sh in isolated local directories (the missing-file exit=1 comes
 * from real sh); fake-codex-app-server as the model provider, behind a bridge
 * that gives each provider process its own thread id and journals its input.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { connect as netConnect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, environments, heartbeatRunEvents, heartbeatRuns, issueComments,
  issues, nativeHarnessBackups, nativeRunResults, plugins } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { defaultCapabilityRunnerdBinary, coldAdmissionTimeoutMs } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture, fakeCodexAppServer } from "../../__tests__/helpers/native-restart.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { issueService } from "../issues.js";
import { FRESH_CONTINUATION_PENDING_BOUND_MS } from "../fresh-continuation-fallback.js";
import { PROCESS_START_REQUESTED } from "../native-local-process-stop.js";
const HELD_PREDECESSOR_NOTICE = "Your message and saved work are kept, but the previous run of this conversation did not finish. Send a new message to try again.";
import { FRESH_THREAD_STARTED_NOTE } from "../native-runtime/fresh-thread-stop-gate.js";
import { createNativeSessionHandoffLoader } from "../native-runtime/native-session-handoff.js";
import { resolveHeartbeatNativeRuntimeMode } from "../native-runtime/runtime-mode.js";
import { closeIdleWarmNativeSessionsForRestart, executePaperclipNativeSession, scopedRunnerdStateRoot } from "../native-runtime/native-session-executor.js";
import { finalizeNativeRun } from "../native-runtime/native-run-finalizer.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./runtime-selection.js";

type BoxCommand = Parameters<CommandManagedRuntimeRunner["execute"]>[0];
type BoxResult = Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>;
type Observation = { command: BoxCommand; result: BoxResult; stack: string };
type Selection = Extract<Awaited<ReturnType<typeof selectHeartbeatRuntime>>, { selected: true }>;
type Execution = NonNullable<Selection["nativeExecution"]>;

// External box I/O boundary, equivalent to an SSH/provider command runner, not
// an implementation of native recovery. Missing-file exit=1 comes from REAL sh.
function localBox(cwd: string, observations: Observation[]): CommandManagedRuntimeRunner {
  return { async execute(command) {
    const stack = new Error("fixture box dispatch").stack ?? "";
    const child = spawn(command.command, command.args ?? [], { cwd: command.cwd ?? cwd,
      env: { PATH: process.env.PATH, HOME: cwd, ...command.env }, stdio: ["pipe", "pipe", "pipe"] });
    const startedAt = new Date().toISOString();
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, command.timeoutMs ?? 30_000);
    child.stdin.on("error", () => undefined);
    child.stdin.end(command.stdin);
    try {
      const result = await new Promise<BoxResult>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr, timedOut,
          pid: child.pid ?? null, startedAt }));
      });
      observations.push({ command, result, stack });
      return result;
    } finally { clearTimeout(timer); }
  } };
}

// Fake PROVIDER ONLY. Rust fixture Codex uses the fixed id codex-thread-1, which
// would hide a real thread change. Translate that id per process at the provider
// boundary, preserve all request/event shapes, and journal the unmodified input.
// A follow-up answer is computed from the turn/start this process was SENT: it
// names the conversation word only if the earlier conversation reached it.
const providerBridge = `
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [fake, resultFile, requestFile, ...fakeArgs] = process.argv.slice(2);
const providerId = "fixture-" + randomUUID();
const summary = JSON.parse(readFileSync(resultFile, "utf8")).summary;
let derived = null;
const child = spawn(fake, ["--state-file", process.env.CODEX_HOME + "/fixture-state.json",
  "--terminal-result-file", resultFile, ...fakeArgs], { stdio: ["pipe", "pipe", "inherit"] });
const replace = (v, from, to) => typeof v === "string" ? (v === from ? to : v)
  : Array.isArray(v) ? v.map(x => replace(x, from, to))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k, replace(x, from, to)])) : v;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  appendFileSync(requestFile, JSON.stringify({ providerId, request }) + "\\n");
  if (request.method === "turn/start") {
    const sent = JSON.stringify(request.params ?? null);
    if (sent.includes("What was our conversation word?")) {
      const word = /Remember ([A-Z]+) as our conversation word/.exec(sent)?.[1];
      derived = word ? "Our conversation word was " + word + ". This answers your follow-up."
        : "I do not know our conversation word. This answers your follow-up.";
    }
  }
  child.stdin.write(JSON.stringify(replace(request, providerId, "codex-thread-1")) + "\\n");
}).on("close", () => child.stdin.end());
createInterface({ input: child.stdout }).on("line", line => {
  let value = replace(replace(JSON.parse(line), "codex-thread-1", providerId), "Codex completed the fake turn.", derived ?? summary);
  if (derived && value.method === "item/tool/call" && value.params?.tool === "paperclip_finish") {
    value = { ...value, params: { ...value.params, arguments: { ...value.params.arguments, summary: derived } } };
  }
  process.stdout.write(JSON.stringify(value) + "\\n");
});
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => process.exit(code ?? 1));
`;
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const FOLLOW_UP = "What was our conversation word? Please answer this follow-up.";
const ANSWER_WITH_HISTORY = "Our conversation word was ALDER. This answers your follow-up.";
const SECOND_FOLLOW_UP = "What was our conversation word? I am asking again.";

type Shape = {
  row: "R" | "G"; title: string; policy: string; fakeArgs: string[]; opening: "done" | "yielded";
};
const SHAPES: Shape[] = [
  { row: "R", title: "(R) plain policy: the first follow-up on a replaced box answers in a fresh thread from the earlier conversation",
    policy: "allow_replacement_after_resume_failure", fakeArgs: [], opening: "done" },
  // D-B6's RED (code-lead's sixth hole): the warm cross-run rebind keeps the prior
  // run's cursor, and upstream's governed-wait fresh start requires cursor null or
  // "0" (native-session-runtime.ts governedWaitFollowUpMayStartFresh). The opening
  // yields through the agent's own pending question: the fake provider calls
  // request_human_input (--repair-first-task-confirmation), and the executor builds
  // the 'interaction-response:<id>' governed wait (native-session-executor.ts
  // nativeGovernedWaitResult). The deployed Pi shape is the Pi file's G row.
  { row: "G", title: "(G) governed wait, warm: the first follow-up on a created box answers, with at most one note and no fresh-thread note",
    policy: "allow_replacement_after_governed_wait", fakeArgs: ["--repair-first-task-confirmation"], opening: "done" },
];

describeEmbeddedPostgres("follow-Paperclip n-fallback: real runner recovery on a created box without runner state", () => {
  const fixture = nativeRestartFixture(); // real DB + real PRP websocket authority
  let workspace: string, credentialHome: string, bridge: string;
  let tlsProxy: TlsServer | null = null, runnerPublicUrl = "", runnerCaBundlePath = "";
  beforeAll(async () => {
    const { runtimeRoot, apiUrl } = fixture.current;
    // rustls refuses a self-signed CA used as the server certificate
    // (CaUsedAsEndEntity), so make a throwaway CA and a leaf signed by it.
    const caKey = join(runtimeRoot, "runner-wss-ca.key"), key = join(runtimeRoot, "runner-wss.key");
    const csr = join(runtimeRoot, "runner-wss.csr"), cert = join(runtimeRoot, "runner-wss.crt"), ext = join(runtimeRoot, "runner-wss.ext");
    runnerCaBundlePath = join(runtimeRoot, "runner-wss-ca.crt");
    await writeFile(ext, "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n");
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", runnerCaBundlePath, "-days", "1", "-subj", "/CN=paperclip-e2e-ca",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
      ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=localhost"],
      ["x509", "-req", "-in", csr, "-CA", runnerCaBundlePath, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", ext],
    ]) {
      const made = spawnSync("openssl", args, { encoding: "utf8", cwd: runtimeRoot });
      if (made.status !== 0) throw new Error(`openssl ${args[0]} failed: ${made.stderr}`);
    }
    const api = new URL(apiUrl);
    tlsProxy = createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, socket => {
      const upstream = netConnect(Number(api.port), api.hostname);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise<void>(done => tlsProxy!.listen(0, "127.0.0.1", done));
    runnerPublicUrl = `wss://127.0.0.1:${(tlsProxy.address() as AddressInfo).port}`;
    workspace = join(runtimeRoot, "controller-workspace");
    credentialHome = join(runtimeRoot, "synthetic-credential-home");
    bridge = join(runtimeRoot, "fixture-provider.mjs");
    await mkdir(workspace, { recursive: true });
    await mkdir(credentialHome, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Answer the person's latest message using the saved task history.\n");
    await writeFile(join(credentialHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-fixture" }), { mode: 0o600 });
    await writeFile(bridge, providerBridge);
  });
  afterAll(async () => {
    await new Promise<void>(done => tlsProxy ? tlsProxy.close(() => done()) : done());
  });

  const nativeIt = process.platform === "win32" ? it.skip : it;
  nativeIt.each(SHAPES)("$title", async ({ row, policy, fakeArgs, opening: openingDisposition }) => {
    // Do not silently pass/skip a missing real-runner prerequisite in this gate.
    expect(existsSync(defaultCapabilityRunnerdBinary()), "build the real fixture runner before running this gate").toBe(true);
    expect(existsSync(fakeCodexAppServer), "build fake-codex-app-server before running this gate").toBe(true);
    const label = `WARM-REPLACED-${row}-${randomUUID().slice(0, 8)}`;
    const seeded = await fixture.seedRun(label);
    const { db, issueId, runId } = seeded;
    const { companyId, agentId, runtimeRoot } = fixture.current;
    const [agent] = await db.update(agents).set({ adapterConfig: { provider: "codex", model: "gpt-5.6-luna",
      lifecycleMode: "warm", instructionsFilePath: join(workspace, "AGENTS.md") } }).where(eq(agents.id, agentId)).returning();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const readRun = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
    const opening = await readRun(runId);
    const observations: Observation[] = [];
    const provider = `warm-replaced-${randomUUID()}`, pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: `paperclip.${provider}`, packageName: `@paperclipai/${provider}`,
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", manifestJson: {
        id: `paperclip.${provider}`, apiVersion: 1, version: "1.0.0", displayName: "Fixture warm box", description: "Fixture provider",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Fixture warm box",
          supportsReusableLeases: true, configSchema: { type: "object" } }],
      } });
    const [environment] = await db.insert(environments).values({ name: provider, driver: "sandbox",
      config: { provider, image: "fixture:old", reuseLease: true } }).returning();
    const boxes = new Map<string, CommandManagedRuntimeRunner>();
    let allocations = 0;
    // The fake provider allocates on acquire and RECORDS any other lease call
    // (stop/release/resume); it never destroys a box's disk.
    const providerCall = vi.fn(async (_id: string, method: string, params: { config: Record<string, unknown> }) => {
      if (method !== "environmentAcquireLease") return {};
      const providerLeaseId = `fixture-box-${++allocations}`;
      // A replacement box mounts the SAME workspace path with an empty disk. The
      // previous box's disk is kept, moved aside, never deleted.
      const cwd = join(runtimeRoot, `${runId}-box-workspace`);
      if (existsSync(cwd)) await rename(cwd, join(runtimeRoot, `${runId}-${providerLeaseId}-previous-disk`));
      await mkdir(cwd, { recursive: true });
      boxes.set(providerLeaseId, localBox(cwd, observations));
      return { providerLeaseId, metadata: { provider, ...params.config, remoteCwd: cwd } };
    });
    const worker = { isRunning: (id: string) => id === pluginId, call: providerCall,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const acquire = (id: string, env = environment) => runtime.acquireRunLease({ companyId, environment: env as Environment,
      issueId, agentId, adapterType: "paperclip_runner", heartbeatRunId: id, persistedExecutionWorkspace: null,
      warmRunnerIdleTimeoutMs: 300_000 });
    const original = await acquire(runId);
    const target = (lease: typeof original.lease): AdapterSandboxExecutionTarget => ({
      kind: "remote", transport: "sandbox",
      environmentId: environment.id, leaseId: lease.id, providerKey: provider, remoteCwd: String(lease.metadata?.remoteCwd),
      runner: boxes.get(lease.providerLeaseId!)!, reusableLeaseConfigured: true,
      effectiveCapabilities: { reusableLeases: true, nativeSyncIn: false, nativeSyncOut: false,
        persistentProcessSessions: false, independentControlCommands: true, incrementalSessionOutput: false,
        concurrentSyncOperations: false, duplexCommandStream: false, runnerWebSocketIngress: false },
      runnerLifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
      sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: lease.providerLeaseId! } });
    const input: HeartbeatRuntimeSelectionInput = {
      run: opening, agent,
      nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: opening, enabled: true, runtimeConfig: {},
        adapterConfig: agent.adapterConfig, agent, issue, target: null, workspaceId: null }),
      task: { issueRef: issue, issueContext: null, context: { paperclipTaskMarkdown: "Remember ALDER as our conversation word." },
        executionContinuation: null, safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: null, acceptedPlanContinuationWake: false },
      session: { persistedNativeExecutionInput: null, persistedRunnerProfile: {}, taskResumeSessionId: null,
        isFailedChatRunRetry: false, getFreshSessionHandoff: async () => null },
      workspace: { persistedExecutionWorkspace: null, executionWorkspace: { cwd: workspace, repoUrl: null, repoRef: null, branchName: null },
        executionTarget: target(original.lease), activeEnvironmentLease: original, isDotRun: false, projectRepositoryPaths: [] },
      config: { runtimeConfig: {}, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null,
        agentIdentity: undefined, issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined },
      recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null }, issuesSvc: issueService(db),
      runtimeEnv: {}, onAdapterEvent: async () => {}, onNativeLifecycleSelected() {}, onProviderResourceDisposition() {},
      onNativeOwnershipHeld() {}, stopControllerLease() {},
    };
    const requestFile = join(runtimeRoot, `${runId}-provider-requests.jsonl`);
    const resultFile = join(runtimeRoot, `${runId}-provider-result.json`);
    const codex = join(runtimeRoot, `${runId}-codex`);
    await writeFile(requestFile, "");
    const writeCodex = (args: string[]) => writeFile(codex, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.110.0'; exit 0; fi\nexec ${quote(process.execPath)} ${quote(bridge)} ${quote(fakeCodexAppServer)} ${quote(resultFile)} ${quote(requestFile)}${args.map(a => ` ${quote(a)}`).join("")}\n`, { mode: 0o700 });
    await writeCodex(fakeArgs);
    const writeResult = (execution: Execution, summary: string, disposition: "done" | "yielded" = "done") => writeFile(resultFile, JSON.stringify({
      schema: "paperclip.run_result.v1", reportedWorkDisposition: disposition, summary,
      completionClaim: { contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: disposition === "done",
        criteria: execution.completionContract.contract.criteria.map((c: { id: string }) => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })),
        remainingWork: disposition === "done" ? [] : [{ description: "Wait for the person's next message.", blocksCompletion: true }] },
      ...(disposition === "yielded" ? { continuation: { kind: "response_wake", summary: "Resume after the person's next message.",
        idempotencyKey: `response-wake-${runId}` } } : {}),
      evidence: [], verification: [], artifacts: [], attentionRequests: [] }));
    const execute = (selection: Selection) => {
      if (!selection.nativeExecution) throw new Error("Expected native execution");
      return executePaperclipNativeSession({ db, execution: selection.nativeExecution, runnerInstanceId: selection.nativeRunnerInstanceId!,
        useRunnerd: true, runnerExecutionTarget: input.workspace.executionTarget!, runnerIngressAuthorized: true, runnerPublicUrl, runnerCaBundlePath,
        runnerRemoteBinaryPath: defaultCapabilityRunnerdBinary(), runnerRemoteCodexPath: codex,
        managedAiCredentialHome: credentialHome, runnerEnvironment: { OPENAI_API_KEY: "synthetic-fixture" }, turnTimeoutMs: 20_000,
        getFreshSessionHandoff: selection.getNativeFreshSessionHandoff });
    };
    const readTurns = async () => (await readFile(requestFile, "utf8")).trim().split(/\r?\n/).filter(Boolean)
      .map(line => JSON.parse(line) as { providerId: string; request: { method: string; params?: unknown } })
      .filter(r => r.request.method === "turn/start");
    const persistedJson = async (id: string) => {
      const run = await readRun(id);
      const events = await db.select().from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, id)));
      return JSON.stringify({ resultJson: run.resultJson, runnerProfileJson: run.runnerProfileJson, errorCode: run.errorCode, events });
    };
    try {
      await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
        body: "Remember ALDER as our conversation word.", createdAt: new Date(opening.createdAt.getTime() - 1) });
      const first = await selectHeartbeatRuntime(db, input);
      if (!first.selected || !first.nativeExecution) throw new Error("Expected opening native selection");
      expect(first.nativeExecution.session.lifecyclePolicy.mode).toBe("warm");
      const oldId = first.nativeExecution.session.normalizedSessionId!;
      const earlierAnswer = "I saved ALDER as our conversation word.";
      await writeResult(first.nativeExecution, earlierAnswer, openingDisposition);
      expect(await execute(first)).toMatchObject({ exitCode: 0 });
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      const successful = await readRun(runId);
      const sourceCheckpoint = successful.runnerProfileJson?.sessionCheckpoint as {
        providerSessionId?: string; goal?: { status?: string } | null;
        semanticResult?: { reportedWorkDisposition?: string; continuation?: { kind?: string } } | null;
      };
      expect(successful.runnerProfileJson?.nativeControllerRecovery).toMatchObject({ schema: "paperclip.native-controller-recovery.v1" });
      const previousProviderId = sourceCheckpoint.providerSessionId;
      expect(previousProviderId).toBeTruthy();
      // Each shape's precondition on the REAL saved checkpoint (the policy's input).
      expect(sourceCheckpoint.goal ?? null).toBeNull();
      if (row === "G") {
        expect(sourceCheckpoint.semanticResult, "G prerequisite: the opening yielded to the next message")
          .toMatchObject({ reportedWorkDisposition: "yielded", continuation: { kind: "response_wake" } });
      }
      expect(await closeIdleWarmNativeSessionsForRestart()).toMatchObject({ busy: 0, failed: 0 });
      await environmentService(db).releaseLease(original.lease.id, "retained");
      const sourceEvidence = (await readRun(runId)).runnerProfileJson;
      // The SAME controller (same PAPERCLIP_HOME): only the box is replaced, and
      // there is NO usable backup (the deployed 562da3cc shape): the controller's
      // local failover backup is moved aside (kept, never deleted) and no durable
      // backup row exists.
      const failoverBackups = join(scopedRunnerdStateRoot(first.nativeExecution), "failover-backups");
      if (existsSync(failoverBackups)) await rename(failoverBackups, join(runtimeRoot, `${runId}-failover-backups-moved-aside`));
      expect(await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.companyId, companyId))).toHaveLength(0);

      // The opening's provider flags shape only the opening turn; a later provider
      // process is an ordinary one.
      await writeCodex([]);
      const started = performance.now();
      await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board", body: FOLLOW_UP });
      const [changed] = await db.update(environments).set({ config: { ...environment.config, image: "fixture:new" } })
        .where(eq(environments.id, environment.id)).returning();
      const admit = async (message: string) => {
        const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "running", scopeKind: "issue",
          contextSnapshot: { issueId, paperclipTaskMarkdown: message } }).returning();
        await db.update(issues).set({ status: "in_progress", executionRunId: run.id }).where(eq(issues.id, issueId));
        input.run = run;
        input.session.persistedNativeExecutionInput = null;
        input.session.persistedRunnerProfile = {};
        input.session.taskResumeSessionId = oldId;
        input.task.context = run.contextSnapshot!;
        input.session.getFreshSessionHandoff = createNativeSessionHandoffLoader({ db, companyId, agentId, issueId, before: run.createdAt });
        return run;
      };
      const current = await admit(FOLLOW_UP);
      const replacement = await acquire(current.id, changed);
      input.workspace.activeEnvironmentLease = replacement;
      input.workspace.executionTarget = target(replacement.lease);
      expect(replacement.lease.providerLeaseId).not.toBe(original.lease.providerLeaseId);
      const fingerprint = (lease: typeof original.lease) => (lease.metadata?.reusableSandboxLease as { leaseFingerprint?: string })?.leaseFingerprint;
      expect(fingerprint(original.lease)).toBeTruthy();
      expect(fingerprint(replacement.lease)).not.toBe(fingerprint(original.lease));
      expect(replacement.lease.metadata).not.toHaveProperty("nativeHarnessBackup");
      // No caller-owned fresh-continuation action and no forceFreshSession flag.
      const selected = await selectHeartbeatRuntime(db, input);
      if (!selected.selected || !selected.nativeExecution) throw new Error("Expected normal follow-up selection");
      expect(selected.nativeExecution.session.normalizedSessionId).toBe(oldId);
      expect(selected.nativeExecution.session.lifecyclePolicy.mode).toBe("warm");
      expect((await readRun(current.id)).runnerProfileJson?.sessionCheckpoint, `the real selector chose ${policy}`)
        .toMatchObject({ providerRecoveryPolicy: policy });
      expect((await readdir(input.workspace.executionTarget!.kind === "remote"
        ? input.workspace.executionTarget!.remoteCwd : workspace, { recursive: true }))
        .filter(path => path.endsWith("runner-state.json"))).toHaveLength(0);
      // The result file carries NO answer: the provider computes it from its input.
      await writeResult(selected.nativeExecution, "I do not know our conversation word.");
      const beforeExecution = observations.length;
      const outcome = await execute(selected).catch((error: unknown) => error);
      const missingStateReads = observations.slice(beforeExecution).filter(o => o.result.exitCode !== 0
        && o.command.args?.some(a => /test -f .*runner-state\.json/.test(a))
        && o.stack.includes("readRemoteRunnerState"));
      // Recorded, not required: on this Codex warm path S1 refuses before any
      // runner-state read (the deployed Pi chain reads it; see the Pi row).
      console.info(`E2E-${row}-RUNNER-STATE-READS: ${missingStateReads.length}`);
      const launched = await db.select({ eventType: heartbeatRunEvents.eventType }).from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, current.id)));
      expect(launched.map(e => e.eventType), "deployed 562da3cc shape: the follow-up really launched")
        .toContain(PROCESS_START_REQUESTED);
      const outcomeText = outcome instanceof Error ? `${(outcome as { code?: string }).code ?? "no-code"}: ${outcome.message}` : "answered";
      console.info(`E2E-${row}-FIRST-OUTCOME: ${outcomeText.slice(0, 400)}`);
      const comments = async () => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      const systemNotes = async () => (await comments()).filter(c => c.authorType === "system" && c.deletedAt === null);
      if (row === "G") {
        console.info(`E2E-G-CURSOR: ${JSON.stringify({ source: (sourceCheckpoint as { cursor?: unknown }).cursor ?? null,
          admitted: ((await readRun(current.id)).runnerProfileJson?.sessionCheckpoint as { cursor?: unknown } | undefined)?.cursor ?? null })}`);
      }
      if (row === "G" && outcome instanceof Error) {
        // Record what a SECOND person message does behind the failed run. Only the
        // heartbeat's own failure write is emulated; finalization is the REAL one.
        await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), error: outcome.message.slice(0, 2000),
          errorCode: (outcome as { code?: string }).code ?? "adapter_failed" }).where(eq(heartbeatRuns.id, current.id));
        const finalized = await finalizeNativeRun({ db, runId: current.id, workspaceFinalizeStatus: "failed", projectRunStatus: true })
          .then(() => "finalized", (error: unknown) => `finalize: ${error instanceof Error ? error.message : String(error)}`);
        await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board", body: SECOND_FOLLOW_UP });
        const second = await admit(SECOND_FOLLOW_UP);
        const again = await acquire(second.id, changed);
        input.workspace.activeEnvironmentLease = again;
        input.workspace.executionTarget = target(again.lease);
        let secondOutcome: unknown;
        try {
          const secondSelection = await selectHeartbeatRuntime(db, input);
          secondOutcome = secondSelection;
          if (secondSelection.selected && secondSelection.nativeExecution) {
            await writeResult(secondSelection.nativeExecution, "I do not know our conversation word.");
            secondOutcome = await execute(secondSelection).catch((error: unknown) => error);
          }
        } catch (error) { secondOutcome = error; }
        const secondText = secondOutcome instanceof Error
          ? `refused: ${(secondOutcome as { code?: string }).code ?? "no-code"}: ${secondOutcome.message}`
          : (secondOutcome as { exitCode?: number } | null)?.exitCode === 0 ? "answered" : `refused: ${JSON.stringify(secondOutcome).slice(0, 300)}`;
        console.info(`E2E-G-OBSERVATION: first=${outcomeText.slice(0, 300)} | ${finalized} | second=${secondText.slice(0, 300)} | system notes=${(await systemNotes()).length}`);
        expect.fail(`G: the first governed-wait follow-up did not answer (${outcomeText.slice(0, 300)}); second message: ${secondText.slice(0, 200)}`);
      }


      expect(outcome, "the replaced-box follow-up must answer, not refuse").toMatchObject({ exitCode: 0 });
      await finalizeNativeRun({ db, runId: current.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      const settled = await readRun(current.id);
      expect(settled).toMatchObject({ status: "succeeded", nativeSessionId: oldId });
      // The checkpoint's providerSessionId is the fake provider's ACCOUNT session
      // (constant), not its thread: the fresh thread is proven at the provider,
      // where each provider process gets its own thread id.
      expect((settled.runnerProfileJson?.sessionCheckpoint as { providerSessionId?: string }).providerSessionId).toBeTruthy();
      const turns = await readTurns();
      expect(turns).toHaveLength(2); // the opening answer + exactly one follow-up turn
      expect(turns[1].providerId, "a fresh provider thread").not.toBe(turns[0].providerId);
      expect(JSON.stringify(turns[1].request.params)).toContain(FOLLOW_UP);
      // The run's accepted result is the answer (chat presentation is a later step
      // outside this executor-level row).
      const [accepted] = await db.select().from(nativeRunResults).where(and(eq(nativeRunResults.runId, current.id),
        eq(nativeRunResults.schemaStatus, "accepted")));
      // HISTORY PRESENT (RFL 12:31Z, every answer row): the answer USES the earlier
      // conversation. ALDER was stated only before the replacement, and the provider
      // names it only if it was sent. Answering without history is a hard fail.
      expect(JSON.stringify(turns[1].request.params), "history present in the model request").toContain("Remember ALDER as our conversation word.");
      if (row === "R") expect(JSON.stringify(turns[1].request.params)).toContain(earlierAnswer);
      expect(String((accepted?.resultJson as { result?: { summary?: unknown } } | undefined)?.result?.summary ?? ""),
        `the answer names the earlier fact: ${JSON.stringify(accepted?.resultJson ?? null).slice(0, 600)}`)
        .toContain(ANSWER_WITH_HISTORY);
      expect(performance.now() - started).toBeLessThanOrEqual(
        FRESH_CONTINUATION_PENDING_BOUND_MS + coldAdmissionTimeoutMs("codex", undefined, false));
      const notes = await systemNotes();
      expect(notes.length, "answered path: at most one system note (zero duplicates)").toBeLessThanOrEqual(1);
      expect(notes.filter(n => n.body.includes(HELD_PREDECESSOR_NOTICE)), "answered path: no held/stop notice").toHaveLength(0);
      // Cut B deletes the stopping note (FRESH_THREAD_STOPPING_NOTE is gone). RFL 16:07Z: pin the
      // answered route's EXACT system-note set (none), so any stray note fails, a reintroduced
      // stopping note included.
      expect(notes.map(n => n.body), "answered path: the route's exact system-note set").toEqual([]);
      expect(notes.filter(n => n.body.includes(FRESH_THREAD_STARTED_NOTE)),
        "answered path: our fresh-thread gate is not entered (no FRESH_THREAD_STARTED note)").toHaveLength(0);
      const persisted = await persistedJson(current.id);
      expect(persisted, "no recoveryRefusalCode on the answered run").not.toContain("recoveryRefusalCode");
      expect(persisted, "no structured runner_remote_state_unavailable code").not.toMatch(/"(?:code|errorCode|prepareRefusalCode)":"runner_remote_state_unavailable"/);
      expect(await db.select().from(nativeRunResults).where(and(eq(nativeRunResults.runId, current.id),
        eq(nativeRunResults.schemaStatus, "accepted")))).toHaveLength(1);
      expect((await readRun(successful.id)).runnerProfileJson).toEqual(sourceEvidence);
      const leaseCalls = providerCall.mock.calls.map(call => call[1]);
      expect(leaseCalls.filter(m => m === "environmentAcquireLease")).toHaveLength(2);
      expect(leaseCalls, "never destroy a box").not.toContain("environmentDestroyLease");
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' is not null`))).toHaveLength(0);
    } finally {
      await closeIdleWarmNativeSessionsForRestart();
      // The runner materializes instruction files read-only; let the fixture's own
      // cleanup of its temporary root remove the box disks this test created.
      for (const entry of await readdir(runtimeRoot, { recursive: true, withFileTypes: true })) {
        if (!entry.isSymbolicLink()) await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
      }
    }
  }, 180_000);
});
