// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThinking } from "./TaskChatThinking";
import { paperclipRunnerUIAdapter } from "@/adapters/paperclip-runner";
import { transcriptToTaskChatItems } from "./transcript-adapter";

// Inline reasoning is plain text in the flow of the turn (Paul 11-15 05:49Z):
// no container (border, background, rounded box, padding block), no indent,
// no bullet. Italic and the muted tone are the only things that set it apart,
// and it starts at the same left edge as the answer text (the agent bubble's
// px-1 inset). Folded mode is unchanged.
const indexCss = readFileSync(path.resolve(__dirname, "../../index.css"), "utf8");
function reasoningLookCss() {
  const match = indexCss.match(/\/\* reasoning-look:start[\s\S]*?\/\* reasoning-look:end \*\//);
  expect(match, "index.css has a marked reasoning-look block").not.toBeNull();
  return match![0];
}

const CODEX = "**Reading the adapter defaults**\n\nThe Codex adapter folds reasoning, so I check `transcriptPresentation` first.\n\n**Comparing with the runner**\n\nThe runner shows reasoning inline.";
const ANSWER_INSET = "px-1"; // TaskChatBubble agent body: "w-full bg-transparent px-1 text-foreground"

// Anything that draws a box, insets the text, or adds a bullet.
const CONTAINER_TOKEN = /^(border(-|$)|bg-|rounded|shadow|ring-|outline-|p[xytblrse]?-|-?m[xytblrse]?-|indent-|list-|gap-|space-[xy]-|size-|text-xs$)/;

let container: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

beforeEach(() => {
  style = document.createElement("style");
  style.textContent = reasoningLookCss();
  document.head.appendChild(style);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  style.remove();
});

function render(text: string, inline: boolean) {
  flushSync(() => root.render(
    <ThemeProvider>
      <TaskChatThinking item={{ id: "r1", kind: "thinking", lines: [text], inline }} />
    </ThemeProvider>,
  ));
}

/** Elements the reasoning renderer itself owns (markdown internals excluded). */
function chromeElements(block: HTMLElement) {
  return [block, ...Array.from(block.querySelectorAll<HTMLElement>("*"))]
    .filter((node) => node === block || !node.parentElement?.closest(".paperclip-markdown"));
}

describe("inline reasoning is plain text in the turn", () => {
  it.each([390, 1440])("renders all streamed thinking after a cut completion at a %spx host width", width => {
    container.style.width = `${width}px`;
    const whole = "r".repeat(4354);
    const parser = paperclipRunnerUIAdapter.createStdoutParser!();
    const parse = (eventType: string, text: string) => parser.parseLine(JSON.stringify({
      type: "paperclip.prp.event", event: { eventType, itemId: "r1", payload: {
        kind: "reasoning", text, item: { id: "r1", type: "reasoning", text },
      } },
    }), "2026-11-17T12:00:00.000Z");
    const entries = [...parse("item.delta", whole.slice(0, 2000)), ...parse("item.delta", whole.slice(2000)),
      ...parse("item.completed", whole.slice(0, 4096) + "…[truncated]")];
    const item = transcriptToTaskChatItems(entries, { runId: "render-whole", running: false })
      .find(item => item.kind === "thinking")!;
    expect(item.kind).toBe("thinking");
    if (item.kind !== "thinking") return;
    render(item.lines.join("\n"), true);
    expect(container.querySelector('[data-testid="task-chat-thinking"]')!.textContent).toBe(whole);
    expect(container.textContent).not.toContain("[truncated]");
  });

  it.each([390, 1440])("renders a legitimate terminal marker literally on reload at a %spx host width", width => {
    container.style.width = `${width}px`;
    const value = "The literal marker is …[truncated]";
    const entries = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
      type: "paperclip.prp.event", event: { eventType: "item.completed", itemId: "literal-1",
        payload: { kind: "reasoning", item: { type: "reasoning", text: value } } },
    }), "2026-11-17T12:00:00.000Z");
    const item = transcriptToTaskChatItems(entries, { runId: "literal-reload", running: false })[0];
    expect(item.kind).toBe("thinking");
    if (item.kind !== "thinking") return;
    render(item.lines.join("\n"), true);
    expect(container.querySelector('[data-testid="task-chat-thinking"]')!.textContent).toBe(value);
    expect(container.textContent).not.toContain("is kept in the run log");
  });

  it("renders a no-stream excerpt with the run-log notice, never the cut marker", () => {
    const excerpt = "Stored excerpt".padEnd(4096, "r");
    const entries = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
      type: "paperclip.prp.event", event: { eventType: "item.completed", itemId: "r1",
        payload: { kind: "reasoning", item: { type: "reasoning", text: excerpt + "…[truncated]" } } },
    }), "2026-11-17T12:00:00.000Z");
    const item = transcriptToTaskChatItems(entries, { runId: "reload", running: false })[0];
    expect(item.kind).toBe("thinking");
    if (item.kind !== "thinking") return;
    render(item.lines.join("\n"), true);
    expect(container.textContent).toContain("Stored excerpt");
    expect(container.textContent).toContain("The full thinking is kept in the run log.");
    expect(container.textContent).not.toContain("[truncated]");
  });
  it("has no container, indent or bullet; only the answer's own inset", () => {
    render(CODEX, true);
    const block = container.querySelector<HTMLElement>('[data-reasoning-display="inline"]')!;
    expect(block).not.toBeNull();
    expect(block.querySelector("ul, ol, li")).toBeNull();
    expect(block.querySelector(".rounded-full")).toBeNull();
    const ownTokens = block.className.split(/\s+/).filter(Boolean);
    expect(ownTokens).toContain(ANSWER_INSET);
    for (const node of chromeElements(block)) {
      const tokens = node.className.split(/\s+/).filter(Boolean)
        .filter((token) => !(node === block && token === ANSWER_INSET));
      expect(tokens.filter((token) => CONTAINER_TOKEN.test(token)), `${node.tagName} ${node.className}`).toEqual([]);
    }
  });

  it("renders each section as plain paragraphs: headline, then its prose", () => {
    render(CODEX, true);
    const block = container.querySelector<HTMLElement>('[data-reasoning-display="inline"]')!;
    const headlines = Array.from(block.querySelectorAll<HTMLElement>(".task-chat-reasoning-headline"));
    expect(headlines.map((node) => node.tagName)).toEqual(["P", "P"]);
    expect(headlines.map((node) => node.textContent)).toEqual(["Reading the adapter defaults", "Comparing with the runner"]);
    expect(block.querySelectorAll(".task-chat-reasoning-markdown")).toHaveLength(2);
  });

  it("keeps the italic, muted look; code stays upright; headline only a touch less muted", () => {
    render(CODEX, true);
    const block = container.querySelector<HTMLElement>('[data-reasoning-display="inline"]')!;
    const headline = block.querySelector<HTMLElement>(".task-chat-reasoning-headline")!;
    const body = block.querySelector<HTMLElement>(".task-chat-reasoning-markdown")!;
    const code = block.querySelector<HTMLElement>(".task-chat-reasoning-markdown code")!;
    expect(getComputedStyle(headline).fontStyle).toBe("italic");
    expect(getComputedStyle(body).fontStyle).toBe("italic");
    expect(getComputedStyle(code).fontStyle).toBe("normal");
    expect(getComputedStyle(body).color).toBe("var(--task-chat-reasoning-foreground)");
    expect(getComputedStyle(headline).color).toBe("var(--task-chat-reasoning-headline-foreground)");
    // In the plain flow the headline is at most a touch less muted than the body.
    const plain = reasoningLookCss().match(/\.task-chat-reasoning-plain[^{]*\{[^}]*--task-chat-reasoning-headline-foreground:\s*color-mix\(in oklab, var\(--foreground\) (\d+)%, var\(--muted-foreground\)\)/);
    expect(plain, "plain flow sets its own headline tone").not.toBeNull();
    expect(Number(plain![1])).toBeLessThanOrEqual(30);
  });

  it("uses the same typography tokens as the Markdown answer outside Coordinator", () => {
    render(CODEX, true);
    const plain = container.querySelector<HTMLElement>(".task-chat-reasoning-plain")!;
    // jsdom keeps var() unresolved; real computed px equality is covered by
    // tests/e2e/reasoning-size.spec.ts in both workspaces and both render paths.
    expect(getComputedStyle(plain).fontSize).toBe("var(--markdown-body-size)");
    expect(getComputedStyle(plain).lineHeight).toBe("var(--markdown-body-leading)");
    const markdown = Array.from(indexCss.matchAll(/^\.paperclip-markdown \{([^}]+)\}/gm), (match) => match[1])
      .find((rule) => rule.includes("font-size:"));
    expect(markdown).toContain("font-size: var(--markdown-body-size)");
    expect(markdown).toContain("line-height: var(--markdown-body-leading)");
  });

  it("uses the Coordinator answer's tokens rather than a copied size", () => {
    // Plain reasoning must use the final answer's body tokens, even when
    // Coordinator's later progress rule specifies its own typography.
    const coordinatorRules = indexCss.split("\n")
      .filter((line) => line.startsWith(".coordinator-workspace [data-conversation-text"))
      .join("\n");
    expect(coordinatorRules).toContain('[data-conversation-text="progress"]');
    const coordinatorStyle = document.createElement("style");
    coordinatorStyle.textContent = coordinatorRules;
    // Same cascade order as index.css: the coordinator rules come later.
    document.head.appendChild(coordinatorStyle);
    container.className = "coordinator-workspace";
    try {
      render(CODEX, true);
      const plain = container.querySelector<HTMLElement>('[data-reasoning-display="inline"] .task-chat-reasoning-plain')!;
      expect(plain).not.toBeNull();
      expect(getComputedStyle(plain).fontSize).toBe("var(--coordinator-body-size)");
      expect(getComputedStyle(plain).lineHeight).toBe("var(--coordinator-body-leading)");
      expect(coordinatorRules).toContain("font-size: var(--coordinator-body-size)");
      expect(coordinatorRules).toContain("line-height: var(--coordinator-body-leading)");
    } finally {
      coordinatorStyle.remove();
      container.className = "";
    }
  });

  it("leaves folded mode unchanged (bulleted sections)", () => {
    render(CODEX, false);
    expect(container.querySelector('[data-reasoning-display="inline"]')).toBeNull();
    const list = container.querySelector('[data-testid="task-chat-reasoning-sections"]')!;
    expect(list.tagName).toBe("UL");
    expect(list.querySelectorAll("li .rounded-full")).toHaveLength(2);
  });
});
