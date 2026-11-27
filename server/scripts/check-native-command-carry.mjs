// Cross-tree, full-journal-command carry gate. Run with the checkout's tsx:
// server/node_modules/.bin/tsx server/scripts/check-native-command-carry.mjs BASE_ROOT PATCHED_ROOT OUT
// BASE_ROOT must be a clean c707f102 tree with its own workspace dependency links.
// This exercises real builders/runtime composition/journal admission, not a provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const baseSha = "c707f102d4e93684b9354976dedbe4555f8528d5";
const load = (root, path) => import(pathToFileURL(join(root, path)).href);
const hash = value => createHash("sha256").update(value).digest("hex");
const modes = ["retained-turn-start", "fresh-bootstrap", "failed-resume-bootstrap"];

if (process.argv[2] === "--child") {
  const [, , , root, label, mode, fixtureFile, out] = process.argv;
  const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
  const { buildNativeExecutionInput, budgetNativeFreshFallback } = await load(root, "server/src/services/native-runtime/native-execution-input.ts");
  const { renderFirstTurnQueuedInput } = await load(root, "server/src/services/native-runtime/first-turn-queued-input.ts");
  const { renderNativeSessionHandoff } = await load(root, "server/src/services/native-runtime/native-session-handoff.ts");
  const { executeNativeSession } = await load(root, "packages/paperclip-runner/src/native-session-runtime.ts");
  const { nativeTaskConstraints } = await load(root, "packages/paperclip-runner/src/backends/runtime-context.ts");
  const { buildNativeModelEnvelope } = await load(root, "packages/paperclip-runner/src/index.ts");
  const { DurablePrpControlPlane } = await load(root, "packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts");
  const budget = label === "patched" ? await load(root, "server/src/services/native-runtime/native-turn-budget.ts") : null;
  const resumed = mode !== "fresh-bootstrap";
  const input = buildNativeExecutionInput({ ...fixture.input, resumedSession: resumed,
    ...(resumed ? { previousTurn: { runId: "previous-run", task: fixture.input.issue } } : {}) });
  const identity = { runId: input.binding.runId, companyId: input.binding.companyId,
    issueId: input.binding.issueId, agentId: input.binding.agentId, sessionId: input.session.normalizedSessionId };
  const checkpoint = { backendKind: "carry", sessionId: "driver-carry", identity,
    providerSessionId: "provider-carry", providerRecoveryPolicy: "allow_replacement_after_resume_failure",
    cursor: "0", activeTurnId: null, pendingRuntimeRequests: [], lineage: [] };
  const directory = mkdtempSync(join(tmpdir(), `native-command-carry-${label}-`));
  const core = new DurablePrpControlPlane({ stateDirectory: directory,
    identity: { runnerInstanceId: "runner-carry", environmentLeaseId: "lease-carry", runId: identity.runId,
      normalizedSessionId: identity.sessionId, turnId: "turn-carry", itemId: identity.issueId },
    expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
  budget?.guardNativeTurnCommands(core);
  let captured = null, preSealBound = null, handoff = "";
  const originalPrompt = input.task.prompt;
  const staleEnvelope = buildNativeModelEnvelope(input);
  const constraints = nativeTaskConstraints(input);
  const session = { identity: () => identity,
    async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
    async *events() {}, async result() { return null; }, async snapshot() { return checkpoint; }, async close() {},
    async startTurn(turn) {
      // Fixed INPUT clock and command identity, not output normalization.
      const Clock = globalThis.Date;
      globalThis.Date = class extends Clock { constructor(...args) { super(...(args.length ? args : ["2026-01-04T00:00:00.000Z"])); } };
      try {
        // Standard non-compaction, no-skill/no-reasoning turn.start payload,
        // as dispatched by live/runnerd-codex-transport.ts. Random IDs and clock
        // are fixed fixture inputs; serialize the WHOLE stock journal command.
        captured = JSON.stringify(core.queueCommand("turn.start", {
          text: turn.message.text, turnId: "turn-carry",
        }, "command-carry"));
      } finally { globalThis.Date = Clock; }
      throw new Error("carry-captured-command");
    } };
  const queued = renderFirstTurnQueuedInput(fixture.queued.map(message => ({ ...message, createdAt: new Date(message.createdAt) })));
  try {
    await assert.rejects(executeNativeSession({ input, persistedSession: resumed ? checkpoint : undefined,
      backend: { preparedTaskConstraints: constraints,
        async descriptor() { return { kind: "carry", name: "carry", version: "1", capabilities: await session.capabilities(),
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
        async openSession() { return session; }, async openReplacementSession() { return session; },
        async recoverSession() { return mode === "failed-resume-bootstrap" ? { recovered: false, reason: "fixture provider history missing" }
          : { recovered: true, session }; } },
      controlPlane: { async openRun() {}, async checkpointSession() {}, async completeRun() {},
        async appendEvent(event) { return { cursor: event.sourceSeq, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
        async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } },
      getFreshSessionHandoff: async () => (handoff = renderNativeSessionHandoff(fixture.handoff)),
      prepareWakeAttachmentPrompt: async () => fixture.attachments,
      getFirstTurnQueuedInput: async () => {
        if (budget) {
          const freshEnvelope = buildNativeModelEnvelope(input);
          const selected = resumed ? buildNativeModelEnvelope(input, { resumedSession: true }) : freshEnvelope;
          const additions = { freshEnvelope, handoff, attachmentPrompt: fixture.attachments, constraints, workingDirectory: input.workspace.cwd, skillInvocation: false };
          preSealBound = budget.nativeQueuedTurnUpperBound(identity.runId, selected, queued, additions);
          budget.assertNativeQueuedTurnBound(identity.runId, selected, queued, additions);
        }
        return queued;
      },
      onContinuityBreak: async () => {
        if (budgetNativeFreshFallback) {
          budgetNativeFreshFallback(input, fixture.input.wakePayload, fixture.input.continuationReadState);
          budget?.registerNativeFreshFallback(identity.runId, originalPrompt, input.task.prompt, staleEnvelope, buildNativeModelEnvelope(input));
        }
      },
      runnerInstanceId: "runner-carry", controlPlaneInstanceId: "controller-carry",
    }), /carry-captured-command/);
    assert(captured, "runtime must reach turn.start");
    const stored = readFileSync(core.store.path, "utf8");
    assert(stored.includes(captured), "the exact full command bytes must occur in the durable journal");
    assert.equal(JSON.stringify(JSON.parse(stored).commands[0]), captured);
    if (preSealBound !== null) assert(preSealBound >= Buffer.byteLength(captured), "server bound dominates full final command");
    const envelope = JSON.parse(JSON.parse(captured).payload.text);
    assert.equal(envelope.schema, mode === "retained-turn-start" ? "paperclip.native-continuation.v1" : "paperclip.native-model-envelope.v3");
    assert(JSON.parse(captured).payload.text.includes("END OF QUEUED PERSON INPUT"));
    assert(JSON.parse(captured).payload.text.includes("$& $' $` $$"), "literal person-authored dollar tokens survive");
    writeFileSync(join(out, `${label}-${mode}.command.json`), captured);
    writeFileSync(join(out, `${label}-${mode}.admission.json`), JSON.stringify({ preSealBound, actual: Buffer.byteLength(captured) }));
  } finally { budget?.clearNativeFreshFallback(identity.runId); await core.stop(); rmSync(directory, { recursive: true, force: true }); }
} else {
  const [, , base, patched, output] = process.argv;
  assert(base && patched && output, "usage: check-native-command-carry.mjs BASE_ROOT PATCHED_ROOT OUT");
  const out = resolve(output);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  assert.equal(execFileSync("git", ["-C", base, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseSha);
  assert.equal(execFileSync("git", ["-C", base, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "");
  const { nativeRuntimeContextFixture } = await load(base, "server/src/services/native-runtime/runtime-context.test-fixture.ts");
  const messages = ["Original words", "Already read words", 'New request: preserve "quotes", 日本語, 🦖, $& $\' $` $$, and all answers.'].map((body, i) => ({
    id: `comment-${i}`, body, authorType: "user", authorId: "board", createdByRunId: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deleted: false, sourceTrust: null }));
  const continuation = { version: 1, companyId: "company", issueId: "task", objective: "Preserve the request.",
    trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null }, originCommentIds: [messages[2].id], messages,
    resumeDelta: { baseRunId: "previous-run", messages: [messages[2]] }, humanResponses: [], interactionOutcomes: [], completedActions: [],
    completedWork: null, unresolvedInteractionIds: [], coverage: { kind: "full_task_history", throughCommentId: messages[2].id, summaryThroughCommentId: null } };
  const fixture = { input: { companyId: "company", runId: "run-carry", agentId: "agent", provider: "pi_rpc", normalizedSessionId: "session-carry",
    issue: { id: "task", identifier: "CARRY-1", title: "Preserve the request", description: "Same task description.", workMode: "standard" },
    taskPrompt: 'Task assignment: preserve "quotes", 日本語 and 🦖.\nSame task description.',
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    runtimeContext: nativeRuntimeContextFixture(), boundCommandBytes: true,
    wakePayload: { reason: "issue_commented", commentIds: [messages[2].id], executionContinuation: continuation },
    continuationReadState: { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: messages.map(message => message.id) },
    completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Preserve", criteria: [{ id: "output", requirement: "Preserve the whole input." }] } } },
    queued: [{ id: "queued-person", body: 'Whole person input: "quoted" 日本語 🦖 $& $\' $` $$. END OF QUEUED PERSON INPUT', createdAt: "2026-01-03T00:00:00Z" }],
    attachments: 'Attachments staged for this turn:\n{"filename":"résumé.txt","path":"/workspace/input.txt"}',
    handoff: { issueId: "task", generation: 1, mode: "whole", maxBytes: 30000, omittedEntriesAtLeast: 0,
      entries: [{ kind: "message", id: "history-1", body: "Earlier read direction, uncut." }] } };
  const fixtureFile = join(out, "fixture.json");
  writeFileSync(fixtureFile, JSON.stringify(fixture));
  const rows = [];
  for (const mode of modes) {
    for (const [label, root] of [["base", base], ["patched", patched]]) {
      const result = spawnSync(join(root, "server/node_modules/.bin/tsx"), [fileURLToPath(import.meta.url), "--child", root, label, mode, fixtureFile, out],
        { encoding: "utf8", maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, `${label}/${mode}: ${result.stderr}\n${result.stdout}`);
    }
    const before = readFileSync(join(out, `base-${mode}.command.json`));
    const after = readFileSync(join(out, `patched-${mode}.command.json`));
    const admission = JSON.parse(readFileSync(join(out, `patched-${mode}.admission.json`), "utf8"));
    rows.push({ mode, bytes: before.length, preSealBound: admission.preSealBound, baseSha256: hash(before), patchedSha256: hash(after), byteIdentical: before.equals(after) });
  }
  writeFileSync(join(out, "result.json"), JSON.stringify({ base: baseSha, fixtureSha256: hash(readFileSync(fixtureFile)), rows }, null, 2));
  console.log(JSON.stringify(rows, null, 2));
  assert(rows.every(row => row.byteIdentical), "FULL serialized final journal command bytes differ from c707f102");
}
