import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { composeNativeSystemInstructions, canonicalNativeRuntimeContextDigest } from "../contracts/runtime-context.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import { QUALIFIED_PI_RPC_PROFILE } from "../drivers/pi/generated-profile.js";
import { authorizedToolSetForProvider, createCapabilityRunnerdCodexTransport } from "../live/runnerd-codex-transport.js";
import { assignedRuntimeContext } from "../../test/support/runnerd-transport.js";
import { DurablePrpControlPlane, spawnRunner } from "./durable-prp-control-plane.js";
import type { PrpEvent } from "../protocol/replay-contract.js";

const binary = resolve(import.meta.dirname, "../../runner/target/debug/paperclip-runnerd");
const fake = resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server");
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type CommandResult = NonNullable<ReturnType<DurablePrpControlPlane["getCommand"]>>;
type Session = {
  core: DurablePrpControlPlane;
  events: PrpEvent[];
  stateDirectory: string;
  command(type: string, input?: Record<string, unknown>): Promise<CommandResult>;
  completed(type: string, input?: Record<string, unknown>): Promise<CommandResult>;
  close(): Promise<void>;
};

// Keep: TL07/TL08. Exercise the TypeScript -> authenticated PRP -> real Rust
// run.prepare boundary and actual provider subprocess turns, not a mocked
// prepare result. The scripted provider is NOT live-model or deployment proof.
it.each([
  ["codex", "open", null], ["codex", "done", null], ["pi_rpc", "open", null], ["pi_rpc", "done", null],
  ["codex", "open", "active_turn"], ["codex", "done", "descendant"],
  ["codex", "open", "goal"], ["codex", "done", "contract"],
] as const)("refreshes an edited skill on %s after an %s conversation (%s) through real run.prepare", async (provider, disposition, blocker) => {
  const root = await mkdtemp(join(tmpdir(), "skill-edit-prepare-"));
  const runnerDigest = sha(await readFile(binary));
  const skillRoot = join(root, "assigned-skill");
  const instructionRoot = join(root, "instructions");
  const resultFile = join(root, "result.json");
  const tracePath = join(root, "provider-trace.ndjson");
  await Promise.all([mkdir(skillRoot), mkdir(instructionRoot)]);
  await writeFile(join(instructionRoot, "AGENTS.md"), "Keep the existing conversation and saved work.");
  const skillPath = join(skillRoot, "SKILL.md");
  await writeFile(skillPath, "---\nname: assigned\ndescription: Original skill v1.\n---\nPreserve the original work.\n");
  const context = assignedRuntimeContext(skillRoot, instructionRoot);
  const tools = authorizedToolSetForProvider(provider, codexSemanticToolSpecs());
  const contract = { revision: "revision-1", criterionIds: ["criterion-1"] };
  const fakeArgs = ["--state-file", join(root, "fake-state.json"), "--durable-turn-ids",
    ...(disposition === "done" ? ["--terminal-result-file", resultFile] : [])];
  await writeFile(resultFile, JSON.stringify({
    schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Saved the requested work.",
    completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
      criteria: [{ criterionId: "criterion-1", status: "satisfied", evidenceRefs: ["provider:fixture:answer"] }], remainingWork: [] },
    evidence: [{ ref: "provider:fixture:answer" }], verification: [], attentionRequests: [], artifacts: [],
  }));
  const proxy = join(root, "proxy.sh");
  // The Pi launch profile qualifies the local facade executable/script. No
  // real account, credential loader or external provider is involved.
  await writeFile(proxy, `exec '${fake}' ${fakeArgs.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}\n`, { mode: 0o600 });
  const shell = await realpath("/bin/sh");
  const executable = await realpath("/bin/true");
  const piLaunchProfile = provider === "pi_rpc" ? {
    command: shell, commandSha256: sha(await readFile(shell)),
    proxyScript: proxy, proxyScriptSha256: sha(await readFile(proxy)),
    executable, executableSha256: sha(await readFile(executable)),
  } : undefined;
  const descriptor = {
    kind: provider, provider, driver: provider === "codex" ? "codex_app_server" : "pi_rpc",
    providerVersion: provider === "pi_rpc" ? QUALIFIED_PI_RPC_PROFILE.runtimeVersion : "fixture-1",
    ...(provider === "pi_rpc" ? { profile: QUALIFIED_PI_RPC_PROFILE } : {}),
    command: provider === "pi_rpc" ? shell : fake,
    args: provider === "pi_rpc" ? [proxy] : fakeArgs,
    cwd: root, model: provider === "pi_rpc" ? "fixture/model" : "gpt-test", instructions: composeNativeSystemInstructions(context, await readFile(join(instructionRoot, "AGENTS.md"), "utf8")),
    approvalPolicy: "never", ...(provider === "codex" ? { externallySandboxed: true } : {}), readOnly: false, includeSkillInstructions: true,
    ...(provider === "pi_rpc" ? { runtimeContext: context } : {}),
  };
  const payload = { provider: descriptor, authorizedTools: tools, completionContract: contract };
  const sessions: Session[] = [];

  async function start(runId: string, checkpoint?: string): Promise<Session> {
    const attemptDirectory = join(root, `${runId}-${sessions.length}`);
    const stateDirectory = join(attemptDirectory, "runner");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    // Restore the predecessor's actual serialized provider checkpoint, as the
    // cold follow-up path does after the previous per-turn daemon has stopped.
    if (checkpoint) await copyFile(checkpoint, join(stateDirectory, "codex-provider-state.json"));
    const identity = { runnerInstanceId: "skill-runner", environmentLeaseId: "skill-lease", runId,
      normalizedSessionId: "skill-conversation", turnId: `turn-${runId}`, itemId: `item-${runId}` };
    const events: PrpEvent[] = [];
    const core = new DurablePrpControlPlane({ stateDirectory: join(attemptDirectory, "control-plane"), identity,
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: runnerDigest,
      onCommittedEvent: async event => { events.push(event); },
      onSemanticToolInput: async input => {
        expect(input.operationId).toBe("paperclip_finish");
        expect(input.input).toMatchObject({ reportedWorkDisposition: "done", completionClaim: { objectiveSatisfied: true } });
        return { result: { ok: true, issue: { status: "done" } }, isError: false };
      } });
    await core.start();
    const process = spawnRunner({ connectUrl: core.connectUrl, stateDirectory, identity,
      ticket: core.issueBootstrapTicket(), runnerBinaryPath: binary, runnerVersion: "0.3.0", runnerDigest,
      maxOutboxBytes: 16 * 1024 * 1024, p0ReserveBytes: 1024 * 1024, maxRuntimeMs: 0,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null }, piLaunchProfile,
      environment: { PATH: globalThis.process.env.PATH, PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
        PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(4 * 1024 * 1024) } });
    let sequence = 0;
    async function command(type: string, input: Record<string, unknown> = {}) {
      const queued = core.queueCommand(type, input, `${runId}-${++sequence}`, true);
      await vi.waitFor(() => {
        const status = core.getCommand(queued.commandId)?.status;
        if (status !== "completed" && status !== "failed") expect(process.child.exitCode, `${type}: runner exited`).toBeNull();
        expect(["completed", "failed"]).toContain(status);
      }, { timeout: 10_000, interval: 10 });
      return core.getCommand(queued.commandId)!;
    }
    async function completed(type: string, input: Record<string, unknown> = {}) {
      const result = await command(type, input);
      expect(result, `${runId} ${type}: ${JSON.stringify(result.result)}`).toMatchObject({ status: "completed" });
      return result;
    }
    let closed = false;
    const session = { core, events, stateDirectory, command, completed, async close() {
      if (closed) return;
      try {
        await completed("runner.drain");
        await completed("runner.suspend");
        const result = await process.completion;
        expect(result).toMatchObject({ code: 0 });
      } finally {
        if (process.child.exitCode === null && process.child.signalCode === null) {
          process.child.kill("SIGTERM");
          await process.completion;
        }
        await core.stop();
        closed = true;
      }
    } };
    sessions.push(session);
    return session;
  }

  async function turn(session: Session, text: string) {
    const previousTerminals = session.events.filter(event => event.eventType === "run.terminal").length;
    await session.completed("turn.start", { text });
    if (disposition === "done") {
      await vi.waitFor(() => expect(session.events.some(event => event.eventType === "semantic_tool.input"), JSON.stringify(session.events)).toBe(true), { timeout: 5_000 });
      // The real control plane dispatches the callback and durably queues its
      // correlated semantic_tool.result; do not manufacture a result command.
    }
    await vi.waitFor(() => {
      const terminals = session.events.filter(event => event.eventType === "run.terminal");
      expect(terminals).toHaveLength(previousTerminals + 1);
      expect(terminals.at(-1)?.payload).toMatchObject({ runTerminalState: "succeeded" });
      if (disposition === "done") expect(terminals.at(-1)?.payload).toMatchObject({ reportedWorkDisposition: "done" });
    }, { timeout: 5_000 });
    await session.completed("session.snapshot");
  }

  let failure: unknown;
  try {
    const first = await start("run-A");
    await first.completed("run.prepare", payload);
    await first.completed("session.open");
    await turn(first, "Save the initial work and retain our conversation.");
    await first.close();
    const checkpoint = join(first.stateDirectory, "codex-provider-state.json");
    const before = JSON.parse(await readFile(checkpoint, "utf8"));
    expect(before.runIdentity.runId).toBe("run-A");
    expect(before.activeProviderTurnId).toBeNull();
    expect(before.piDeferredTerminal ?? null).toBeNull();
    if (disposition === "done") expect(before.activeProviderResultDisposition).toBe("done");
    // Retain real serialized provider state and vary only the durable admission
    // fence. A separate runner process must decide at prepare, before restoring
    // the old provider or changing its configuration.
    if (blocker === "active_turn") {
      before.activeProviderTurnId = "unsettled-old-turn";
      before.lifecycle = "turn_active";
      before.completedTurnAuthoritative = false;
      before.completedProviderTurnId = null;
      before.completedTurnProcessGeneration = null;
    } else if (blocker === "descendant") before.descendantThreadIds = ["old-child-thread"];
    else if (blocker === "goal") before.goal = { objective: "Old work", status: "active", tokenBudget: null,
      tokensUsed: 0, elapsedSeconds: 0, iterations: 0, lastReason: null, createdAt: null,
      updatedAt: null, completedAt: null, workingNow: false };
    if (blocker) await writeFile(checkpoint, JSON.stringify(before), { mode: 0o600 });

    // Edit the on-disk fixture skill and model its new admitted version plus
    // the next run's instruction working-copy framing. The production composer
    // produces the changed prepare text; this is not a live assignment-service
    // test and does not claim that SKILL.md bytes alone change composed text.
    await writeFile(skillPath, "---\nname: assigned\ndescription: Edited skill v2.\n---\nPreserve saved work; use the updated skill.\n");
    const edited = structuredClone(context);
    edited.skills[0]!.versionId = "version-2";
    edited.skills[0]!.bundle.digest = createHash("sha256").update(await readFile(skillPath)).digest("hex");
    edited.instructions.workingCopy = { kind: "agent_files", rootPath: instructionRoot, entryPath: "AGENTS.md" };
    edited.aggregateDigest = canonicalNativeRuntimeContextDigest(edited);
    const nextInstructions = composeNativeSystemInstructions(edited, await readFile(join(instructionRoot, "AGENTS.md"), "utf8"));
    const nextPayload = { ...payload, provider: { ...descriptor, instructions: nextInstructions,
      ...(provider === "pi_rpc" ? { runtimeContext: edited } : {}) } };
    expect(nextPayload.provider.instructions).not.toBe(payload.provider.instructions);
    if (blocker === "contract") nextPayload.completionContract = { revision: "revision-2", criterionIds: ["criterion-1"] };
    const next = await start("run-B", checkpoint);
    const prepared = await next.command("run.prepare", nextPayload);
    console.log(`SKILL_EDIT_PRP provider=${provider} predecessor=${disposition} config_diff=[instructions] includeSkillInstructions_unchanged=true tools_unchanged=true completionContract_unchanged=${blocker !== "contract"} status=${prepared.status} result=${JSON.stringify(prepared.result)}`);
    expect(prepared).toMatchObject({ status: "completed" });
    if (blocker) {
      expect(prepared.result?.result).toMatchObject({ status: blocker === "goal" || blocker === "contract" ? "refresh_fresh" : "refresh_wait" });
      expect(JSON.parse(await readFile(join(next.stateDirectory, "codex-provider-state.json"), "utf8"))).toEqual(before);
      return;
    }
    await next.completed("session.open");
    const adopted = JSON.parse(await readFile(join(next.stateDirectory, "codex-provider-state.json"), "utf8"));
    expect(adopted.runIdentity.runId).toBe("run-B");
    expect(adopted.threadId).toBe(before.threadId);
    expect(adopted.config.instructions).toBe(nextInstructions);
    expect(adopted.completionContract).toEqual(before.completionContract);
    await turn(next, "Continue from the saved work using the edited assigned skill.");
    await next.close();
    const frames = (await readFile(tracePath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      .filter(entry => entry.kind === "frame" && entry.direction === "client_to_provider")
      .map(entry => JSON.parse(Buffer.from(entry.rawBase64, "base64").toString("utf8")));
    const resumes = frames.filter(frame => frame.method === "thread/resume");
    const instructionField = provider === "codex" ? "developerInstructions" : "baseInstructions";
    expect(resumes.at(-1).params[instructionField]).toContain(nextInstructions);
    expect(resumes.at(-1).params.threadId).toBe(before.threadId);
    expect(frames.filter(frame => frame.method === "thread/start")).toHaveLength(1);
    expect(frames.filter(frame => frame.method === "turn/start")).toHaveLength(2);
    // Same-run replays cannot mutate instructions after the new binding.
    const third = await start("run-B", join(next.stateDirectory, "codex-provider-state.json"));
    const rejected = await third.command("run.prepare", { ...nextPayload, provider: { ...nextPayload.provider, instructions: "same-run mutation" } });
    expect(rejected).toMatchObject({ status: "failed" });
  } catch (error) {
    failure = error;
    const trace = await readFile(tracePath, "utf8").catch(() => "");
    console.error("Provider response trace:", trace.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      .filter(entry => entry.kind === "frame" && entry.direction === "provider_to_client")
      .map(entry => Buffer.from(entry.rawBase64, "base64").toString("utf8")).slice(-12));
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const session of sessions.toReversed()) {
      try { await session.close(); } catch (error) { errors.push(error); }
    }
    await rm(root, { recursive: true, force: true });
    if (errors.length && failure) console.error("Cleanup after original failure:", ...errors);
    else if (errors.length) throw new AggregateError(errors, "Skill-edit fixture cleanup failed");
  }
}, 45_000);

