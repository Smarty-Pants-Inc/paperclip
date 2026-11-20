import { fromMarkdown } from "mdast-util-from-markdown";

/** T3 f2d4df0 TimelineWorkGroupRows.tsx:603–646; change to 0 for label-only. */
export const REASONING_COLLAPSED_PREVIEW_LINES: number = 4;

/** T3 bounds parsing to 8192 source characters and its inline preview to 2048. */
export function reasoningPreviewText(text: string): string {
  const tree = fromMarkdown(text.slice(0, 8192));
  const fragments: string[] = [];
  function visit(node: (typeof tree) | (typeof tree.children)[number]): void {
    if (node.type === "html" || node.type === "definition") return;
    if ("alt" in node) fragments.push(node.alt ?? "");
    else if ("value" in node) fragments.push(node.value);
    else if ("children" in node) {
      for (const [index, child] of node.children.entries()) {
        if (index && ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(node.type)) fragments.push(" ");
        visit(child);
      }
    } else if (node.type === "break") fragments.push(" ");
  }
  visit(tree);
  return fragments.join("").replace(/\s+/g, " ").trim().slice(0, 2048).replace(/[\uD800-\uDBFF]$/, "");
}
