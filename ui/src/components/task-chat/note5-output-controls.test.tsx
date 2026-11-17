// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { MAX_LIVE_LOG_LINES, MAX_LIVE_EVENTS, appendCapped } from "@/lib/live-log-buffer";
import { TaskChatProtocolActivityDetails } from "./TaskChatProtocolActivityRow";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatBubble } from "./TaskChatBubble";
import { CsvPreview } from "../CsvPreview";
import { ProviderTraceStatusBadge } from "../ProviderTraceStatusBadge";
import { parseCsv } from "@/lib/csv-preview";
import { SheetTable as TintSheetTable } from "@/artifact-directions/directions/d2-tint/Content";
import { SheetTable as HybridSheetTable } from "@/artifact-directions/directions/d4-hybrid/Content";
import { TaskChatDiffView } from "./TaskChatDiffView";
import { parseUnifiedDiffLines } from "./diff-lines";
import { nativeRunEventsToTranscript } from "../transcript/native-run-events";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { RunTranscriptView } from "../transcript/RunTranscriptView";
import { transcriptToTaskChatItems } from "./transcript-adapter";
import type { TaskChatProviderActivityItem } from "./task-chat-model";
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { issuePrefix: "PAP" } }), useOptionalCompany: () => null }));
const text = "Full output. ".repeat(800) + "VISIBLE_LAST_BYTE";
const base: TaskChatProviderActivityItem = { id: "notice", kind: "protocol", surface: "provider_activity", family: "tool_execution", eventType: "tool.completed", status: "completed", title: "Read", details: [], steps: [], links: [], children: [], output: text, outputTruncated: true, runLogHref: "/agents/agent-1/runs/run-1" };

