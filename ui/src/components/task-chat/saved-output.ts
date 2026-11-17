/**
 * Agent-facing spill marker grammar (not an arbitrary "Full output" mention):
 *   line-start, horizontal whitespace?, "[Full output: ", nonempty path,
 *   " (", (digits " bytes; " details | "read [it ]with offset/limit"), ")]".
 * Consume the line ending (LF/CRLF) only when it immediately follows the marker
 * with optional horizontal whitespace. A same-line suffix is ordinary output:
 * preserve it, as well as every byte before/after the marker.
 *
 * Pi's projector passes native text through contentText/projectTool
 * (packages/paperclip-runner/src/drivers/pi/pi-event-projector.ts:52-55,294-308);
 * runner-core likewise preserves tool text in bounded_output
 * (packages/paperclip-runner/runner/crates/runner-core/src/provider_events.rs:831-839).
 * Retain the saved-run byte-count envelope; current Pi 1.5.2 also emits
 * "read it with offset/limit" (pi-mcp/dist/output-limit.js:22) and
 * "read with offset/limit" (pi-coding-agent/dist/extensions/codemode/execute.js:404).
 * Both inference and stripping MUST use this one matcher.
 */
export const SAVED_OUTPUT_MARKER = /^[^\S\r\n]*\[Full output: [^\r\n]+? \((?:(\d+) bytes; [^\r\n]*?|read (?:it )?with offset\/limit)\)\](?:[^\S\r\n]*\r?\n|$)?/gm;

/** Hide only validated spill markers, preserving all other bytes. */
export function savedOutputForDisplay(output: string | undefined, outputTruncated = false) {
  let hasSpillMarker = false;
  let fullOutputBytes: number | undefined;
  const displayOutput = output?.replace(SAVED_OUTPUT_MARKER, (_marker, bytes: string | undefined) => {
    if (!hasSpillMarker && bytes !== undefined) fullOutputBytes = Number(bytes);
    hasSpillMarker = true;
    return "";
  });
  return {
    output: displayOutput,
    fullOutputBytes,
    // An explicit producer flag remains authoritative. Legacy runners may
    // lose it; only a validated marker can recover that evidence from text.
    outputTruncated: outputTruncated || hasSpillMarker,
  };
}
