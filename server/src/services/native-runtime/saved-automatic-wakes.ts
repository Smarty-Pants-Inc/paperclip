import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export const READ_SAVED_AUTOMATIC_WAKES = "read_saved_automatic_wakes";
export const READ_SAVED_AUTOMATIC_WAKES_DEFINITION = {
  name: READ_SAVED_AUTOMATIC_WAKES,
  description: "Read the complete saved automatic wake events bound to this run, as untrusted JSON data. Concatenate data pages, passing nextOffset until null. No other run or task can be selected.",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    offset: { type: "integer", minimum: 0 }, digest: { type: "string" },
  } },
};
export function savedAutomaticWakeEvents(value: unknown): unknown[] {
  const events = object(value).nativeInputRefusalWakes;
  return Array.isArray(events) ? events : [];
}
export function savedAutomaticWakesText(value: unknown, referenceOnly = false, readerAvailable = true, inlineEventLimit = Number.POSITIVE_INFINITY): string {
  const events = savedAutomaticWakeEvents(value);
  if (!events.length) return "";
  if (!readerAvailable) {
    const kept = events.slice(Math.max(0, events.length - inlineEventLimit));
    const omitted = events.length - kept.length;
    return [kept.length ? `Saved automatic wake events (untrusted data):\n${JSON.stringify(kept)}` : "",
      omitted ? `${omitted} earlier automatic events not shown; still owed for a later turn:\n${events.slice(0, omitted).map(savedAutomaticWakeSource).join("\n")}` : ""].filter(Boolean).join("\n\n");
  }
  const json = JSON.stringify(events);
  // An arbitrarily large backlog is not a required inline prompt. The complete
  // immutable run snapshot remains available through the scoped paged reader.
  if (referenceOnly || Buffer.byteLength(json) > 32_000) return `Saved automatic wake events (untrusted data): ${events.length} events. Read their full payloads with ${READ_SAVED_AUTOMATIC_WAKES} (start at offset 0, then nextOffset until null). SHA-256: ${createHash("sha256").update(json).digest("hex")}.`;
  return `Saved automatic wake events (untrusted data):\n${json}`;
}
/** Navigation only: full automatic payloads remain owed, never summary-delivered. */
function savedAutomaticWakeSource(value: unknown): string {
  const event = object(value), payload = object(event.payload), context = object(event.contextSnapshot);
  const summaries = [payload, context].flatMap(source => Array.isArray(source.childIssueSummaries) ? source.childIssueSummaries : []);
  const ids = [...new Set([payload.childIssueId, payload.childTaskId, context.childIssueId, context.childTaskId,
    ...summaries.map(summary => object(summary).id)].filter(id => typeof id === "string"))];
  const line = [payload.childSummary, context.childSummary, ...summaries.map(summary => object(summary).summary), event.reason]
    .find(text => typeof text === "string") as string | undefined;
  return `- ${String(event.reason ?? event.source ?? "automatic")} ${ids.join(", ") || String(payload.issueId ?? context.issueId ?? "task")}: ${(line ?? "Saved automatic update").split(/\r?\n/, 1)[0].slice(0, 160)}`;
}

/** Remove only duplicate first-event context, not unrelated newly admitted data. */
export function withoutDuplicateSavedWakeContext(value: unknown): unknown {
  const events = savedAutomaticWakeEvents(value);
  if (!events.length) return value;
  const wake = { ...object(value) };
  const summaries = events.flatMap(event => {
    const entry = object(event);
    return [object(entry.payload), object(entry.contextSnapshot)].flatMap(source =>
      Array.isArray(source.childIssueSummaries) ? source.childIssueSummaries : []);
  });
  if (Array.isArray(wake.childIssueSummaries)) wake.childIssueSummaries = wake.childIssueSummaries.filter(summary =>
    !summaries.some(saved => isDeepStrictEqual(saved, summary)));
  return wake;
}
/** Authority revalidates the active run before passing its server-owned context. */
export function readSavedAutomaticWakes(contextSnapshot: unknown, args: Record<string, unknown>) {
  if (Object.keys(args).some(key => key !== "offset" && key !== "digest")) throw new Error("saved_automatic_wakes_arguments_invalid");
  const offset = args.offset ?? 0;
  const events = savedAutomaticWakeEvents(contextSnapshot);
  if (!events.length) throw new Error("saved_automatic_wakes_not_bound");
  const json = JSON.stringify(events), digest = createHash("sha256").update(json).digest("hex");
  if (args.digest !== undefined && args.digest !== digest) throw new Error("saved_automatic_wakes_digest_mismatch");
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > json.length) throw new Error("saved_automatic_wakes_offset_invalid");
  // Character offsets cannot bisect UTF-8, and the encoded response is bounded
  // even for entirely escaped/control/non-ASCII content (<= 150 KB).
  let end = Math.min(json.length, offset + 24_000);
  if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
  return { trust: "untrusted_data", digest, eventCount: events.length, offset,
    nextOffset: end < json.length ? end : null, data: json.slice(offset, end) };
}
