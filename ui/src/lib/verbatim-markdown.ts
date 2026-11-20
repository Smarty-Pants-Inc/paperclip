import { createRootEditorSubscription$ } from "@mdxeditor/editor";
import type { MDXEditorProps, RealmPlugin } from "@mdxeditor/editor";
import {
  $getSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
} from "lexical";
import type { ElementNode, LexicalNode } from "lexical";
import { fromMarkdown } from "mdast-util-from-markdown";

type ToMarkdownOptions = NonNullable<MDXEditorProps["toMarkdownOptions"]>;

/**
 * Export options for composers whose text goes to an agent verbatim.
 *
 * MDXEditor serializes through mdast-util-to-markdown, whose `text` handler
 * escapes any character that could start markdown (`*`, `~`, `` ` ``, `_`, `=`,
 * `<` ...). Those escapes are transport for a markdown re-import; a chat
 * message is read by the agent as written, so the person's own characters
 * must reach it unchanged. MDXEditor's documented `toMarkdownOptions` prop
 * takes mdast-util-to-markdown `handlers`; overriding `text` stops the escaping
 * while formatting the person applies (toolbar bold, lists, code blocks) is
 * still written by its own handler. A typed line break is sent as a newline,
 * not markdown's `\` hard break.
 */
export const VERBATIM_TO_MARKDOWN_OPTIONS: ToMarkdownOptions = {
  listItemIndent: "one",
  handlers: {
    text: (node: { value: string }) => node.value,
    break: () => "\n",
  },
} as ToMarkdownOptions;

/**
 * Pieces of a stored message the composer itself writes as markdown and shows
 * as objects: images (pasted or uploaded screenshots) and the links its
 * mention and slash-command pickers insert. They are imported as markdown so
 * they come back as the image or chip; the verbatim export writes them in the
 * same form.
 */
const EDITOR_OBJECT =
  /!\[[^[\]\n]*\]\([^()\s]+\)|\[[^[\]\n]*\]\((?:(?:agent|user|project|skill|routine):\/\/|\/issues\/)[^()\s]*\)/g;

function escapeLiteralText(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}

/**
 * The editor-space markdown for text a verbatim composer stored.
 *
 * A verbatim composer stores exactly what the person typed, so its value is
 * text, not markdown: `__bold__` is eight characters, not strong emphasis.
 * MDXEditor's `markdown` prop and `setMarkdown` always parse markdown
 * (https://mdxeditor.dev/editor/docs/getting-started, "markdown" / ref
 * `setMarkdown`), and it has no documented plain-text setter. So a restored
 * draft is handed to it as markdown that parses back to the same characters:
 * every ASCII punctuation character is backslash-escaped (CommonMark 2.4: an
 * escaped punctuation character is literal), every newline is a hard break
 * (`\` before the line ending, CommonMark 6.7), which the verbatim export
 * writes back as a newline, and spaces or tabs at a line's start or end are
 * character references (CommonMark 2.5), which the parser would otherwise
 * strip. Images and picker links stay markdown (EDITOR_OBJECT). Exporting
 * the result with VERBATIM_TO_MARKDOWN_OPTIONS yields the original text,
 * byte for byte.
 */
export function verbatimTextToEditorMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      let out = "";
      let last = 0;
      for (const match of line.matchAll(EDITOR_OBJECT)) {
        out += escapeLiteralText(line.slice(last, match.index)) + match[0];
        last = match.index + match[0].length;
      }
      out += escapeLiteralText(line.slice(last));
      return out.replace(/^[ \t]+|[ \t]+$/g, (space) => space.replace(/ /g, "&#32;").replace(/\t/g, "&#9;"));
    })
    .join("\\\n");
}

interface OpenFence {
  marker: "`" | "~";
  length: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Whether these lines leave a fenced code block open, per CommonMark 4.5: a
 * fence opens with three or more backticks or tildes (a backtick opener's info
 * string has no backtick) and closes only on a line of the same character, at
 * least as long, with nothing after it but spaces or tabs. A shorter fence or
 * the other character inside the block is content.
 */
export function openFenceAfter(lines: readonly string[]): OpenFence | null {
  let open: OpenFence | null = null;
  for (const line of lines) {
    if (open) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === open.marker && close[1].length >= open.length) open = null;
      continue;
    }
    const opener = FENCE_OPEN.exec(line);
    if (!opener) continue;
    const marker = opener[1][0] as OpenFence["marker"];
    if (marker === "`" && opener[2].includes("`")) continue;
    open = { marker, length: opener[1].length };
  }
  return open;
}

/**
 * A person typing a fence presses Enter after the opening ``` line. Even with
 * markdown typing shortcuts disabled, Lexical's ordinary Enter makes a new
 * paragraph, which exports with a blank line. While a typed fence is open
 * before the caret, Enter adds a line break inside the same paragraph instead;
 * the paragraph then exports as the exact fence typed.
 */
export function typedFencePlugin(): RealmPlugin {
  return {
    init(realm) {
      realm.pub(createRootEditorSubscription$, [
        (editor) =>
          editor.registerCommand(
            KEY_ENTER_COMMAND,
            (event) => {
              if (event?.shiftKey) return false;
              const selection = $getSelection();
              if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
              const anchor = selection.anchor;
              let child: LexicalNode = anchor.getNode();
              let block: LexicalNode = child;
              let parent = block.getParent();
              while (parent && !$isRootOrShadowRoot(parent)) {
                child = block;
                block = parent;
                parent = block.getParent();
              }
              if (block.getType() !== "paragraph") return false;
              // The text before the caret: whole inline siblings before the
              // caret's own, plus that node's text up to the caret.
              let before = "";
              if (child === block) {
                before = block.getTextContent();
              } else {
                for (const sibling of (block as ElementNode).getChildren()) {
                  if (sibling.is(child)) break;
                  before += sibling.getTextContent();
                }
                before += anchor.type === "text" && child.is(anchor.getNode())
                  ? child.getTextContent().slice(0, anchor.offset)
                  : child.getTextContent();
              }
              if (!openFenceAfter(before.split("\n"))) return false;
              event?.preventDefault();
              selection.insertLineBreak();
              return true;
            },
            COMMAND_PRIORITY_HIGH,
          ),
      ]);
    },
  };
}

interface SourceNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SourceNode[];
}

/**
 * The person's text from a draft an older build stored as markdown: what its
 * markdown import showed. Text keeps its characters with the escapes and
 * character references resolved (`a\*b\*c` is `a*b*c`), a hard break is a
 * newline, and every other construct (formatting, links, images, code) keeps
 * its source, as the older build would have sent it.
 */
export function legacyMarkdownDraftToText(markdown: string): string {
  const source = markdown.replace(/\r\n?/g, "\n");
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: SourceNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((node.type === "text" || node.type === "break") && start !== undefined && end !== undefined) {
      edits.push({ start, end, text: node.type === "text" ? node.value ?? "" : "\n" });
      return;
    }
    if (node.type === "paragraph" || node.type === "root" || node.type === "strong" || node.type === "emphasis"
      || node.type === "heading" || node.type === "blockquote" || node.type === "list" || node.type === "listItem"
      || node.type === "link") {
      node.children?.forEach(visit);
    }
  };
  visit(fromMarkdown(source) as SourceNode);
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
