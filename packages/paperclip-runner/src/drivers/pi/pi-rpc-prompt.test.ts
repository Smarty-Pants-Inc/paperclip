import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: K3/K4 are recorded RPC acceptance/ownership failures. Real pipes
// and the real session pump prove a lost ACK never causes duplicate model input.
const fakePi = `
  const { appendFileSync } = require("node:fs");
  const { createInterface } = require("node:readline");
  const mode = process.env.TEST_PROMPT_MODE;
  let streaming = false, prompted = false, promptCount = 0, messageId = 0;
  const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
  const answer = request => emit({ type: "response", id: request.id, command: request.type, success: true });
  const start = () => {
    streaming = true;
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { role: "assistant", responseId: "m-" + (++messageId), provider: "neutral", model: "model", timestamp: messageId } });
  };
  const finish = () => {
    const message = { role: "assistant", responseId: "m-" + messageId, provider: "neutral", model: "model", timestamp: messageId, content: [{ type: "text", text: "answer" }], stopReason: "stop" };
    emit({ type: "message_end", message });
    emit({ type: "agent_settled", aborted: false });
    streaming = false;
  };
  createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify(request) + "\\n");
    let data;
    if (request.type === "get_state") {
      if (prompted && mode === "silent-state") return;
      data = { sessionId: mode === "wrong-session" && prompted ? "wrong" : "native-session", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: streaming, isCompacting: false, pendingMessageCount: 0 };
    } else if (request.type === "set_model") data = { provider: "neutral", id: "model" };
    else if (request.type === "get_available_models") data = { models: [{ provider: "neutral", id: "model", contextWindow: 200000 }] };
    else if (request.type === "get_available_thinking_levels") data = { levels: ["high"] };
    else if (request.type === "test_finish") { finish(); answer(request); return; }
    else if (request.type === "prompt") {
      prompted = true; promptCount++;
      if (mode === "silent" || mode === "silent-state") return;
      if (promptCount === 1 && ["handled", "handled-independent", "handled-independent-after"].includes(mode)) {
        if (mode === "handled-independent") { start(); finish(); }
        data = { disposition: "handled" };
        emit({ type: "response", id: request.id, command: request.type, success: true, data });
        if (mode === "handled-independent-after") { start(); finish(); }
        return;
      }
      if (promptCount === 1 && mode === "rejected") {
        emit({ type: "response", id: request.id, command: request.type, success: false, error: "rejected before acceptance" }); return;
      }
      if (promptCount === 1 && mode === "invalid") {
        emit({ type: "response", id: request.id, command: request.type, success: true, data: { disposition: "not-a-disposition" } }); return;
      }
      if (mode !== "accepted-silent") start();
      if (mode === "streaming" || mode === "wrong-session") return;
      if (mode === "settled") { finish(); return; }
      data = { disposition: mode === "queued" && promptCount === 1 ? "queued" : "started" };
      emit({ type: "response", id: request.id, command: request.type, success: true, data });
      if (mode === "compaction-error") {
        emit({ type: "compaction_start", reason: "threshold" });
        emit({ type: "compaction_end", reason: "threshold", aborted: false, errorMessage: "Compaction service unavailable" });
      }
      if (data.disposition !== "queued" && !["accepted-silent", "started-silent"].includes(mode)) finish(); return;
    }
    emit({ type: "response", id: request.id, command: request.type, success: true, data });
  }).on("close", () => process.exit(0));
`;

