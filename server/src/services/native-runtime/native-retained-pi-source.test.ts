import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isQuiescentRetainedPiSource, READ_STOPPED_REMOTE_PI_SOURCE, type RetainedPiSourceEvidence } from "./native-retained-pi-source.js";

// Keep reason: trust boundary / recorded Goal5 RED. No individual missing
// retirement fact can be exercised cheaply by the real-runnerd happy path.
function evidence(): RetainedPiSourceEvidence {
  const identity = { runId: "old-run", runnerInstanceId: "old-runner", environmentLeaseId: "old-lease",
    normalizedSessionId: "conversation", turnId: "turn", itemId: "item" };
  return { owner: { phase: "terminal_failure", leaseOwner: null, resultId: null, recoveryState: null },
    runStatus: "cancelled", terminationReceipt: true, leaseHandoff: true, processesAbsent: true,
    identity, providerSessionId: "native-pi-id",
    runnerState: { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended", outbox: [],
      pendingTerminalDelivery: null, pendingProviderCleanup: null },
    providerState: { schema: "paperclip.runner.codex-provider-state.v1", config: { provider: "pi_rpc", driver: "pi_rpc" },
      lifecycle: "session_open", completedTurnAuthoritative: true, providerSessionId: "native-pi-id", threadId: "native-pi-id",
      activeProviderTurnId: null, startupAttempt: null, ambiguousTurnStartPending: false,
      pendingEvents: [], queuedEvents: [], toolBridge: { pending: {} } } };
}
const state = (value: unknown) => value as Record<string, unknown>;

describe("failed retained Pi source admission", () => {
  it("admits only the stopped authoritative checkpoint, without changing the failed result", () => {
    const input = evidence(), before = JSON.stringify(input);
    expect(isQuiescentRetainedPiSource(input)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.owner.resultId).toBeNull();
  });

  const variants: Array<[string, (input: RetainedPiSourceEvidence) => void]> = [
    ["nonterminal coordinator", input => { input.owner.phase = "observed"; }],
    ["held owner lease", input => { input.owner.leaseOwner = "writer"; }],
    ["unexpected result", input => { input.owner.resultId = "result"; }],
    ["pending recovery", input => { input.owner.recoveryState = "resuming_session"; }],
    ["running predecessor", input => { input.runStatus = "running"; }],
    ["missing provider termination", input => { input.terminationReceipt = false; }],
    ["missing lease handoff", input => { input.leaseHandoff = false; }],
    ["unproven process births", input => { input.processesAbsent = false; }],
    ["missing Runner state", input => { input.runnerState = null; }],
    ["wrong Runner schema", input => { state(input.runnerState).schema = "unknown"; }],
    ["unsuspended Runner", input => { state(input.runnerState).lifecycle = "ready"; }],
    ["unsent outbox", input => { state(input.runnerState).outbox = [{ sourceSeq: 1 }]; }],
    ["missing outbox", input => { delete state(input.runnerState).outbox; }],
    ["pending terminal delivery", input => { state(input.runnerState).pendingTerminalDelivery = {}; }],
    ["missing terminal delivery measurement", input => { delete state(input.runnerState).pendingTerminalDelivery; }],
    ["pending provider cleanup", input => { state(input.runnerState).pendingProviderCleanup = {}; }],
    ["warm transition", input => { state(input.runnerState).warmTransition = {}; }],
    ["recoverable Runner failure", input => { state(input.runnerState).recoverableFailure = {}; }],
    ["missing provider state", input => { input.providerState = null; }],
    ["wrong provider schema", input => { state(input.providerState).schema = "unknown"; }],
    ["non-Pi provider", input => { state(input.providerState).config = { provider: "codex", driver: "codex_app_server" }; }],
    ["active provider lifecycle", input => { state(input.providerState).lifecycle = "turn_active"; }],
    ["non-authoritative completed turn", input => { state(input.providerState).completedTurnAuthoritative = false; }],
    ["missing completed-turn authority", input => { delete state(input.providerState).completedTurnAuthoritative; }],
    ["active provider turn", input => { state(input.providerState).activeProviderTurnId = "turn"; }],
    ["missing active-turn measurement", input => { delete state(input.providerState).activeProviderTurnId; }],
    ["provider startup", input => { state(input.providerState).startupAttempt = {}; }],
    ["ambiguous turn start", input => { state(input.providerState).ambiguousTurnStartPending = true; }],
    ["pending receipt-limit interrupt", input => { state(input.providerState).receiptLimitInterruptPending = true; }],
    ["pending provider events", input => { state(input.providerState).pendingEvents = [{}]; }],
    ["queued provider events", input => { state(input.providerState).queuedEvents = [{}]; }],
    ["missing pending events", input => { delete state(input.providerState).pendingEvents; }],
    ["missing queued events", input => { delete state(input.providerState).queuedEvents; }],
    ["pending semantic tool", input => { state(input.providerState).toolBridge = { pending: { call: {} } }; }],
    ["missing semantic inventory", input => { delete state(input.providerState).toolBridge; }],
    ["changed native provider ID", input => { state(input.providerState).providerSessionId = "other"; }],
    ["changed native thread ID", input => { state(input.providerState).threadId = "other"; }],
    ["missing native ID", input => { input.providerSessionId = ""; }],
    ...["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"].map(key =>
      [`changed ${key}`, (input: RetainedPiSourceEvidence) => { state(input.runnerState)[key] = "other"; }] as [string, (input: RetainedPiSourceEvidence) => void]),
  ];
  it.each(variants)("refuses %s", (_name, mutate) => {
    const input = evidence(); mutate(input);
    expect(isQuiescentRetainedPiSource(input)).toBe(false);
  });
});

