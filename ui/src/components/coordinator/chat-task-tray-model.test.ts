import { describe, expect, it } from "vitest";
import { buildChatTaskTray, filterChatTaskTray, groupForGlyph, CHAT_TASK_TRAY_GROUP_ORDER } from "./chat-task-tray-model";
import type { ChatTaskTrayItem } from "./useChatTaskTray";
import { resolveTaskStatusPresentation, taskStatusIconProps } from "@/lib/task-status-presentation";

export function task(n: number, patch: Partial<ChatTaskTrayItem> = {}): ChatTaskTrayItem {
  return { id: `handoff-${n}`, issueId: `task-${n}`, identifier: `TEST-${n}`, title: `Task ${n}`,
    status: "todo", createdAt: "2026-11-26T07:00:00Z", sourceRunId: null, suggestionInteractionId: null, ...patch };
}
describe("chat task tray model", () => {
  it.each([0, 1, 5, 24, 205])("counts %i open tasks, not terminal tasks or duplicate handoffs", count => {
    const items = Array.from({ length: count }, (_, i) => task(i));
    const model = buildChatTaskTray([...items, ...items, task(500, { status: "done" }), task(501, { status: "cancelled" })]);
    expect(model.total).toBe(count);
    expect(model.counts["up-next"]).toBe(count);
    expect(model.preview).toBe(count ? `Task 0${count > 1 ? ", Task 1" : ""}${count > 2 ? ` +${count - 2}` : ""}` : "");
  });
  it.each([
    ["blocked", "needs-you"], ["in_queue", "waiting"], ["paused", "waiting"], ["monitoring", "waiting"],
    ["idle", "waiting"], ["in_review", "waiting"], ["in_progress", "working"], ["todo", "up-next"],
    ["backlog", "up-next"], ["blocked_checking", "waiting"], ["blocked_lifecycle", "waiting"], ["future_status", null], ["done", null], ["cancelled", null],
  ])("maps resolver glyph %s to %s", (glyph, group) => expect(groupForGlyph(glyph)).toBe(group));
  it("uses shared status evidence and the task id rather than handoff id on either base", () => {
    const items = [
      task(1, { status: "blocked" }),
      task(2, { status: "blocked", unblockDescriptor: { owner: { userId: "person" }, action: "Approve deploy" } }),
      task(3, { status: "blocked", blockerAttention: { state: "covered", reason: "active_child", unresolvedBlockerCount: 1,
        coveredBlockerCount: 1, attentionBlockerCount: 0, stalledBlockerCount: 0, sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null } }),
      task(4, { status: "blocked", interruption: { state: "waiting_for_user", responsibility: "user", userAction: "resume",
        intentId: null, nextRetryAt: null, canRetry: false, sourceRunIds: [], observedRunId: null } }),
      task(5, { status: "in_progress", displayStatus: "monitoring" }),
      task(6, { status: "in_review", externalConversationState: "waiting" }),
      task(7, { status: "in_progress" }), task(8, { status: "backlog" }),
    ];
    const model = buildChatTaskTray(items);
    const expectedCounts = { working: 0, "needs-you": 0, waiting: 0, "up-next": 0 };
    for (const item of items) {
      // Do not hard-code one stack's blocked/pause policy: the resolver owns it.
      const source = { ...item, id: item.issueId };
      const presentation = resolveTaskStatusPresentation(taskStatusIconProps(source));
      const group = groupForGlyph(presentation.glyphStatus)!;
      expectedCounts[group]++;
      expect(model.rows.find(row => row.item.issueId === item.issueId)).toMatchObject({ group, presentation });
    }
    expect(model.counts).toEqual(expectedCounts);
  });
  it("sorts busy first, newest update first, then identifier; filtering does not alter counts", () => {
    const model = buildChatTaskTray([
      task(3), task(2, { status: "in_progress", updatedAt: "2026-11-26T07:01:00Z" }),
      task(1, { status: "in_progress", updatedAt: "2026-11-26T07:01:00Z" }),
      task(4, { status: "in_progress", updatedAt: "2026-11-26T07:02:00Z" }),
    ], item => item.issueId === "task-1" ? "Alex Owner" : "Unassigned");
    expect(CHAT_TASK_TRAY_GROUP_ORDER).toEqual(["working", "needs-you", "waiting", "up-next"]);
    expect(model.rows.map(row => row.item.issueId)).toEqual(["task-4", "task-1", "task-2", "task-3"]);
    expect(filterChatTaskTray(model.rows, "alex").map(row => row.item.issueId)).toEqual(["task-1"]);
    expect(filterChatTaskTray(model.rows, "TEST-2")).toHaveLength(1);
    expect(filterChatTaskTray(model.rows, "task 4")).toHaveLength(1);
    expect(filterChatTaskTray(model.rows, "absent")).toEqual([]);
    expect(model.total).toBe(4);
    expect(model.counts.working).toBe(3);
  });
  it("keeps unknown states visible as unavailable, not zero", () => {
    const model = buildChatTaskTray([task(1, { status: "future" as ChatTaskTrayItem["status"] })]);
    expect(model.total).toBe(1);
    expect(model.unavailable).toBe(true);
    expect(model.rows[0].presentation.label).toBe("Status unavailable");
  });
});
