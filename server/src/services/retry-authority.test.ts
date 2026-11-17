import { describe, expect, it } from "vitest";
import { decideRetryAuthority, heldRetryOffersRetry, type RetryAuthorityFacts } from "./task-retry-eligibility.js";
import {
  AGENT_PAUSED_RETRY_MESSAGE, AUTOMATIC_RECOVERY_MESSAGE, HELD_PREDECESSOR_NOTICE, HELD_RECOVERED_WORK_MESSAGE,
  NO_SAVED_WORK_NEW_TASK_MESSAGE, NO_SAVED_WORK_RETRY_MESSAGE, RECOVERED_WORK_CONTINUE_MESSAGE, RECOVERED_WORK_MESSAGE,
  RECOVERED_WORK_RETRY_MESSAGE, RETRY_STOP_UNPROVEN_MESSAGE, RETRY_STOP_WAIT_MESSAGE, STOPPED_TASK_NEW_TASK_MESSAGE,
  STOPPED_TASK_RETRY_MESSAGE,
} from "./native-runtime/held-predecessor-notice-text.js";

// Retry fold: the STATE TABLE of the one authority. Each row is a judge-bar
// state; the decision gives canRetry, the card text, the transcript note, the
// structured next action and the user action TOGETHER (R15: card = transcript).
const rows: Array<{ row: string; facts: RetryAuthorityFacts; canRetry: boolean; userAction: string; text: string | null }> = [
  { row: "R1 A manager Stop, Retry accepted", facts: { stopKind: "manager", retrySource: true }, canRetry: true, userAction: "retry", text: STOPPED_TASK_RETRY_MESSAGE },
  { row: "R1/R10 F1 manager Stop, Retry source refused", facts: { stopKind: "manager", retrySource: false }, canRetry: false, userAction: "new_task", text: STOPPED_TASK_NEW_TASK_MESSAGE },
  { row: "R2 C own Stop unproven, waiting", facts: { stopGate: "waiting", retrySource: true }, canRetry: false, userAction: "wait", text: RETRY_STOP_WAIT_MESSAGE },
  { row: "R2 C own Stop unproven past the bound", facts: { stopGate: "expired", retrySource: true }, canRetry: false, userAction: "new_task", text: RETRY_STOP_UNPROVEN_MESSAGE },
  { row: "R3 E-C01 fence-refused", facts: { heldConversation: true, retrySource: true }, canRetry: false, userAction: "new_task", text: HELD_PREDECESSOR_NOTICE },
  { row: "R4/R11 D row-D", facts: { heldConversation: true, heldRefusal: "prior_owner_scope_mismatch", savedWork: "recovered", retrySource: true, runStatus: "failed" }, canRetry: false, userAction: "new_task", text: HELD_RECOVERED_WORK_MESSAGE },
  { row: "R4 D refusal alone", facts: { heldRefusal: "prior_owner_scope_mismatch", retrySource: true }, canRetry: false, userAction: "new_task", text: HELD_PREDECESSOR_NOTICE },
  { row: "R5 M person's settled Stop", facts: { savedWork: "recovered", runStatus: "cancelled", retrySource: false }, canRetry: false, userAction: "message", text: RECOVERED_WORK_CONTINUE_MESSAGE },
  { row: "R6 G agent paused", facts: { agentPaused: true, savedWork: "recovered", runStatus: "failed", retrySource: true }, canRetry: false, userAction: "resume", text: AGENT_PAUSED_RETRY_MESSAGE },
  { row: "R7 M1 dead end", facts: { heldConversation: true, savedWork: "recovered", runStatus: "failed", retrySource: true }, canRetry: false, userAction: "new_task", text: HELD_RECOVERED_WORK_MESSAGE },
  { row: "R9 automatic recovery pending", facts: { automaticRecovery: true, heldConversation: true, retrySource: true }, canRetry: false, userAction: "wait", text: AUTOMATIC_RECOVERY_MESSAGE },
  { row: "recovered failure, Retry accepted", facts: { savedWork: "recovered", runStatus: "failed", retrySource: true }, canRetry: true, userAction: "retry", text: RECOVERED_WORK_RETRY_MESSAGE },
  { row: "recovered failure, Retry unavailable", facts: { savedWork: "recovered", runStatus: "failed", retrySource: false }, canRetry: false, userAction: "message", text: RECOVERED_WORK_MESSAGE },
  { row: "no work saved, Retry accepted", facts: { stoppedBeforeWork: true, savedWork: "recovered", retrySource: true }, canRetry: true, userAction: "retry", text: NO_SAVED_WORK_RETRY_MESSAGE },
  { row: "no work saved, held", facts: { stoppedBeforeWork: true, savedWork: "recovered", heldConversation: true, retrySource: true }, canRetry: false, userAction: "new_task", text: NO_SAVED_WORK_NEW_TASK_MESSAGE },
];

describe("retry fold: one authority state table", () => {
  it.each(rows)("$row", ({ facts, canRetry, userAction, text }) => {
    const decision = decideRetryAuthority(facts);
    expect(decision).toMatchObject({ canRetry, userAction, cardText: text });
    // R15: the card and the transcript note carry the SAME instruction, exactly.
    expect(decision.transcriptNotice).toBe(decision.cardText);
    // The structured next action is the card's own instruction (or none, when the card names no action).
    if (decision.nextAction) expect(decision.cardText).toContain(decision.nextAction);
    // Retry is offered exactly where the user action is Retry.
    expect(decision.canRetry).toBe(decision.userAction === "retry");
    if (!decision.canRetry) expect(decision.cardText ?? "").not.toMatch(/Press Retry|Retry continues/);
  });

  it("R9: during automatic recovery the one instruction never says to send a new message or offers Retry", () => {
    const decision = decideRetryAuthority({ automaticRecovery: true, heldConversation: true, retrySource: true });
    expect(decision.cardText).not.toMatch(/send a new message/i);
    expect(decision.canRetry).toBe(false);
  });

  it("R11 F2: a prior-owner fence refusal is a refusal a click cannot change", () => {
    for (const reason of ["prior_owner_scope_mismatch", "prior_owner_terminal_state_indeterminate"])
      expect(heldRetryOffersRetry(reason)).toBe(false);
  });

  it("R6 G: paused wins over every Retry fact", () => {
    for (const facts of rows.map(row => row.facts))
      expect(decideRetryAuthority({ ...facts, agentPaused: true, automaticRecovery: false })).toMatchObject({ userAction: "resume", canRetry: false });
  });
});
