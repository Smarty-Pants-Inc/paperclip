import { describe, expect, it } from "vitest";
import type { IssueQueuedCommentEntry, IssueQueuedCommentQueue } from "@paperclipai/shared";
import { queuedMessageAutoSteerEligible } from "./queued-message-auto-steer";

function entry(id: string, body: string, position: number): IssueQueuedCommentEntry {
  return {
    comment: {
      id, companyId: "company-1", issueId: "issue-1", authorType: "user", authorAgentId: null,
      authorUserId: "user-1", body, presentation: null, metadata: null,
      createdAt: new Date("2026-11-17T05:00:00Z"), updatedAt: new Date("2026-11-17T05:00:00Z"),
    },
    position, canEdit: true, canDiscard: true,
  };
}

function queue(entries: IssueQueuedCommentEntry[]): IssueQueuedCommentQueue {
  return {
    issueId: "issue-1", queueId: "wake-1", state: "deferred", targetRunId: "run-1", revision: "rev-1",
    protocol: "paperclip_runner_v1", steeringDisposition: "available", entries,
  };
}

const none = new Set<string>();

describe("queuedMessageAutoSteerEligible", () => {
  it("offers a plain queued follow-up (guard)", () => {
    const plain = entry("comment-1", "Please also check the tests", 0);
    expect(queuedMessageAutoSteerEligible({ queue: queue([plain]), entry: plain,
      cancelledIds: none, attemptedKeys: none, editingCommentId: null })).toBe(true);
  });

  it("never steers a /new chat reset, which runs only at a turn boundary", () => {
    for (const body of ["/new", "  /new\n"]) {
      const reset = entry("comment-1", body, 0);
      expect(queuedMessageAutoSteerEligible({ queue: queue([reset]), entry: reset,
        cancelledIds: none, attemptedKeys: none, editingCommentId: null })).toBe(false);
    }
  });

  it("offers only the head of a chat queue, so steered messages keep their sent order", () => {
    const head = entry("comment-1", "First", 0);
    const second = entry("comment-2", "Second", 1);
    const chat = queue([head, second]);
    const eligible = (candidate: IssueQueuedCommentEntry) => queuedMessageAutoSteerEligible({
      queue: chat, entry: candidate, cancelledIds: none, attemptedKeys: none, editingCommentId: null, headOnly: true,
    });
    expect(eligible(head)).toBe(true);
    expect(eligible(second)).toBe(false);
  });
});