// Actual /proc + file contract check, not a mocked process-absence boolean.
it.skipIf(process.platform !== "linux")("requires a retired lineage and exact dead Runner birth without signalling or consuming evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "retained-pi-source-"));
  try {
    const child = JSON.parse(execFileSync(process.execPath, ["-e", String.raw`
      const fs = require("node:fs");
      const fields = fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(/\s+/);
      console.log(JSON.stringify({ pid: process.pid, started: Number(fields[19]), boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() }));
    `], { encoding: "utf8" }));
    const lineage = join(root, "process-lineage"); mkdirSync(lineage);
    const marker = join(root, "runner-process.identity"), writer = join(lineage, `writer-${child.pid}.json`);
    const markerBytes = `nonce\n${child.pid}\n${new Date().toISOString()}\nold-runner\nlinux:${child.boot}:${child.started}\n`;
    writeFileSync(marker, markerBytes);
    writeFileSync(writer, JSON.stringify({ schema: "paperclip.runner.process-lineage-writer.v1", writer: { pid: child.pid, started: child.started } }));
    writeFileSync(join(root, "runner-state.json"), JSON.stringify(evidence().runnerState));
    writeFileSync(join(root, "codex-provider-state.json"), JSON.stringify(evidence().providerState));
    const probe = (runnerId = "old-runner") => execFileSync(process.execPath, ["-e", READ_STOPPED_REMOTE_PI_SOURCE, root, runnerId], { encoding: "utf8" });
    expect(JSON.parse(probe()).processesAbsent).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe(markerBytes);
    expect(readFileSync(writer, "utf8")).toContain("process-lineage-writer");
    expect(() => probe("wrong-runner")).toThrow();
    const journal = join(lineage, `lineage-${child.pid}-0.json`); writeFileSync(journal, "{}");
    expect(() => probe()).toThrow(); rmSync(journal);
    writeFileSync(writer, JSON.stringify({ schema: "paperclip.runner.process-lineage-writer.v1", writer: { pid: child.pid, started: child.started + 1 } }));
    expect(() => probe()).toThrow();
    rmSync(writer); expect(() => probe()).toThrow();
    // A live process may not pass even when the journal directory is empty.
    const self = readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(/\s+/);
    writeFileSync(marker, `nonce\n${process.pid}\n${new Date().toISOString()}\nold-runner\nlinux:${child.boot}:${self[19]}\n`);
    writeFileSync(join(lineage, `writer-${process.pid}.json`), JSON.stringify({ schema: "paperclip.runner.process-lineage-writer.v1", writer: { pid: process.pid, started: Number(self[19]) } }));
    expect(() => probe()).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
