import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { predecessorSandboxRecordFromObservation } from "../environment-runtime.js";
import { PREDECESSOR_SANDBOX_READ_TIMEOUT_MS, remoteRunnerGenerationLost, type PredecessorSandboxRecord } from "./native-session-executor.js";

// Independent boundary checks from the supplied ruling (RFL's judge test on
// f3eb36cb, adopted into the tree). Provider records and remote command
// responses are synthetic; this does not claim a live Boat run.
// Keep reason: the boundary decides whether a predecessor may be retired.
// Adapted after the helper-check verdict: Core reads no raw provider state
// names, so "cancelled" and "archived" records prove nothing here (the plugin
// maps them to destroyed and stopped), and the marker probe needs the same box.
const providerNow = "2026-11-13T11:00:00.000Z";
const start = { at: "2026-11-13T10:00:00.000Z", source: "run" as const };
const record = (state: string, stoppedAt: string | null = null, lastRebootAt: string | null = null): PredecessorSandboxRecord =>
  ({ kind: "present", state, stoppedAt, lastRebootAt, observedAt: providerNow });
const reply = (exitCode: number, stdout = "") => ({ exitCode, stdout, stderr: "", signal: null, timedOut: false });
function runner(marker: "missing" | "lost") {
  let calls = 0;
  return { execute: vi.fn(async () => {
    calls++;
    if (marker === "missing") return reply(31);
    if (calls % 2 === 1) return reply(0, "nonceJudge\n12345\n2026-11-13T10:00:00.000Z\nold-runner\nlinux:11111111-1111-1111-1111-111111111111:23456\n");
    return reply(47); // A restored marker on the CURRENT box has a different boot.
  }) } as unknown as CommandManagedRuntimeRunner;
}
const evaluate = (readSandbox: () => Promise<PredecessorSandboxRecord>, marker: "missing" | "lost" = "missing", probedProviderLeaseId: string | null = "old-box") =>
  remoteRunnerGenerationLost({ runner: runner(marker), remoteCwd: "/workspace", identity: {
    runnerInstanceId: "old-runner", normalizedSessionId: "old-session",
  }, predecessor: { readSandbox, start, providerLeaseId: "old-box", probedProviderLeaseId }, now: () => Date.parse("2026-11-13T12:00:00.000Z") });
afterEach(() => vi.useRealTimers());

describe("provider branches, without a usable marker", () => {
  it.each([
    ["gone", { kind: "gone" }, true],
    ["raw cancelled (the plugin reports destroyed)", record("cancelled"), false],
    ["stopped exactly fifteen minutes", record("stopped", "2026-11-13T10:45:00Z"), true],
    ["raw archived exactly fifteen minutes (the plugin reports stopped)", record("archived", "2026-11-13T10:45:00Z"), false],
    ["14m59.999s", record("stopped", "2026-11-13T10:45:00.001Z"), false],
    ["provider clock says fourteen minutes, caller says seventy-four", record("stopped", "2026-11-13T10:46:00Z"), false],
    ["future stoppedAt on provider clock", record("stopped", "2026-11-13T11:01:00Z"), false],
    ["missing stoppedAt", record("stopped"), false],
    ["reboot after start", record("running", null, "2026-11-13T10:00:00.001Z"), true],
    ["reboot equal start", record("running", null, start.at), false],
    ["reboot before start", record("running", null, "2026-11-13T09:59:59Z"), false],
    ["invalid reboot", record("running", null, "not-a-date"), false],
    ...["stopping", "resuming", "starting", "archiving", "unknown", "error", "STOPPED", "pre-stopped", "archived-extra"].map(state =>
      [state, record(state, "2026-11-13T10:00:00Z"), false]),
  ] as Array<[string, PredecessorSandboxRecord, boolean]>)("%s", async (_label, value, expected) => {
    expect(await evaluate(async () => value)).toBe(expected);
  });
  it("falls back to the caller clock only when provider observedAt is absent", async () => {
    expect(await evaluate(async () => ({ ...record("stopped", "2026-11-13T11:40:00Z"), observedAt: null }))).toBe(true);
  });
  it("running with no reboot retains the existing marker probe, on the predecessor's own box only", async () => {
    expect(await evaluate(async () => record("running"), "lost")).toBe(true);
    expect(await evaluate(async () => record("running"), "lost", "new-box")).toBe(false);
    expect(await evaluate(async () => record("running"), "lost", null)).toBe(false);
  });
});

describe("fail-closed ruling even when the CURRENT box has a copied old marker", () => {
  it.each([
    record("stopping", "2026-11-13T10:00:00Z"),
    record("resuming", "2026-11-13T10:00:00Z"),
    record("starting", "2026-11-13T10:00:00Z"),
    record("unknown", "2026-11-13T10:00:00Z"),
    record("stopped"),
    record("stopped", "2026-11-13T10:46:00Z"),
    record("stopped", "2026-11-13T11:01:00Z"),
  ])("does not upgrade %j to gone", async value => {
    expect(await evaluate(async () => value, "lost")).toBe(false);
  });
  it("a rejected provider read is NOT proven, rather than marker fallback", async () => {
    expect(await evaluate(async () => { throw new Error("provider unavailable"); }, "lost")).toBe(false);
  });
  it("a synchronously thrown provider read is NOT proven", async () => {
    expect(await evaluate(() => { throw new Error("provider throws synchronously"); }, "lost")).toBe(false);
  });
  it("a timed-out provider read is bounded and NOT proven", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let resolved = false;
    const result = evaluate(() => new Promise(() => {}), "lost").then(value => { resolved = true; return value; });
    await vi.advanceTimersByTimeAsync(PREDECESSOR_SANDBOX_READ_TIMEOUT_MS - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    expect(await result).toBe(false);
  });
});

describe("observation normalization", () => {
  it.each([undefined, {}, { providerLeaseId: "old-box" }, { providerLeaseId: "old-box", state: "unknown" },
    { providerLeaseId: "other-box", state: "destroyed" }])("missing fields or wrong identity never manufacture gone: %j", value => {
    expect(() => predecessorSandboxRecordFromObservation(value as never, "old-box")).toThrow();
  });
  it("an old stopped observation without optional fields has no provider-loss evidence", async () => {
    const mapped = predecessorSandboxRecordFromObservation({ providerLeaseId: "old-box", state: "stopped" }, "old-box");
    expect(await evaluate(async () => mapped)).toBe(false);
  });
  it("an explicit old destroyed observation is already sufficient, with no new fields", async () => {
    const mapped = predecessorSandboxRecordFromObservation({ providerLeaseId: "old-box", state: "destroyed" }, "old-box");
    expect(await evaluate(async () => mapped)).toBe(true);
  });
});
