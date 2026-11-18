import { describe, expect, it } from "vitest";
import { projectExecution } from "./execution-projection.js";
import { NATIVE_CLEANUP_HOLD_CAUSE, NATIVE_CLEANUP_HOLD_NEXT_ACTION } from "./native-runtime/native-cleanup-admission-hold.js";
import { NATIVE_CLEANUP_SETTLING_MESSAGE } from "./native-runtime/completed-turn-cleanup.js";

// RFL C4/F2: the #20806 cleanup hold and upstream #21447 routine hold must
// compose without publishing two competing explanations for one queued turn.
// Keep reason: this is the exact integration/signature conflict named by the
// port judgement, not a generic mock-call-count or source-text assertion.
describe("port: cleanup and routine admission hold precedence", () => {
  const now = new Date("2026-11-16T08:50:00Z");
  const queued = {
    id: "queued-turn", status: "queued", runtimeMode: "native", errorCode: null,
    nextAction: null, lastUsefulActionAt: now, lastOutputAt: null, startedAt: null,
    scheduledRetryAt: null, scheduledRetryAttempt: 1, retryOfRunId: null,
    executionControlDeadlineAt: null,
  } as Parameters<typeof projectExecution>[0];
  const project = (cleanup: boolean) => projectExecution(
    queued, undefined, [], undefined, now, undefined, false, undefined, false,
    undefined, "ROUTINE-123", cleanup,
  );

  it("names exactly the cleanup hold while both cleanup and a routine hold the queued run", () => {
    const projection = project(true);
    expect(projection).toMatchObject({
      phase: "queued", cause: NATIVE_CLEANUP_HOLD_CAUSE,
      label: NATIVE_CLEANUP_SETTLING_MESSAGE, nextAction: NATIVE_CLEANUP_HOLD_NEXT_ACTION,
    });
    expect(projection.agentQueue).toBeUndefined();
    expect(`${projection.label} ${projection.nextAction}`).not.toContain("ROUTINE-123");
    expect(`${projection.label} ${projection.nextAction}`).not.toContain("This routine runs one task at a time");
  });

  it("names exactly the remaining routine hold after cleanup settles", () => {
    const projection = project(false);
    expect(projection).toMatchObject({
      phase: "queued", cause: "routine_execution_in_progress", label: "Waiting for ROUTINE-123 to finish",
    });
    expect(projection.nextAction).toContain("This routine runs one task at a time");
    expect(projection.agentQueue).toBeUndefined();
    expect(`${projection.label} ${projection.nextAction}`).not.toContain(NATIVE_CLEANUP_SETTLING_MESSAGE);
  });
});
