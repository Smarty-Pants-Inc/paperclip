// @vitest-environment jsdom

import { createRequire } from "node:module";
import type { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import { legacyMarkdownDraftToText, openFenceAfter, VERBATIM_TO_MARKDOWN_OPTIONS, verbatimTextToEditorMarkdown } from "./verbatim-markdown";
import { importMarkdown } from "./verbatim-markdown.testkit";

// Resolve the editor's actual serializer dependencies, not another copy or a
// mock. These are MDXEditor's dependencies, not new application dependencies.
const requireFromEditor = createRequire(createRequire(import.meta.url).resolve("@mdxeditor/editor"));
const { toMarkdown } = requireFromEditor("mdast-util-to-markdown");
const { gfmStrikethroughToMarkdown } = requireFromEditor("mdast-util-gfm-strikethrough");
const { gfmTableToMarkdown } = requireFromEditor("mdast-util-gfm-table");
const { gfmTaskListItemToMarkdown } = requireFromEditor("mdast-util-gfm-task-list-item");

type Root = ReturnType<typeof fromMarkdown>;

/** Lexical keeps text, line breaks and paragraphs; positions are not content. */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  const { position: _position, ...rest } = node as Record<string, unknown>;
  return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, strip(value)]));
}

function nodeTypes(node: { type: string; children?: unknown[] }): string[] {
  return [node.type, ...((node.children ?? []) as { type: string }[]).flatMap(nodeTypes)];
}

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

const BACKSLASH_INPUTS = [String.raw`a\_b`, String.raw`a\=b`, String.raw`a\<b`, String.raw`\>`];

describe("verbatim composer text through the whole pipeline", () => {
  // Editor content (a typed text node) -> verbatim export -> what the composer
  // stores and sends. The stored value is the export: no cleanup pass runs.
  it.each([...BACKSLASH_INPUTS, ...cases.map(({ input }) => input)])("exports %j exactly", (input) => {
    const typed: Root = {
      type: "root",
      children: [{
        type: "paragraph",
        children: input.split("\n").flatMap((line, index) =>
          index === 0 ? [{ type: "text" as const, value: line }] : [{ type: "break" as const }, { type: "text" as const, value: line }]),
      }],
    };
    expect(serialize(typed, VERBATIM_TO_MARKDOWN_OPTIONS)).toBe(input);
  });

  const drafts = [
    ...BACKSLASH_INPUTS,
    ...cases.map(({ input }) => input),
    "__bold__",
    "**bold** and *it* ~~gone~~ ==mark== `code`",
    "# not a heading\n- not a list\n1. not ordered\n> not a quote\n---\n===",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    // MDXEditor trims the whole export (core), so only inner lines carry edge space.
    "start\n    four spaces\n\ttab\nend  \n\nafter a blank line\n\n\nthree",
    "~~~\ninside ``` stays\n~~~",
    "````\n```\nnested\n```\n````",
    "trailing backslash \\\nnext",
    "&amp; &#32; [x](y) <b> {curly} :colon: @someone https://example.com",
  ];

  it.each(drafts)("restores draft %j as literal text that exports byte for byte", (draft) => {
    const tree = importMarkdown(verbatimTextToEditorMarkdown(draft));
    // One paragraph of text and line breaks: nothing became markdown.
    expect(new Set(nodeTypes(tree))).toEqual(new Set(["root", "paragraph", "text", ...(draft.includes("\n") ? ["break"] : [])]));
    expect(serialize(tree, VERBATIM_TO_MARKDOWN_OPTIONS)).toBe(draft);
  });

  it.each([
    "Inspect this image\n\n![sample.png](/api/attachments/a1/content)",
    "ask [@Builder](agent://agent-1) and [PAP-12](/issues/PAP-12) then [/review](skill://s1/review) __x__",
  ])("restores the composer's own images and picker links as objects, the rest as text: %j", (draft) => {
    const tree = importMarkdown(verbatimTextToEditorMarkdown(draft));
    const types = nodeTypes(tree);
    expect(types.includes("image") || types.includes("link")).toBe(true);
    expect(types).not.toContain("strong");
    expect(serialize(tree, VERBATIM_TO_MARKDOWN_OPTIONS)).toBe(draft);
  });

  it("restores '__bold__', then the person types '!': the composer sends '__bold__!'", () => {
    const restored = importMarkdown(verbatimTextToEditorMarkdown("__bold__"));
    const paragraphNode = (restored.children[0] as { children: { type: string; value?: string }[] });
    expect(strip(paragraphNode.children)).toEqual([{ type: "text", value: "__bold__" }]);
    paragraphNode.children[0].value += "!";
    expect(serialize(restored, VERBATIM_TO_MARKDOWN_OPTIONS)).toBe("__bold__!");
    // The markdown import the editor used before turned the draft into strong text.
    const asMarkdown = importMarkdown("__bold__");
    expect(nodeTypes(asMarkdown)).toContain("strong");
  });
});

