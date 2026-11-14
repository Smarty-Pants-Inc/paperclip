import { validateOrigin, type Origin } from "./pi-bind-protocol.js";

/** Pi's supported appendEntry -> entry_appended RPC seam. Never project arbitrary
 * hook errors or extension data; this owned envelope contains only origin/count.
 */
export const PI_TOOL_LIMIT_ENTRY = "paperclip.tool-limit.v1";
export function piToolLimitMessage(toolCount: number): string {
  return `Pi openai-completions total tool cap 128 exceeded in provider request: ${toolCount} tools. Request refused; no tools were silently trimmed. Reduce this agent's tools or ask the board.`;
}
export function piToolLimitEntry(value: unknown): { origin: Origin; toolCount: number } | undefined {
  if (!value || typeof value !== "object") return;
  const entry = value as Record<string, unknown>;
  if (entry.type !== "custom" || entry.customType !== PI_TOOL_LIMIT_ENTRY || !entry.data || typeof entry.data !== "object") return;
  const data = entry.data as Record<string, unknown>;
  if (data.api !== "openai-completions" || data.cap !== 128 || !validateOrigin(data.origin)
    || !Number.isSafeInteger(data.toolCount) || (data.toolCount as number) <= 128) return;
  return { origin: { epoch: data.origin.epoch, runId: data.origin.runId, turnId: data.origin.turnId }, toolCount: data.toolCount as number };
}
