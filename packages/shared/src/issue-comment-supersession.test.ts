import { describe, expect, it } from "vitest";
import { ISSUE_COMMENT_SUPERSESSION_KEYS, isCurrentNotice, isSupersededNotice } from "./index.js";

// RFL 11:43Z (2): ONE definition of a CURRENT note. A kept note (never deleted, org 09:18Z) is history once a
// comment (supersededBy) or a card (supersededByInteractionId) superseded it. Every reader (server SQL, the B'
// test helpers, the UI's isHistoricalNotice) uses this rule, never a second copy.
describe("CURRENT comment notice (B' never-delete supersession)", () => {
  const id = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
  const base = { version: 1, sections: [{ rows: [{ type: "text", text: "Details" }] }] };

  it("names exactly the two supersession markers, so SQL readers derive from the same list", () => {
    expect([...ISSUE_COMMENT_SUPERSESSION_KEYS]).toEqual(["supersededBy", "supersededByInteractionId"]);
  });

  it.each([
    ["superseded by a comment", { ...base, supersededBy: id }],
    ["superseded by a card", { ...base, supersededByInteractionId: id }],
    ["superseded by both", { ...base, supersededBy: id, supersededByInteractionId: id }],
  ])("a note %s is history, not current", (_name, metadata) => {
    expect(isSupersededNotice(metadata)).toBe(true);
    expect(isCurrentNotice(metadata)).toBe(false);
  });

  it.each([
    ["with no metadata", null],
    ["with undefined metadata", undefined],
    ["with no marker", base],
    ["with empty markers", { ...base, supersededBy: "", supersededByInteractionId: "" }],
    ["with non-string markers", { ...base, supersededBy: 42, supersededByInteractionId: null }],
    ["with non-object metadata", "supersededBy"],
    ["with array metadata", [{ supersededBy: id }]],
  ])("a note %s is current", (_name, metadata) => {
    expect(isSupersededNotice(metadata)).toBe(false);
    expect(isCurrentNotice(metadata)).toBe(true);
  });
});
