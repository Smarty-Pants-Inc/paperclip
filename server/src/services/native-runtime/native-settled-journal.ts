import { isSettledRemoteWarmControlState } from "./remote-warm-session-recovery.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** A command ordinal alone cannot order checkpoints: an ACK changes status at
 * the same controllerSeq. Keep a settled local journal only if it dominates
 * every command/event in the saved checkpoint of the exact same authority.
 * Divergent payloads, terminal results, or identities are never merged. */
export function newerSettledNativeJournal(localBytes: string, savedBytes: string): boolean {
  try {
    const local = record(JSON.parse(localBytes)), saved = record(JSON.parse(savedBytes));
    if (local.schema !== saved.schema || canonical(local.identity) !== canonical(saved.identity)
      || local.warmTransition != null || local.stagedRunAttachment != null
      || saved.warmTransition != null || saved.stagedRunAttachment != null
      || !Array.isArray(local.commands) || !Array.isArray(saved.commands)
      || !Array.isArray(local.committedEvents) || !Array.isArray(saved.committedEvents)
      || Number(local.ackedSourceSeq) < Number(saved.ackedSourceSeq)
      || !isSettledRemoteWarmControlState(local, record(local.identity))) return false;
    const commands = local.commands.map(record), events = local.committedEvents.map(record);
    if (!commands.every(command => command.status === "completed") || commands.length < saved.commands.length) return false;
    let advanced = commands.length > saved.commands.length || Number(local.ackedSourceSeq) > Number(saved.ackedSourceSeq);
    for (const [index, value] of saved.commands.entries()) {
      const previous = record(value), current = commands[index];
      if (!current) return false;
      const { status: oldStatus, result: oldResult, ...oldIntent } = previous;
      const { status: newStatus, result: newResult, ...newIntent } = current;
      if (canonical(oldIntent) !== canonical(newIntent)) return false;
      if (oldStatus === "pending" && newStatus === "completed") advanced = true;
      else if (oldStatus !== newStatus || canonical(oldResult) !== canonical(newResult)) return false;
    }
    if (!saved.committedEvents.every(value => {
      const previous = record(value), current = events.find(event => event.sourceSeq === previous.sourceSeq);
      return current && canonical(current) === canonical(previous);
    })) return false;
    const answered = new Set(commands.filter(command => command.type === "semantic_tool.result")
      .map(command => record(command.payload).sourceEventId));
    if (events.some(event => ["semantic_tool.input", "mcp_app.tool_input"].includes(String(event.eventType))
      && !answered.has(event.sourceEventId))) return false;
    return advanced;
  } catch { return false; }
}
