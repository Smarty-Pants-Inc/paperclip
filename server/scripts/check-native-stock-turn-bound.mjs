// Source-mode, real runtime -> CodexHarnessSession -> runnerd transport ->
// durable journal boundary. Only provider startup/I/O is stopped. No alternate
// payload builder or mocked session.startTurn can hide stock skill additions.
// Usage: server/node_modules/.bin/tsx server/scripts/check-native-stock-turn-bound.mjs ROOT OUT
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [root, output, v4BudgetPath] = process.argv.slice(2);
const v4Budget = v4BudgetPath ? await import(pathToFileURL(resolve(v4BudgetPath)).href) : null;
assert(root && output, "ROOT and OUT are required");
const load = path => import(pathToFileURL(join(root, path)).href);
const { DurablePrpControlPlane } = await load("packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts");
const { createCapabilityRunnerdCodexTransport, resolveRunnerdCodexSkillInputs } = await load("packages/paperclip-runner/src/live/runnerd-codex-transport.ts");
const { CodexHarnessSession } = await load("packages/paperclip-runner/src/drivers/codex/codex-harness-session.ts");
const { executeNativeSession } = await load("packages/paperclip-runner/src/native-session-runtime.ts");
const { nativeTaskConstraints } = await load("packages/paperclip-runner/src/backends/runtime-context.ts");
const { canonicalNativeRuntimeContextDigest, buildNativeModelEnvelope } = await load("packages/paperclip-runner/src/index.ts");
const { nativeRuntimeContextFixture } = await load("server/src/services/native-runtime/runtime-context.test-fixture.ts");
const { buildNativeExecutionInput } = await load("server/src/services/native-runtime/native-execution-input.ts");
const { renderNativeRunnerStagedAttachmentPrompt } = await load("server/src/services/native-runtime/native-runner-file-handoff.ts");
const { renderFirstTurnQueuedInput } = await load("server/src/services/native-runtime/first-turn-queued-input.ts");
const { commandTextBytes, commandEnvelopeBytes, nativeQueuedTurnUpperBound, assertNativeQueuedTurnBound, assertNativeTurnCommandBound } = await load("server/src/services/native-runtime/native-turn-budget.ts");
mkdirSync(output, { recursive: true, mode: 0o700 });
const rows = [];
const cases = [
  ["codex", 0, "control"], ["codex", 3, "skills-3"], ["codex", 8, "skills-8"], ["codex", 64, "skills-64"],
  ["pi_rpc", 64, "pi-skills-64"], ["opencode", 0, "opencode"], ["acpx", 0, "acpx"],
  ["codex", 64, "fresh-cwd-effort-timing"], ["codex", 64, "admitted-64"], ["pi_rpc", 64, "admitted-pi-64"],
  ["codex", 3, "challenger-3"], ["codex", 64, "challenger-64"],
  ["opencode", 0, "opencode-reasoning"], ["acpx", 0, "acpx-provider-started"],
  ["codex", 64, "admitted-prepared-64"], ["codex", 64, "admitted-preconfigured-64"],
  ["codex", 64, "admitted-cached-skills-64"],
];
for (const [provider, skillCount, fixture] of cases) {
  const directory = mkdtempSync(join(tmpdir(), "stock-turn-bound-"));
  const challenger = fixture.startsWith("challenger-");
  const context = nativeRuntimeContextFixture();
  context.skills = Array.from({ length: skillCount }, (_, i) => ({ key: `skill-${i}`, runtimeName: `skill_${challenger && i === 63 ? "063" : i}`, versionId: null,
    bundle: { ...context.instructions.bundle, rootPath: `/assigned/skill_${i}` } }));
  context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
  const skillInputs = provider === "codex" ? context.skills.map(skill => ({ type: "skill", name: skill.runtimeName, path: resolve(skill.bundle.rootPath, "SKILL.md") })) : [];
  // 288 B Codex home: the designer's ordinary-path counterexample, with each
  // component below NAME_MAX. It is provider-visible, never created locally.
  const filesystemRoot = challenger ? "/" + "h".repeat(31) : "/" + "h".repeat(138) + "/" + "h".repeat(137);
  const codexHome = resolve(filesystemRoot, "codex-home");
  assert.equal(Buffer.byteLength(codexHome), challenger ? 43 : 288);
  const preparedContext = fixture === "admitted-prepared-64" ? { ...context, skills: context.skills.map(skill => ({ ...skill,
    bundle: { ...skill.bundle, rootPath: `/prepared/${"p".repeat(180)}/${"p".repeat(150)}/${skill.runtimeName}` } })) } : undefined;
  const mappedSkills = resolveRunnerdCodexSkillInputs(skillInputs, context, codexHome, preparedContext);
  const cwd = challenger ? "/cwd" : "/workspace/" + "w".repeat(13);
  const input = buildNativeExecutionInput({ companyId: "company", runId: "run", agentId: "agent", provider, acpxAgent: "claude", model: provider === "opencode" ? "openai/gpt-5.5" : provider === "acpx" ? "claude-sonnet-5" : "gpt-5.6-sol", normalizedSessionId: "session",
    issue: { id: "task", identifier: "BOUND-1", title: "Keep the request", description: fixture === "admitted-cached-skills-64" ? null : context.skills.map(skill => `/${skill.runtimeName}`).join(" ") || null, workMode: "standard" },
    taskPrompt: "Whole task input.", workspace: { id: "workspace", cwd: challenger ? "/" + "o".repeat(43) : fixture === "fresh-cwd-effort-timing" ? "/old" : cwd, repoUrl: null, repoRef: null, branchName: null },
    runtimeContext: context, ...(fixture === "fresh-cwd-effort-timing" ? { codexReasoningEffort: "xhigh" } : {}),
    completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Keep the request", criteria: [{ id: "output", requirement: "Keep the whole request" }] } },
  });
  const constraints = nativeTaskConstraints(input);
  const attachmentPrompt = renderNativeRunnerStagedAttachmentPrompt(Array.from({ length: 128 }, (_, i) => ({
    id: i === 127 ? `attachment-${i}`.slice(4) : `attachment-${i}`,
    filename: i === 127 ? '"'.repeat(104) + "x".repeat(76) + ".txt" : '"'.repeat(180) + ".txt", contentType: "text/plain", byteSize: 123456789,
    workspaceRelativePath: `.paperclip-inbound/${i}/original`, unavailableReason: null,
  })));
  let queuedBody = "Whole queued person input. $& $' $` $$ END";
  let queued = renderFirstTurnQueuedInput([{ id: "person", createdAt: new Date("2026-01-01Z"), body: queuedBody }]);
  queuedBody += "q".repeat(288 - commandTextBytes(queued));
  queued = renderFirstTurnQueuedInput([{ id: "person", createdAt: new Date("2026-01-01Z"), body: queuedBody }]);
  assert.equal(commandTextBytes(queued), 288);
  const selected = () => buildNativeModelEnvelope(input);
  input.task.prompt = "END OF WHOLE TASK";
  const knownTarget = challenger ? 282255 : 282235;
  input.task.prompt = "k".repeat(knownTarget - commandEnvelopeBytes(selected())) + input.task.prompt;
  const additions = { attachmentPrompt, constraints, workingDirectory: cwd, skillInvocation: provider === "codex", skillInputs: mappedSkills,
    ...(fixture === "fresh-cwd-effort-timing" ? { effort: input.provider.reasoningEffort } : {}) };
  if (fixture.startsWith("admitted-")) {
    const over = nativeQueuedTurnUpperBound("run", selected(), queued, additions) - 500000;
    input.task.prompt = input.task.prompt.slice(over);
  }
  const bound = nativeQueuedTurnUpperBound("run", selected(), queued, additions);
  let admitted = true;
  try { assertNativeQueuedTurnBound("run", selected(), queued, additions); } catch { admitted = false; }
  let captured, core, journalAdmitted = false;
  const originalQueue = DurablePrpControlPlane.prototype.queueCommand;
  const storeDescriptor = Object.getOwnPropertyDescriptor(DurablePrpControlPlane.prototype, "store");
  Object.defineProperty(DurablePrpControlPlane.prototype, "store", { ...storeDescriptor, get() { core = this; return storeDescriptor.get.call(this); } });
  DurablePrpControlPlane.prototype.queueCommand = function(type, ...args) {
    core = this;
    if (type !== "turn.start") return originalQueue.call(this, type, ...args);
    // Observe the REAL serializer's own byte check, without changing its
    // limit or return value. The designer's 64-skill command exceeds even the
    // journal cap, so that exact attempted command cannot truthfully be stored.
    const byteLength = Buffer.byteLength;
    Buffer.byteLength = function(value, ...encoding) {
      if (typeof value === "string" && value.startsWith('{"schema":"paperclip.prp.command.v1"') && value.includes('"type":"turn.start"')) captured = value;
      return byteLength.call(Buffer, value, ...encoding);
    };
    try { originalQueue.call(this, type, ...args); journalAdmitted = true; }
    catch (error) { if (!captured || error.code !== "command_payload_too_large") throw error; }
    finally { Buffer.byteLength = byteLength; }
    throw new Error("captured-stock-command");
  };
  const bundle = createCapabilityRunnerdCodexTransport({ provider, ...(provider === "acpx" ? { acpxAgent: "claude" } : {}),
    stateDirectory: directory, runnerFilesystemRoot: filesystemRoot, runtimeContext: context,
    ...(fixture === "admitted-preconfigured-64" ? { homeMode: "preconfigured", environment: { HOME: "/", CODEX_HOME: codexHome } } : {}),
    runnerArtifact: { version: "0.3.0", digest: `sha256:${"a".repeat(64)}` },
    runnerProcessLauncher() { throw new Error("must-not-launch"); }, controlPlaneRegistration() { throw new Error("must-not-register"); },
    async prepareLaunch() { throw new Error("stop-before-provider-io"); }, closeGraceMs: 50,
    ...(fixture === "fresh-cwd-effort-timing" ? { recordTimingReceipt() {} } : {}),
    ...(fixture === "acpx-provider-started" ? { providerStartedTurns: true } : {}),
  });
  try {
    // Establish the REAL transport's durable authority, but deliberately stop
    // at its existing launch-preparer seam before any provider process/I/O.
    await assert.rejects(bundle.transport.request("thread/start", { cwd, dynamicTools: [] }), /stop-before-provider-io/);
    if (fixture === "opencode-reasoning") core.store.state.runAttachTemplate = { provider: { model: "openrouter/openai/gpt-5.5" } };
    if (preparedContext) core.store.state.runAttachTemplate = { provider: { runtimeContext: preparedContext } };
    const session = new CodexHarnessSession({ transport: bundle.transport, runId: "run", normalizedSessionId: "session",
      opened: { threadId: "thread", providerSessionId: "provider", collaborationMode: null,
        lineage: { threadId: "thread", parentThreadId: null, rootThreadId: "thread" },
        context: { model: "fixture", modelProvider: provider, codexVersion: "fixture", workingDirectory: cwd, collaborationMode: "default", sandbox: {} } },
      taskEnvelope: { schema: "paperclip.codex-task.v1", objective: "Keep the request" }, conversationMode: "prepared", resumed: false,
      sourceSequence: 0, now: () => new Date(), runnerInstanceId: "runner", driverKind: provider === "codex" ? "codex_app_server" : provider,
      capabilities: { goals: false, steering: false }, goalCapability: {}, goalAvailability: "unavailable", goalReasonCode: null, goalReason: null,
      dynamicTools: [], skillInputs, ...(fixture === "fresh-cwd-effort-timing" ? { reasoningEffort: input.provider.reasoningEffort } : {}),
    });
    const identity = { ...input.binding, sessionId: "session" };
    const checkpoint = { backendKind: "mock", sessionId: "driver", identity, providerSessionId: "provider", cursor: "0", activeTurnId: null,
      pendingRuntimeRequests: [], lineage: [], workingDirectory: cwd };
    const port = { identity: () => identity, async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
      async *events() {}, async result() { return null; }, async snapshot() { return checkpoint; }, async close() {},
      startTurn: turn => session.startTurn({ ...turn, ...(fixture === "opencode-reasoning" ? { reasoningMode: "disabled" } : {}) }),
    };
    await assert.rejects(executeNativeSession({ input, backend: { preparedTaskConstraints: constraints,
      async descriptor() { return { kind: "mock", name: "stock-boundary", version: "1", capabilities: await port.capabilities(), runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
      async openSession() { return port; } },
      controlPlane: { async openRun() {}, async checkpointSession() {}, async completeRun() {},
        async appendEvent(event) { return { cursor: event.sourceSeq, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
        async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } },
      prepareWakeAttachmentPrompt: async () => attachmentPrompt, getFirstTurnQueuedInput: async () => queued,
      runnerInstanceId: "runner", controlPlaneInstanceId: "controller",
    }), /captured-stock-command/);
    assert(captured, "real transport must serialize turn.start");
    if (journalAdmitted) assert(readFileSync(core.store.path, "utf8").includes(captured), "exact command occurs in durable journal");
    else assert.equal(core.store.state.commands.length, 0, "oversized attempted command is NOT journaled");
    const actual = Buffer.byteLength(captured);
    const command = JSON.parse(captured);
    const finalGuardAdmits = budget => {
      try { budget("turn.start", command.payload, command.commandId); return true; } catch { return false; }
    };
    const finalGuardAdmitted = finalGuardAdmits(assertNativeTurnCommandBound);
    const row = { fixture, provider, skillCount, knownBytes: commandEnvelopeBytes(selected()), attachmentBytes: commandTextBytes(attachmentPrompt), queuedBytes: commandTextBytes(queued),
      bound, actual, margin: bound - actual, admitted, finalGuardAdmitted, journalAdmitted,
      ...(v4Budget ? { v4Bound: v4Budget.nativeQueuedTurnUpperBound("run", selected(), queued, additions),
        v4Margin: v4Budget.nativeQueuedTurnUpperBound("run", selected(), queued, additions) - actual,
        v4FinalGuardAdmitted: finalGuardAdmits(v4Budget.assertNativeTurnCommandBound) } : {}) };
    rows.push(row);
    writeFileSync(join(output, `${fixture}.command.json`), captured);
    writeFileSync(join(output, `${fixture}.fixture.json`), JSON.stringify({ input, additions, queued,
      providerSetup: { filesystemRoot, codexHome, cwd, preparedContext,
        preconfigured: fixture === "admitted-preconfigured-64", performance: fixture === "fresh-cwd-effort-timing",
        providerStartedTurns: fixture === "acpx-provider-started", reasoningMode: fixture === "opencode-reasoning" ? "disabled" : undefined } }, null, 2));
    assert(!admitted || finalGuardAdmitted, `${fixture}: admitted bound ${bound}, actual ${actual}; pre-seal stock admission must pass the final guard`);
  } finally {
    DurablePrpControlPlane.prototype.queueCommand = originalQueue;
    Object.defineProperty(DurablePrpControlPlane.prototype, "store", storeDescriptor);
    await bundle.transport.close();
    await core?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}
writeFileSync(join(output, "result.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
assert(rows.every(row => row.bound >= row.actual), "pre-seal bound must dominate EVERY actual stock command");
assert(rows.filter(row => row.fixture.startsWith("admitted-")).every(row => row.admitted && row.actual <= 500000), "near-cap 64-skill commands must really fit when admitted");
