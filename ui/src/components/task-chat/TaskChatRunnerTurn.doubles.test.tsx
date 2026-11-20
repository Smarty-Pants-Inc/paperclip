// @vitest-environment jsdom

import { mkdirSync, writeFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { TaskChatRequestHistoryContext } from "./TaskChatComposerTakeoverContext";
import type { TaskChatItem } from "./task-chat-model";

// An answer drawn twice in the runner lane: working text the final restates
// (after an Interrupt), and an earlier answer re-keyed by a transcript rebuild.
const T0 = Date.parse("2026-11-20T07:41:00.000Z");

const message = (id: string, text: string, channel: "progress" | "final", atMs: number): TaskChatItem => ({
  id: `run-1:msg:${id}`,
  kind: "message",
  author: "agent",
  authorName: "Runner",
  text,
  channel,
  interstitial: channel !== "final",
  streaming: false,
  atMs,
});

const SLEEP_PROGRESS = "9 + 10 = 19.";
const SLEEP_FINAL = "9 + 10 = 19. The `sleep 600` call was cut off by the interrupt, so LONG was never printed.";
const T2_PROGRESS = "6 x 7 = 42.\n\nThe capital of France is Paris.\n\nResuming the remaining steps, starting with step 3.";
const T2_FINAL = "6 x 7 = 42.\n\nThe capital of France is Paris.\n\nDONE";

describe.each([390, 1440])("runner lane draws an answer once at %ipx", (width) => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    container = document.createElement("div");
    container.style.width = `${width}px`;
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (items: TaskChatItem[], status = "running") =>
    act(() =>
      root.render(
        <MemoryRouter>
          <ThemeProvider>
            <TaskChatRequestHistoryContext.Provider value="issue-1">
              <TaskChatRunnerTurn
                runId="run-1"
                agentName="Runner"
                items={items}
                status={status}
                startedAtMs={T0}
                continuedAfterSteering
              />
            </TaskChatRequestHistoryContext.Provider>
          </ThemeProvider>
        </MemoryRouter>,
      ),
    );

  const count = (needle: string) => (container.textContent ?? "").split(needle).length - 1;
  const snapshot = (name: string) => {
    const dir = process.env.DOUBLES_SNAPSHOT_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${name}-${width}.html`, container.innerHTML);
  };

  it("U1 sleep600: progress the final starts with is drawn once", () => {
    render([message("4", SLEEP_PROGRESS, "progress", T0 + 1_000), message("9", SLEEP_FINAL, "final", T0 + 13_000)]);
    snapshot("U1");
    expect(count("9 + 10 = 19.")).toBe(1);
    expect(count("call was cut off")).toBe(1);
  });

  it("U2 t2: progress whose sentences the final restates is drawn once", () => {
    render([message("4", T2_PROGRESS, "progress", T0 + 1_000), message("9", T2_FINAL, "final", T0 + 80_000)], "succeeded");
    snapshot("U2");
    expect(count("6 x 7 = 42.")).toBe(1);
    expect(count("The capital of France is Paris.")).toBe(1);
    expect(count("Resuming the remaining steps")).toBe(0);
  });

  it("U3 lastinr2: an earlier answer re-keyed by a transcript rebuild is drawn once", () => {
    // 201 arrives (07:41:43.642), then the transcript is rebuilt with an entry
    // before it (its id moves from msg:6 to msg:7) and 202 arrives (07:41:45.157).
    render([message("6", "201", "final", T0 + 43_642)]);
    render([message("7", "201", "final", T0 + 43_642), message("9", "202", "final", T0 + 45_157)]);
    snapshot("U3");
    const answers = [...container.querySelectorAll('[data-testid="task-chat-earlier-response"], [data-testid="task-chat-final-response"]')]
      .map((node) => node.textContent ?? "");
    expect(answers.filter((text) => text.includes("201"))).toHaveLength(1);
    expect(answers.filter((text) => text.includes("202"))).toHaveLength(1);
  });

  it("U4 control: progress the final does not restate stays drawn", () => {
    render([message("4", "Checking the build logs before answering.", "progress", T0 + 1_000), message("9", SLEEP_FINAL, "final", T0 + 13_000)]);
    snapshot("U4");
    expect(count("Checking the build logs before answering.")).toBe(1);
    expect(count("9 + 10 = 19.")).toBe(1);
  });

  it("U4b control: two distinct answers with the same text both stay", () => {
    render([message("6", "201", "final", T0 + 43_642), message("9", "201", "final", T0 + 45_157), message("11", "202", "final", T0 + 47_000)]);
    const answers = [...container.querySelectorAll('[data-testid="task-chat-earlier-response"]')].map((node) => node.textContent ?? "");
    expect(answers.filter((text) => text.includes("201"))).toHaveLength(2);
  });

  it("U5 control: a final with no progress is drawn unchanged", () => {
    render([message("9", SLEEP_FINAL, "final", T0 + 13_000)]);
    snapshot("U5");
    expect(count(SLEEP_FINAL.replace("`sleep 600`", "sleep 600"))).toBe(1);
    expect(container.querySelectorAll('[data-testid="task-chat-final-response"]')).toHaveLength(1);
  });
});
