import { describe, expect, it } from "vitest";
import { projectExecution } from "./execution-projection.js";

// Keep the upstream routine-admission projection; our cleanup presentation is gone.
describe("port: routine admission hold", () => {
  const now = new Date("2026-11-16T08:50:00Z");
  const queued = {
    id: "queued-turn", status: "queued", runtimeMode: "native", errorCode: null,
    nextAction: null, lastUsefulActionAt: now, lastOutputAt: null, startedAt: null,
    scheduledRetryAt: null, scheduledRetryAttempt: 1, retryOfRunId: null,
    executionControlDeadlineAt: null,
  } as Parameters<typeof projectExecution>[0];

  it("names exactly the remaining routine hold after cleanup settles", () => {
    const projection = projectExecution(
      queued, undefined, [], undefined, now, undefined, false, undefined, false,
      undefined, "ROUTINE-123",
    );
    expect(projection).toMatchObject({
      phase: "queued", cause: "routine_execution_in_progress", label: "Waiting for ROUTINE-123 to finish",
    });
    expect(projection.nextAction).toContain("This routine runs one task at a time");
    expect(projection.agentQueue).toBeUndefined();
  });
});
