// Keep: effective-config/lease-marker trust boundary. No Boat or provider traffic.
import { expect, it, vi } from "vitest";
import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
const { config } = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("../../../../../server/src/services/environment-config.js", () => ({ resolveEnvironmentDriverConfigForRuntime: config }));
vi.mock("../../../../../server/src/instrumentation.js", () => ({ getStartupTracer: () => ({ startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }) }) }));
vi.mock("@paperclipai/db", () => ({ environmentLeases: {} }));
import { resolveEnvironmentExecutionTarget } from "../../../../../server/src/services/environment-execution-target.js";
import { createSandboxRunnerRetention, createSandboxRunnerSupervision } from "../../../../../server/src/services/native-runtime/sandbox-runner-retention.js";
import { BoatDuplexChannels } from "./duplex.js";

// Execute the exact production S9 admission condition, rather than a hand-copied
// approximation. The whole native executor needs Runner/DB binaries that this
// bounded plugin task does not build. Target mapping and S9 owner below are real
// imported modules; only config storage, capability RPC and transport are fixtures.
const executorPath = new URL("../../../../../server/src/services/native-runtime/native-session-executor.ts", import.meta.url);
const executor = readFileSync(executorPath, "utf8");
const ast = ts.createSourceFile(executorPath.pathname, executor, ts.ScriptTarget.Latest, true);
let condition: string | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "sandboxOwnerInput" && node.initializer && ts.isConditionalExpression(node.initializer)) {
    if (condition) throw Error("ambiguous S9 gate");
    condition = node.initializer.condition.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!condition) throw Error("production S9 gate not found");
const admits = new Function("remoteTarget", "sandboxLeaseAcquisition", "remoteCommandRunner", "input", `return Boolean(${condition});`);
// Execute the actual host projection. It drops Environment/config before the
// plugin RPC, rather than assuming a fixture-only config field reaches Boat.
const runtimeSource = readFileSync(new URL("../../../../../server/src/services/environment-runtime.ts", import.meta.url), "utf8");
const runtimeAst = ts.createSourceFile("environment-runtime.ts", runtimeSource, ts.ScriptTarget.Latest, true);
let projection: string | undefined;
function findProjection(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(runtimeAst) === "managerInput" && node.initializer) {
    if (projection) throw Error("ambiguous manager projection");
    projection = node.initializer.getText(runtimeAst);
  }
  ts.forEachChild(node, findProjection);
}
findProjection(runtimeAst);
if (!projection) throw Error("production duplex projection not found");
const managerInput = new Function("input", "providerKey", "providerLeaseId", `return (${projection});`);
const capabilities = { reusableLeases: true, duplexCommandStream: true, runnerWebSocketIngress: true,
  nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false, independentControlCommands: false,
  incrementalSessionOutput: false, concurrentSyncOperations: false };

