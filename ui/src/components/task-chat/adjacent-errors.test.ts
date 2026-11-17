import { describe, expect, it } from "vitest";
import { compactAdjacentErrors } from "./adjacent-errors";
import type { TaskChatItem, TaskChatMarkerItem, TaskChatMessageItem } from "./task-chat-model";

const failed: TaskChatMarkerItem = {
  id: "failure", kind: "marker", variant: "interrupted", label: "Run failed", runId: "run-1",
};
const recovery: TaskChatMessageItem = {
  id: "recovery", kind: "message", author: "system", text: "Paperclip retried continuation, but it still has no live execution path.",
  presentation: { kind: "system_notice", title: "No live execution path", tone: "danger", detailsDefaultOpen: false },
};

describe("compactAdjacentErrors", () => {
  it.each([
    [failed, recovery],
    [recovery, failed],
  ])("keeps the later row and all of its details in either order", (first, last) => {
    const items = [first, last];
    expect(compactAdjacentErrors(items).items).toEqual([last]);
    expect(items).toEqual([first, last]);
  });

  it("compacts a contiguous group only when both error sources are present", () => {
    const latest = { ...failed, id: "latest", detail: "Newest error", runId: "run-2" };
    expect(compactAdjacentErrors([failed, recovery, latest]).items).toEqual([latest]);
    expect(compactAdjacentErrors([failed, latest]).items).toEqual([failed, latest]);
    expect(compactAdjacentErrors([recovery, { ...recovery, id: "other" }]).items).toHaveLength(2);
  });

  it("preserves the latest suppressed run retry without changing saved rows", () => {
    const latestFailure = { ...failed, id: "last-failure", runId: "last-run", retryable: false };
    const items = [failed, latestFailure, recovery];
    const compacted = compactAdjacentErrors(items);
    expect(compacted.items).toEqual([recovery]);
    expect(compacted.retryMarkers.get(recovery.id)).toBe(latestFailure);
    expect(items).toEqual([failed, latestFailure, recovery]);
    expect(compactAdjacentErrors([failed, { id: "human", kind: "message", author: "human", text: "Retry?" }, recovery]).retryMarkers.size).toBe(0);
  });

  it.each([
    recovery.text,
    "Paperclip automatically retried dispatch for this assigned `todo` issue during terminal run recovery, but it still has no live execution path.",
    "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry made progress, but it still has no live execution path.",
    "Paperclip retried this issue's run after it ended without finishing, but the bounded retry budget is spent and it still has no live execution path.",
  ])("recognizes an old unstructured recovery comment: %s", (text) => {
    const legacy = { ...recovery, text, presentation: null };
    expect(compactAdjacentErrors([failed, legacy]).items).toEqual([legacy]);
  });

  it.each([
    "Paperclip could not start this task. Press Retry to start it.",
    "Paperclip could not continue this task. Press Retry to start it again from the saved work.",
    "Paperclip tried to start this task again, but it still could not start. Press Retry to start it again.",
    "Paperclip tried to continue this task again, but it still could not continue after 3 tries. Press Retry to start it again from the saved work.",
  ])("recognizes the current recovery notice: %s", (text) => {
    const titled = { ...recovery, text, presentation: { ...recovery.presentation!, title: "Task could not continue" } };
    expect(compactAdjacentErrors([failed, titled]).items).toEqual([titled]);
    const unstructured = { ...recovery, text, presentation: null };
    expect(compactAdjacentErrors([failed, unstructured]).items).toEqual([unstructured]);
    const retitled: TaskChatMessageItem = { ...recovery, text,
      presentation: { ...recovery.presentation!, title: "Automatic recovery blocked" },
      metadata: { version: 1, sections: [{ title: "Recovery", rows: [
        { type: "key_value", label: "Recovery action", value: "recovery-action-1" }] }] } };
    expect(compactAdjacentErrors([failed, retitled]).items).toEqual([retitled]);
    const quoted = { ...recovery, presentation: null, text: `Child task report: ${text}` };
    expect(compactAdjacentErrors([failed, quoted]).items).toEqual([failed, quoted]);
  });

  it.each([
    "Paperclip could not start this task. Press Retry to start it.",
    "Paperclip could not continue this task. Press Retry to start it again from the saved work.",
    "Paperclip tried to start this task again, but it still could not start after 2 tries. Press Retry to start it again.",
    "Paperclip tried to continue this task again, but it still could not continue after 2 tries. Press Retry to start it again from the saved work.",
  ])("compacts a stranded notice under the producer title and preserves Retry: %s", (text) => {
    const notice: TaskChatMessageItem = {
      ...recovery,
      text,
      presentation: { ...recovery.presentation!, title: "Automatic recovery blocked" },
      metadata: { version: 1, sourceRunId: "run-1", sections: [{ title: "Recovery", rows: [
        { type: "key_value", label: "Recovery action", value: "recovery-action-1" },
      ] }] },
    };
    const compacted = compactAdjacentErrors([failed, notice]);
    expect(compacted.items).toEqual([notice]);
    expect(compacted.retryMarkers.get(notice.id)).toBe(failed);
    expect(compactAdjacentErrors([notice, failed]).items).toEqual([failed]);

    const withoutAction = { ...notice, metadata: undefined };
    expect(compactAdjacentErrors([failed, withoutAction]).items).toEqual([failed, withoutAction]);
  });

  it.each([
    // CONTINUATION_REFUSED_NOTICE in server/src/services/recovery/service.ts:
    // the shared prefix must not turn a different recovery family into a duplicate.
    "Paperclip could not continue this task on its own. The earlier Retry or message no longer matches the task, "
      + "for example because the task or the message changed since. Nothing was lost. Press Retry to continue.",
    // Successful-run disposition escalation, not stranded execution recovery.
    "Paperclip could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.",
  ])("keeps other could-not notices and their retry boundaries: %s", (text) => {
    for (const presentation of [null, { ...recovery.presentation!, title: "Automatic recovery blocked" }]) {
      const boundary: TaskChatMessageItem = {
        ...recovery, id: "unrelated", text, presentation,
        metadata: { version: 1, sections: [{ title: "Recovery", rows: [
          { type: "key_value", label: "Recovery action", value: "other-action" },
        ] }] },
      };
      const items = [failed, boundary, recovery];
      const result = compactAdjacentErrors(items);
      expect(result.items).toEqual(items);
      expect(result.retryMarkers.size).toBe(0);
    }
  });

  it.each(["Automatic recovery blocked", "Error: usage limit reached"])(
    "recognizes a saved stranded-recovery notice with the producer title %s", (title) => {
      // buildStrandedRecoveryEscalationNotice saves this metadata even when
      // its default or source-run title replaces the recovery-family title.
      const notice: TaskChatMessageItem = {
        ...recovery,
        text: "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry made progress, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.",
        presentation: { ...recovery.presentation!, title },
        metadata: { version: 1, sourceRunId: "run-1", sections: [{ title: "Recovery", rows: [
          { type: "key_value", label: "Recovery action", value: "recovery-action-1" },
          { type: "key_value", label: "Recovery owner", value: "Board decision required" },
        ] }] },
      };
      const compacted = compactAdjacentErrors([failed, notice]);
      expect(compacted.items).toEqual([notice]);
      expect(compacted.retryMarkers.get(notice.id)).toBe(failed);
      expect(compactAdjacentErrors([notice, failed]).items).toEqual([failed]);
    },
  );

  it.each([
    { ...recovery, presentation: { ...recovery.presentation!, title: "Child task blocked" } },
    { ...recovery, presentation: { ...recovery.presentation!, title: "" } },
    { ...recovery, presentation: { ...recovery.presentation!, title: "Automatic recovery blocked" } },
    { ...recovery, presentation: { ...recovery.presentation!, title: "Automatic recovery blocked" }, metadata: {
      version: 1 as const, sections: [{ title: "Recovery", rows: [{ type: "key_value" as const, label: "Recovery action", value: "" }] }],
    } },
    { ...recovery, text: "Child task has no live execution path.", metadata: {
      version: 1 as const, sections: [{ title: "Recovery", rows: [{ type: "key_value" as const, label: "Recovery action", value: "child-action" }] }],
    }, presentation: { ...recovery.presentation!, title: "Child task blocked" } },
    { ...recovery, presentation: null, text: "Child task has no live execution path. Parent must review its result." },
    { ...recovery, presentation: null, text: "Child task report: Paperclip retried continuation, but it still has no live execution path." },
  ])("preserves unrelated notices and their retry boundaries: $text ($presentation.title)", (boundary) => {
    const lastFailure = { ...failed, id: "last-failure", runId: "last-run" };
    for (const last of [recovery, lastFailure]) {
      const items = [failed, { ...boundary, id: "unrelated" }, last];
      const result = compactAdjacentErrors(items);
      expect(result.items).toEqual(items);
      expect(result.retryMarkers.size).toBe(0);
    }
  });

  const boundaries: TaskChatItem[] = [
    { id: "human", kind: "message", author: "human", text: "Please try again." },
    { id: "agent", kind: "message", author: "agent", text: "There is no live execution path." },
    { id: "system", kind: "message", author: "system", text: "Child task completed." },
    { id: "session", kind: "marker", variant: "session_start", label: "Session reset" },
    { ...failed, id: "cancelled", tone: "neutral", label: "Stopped" },
    { ...failed, id: "credential", credentialAccess: { agentName: "Coder", deniedUser: "you", settingsHref: "/agents/coder" } },
    { id: "tool", kind: "tool", name: "Read file", status: "completed" },
  ];
  it.each(boundaries.map((boundary) => [boundary.id, boundary] as const))(
    "keeps both errors across a %s row", (_, boundary) => {
      const items = [failed, boundary, recovery];
      expect(compactAdjacentErrors(items).items).toEqual(items);
    },
  );
});
