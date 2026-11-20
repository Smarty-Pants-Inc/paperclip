import { createRootEditorSubscription$ } from "@mdxeditor/editor";
import type { MDXEditorProps, RealmPlugin } from "@mdxeditor/editor";
import {
  $getSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
} from "lexical";

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

const FENCE_LINE = /^\s*(```|~~~)/;

/**
 * A person typing a fence presses Enter after the opening ``` line. Lexical's
 * markdown shortcut then turns the paragraph into an empty code block without
 * moving the caret into it, so the rest of the fence lands as escaped prose.
 * While a typed fence is open, Enter adds a line break inside the same
 * paragraph instead; the paragraph then exports as the exact fence typed.
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
              let block = selection.anchor.getNode();
              let parent = block.getParent();
              while (parent && !$isRootOrShadowRoot(parent)) {
                block = parent;
                parent = block.getParent();
              }
              if (block.getType() !== "paragraph") return false;
              const fenceLines = block
                .getTextContent()
                .split("\n")
                .filter((line) => FENCE_LINE.test(line)).length;
              if (fenceLines % 2 === 0) return false;
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
