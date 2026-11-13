import { unlinkSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPiNativeSessionBackend } from "./backends/pi-native-backend.js";
import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "./contracts/native-execution.js";
import { PiRpcHarnessSession } from "./drivers/pi/pi-rpc-driver.js";
import { PiRpcTransport } from "./drivers/pi/pi-rpc-transport.js";
import { QUALIFIED_PI_RPC_PROFILE } from "./drivers/pi/qualified-profile.js";
import { executeNativeSession, nativeSessionCleanupBlock } from "./native-session-runtime.js";

// Keep reason: recorded cleanup-quarantine incident (ca1be953) and process/child
// ownership boundary. Exercise real process exit, filesystem cleanup and runtime
// admission; deterministic faults keep genuinely incomplete cleanup observable.
async function fixture(overrides: Partial<ConstructorParameters<typeof PiRpcHarnessSession>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-close-"));
  const instructionFile = join(root, "instructions.md");
  await writeFile(instructionFile, "instructions");
  const transport = { pid: 42, exited: true, async *events() {}, close: vi.fn(async () => {}) };
  const session = new PiRpcHarnessSession({
    transport: transport as unknown as PiRpcTransport, runId: "run", normalizedSessionId: "session",
    providerSessionId: "native", sessionFile: join(root, "saved.jsonl"), workingDirectory: root,
    runnerInstanceId: "runner", now: () => new Date(), agentHome: root, instructionFile, instructionBoundary: "host",
    config: { provider: "pi_rpc", model: "neutral/model", piRpcThinkingLevel: "off" },
    identity: { providerSessionId: "native", model: "neutral/model", piRpcThinkingLevel: "off" }, piMetadata: {},
    initialContext: { baseInstructions: "", runtimeContext: null, instructions: "", tools: [], toolNames: {}, diagnostics: [] },
    bindRequest: async () => { throw new Error("unexpected bind request"); }, ...overrides,
  });
  return { session, transport, instructionFile, root };
}

