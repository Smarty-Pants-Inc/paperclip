import { expect, it } from "vitest";
import {
  hasAcknowledgedNativeStopIntent, hasRecordedUserStopRequest, isAcknowledgedNativeReassignmentStop, isAcknowledgedNativeStop,
} from "./acknowledged-native-stop.js";

// A managing agent's authorized Stop (POST /heartbeat-runs/:runId/cancel by an
// agent with lifecycle authority over the target) is an intentional Stop, the
// same as a person's Stop button. Its durable record keeps the agent as the
// initiator; no board user is invented. Only the authority fence writes the
// management record, and only the exact bound native ACK proves the Stop.
const ack = {
  schema: "paperclip.native-cancellation.v1", runId: "run", companyId: "company", issueId: "issue",
  scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
  intentAuditId: "intent", acknowledgementAuditId: "ack",
};
const managementStop = {
  schema: "paperclip.management-stop.v1", companyId: "company", runId: "run",
  targetAgentId: "worker", actorAgentId: "lead", authorizedAt: "2026-11-17T00:31:43.000Z",
};
const managed = { id: "run", companyId: "company", agentId: "worker", nativeIssueId: "issue", status: "cancelled", resultJson: {
  cancelledByActorType: "agent", cancelledByAgentId: "lead", managementStop,
  cancellation: { source: "control_plane", expected: true, initiator: { type: "agent", id: "lead" },
    reason: "Cancelled by a managing agent", recordedAt: "2026-11-17T00:31:43.000Z" },
  startupCancellation: { requestedAt: "2026-11-17T00:31:43.000Z", errorCode: "operator_interrupted" },
  nativeCancellation: ack,
} as Record<string, unknown> };

it("recognizes an authorized managing-agent Stop with its exact bound native ACK as an intentional Stop", () => {
  expect(hasAcknowledgedNativeStopIntent({ ...managed, status: "running" })).toBe(true);
  expect(isAcknowledgedNativeStop(managed)).toBe(true);
});

it("keeps the managing agent as the initiator and does not make it a user Stop", () => {
  expect(managed.resultJson).not.toHaveProperty("cancelledByUserId");
  expect(hasRecordedUserStopRequest(managed)).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop(managed)).toBe(false);
});

it.each([
  ["missing ACK", { nativeCancellation: undefined }],
  ["pending ACK", { nativeCancellation: { ...ack, dispatchState: "pending" } }],
  ["undispatched ACK", { nativeCancellation: { ...ack, dispatched: false } }],
  ["ACK bound to another run", { nativeCancellation: { ...ack, runId: "other" } }],
  ["ACK bound to another issue", { nativeCancellation: { ...ack, issueId: "other" } }],
  ["ACK bound to another company", { nativeCancellation: { ...ack, companyId: "other" } }],
  ["ACK without its audit", { nativeCancellation: { ...ack, acknowledgementAuditId: undefined } }],
  ["no authority record (agent attribution alone)", { managementStop: undefined }],
  ["authority record for another run", { managementStop: { ...managementStop, runId: "other" } }],
  ["authority record for another company", { managementStop: { ...managementStop, companyId: "other" } }],
  ["authority record for another target agent", { managementStop: { ...managementStop, targetAgentId: "other" } }],
  ["authority record for another actor", { managementStop: { ...managementStop, actorAgentId: "other" } }],
  ["unknown authority schema", { managementStop: { ...managementStop, schema: "other" } }],
  ["initiator is not the authorized agent", { cancellation: { ...(managed.resultJson.cancellation as object), initiator: { type: "agent", id: "other" } } }],
  ["initiator is the system", { cancellation: { ...(managed.resultJson.cancellation as object), initiator: { type: "system" } } }],
  ["attributed to a user instead", { cancelledByActorType: "user" }],
])("does not accept a managing-agent Stop with %s", (_label, change) => {
  const run = { ...managed, resultJson: { ...managed.resultJson, ...change } };
  expect(hasAcknowledgedNativeStopIntent(run)).toBe(false);
  expect(isAcknowledgedNativeStop(run)).toBe(false);
});

it("does not treat a bare turn.cancelled/ACK as an intentional Stop without an identified initiator", () => {
  expect(isAcknowledgedNativeStop({ ...managed, resultJson: { nativeCancellation: ack } })).toBe(false);
});
