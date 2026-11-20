// @vitest-environment jsdom

import { createRequire } from "node:module";
import type { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import { VERBATIM_TO_MARKDOWN_OPTIONS } from "./verbatim-markdown";

// Resolve the editor's actual serializer dependencies, not another copy or a
// mock. These are MDXEditor's dependencies, not new application dependencies.
const requireFromEditor = createRequire(createRequire(import.meta.url).resolve("@mdxeditor/editor"));
const { toMarkdown } = requireFromEditor("mdast-util-to-markdown");
const { gfmStrikethroughToMarkdown } = requireFromEditor("mdast-util-gfm-strikethrough");
const { gfmTableToMarkdown } = requireFromEditor("mdast-util-gfm-table");
const { gfmTaskListItemToMarkdown } = requireFromEditor("mdast-util-gfm-task-list-item");

type Root = ReturnType<typeof fromMarkdown>;

function paragraph(value: string): Root {
  return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] };
}

function serialize(tree: Root, options = {}) {
  // core, table and lists plugins register these GFM export extensions.
  // MDXEditor publishes the serializer's result with .trim() (core/index.js).
  return (toMarkdown(tree, {
    extensions: [
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown({ tableCellPadding: true, tablePipeAlign: true }),
      gfmTaskListItemToMarkdown(),
    ],
    ...options,
  }) as string).trim();
}

const fence = "```\nls -la ~/x_y\n```";
const cases: { name: string; input: string; tree: Root }[] = [
  { name: "equals", input: "a == b", tree: paragraph("a == b") },
  { name: "angle brackets", input: "<tag>", tree: paragraph("<tag>") },
  { name: "underscores", input: "x_y_z", tree: paragraph("x_y_z") },
  { name: "literal asterisks", input: "2 * 3 * 4", tree: paragraph("2 * 3 * 4") },
  {
    name: "pasted code fence",
    input: fence,
    tree: { type: "root", children: [{ type: "code", lang: "", value: "ls -la ~/x_y" }] },
  },
  {
    name: "Windows path",
    input: String.raw`C:\Users\paul\file_name.txt`,
    tree: paragraph(String.raw`C:\Users\paul\file_name.txt`),
  },
  {
    // Auto-linking is disabled in verbatim mode, so this is text, not a link.
    name: "bare URL",
    input: "https://example.com/a_b/~user?q=x_y",
    tree: paragraph("https://example.com/a_b/~user?q=x_y"),
  },
];

const typedFence: Root = {
  type: "root",
  children: [{
    type: "paragraph",
    children: [
      { type: "text", value: "```" },
      { type: "break" },
      { type: "text", value: "ls -la ~/x_y" },
      { type: "break" },
      { type: "text", value: "```" },
    ],
  }],
};

describe("verbatim composer markdown serialization", () => {
  it("witnesses the default serializer escaping literal asterisks", () => {
    expect(serialize(paragraph("2 * 3 * 4"))).toBe(String.raw`2 \* 3 \* 4`);
  });

  it("witnesses GFM escaping a tilde even in a plain-text URL", () => {
    const output = serialize(paragraph("https://example.com/a_b/~user?q=x_y"));
    expect(output).toContain(String.raw`\~user`);
    expect(output).not.toBe("https://example.com/a_b/~user?q=x_y");
  });

  it.each(cases)("sends $name exactly as entered", ({ input, tree }) => {
    expect(serialize(tree, VERBATIM_TO_MARKDOWN_OPTIONS)).toBe(input);
  });

  it("preserves a typed fence represented by paragraph text and line breaks", () => {
    // This is the export shape produced while typedFencePlugin keeps Enter in
    // the paragraph. This row tests serialization, not keyboard interception.
    expect(serialize(typedFence)).not.toBe(fence);
    expect(serialize(typedFence, VERBATIM_TO_MARKDOWN_OPTIONS)).toBe(fence);
  });

  it.each([
    { name: "default", options: {} },
    { name: "verbatim", options: VERBATIM_TO_MARKDOWN_OPTIONS },
  ])("keeps intentional strong formatting and paragraph breaks ($name)", ({ options }) => {
    expect(serialize({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "strong", children: [{ type: "text", value: "bold" }] }] }],
    }, options)).toBe("**bold**");
    expect(serialize({
      type: "root",
      children: [paragraph("line one").children[0], paragraph("line two").children[0]],
    }, options)).toBe("line one\n\nline two");
  });

  it("exports a hard break as a newline only in verbatim mode", () => {
    const tree: Root = {
      type: "root",
      children: [{ type: "paragraph", children: [
        { type: "text", value: "line one" }, { type: "break" }, { type: "text", value: "line two" },
      ] }],
    };
    expect(serialize(tree)).toBe("line one\\\nline two");
    expect(serialize(tree, VERBATIM_TO_MARKDOWN_OPTIONS)).toBe("line one\nline two");
  });
});
