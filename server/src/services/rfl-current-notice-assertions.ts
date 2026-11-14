import { expect } from "vitest";
import type { issueComments } from "@paperclipai/db";
type Note = typeof issueComments.$inferSelect;
/** RFL class 1: retain historical rows and their exact body/title; one current note. */
export function currentNotices(after: Note[], before: Note[] = []): Note[] {
  for (const old of before) {
    const retained = after.find(note => note.id === old.id);
    expect(retained, `historical note ${old.id} retained`).toBeDefined();
    expect(retained!.deletedAt).toBeNull();
    expect(retained!.body).toBe(old.body);
    expect(retained!.createdAt).toEqual(old.createdAt);
    expect(retained!.updatedAt).toEqual(old.updatedAt);
    expect(retained!.metadata?.sections).toEqual(old.metadata?.sections);
    expect(retained!.metadata?.authorizationReason).toEqual(old.metadata?.authorizationReason);
  }
  for (const note of after) {
    expect(note.deletedAt).toBeNull();
    const target = note.metadata?.supersededByCommentId;
    if (target) expect(after.some(candidate => candidate.id === target && candidate.id !== note.id)).toBe(true);
  }
  return after.filter(note => !note.metadata?.supersededByCommentId);
}
