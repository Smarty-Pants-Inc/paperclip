import { expect, test, type APIResponse, type Page, type Locator } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
// Opt in where Playwright's ffmpeg is provisioned; screenshots are unconditional.
test.use({ video: process.env.PAPERCLIP_TAB_BAR_VIDEO === "1" ? "on" : "off" });
const nav = (page: Page) => page.locator('nav[aria-label="Mobile navigation"]');
const bar = (page: Page) => page.getByTestId("mobile-tab-bar");
async function keyboard(page: Page, open: boolean) {
  await page.evaluate(open => {
    Object.defineProperty(visualViewport!, "height", { configurable: true, value: document.documentElement.clientHeight - (open ? 336 : 0) });
    visualViewport!.dispatchEvent(new Event("resize"));
  }, open);
}
async function geometry(page: Page, safe = 34) {
  await expect(bar(page)).toBeVisible();
  const viewport = page.viewportSize()!;
  await expect.poll(async () => Math.abs((await bar(page).boundingBox())!.y - (viewport.height - Math.max(8, safe) - 48))).toBeLessThanOrEqual(1);
  const box = (await bar(page).boundingBox())!;
  expect(Math.abs(box.height - 48)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.x - 14)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewport.width - box.x - box.width - 14)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewport.height - box.y - box.height - Math.max(8, safe))).toBeLessThanOrEqual(1);
  const items = nav(page).locator("a, button");
  await expect(items).toHaveCount(4);
  expect(await items.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") ?? node.textContent))).toEqual(["Chat", "Tasks", "Inbox, 104 items need attention", "New task"]);
  for (const item of await items.all()) {
    const target = (await item.boundingBox())!;
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.width).toBeGreaterThanOrEqual(44);
  }
  const inbox = nav(page).getByRole("link", { name: "Inbox, 104 items need attention", exact: true });
  await expect(inbox).toContainText("99+");
  const tabBox = (await inbox.boundingBox())!;
  const badgeBox = (await inbox.locator(".mobile-tab-badge").boundingBox())!;
  expect(Math.abs(badgeBox.y - tabBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(badgeBox.x - (tabBox.x + tabBox.width / 2 + 2))).toBeLessThanOrEqual(1);
}
async function aboveBar(page: Page, item: Locator, gap?: number) {
  await expect(item).toBeVisible();
  const box = (await item.boundingBox())!;
  const distance = (await bar(page).boundingBox())!.y - box.y - box.height;
  expect(distance).toBeGreaterThanOrEqual(0);
  if (gap != null) expect(Math.abs(distance - gap)).toBeLessThanOrEqual(1);
}

