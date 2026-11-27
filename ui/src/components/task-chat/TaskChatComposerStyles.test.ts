import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);

  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  expect(bodyEnd, `Missing CSS block end: ${selector}`).toBeGreaterThan(bodyStart);

  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

function customPropertyValue(name: string): string {
  const match = stylesheet.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"));
  expect(match, `Missing CSS custom property: ${name}`).not.toBeNull();
  return match?.[1].trim() ?? "";
}

describe("task-chat composer styles", () => {
  it("bounds the phone-only card to 52px at rest and five text lines before scrolling", () => {
    const card = cssBlock('.paperclip-task-chat-composer[data-composer-layout="phone-row"]');
    expect(card).toContain("min-height: var(--sz-52px)");
    expect(card).toContain("--tc-composer-editor-max-height: calc(5 * var(--tc-phone-row-line-height)");
    const editor = cssBlock('[data-composer-layout="phone-row"] .task-chat-phone-editor');
    expect(editor).toContain("min-height: var(--sz-44px)");
    expect(editor).toContain("max-height: var(--tc-composer-editor-max-height)");
    expect(editor).toContain("overflow-y: auto");
    expect(editor).toContain("padding: 0 !important");
    expect(editor).toContain("border-block: var(--tc-phone-row-text-inset) solid transparent");
    const row = cssBlock('[data-composer-layout="phone-row"] .task-chat-composer-row');
    expect(row).toContain("align-items: flex-end");
    const phoneRules = stylesheet.slice(stylesheet.indexOf("/* Phone composer row"), stylesheet.indexOf("\n.paperclip-mdxeditor-content {"));
    expect(phoneRules).toContain("@media (max-width: 767px)");
    expect(phoneRules).not.toContain("task-chat-status-line");
    expect(cssBlock('[data-composer-layout="phone-row"] .task-chat-composer-row button')).toContain("min-height: var(--sz-44px)");
  });

  it("covers transcript text and blocks clicks across the Coordinator footer", () => {
    const block = cssBlock('.coordinator-workspace .task-chat-composer-dock');

    expect(block).toContain("background: var(--background)");
    expect(block).toContain("pointer-events: auto");
    expect(block).not.toContain("border-radius");
  });

  it("wraps long placeholders within the composer instead of clipping them", () => {
    const block = cssBlock(
      '.paperclip-task-chat-composer .paperclip-mdxeditor [class*="_placeholder_"]',
    );

    expect(block).toContain("display: block");
    expect(block).toContain("width: 100%");
    expect(block).toContain("overflow-wrap: anywhere");
    expect(block).toContain("white-space: normal");
  });

  it("keeps the composer's combined shadow valid with full-color semantic tokens", () => {
    const shadow = customPropertyValue("--shadow-extract-7");

    expect(shadow).toContain("color-mix(in oklab, var(--primary) 16%, transparent)");
    expect(shadow).not.toContain("hsl(var(");
  });
});
