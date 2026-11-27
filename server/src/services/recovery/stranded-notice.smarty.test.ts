import { describe, expect, it } from "vitest";

import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";

describe("buildStrandedRecoveryEscalationNotice", () => {
  it.each(["runner.ingress.acquire", "runner.transport.connect"])("does not choose a saved-files notice for failed %s", failedStage => {
    const notice = buildStrandedRecoveryEscalationNotice({ recoveryActionId: "connection-failure", recoveryOwner: null,
      seed: { title: "Recovering saved work…", tone: "danger",
        body: "The task's saved files could not be put back after the run stopped. Press Retry to continue from the last saved version in a new workspace." },
      sourceRun: { id: "failed-run", status: "failed", errorCode: "native_session_interrupted", failedStage,
        errorSummary: "Boat returned an invalid private preview URL. https://private.example/secret" } });
    expect(notice.presentation.title).toBe("Couldn't connect to the agent's machine");
    expect(notice.body).toBe("No agent work started. Your message is saved.");
    expect(JSON.stringify(notice)).not.toMatch(/saved files|saved work|private\.example|Boat/i);
  });
});