for (const viewport of [{ width: 375, height: 812 }, { width: 393, height: 852 }, { width: 440, height: 956 }]) {
  for (const colorScheme of ["light", "dark"] as const) test.describe(`${viewport.width} ${colorScheme}`, () => {
    test.use({ viewport, colorScheme, isMobile: true, hasTouch: true });
    test("phone capsule across routes, keyboard and solid surface", async ({ page, request, browserName }, info) => {
      test.setTimeout(120_000);
      const company = await json(await request.post("/api/companies", { data: { name: `TEST Phone capsule ${viewport.width} ${colorScheme}` } }));
      const tasks = [];
      try {
        await page.route("**/api/workspace-preferences/me", route => route.fulfill({ json: { userId: "local-board", coordinatorWorkspaceEnabled: true, updatedAt: null } }));
        await page.route("**/api/announcements/current", route => route.fulfill({ json: null }));
        await page.route("**/attention/summary", route => route.fulfill({ json: { totalCount: 104, deskBadgeCount: 104 } }));
        await page.route("**/attention?*", async route => {
          const response = await route.fetch();
          await route.fulfill({ json: { ...await response.json(), deskBadgeCount: 104 } });
        });
        await page.addInitScript(() => {
          const apply = () => document.documentElement.style.setProperty("--sz-safe-bottom", "34px");
          document.addEventListener("DOMContentLoaded", apply);
          localStorage.setItem("paperclip-theme", "system");
        });
        const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: { name: "TEST Capsule agent", adapterType: "process", adapterConfig: { command: "false" }, runtimeConfig: { heartbeat: { enabled: false } } } }));
        for (let index = 0; index < 24; index++) tasks.push(await json(await request.post(`/api/companies/${company.id}/issues`, { data: { title: `TEST Capsule row ${String(index).padStart(2, "0")}`, status: "backlog" } })));
        const prefix = `/${company.issuePrefix}`;
        const shot = async (name: string) => page.screenshot({ path: info.outputPath(`${viewport.width}-${colorScheme}-${name}.png`) });
        await page.goto(`${prefix}/chats/${agent.id}`);
        await geometry(page);
        expect(await bar(page).evaluate(node => getComputedStyle(node).backdropFilter)).toContain("blur(20px)");
        const composer = page.locator(".paperclip-task-chat-composer").last();
        await aboveBar(page, composer, 10);
        await shot("chat");
        await composer.getByRole("textbox").first().focus();
        // Exercise the real shell hook: layout viewport remains fixed; only the
        // visual viewport shrinks, as on an iPhone with its keyboard open.
        await keyboard(page, true);
        await expect(bar(page)).toBeHidden();
        expect(await page.locator("body").ariaSnapshot()).not.toContain('navigation "Mobile navigation"');
        for (let index = 0; index < 8; index++) {
          await page.keyboard.press("Tab");
          expect(await nav(page).evaluate(node => node.contains(document.activeElement))).toBe(false);
        }
        await shot("keyboard");
        await keyboard(page, false);
        await geometry(page);
        await nav(page).getByRole("link", { name: "Tasks", exact: true }).tap();
        await expect(page).toHaveURL(/\/issues(?:\?.*)?$/);
        await geometry(page);
        const rows = page.locator('#main-content a[href*="/issues/"]').filter({ hasText: "TEST Capsule row" });
        await expect(rows).toHaveCount(24);
        await page.evaluate(async () => {
          window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        // Restore the nav with an upward gesture, then return to the end with
        // less than its hide threshold so the actual bottom reserve is tested.
        await expect(nav(page)).toHaveAttribute("data-visible", "false");
        await page.evaluate(() => window.scrollBy(0, -20));
        await expect(nav(page)).toHaveAttribute("data-visible", "true");
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await geometry(page);
        await aboveBar(page, rows.last());
        // Mid-list screenshot: real rows continue behind the glass. The end
        // clearance was checked separately above.
        await page.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2));
        await geometry(page);
        await shot("tasks");
        if (browserName === "chromium") {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }, { name: "prefers-reduced-transparency", value: "reduce" }] });
          const solid = await bar(page).evaluate(node => {
            const context = document.createElement("canvas").getContext("2d")!;
            context.fillStyle = getComputedStyle(node).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return { alpha: context.getImageData(0, 0, 1, 1).data[3], filter: getComputedStyle(node).backdropFilter };
          });
          expect(solid).toEqual({ alpha: 255, filter: "none" });
          await shot("solid");
          await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }, { name: "prefers-reduced-transparency", value: "no-preference" }] });
          await expect.poll(() => bar(page).evaluate(node => ({ filter: getComputedStyle(node).backdropFilter, reduced: matchMedia("(prefers-reduced-transparency: reduce)").matches }))).toEqual({ filter: "blur(20px) saturate(1.35)", reduced: false });
        } else {
          // WebKit has no CDP reduced-transparency emulation; retain a separate
          // screenshot, without claiming it proves the opaque media branch.
          info.annotations.push({ type: "coverage-gap", description: "Reduced transparency requires Chromium CDP" });
        }
        await expect.poll(() => bar(page).evaluate(node => getComputedStyle(node).backdropFilter)).toContain("blur(20px)");
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await nav(page).evaluate(node => getComputedStyle(node).transitionDuration)).toBe("0s");
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect(nav(page)).toHaveAttribute("data-visible", "false");
        await expect(nav(page)).toHaveAttribute("inert", "");
        expect((await bar(page).boundingBox())!.y).toBeGreaterThanOrEqual(viewport.height);
        await page.evaluate(() => window.scrollBy(0, -20));
        await expect(nav(page)).toHaveAttribute("data-visible", "true");
        await geometry(page);
        expect(await nav(page).evaluate(node => getComputedStyle(node).transitionDuration)).toBe("0s");
        await nav(page).getByRole("link", { name: /^Inbox/ }).tap();
        await expect(page).toHaveURL(/\/decisions$/);
        await geometry(page);
        await nav(page).getByRole("link", { name: "Chat", exact: true }).tap();
        await expect(page).toHaveURL(/\/chats(?:\/[^/]+)?$/);
        await geometry(page);
        await page.goto(`${prefix}/issues/${tasks[0].identifier}`);
        // Wait for the cold task page, not just the previous shell frame.
        await expect(page.locator(".paperclip-task-chat-composer").last()).toBeVisible({ timeout: 30_000 });
        // Start task geometry at the top, not at a restored mid-list scroll
        // offset that can activate the independently tested hide-on-scroll.
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(nav(page)).toHaveAttribute("data-visible", "true");
        await geometry(page);
        await aboveBar(page, page.locator(".paperclip-task-chat-composer").last());
        await nav(page).getByRole("button", { name: "New task", exact: true }).tap();
        await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
        await page.keyboard.press("Escape");
        await page.evaluate(() => document.documentElement.style.setProperty("--sz-safe-bottom", "0px"));
        await geometry(page, 0);
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect(bar(page)).toBeHidden();
      } finally {
        for (const task of tasks) await json(await request.patch(`/api/issues/${task.id}`, { data: { status: "cancelled" } }));
        await json(await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } }));
      }
    });
  });
}
