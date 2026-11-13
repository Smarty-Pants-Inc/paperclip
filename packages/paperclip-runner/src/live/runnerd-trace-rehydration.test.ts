import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { RunnerdTraceFrameIndex } from "./runnerd-trace-frame-index.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, statSync: vi.fn(fs.statSync), existsSync: vi.fn(fs.existsSync) };
});

afterEach(() => vi.restoreAllMocks());

async function fixture(filePresent: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "runnerd-pending-trace-"));
  const path = join(directory, "trace.ndjson");
  if (filePresent) writeFileSync(path, "");
  let wake!: () => void;
  let core!: DurablePrpControlPlane;
  const subscribe = DurablePrpControlPlane.prototype.onReadableStateChange;
  vi.spyOn(DurablePrpControlPlane.prototype, "onReadableStateChange").mockImplementation(function (this: DurablePrpControlPlane, listener) {
    wake = listener;
    core = this;
    return subscribe.call(this, listener);
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    stateDirectory: join(directory, "state"),
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(directory),
    environment: { PAPERCLIP_PROVIDER_TRACE_PATH: path },
    runnerProcessLauncher: (spec) => {
      const environment = { ...spec.environment };
      delete environment.PAPERCLIP_PROVIDER_TRACE_PATH;
      const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: environment, stdio: "ignore" });
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal, stdout: "", stderr: "" }));
      });
      return { child, completion };
    },
  });
  const pump = async () => {
    wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    await bundle.transport.request("thread/start", { cwd: directory });
    await vi.waitFor(() => expect(core.store.state.committedEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["session.capabilities.updated", "session.goal.snapshot"]),
    ));
    await pump();
  } catch (error) {
    await bundle.transport.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { ...bundle, path, pump, cleanup: async () => {
    await bundle.transport.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

const interpretation = (id: string, method = "item/started") => ({
  sourceEventId: id,
  sourceEventType: "item.started",
  providerMethod: method,
  disposition: "mapped" as const,
  emittedEventIds: [`canonical:${id}:${method}`],
  reason: "Mapped notification",
});

it.each([false, true])("bounds filesystem calls across M pending entries and K real pumps (file present: %s)", async (filePresent) => {
  const f = await fixture(filePresent);
  try {
    const M = 512;
    const K = 12;
    for (let i = 0; i < M; i++) f.transport.recordTraceInterpretation!(interpretation(`pending-${i}`));
    const count = () => [statSync, existsSync].reduce((total, mock) => total + vi.mocked(mock).mock.calls.filter(([path]) => path === f.path).length, 0);
    const before = count();
    for (let i = 0; i < K; i++) await f.pump();
    const calls = count() - before;
    console.log(JSON.stringify({ filePresent, M, K, filesystemCallsDuringPumps: calls, baseLowerBound: M * K }));
    expect(calls).toBeLessThanOrEqual(4 * K);
  } finally {
    await f.cleanup();
  }
}, 30_000);

it("appends a late frame once, retaining distinct driver interpretations and contiguous sequences", async () => {
  const f = await fixture(false);
  try {
    for (let i = 0; i < 32; i++) f.transport.recordTraceInterpretation!(interpretation("late"));
    f.transport.recordTraceInterpretation!(interpretation("late", "item/completed"));
    for (let i = 0; i < 5; i++) await f.pump();
    appendFileSync(f.path, `${JSON.stringify({ kind: "interpretation", frameId: 42, emittedEventIds: ["late"] })}\n`);
    for (let i = 0; i < 5; i++) await f.pump();
    const records = readFileSync(`${f.path}.rehydration`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const late = records.filter((entry) => entry.sourceEventId === "late");
    expect(late).toHaveLength(2);
    expect(late.map((entry) => entry.ruleId)).toEqual([
      "codex_driver.normalize.item/started", "codex_driver.normalize.item/completed",
    ]);
    expect(late.map((entry) => entry.debugSequence)).toEqual([1, 2]);
    expect(late.map((entry) => entry.frameId)).toEqual([42, 42]);
    expect(late.map((entry) => entry.emittedEventIds)).toEqual([
      ["canonical:late:item/started"], ["canonical:late:item/completed"],
    ]);
  } finally {
    await f.cleanup();
  }
}, 30_000);

it("expires missing correlations with a diagnostic, leaves the run usable, and stops filesystem retries", async () => {
  const f = await fixture(false);
  const locate = vi.spyOn(RunnerdTraceFrameIndex.prototype, "locate");
  try {
    f.transport.recordTraceInterpretation!(interpretation("never-arrives"));
    for (let i = 0; i < 4100; i++) await f.pump();
    expect(f.evidence().diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining("typescript_rehydration_retry_limit"),
    ]));
    const count = () => vi.mocked(statSync).mock.calls.filter(([path]) => path === f.path).length;
    const missingCalls = () => locate.mock.calls.filter(([, eventId]) => eventId === "never-arrives").length;
    expect(missingCalls()).toBe(4097);
    await vi.waitFor(async () => {
      for (let i = 0; i < 4096; i++) await f.pump();
      const before = count();
      for (let i = 0; i < 12; i++) await f.pump();
      expect(count()).toBe(before);
    }, { timeout: 5000, interval: 10 });
    expect(missingCalls()).toBe(4097);
    await expect(f.transport.request("thread/read", {})).resolves.toHaveProperty("thread");
    await f.transport.close();
    const status = JSON.parse(readFileSync(`${f.path}.rehydration`, "utf8").trim().split("\n").at(-1)!);
    expect(status).toMatchObject({ status: "incomplete", reason: "typescript_rehydration_retry_limit" });
    const afterClose = count();
    f.transport.recordTraceInterpretation!(interpretation("after-close"));
    expect(count()).toBe(afterClose);
  } finally {
    await f.cleanup();
  }
}, 30_000);

it("drains more than one retry budget on close without losing any resolved trace records", async () => {
  const f = await fixture(false);
  try {
    const ids = Array.from({ length: 512 }, (_, i) => `final-${i}`);
    for (const id of ids) f.transport.recordTraceInterpretation!(interpretation(id));
    appendFileSync(f.path,
      `${JSON.stringify({ kind: "interpretation", frameId: 77, emittedEventIds: ids })}\n` +
      `${JSON.stringify({ kind: "trace_status", debugChannel: "rust_native", status: "complete" })}\n`);
    await f.transport.close();
    const records = readFileSync(`${f.path}.rehydration`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const resolved = records.filter((entry) => entry.stage === "typescript_codex_driver_normalization");
    expect(resolved.map((entry) => entry.sourceEventId)).toEqual(ids);
    expect(resolved.map((entry) => entry.frameId)).toEqual(ids.map(() => 77));
    expect(records.map((entry) => entry.debugSequence)).toEqual(records.map((_, i) => i + 1));
    expect(records.at(-1)).toMatchObject({ status: "complete", reason: null });
  } finally {
    await f.cleanup();
  }
}, 30_000);
