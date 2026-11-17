// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runLogChunks from "../../lib/run-log-chunks";
import * as liveLogBuffer from "../../lib/live-log-buffer";
import { RunTranscriptView } from "./RunTranscriptView";
import type { OutputPage } from "./OutputPageControls";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { issuePrefix: "PAP" } }), useOptionalCompany: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FORBIDDEN = /trimm|truncat|earlier output removed|removed from memory/i;
const entries = [{ kind: "assistant" as const, ts: "2026-11-17T00:00:00Z", text: "Newest answer" }];

describe("Show earlier output", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const render = (earlierOutput?: OutputPage, laterOutput?: OutputPage, mode: "nice" | "raw" = "nice") =>
    act(() => root.render(<MemoryRouter><ThemeProvider><RunTranscriptView entries={entries} earlierOutput={earlierOutput} laterOutput={laterOutput} mode={mode} /></ThemeProvider></MemoryRouter>));

  it("offers 'Show earlier output' when older output left memory, and loads it on press", () => {
    const load = vi.fn();
    render({ available: true, state: "idle", load });
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "Show earlier output");
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Newest answer");
  });

  it("shows nothing extra when the whole run is in memory", () => {
    render({ available: false, state: "idle", load: vi.fn() });
    expect(container.textContent).not.toMatch(/Show earlier output/);
  });

  it("(d) says when an earlier range could not load, and Retry reads it again", () => {
    const load = vi.fn();
    render({ available: true, state: "error", load });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load earlier output. Retry");
    const retry = [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
    act(() => retry!.click());
    expect(load).toHaveBeenCalledTimes(1);
    render({ available: true, state: "idle", load });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers 'Show later output' in raw mode too", () => {
    render(undefined, { available: true, state: "idle", load: vi.fn() }, "raw");
    expect(container.textContent).toContain("Show later output");
  });

  it("(e) never shows trimmed, truncated or removed wording in any paging state", () => {
    for (const state of ["idle", "loading", "error"] as const) {
      for (const mode of ["nice", "raw"] as const) {
        render({ available: true, state, load: vi.fn() }, { available: true, state, load: vi.fn() }, mode);
        expect(container.textContent).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("(e) the buffers export no marker text and the paging sources carry no such copy", () => {
    for (const value of [...Object.values(runLogChunks), ...Object.values(liveLogBuffer)]) {
      if (typeof value === "string") expect(value).not.toMatch(FORBIDDEN);
    }
    const sources = [
      "../../lib/run-log-chunks.ts",
      "../../lib/run-log-paging.ts",
      "../../lib/live-log-buffer.ts",
      "./OutputPageControls.tsx",
      "./useLiveRunTranscripts.ts",
    ].map((path) => readFileSync(resolve(__dirname, path), "utf8"));
    for (const source of sources) {
      const literals = source.match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? [];
      for (const literal of literals) expect(literal).not.toMatch(/earlier output (trimmed|removed)|\[truncated\]|trimmed to stay/i);
    }
  });
});
