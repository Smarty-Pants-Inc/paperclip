import { readSync, statSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { probeTransportPump, type ReadableEvent, type TransportPumpProbe } from "../../test/support/transport-pump-probe.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
} from "./runnerd-codex-transport.js";

// A live transport used to look for committed events every 5 ms for as long as
// it was open, so a dozen open sessions kept the server's main thread busy
// with nothing to deliver, and every event waited for the next tick.
const fixture = resolve(import.meta.dirname, "../../test/fixtures/fake-paced-codex-app-server.mjs");
const DELTAS = 40;

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync), statSync: vi.fn(fs.statSync) };
});

async function openTransport(
  persistence: "file" | "external",
  onReadable?: (event: ReadableEvent) => void,
  environment: Record<string, string> = {},
  provider: "codex" | "pi_rpc" = "codex",
) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-transport-pump-"));
  const piProxyPath = join(root, "pi-proxy");
  if (provider === "pi_rpc") {
    const command = [process.execPath, fixture, String(DELTAS), "15"]
      .map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
    await writeFile(piProxyPath, `#!/bin/sh\nexec ${command}\n`, { mode: 0o700 });
  }
  let probe: TransportPumpProbe | null = null;
  let authority: DurablePrpControlPlane | null = null;
  const bundle = createCapabilityRunnerdCodexTransport({
    provider,
    ...(provider === "pi_rpc" ? { piProxyPath } : {}),
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: process.execPath,
    codexArgs: [fixture, String(DELTAS), "15"],
    environment,
    stateDirectory: join(root, "session"),
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    controlPlaneRegistration: async (core) => {
      authority = core;
      probe = probeTransportPump(core, persistence, onReadable);
      return probe.registration();
    },
  });
  try {
    await bundle.transport.request("thread/start", { cwd: root, model: provider === "pi_rpc" ? "fixture/no-model" : "fixture-no-model", dynamicTools: [] });
  } catch (error) {
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    transport: bundle.transport,
    probe: probe!,
    core: authority!,
    async close() {
      await bundle.transport.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.each(["file", "external"] as const)("runnerd transport event pump with %s persistence", (persistence) => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops looking for events while an open session has none to deliver", async () => {
    const session = await openTransport(persistence);
    try {
      const before = session.probe.stateReads();
      await new Promise((elapsed) => setTimeout(elapsed, 2_000));
      // The 5 ms poll took the state several hundred times a second. Without
      // it, only the tail of session startup reads the state in this window.
      expect(session.probe.stateReads() - before).toBeLessThan(100);

      // The quiet session still delivers the first event that arrives.
      const notifications = session.transport.notifications()[Symbol.asyncIterator]();
      await session.transport.request("turn/start", { input: [{ type: "text", text: "Stream the paced fixture." }] });
      for (;;) {
        const next = await notifications.next();
        expect(next.done).not.toBe(true);
        if (next.value.method === "turn/completed") break;
      }
    } finally {
      await session.close();
    }
  }, 30_000);

  it("delivers each committed event in the next task, without a timer tick", async () => {
    // No interval ever fires in this test, so nothing here can be delivered by
    // a periodic poll.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // The control plane wakes the transport before this probe sees the event,
    // so a task queued here runs after the transport's delivery task. That
    // order does not depend on the host's speed.
    const overtaken = new Set<number>();
    const pending = new Map<number, NodeJS.Immediate>();
    const session = await openTransport(persistence, (event) => {
      if (event.eventType !== "item.delta") return;
      pending.set(event.sourceSeq, setImmediate(() => {
        pending.delete(event.sourceSeq);
        overtaken.add(event.sourceSeq);
      }));
    });
    try {
      const notifications = session.transport.notifications()[Symbol.asyncIterator]();
      await session.transport.request("turn/start", { input: [{ type: "text", text: "Stream the paced fixture." }] });
      // Events committed before this point can wait for the start response.
      const startAnswered = performance.now();
      const deliveredInOrder: boolean[] = [];
      let completed = false;
      let stalled: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (async () => {
          for (;;) {
            const next = await notifications.next();
            if (next.done) return;
            if (next.value.method === "item/agentMessage/delta") {
              const event = session.probe.readable.filter((candidate) => candidate.eventType === "item.delta")[deliveredInOrder.length]!;
              clearImmediate(pending.get(event.sourceSeq));
              pending.delete(event.sourceSeq);
              deliveredInOrder.push(event.at < startAnswered || !overtaken.has(event.sourceSeq));
            }
            if (next.value.method === "turn/completed") {
              completed = true;
              return;
            }
          }
        })(),
        new Promise<void>((elapsed) => { stalled = setTimeout(elapsed, 10_000); }),
      ]);
      clearTimeout(stalled);

      expect(completed, "the turn's events were delivered without a periodic poll").toBe(true);
      expect(deliveredInOrder).toHaveLength(DELTAS);
      expect(deliveredInOrder.every(Boolean), "every event was delivered in the task after it became readable").toBe(true);
      // The assertion above covers the events streamed after the start response.
      expect(session.probe.readable.some((event) => event.eventType === "item.delta" && event.at >= startAnswered)).toBe(true);
    } finally {
      for (const task of pending.values()) clearImmediate(task);
      vi.useRealTimers();
      await session.close();
    }
  }, 30_000);
});

