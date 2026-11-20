// Test-only: the real markdown import and export the composer's MDXEditor
// runs, resolved from MDXEditor's own dependency tree (no mocks, no copies).
import { createRequire } from "node:module";
import type { fromMarkdown } from "mdast-util-from-markdown";
import { VERBATIM_TO_MARKDOWN_OPTIONS } from "./verbatim-markdown";

const requireFromEditor = createRequire(createRequire(import.meta.url).resolve("@mdxeditor/editor"));
const { toMarkdown } = requireFromEditor("mdast-util-to-markdown");
const { fromMarkdown: parseMarkdown } = requireFromEditor("mdast-util-from-markdown") as { fromMarkdown: typeof fromMarkdown };
const { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } = requireFromEditor("mdast-util-gfm-strikethrough");
const { gfmStrikethrough } = requireFromEditor("micromark-extension-gfm-strikethrough");
const { gfmTableFromMarkdown, gfmTableToMarkdown } = requireFromEditor("mdast-util-gfm-table");
const { gfmTable } = requireFromEditor("micromark-extension-gfm-table");
const { gfmTaskListItemFromMarkdown, gfmTaskListItemToMarkdown } = requireFromEditor("mdast-util-gfm-task-list-item");
const { gfmTaskListItem } = requireFromEditor("micromark-extension-gfm-task-list-item");
const { highlightMarkFromMarkdown } = requireFromEditor("mdast-util-highlight-mark");
const { highlightMark } = requireFromEditor("micromark-extension-highlight-mark");

export type Root = ReturnType<typeof fromMarkdown>;

/** MDXEditor's import with the syntax the composer's plugins register (core, lists, table; HTML suppressed). */
export function importMarkdown(markdown: string): Root {
  return parseMarkdown(markdown, {
    extensions: [gfmStrikethrough(), highlightMark(), gfmTaskListItem(), gfmTable()],
    mdastExtensions: [gfmStrikethroughFromMarkdown(), highlightMarkFromMarkdown, gfmTaskListItemFromMarkdown(), gfmTableFromMarkdown()],
  });
}

/** MDXEditor's export; it publishes the serializer's result with .trim() (core/index.js). */
export function exportMarkdown(tree: Root, options: object = {}): string {
  return (toMarkdown(tree, {
    extensions: [
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown({ tableCellPadding: true, tablePipeAlign: true }),
      gfmTaskListItemToMarkdown(),
    ],
    ...options,
  }) as string).trim();
}

/** What the composer's editor holds and sends after importing `markdown`. */
export function verbatimRoundTrip(markdown: string): string {
  return exportMarkdown(importMarkdown(markdown), VERBATIM_TO_MARKDOWN_OPTIONS);
}
