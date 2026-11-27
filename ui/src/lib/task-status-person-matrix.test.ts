import type { IssueBlockerAttention } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { resolveTaskStatusPresentation, type TaskStatusPresentationInput } from "./task-status-presentation";

// A1–A20: pure resolver acceptance matrix; compact responses must not invent a person.
const attention = (state: IssueBlockerAttention["state"]): IssueBlockerAttention => ({
  state, reason: state === "covered" ? "active_child" : "attention_required",
  unresolvedBlockerCount: 1, coveredBlockerCount: state === "covered" ? 1 : 0,
  stalledBlockerCount: 0, attentionBlockerCount: 0,
  sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null,
});
const person = { owner: { userId: "person-1" }, action: "Read the text" };
const question: NonNullable<TaskStatusPresentationInput["interruption"]> = {
  state: "waiting_for_user", responsibility: "user", userAction: "question",
  intentId: null, nextRetryAt: null, canRetry: false, sourceRunIds: [], observedRunId: null,
};
const rows: [string, TaskStatusPresentationInput, string, string][] = [
  ["A1 backlog", { status: "backlog" }, "backlog", "Backlog"],
  ["A2 todo", { status: "todo" }, "todo", "Todo"],
  ["A3 missing attention", { status: "blocked" }, "in_queue", "Blocked · waiting"],
  ["A4 none", { status: "blocked", blockerAttention: attention("none") }, "in_queue", "Blocked · waiting on 1 task"],
  ["A5 covered", { status: "blocked", blockerAttention: attention("covered") }, "in_queue", "Blocked · waiting on sub-tasks"],
  ["A6 stalled", { status: "blocked", blockerAttention: attention("stalled") }, "in_queue", "Blocked · waiting on 1 task"],
  ["A7 needs attention", { status: "blocked", blockerAttention: attention("needs_attention") }, "in_queue", "Blocked · waiting on 1 task"],
  ["A8 board", { status: "blocked", unblockDescriptor: { owner: "board", action: "Read traces" } }, "in_queue", "Blocked · waiting"],
  ["A9 agent", { status: "blocked", unblockDescriptor: { owner: { agentId: "agent-1" }, action: "Read traces" } }, "in_queue", "Blocked · waiting"],
  ["A10 person", { status: "blocked", unblockDescriptor: person }, "blocked", "Person: Read the text"],
  ["A11 person beats coverage", { status: "blocked", unblockDescriptor: person, blockerAttention: attention("covered") }, "blocked", "Person: Read the text"],
  ["A12 own question", { status: "blocked", interruption: question }, "blocked", "Person: Answer question"],
  ["A12 own approval", { status: "blocked", interruption: { ...question, userAction: "approval" } }, "blocked", "Person: Decide approval"],
  ["A13 authority", { status: "blocked", actionRequired: { action: "Approve" } }, "blocked", "Person: Approve"],
  ["A14 authority clear", { status: "blocked", actionRequired: null, unblockDescriptor: person, interruption: question }, "in_queue", "Blocked · waiting"],
  ["A15 recovery wait", { status: "in_progress", displayStatus: "blocked", unblockDescriptor: null }, "in_queue", "Blocked · waiting"],
  ["A16 monitoring", { status: "in_progress", displayStatus: "monitoring" }, "monitoring", "Monitoring"],
  ["A17 idle", { status: "in_review", externalConversationState: "waiting" }, "idle", "Idle"],
  ["A18 terminal", { status: "done", displayStatus: "blocked", unblockDescriptor: person }, "done", "Done"],
  ["A19 cancelled", { status: "cancelled", unblockDescriptor: person }, "cancelled", "Cancelled"],
  ["A20 own question without attention", { id: "task-1", status: "blocked", blockerAttention: undefined, interruption: question }, "blocked", "Person: Answer question"],
];

describe("person-only red acceptance", () => {
  it.each(rows)("%s", (_name, input, glyphStatus, label) => {
    expect(resolveTaskStatusPresentation(input)).toEqual({ glyphStatus, label, ariaLabel: label });
  });
});
