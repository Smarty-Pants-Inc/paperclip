// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "@/adapters";
import { buildTranscript } from "@/adapters";
import { paperclipRunnerUIAdapter } from "@/adapters/paperclip-runner";
import { formatIssueChangeValue } from "@/lib/issue-change-receipt";
import { resolveInitialLogOffset } from "../transcript/useLiveRunTranscripts";
import { RunTranscriptView } from "../transcript/RunTranscriptView";
import { parseUnifiedDiffLines } from "./diff-lines";
import { transcriptToTaskChatItems } from "./transcript-adapter";

const ts = "2026-11-17T05:00:00.000Z";
const long = "Readable output line.\n".repeat(5000) + "EXACT_END_SENTINEL";
const options = { runId: "run-note5", running: false };
const activity = (family: Extract<TranscriptEntry, { kind: "provider_activity" }>["family"], payload: Record<string, unknown>): TranscriptEntry => ({ kind: "provider_activity", ts, family, payload, eventType: `${family}.completed`, status: "completed", title: "Activity", summary: "Activity" });
const convert = (entry: TranscriptEntry) => transcriptToTaskChatItems([entry], options)[0];

describe("NOTE 5: browser-available text survives the complete transcript pipeline", () => {
  it("keeps the complete expandable tool result and command, not a 600-character detail", () => {
    const rows = transcriptToTaskChatItems([
      { kind: "tool_call", ts, name: "bash", toolUseId: "tool", input: { command: long } },
      { kind: "tool_result", ts, toolUseId: "tool", content: long, isError: false },
    ], options);
    expect(rows[0]).toMatchObject({ kind: "tool", target: long, detail: long });
  });
  it("preserves significant whitespace in expanded command and tool output", () => {
    const original = "  indented line\n\n";
    const rows = transcriptToTaskChatItems([{ kind: "tool_call", ts, name: "bash", toolUseId: "whitespace", input: { command: original } }, { kind: "tool_result", ts, toolUseId: "whitespace", content: original, isError: false }], options);
    expect(rows[0]).toMatchObject({ target: original, detail: original });
  });
  it.each(["tool_execution", "plan_proposal", "research"] as const)("keeps all %s output without inventing a producer omission", family => {
    const item = convert(activity(family, { output: long, markdown: long }));
    expect(item).toMatchObject({ output: long, outputTruncated: false });
  });
  it("keeps producer omission flags when they are actually supplied", () => {
    expect(convert(activity("tool_execution", { output: long, outputTruncated: true }))).toMatchObject({ output: long, outputTruncated: true });
  });
  it("keeps all provider notice fields and their full values", () => {
    const item = convert(activity("provider_notice", { userActionable: true, category: "status", phase: "running", message: long, details: Array.from({ length: 70 }, (_, i) => ({ name: `Field ${i}`, value: long })) }));
    expect(item).toMatchObject({ details: expect.arrayContaining([{ label: "Field 69", value: long, mono: false }]) });
  });
  it.each(["research", "plan", "delegation"] as const)("keeps every %s entry above the old collection limits", family => {
    const item = convert(activity(family, { sources: Array.from({ length: 70 }, (_, i) => ({ title: `Source ${i}`, url: `https://example.com/${i}`, snippet: long })), steps: Array.from({ length: 260 }, (_, i) => ({ stepId: String(i), body: long })), children: Array.from({ length: 70 }, (_, i) => ({ childId: String(i), summary: long })) }));
    expect(item && "links" in item ? item.links.length : 0).toBe(family === "research" ? 70 : 0);
    expect(item && "steps" in item ? item.steps.length : 0).toBe(family === "plan" ? 260 : 0);
    expect(item && "children" in item ? item.children.length : 0).toBe(family === "delegation" ? 70 : 0);
  });
  it("keeps all workspace preview and patch bytes", () => {
    const file = convert({ kind: "workspace_file_reference", ts, referenceId: "f", source: "runner_verified", path: "notes.md", displayName: "Notes", mediaType: "text/markdown", presentation: "document", line: null, preview: long, previewTruncated: false, contentDigest: null });
    expect(file).toMatchObject({ preview: long, previewTruncated: false });
    const patch = convert({ kind: "workspace_change", ts, changeSetId: "c", revision: 1, source: "runner_verified", complete: true, files: [{ path: "notes.md", previousPath: null, operation: "modify", additions: 1, deletions: 0, binary: false, diff: long }], totals: { files: 1, additions: 1, deletions: 0 }, patchArtifactRef: null });
    expect(patch).toMatchObject({ files: [{ diff: long }] });
  });
  it("parses every diff line so the existing expand control can reveal everything", () => {
    const result = parseUnifiedDiffLines(Array.from({ length: 650 }, (_, i) => `+line-${i}`).join("\n"));
    expect(result.lines).toHaveLength(650);
    expect(result.lines.at(-1)?.text).toBe("line-649");
    expect(result.truncated).toBe(false);
  });
  it("keeps the original full line when an adapter parser fails", () => {
    const entries = buildTranscript([{ ts, stream: "stdout", chunk: long.replaceAll("\n", " ") + "\n" }], () => { throw new Error("Cannot parse"); });
    expect(JSON.stringify(entries)).toContain("EXACT_END_SENTINEL");
  });
  it("starts persisted history at byte zero instead of a silently capped tail", () => {
    expect(resolveInitialLogOffset({ id: "run", status: "succeeded", adapterType: "process", logBytes: 20_000_000 }, 256_000)).toBe(0);
  });
  it("retains every requested block in the transcript view behind an expand control", () => {
    const html = renderToStaticMarkup(<RunTranscriptView limit={1} entries={[{ kind: "assistant", ts, text: "FIRST_OUTPUT_SENTINEL" }, { kind: "stderr", ts, text: "LAST_OUTPUT_SENTINEL" }]} />);
    expect(html).toContain("Show 1 earlier");
  });
  it("keeps the complete changed description value", () => {
    expect(formatIssueChangeValue(long, { field: "description" })).toBe(long);
  });
  it("keeps more than 2000 workspace files at the adapter boundary", () => {
    const entries = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({ type: "paperclip.prp.event", event: { eventType: "workspace.change.updated", payload: { changeSetId: "c", files: Array.from({ length: 2001 }, (_, i) => ({ path: `file-${i}` })) } } }), ts);
    expect(JSON.stringify(entries)).toContain("file-2000");
  });
});
