import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

export type OutputPageState = "idle" | "loading" | "error";

/** One direction of saved-run-log paging, as offered by a bounded transcript buffer. */
export interface OutputPage {
  available: boolean;
  state: OutputPageState;
  load: () => void;
}

/**
 * "Show earlier output" / "Show later output". Output that left browser memory
 * is still in the saved run log; this control (or scrolling to that edge) reads
 * it back in place. A failed read says so and offers Retry, never a silent gap.
 */
export function OutputPageControl({ direction, page, onBeforeLoad }: {
  direction: "earlier" | "later";
  page?: OutputPage;
  onBeforeLoad?: () => void;
}) {
  if (!page?.available) return null;
  const load = () => { onBeforeLoad?.(); page.load(); };
  if (page.state === "error") {
    return (
      <p role="alert" className="text-sm text-muted-foreground" data-output-page={direction}>
        Couldn't load {direction} output.{" "}
        <button type="button" className="text-foreground underline underline-offset-4" onClick={load}>Retry</button>
      </p>
    );
  }
  return (
    <button
      type="button"
      className="text-sm text-foreground underline underline-offset-4 disabled:no-underline disabled:text-muted-foreground"
      disabled={page.state === "loading"}
      aria-busy={page.state === "loading"}
      data-output-page={direction}
      onClick={load}
    >
      {page.state === "loading" ? `Loading ${direction} output…` : `Show ${direction} output`}
    </button>
  );
}

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  let parent = element?.parentElement ?? null;
  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);
    if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
    parent = parent.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/**
 * Keep the reader's place while output pages in above or below: remember the
 * first visible block before the load, and after the window changes move the
 * scroll position so that block sits exactly where it was.
 */
export function useOutputPageAnchor(rootRef: RefObject<HTMLElement | null>, change: unknown, loading: boolean) {
  const anchorRef = useRef<{ key: string; top: number } | null>(null);
  const capture = () => {
    const root = rootRef.current;
    const container = scrollParent(root);
    if (!root || !container) return;
    const containerTop = container.getBoundingClientRect().top;
    for (const element of root.querySelectorAll<HTMLElement>("[data-output-anchor]")) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > containerTop) {
        anchorRef.current = { key: element.dataset.outputAnchor!, top: rect.top };
        return;
      }
    }
  };
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const root = rootRef.current;
    if (anchor && root) {
      const element = [...root.querySelectorAll<HTMLElement>("[data-output-anchor]")].find((node) => node.dataset.outputAnchor === anchor.key);
      const container = scrollParent(root);
      if (element && container) container.scrollTop += element.getBoundingClientRect().top - anchor.top;
    }
    if (!loading) anchorRef.current = null;
  }, [change, loading, rootRef]);
  return capture;
}

/** Load the next page when the reader scrolls to the edge of the window. */
export function OutputPageEdge({ page, onBeforeLoad }: { page?: OutputPage; onBeforeLoad?: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const beforeRef = useRef(onBeforeLoad);
  beforeRef.current = onBeforeLoad;
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((records) => {
      const current = pageRef.current;
      if (records.some((record) => record.isIntersecting) && current?.available && current.state === "idle") {
        beforeRef.current?.();
        current.load();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [page?.available]);
  return page?.available ? <div ref={ref} aria-hidden="true" className="h-px" /> : null;
}