describe("Pi cleanup retries", () => {
  it("retries only unfinished cleanup and coalesces concurrent close calls", async () => {
    let release!: () => void;
    const closeProvider = vi.fn().mockRejectedValueOnce(new Error("broker still listening"))
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const f = await fixture({ closeProvider });
    await expect(f.session.close()).rejects.toThrow("Pi cleanup failed");
    const retry = f.session.close();
    const concurrent = f.session.close();
    const settlement = Promise.allSettled([retry, concurrent]);
    try {
      await vi.waitFor(() => expect(closeProvider).toHaveBeenCalledTimes(2));
    } finally { release?.(); }
    expect(await settlement).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
    await f.session.close();
    expect(closeProvider).toHaveBeenCalledTimes(2);
    expect(f.transport.close).toHaveBeenCalledOnce();
  });

  it("accepts an already removed instruction file, but not a non-ENOENT filesystem error", async () => {
    const f = await fixture();
    await unlink(f.instructionFile);
    await expect(f.session.close()).resolves.toBeUndefined();
    const directory = await fixture();
    await unlink(directory.instructionFile); await mkdir(directory.instructionFile);
    await expect(directory.session.close()).rejects.toThrow("Pi cleanup failed");
    // The directory is a real cleanup failure, not proof that the target is gone.
  });

  it("retries an owed binding revocation rather than retaining its rejected promise", async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error("revocation unavailable")).mockResolvedValue(undefined);
    const f = await fixture();
    const resident = {
      directory: join(f.root, "private"), socketPath: join(f.root, "private", "bind.sock"), environment: {}, epoch: 1,
      context: { baseInstructions: "", runtimeContext: null, instructions: "", tools: [], toolNames: {}, diagnostics: [] },
      modelConfiguration: { id: "model", contextWindow: 128000, maxTokens: 8192, input: ["text"] as ["text"] },
      binding: { origin: { epoch: 1, runId: "run", turnId: "turn" }, close, initial: true },
    };
    const bound = await fixture({ resident });
    await expect(bound.session.close()).rejects.toThrow("Pi cleanup failed");
    await expect(bound.session.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(resident.binding).toBeNull();
    await f.session.close();
  });

  it("does not forgive an explicit uncertain child receipt after Pi exits", async () => {
    const f = await fixture(); f.transport.exited = false;
    f.transport.close.mockImplementation(async () => { f.transport.exited = true; });
    const bindRequest = vi.fn(async (_path, request) => ({ schema: 1, type: "stop_children", nonce: request.nonce, sessionId: request.sessionId, settled: [], uncertain: ["child"] }));
    const bound = await fixture({ transport: f.transport as unknown as PiRpcTransport, resident: {
      directory: join(f.root, "private"), socketPath: join(f.root, "private", "bind.sock"), environment: {}, epoch: 1,
      context: { baseInstructions: "", runtimeContext: null, instructions: "", tools: [], toolNames: {}, diagnostics: [] },
      modelConfiguration: { id: "model", contextWindow: 128000, maxTokens: 8192, input: ["text"] }, binding: null,
    }, bindRequest: bindRequest as ConstructorParameters<typeof PiRpcHarnessSession>[0]["bindRequest"] });
    await expect(bound.session.close()).rejects.toThrow("Pi child cleanup uncertain");
    expect(f.transport.exited).toBe(true);
    await expect(bound.session.close()).rejects.toThrow("Pi child cleanup uncertain");
    await f.session.close();
  });

  it("does not forgive a missing child receipt while Pi is live", async () => {
    const f = await fixture(); f.transport.exited = false;
    f.transport.close.mockRejectedValue(new Error("process group still alive"));
    const bindRequest = vi.fn(async () => { throw new Error("private IPC unavailable"); });
    const bound = await fixture({ transport: f.transport as unknown as PiRpcTransport, resident: {
      directory: join(f.root, "private"), socketPath: join(f.root, "private", "bind.sock"), environment: {}, epoch: 1,
      context: { baseInstructions: "", runtimeContext: null, instructions: "", tools: [], toolNames: {}, diagnostics: [] },
      modelConfiguration: { id: "model", contextWindow: 128000, maxTokens: 8192, input: ["text"] }, binding: null,
    }, bindRequest });
    await expect(bound.session.close()).rejects.toThrow(/uncertain|cleanup/);
    await expect(bound.session.close()).rejects.toThrow(/uncertain|cleanup/);
    expect(bindRequest).toHaveBeenCalledTimes(2);
    // Once exit is verified, lost IPC is benign, but physical cleanup is still owed.
    f.transport.exited = true; f.transport.close.mockResolvedValue(undefined);
    await expect(bound.session.close()).resolves.toBeUndefined();
    await f.session.close();
  });
});

describe("Pi transport cleanup retries", () => {
  it("retries failed process-group cleanup even after the process has exited", async () => {
    const transport = new PiRpcTransport({ command: process.execPath, args: ["-e", 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], cwd: tmpdir() });
    const kill = process.kill.bind(process);
    let denyCleanup = true;
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, requested) => {
      if (pid === -transport.pid! && denyCleanup) throw Object.assign(new Error("process-group cleanup denied"), { code: "EPERM" });
      return kill(pid, requested);
    });
    try {
      await expect(transport.close()).rejects.toThrow("process-group cleanup denied");
      expect(transport.exited).toBe(true);
      await expect(transport.close()).rejects.toThrow("process-group cleanup denied");
      denyCleanup = false;
      await expect(transport.close()).resolves.toBeUndefined();
    } finally { denyCleanup = false; await transport.close(); signal.mockRestore(); }
  });
});

