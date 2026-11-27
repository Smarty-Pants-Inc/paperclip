import type { TaskChatItem } from "./task-chat-model";

type HandoffItem = Extract<TaskChatItem, { kind: "task_handoff" }>;

/** Resolve against the whole run so steering never resets creation ordinals. */
export function embedTaskHandoffsAtCreateBoundaries(
  segments: readonly (readonly TaskChatItem[])[],
  cards: readonly HandoffItem[],
): TaskChatItem[][] {
  const unique = [...new Map(cards.map(card => [card.handoff.issueId, card])).values()];
  const cardIds = new Set(unique.map(card => card.id));
  const clean = segments.map(items => items.filter(item => !cardIds.has(item.id)));
  const positions = clean.flatMap((items, segment) => items.map((item, index) => {
    const activity = item.kind === "protocol" && item.surface === "provider_activity" && item.family === "tool_execution" ? item : null;
    const name = item.kind === "tool" ? item.rawName ?? item.name : activity?.details.find(detail => detail.label === "Name")?.value;
    const start = "startedAtMs" in item ? item.startedAtMs : "atMs" in item ? item.atMs : undefined;
    const end = item.kind === "tool" ? item.status === "in_progress" || item.status === "pending" ? undefined : item.finishedAtMs
      : activity?.status === "running" ? undefined : activity?.updatedAtMs;
    return { segment, index, start, end, tool: item.kind === "tool" || !!activity,
      creation: !!name?.replaceAll("-", "_").toLowerCase().match(/(^|[_.])create_task$/),
      result: item.kind === "tool" ? item.detail ?? "" : activity?.output ?? "" };
  }));
  const calls = positions.filter(position => position.tool);
  const creations = calls.filter(call => call.creation);
  const matched = unique.map(card => calls.find(call => call.result.includes(card.handoff.issueId)));
  const used = new Set(matched.filter(call => !!call));
  const after = new Map<string, HandoffItem[]>();
  unique.forEach((card, ordinal) => {
    let call = matched[ordinal];
    if (!call) {
      call = creations[ordinal] && !used.has(creations[ordinal]) ? creations[ordinal] : creations.find(candidate => !used.has(candidate));
      if (call) used.add(call);
    }
    const at = Date.parse(card.handoff.createdAt);
    const anchor = call ?? calls.find(candidate => candidate.start != null && candidate.start <= at && (candidate.end == null || candidate.end >= at))
      ?? positions.findLast(position => position.start != null && position.start <= at);
    const segment = anchor?.segment ?? Math.max(0, clean.length - 1);
    const index = anchor?.index ?? (clean[segment]?.length ?? 0) - 1;
    const key = `${segment}:${index}`;
    after.set(key, [...(after.get(key) ?? []), card]);
  });
  if (!clean.length) clean.push([]);
  return clean.map((items, segment) => [
    ...(after.get(`${segment}:-1`) ?? []),
    ...items.flatMap((item, index) => [item, ...(after.get(`${segment}:${index}`) ?? [])]),
  ]);
}

/** Suggestions retain this owner when acceptance morphs them into created tasks. */
export function taskCreationSourceRunId(item: TaskChatItem): string | null {
  if (item.kind === "task_handoff") return item.handoff.sourceRunId ?? null;
  if (item.kind === "interaction" && item.interaction.kind === "suggest_tasks") {
    return item.interaction.sourceRunId ?? null;
  }
  return null;
}

/**
 * A task card closes its source agent turn, including its final reply and every
 * steering segment. Run ownership is explicit; unavailable history and older
 * handoffs without provenance keep their existing chronological slots.
 * Apply before settled turns merge so a card also preserves its run boundary.
 */
export function orderTaskCreationItems(
  items: TaskChatItem[],
  sourceRunByItemId: ReadonlyMap<string, string>,
): TaskChatItem[] {
  const lastItemByRun = new Map<string, string>();
  for (const item of items) {
    const runId = sourceRunByItemId.get(item.id);
    if (runId) lastItemByRun.set(runId, item.id);
  }
  const cardsByAnchor = new Map<string, TaskChatItem[]>();
  const relocated = new Set<string>();
  for (const item of items) {
    const runId = taskCreationSourceRunId(item);
    const anchorId = runId ? lastItemByRun.get(runId) : undefined;
    if (!anchorId) continue;
    const cards = cardsByAnchor.get(anchorId) ?? [];
    cards.push(item);
    cardsByAnchor.set(anchorId, cards);
    relocated.add(item.id);
  }
  if (relocated.size === 0) return items;
  return items.flatMap(item => relocated.has(item.id)
    ? []
    : [item, ...(cardsByAnchor.get(item.id) ?? [])]);
}
