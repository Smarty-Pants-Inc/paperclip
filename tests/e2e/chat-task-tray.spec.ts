import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { json } from "./agent-chat.shared";
import { seedChatTaskTray, type TrayScenario, type TraySeed } from "./helpers/chat-task-tray.seed";

/** Ordinary discovery needs no saved baselines: empty-dock layout is measured
 * against the same dock with any accessory host removed from layout, in-run.
 * Optional two-revision capture requires CHAT_TASK_TRAY_BASELINE_DIR explicitly;
 * run the base with CAPTURE=before (0/5/24), then the candidate with CAPTURE=after.
 * Keep that directory outside Playwright's outputDir. No API mocks.
 */
const capture = process.env.CHAT_TASK_TRAY_CAPTURE ?? "after";
if (!["before", "after"].includes(capture)) throw new Error("CHAT_TASK_TRAY_CAPTURE must be before or after");
const baselineDir = process.env.CHAT_TASK_TRAY_BASELINE_DIR ? path.resolve(process.env.CHAT_TASK_TRAY_BASELINE_DIR) : null;
if (capture === "before" && !baselineDir) throw new Error("Before capture requires CHAT_TASK_TRAY_BASELINE_DIR");
const eastern = () => new Date().toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
const test = base.extend<{ seedTray: (count: TrayScenario) => Promise<TraySeed> }>({
  seedTray: async ({ request }, use, testInfo) => {
    const seeds: TraySeed[] = [];
    const quiescence: unknown[] = [];
    const startedET = eastern();
    try {
      await use(async count => {
        const seed = await seedChatTaskTray(request, count);
        seeds.push(seed);
        return seed;
      });
    } finally {
      try {
        for (const seed of seeds) {
          try { quiescence.push(await seed.assertQuiescent()); } finally { await seed.dispose(); }
        }
      } finally {
        await testInfo.attach("attempt-ledger", { contentType: "application/json", body: Buffer.from(JSON.stringify({
          testId: testInfo.testId, retry: testInfo.retry, capture, startedET, finishedET: eastern(),
          status: testInfo.status, expectedStatus: testInfo.expectedStatus, quiescence,
          fixtures: seeds.map(({ companyId, agentId, conversationId, sessionGeneration }) =>
            ({ companyId, agentId, conversationId, sessionGeneration })),
        }, null, 2)) });
      }
    }
  },
});
test.use({ trace: "retain-on-failure", video: "on", actionTimeout: 10_000, viewport: { width: 1280, height: 900 }, contextOptions: { reducedMotion: "no-preference" } });
test.setTimeout(90_000);

