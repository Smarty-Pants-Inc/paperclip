import { expect } from "vitest";
import type { issueComments } from "@paperclipai/db";

/** RFL class 1: immutable history may contain many rows, but one current note. */
export function expectOneCurrentSystemNote(comments: (typeof issueComments.$inferSelect)[]) {
  const current = comments.filter(comment => comment.authorType === "system"
    && comment.deletedAt === null && !comment.metadata?.supersededByCommentId);
  expect(current).toHaveLength(1);
  return current[0]!;
}

/** A state change appends, preserving the old body, title/sections and row. */
export function expectSupersededSystemNote(previous: typeof issueComments.$inferSelect,
  comments: (typeof issueComments.$inferSelect)[], currentId: string) {
  expect(comments.find(comment => comment.id === previous.id)).toMatchObject({
    body: previous.body, deletedAt: null,
    metadata: { ...previous.metadata, supersededByCommentId: currentId },
  });
  expect(previous.id).not.toBe(currentId);
}
