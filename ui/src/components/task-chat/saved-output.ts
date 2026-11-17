/** Hide only the producer's agent-facing spill-marker line, preserving all other bytes. */
export function savedOutputForDisplay(output: string | undefined, outputTruncated = false) {
  return {
    output: output?.replace(/^\[Full output: [^\r\n]+ \(\d+ bytes; [^\r\n]*\)\](?:\r?\n|$)/gm, ""),
    // Runner versions can recompute the flag from the shortened output. The
    // producer's marker is still reliable evidence that the full text is kept.
    outputTruncated: outputTruncated || Boolean(output?.includes("[Full output: ")),
  };
}
