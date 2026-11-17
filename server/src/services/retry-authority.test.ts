import { describe, expect, it } from "vitest";
import { decideRetryAuthority, heldRetryOffersRetry, type RetryAuthorityFacts } from "./task-retry-eligibility.js";
import {
  AGENT_PAUSED_RETRY_MESSAGE, AUTOMATIC_RECOVERY_MESSAGE, HELD_PREDECESSOR_NOTICE, HELD_RECOVERED_WORK_MESSAGE,
  NO_SAVED_WORK_NEW_TASK_MESSAGE, NO_SAVED_WORK_RETRY_MESSAGE, RECOVERED_WORK_CONTINUE_MESSAGE, RECOVERED_WORK_MESSAGE,
  RECOVERED_WORK_RETRY_MESSAGE, RETRY_STOP_UNPROVEN_MESSAGE, RETRY_STOP_WAIT_MESSAGE, STOPPED_TASK_NEW_TASK_MESSAGE,
  STOPPED_TASK_RETRY_MESSAGE,
} from "./native-runtime/held-predecessor-notice-text.js";
import { RECOVERING_SAVED_WORK_NEXT_ACTION, WORKSPACE_RESTORE_PENDING_KEY, workspaceRestoreHoldNextAction } from "./legacy-execution-recovery.js";
import { withoutUnavailableRetry } from "./execution-blocker.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

// Retry fold: the STATE TABLE of the one authority. Each row is a judge-bar
// state; the decision gives canRetry, the card text, the transcript note, the
// structured next action and the user action TOGETHER (R15: card = transcript).
const rows: Array<{ row: string; facts: RetryAuthorityFacts; canRetry: boolean; userAction: string; text: string | null;
  admission?: "held" }> = [
  { row: "R1 A manager Stop, Retry accepted", facts: { stopKind: "manager", retrySource: true }, canRetry: true, userAction: "retry", text: STOPPED_TASK_RETRY_MESSAGE },
  { row: "R1/R10 F1 manager Stop, Retry source refused", facts: { stopKind: "manager", retrySource: false }, canRetry: false, userAction: "new_task", text: STOPPED_TASK_NEW_TASK_MESSAGE },
  { row: "R2 C own Stop unproven, waiting", facts: { stopGate: "waiting", retrySource: true }, canRetry: false, userAction: "wait", text: RETRY_STOP_WAIT_MESSAGE },
  { row: "R2 C own Stop unproven past the bound", facts: { stopGate: "expired", retrySource: true }, canRetry: false, userAction: "new_task", text: RETRY_STOP_UNPROVEN_MESSAGE },
  // SUPERSEDE (rf-3 STOP 2, RFL ruling 14:12Z; follow-Paperclip Cut B R8): a held
  // notice never withholds Retry; Retry rotates onto a fresh thread with history.
  { row: "supersedes: R3 E-C01 fence-refused", facts: { heldConversation: true, retrySource: true }, canRetry: true, userAction: "retry", text: HELD_PREDECESSOR_NOTICE },
  { row: "supersedes: R4/R11 D row-D", facts: { heldConversation: true, heldRefusal: "prior_owner_scope_mismatch", savedWork: "recovered", retrySource: true, runStatus: "failed" }, canRetry: true, userAction: "retry", text: HELD_RECOVERED_WORK_MESSAGE },
  { row: "supersedes: R4 D refusal alone", facts: { heldRefusal: "prior_owner_scope_mismatch", retrySource: true }, canRetry: true, userAction: "retry", text: HELD_PREDECESSOR_NOTICE },
  { row: "R5 M person's settled Stop", facts: { savedWork: "recovered", runStatus: "cancelled", retrySource: false }, canRetry: false, userAction: "message", text: RECOVERED_WORK_CONTINUE_MESSAGE },
  { row: "R6 G agent paused", facts: { agentPaused: true, savedWork: "recovered", runStatus: "failed", retrySource: true }, canRetry: false, userAction: "resume", text: AGENT_PAUSED_RETRY_MESSAGE },
  { row: "supersedes: R7 M1 dead end", facts: { heldConversation: true, savedWork: "recovered", runStatus: "failed", retrySource: true }, canRetry: true, userAction: "retry", text: HELD_RECOVERED_WORK_MESSAGE },
  { row: "R9 automatic recovery pending", facts: { automaticRecovery: true, heldConversation: true, retrySource: true }, canRetry: false, userAction: "wait", text: AUTOMATIC_RECOVERY_MESSAGE },
  { row: "recovered failure, Retry accepted", facts: { savedWork: "recovered", runStatus: "failed", retrySource: true }, canRetry: true, userAction: "retry", text: RECOVERED_WORK_RETRY_MESSAGE },
  { row: "recovered failure, Retry unavailable", facts: { savedWork: "recovered", runStatus: "failed", retrySource: false }, canRetry: false, userAction: "message", text: RECOVERED_WORK_MESSAGE },
  { row: "no work saved, Retry accepted", facts: { stoppedBeforeWork: true, savedWork: "recovered", retrySource: true }, canRetry: true, userAction: "retry", text: NO_SAVED_WORK_RETRY_MESSAGE },
  { row: "supersedes: no work saved, held", facts: { stoppedBeforeWork: true, savedWork: "recovered", heldConversation: true, retrySource: true }, canRetry: true, userAction: "retry", text: NO_SAVED_WORK_RETRY_MESSAGE },
  { row: "no work saved, held, Retry source refused", facts: { stoppedBeforeWork: true, heldConversation: true, retrySource: false }, canRetry: false, userAction: "new_task", text: NO_SAVED_WORK_NEW_TASK_MESSAGE },
  // RESTORE HOLD: the words are legacy-execution-recovery.ts's (restore-card), delegated, not mapped here.
  // fam-retry2 (upstream wins): accepted and HELD, in the hold's words.
  { row: "restore hold, files owed", facts: { restoreHold: { [WORKSPACE_RESTORE_PENDING_KEY]: true }, retrySource: true }, canRetry: true, userAction: "wait", text: RECOVERING_SAVED_WORK_NEXT_ACTION, admission: "held" },
  { row: "restore hold, Paperclip's workspace recovery owns the files", facts: { restoreHold: { workspaceRestoreFailure: "restore_failed",
    workspaceRestoreRecovery: { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA } }, retrySource: true }, canRetry: true, userAction: "wait",
    text: workspaceRestoreHoldNextAction({ workspaceRestoreFailure: "restore_failed" }), admission: "held" },
  { row: "restore hold, restore failed", facts: { restoreHold: { workspaceRestoreFailure: "restore_failed" }, retrySource: true }, canRetry: false, userAction: "new_task",
    text: withoutUnavailableRetry(workspaceRestoreHoldNextAction({ workspaceRestoreFailure: "restore_failed" }), false) },
];