const pendingInterpretation = (sourceEventId: string) => ({
  sourceEventId,
  sourceEventType: "item.delta",
  providerMethod: "item/agentMessage/delta",
  disposition: "mapped" as const,
  emittedEventIds: [sourceEventId],
  reason: "Trace correlation regression",
});
const nextTask = () => new Promise<void>((done) => setImmediate(done));

async function openTraceTransport(tracePath: string, provider: "codex" | "pi_rpc" = "codex") {
  // These tests own the synthetic native writer. Do not mix startup frames or
  // a real pre-fake-clock retry interval into that writer's correlation queue.
  const environment: Record<string, string> = {};
  const session = await openTransport("file", undefined, environment, provider);
  await nextTask();
  environment.PAPERCLIP_PROVIDER_TRACE_PATH = tracePath;
  return session;
}

describe("native trace correlation retry lifetime", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("retires an empty native file's pending work after 30s without a 5ms stat storm", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-trace-pump-"));
    const tracePath = join(directory, "trace.ndjson");
    const session = await openTraceTransport(tracePath);
    try {
      await nextTask();
      await writeFile(tracePath, "");
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.mocked(statSync).mockClear();
      const traceStats = () => vi.mocked(statSync).mock.calls.filter(([path]) => path === tracePath).length;
      for (let i = 0; i < 512; i++) session.transport.recordTraceInterpretation!(pendingInterpretation(`missing-${i}`));
      // Ingress must not perform a stat for every item either.
      expect(traceStats()).toBe(0);
      await nextTask();
      expect(traceStats()).toBeLessThanOrEqual(1);
      expect(vi.getTimerCount()).toBe(1);
      const before = traceStats();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(traceStats() - before).toBeLessThanOrEqual(4);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(vi.getTimerCount()).toBe(0);
      const retired = traceStats();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(traceStats()).toBe(retired);
      vi.useRealTimers();
      await session.transport.close();
      const status = JSON.parse((await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").at(-1)!);
      expect(status).toMatchObject({ status: "incomplete", reason: "typescript_rehydration_correlation_incomplete" });
    } finally {
      vi.useRealTimers();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("still correlates Codex native frames appended after an initial empty pass", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-trace-arrival-"));
    const tracePath = join(directory, "trace.ndjson");
    const session = await openTraceTransport(tracePath);
    try {
      await nextTask();
      await writeFile(tracePath, "");
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      session.transport.recordTraceInterpretation!(pendingInterpretation("late-native-frame"));
      await nextTask();
      await appendFile(tracePath, `${JSON.stringify({ kind: "interpretation", frameId: 987, emittedEventIds: ["late-native-frame"] })}\n`);
      await vi.advanceTimersByTimeAsync(250);
      const entries = (await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({ sourceEventId: "late-native-frame", frameId: 987, stage: "typescript_codex_driver_normalization" }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([null, 17])("refreshes driver ingress after cached settlement or an older match (oldFrame=%s)", async (oldFrame) => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-stale-trace-"));
    const tracePath = join(directory, "trace.ndjson");
    const session = await openTraceTransport(tracePath);
    try {
      await nextTask();
      await writeFile(tracePath, [
        { kind: "interpretation", frameId: 1, emittedEventIds: ["seed"] },
        ...(oldFrame === null ? [] : [{ kind: "interpretation", frameId: oldFrame, emittedEventIds: ["fresh"] }]),
        { kind: "trace_status", debugChannel: "rust_native", status: "complete" },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      session.transport.recordTraceInterpretation!(pendingInterpretation("seed"));
      await nextTask();
      await appendFile(tracePath, `${JSON.stringify({ kind: "interpretation", frameId: 99, emittedEventIds: ["fresh"] })}\n`);
      vi.mocked(statSync).mockClear();
      session.transport.recordTraceInterpretation!(pendingInterpretation("fresh"));
      expect(vi.mocked(statSync).mock.calls.filter(([path]) => path === tracePath)).toHaveLength(0);
      await nextTask();
      const entries = (await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.filter((entry) => entry.sourceEventId === "fresh")).toEqual([
        expect.objectContaining({ frameId: 99, stage: "typescript_codex_driver_normalization" }),
      ]);
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("correlates a slow writer completing its partial frame at 29,999ms before the expiry pass", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-deadline-trace-"));
    const tracePath = join(directory, "trace.ndjson");
    const session = await openTraceTransport(tracePath);
    try {
      await nextTask();
      await writeFile(tracePath, "");
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      session.transport.recordTraceInterpretation!(pendingInterpretation("near-deadline"));
      await nextTask();
      await vi.advanceTimersByTimeAsync(29_500);
      const frame = JSON.stringify({ kind: "interpretation", frameId: 123, emittedEventIds: ["near-deadline"] });
      await appendFile(tracePath, frame.slice(0, -1));
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(249);
      await appendFile(tracePath, frame.slice(-1) + "\n");
      await vi.advanceTimersByTimeAsync(1);
      const entries = (await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({ sourceEventId: "near-deadline", frameId: 123 }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps incremental read progress through an expired native backlog into close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-close-backlog-"));
    const tracePath = join(directory, "trace.ndjson");
    const session = await openTraceTransport(tracePath);
    try {
      await nextTask();
      const replacement = join(directory, "replacement.ndjson");
      await writeFile(replacement, JSON.stringify({ kind: "frame", rawBase64: "x".repeat(2 * 1024 * 1024) }) + "\n" +
        JSON.stringify({ kind: "interpretation", frameId: 456, emittedEventIds: ["backlogged"] }) + "\n" +
        JSON.stringify({ kind: "trace_status", debugChannel: "rust_native", status: "complete" }) + "\n");
      await rename(replacement, tracePath);
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.mocked(readSync).mockClear();
      session.transport.recordTraceInterpretation!(pendingInterpretation("backlogged"));
      await nextTask(); // consumes only the first 1MiB
      const readsBeforeClose = vi.mocked(readSync).mock.calls.length;
      expect(readsBeforeClose).toBeGreaterThan(0);
      vi.setSystemTime(Date.now() + 30_000);
      await session.transport.close();
      const positions = vi.mocked(readSync).mock.calls.map((call) => (call as unknown as [number, Buffer, number, number, number])[4]);
      expect(positions[0]).toBe(0);
      expect(positions.length).toBeGreaterThan(readsBeforeClose);
      expect(positions.slice(readsBeforeClose).every((position) => position > 0)).toBe(true);
      const entries = (await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({ sourceEventId: "backlogged", frameId: 456 }));
      expect(entries.at(-1)).toMatchObject({ status: "complete" });
    } finally {
      vi.useRealTimers();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([false, true])("refreshes a real native file before close-time expiry (atDeadline=%s)", async (atDeadline) => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-native-correlation-batch-"));
    const tracePath = join(directory, "trace.ndjson");
    await writeFile(tracePath, "");
    const { transport } = createCapabilityRunnerdCodexTransport({ environment: { PAPERCLIP_PROVIDER_TRACE_PATH: tracePath } });
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      for (let i = 0; i < 512; i++) transport.recordTraceInterpretation!(pendingInterpretation(`batch-${i}`));
      if (atDeadline) vi.setSystemTime(Date.now() + 30_000);
      await appendFile(tracePath, Array.from({ length: 512 }, (_, i) => JSON.stringify({
        kind: "interpretation", frameId: i + 1, emittedEventIds: [`batch-${i}`],
      })).join("\n") + "\n");
      vi.mocked(statSync).mockClear();
      await transport.close();
      expect(vi.mocked(statSync).mock.calls.filter(([path]) => path === tracePath)).toHaveLength(1);
      const entries = (await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const interpretations = entries.filter((entry) => entry.kind === "interpretation");
      expect(interpretations).toHaveLength(512);
      expect(interpretations.map((entry) => entry.frameId)).toEqual(Array.from({ length: 512 }, (_, i) => i + 1));
      expect(entries.at(-1)).toMatchObject({ status: "complete" });
    } finally {
      vi.useRealTimers();
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not scan or correlate Pi's own interpretation records, even with a raw backlog at close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-pi-driver-trace-"));
    const tracePath = join(directory, "trace.ndjson");
    await writeFile(tracePath, JSON.stringify({
      kind: "interpretation", debugChannel: "typescript_codex_driver",
      frameId: 99, emittedEventIds: ["pi-driver"],
    }) + "\n" + JSON.stringify({ kind: "frame", rawBase64: "x".repeat(2 * 1024 * 1024) }) + "\n");
    const session = await openTraceTransport(tracePath, "pi_rpc");
    const { transport } = session;
    try {
      vi.mocked(readSync).mockClear();
      vi.mocked(statSync).mockClear();
      for (let i = 0; i < 512; i++) transport.recordTraceInterpretation!(pendingInterpretation("pi-driver"));
      const notifications = transport.notifications()[Symbol.asyncIterator]();
      await transport.request("turn/start", { input: [{ type: "text", text: "Deliver Pi events without scanning its trace." }] });
      for (;;) {
        const next = await notifications.next();
        expect(next.done).toBe(false);
        if (next.value.method === "turn/completed") break;
      }
      await nextTask();
      await transport.close();
      expect(vi.mocked(readSync).mock.calls.length).toBe(0);
      expect(vi.mocked(statSync).mock.calls.filter(([path]) => path === tracePath)).toHaveLength(0);
      const entries = (await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toEqual([expect.objectContaining({ kind: "trace_status", status: "complete" })]);
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(["empty", "missing"])("throttles trace-only refreshes to 4/s while held delivery still retries every 5ms (%s trace)", async (traceState) => {
    const directory = await mkdtemp(join(tmpdir(), "runnerd-held-trace-"));
    const tracePath = join(directory, "trace.ndjson");
    const session = await openTraceTransport(tracePath);
    const getCommand = session.core.getCommand.bind(session.core);
    let hold = true;
    const commandSpy = vi.spyOn(session.core, "getCommand").mockImplementation((id) => {
      const command = getCommand(id);
      return hold && command?.type === "turn.start"
        ? { ...command, status: "pending", result: null } : command;
    });
    let starting: Promise<unknown> | undefined;
    try {
      if (traceState === "empty") await writeFile(tracePath, "");
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      starting = session.transport.request("turn/start", { input: [{ type: "text", text: "Hold the command receipt." }] });
      await vi.waitFor(() => expect(session.probe.readable.some((event) => event.eventType === "turn.completed")).toBe(true), { timeout: 10_000 });
      session.transport.recordTraceInterpretation!(pendingInterpretation("held-trace"));
      await nextTask();
      const reads = session.probe.stateReads();
      vi.mocked(statSync).mockClear();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(session.probe.stateReads() - reads).toBeGreaterThanOrEqual(100);
      expect(vi.mocked(statSync).mock.calls.filter(([path]) => path === tracePath).length).toBeLessThanOrEqual(4);
      await appendFile(tracePath, JSON.stringify({ kind: "interpretation", debugChannel: "rust_native", frameId: 321, emittedEventIds: ["held-trace"] }) + "\n");
      await vi.advanceTimersByTimeAsync(250);
      const entries = (await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({ sourceEventId: "held-trace", frameId: 321 }));
      hold = false;
      await starting;
      await vi.advanceTimersByTimeAsync(5);
      const notifications = session.transport.notifications()[Symbol.asyncIterator]();
      for (;;) {
        const next = await notifications.next();
        expect(next.done).toBe(false);
        if (next.value.method === "turn/completed") break;
      }
    } finally {
      hold = false;
      commandSpy.mockRestore();
      vi.useRealTimers();
      await session.close();
      await starting?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("correlates a native provider's rust_native records", async () => {
    const frameId = 45;
    const directory = await mkdtemp(join(tmpdir(), "runnerd-pi-no-native-"));
    const tracePath = join(directory, "trace.ndjson");
    await writeFile(tracePath, "");
    await appendFile(tracePath, `${JSON.stringify({ kind: "interpretation", debugChannel: "rust_native", frameId, emittedEventIds: ["pi-0"] })}\n`);
    const { transport } = createCapabilityRunnerdCodexTransport({ environment: { PAPERCLIP_PROVIDER_TRACE_PATH: tracePath } });
    try {
      vi.mocked(statSync).mockClear();
      transport.recordTraceInterpretation!(pendingInterpretation("pi-0"));
      await transport.close();
      const entries = (await readFile(`${tracePath}.rehydration`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.filter((entry) => entry.kind === "interpretation")).toHaveLength(1);
      expect(entries[0]).toMatchObject({ sourceEventId: "pi-0", frameId });
      expect(entries.at(-1)).toMatchObject({ status: "complete" });
      expect(vi.mocked(statSync).mock.calls.filter(([path]) => path === tracePath).length).toBeLessThanOrEqual(1);
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