describe("typed fence tracking (CommonMark fenced code)", () => {
  it.each([
    { lines: ["```"], open: { marker: "`", length: 3 } },
    { lines: ["~~~"], open: { marker: "~", length: 3 } },
    { lines: ["```", "code", "```"], open: null },
    { lines: ["~~~", "```", "still code"], open: { marker: "~", length: 3 } },
    { lines: ["~~~", "```", "~~~"], open: null },
    { lines: ["````", "```", "nested"], open: { marker: "`", length: 4 } },
    { lines: ["````", "```", "nested", "```"], open: { marker: "`", length: 4 } },
    { lines: ["````", "```", "nested", "```", "````"], open: null },
    { lines: ["~~~", "~~~~~"], open: null },
    { lines: ["~~~~", "~~~"], open: { marker: "~", length: 4 } },
    { lines: ["```", "``` not a closer"], open: { marker: "`", length: 3 } },
    { lines: ["``` js`x"], open: null },
    { lines: ["    ```"], open: null },
    { lines: ["prose", "   ```py"], open: { marker: "`", length: 3 } },
    { lines: ["``"], open: null },
  ])("$lines -> $open", ({ lines, open }) => {
    expect(openFenceAfter(lines)).toEqual(open);
  });
});

describe("drafts an older build stored as markdown", () => {
  it.each([
    [String.raw`a\*b\*c`, "a*b*c"],
    [String.raw`\_\_bold\_\_`, "__bold__"],
    ["**bold** and [@Builder](agent://agent-1)", "**bold** and [@Builder](agent://agent-1)"],
    [String.raw`2 \* 3 \~ x&#x20;`, "2 * 3 ~ x "],
    ["line one\\\nline two", "line one\nline two"],
    ["```py\nprint('a\\_b')\n```", "```py\nprint('a\\_b')\n```"],
    ["plain words", "plain words"],
    ["[https://example.com/a_b/~user?q=x_y](https://example.com/a_b/~user?q=x_y)", "https://example.com/a_b/~user?q=x_y"],
    [String.raw`https://example.com/a\_b/\~user?q=x\_y`, "https://example.com/a_b/~user?q=x_y"],
    [String.raw`[https://example.com/a\_b/\~user?q=x\_y](https://example.com/a_b/~user?q=x_y)`, "https://example.com/a_b/~user?q=x_y"],
    [String.raw`[https://example.com/a\_b](https://example.com/a\_b)`, "https://example.com/a_b"],
    ["before [https://x/a_b](https://x/a_b) after", "before https://x/a_b after"],
    // A real link keeps its markdown structure, with child-text escapes resolved.
    [String.raw`[different\_text](https://example.com/a_b)`, "[different_text](https://example.com/a_b)"],
    ["[https://example.com](https://example.com/)", "[https://example.com](https://example.com/)"],
    ["[https://example.com/](https://example.com)", "[https://example.com/](https://example.com)"],
    ["[**https://example.com**](https://example.com)", "[**https://example.com**](https://example.com)"],
    ["[https://example.com`/a`](https://example.com/a)", "[https://example.com`/a`](https://example.com/a)"],
  ])("restores %j as the person's text %j", (stored, text) => {
    expect(legacyMarkdownDraftToText(stored)).toBe(text);
  });
});