describe("retry fold: one authority state table", () => {
  it.each(rows)("$row", ({ facts, canRetry, userAction, text, admission }) => {
    const decision = decideRetryAuthority(facts);
    expect(decision).toMatchObject({ canRetry, userAction, cardText: text });
    expect(decision.admission).toBe(admission);
    // R15: the card and the transcript note carry the SAME instruction, exactly.
    expect(decision.transcriptNotice).toBe(decision.cardText);
    // The structured next action is the card's own instruction (or none, when the card names no action).
    if (decision.nextAction) expect(decision.cardText).toContain(decision.nextAction);
    // Retry is offered exactly where the user action is Retry.
    expect(decision.canRetry).toBe(decision.userAction === "retry" || decision.admission === "held");
    if (!decision.canRetry) expect(decision.cardText ?? "").not.toMatch(/Press Retry|Retry continues/);
  });

  it("R9: during automatic recovery the one instruction never says to send a new message or offers Retry", () => {
    const decision = decideRetryAuthority({ automaticRecovery: true, heldConversation: true, retrySource: true });
    expect(decision.cardText).not.toMatch(/send a new message/i);
    expect(decision.canRetry).toBe(false);
  });

  // SUPERSEDE (rf-3 STOP 2, RFL ruling 14:12Z): PV2's heldRetryOffersRetry has no
  // fence reasons; a held Retry rotates onto a fresh thread with history.
  it("supersedes: R11 F2: a prior-owner fence refusal is a refusal a click cannot change", () => {
    for (const reason of ["prior_owner_scope_mismatch", "prior_owner_terminal_state_indeterminate"])
      expect(heldRetryOffersRetry(reason)).toBe(true);
  });

  it("rf-3 STOP 2: a held notice beside an offered Retry names Retry, never a new message or a new task", () => {
    for (const text of [HELD_PREDECESSOR_NOTICE, HELD_RECOVERED_WORK_MESSAGE]) {
      expect(text).toContain("Press Retry");
      expect(text).not.toMatch(/send a new message|new task|cannot continue/i);
    }
  });

  it("R6 G: paused wins over every Retry fact", () => {
    for (const facts of rows.map(row => row.facts))
      expect(decideRetryAuthority({ ...facts, agentPaused: true, automaticRecovery: false })).toMatchObject({ userAction: "resume", canRetry: false });
  });
});