async function openChat(page: Page, seed: TraySeed, theme: "light" | "dark") {
  await page.addInitScript(value => localStorage.setItem("paperclip.theme", value), theme);
  const handoffs = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/issues/${seed.conversationId}/chat-handoffs`
      && (capture === "before" || url.searchParams.get("view") === "tray");
  });
  await page.goto(seed.route);
  const response = await handoffs;
  // Successful service-worker responses can lose their body on canonical URL
  // replacement; only fetch the body when it is needed to explain an error.
  if (!response.ok()) throw new Error(`Handoff response ${response.status()}: ${await response.text()}`);
  // Same readiness boundary used by the existing agent-chat browser specs;
  // history reveal can take longer than a single default 5s assertion on mobile.
  await expect(page.locator('[data-testid="task-chat-thread"] > [aria-busy="false"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("task-chat-composer-dock")).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-input").last()).toBeVisible();
  // The seed is quiescent (no queued or running run), so the run status line
  // must be absent: no idle status row, and the tray sits directly above the input.
  await expect(page.getByTestId("task-chat-status-line")).toHaveCount(0);
  // Wait for the real handoff response and settled UI, not a fixed delay or mocks.
  await expect(page.getByTestId("chat-task-tray").getByText("Loading open tasks…", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.locator("html").evaluate(element => element.classList.contains("dark"))).toBe(theme === "dark");
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(`${capture}-${name}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}
async function box(page: Page, hook: string) {
  const bounds = await page.getByTestId(hook).last().boundingBox();
  expect(bounds, `${hook} has a layout box`).not.toBeNull();
  return bounds!;
}
async function aboveStatus(page: Page, label: string) {
  // Existing hooks only. With a live run the tray sits above the run status
  // line; with none (this quiescent seed) it sits directly above the input.
  const row = await box(page, "chat-task-tray");
  const hasStatus = await page.getByTestId("task-chat-status-line").count() > 0;
  const below = await box(page, hasStatus ? "task-chat-status-line" : "task-chat-composer-input");
  expect.soft(row.y + row.height, `${label}: tray bottom <= ${hasStatus ? "status-line" : "input"} top`).toBeLessThanOrEqual(below.y);
  return { row, below };
}
async function noTerminalTasks(page: Page, seed: TraySeed) {
  for (const task of seed.tasks.filter(task => ["done", "cancelled"].includes(task.status))) {
    await expect.soft(page.getByTestId("chat-task-tray")).not.toContainText(task.title);
    await expect.soft(page.getByTestId("chat-task-tray-panel").getByRole("link", { name: new RegExp(task.identifier) })).toHaveCount(0);
  }
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${viewport.width}x${viewport.height} ${theme}`, () => {
      test.use({ viewport });
      for (const count of [0, 1, 5, 24] as const) {
        if (capture === "before" && count === 1) continue;
        test(`${count} open tasks: visual states, geometry and terminal exclusion`, async ({ page, seedTray }, testInfo) => {
          const seed = await seedTray(count);
          await openChat(page, seed, theme);
          const key = `${viewport.width}x${viewport.height}-${theme}`;
          if (capture === "before") {
            await expect(page.locator('[data-testid^="chat-task-tray"]')).toHaveCount(0);
            if (count === 0) {
              // Screenshot waits for fonts and layout before baseline measurement.
              await screenshot(page, testInfo, `0-${key}-base-measured`);
              const dock = await box(page, "task-chat-composer-dock");
              await mkdir(baselineDir!, { recursive: true });
              await writeFile(path.join(baselineDir!, `${key}.json`), JSON.stringify({ dock, measuredET: eastern() }));
              await testInfo.attach("bare-dock", { contentType: "application/json", body: Buffer.from(JSON.stringify({ key, dock })) });
            }
            await screenshot(page, testInfo, `${count}-${key}-base`);
            return;
          }
          if (count === 0) {
            await screenshot(page, testInfo, `0-${key}-none`);
            const dock = await box(page, "task-chat-composer-dock");
            const measured = await page.getByTestId("task-chat-composer-dock").last().evaluate(async element => {
              const hosts = [...document.querySelectorAll<HTMLElement>('[data-testid="chat-composer-accessory-host"]')];
              const styles = hosts.map(host => host.getAttribute("style"));
              const bounds = () => { const { y, height } = element.getBoundingClientRect(); return { y, height }; };
              const before = bounds();
              try {
                for (const host of hosts) host.style.setProperty("display", "none", "important");
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                return { before, withoutAccessory: bounds(), hostCount: hosts.length };
              } finally {
                hosts.forEach((host, index) => styles[index] == null ? host.removeAttribute("style") : host.setAttribute("style", styles[index]!));
              }
            });
            await testInfo.attach("empty-dock-in-run", { contentType: "application/json", body: Buffer.from(JSON.stringify(measured, null, 2)) });
            expect.soft(measured.before, "same empty dock with host removed from layout").toEqual(measured.withoutAccessory);
            if (baselineDir) {
              const baseline = JSON.parse(await readFile(path.join(baselineDir, `${key}.json`), "utf8"));
              await testInfo.attach("empty-dock-comparison", { contentType: "application/json", body: Buffer.from(JSON.stringify({
                key, base: baseline, after: { dock, measuredET: eastern() },
              }, null, 2)) });
              expect.soft(dock.y, "empty dock top equals bare base").toBe(baseline.dock.y);
              expect.soft(dock.height, "empty dock height equals bare base").toBe(baseline.dock.height);
            }
            await expect.soft(page.locator('[data-testid^="chat-task-tray"]')).toHaveCount(0);
            const wrappers = await page.getByTestId("chat-composer-accessory-host").evaluateAll(elements => elements.map(element => ({
              tag: element.tagName, attributes: Object.fromEntries(Array.from(element.attributes).map(attribute => [attribute.name, attribute.value])),
              display: getComputedStyle(element).display, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
            })));
            await testInfo.attach("empty-accessory-host", { contentType: "application/json", body: Buffer.from(JSON.stringify(wrappers, null, 2)) });
            for (const wrapper of wrappers) expect.soft(wrapper, "empty accessory takes no layout space").toMatchObject({ display: "none", width: 0, height: 0 });
            return;
          }
          await screenshot(page, testInfo, `${count}-${key}-folded`);
          await noTerminalTasks(page, seed);
          if (count === 1) {
            const single = page.getByTestId("chat-task-tray-single");
            await expect(single).toHaveAttribute("href", new RegExp(seed.tasks[0].identifier));
            await expect(page.getByTestId("chat-task-tray-summary")).toHaveCount(0);
            await expect(page.locator(".chat-task-tray-chevron")).toHaveCount(0);
            const layout = await aboveStatus(page, "single (not expandable)");
            await testInfo.attach("layout-single-not-expandable", { contentType: "application/json", body: Buffer.from(JSON.stringify(layout)) });
            // One-task expanded is intentionally identical: no chevron/list exists.
            await screenshot(page, testInfo, `${count}-${key}-expanded-not-applicable`);
            return;
          }
          const summary = page.getByTestId("chat-task-tray-summary");
          if (await summary.count() === 0) {
            await screenshot(page, testInfo, `${count}-${key}-expanded-unavailable`);
            await expect(summary, "Final contract: blocked evidence must not suppress the entire tray").toBeVisible();
            return;
          }
          await expect(summary).toHaveAttribute("aria-expanded", "false");
          await expect(summary).toContainText(`${count} open tasks`);
          const folded = await aboveStatus(page, "folded");
          await summary.click();
          await expect(page.getByTestId("chat-task-tray-panel")).toBeVisible();
          const expanded = await aboveStatus(page, "expanded");
          expect.soft(expanded.row, "row bounding box is unchanged by expansion").toEqual(folded.row);
          await expect(page.getByTestId("chat-task-tray-row")).toHaveCount(count);
          await noTerminalTasks(page, seed);
          await expect(page.getByTestId("chat-task-tray-filter")).toHaveCount(count >= 10 ? 1 : 0);
          await expect(page.getByTestId("chat-task-tray-open-tasks")).toBeVisible();
          const panel = await box(page, "chat-task-tray-panel");
          expect.soft(panel.y + panel.height, "panel opens upward").toBeLessThanOrEqual(folded.row.y);
          expect.soft(panel.height).toBeLessThanOrEqual(viewport.height * (viewport.width < 640 ? 0.6 : 0.5));
          await screenshot(page, testInfo, `${count}-${key}-expanded`);
          await testInfo.attach("layout", { body: Buffer.from(JSON.stringify({ folded, expanded, panel })), contentType: "application/json" });
          await page.getByTestId("chat-task-tray-open-tasks").click();
          // Desktop tabs and mobile panel both label the active content Tasks.
          await expect(page.getByRole("tabpanel", { name: "Tasks", exact: true })).toBeVisible();
        });
      }
    });
  }
}

if (capture === "after") {
  test("real Tab, Enter, Esc, Space and a second click keep the row anchored", async ({ page, seedTray }, testInfo) => {
    const seed = await seedTray(5);
    await openChat(page, seed, "light");
    const row = page.getByTestId("chat-task-tray-summary");
    // Start at document boundary, then use actual keyboard traversal (never locator.focus()).
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    for (let i = 0; i < 100; i++) {
      await page.keyboard.press("Tab");
      if (await row.evaluate(element => element === document.activeElement)) break;
    }
    await expect(row).toBeFocused();
    const folded = await box(page, "chat-task-tray");
    await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    expect(await box(page, "chat-task-tray")).toEqual(folded);
    await page.keyboard.press("Escape");
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(row).toBeFocused();
    await page.keyboard.press("Space");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await screenshot(page, testInfo, "keyboard-expanded");
    await page.mouse.click(folded.x + folded.width / 2, folded.y + folded.height / 2);
    await expect(row).toHaveAttribute("aria-expanded", "false");
  });

  test("24 tasks: evidence groups, newest-first ties, filtering by title ID and owner", async ({ page, seedTray }, testInfo) => {
    const seed = await seedTray(24);
    await openChat(page, seed, "dark");
    await screenshot(page, testInfo, "24-evidence-groups");
    // The shared status resolver owns the blocked policy, and it differs by
    // stack: the base marks every blocked task "needs you"; the person-only-red
    // stack marks only the two person-action waits and the rest "waiting".
    // Accept exactly one complete expectation, never a mix. Empty groups render
    // neither a count nor a section.
    const personOnlyRed = await page.getByTestId("chat-task-tray-count-waiting").count() > 0;
    await testInfo.attach("blocked-policy", { contentType: "text/plain", body: Buffer.from(personOnlyRed ? "person-only-red" : "base") });
    const counts: Array<[string, number]> = personOnlyRed
      ? [["working", 8], ["needs-you", 2], ["waiting", 6], ["up-next", 8]]
      : [["working", 8], ["needs-you", 8], ["up-next", 8]];
    for (const [group, count] of counts) {
      await expect.soft(page.getByTestId(`chat-task-tray-count-${group}`)).toHaveText(new RegExp(`${count} ${group.replaceAll("-", " ")}$`));
    }
    await page.getByTestId("chat-task-tray-summary").click();
    const groups = page.locator('[data-testid^="chat-task-tray-group-"]');
    await expect(groups).toHaveText(personOnlyRed
      ? ["Working · 8", "Needs you · 2", "Waiting · 6", "Up next · 8"]
      : ["Working · 8", "Needs you · 8", "Up next · 8"]);
    // Newest first within a group; the seed makes lower indexes newer.
    const sorted = personOnlyRed
      ? [seed.tasks.slice(0, 8), seed.tasks.slice(14, 16), seed.tasks.slice(8, 14), seed.tasks.slice(16, 24)].flat()
      : seed.tasks.slice(0, 24);
    expect(await page.getByTestId("chat-task-tray-row").locator(".chat-task-tray-id").allTextContents())
      .toEqual(sorted.map(task => task.identifier));
    const filter = page.getByTestId("chat-task-tray-filter");
    // Match the full last identifier, not '-1' (which also matches '-10' etc.).
    await filter.fill(seed.tasks[23].identifier);
    await expect(page.getByTestId("chat-task-tray-row")).toHaveCount(1);
    await filter.fill("Reviewer: approve");
    await expect(page.getByTestId("chat-task-tray-row")).toHaveCount(2);
    await filter.fill("Tray Smarty");
    await expect(page.getByTestId("chat-task-tray-row")).toHaveCount(seed.tasks.filter(task => task.assigneeAgentId === seed.agentId && !["done", "cancelled"].includes(task.status)).length);
    await filter.fill("no-such-open-task");
    await expect(page.getByText("No open tasks match.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-task-tray-summary")).toContainText("24 open tasks");
  });

  test("normal API completion updates the open list and removes the last task without reload", async ({ page, request, seedTray }, testInfo) => {
    const seed = await seedTray(5);
    await openChat(page, seed, "light");
    await page.getByTestId("chat-task-tray-summary").click();
    await json(await request.patch(`/api/issues/${seed.tasks[0].id}`, { data: { status: "done" } }));
    await expect(page.getByTestId("chat-task-tray-row")).toHaveCount(4);
    await expect(page.getByTestId("chat-task-tray-panel")).not.toContainText(seed.tasks[0].identifier);
    await screenshot(page, testInfo, "live-four-open");
    for (const task of seed.tasks.slice(1, 5)) {
      await json(await request.patch(`/api/issues/${task.id}`, { data: { status: "done" } }));
    }
    await expect(page.getByTestId("chat-task-tray")).toHaveCount(0);
    await screenshot(page, testInfo, "live-zero-open");
  });

  test("a new handoff shimmers exactly once and never opens the list", async ({ page, request, seedTray }, testInfo) => {
    const seed = await seedTray(5);
    await openChat(page, seed, "light");
    await expect(page.getByTestId("chat-task-tray-summary")).toContainText("5 open tasks");
    await page.evaluate(() => {
      const state = { starts: 0, ends: 0 };
      Object.assign(window, { trayAnimations: state });
      for (const eventName of ["animationstart", "animationend"]) document.addEventListener(eventName, event => {
        if (event.target instanceof Element && event.target.classList.contains("chat-task-tray-shimmer")) {
          if (eventName === "animationstart") state.starts++; else state.ends++;
        }
      });
    });
    await expect(page.locator(".chat-task-tray-shimmer")).toHaveCount(0);
    await seed.createTask();
    await expect(page.getByTestId("chat-task-tray-summary")).toContainText("6 open tasks");
    try {
      await expect.poll(() => page.evaluate(() => (window as unknown as { trayAnimations: { ends: number } }).trayAnimations.ends)).toBe(1);
    } finally {
      await testInfo.attach("shimmer-observation", { contentType: "application/json", body: Buffer.from(JSON.stringify(await page.evaluate(() => ({
        animations: (window as unknown as { trayAnimations: unknown }).trayAnimations,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        shimmerElements: document.querySelectorAll(".chat-task-tray-shimmer").length,
        rowExpanded: document.querySelector('[data-testid="chat-task-tray-summary"]')?.getAttribute("aria-expanded"),
      })), null, 2)) });
      await screenshot(page, testInfo, "new-task-shimmer-observed");
    }
    const animations = await page.evaluate(() => (window as unknown as { trayAnimations: { starts: number; ends: number } }).trayAnimations);
    expect(animations).toEqual({ starts: 1, ends: 1 });
    await expect(page.getByTestId("chat-task-tray-summary")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("chat-task-tray-panel")).toHaveCount(0);
    // A normal metadata edit causes a real live-event refetch, not a creation.
    // Wait for that response: a fresh-cache focus event need not refetch at all.
    const refetched = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/issues/${seed.conversationId}/chat-handoffs` && url.searchParams.get("view") === "tray";
    });
    await json(await request.patch(`/api/issues/${seed.tasks[0].id}`, { data: { description: "Browser proof: ordinary metadata refetch" } }));
    expect((await refetched).ok()).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId("chat-task-tray-summary")).toContainText("6 open tasks");
    expect(await page.evaluate(() => (window as unknown as { trayAnimations: { starts: number } }).trayAnimations.starts)).toBe(1);
    await screenshot(page, testInfo, "new-task-stays-folded");
  });
}
