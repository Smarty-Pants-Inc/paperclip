import { expect, it } from "vitest";
import { workspaceRestoreMarkerDetail } from "./workspace-restore-marker";

it("makes saved-plan claims only with durable evidence", () => {
  expect(workspaceRestoreMarkerDetail({ result: {}, savedPlan: true, hasResponse: true })).toContain("after the plan was saved");
  expect(workspaceRestoreMarkerDetail({ result: {}, savedPlan: false, hasResponse: false })).toBe("Workspace restore failed. Workspace files need recovery.");
});

it("separates explicit missing-response evidence from the restore failure", () => {
  expect(workspaceRestoreMarkerDetail({ result: { finalResponseRecorded: false }, savedPlan: false, hasResponse: false })).toContain("No final response was recorded.");
  expect(workspaceRestoreMarkerDetail({ result: { finalResponseRecorded: false }, savedPlan: false, hasResponse: true })).not.toContain("No final response");
});

it.each(["/host/secret", "../escape", "file -> /secret", "C:\\host\\secret", "tmp/private-clone/file"])("omits diagnostic path %s", (workspaceRestorePath) => {
  expect(workspaceRestoreMarkerDetail({ result: { workspaceRestorePath }, savedPlan: false, hasResponse: true })).not.toContain("Affected path");
});

// restore-card3: owed files (the server's workspaceRestorePending fact) never say failed.
it("says recovering, not failed, for files that are only owed", () => {
  const detail = workspaceRestoreMarkerDetail({ result: { workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true },
    savedPlan: false, hasResponse: true });
  expect(detail).toContain("Recovering your saved work");
  expect(detail.toLowerCase()).not.toContain("failed");
  expect(workspaceRestoreMarkerDetail({ result: { workspaceRestoreFailure: "restore_failed" }, savedPlan: false, hasResponse: true }))
    .toBe("Workspace restore failed. Workspace files need recovery.");
});

// restore-card4: the server projects workspaceRestoreRecovered once the worker
// saved the owed files; the marker then says recovered, with no failure words.
it("says recovered, neither recovering nor failed, once the owed files were saved", () => {
  const detail = workspaceRestoreMarkerDetail({ result: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovered: true },
    savedPlan: false, hasResponse: true });
  expect(detail).toBe("Saved work recovered.");
  expect(detail.toLowerCase()).not.toContain("failed");
  expect(detail).not.toContain("Recovering");
});

// restore-card6: past the person bound the server projects workspaceRestoreDelayed;
// the marker says the delayed words and offers Retry (not pending).
it("says recovering is taking longer, with Retry, once the owed hold is past the person bound", async () => {
  const { workspaceRestoreMarker } = await import("./workspace-restore-marker");
  const result = { workspaceRestoreFailure: "restore_failed", workspaceRestoreDelayed: true };
  expect(workspaceRestoreMarkerDetail({ result, savedPlan: false, hasResponse: true }))
    .toBe("Recovering your saved work is taking longer than expected. You can Retry to continue from the last saved version.");
  expect(workspaceRestoreMarker(result)).toMatchObject({ pending: false, label: "Recovering saved work", tone: "neutral" });
});
