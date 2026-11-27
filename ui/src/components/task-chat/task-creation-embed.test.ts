import { describe, expect, it } from "vitest";
import type { TaskChatItem, TaskChatToolItem } from "./task-chat-model";
import { embedTaskHandoffsAtCreateBoundaries } from "./task-creation-order";
const tool = (id: string, detail?: string, name = "mcp__paperclip__create_task"): TaskChatToolItem =>
  ({ id, kind: "tool", name, status: "completed", detail });
const card = (id: string): Extract<TaskChatItem, { kind: "task_handoff" }> => ({
  id: `card-${id}`, kind: "task_handoff",
  handoff: { id: `card-${id}`, issueId: id, identifier: null, title: id, status: "todo",
    createdAt: "2026-10-26T12:00:00Z", sourceRunId: "run", suggestionInteractionId: null },
});
const ids = (segments: TaskChatItem[][]) => segments.map(items => items.map(item => item.id));
describe("task creation boundaries", () => {
  it("prefers result identities over card order and splits tool groups", () => {
    expect(ids(embedTaskHandoffsAtCreateBoundaries([
      [tool("one", '{"id":"first"}'), tool("two", '{"id":"second"}'), tool("three", "", "read")],
    ], [card("second"), card("first")]))).toEqual([["one", "card-first", "two", "card-second", "three"]]);
  });
  it("matches provider results and normalized prefixed names", () => {
    const activity: TaskChatItem = { id: "provider", kind: "protocol", surface: "provider_activity",
      family: "tool_execution", eventType: "tool.execution.completed", status: "completed", title: "Create",
      details: [{ label: "Name", value: "mcp__paperclip__create-task" }], output: '{"id":"first"}',
      steps: [], links: [], children: [] };
    expect(ids(embedTaskHandoffsAtCreateBoundaries([[activity]], [card("first")]))).toEqual([["provider", "card-first"]]);
  });
  it("matches a task identity in a generic script result before a named creation", () => {
    expect(ids(embedTaskHandoffsAtCreateBoundaries([[tool("script", "first", "run_script"), tool("named")]],
      [card("first")]))).toEqual([["script", "card-first", "named"]]);
  });
  it.each([undefined, Date.parse("2026-10-26T12:00:02Z")])("uses the script call window while its end is %s", end => {
    const script = { ...tool("script", "", "run_script"), startedAtMs: Date.parse("2026-10-26T11:59:59Z"), finishedAtMs: end };
    expect(ids(embedTaskHandoffsAtCreateBoundaries([[script, tool("later", "", "read")]], [card("first")])))
      .toEqual([["script", "card-first", "later"]]);
  });
  it("places a card after the last earlier-starting item outside any call window", () => {
    const message: TaskChatItem = { id: "earlier", kind: "message", author: "agent", text: "Work", atMs: Date.parse("2026-10-26T11:59:59Z") };
    const later = { ...message, id: "later", atMs: Date.parse("2026-10-26T12:00:01Z") };
    expect(ids(embedTaskHandoffsAtCreateBoundaries([[message, later]], [card("first")])))
      .toEqual([["earlier", "card-first", "later"]]);
  });
  it("uses creation ordinals across segments, not once per segment", () => {
    expect(ids(embedTaskHandoffsAtCreateBoundaries([[tool("one")], [tool("two")]],
      [card("first"), card("second")]))).toEqual([["one", "card-first"], ["two", "card-second"]]);
  });
  it("reserves identity matches before assigning unmatched ordinal calls", () => {
    expect(ids(embedTaskHandoffsAtCreateBoundaries([[tool("one", "second"), tool("two")]],
      [card("first"), card("second")]))).toEqual([["one", "card-second", "two", "card-first"]]);
  });
  it("falls back at the end of the last segment, including an empty turn", () => {
    expect(ids(embedTaskHandoffsAtCreateBoundaries([[tool("read", "", "read")], []], [card("first")])))
      .toEqual([["read"], ["card-first"]]);
    expect(ids(embedTaskHandoffsAtCreateBoundaries([], [card("first")]))).toEqual([["card-first"]]);
  });
  it("deduplicates repeated cards and is idempotent", () => {
    const segments = [[tool("one")]];
    const once = embedTaskHandoffsAtCreateBoundaries(segments, [card("first"), card("first")]);
    expect(ids(embedTaskHandoffsAtCreateBoundaries(once, [card("first")]))).toEqual([["one", "card-first"]]);
  });
});
