// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { MAX_LIVE_LOG_LINES, MAX_LIVE_EVENTS, appendCapped } from "@/lib/live-log-buffer";
import { TaskChatProtocolActivityDetails } from "./TaskChatProtocolActivityRow";
import { TaskChatToolCard } from "./TaskChatToolCard";
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
  it("retains live log lines and events beyond the former hard ceilings", () => {
    const lines = Array.from({ length: 5001 }, (_, i) => `line-${i}`);
    expect(appendCapped([], lines, MAX_LIVE_LOG_LINES)).toEqual(lines);
    expect(appendCapped([], lines, MAX_LIVE_EVENTS)).toEqual(lines);
  });
});
