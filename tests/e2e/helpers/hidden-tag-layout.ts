import { expect, type Locator, type TestInfo } from "@playwright/test";

/** Unlike toBeInViewport(), require the entire badge to fit, not just intersect. */
export async function expectHiddenTagLayout(row: Locator, testInfo: TestInfo, name: string) {
  await expect(row.locator('[data-slot="hidden-task-badge"]')).toHaveText("Hidden");
  const layout = await row.evaluate(async (element) => {
    await document.fonts.ready;
    const badge = element.querySelector<HTMLElement>('[data-slot="hidden-task-badge"]')!;
    const title = element.querySelector<HTMLElement>('[data-slot="task-row-title"]')!;
    const text = title.querySelector<HTMLElement>('[data-slot="task-row-title-text"]') ?? title;
    const rect = (node: Element) => {
      const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const range = document.createRange();
    range.selectNodeContents(text);
    const clippingAncestors = [];
    for (let parent = badge.parentElement; parent; parent = parent.parentElement) {
      if (/(hidden|clip|auto|scroll)/.test(getComputedStyle(parent).overflowX)) {
        clippingAncestors.push(rect(parent));
      }
    }
    return {
      row: rect(element), badge: rect(badge), title: rect(title),
      titleTextWidth: range.getBoundingClientRect().width,
      titleOverflow: getComputedStyle(title).textOverflow,
      viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
      clippingAncestors,
    };
  });
  await testInfo.attach(`${name}-layout`, { body: JSON.stringify(layout, null, 2), contentType: "application/json" });
  console.log(`${name}: ${JSON.stringify(layout)}`);
  expect(layout.badge.right, "Hidden tag must fit inside its row").toBeLessThanOrEqual(layout.row.right);
  expect(layout.badge.left).toBeGreaterThanOrEqual(layout.row.left);
  expect(layout.badge.top).toBeGreaterThanOrEqual(layout.row.top);
  expect(layout.badge.bottom).toBeLessThanOrEqual(layout.row.bottom);
  expect(layout.badge.right, "Hidden tag must fit inside the viewport").toBeLessThanOrEqual(layout.viewport.width);
  expect(layout.badge.left).toBeGreaterThanOrEqual(0);
  expect(layout.badge.top).toBeGreaterThanOrEqual(0);
  expect(layout.badge.bottom).toBeLessThanOrEqual(layout.viewport.height);
  for (const ancestor of layout.clippingAncestors) {
    expect(layout.badge.right, "Hidden tag must not be clipped by an ancestor").toBeLessThanOrEqual(ancestor.right);
    expect(layout.badge.left).toBeGreaterThanOrEqual(ancestor.left);
  }
  expect(layout.title.right, "Title must leave room for the badge").toBeLessThanOrEqual(layout.badge.left);
  if (layout.viewport.width === 390) {
    expect(layout.titleTextWidth, "On phone, truncate the title instead of the badge").toBeGreaterThan(layout.title.width);
    expect(layout.titleOverflow).toBe("ellipsis");
  }
}