// Scripted RPC JSONL peer: no credentials/model calls. The real Pi transport owns and
// observes this process. Its second prompt dies before ACK, as a continuation
// can do; the instruction file is already gone when close tries to remove it.
const peer = `
const readline = require("node:readline"); const fs = require("node:fs");
let prompts = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const c = JSON.parse(line); let data;
  if (c.type === "get_state") data = { sessionId: "native-cleanup", model: { provider: "neutral", id: "model" }, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  if (c.type === "get_available_models") data = { models: [{ provider: "neutral", id: "model" }] };
  if (c.type === "set_model") data = { provider: "neutral", id: "model" };
  if (c.type === "get_available_thinking_levels") data = { levels: ["off"] };
  if (c.type === "prompt") {
    ++prompts;
    if (process.env.DIE_ON_CONTINUATION === "1" && prompts === 2) { fs.unlinkSync(process.env.PAPERCLIP_PI_INSTRUCTIONS_FILE); process.exit(17); }
    data = { disposition: "started" };
  }
  console.log(JSON.stringify({ type: "response", id: c.id, command: c.type, success: true, data }));
  if (c.type === "prompt") {
    console.log(JSON.stringify({ type: "agent_start" }));
    const message = { role: "assistant", responseId: "answer-" + prompts, content: [{ type: "text", text: "Message ran" }], stopReason: "stop" };
    console.log(JSON.stringify({ type: "message_start", message }));
    console.log(JSON.stringify({ type: "message_end", message }));
    console.log(JSON.stringify({ type: "agent_end", messages: [message] }));
    console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
  }
});
`;

