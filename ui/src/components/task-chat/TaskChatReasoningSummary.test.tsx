// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChatReasoningSummary } from "./TaskChatReasoningSummary";

// The reasoning look lives in index.css on the existing hooks
// (.task-chat-reasoning-markdown, .task-chat-reasoning-headline). jsdom cannot
// load the whole Tailwind sheet, so the test loads exactly the marked block.
const indexCss = readFileSync(path.resolve(__dirname, "../../index.css"), "utf8");
function reasoningLookCss() {
  const match = indexCss.match(/\/\* reasoning-look:start[\s\S]*?\/\* reasoning-look:end \*\//);
  expect(match, "index.css has a marked reasoning-look block").not.toBeNull();
  return match![0];
}

let container: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

beforeEach(() => {
  style = document.createElement("style");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  style.remove();
});

function render(text: string) {
  style.textContent = reasoningLookCss();
  document.head.appendChild(style);
  flushSync(() => root.render(<TaskChatReasoningSummary text={text} />));
}

describe("reasoning text look", () => {
  it("renders prose-only reasoning (Claude) in italics", () => {
    render("I should read the config first, then compare it with the docs.");
    const prose = container.querySelector<HTMLElement>(".task-chat-reasoning-markdown")!;
    expect(prose).not.toBeNull();
    expect(getComputedStyle(prose).fontStyle).toBe("italic");
  });

  it("renders headlines and their bodies (Codex) in italics", () => {
    render("**Checking the config**\n\nThe default lives in the adapter.\n\n**Comparing docs**\n\nThe docs agree.");
    const headlines = Array.from(container.querySelectorAll<HTMLElement>(".task-chat-reasoning-headline"));
    const bodies = Array.from(container.querySelectorAll<HTMLElement>(".task-chat-reasoning-markdown"));
    expect(headlines.map((node) => node.textContent)).toEqual(["Checking the config", "Comparing docs"]);
    expect(bodies).toHaveLength(2);
    for (const node of [...headlines, ...bodies]) expect(getComputedStyle(node).fontStyle).toBe("italic");
  });

  it("is muted against the reply: no reasoning text uses the full reply colour", () => {
    render("**Checking the config**\n\nThe default lives in the adapter.");
    const headline = container.querySelector<HTMLElement>(".task-chat-reasoning-headline")!;
    const body = container.querySelector<HTMLElement>(".task-chat-reasoning-markdown")!;
    // Headline: a step quieter than the reply; body: the muted tier.
    expect(headline.className).not.toMatch(/(^|\s)text-foreground(\s|$)/);
    expect(getComputedStyle(headline).color).toBe("var(--task-chat-reasoning-headline-foreground)");
    expect(getComputedStyle(body).color).toBe("var(--task-chat-reasoning-foreground)");
    const css = reasoningLookCss();
    expect(css).toMatch(/--task-chat-reasoning-foreground:\s*var\(--muted-foreground\)/);
    expect(css).toMatch(/--task-chat-reasoning-headline-foreground:\s*color-mix\(in oklab, var\(--foreground\) \d+%, var\(--muted-foreground\)\)/);
  });

  it("keeps emphasis readable inside italic reasoning", () => {
    render("I *must not* change the agent row.");
    const em = container.querySelector<HTMLElement>(".task-chat-reasoning-markdown em")!;
    expect(em).not.toBeNull();
    expect(getComputedStyle(em).fontStyle).toBe("normal");
  });

  it("adds no one-edge accent stripe (smarty-design rule)", () => {
    expect(reasoningLookCss()).not.toMatch(/border-(left|right|top|bottom|inline-start|inline-end|block-start|block-end)\s*:|box-shadow\s*:\s*inset/);
  });
});