async function exercise(marker: boolean, effectiveCarrier: "ssh" | "off", offAfterQualification = false) {
  const scope = { driverKey: "plugin:paperclip.boat-sandbox-provider:boat", companyId: "company", environmentId: "environment", providerLeaseId: "allocation" };
  let prepareCount = 0, connectCount = 0, qualificationFrames = 0, opensAtOffEdit = 0;
  const operations: string[] = [];
  let receive: (bytes: Uint8Array) => void = () => {};
  let ended: () => void = () => {};
  const channels = new BoatDuplexChannels({
    prepare: async () => { prepareCount++; return {} as never; },
    connect: async (_endpoint, _command, callbacks) => {
      connectCount++;
      return { close: async () => {}, write: async bytes => {
        const frame = JSON.parse(Buffer.from(bytes).toString("utf8"));
        operations.push(frame.op);
        expect(["qualify", "observe", "park"]).toContain(frame.op);
        if (frame.op === "qualify") qualificationFrames++;
        callbacks.data(Buffer.from(JSON.stringify({ ...frame, status: { qualify: "qualified", observe: "observed", park: "parked" }[frame.op as string],
          guardianVersion: 1, privateHostControlVersion: 1, lastControllerCommandSeq: 0, ackedSourceSeq: 0 }) + "\n"));
      }};
    },
    notify: { data: (_route, _session, bytes) => receive(bytes), exit: () => ended() },
    activity: async (_lease, run) => run(),
  });
  // This is the already-acquired SSH scope. No SDK event arrives on env save.
  channels.bind({ ...scope, config: { apiKey: "fixture-only", duplexCarrier: "ssh" }, guardianPreflight: { usable: true } });
  const environment = { id: scope.environmentId, driver: "sandbox", config: { provider: scope.driverKey, reuseLease: true, duplexCarrier: effectiveCarrier } };
  const lease = { id: "lease", companyId: scope.companyId, environmentId: scope.environmentId, heartbeatRunId: "run", issueId: "issue",
    executionWorkspaceId: "workspace", provider: scope.driverKey, providerLeaseId: scope.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
    metadata: { agentId: "agent", sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: scope.providerLeaseId }, ...(marker ? { runnerGuardianVersion: 1 } : {}) } };
  let savedEnvironment = environment;
  config.mockResolvedValue(savedEnvironment);
  const hookFields: string[][] = [];
  const open = vi.fn(async (input: { command: string[]; environment: unknown; lease: unknown }) => {
    const params = managerInput(input, scope.driverKey, scope.providerLeaseId);
    hookFields.push(Object.keys(params).sort());
    const pair = await channels.open({ ...params, hostRouteId: `boundary-route-${prepareCount}` });
    return {
      onData: (fn: typeof receive) => { receive = fn; }, onExit: (fn: typeof ended) => { ended = fn; },
      write: (bytes: Uint8Array) => { void channels.write({ ...pair, data: Buffer.from(bytes).toString("base64") }); },
      close: () => channels.close(pair),
    };
  });
  const runtime = { supportsSync: () => false, resolveCapabilities: async () => capabilities, openDuplexChannel: open,
    readSandboxDuplexBridgeInput: async () => ({ enableDuplexBridge: false }),
    getDriver: () => ({ releaseRunLease: vi.fn(async () => ({ ...lease, status: "released", cleanupStatus: "success" })) }), resumeRunLease: vi.fn() };
  const target = await resolveEnvironmentExecutionTarget({ db: {} as never, companyId: scope.companyId, adapterType: "paperclip_runner",
    environment, leaseId: lease.id, lease: lease as never, leaseMetadata: lease.metadata, environmentRuntime: runtime as never });
  if (target?.kind !== "remote" || target.transport !== "sandbox") throw Error("sandbox target required");
  const admitted = admits(target, target.sandboxLeaseAcquisition, target.runner, { execution: { provider: { kind: "codex" } } });
  let qualified = false;
  try {
    if (admitted) {
      const owner = createSandboxRunnerRetention({ binding: { companyId: scope.companyId, environmentId: scope.environmentId, providerKey: scope.driverKey,
        providerLeaseId: scope.providerLeaseId, scopeDigest: "fixture", accountIdentity: "fixture", credentialIdentity: "fixture" },
        lifecycle: target.runnerLeaseLifecycle!, openDuplexChannel: target.runner!.openDuplexChannel!.bind(target.runner),
        runnerInstanceId: "runner", supervision: createSandboxRunnerSupervision() });
      try { await owner.qualify({ runnerBinary: "/trusted/runnerd", runnerDigest: "fixture-digest" }); }
      catch (error) {
        if ((error as { code?: string }).code !== "BOAT_SSH_CARRIER_OFF") throw error;
      }
      qualified = owner.driver !== undefined;
      if (offAfterQualification) {
        opensAtOffEdit = open.mock.calls.length;
        // A normal in-flight run can finish after the operator saves off. There
        // is no acquire/resume or SDK config event before its S9 release path.
        // A DB save replaces the saved row, not the run's captured object.
        savedEnvironment = { ...environment, config: { ...environment.config, duplexCarrier: "off" } };
        config.mockResolvedValue(savedEnvironment);
        await owner.driver!.release({ runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
          normalizedSessionId: "session", turnId: "turn", itemId: "item" } as never);
      }
      if (effectiveCarrier === "off") {
        await owner.driver!.release({ runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
          normalizedSessionId: "session", turnId: "turn", itemId: "item" } as never);
      }
      owner.detach();
    }
    const result = { marker, effectiveCarrier, genericBridgeEnabled: target.enableSandboxDuplexBridge, admitted, qualified,
      runtimeOpens: open.mock.calls.length, prepareCount, connectCount, qualificationFrames, operations,
      offAfterQualification, opensAtOffEdit, opensAfterOffEdit: offAfterQualification ? open.mock.calls.length - opensAtOffEdit : undefined,
      finalEffectiveCarrier: savedEnvironment.config.duplexCarrier, runStartCarrier: environment.config.duplexCarrier, hookFields };
    if (process.env.OFF_BOUNDARY_OBS) appendFileSync(process.env.OFF_BOUNDARY_OBS, JSON.stringify({ ...result,
      executorSha256: createHash("sha256").update(executor).digest("hex"), productionAdmissionCondition: condition }) + "\n");
    return result;
  } finally { await channels.shutdown(); }
}

it("control: SSH with current marker admits a real S9 qualification", async () => {
  expect(await exercise(true, "ssh")).toMatchObject({ admitted: true, qualified: true, runtimeOpens: 1, prepareCount: 1, connectCount: 1, qualificationFrames: 1 });
});
it("control: absent marker withholds S9 even with static capabilities", async () => {
  expect(await exercise(false, "off")).toMatchObject({ admitted: false, qualified: false, runtimeOpens: 0, prepareCount: 0 });
});
it("Core-limited boundary: stale-marker opens remain possible until acquire/resume, not limited to one", async () => {
  const result = await exercise(true, "off");
  // Core omits environment config from the duplex hook. Repeated opens are
  // possible before the next scoped acquire/resume removes the marker.
  // The real SDK/key-retirement continuations are in sshfix.test.ts.
  expect(result).toMatchObject({ admitted: true, qualified: true, runtimeOpens: 3, prepareCount: 3, connectCount: 3, qualificationFrames: 1 });
  expect(result.operations).toEqual(["qualify", "observe", "park"]);
  expect(result.hookFields).toHaveLength(3);
  for (const fields of result.hookFields) expect(fields).not.toContain("config");
});
it("accepted boundary: an SSH-on in-flight owner may observe and park after an off save",  async () => {
  const result = await exercise(true, "ssh", true);
  expect(result.finalEffectiveCarrier).toBe("off");
  expect(result.opensAtOffEdit).toBe(1);
  expect(result.runStartCarrier).toBe("ssh");
  expect(result.opensAfterOffEdit).toBe(2);
  expect(result.operations).toEqual(["qualify", "observe", "park"]);
});
