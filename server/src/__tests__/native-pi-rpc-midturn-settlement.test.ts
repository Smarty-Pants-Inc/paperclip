import { expect, it } from "vitest";
import { isQuiescentRetainedPiSource } from "../services/native-runtime/native-retained-pi-source.js";

// Permanent clause tests for the judge's observed prepared/non-authoritative
// Stop state. A lifecycle-only relaxation must not make any of these pass.
function interruptedEvidence(): import("../services/native-runtime/native-retained-pi-source.js").RetainedPiSourceEvidence {
  const identity = { runId: "run", runnerInstanceId: "runner", environmentLeaseId: "lease", normalizedSessionId: "conversation", turnId: "turn", itemId: "item" };
  const records = new Map<string, string>();
  const command = (seq: number, type: string, payload: unknown, result: unknown) => records.set(`command:${seq}`, JSON.stringify({
    controllerSeq: seq, commandId: `c${seq}`, type, payload, status: "completed",
    result: { commandId: `c${seq}`, commandType: type, controllerSeq: seq, status: "completed", result } }));
  command(1, "turn.start", { turnId: "turn" }, { status: "accepted", providerTurnId: "pi-turn" });
  command(2, "turn.interrupt", { threadId: "pi-session", turnId: "pi-turn" }, { status: "interrupt_requested", providerTurnId: "pi-turn" });
  command(3, "turn.stop", {}, { status: "stopped", providerExitConfirmed: true, providerTurnId: "pi-turn" });
  command(4, "runner.drain", {}, { status: "completed", retainedEventsDrained: true });
  command(5, "runner.suspend", {}, { status: "completed" });
  const event = (seq: number, eventType: string, payload: unknown) => records.set(`event:${seq}`, JSON.stringify({ eventType,
    envelope: { ...identity, payload: { eventType, runId: identity.runId, normalizedSessionId: identity.normalizedSessionId,
      sourceInstanceId: identity.runnerInstanceId, payload } } }));
  event(1, "turn.accepted", { providerTurnId: "pi-turn" });
  event(2, "harness.diagnostic", { code: "provider_interrupt_requested", providerTurnId: "pi-turn", pendingCallIds: [] });
  return { owner: { phase: "terminal_failure", leaseOwner: null, resultId: null, recoveryState: null }, runStatus: "cancelled",
    identity, providerSessionId: "pi-session", terminationReceipt: true, leaseHandoff: true, processesAbsent: true,
    checkpointRecords: records,
    runnerState: { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null },
    providerState: { schema: "paperclip.runner.codex-provider-state.v1", config: { provider: "pi_rpc", driver: "pi_rpc" }, lifecycle: "prepared",
      completedTurnAuthoritative: false, completedProviderTurnId: null, completedTurnProcessGeneration: null, settledProviderTurnIds: ["pi-turn"],
      providerSessionId: "pi-session", threadId: "pi-session", activeProviderTurnId: null, startupAttempt: null, ambiguousTurnStartPending: false,
      pendingEvents: [], queuedEvents: [], toolBridge: { pending: {} } } };
}
type Evidence = ReturnType<typeof interruptedEvidence>;
const provider = (input: Evidence) => input.providerState as Record<string, unknown>;
const runner = (input: Evidence) => input.runnerState as Record<string, unknown>;
type JournalRecord = Record<string, unknown> & {
  payload: Record<string, unknown>;
  result: Record<string, unknown> & { result: Record<string, unknown> };
  envelope: Record<string, unknown> & { payload: Record<string, unknown> & { payload: Record<string, unknown> } };
};
function changeRecord(input: Evidence, key: string, change: (value: JournalRecord) => void) {
  const records = input.checkpointRecords as Map<string, string>, value = JSON.parse(records.get(key)!); change(value); records.set(key, JSON.stringify(value));
}
it("accepts the exact settled interrupt journal without manufacturing completion authority", () => {
  const input = interruptedEvidence(), before = JSON.stringify([...input.checkpointRecords!]);
  expect(isQuiescentRetainedPiSource(input)).toBe(true);
  expect(provider(input).completedTurnAuthoritative).toBe(false);
  expect(input.owner.resultId).toBeNull(); expect(JSON.stringify([...input.checkpointRecords!])).toBe(before);
});
function terminalConsumedEvidence(): Evidence {
  const input = interruptedEvidence(), records = input.checkpointRecords as Map<string, string>;
  records.delete("command:3"); provider(input).lifecycle = "session_open";
  const event = JSON.parse(records.get("event:1")!);
  event.eventType = event.envelope.payload.eventType = "turn.cancelled";
  event.envelope.payload.payload = { providerTurnId: "pi-turn", status: "cancelled" };
  records.set("event:3", JSON.stringify(event));
  return input;
}
it("accepts native cancellation already consumed before close, then measured suspension", () => {
  expect(isQuiescentRetainedPiSource(terminalConsumedEvidence())).toBe(true);
});
it.each(["native terminal absent", "native terminal names another turn", "pi_abort_escalated", "uncertain semantic side effect"])("consumed-terminal Stop refuses %s", name => {
  const input = terminalConsumedEvidence();
  if (name === "native terminal absent") (input.checkpointRecords as Map<string, string>).delete("event:3");
  if (name === "native terminal names another turn") changeRecord(input, "event:3", value => { value.envelope.payload.payload.providerTurnId = "other"; });
  if (name === "pi_abort_escalated") changeRecord(input, "event:3", value => { value.envelope.payload.payload.code = "pi_abort_escalated"; });
  if (name === "uncertain semantic side effect") provider(input).toolBridge = { pending: { write: {} } };
  expect(isQuiescentRetainedPiSource(input)).toBe(false);
});
const refusals: Array<[string, (input: Evidence) => void]> = [
  ["lifecycle alone (journal missing)", input => { delete input.checkpointRecords; }],
  ["missing accepted-turn record", input => { (input.checkpointRecords as Map<string, string>).delete("event:1"); }],
  ["missing interrupt diagnostic", input => { (input.checkpointRecords as Map<string, string>).delete("event:2"); }],
  ["pi_abort_escalated", input => { changeRecord(input, "event:1", value => { value.eventType = value.envelope.payload.eventType = "harness.diagnostic"; value.envelope.payload.payload = { code: "pi_abort_escalated" }; }); }],
  ["uncertain side effect at interrupt", input => { changeRecord(input, "event:2", value => { value.envelope.payload.payload.pendingCallIds = ["external-write"]; }); }],
  ["uncertain tool still pending", input => { provider(input).toolBridge = { pending: { external: {} } }; }],
  ["failed abort receipt", input => { changeRecord(input, "command:2", value => { value.result.status = "failed"; }); }],
  ["interrupt ack only, no settled provider turn", input => { provider(input).settledProviderTurnIds = []; }],
  ["interrupted other turn", input => { changeRecord(input, "command:2", value => { value.payload.turnId = "other"; }); }],
  ["interrupt result from other turn", input => { changeRecord(input, "command:2", value => { value.result.result.providerTurnId = "other"; }); }],
  ["interrupt from other session", input => { changeRecord(input, "command:2", value => { value.payload.threadId = "other"; }); }],
  ["unconfirmed physical stop", input => { changeRecord(input, "command:3", value => { value.result.result.providerExitConfirmed = false; }); }],
  ["wrong physical stop turn", input => { changeRecord(input, "command:3", value => { value.result.result.providerTurnId = "other"; }); }],
  ["null stop turn with no terminal frame", input => { changeRecord(input, "command:3", value => { value.result.result.providerTurnId = null; }); }],
  ["drain not complete", input => { changeRecord(input, "command:4", value => { value.result.result.retainedEventsDrained = false; }); }],
  ["suspend not complete", input => { changeRecord(input, "command:5", value => { value.status = "sent"; }); }],
  ["new start after stop", input => { changeRecord(input, "command:1", value => { value.controllerSeq = value.result.controllerSeq = 9; }); }],
  ["wrong command id", input => { changeRecord(input, "command:2", value => { value.result.commandId = "other"; }); }],
  ["wrong event run", input => { changeRecord(input, "event:2", value => { value.envelope.runId = "other"; }); }],
  ["wrong event provider instance", input => { changeRecord(input, "event:2", value => { value.envelope.payload.sourceInstanceId = "other"; }); }],
  ["running predecessor", input => { input.runStatus = "running"; }],
  ["failed but not operator-cancelled predecessor", input => { input.runStatus = "failed"; }],
  ["unfinished coordinator", input => { input.owner.phase = "observed"; }],
  ["held owner", input => { input.owner.leaseOwner = "owner"; }],
  ["business result present", input => { input.owner.resultId = "result"; }],
  ["recovery present", input => { input.owner.recoveryState = "resuming_session"; }],
  ["termination receipt missing", input => { input.terminationReceipt = false; }],
  ["handoff missing", input => { input.leaseHandoff = false; }],
  ["process proof missing", input => { input.processesAbsent = false; }],
  ["pending Runner cleanup", input => { runner(input).pendingProviderCleanup = {}; }],
  ["Runner not suspended", input => { runner(input).lifecycle = "ready"; }],
  ["Runner outbox", input => { runner(input).outbox = [{}]; }],
  ["pending terminal delivery", input => { runner(input).pendingTerminalDelivery = {}; }],
  ["active Pi turn", input => { provider(input).activeProviderTurnId = "pi-turn"; }],
  ["unread provider events", input => { provider(input).pendingEvents = [{}]; }],
  ["queued provider events", input => { provider(input).queuedEvents = [{}]; }],
  ["ambiguous start", input => { provider(input).ambiguousTurnStartPending = true; }],
  ["provider startup", input => { provider(input).startupAttempt = {}; }],
  ["receipt-limit cleanup pending", input => { provider(input).receiptLimitInterruptPending = true; }],
  ["non-Pi provider", input => { provider(input).config = { provider: "codex", driver: "codex_app_server" }; }],
];
it.each(refusals)("settled Stop refuses %s", (_name, mutate) => {
  const input = interruptedEvidence(); mutate(input); expect(isQuiescentRetainedPiSource(input)).toBe(false);
});
