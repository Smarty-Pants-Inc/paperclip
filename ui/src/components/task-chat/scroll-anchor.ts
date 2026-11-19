/** How close to the end of a thread counts as "at the end" (following it, caught up). */
export const PIN_THRESHOLD_PX = 48;

/** One policy for the scroller's pinning and for chat read receipts. */
export function isScrolledToEnd(el: Element): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
}

/** Keep a reading position by logical row identity, not total scroll height. */
export interface ThreadScrollAnchor {
  id: string;
  top: number;
}

export function readThreadScrollAnchor(root: Element, viewportTop: number, viewportBottom: number): ThreadScrollAnchor | null {
  for (const row of root.querySelectorAll<HTMLElement>("[data-thread-anchor]")) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > viewportTop && rect.top < viewportBottom) {
      return { id: row.dataset.threadAnchor!, top: rect.top - viewportTop };
    }
  }
  return null;
}

export function threadScrollAnchorDelta(root: Element, anchor: ThreadScrollAnchor | null, viewportTop: number): number {
  if (!anchor) return 0;
  // IDs are opaque and need not be safe CSS selectors.
  for (const row of root.querySelectorAll<HTMLElement>("[data-thread-anchor]")) {
    if (row.dataset.threadAnchor === anchor.id) {
      return row.getBoundingClientRect().top - viewportTop - anchor.top;
    }
  }
  return 0;
}
