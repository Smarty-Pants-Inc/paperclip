import { describe, expect, it } from "vitest";
import { parseQuarantinedCopyName, selectStopOnlyQuarantinedCopy, type StoppedRunFacts } from "./quarantined-stop-copies.js";

const key = "a".repeat(64), runId = "11111111-1111-4111-8111-111111111111";
const stopAt = Date.parse("2026-11-16T10:00:00.000Z");
const copy = parseQuarantinedCopyName(`${key}.identity_indeterminate.1763287200000.4242.22222222-2222-4222-8222-222222222222`);
const run: StoppedRunFacts = { id: runId, companyId: "c", agentId: "a", issueId: "i", stopAt, stateKey: key };
const at = (offsetMs: number) => new Date(stopAt + offsetMs).toISOString();
const journal = (...commands: Array<Record<string, unknown>>) => ({ identity: { runId }, commands: [
  { type: "turn.start", status: "completed", controllerSeq: 1 }, ...commands] });
const suspend = { type: "runner.suspend", status: "pending", issuedAt: at(1_000), commandId: "command_close_suspend_x" };
const UNSETTLED = "journal_commands_unsettled(runner.suspend.pending)";

describe("selectStopOnlyQuarantinedCopy (the one rule for dry-run and --apply)", () => {
  it("matches a copy whose only unsettled commands are the person's Stop's own lifecycle commands", () => {
    expect(selectStopOnlyQuarantinedCopy(copy, journal(suspend, { ...suspend, type: "runner.drain" }), UNSETTLED, run))
      .toEqual({ match: true, runId });
  });
  it.each([
    ["a suspend journaled before the Stop", journal({ ...suspend, issuedAt: at(-1_000) }), UNSETTLED, run, "unsettled_not_stop_issued"],
    ["a failed suspend", journal({ ...suspend, status: "failed" }), "journal_commands_unsettled(runner.suspend.failed)", run, "unsettled_not_stop_issued"],
    ["a non-lifecycle pending command beside the Stop's suspend", journal(suspend, { type: "run.attach", status: "pending", issuedAt: at(2_000) }),
      "journal_commands_unsettled(runner.suspend.pending,run.attach.pending)", run, "unsettled_not_stop_issued"],
    ["a foreign run (journal names another run)", { ...journal(suspend), identity: { runId: "33333333-3333-4333-8333-333333333333" } }, UNSETTLED, run, "run_missing"],
    ["a run the person did not Stop", journal(suspend), UNSETTLED, { ...run, stopAt: null }, "run_not_person_stopped"],
    ["another session's state key", journal(suspend), UNSETTLED, { ...run, stateKey: "b".repeat(64) }, "state_key_not_runs"],
    ["a settled copy", journal(), null, run, "copy_settled"],
    ["another refusal", journal(suspend), "runner_lifecycle_not_suspended", run, "copy_refusal_runner_lifecycle_not_suspended"],
  ] as const)("leaves %s untouched", (_label, copyJournal, refusal, facts, reason) => {
    expect(selectStopOnlyQuarantinedCopy(copy, copyJournal, refusal, facts)).toEqual({ match: false, reason });
  });
  it("leaves identity_mismatch copies and unrecognized names untouched", () => {
    expect(selectStopOnlyQuarantinedCopy(parseQuarantinedCopyName(`${key}.identity_mismatch.1.2.22222222-2222-4222-8222-222222222222`),
      journal(suspend), UNSETTLED, run)).toEqual({ match: false, reason: "copy_reason_identity_mismatch" });
    expect(selectStopOnlyQuarantinedCopy(parseQuarantinedCopyName("notes.txt"), journal(suspend), UNSETTLED, run))
      .toEqual({ match: false, reason: "copy_name_unrecognized" });
  });
});
