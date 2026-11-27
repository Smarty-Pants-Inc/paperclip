import { resolveTaskStatusPresentation, taskStatusIconProps, type TaskStatusPresentation } from "@/lib/task-status-presentation";
import type { ChatTaskTrayItem } from "./useChatTaskTray";

export const CHAT_TASK_TRAY_GROUP_ORDER = ["working", "needs-you", "waiting", "up-next"] as const;
export type ChatTaskTrayGroup = typeof CHAT_TASK_TRAY_GROUP_ORDER[number];
export const CHAT_TASK_TRAY_LABELS: Record<ChatTaskTrayGroup, string> = {
  working: "Working", "needs-you": "Needs you", waiting: "Waiting", "up-next": "Up next",
};
export function groupForGlyph(glyph: string): ChatTaskTrayGroup | null {
  switch (glyph) {
    case "blocked": return "needs-you";
    case "in_queue": case "paused": case "monitoring": case "idle": case "in_review":
    case "blocked_checking": case "blocked_lifecycle": return "waiting";
    case "in_progress": return "working";
    case "todo": case "backlog": return "up-next";
    default: return null;
  }
}
/** A handoff id identifies the receipt; task evidence refers to issueId. */
export function trayTaskStatusInput(item: ChatTaskTrayItem) {
  const source = { ...item, id: item.issueId };
  return taskStatusIconProps(source);
}
export interface ChatTaskTrayRow {
  item: ChatTaskTrayItem;
  group: ChatTaskTrayGroup | null;
  presentation: TaskStatusPresentation;
  searchText: string;
}
export function buildChatTaskTray(items: readonly ChatTaskTrayItem[], ownerName: (item: ChatTaskTrayItem) => string = () => "Unassigned") {
  const groups: Record<ChatTaskTrayGroup, ChatTaskTrayRow[]> = { working: [], "needs-you": [], waiting: [], "up-next": [] };
  const counts: Record<ChatTaskTrayGroup, number> = { working: 0, "needs-you": 0, waiting: 0, "up-next": 0 };
  const unique = new Map(items.map(item => [item.issueId, item]));
  const unknown: ChatTaskTrayRow[] = [];
  for (const item of unique.values()) {
    if (item.status === "done" || item.status === "cancelled") continue;
    const presentation = resolveTaskStatusPresentation(trayTaskStatusInput(item));
    const group = groupForGlyph(presentation.glyphStatus);
    const row = { item, group, presentation: group ? presentation : { ...presentation, label: "Status unavailable", ariaLabel: "Status unavailable" },
      searchText: `${item.identifier ?? item.issueId} ${item.title} ${ownerName(item)}`.toLocaleLowerCase() };
    if (group) { groups[group].push(row); counts[group]++; } else unknown.push(row);
  }
  const updated = (row: ChatTaskTrayRow) => Date.parse(row.item.updatedAt ?? "") || 0;
  const compare = (a: ChatTaskTrayRow, b: ChatTaskTrayRow) => updated(b) - updated(a)
    || (a.item.identifier ?? a.item.issueId).localeCompare(b.item.identifier ?? b.item.issueId, undefined, { numeric: true })
    || a.item.issueId.localeCompare(b.item.issueId);
  for (const group of CHAT_TASK_TRAY_GROUP_ORDER) groups[group].sort(compare);
  unknown.sort(compare);
  const rows = [...CHAT_TASK_TRAY_GROUP_ORDER.flatMap(group => groups[group]), ...unknown];
  const preview = rows.slice(0, 2).map(row => row.item.title).join(", ") + (rows.length > 2 ? ` +${rows.length - 2}` : "");
  return { rows, groups, counts, total: rows.length, preview, unavailable: unknown.length > 0 };
}
export function filterChatTaskTray(rows: readonly ChatTaskTrayRow[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? rows.filter(row => row.searchText.includes(needle)) : rows;
}