describe("NOTE 5: full output controls and honest producer-limit copy", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const render = (child: React.ReactNode) => act(() => root.render(<MemoryRouter><ThemeProvider>{child}</ThemeProvider></MemoryRouter>));
  it("names the kept full text without forbidden labels or a misleading saved-run link", () => {
    render(<TaskChatProtocolActivityDetails item={base} />);
    expect(container.textContent).not.toMatch(/truncated|saved only part|\bcut\b/i);
    expect(container.textContent).toContain("Showing part of this output. The full output stays on the agent's machine only while it runs.");
    expect(container.querySelector('a[href="/PAP/agents/agent-1/runs/run-1"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(text);
  });
  it("shows the UTF-8 excerpt size of a 102400-byte spill without a link or truncated label", () => {
    const fullOutput = "é".repeat(51200);
    expect(new TextEncoder().encode(fullOutput)).toHaveLength(102400);
    const output = fullOutput.slice(0, 20480) + "\n" + fullOutput.slice(-4096) + "\n";
    const marker = "[Full output: /tmp/x.json (102400 bytes; the excerpt above is its first 40 KiB and last 8 KiB; use read(/tmp/x.json, offset, limit) or rg on that path to see more)]";
    render(<TaskChatProtocolActivityDetails item={{ ...base, outputTruncated: false, output: output + marker }} />);
    expect(container.querySelector("pre")?.textContent).toBe(output);
    expect(container.textContent).toContain("Showing part of this output (48 KB of 100 KB). The full output stays on the agent's machine only while it runs.");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toMatch(/truncated|\[Full output:|\/tmp\/x\.json/i);
  });
  // RFL's four qualified production-component regressions (round 2).
  it("RFL: canonical spilled tool shows one kept line, no run link and no private path", () => {
    render(<TaskChatProtocolActivityDetails item={{ ...base, outputTruncated: false, output: "FIRST\n[Full output: /tmp/private-spill.log (102400 bytes; sha256: abc123)]\nLAST" }} />);
    expect(container.textContent?.match(/The full output stays on the agent's machine only while it runs\./g)).toHaveLength(1);
    expect(container.textContent).not.toContain("/tmp/private-spill.log");
    expect(container.querySelector('a[href="/PAP/agents/agent-1/runs/run-1"]')).toBeNull();
  });
  it("RFL: unflagged ordinary output shows no kept line", () => {
    render(<TaskChatProtocolActivityDetails item={{ ...base, outputTruncated: false, output: "Complete output" }} />);
    expect(container.textContent).not.toContain("The full output stays");
    expect(container.querySelector("pre")?.textContent).toBe("Complete output");
  });
  it("RFL: unflagged documentation mention must not invent a producer flag", () => {
    const output = "The documentation describes the [Full output: marker syntax.";
    render(<TaskChatProtocolActivityDetails item={{ ...base, outputTruncated: false, output }} />);
    expect(container.textContent).not.toContain("The full output stays");
    expect(container.querySelector("pre")?.textContent).toBe(output);
  });
  it("RFL: an indented spill box-path marker must not reach the person", () => {
    render(<TaskChatProtocolActivityDetails item={{ ...base, outputTruncated: true, output: "FIRST\n  [Full output: /tmp/private-spill.log (102400 bytes; sha256: abc123)]\nLAST" }} />);
    expect(container.textContent).not.toContain("/tmp/private-spill.log");
    expect(container.querySelector("pre")?.textContent).toBe("FIRST\nLAST");
  });
  it.each([
    ["\t[Full output: /tmp/private-spill.log (102400 bytes; sha256: abc123)]\r\n", ""],
    ["  [Full output: /tmp/private-spill.log (102400 bytes; ask to read any part)]", ""],
    [" [Full output: /tmp/private-spill.log (read it with offset/limit)]\n", ""],
    [" [Full output: /tmp/private-spill.log (read with offset/limit)]\r\n", ""],
    ["  [Full output: /tmp/private-spill.log (102400 bytes; sha256: abc123)]KEEP_SUFFIX\r\n", "KEEP_SUFFIX\r\n"],
  ])("RFL grammar: hides marker but preserves suffix and other bytes (%s)", (marker, suffix) => {
    const before = "  FIRST\t\r\n\r\n";
    const after = "LAST\t ";
    render(<TaskChatProtocolActivityDetails item={{ ...base, outputTruncated: false, output: before + marker + after }} />);
    expect(container.querySelector("pre")?.textContent).toBe(before + suffix + after);
    expect(container.textContent?.match(/The full output stays on the agent's machine only while it runs\./g)).toHaveLength(1);
    expect(container.innerHTML).not.toContain("/tmp/private-spill.log");
  });
  it("hides only the spill marker line in compact provider details", () => {
    const output = "  FIRST_BYTE\n\nLAST_BYTE\t \n";
    render(<TaskChatProtocolActivityDetails item={{ ...base, outputTruncated: false, output: output + "[Full output: /tmp/compact-spill.log (102400 bytes; sha256: abc123)]\nAFTER_MARKER" }} />);
    expect(container.querySelector("pre")?.textContent).toBe(output + "AFTER_MARKER");
    expect(container.textContent?.split("The full output stays on the agent's machine only while it runs.")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/\[Full output:|\/tmp\/compact-spill|saved only part|truncated/i);
  });
  it("hides the spill marker in legacy provider output and summary without needing a true flag", () => {
    const output = "  LEGACY_FIRST\nLEGACY_LAST\t \n";
    const spilled = output + "[Full output: /tmp/legacy-spill.log (102400 bytes; sha256: abc123)]";
    render(<RunTranscriptView entries={[{ kind: "provider_activity", ts: "2026-11-17T00:00:00Z", family: "tool_execution", eventType: "tool.started", status: "running", title: "Tool", summary: spilled, payload: { output: spilled, outputTruncated: false } }]} />);
    expect(container.querySelector("pre")?.textContent).toBe(output);
    expect(container.querySelector("p.whitespace-pre-wrap")?.textContent).toBe(output);
    expect(container.textContent).toContain("Showing part of this output (29 B of 100 KB).");
    expect(container.textContent?.split("The full output stays on the agent's machine only while it runs.")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/\[Full output:|\/tmp\/legacy-spill/);
  });
  it.each([
    ["card", "Read", true], ["card", "Read", false],
    ["nice", "Read", true], ["nice", "Read", false],
    ["nice", "bash", true], ["nice", "bash", false],
    ["raw", "Read", true], ["raw", "Read", false],
  ] as const)("keeps native tool output whole and private (%s, %s, flag=%s)", (view, name, outputTruncated) => {
    const output = '  {"first":"NATIVE_FIRST","last":"NATIVE_LAST"}\t \n';
    const event = {
      id: 1, companyId: "c", agentId: "a", runId: "r", seq: 1, stream: null, level: null, color: null, message: null,
      eventType: "tool.execution.completed", createdAt: new Date("2026-11-17T00:00:00Z"),
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "r", eventType: "tool.execution.completed", payload: {
        schema: "paperclip.tool.execution.v1", executionId: "read-spill", transport: "builtin", operation: name === "bash" ? "execute" : "read", name, status: "completed",
        output: outputTruncated ? output : output + "[Full output: /tmp/native-spill.log (100000 bytes; sha256: abc123)]", outputTruncated,
      } } },
    } as HeartbeatRunEvent;
    const entries = nativeRunEventsToTranscript([event]);
    if (view === "card") {
      const item = transcriptToTaskChatItems(entries, { runId: "r", running: false }).find(item => item.kind === "tool");
      if (item?.kind !== "tool") throw new Error("expected tool");
      render(<TaskChatToolCard item={item} />);
      act(() => container.querySelector("button")!.click());
    } else {
      render(<RunTranscriptView mode={view} entries={entries} />);
      if (view === "nice") act(() => container.querySelector<HTMLButtonElement>('button[aria-label^="Expand"]')!.click());
    }
    expect([...container.querySelectorAll("pre")].some(node => node.textContent === output)).toBe(true);
    expect(container.textContent?.split("The full output stays on the agent's machine only while it runs.")).toHaveLength(2);
    expect(container.textContent).toContain(outputTruncated ? "Showing part of this output." : "Showing part of this output (50 B of 98 KB).");
    expect(container.innerHTML).not.toMatch(/\[Full output:|\/tmp\/native-spill/);
  });
  it.each(["bubble", "nice", "raw"] as const)("renders the final producer text as is, never fullText metadata (%s)", (view) => {
    const answer = "This answer is longer than one message (100 KB).\nThe full text is kept; ask me to show any part.\n\n## Excerpt (the start of the answer, not the whole answer)\n\nANSWER_START";
    const path = "/tmp/full-answer-private.md";
    const sha256 = "1a2b3c4d".repeat(8);
    const event = {
      id: 1, companyId: "c", agentId: "a", runId: "r", seq: 1, stream: null, level: null, color: null, message: null,
      eventType: "item.completed", createdAt: new Date("2026-11-17T00:00:00Z"),
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "r", eventType: "item.completed", itemId: "final-answer", payload: {
        kind: "agent_message", channel: "final", text: answer, fullText: { path, sha256, bytes: 102400 },
      } } },
    } as HeartbeatRunEvent;
    const entries = nativeRunEventsToTranscript([event]);
    if (view === "bubble") {
      const [item] = transcriptToTaskChatItems(entries, { runId: "r", running: false });
      if (item?.kind !== "message") throw new Error("expected final answer bubble");
      expect(item.text).toBe(answer);
      render(<TaskChatBubble item={item} />);
    } else render(<RunTranscriptView mode={view} entries={entries} />);
    expect(container.textContent).toContain("This answer is longer than one message (100 KB).");
    expect(container.textContent).toContain("The full text is kept; ask me to show any part.");
    expect(container.textContent).toContain("Excerpt (the start of the answer, not the whole answer)");
    expect(container.textContent).toContain("ANSWER_START");
    expect(container.innerHTML).not.toContain(path);
    expect(container.innerHTML).not.toContain(sha256);
  });
  it("shows the actual research output and wraps source snippets after expansion", () => {
    render(<TaskChatProtocolActivityDetails item={{ ...base, family: "research", links: [{ label: "Research source", href: "https://example.com", description: text }] }} />);
    expect(container.querySelector("pre")?.textContent).toBe(text);
    expect([...container.querySelectorAll(".truncate")].filter(el => el.textContent === text)).toHaveLength(0);
  });
  it("reveals every workspace file rather than saying more files are not shown", () => {
    render(<TaskChatProtocolActivityDetails item={{ id: "changes", kind: "protocol", surface: "workspace_change", changeSetId: "c", revision: 1, source: "runner_verified", complete: true, files: Array.from({ length: 10 }, (_, i) => ({ path: `file-${i}`, previousPath: null, operation: "modify", additions: 1, deletions: 0, binary: false, diff: null })), totals: { files: 10, additions: 10, deletions: 0 }, patchArtifactRef: null }} />);
    const more = [...container.querySelectorAll("button")].find(el => el.textContent?.includes("Show 2 more files"));
    expect(more).toBeDefined();
    act(() => more?.click());
    expect(container.querySelectorAll('ul[aria-label="Changed files"] li')).toHaveLength(10);
    expect(container.textContent).toContain("file-9");
  });
  it("reveals all earlier transcript blocks when clicked", () => {
    render(<RunTranscriptView limit={1} entries={[{ kind: "assistant", ts: "2026-11-17T00:00:00Z", text: "FIRST_OUTPUT" }, { kind: "tool_call", ts: "2026-11-17T00:00:00Z", name: "read", toolUseId: "between", input: {} }, { kind: "assistant", ts: "2026-11-17T00:00:01Z", text: "LAST_OUTPUT", channel: "final" }]} />);
    const more = [...container.querySelectorAll("button")].find(el => el.textContent?.includes("Show 2 earlier"));
    expect(more).toBeDefined();
    act(() => more?.click());
    expect(container.textContent).toContain("FIRST_OUTPUT");
    expect(container.textContent).toContain("LAST_OUTPUT");
  });
  it("keeps full command and result visible after opening the actual tool row", () => {
    const items = transcriptToTaskChatItems([{ kind: "tool_call", ts: "2026-11-17T00:00:00Z", name: "bash", toolUseId: "tool", input: { command: text } }, { kind: "tool_result", ts: "2026-11-17T00:00:01Z", toolUseId: "tool", content: text, isError: false }], { runId: "r", running: false });
    if (items[0]?.kind !== "tool") throw new Error("expected tool");
    render(<TaskChatToolCard item={items[0]} />);
    act(() => container.querySelector("button")?.click());
    expect(container.querySelector("pre")?.textContent).toBe(text);
    expect(container.querySelector('[data-testid="task-chat-tool-target-detail"]')?.textContent).toBe(text);
  });
  it("preserves legacy activity output and full expanded summary without a misleading saved-run link", () => {
    render(<RunTranscriptView runLogHref="/agents/agent-1/runs/run-1" entries={[{ kind: "provider_activity", ts: "2026-11-17T00:00:00Z", family: "tool_execution", eventType: "tool.started", status: "running", title: "Tool", summary: text, payload: { output: text, outputTruncated: true } }]} />);
    expect(container.querySelector("pre")?.textContent).toBe(text);
    expect(container.querySelector("p.whitespace-pre-wrap")?.textContent).toBe(text);
    expect(container.querySelector('a[href="/PAP/agents/agent-1/runs/run-1"]')).toBeNull();
    expect(container.textContent).not.toMatch(/truncated/i);
  });
  it("judge: exact 40000-character final answer reaches actual Markdown DOM", () => {
    const answer = "A".repeat(39983) + "FINAL_40000_END!X";
    expect(answer.length).toBe(40000);
    const [item] = transcriptToTaskChatItems([{ kind: "assistant", ts: "2026-11-17T00:00:00Z", text: answer, channel: "final" }], { runId: "r", running: false });
    if (item.kind !== "message") throw new Error("expected message");
    render(<TaskChatBubble item={item} />);
    expect(container.querySelector(".paperclip-markdown")?.textContent).toBe(answer);
  });
  it("judge: exact 100 KiB tool output expands whole", () => {
    const output = "T".repeat(102400 - 13) + "TOOL_LAST_END";
    expect(output.length).toBe(102400);
    const [item] = transcriptToTaskChatItems([{ kind: "tool_call", ts: "2026-11-17T00:00:00Z", name: "bash", toolUseId: "t", input: { command: "echo output" } }, { kind: "tool_result", ts: "2026-11-17T00:00:00Z", toolUseId: "t", content: output, isError: false }], { runId: "r", running: false });
    if (item.kind !== "tool") throw new Error("expected tool");
    render(<TaskChatToolCard item={item} />);
    act(() => container.querySelector("button")!.click());
    expect(container.querySelector("pre")?.textContent).toBe(output);
  });
  it("judge: every one of 2000 diff lines is reachable", () => {
    const parsed = parseUnifiedDiffLines(Array.from({ length: 2000 }, (_, i) => `+line-${i}`).join("\n"));
    expect(parsed.lines).toHaveLength(2000);
    expect(parsed.truncated).toBe(false);
    render(<TaskChatDiffView lines={parsed.lines} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(24);
    const more = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Show 1976 more"));
    expect(more).toBeDefined();
    act(() => more!.click());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2000);
    expect(container.textContent).toContain("line-1999");
  });
  it("judge: no producer notice without a true output flag, even for 100 KiB", () => {
    const output = "x".repeat(102400);
    const [item] = transcriptToTaskChatItems([{ kind: "provider_activity", ts: "2026-11-17T00:00:00Z", family: "tool_execution", eventType: "tool.completed", title: "Tool", status: "completed", payload: { output }, summary: "" }], { runId: "r", running: false });
    if (item.kind !== "protocol" || item.surface !== "provider_activity") throw new Error("expected activity");
    render(<TaskChatProtocolActivityDetails item={item} />);
    expect(container.querySelector("pre")?.textContent).toBe(output);
    expect(container.textContent).not.toMatch(/runner saved only part|full output stays/);
  });
  it("judge: native diff fallback renders the saved-run reference as an anchor", () => {
    const event = { id: 1, companyId: "c", agentId: "a", runId: "r", seq: 1, stream: null, level: null, color: null, message: null, eventType: "tool.execution.completed", createdAt: new Date("2026-11-17T00:00:00Z"), payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "r", eventType: "tool.execution.completed", payload: { schema: "paperclip.tool.execution.v1", executionId: "edit", transport: "builtin", operation: "edit", name: "Edit", status: "completed", output: "", fileChanges: [{ path: "a.txt", operation: "modify", additions: 1, deletions: 0, diff: "+hello", diffTruncated: true }] } } } } as HeartbeatRunEvent;
    render(<RunTranscriptView entries={nativeRunEventsToTranscript([event])} />);
    const diff = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(button => button.textContent?.includes("a.txt"));
    expect(diff).toBeDefined();
    act(() => diff!.click());
    expect(container.textContent).toContain("runner saved only part");
    expect(container.querySelector('a[href*="/agents/a/runs/r"]')).not.toBeNull();
  });
  it("keeps every CSV column and reveals every row without a content-cut marker", () => {
    const header = Array.from({ length: 101 }, (_, index) => `column-${index}`).join(",");
    const csv = header + "\n" + Array.from({ length: 501 }, (_, index) => `row-${index}`).join("\n");
    render(<CsvPreview text={csv} title="Saved CSV" />);
    expect(container.querySelectorAll("thead th")).toHaveLength(102);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(500);
    const more = [...container.querySelectorAll("button")].find(button => button.textContent === "Show 1 more row");
    expect(more).toBeDefined();
    act(() => more!.click());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(501);
    expect(container.textContent).toContain("row-500");
    expect(container.textContent).not.toContain("Showing the first");
  }, 30000);
  it("independent: a flagged producer trace notice must contain a saved-run anchor", () => {
    const trace = { status: "truncated", expiresAt: "2099-01-01T00:00:00Z", frameCount: 1, byteCount: 10 } as any;
    render(<ProviderTraceStatusBadge {...{ trace, runLogHref: "/agents/agent-1/runs/run-1" }} />);
    expect(container.textContent).toMatch(/runner saved only part|full output stays/);
    expect(container.querySelector('a[href="/PAP/agents/agent-1/runs/run-1"]')).not.toBeNull();
  });
  it.each([["tint", TintSheetTable], ["hybrid", HybridSheetTable]] as const)("independent: lab %s sheet should not append a custom cut label instead of a real paging control", (_name, SheetTable) => {
    const html = renderToStaticMarkup(<SheetTable artifact={{ excerpt: "Name,Value\none,1\ntwo,2\nLAST,END" } as any} rows={1} />);
    expect(html).not.toMatch(/more rows?|more columns?/);
  });
  it("independent: CSV expansion reaches the exact last row, column, and Unicode bytes", async () => {
    const cell = (s: string) => '"' + s.replaceAll('"', '""') + '"';
    const header = Array.from({ length: 101 }, (_, j) => `column-${j}`);
    const rows = Array.from({ length: 503 }, (_, i) => Array.from({ length: 101 }, (_, j) => `r${i}c${j}`));
    rows[502][100] = 'LAST,"quoted"\nユニコード🙂END';
    const csv = [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
    expect(parseCsv(csv)).toEqual([header, ...rows]);
    render(<CsvPreview text={csv} title="Independent CSV" />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(500);
    const more = [...container.querySelectorAll('button')].find(b => b.textContent === 'Show 3 more rows');
    expect(more).toBeDefined();
    await act(async () => more!.click());
    const actual = [...container.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(td => td.textContent));
    expect(actual).toEqual(rows);
    expect(new TextEncoder().encode(actual[502][100]!)).toEqual(new TextEncoder().encode(rows[502][100]));
  }, 30000);
  it("retains live log lines and events beyond the former hard ceilings", () => {
    const lines = Array.from({ length: 5001 }, (_, i) => `line-${i}`);
    expect(appendCapped([], lines, MAX_LIVE_LOG_LINES)).toEqual(lines);
    expect(appendCapped([], lines, MAX_LIVE_EVENTS)).toEqual(lines);
  });
});
