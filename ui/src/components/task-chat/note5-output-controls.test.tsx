// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { MAX_LIVE_LOG_LINES, MAX_LIVE_EVENTS, appendCapped } from "@/lib/live-log-buffer";
import { TaskChatProtocolActivityDetails } from "./TaskChatProtocolActivityRow";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatBubble } from "./TaskChatBubble";
import { CsvPreview } from "../CsvPreview";
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
  it("names the genuine runner omission without the forbidden label and links to the saved run", () => {
    render(<TaskChatProtocolActivityDetails item={base} />);
    expect(container.textContent).not.toMatch(/truncated/i);
    expect(container.textContent).toContain("runner saved only part");
    expect(container.querySelector('a[href="/PAP/agents/agent-1/runs/run-1"]')?.textContent).toContain("run log");
    expect(container.querySelector("pre")?.textContent).toBe(text);
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
  it("preserves legacy activity output and full expanded summary with a saved-run link", () => {
    render(<RunTranscriptView runLogHref="/agents/agent-1/runs/run-1" entries={[{ kind: "provider_activity", ts: "2026-11-17T00:00:00Z", family: "tool_execution", eventType: "tool.started", status: "running", title: "Tool", summary: text, payload: { output: text, outputTruncated: true } }]} />);
    expect(container.querySelector("pre")?.textContent).toBe(text);
    expect(container.querySelector("p.whitespace-pre-wrap")?.textContent).toBe(text);
    expect(container.querySelector('a[href="/PAP/agents/agent-1/runs/run-1"]')).not.toBeNull();
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
    expect(container.textContent).not.toContain("runner saved only part");
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
  it("retains live log lines and events beyond the former hard ceilings", () => {
    const lines = Array.from({ length: 5001 }, (_, i) => `line-${i}`);
    expect(appendCapped([], lines, MAX_LIVE_LOG_LINES)).toEqual(lines);
    expect(appendCapped([], lines, MAX_LIVE_EVENTS)).toEqual(lines);
  });
});