describe("Pi process death through native runtime admission", () => {
  const cases = [{ transient: false, native: false }, { transient: true, native: false },
    ...(process.env.PI_TEST_BINARY ? [{ transient: true, native: true }] : [])];
  it.each(cases)("runs the next message in the same domain after reset (%j)", async ({ transient, native }) => {
    const root = await mkdtemp(join(tmpdir(), "pi-runtime-cleanup-"));
    const transports: PiRpcTransport[] = [];
    const instructionFiles: string[] = [];
    let requests = 0;
    // Optional real Pi 1.5.2 qualification: local scripted model, no paid LLM.
    const server = native ? createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (++requests === 2) {
          unlinkSync(instructionFiles[0]!);
          process.kill(transports[0]!.pid!, "SIGKILL");
          res.destroy();
          return;
        }
        const records = [
          ["message_start", { message: { id: `message-${requests}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
          ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Message ran" } }],
          ["content_block_stop", { index: 0 }],
          ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
          ["message_stop", {}],
        ] as const;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(records.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""));
      });
    }) : undefined;
    if (server) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server?.address();
    const input: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId: `cleanup-${transient}-${native}`, issueId: "chat", agentId: "agent", runId: "first", executionWorkspaceId: "workspace" },
      task: { identifier: "CLEANUP", title: "Continue chat", description: null, prompt: "Continue", workMode: "standard" },
      workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: "before-reset", driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      provider: { kind: "pi_rpc", model: native ? "paperclip/faux" : "neutral/model", piRpcThinkingLevel: "off", profile: QUALIFIED_PI_RPC_PROFILE },
      completionContract: { id: "contract", sha256: "digest", schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Continue", criteria: [{ id: "objective", requirement: "Continue" }] } },
      interactionResponses: [], credentialBindings: [],
    };
    const closeAttempts: number[] = [];
    let cleanupUnavailable = transient;
    const backend = createPiNativeSessionBackend(input, {
      command: process.env.PI_TEST_BINARY,
      runtimeDirectory: join(root, "sessions"), environment: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1",
        ...(address && typeof address !== "string" ? { PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none" } : {}),
      },
      transportFactory: options => {
        const index = transports.length;
        instructionFiles.push(options.env!.PAPERCLIP_PI_INSTRUCTIONS_FILE!);
        const transport = new PiRpcTransport(native ? options : { ...options, command: process.execPath, args: ["-e", peer],
          env: { ...options.env, DIE_ON_CONTINUATION: index === 0 ? "1" : "0" } });
        transports.push(transport); closeAttempts.push(0);
        const close = transport.close.bind(transport);
        vi.spyOn(transport, "close").mockImplementation(async () => {
          ++closeAttempts[index]!; await close();
          if (index === 0 && cleanupUnavailable) throw new Error("physical cleanup temporarily unverified");
        });
        return transport;
      },
    });
    const events: string[] = [];
    const port: ControlPlanePort = {
      async openRun() {}, async checkpointSession() {}, async completeRun() {},
      async appendEvent(event) {
        if (!("sourceSeq" in event)) throw new Error("Expected native PRP event");
        events.push(event.eventType);
        return { cursor: event.sourceSeq, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" };
      },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
    };
    const execute = (current: NativeExecutionInputV1) => executeNativeSession({ input: current, backend, controlPlane: port,
      runnerInstanceId: "runner-cleanup", controlPlaneInstanceId: "control-cleanup",
      resolveMissingResult: async () => ({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Message ran",
        completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
        evidence: [], verification: [], attentionRequests: [], artifacts: [] }),
    });
    // Complete one prompt through the Pi driver, then kill its process during
    // continuation. Runtime must clean up that exact failed session.
    try {
      const first = await backend.openSession({ identity: { ...input.binding, sessionId: "before-reset" }, workingDirectory: root });
      const firstTurn = await first.startTurn({ message: { role: "user", text: "first message" } });
      for await (const event of first.events()) if (event.eventType === "turn.completed" && event.turnId === firstTurn.turnId) break;
      const reuseBackend = { ...backend, descriptor: () => backend.descriptor(), openSession: async () => first };
      const failed = executeNativeSession({ input, backend: reuseBackend, controlPlane: port, runnerInstanceId: "runner-cleanup", controlPlaneInstanceId: "control-cleanup" });
      await expect(failed).rejects.toThrow(/exited|closed/);
      expect(transports[0]!.exited).toBe(true);
      const reset = { ...input, binding: { ...input.binding, runId: "after-reset" }, session: { ...input.session, normalizedSessionId: "after-reset" } };
      if (transient) {
        await expect(execute(reset)).rejects.toThrow("native_session_cleanup_quarantined");
        expect(transports).toHaveLength(1);
        expect(nativeSessionCleanupBlock({ companyId: input.binding.companyId, issueId: "chat" })).not.toBeNull();
      }
      cleanupUnavailable = false;
      await expect(execute(reset)).resolves.toMatchObject({ result: { summary: "Message ran" } });
      expect(transports).toHaveLength(2);
      expect(events).toContain("turn.completed");
      expect(nativeSessionCleanupBlock({ companyId: input.binding.companyId, issueId: "chat" })).toBeNull();
      const files = await readdir(join(root, "sessions"));
      expect(files.filter(file => file.endsWith(".instructions.md"))).toEqual([]);
      expect(transports.every(transport => transport.exited)).toBe(true);
      if (native) {
        expect(await readFile(join(root, "sessions", "before-reset.jsonl"), "utf8")).toContain("Message ran");
        expect(await readFile(join(root, "sessions", "after-reset.jsonl"), "utf8")).toContain("Message ran");
        await writeFile(join(root, "native-cleanup-proof.json"), JSON.stringify({ binary: process.env.PI_TEST_BINARY,
          source: "Real Pi process; scripted local model, no paid LLM or daily-work claim", requests, closeAttempts,
          deadContinuationPid: transports[0]!.pid, successorPid: transports[1]!.pid, allProcessesExited: true,
          cleanupDomain: { companyId: input.binding.companyId, issueId: "chat" }, quarantineCleared: true,
          savedSessionFiles: files.filter(file => file.endsWith(".jsonl")), events,
        }, null, 2));
      }
    } finally {
      cleanupUnavailable = false;
      // Observe all physical children even on the RED path; retain evidence.
      await Promise.all(transports.map(transport => transport.close().catch(() => undefined)));
      if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  }, 30_000);
});
