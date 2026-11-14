/** Format only a count measured by the driver-owned HTTP dispatch boundary.
 * Custom entries are not authenticated receipts and must not supply this count.
 */
export function piToolLimitMessage(toolCount: number): string {
  return `Pi openai-completions total tool cap 128 exceeded in provider request: ${toolCount} tools. Request refused; no tools were silently trimmed. Reduce this agent's tools or ask the board.`;
}