it("warm Codex attachment uses the current instruction grant and resumes the same thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-edit-warm-"));
  const tracePath = join(root, "trace.ndjson");
  const { transport, evidence } = createCapabilityRunnerdCodexTransport({
    provider: "codex", runnerBinary: binary, codexCommand: fake,
    codexArgs: ["--state-file", join(root, "fake-state.json"), "--durable-turn-ids"],
    stateDirectory: root, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    environment: { PAPERCLIP_PROVIDER_TRACE_PATH: tracePath, PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(4 * 1024 * 1024) },
  });
  try {
    const opened = await transport.request("thread/start", { cwd: root, model: "gpt-test",
      baseInstructions: "Assigned skill v1", dynamicTools: [] }) as { thread: { id: string } };
    const previousPid = evidence().codexPid;
    await transport.attachRun!({ runId: "warm-run-B", turnId: "warm-turn-B", itemId: "warm-item-B",
      currentRunGrant: { runtimeContext: null, instructions: "Assigned skill edited v2" } });
    const read = await transport.request("thread/read", { threadId: opened.thread.id }) as { thread: { id: string } };
    expect(read.thread.id).toBe(opened.thread.id);
    const state = JSON.parse(await readFile(join(root, "runner/codex-provider-state.json"), "utf8"));
    expect(state.config.instructions).toBe("Assigned skill edited v2");
    expect(state.runIdentity.runId).toBe("warm-run-B");
    expect(evidence().codexPid).not.toBe(previousPid);
    const requests = (await readFile(tracePath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      .filter(entry => entry.kind === "frame" && entry.direction === "client_to_provider")
      .map(entry => JSON.parse(Buffer.from(entry.rawBase64, "base64").toString("utf8")));
    expect(requests.filter(frame => frame.method === "thread/resume").at(-1).params)
      .toMatchObject({ threadId: opened.thread.id, developerInstructions: "Assigned skill edited v2" });
    expect(requests.filter(frame => frame.method === "thread/start")).toHaveLength(1);
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