async function fixture(mode: string, turnIdleTimeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-"));
  const log = join(root, "commands.jsonl");
  const sessions: PiRpcHarnessSession[] = [];
  const drains: Promise<void>[] = [];
  const events: PrpEvent[][] = [];
  const transports: PiRpcTransport[] = [];
  const deadline = 80;
  const driver = new PiRpcDriver({
    runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
    promptTimeoutMs: deadline,
    turnIdleTimeoutMs,
    environment: { PI_CODING_AGENT_DIR: join(root, "agent") },
    transportFactory: (options: PiRpcTransportOptions) => {
      const transport = new PiRpcTransport({ ...options, command: process.execPath, args: ["-e", fakePi],
        env: { ...options.env, TEST_PROMPT_MODE: sessions.length === 0 ? mode : "started", TEST_COMMAND_LOG: log },
        shutdownTimeoutMs: 100, killTimeoutMs: 100 });
      transports.push(transport);
      return transport;
    },
  });
  async function open() {
    const session = await driver.openSession({ runId: `run-${sessions.length}`, normalizedSessionId: "normalized", workingDirectory: root }) as PiRpcHarnessSession;
    sessions.push(session);
    const captured: PrpEvent[] = []; events.push(captured);
    drains.push((async () => { try { for await (const event of session.events()) captured.push(event); } catch { /* terminal events retain failures */ } })());
    return session;
  }
  return { root, deadline, open, events, transports,
    async commands() { return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)); },
    async close() {
      await Promise.all(sessions.map(session => session.close()));
      await Promise.all(drains);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function bounded<T>(promise: Promise<T>, timeoutMs = 600): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("test watchdog: prompt remained pending")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

describe("Pi RPC event-idle deadline through real subprocess pipes (L15)", () => {
  it.each(["accepted-silent", "started-silent"])("retires %s Pi and forwards the captured turn's idle failure", async mode => {
    const f = await fixture(mode, 80);
    try {
      const session = await f.open();
      const turn = await session.startTurn({ message: { role: "user", text: "accepted once" } });
      await expect.poll(() => f.events[0].find(event => event.eventType === "turn.failed" && event.turnId === turn.turnId)).toMatchObject({
        runId: "run-0", payload: { error: { code: "pi_turn_idle_timeout", recoverable: false } },
      });
      await session.close();
      expect(session.processExited()).toBe(true);
      expect(f.events[0].filter(event => event.eventType.startsWith("turn.") && event.eventType !== "turn.started")).toHaveLength(1);
      expect((await f.commands()).filter(command => command.type === "prompt")).toHaveLength(1);
    } finally { await f.close(); }
  });
});

// Keep reason: L17's native compaction error must cross real subprocess pipes
// without overriding the later successful assistant receipt / agent_settled.
describe("Pi RPC compaction error through the real driver pump (L17)", () => {
  it("keeps a compaction warning visible and completes only at native settlement", async () => {
    const f = await fixture("compaction-error");
    try {
      const session = await f.open();
      const turn = await session.startTurn({ message: { role: "user", text: "recover after summarizer failure" } });
      await expect.poll(() => f.events[0].find(event => event.eventType === "turn.completed" && event.turnId === turn.turnId)).toMatchObject({ payload: { piAgentSettled: true } });
      expect(f.events[0].find(event => event.payload.kind === "warning")).toMatchObject({ eventType: "item.completed", runId: "run-0", turnId: turn.turnId, payload: { code: "pi_compaction_failed", text: expect.stringContaining("Compaction service unavailable") } });
      expect(f.events[0].some(event => event.eventType === "turn.failed" || event.eventType === "context.compacted")).toBe(false);
      expect(session.processExited()).toBe(false);
      expect((await f.commands()).filter(command => command.type === "prompt")).toHaveLength(1);
    } finally { await f.close(); }
  });
});

// The watchdog is only a RED-test escape hatch; it does not enforce the client deadline.
describe("Pi RPC prompt acceptance deadline (K3)", () => {
  it.each(["silent", "silent-state", "wrong-session"])("fails only the unknown turn, never resends, retires %s Pi, and the next fresh child works", async mode => {
    const f = await fixture(mode);
    try {
      const first = await f.open();
      const pid = first.processPid();
      const start = performance.now();
      await expect(bounded(first.startTurn({ message: { role: "user", text: "do once" } }))).rejects.toThrow(/deadline/i);
      expect(performance.now() - start).toBeLessThan(500);
      expect(first.processExited()).toBe(true);
      expect(f.events[0].filter(event => event.eventType === "turn.failed")).toMatchObject([
        { payload: { error: { code: "pi_prompt_deadline_exceeded", acceptance: "unknown", recoverable: false } } },
      ]);
      expect(f.events[0].some(event => event.eventType === "turn.completed")).toBe(false);
      const commands = await f.commands();
      expect(commands.filter(command => command.type === "prompt")).toHaveLength(1);
      expect(commands.at(-1)?.type).toBe("get_state");
      await expect(first.startTurn({ message: { role: "user", text: "do not reuse" } })).rejects.toThrow(/closed/);
      const fresh = await f.open();
      expect(fresh.processPid()).not.toBe(pid);
      const turn = await bounded(fresh.startTurn({ message: { role: "user", text: "next turn" } }));
      await expect.poll(() => f.events[1].find(event => event.eventType === "turn.completed" && event.turnId === turn.turnId)).toBeDefined();
      expect((await f.commands()).filter(command => command.type === "prompt").map(command => command.message)).toEqual(["do once", "next turn"]);
    } finally { await f.close(); }
  });

  it("reconciles a lost ACK only with the captured streaming run and matching native session, without resending", async () => {
    const f = await fixture("streaming");
    try {
      const session = await f.open();
      const turn = await bounded(session.startTurn({ message: { role: "user", text: "accepted once" } }));
      expect(session.processExited()).toBe(false);
      expect((await f.commands()).filter(command => command.type === "prompt")).toHaveLength(1);
      expect((await f.commands()).at(-1)?.type).toBe("get_state");
      await f.transports[0].request("test_finish");
      await expect.poll(() => f.events[0].find(event => event.eventType === "turn.completed" && event.turnId === turn.turnId)).toBeDefined();
      expect(f.events[0].some(event => event.eventType === "turn.failed" || event.eventType === "session.failed")).toBe(false);
    } finally { await f.close(); }
  });

  it("does not fail or retire a turn that already settled while its prompt ACK was lost", async () => {
    const f = await fixture("settled");
    try {
      const session = await f.open();
      const turn = await bounded(session.startTurn({ message: { role: "user", text: "fast answer, lost ACK" } }));
      expect(session.processExited()).toBe(false);
      expect(f.events[0].filter(event => event.eventType === "turn.completed")).toMatchObject([{ turnId: turn.turnId }]);
      expect(f.events[0].some(event => event.eventType === "turn.failed" || event.eventType === "session.failed")).toBe(false);
      expect((await f.commands()).filter(command => command.type === "prompt")).toHaveLength(1);
    } finally { await f.close(); }
  });
});

describe("Pi RPC prompt dispositions (K4)", () => {
  it.each(["handled", "handled-independent", "handled-independent-after"])("completes %s with an explicit no-model-output outcome, no settlement wait and no session fence", async mode => {
    const f = await fixture(mode);
    try {
      const session = await f.open();
      const pid = session.processPid();
      const first = await bounded(session.startTurn({ message: { role: "user", text: "/extension-command" } }));
      expect(f.events[0].filter(event => event.eventType === "turn.completed")).toMatchObject([
        { turnId: first.turnId, payload: { status: "completed", outcome: "handled", modelOutput: false } },
      ]);
      expect(f.events[0].find(event => event.eventType === "turn.completed")?.payload.piAgentSettled).toBeUndefined();
      expect(f.events[0].some(event => event.turnId === first.turnId && event.eventType.startsWith("item."))).toBe(false);
      expect((await session.snapshot()).activeTurnId).toBeNull();
      expect(session.processExited()).toBe(false);
      const second = await bounded(session.startTurn({ message: { role: "user", text: "real model work" } }));
      await expect.poll(() => f.events[0].find(event => event.eventType === "turn.completed" && event.turnId === second.turnId)).toBeDefined();
      expect(session.processPid()).toBe(pid);
      expect(f.events[0].some(event => event.eventType === "turn.failed" || event.eventType === "session.failed")).toBe(false);
      expect(f.events[0].filter(event => event.turnId === first.turnId && event.eventType.startsWith("item."))).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(["started", "queued"])("accepts %s and completes only on the owned agent_settled", async disposition => {
    const f = await fixture(disposition);
    try {
      const session = await f.open();
      const turn = await bounded(session.startTurn({ message: { role: "user", text: "model work" } }));
      if (disposition === "queued") {
        expect(f.events[0].some(event => event.eventType === "turn.completed")).toBe(false);
        await f.transports[0].request("test_finish");
      }
      await expect.poll(() => f.events[0].find(event => event.eventType === "turn.completed" && event.turnId === turn.turnId)).toBeDefined();
      expect(f.events[0].find(event => event.eventType === "turn.completed")?.payload).toMatchObject({ status: "completed", piAgentSettled: true });
      expect(f.events[0].some(event => event.eventType === "turn.failed" || event.eventType === "session.failed")).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["rejected", "invalid"])("fails %s input without retiring the session and the next prompt works", async mode => {
    const f = await fixture(mode);
    try {
      const session = await f.open();
      const pid = session.processPid();
      await expect(bounded(session.startTurn({ message: { role: "user", text: "not accepted" } }))).rejects.toThrow();
      expect(f.events[0].filter(event => event.eventType === "turn.failed")).toMatchObject([
        { payload: { error: { code: "pi_prompt_rejected" } } },
      ]);
      expect(session.processExited()).toBe(false);
      const turn = await bounded(session.startTurn({ message: { role: "user", text: "accepted" } }));
      await expect.poll(() => f.events[0].find(event => event.eventType === "turn.completed" && event.turnId === turn.turnId)).toBeDefined();
      expect(session.processPid()).toBe(pid);
      expect(f.events[0].some(event => event.eventType === "session.failed")).toBe(false);
    } finally { await f.close(); }
  });
});
