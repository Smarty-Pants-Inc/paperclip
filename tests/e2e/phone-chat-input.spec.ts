import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { setup, json } from "./agent-chat.shared";

/**
 * Run: PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test
 *   --config tests/e2e/playwright.config.ts tests/e2e/phone-chat-input.spec.ts
 * Measurements deliberately do not assert the proposed layout. --grep measurements
 * collects a before/after table even when the separately named contracts are red.
 * CSS pixels are logical points here: touch Chromium, deviceScaleFactor=3.
 * No real iPhone, WebKit, iOS keyboard, VoiceOver, or larger-text qualification.
 */
test.use({ video: "on", actionTimeout: 10_000 });
const phones = [
  { width: 375, height: 812 },
  { width: 393, height: 852 },
  { width: 440, height: 956 },
];
const themes = ["light", "dark"] as const;
const model = { id: "paperclip/phone-fixture", label: "Phone Model" };
// A real process adapter supplies chat, queue and cancellation. Only the owned
// agent's browser metadata/catalog is presented as Pi, to exercise a provider-
// path model label and seven named levels without invoking a model or login.
// No task, comment, run, attachment or queue API response is mocked.
async function openChat(page: Page, request: Parameters<typeof setup>[0], theme: string, fixture: Awaited<ReturnType<typeof setup>>) {
  // Dismiss the throwaway instance's announcement through its real API; an
  // asynchronously arriving floating card otherwise covers composer controls.
  const announcement = await json(await request.get("/api/announcements/current"));
  if (announcement) await expect(await request.post(`/api/announcements/${announcement.id}/dismiss`, {
    data: { companyId: fixture.company.id },
  })).toBeOK();
  await page.route("**/api/workspace-preferences/me", route => route.fulfill({ json: {
    userId: "local-board", coordinatorWorkspaceEnabled: true, updatedAt: null,
  } }));
  const presentAgent = (agent: any) => agent.id === fixture.agent.id ? {
    ...agent, adapterType: "pi_local",
    adapterConfig: { model: model.id, thinking: "high" },
  } : agent;
  await page.route(`**/api/companies/${fixture.company.id}/agents`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: (await response.json()).map(presentAgent) });
  });
  await page.route(`**/api/agents/${fixture.agent.id}`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: presentAgent(await response.json()) });
  });
  await page.route(`**/api/companies/${fixture.company.id}/adapters/pi_local/models*`, route =>
    route.fulfill({ json: [model] }));
  await page.addInitScript(value => localStorage.setItem("paperclip.theme", value), theme);
  // Resolve the owned conversation before editing, so first-send draft-owner
  // migration cannot race the empty/three-line/working measurements.
  await json(await request.post(fixture.chatPath));
  await page.goto(fixture.route);
  await expect(page.getByTestId("task-chat-history-loading")).toHaveCount(0);
  // Cold static-UI hydration can exceed the default 5 s in the low-memory
  // browser environment. This is readiness, not a relaxed layout assertion.
  await expect(editor(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("task-chat-composer-model-label").last()).toHaveText(model.label);
  await page.evaluate(() => document.fonts.ready);
  return fixture;
}
const card = (page: Page) => page.locator(".paperclip-task-chat-composer").last();
const editor = (page: Page) => page.getByTestId("task-chat-composer-input").last()
  .locator('[contenteditable="true"],textarea').first();
const add = (page: Page) => page.getByTestId("task-chat-composer-add").last();
const selector = (page: Page) => page.getByTestId("task-chat-composer-selection").last()
  .getByRole("button", { name: /^(Select model and effort|Model and level: .+)$/ });
const sendButton = (page: Page) => page.getByTestId("task-chat-composer-send").last();
const stop = (page: Page) => page.getByTestId("task-chat-composer-stop").last();
async function rect(locator: Locator) {
  return locator.evaluate(element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  });
}
async function settle(page: Page) {
  // Wait for two stable animation frames, not a guessed layout delay.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function capture(page: Page, info: TestInfo, name: string) {
  await settle(page);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}
async function measure(page: Page, state: string) {
  await settle(page);
  const composer = await rect(card(page));
  const dock = await rect(page.getByTestId("task-chat-composer-dock").last());
  const statusLine = page.getByTestId("task-chat-status-line");
  if (state !== "working") await expect(statusLine).toHaveCount(0);
  const status = state === "working" ? await rect(statusLine.last()) : null;
  const nav = await rect(page.getByRole("navigation", { name: "Mobile navigation" }));
  return { state, viewport: page.viewportSize(), card: composer.height, dock: dock.height,
    dockToScreenBottom: page.viewportSize()!.height - dock.y,
    status: status?.height ?? null, statusToCardGap: status ? composer.y - status.bottom : null,
    tabBar: nav.height, tabBarBottom: nav.bottom };
}
async function visibleTextLines(page: Page) {
  return editor(page).evaluate(element => {
    // Overflow clips at the padding box (inside the border). Count every
    // text line intersecting it, including a sliver of a sixth.
    const box = element.getBoundingClientRect();
    const top = box.top + element.clientTop;
    const bottom = top + element.clientHeight;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rows = new Set<number>();
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.bottom > top && rect.top < bottom) rows.add(rect.top);
      }
    }
    return { count: rows.size, top, bottom, scrollTop: element.scrollTop,
      clientHeight: element.clientHeight, html: element.innerHTML };
  });
}
async function assertStatus(page: Page) {
  const status = await rect(page.getByTestId("task-chat-status-line").last());
  const composer = await rect(card(page));
  expect.soft(status.height, "status line remains 32 CSS px").toBe(32);
  // getBoundingClientRect on bare e3675d9e: coordinator phone gap is zero.
  expect.soft(composer.y - status.bottom, "preserve the measured bare-base status/card gap").toBe(0);
  expect.soft(await page.getByTestId("task-chat-status-line").last().evaluate(element =>
    Boolean(element.nextElementSibling?.querySelector(".paperclip-task-chat-composer"))),
  "status is immediately followed by the card wrapper").toBe(true);
}
async function assertRow(page: Page, action = sendButton(page), resting = false) {
  expect.soft(await card(page).getAttribute("data-composer-layout"), "C3 phone layout hook").toBe("phone-row");
  expect.soft(await page.getByTestId("task-chat-composer-row").count(), "C3 row hook").toBe(1);
  const controls = [add(page), editor(page), selector(page), action];
  const bounds = await Promise.all(controls.map(rect));
  const centers = bounds.map(r => r.y + r.height / 2);
  if (resting) expect.soft(Math.max(...centers) - Math.min(...centers), "one row, centers within 4 px").toBeLessThanOrEqual(4);
  for (let i = 1; i < bounds.length; i++) {
    expect.soft(bounds[i - 1]!.right, "controls in left-to-right order, no overlap").toBeLessThanOrEqual(bounds[i]!.x);
  }
  for (const [i, boundsOfControl] of bounds.entries()) {
    expect.soft(boundsOfControl.height, `control ${i} target height`).toBeGreaterThanOrEqual(44);
  }
}
async function hold(page: Page, request: Parameters<typeof setup>[0], fixture: Awaited<ReturnType<typeof setup>>) {
  // Lexical applies edits asynchronously; use real delete keys and wait for
  // React to expose an empty draft before a run event can re-render the editor.
  await editor(page).focus();
  await editor(page).press("ControlOrMeta+A");
  await editor(page).press("Backspace");
  await expect(editor(page)).toHaveText("");
  await expect(sendButton(page)).toBeDisabled();
  // API send avoids conveying the UI-only model metadata to a process adapter.
  const chat = await json(await request.get(fixture.chatPath));
  await json(await request.post(`/api/issues/${chat.id}/comments`, { data: {
    body: `fixture:${Buffer.from(JSON.stringify({ action: "hold" })).toString("base64url")}`,
    clientRequestId: randomUUID(),
  } }));
  await expect(stop(page)).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    const comments = await json(await request.get(`/api/issues/${chat.id}/comments`));
    return comments.some((c: any) => c.body === "Provider is streaming and ready to stop.");
  }, { timeout: 30_000 }).toBe(true);
}

for (const viewport of phones) for (const theme of themes) {
  test.describe(`${viewport.width} ${theme}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3, colorScheme: theme });
    test.setTimeout(120_000);
    let fixture: Awaited<ReturnType<typeof setup>>;
    test.beforeEach(async ({ page, request }) => {
      fixture = await setup(request);
      await openChat(page, request, theme, fixture);
    });
    test.afterEach(async ({ page, request }) => {
      // Unmount query observers before draining intercepted metadata requests.
      // Otherwise cleanup competes with fresh background refetches from the
      // still-mounted conversation. Keep all handler errors observable.
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
      if (fixture) {
        await fixture.restore();
        await json(await request.patch(`/api/companies/${fixture.company.id}`, { data: { status: "archived" } }));
      }
    });

    test("measurements: empty, one line, three lines, working", async ({ page, request }, info) => {
      const rows = [];
      for (const [state, text] of [["empty", ""], ["one-line", "One line"], ["three-lines", "One\nTwo\nThree"]]) {
        await editor(page).fill(text!);
        rows.push(await measure(page, state!));
        await capture(page, info, state!);
      }
      await editor(page).fill("");
      await hold(page, request, fixture);
      rows.push(await measure(page, "working"));
      await capture(page, info, "working");
      const heightsPath = info.outputPath("heights.json");
      await writeFile(heightsPath, JSON.stringify(rows, null, 2));
      await info.attach("heights", { path: heightsPath, contentType: "application/json" });
    });

    test("contracts: rest, tap targets, two-line selector and idle status", async ({ page }, info) => {
      await capture(page, info, "rest");
      expect.soft((await rect(card(page))).height).toBeLessThanOrEqual(53);
      await assertRow(page, sendButton(page), true);
      await expect(page.getByTestId("task-chat-status-line")).toHaveCount(0);
      const first = page.getByTestId("task-chat-composer-model-label").last();
      const second = page.getByTestId("task-chat-composer-level-label").last();
      expect.soft(await first.innerText()).not.toContain("/");
      expect.soft(await second.count(), "C3 reasoning label").toBe(1);
      if (await second.count()) {
        expect.soft(await second.innerText()).toBe("High");
        const top = await rect(first), bottom = await rect(second);
        expect.soft(top.bottom).toBeLessThanOrEqual(bottom.y);
        const trigger = await rect(selector(page));
        expect.soft(top.y).toBeGreaterThanOrEqual(trigger.y);
        expect.soft(bottom.bottom).toBeLessThanOrEqual(trigger.bottom);
      }
      if (viewport.width === 375) {
        // A real preferred catalog label, long enough to exercise the wider
        // trigger, without ever exposing its provider path in the row.
        await page.route(`**/api/companies/${fixture.company.id}/adapters/pi_local/models*`, route =>
          route.fulfill({ json: [{ ...model, label: "Claude Fable 5.2" }] }));
        await page.reload();
        await expect(first).toHaveText("Claude Fable 5.2", { timeout: 30_000 });
        await expect(second).toHaveText("High");
        await assertRow(page, sendButton(page), true);
        const labelFits = await first.evaluate(e => e.scrollWidth <= e.clientWidth);
        expect(labelFits, "long model label is readable at 375").toBe(true);
        await capture(page, info, "long-model-label");
      }
    });

    test("contracts: grows through five lines then scrolls", async ({ page }, info) => {
      const heights = [];
      for (let lines = 1; lines <= 7; lines++) {
        await editor(page).fill(Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join("\n"));
        await settle(page);
        if (lines > 5) await expect.poll(() => editor(page).evaluate(element => {
          const line = Number.parseFloat(getComputedStyle(element).lineHeight);
          return Math.abs(element.scrollTop / line - Math.round(element.scrollTop / line));
        }), { message: "caret scrolling settles on a whole line" }).toBeLessThan(0.01);
        heights.push({ card: (await rect(card(page))).height, field: (await rect(editor(page))).height });
        await capture(page, info, `lines-${lines}`);
        if (lines >= 5) {
          const visibleLines = await visibleTextLines(page);
          await info.attach(`visible-lines-${lines}`, {
            body: Buffer.from(JSON.stringify(visibleLines)), contentType: "application/json",
          });
          expect.soft(visibleLines.count, `no part of a sixth visible line at ${lines}`).toBe(5);
        }
        if (lines > 1 && lines <= 5) expect.soft(heights[lines - 1]!.field, `field grows at line ${lines}`).toBeGreaterThan(heights[lines - 2]!.field);
        if (lines >= 6) {
          expect.soft(Math.abs(heights[lines - 1]!.card - heights[4]!.card), `card capped at line ${lines}`).toBeLessThanOrEqual(1);
          expect.soft(await editor(page).evaluate(e => e.scrollHeight > e.clientHeight), `field scrolls at line ${lines}`).toBe(true);
        }
        // Other controls align with the bottom line, not the growing field's centre.
        if (lines > 1) {
          const r = await Promise.all([add(page), selector(page), sendButton(page)].map(rect));
          const centers = r.map(b => b.y + b.height / 2);
          expect.soft(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(4);
          const field = await rect(editor(page));
          expect.soft(Math.abs(r[0]!.bottom - field.bottom)).toBeLessThanOrEqual(8);
        }
      }
      // A small wheel delta must be allowed during the gesture, then settle
      // at five lines; snapping every scroll event would trap small deltas.
      await editor(page).hover();
      await page.mouse.wheel(0, -13);
      await expect.poll(async () => (await visibleTextLines(page)).scrollTop).toBe(24);
      expect((await visibleTextLines(page)).count).toBe(5);
      await capture(page, info, "lines-7-wheel-settled");
      await editor(page).press("ControlOrMeta+End");
      await editor(page).press("Shift+Enter");
      await page.keyboard.insertText("Line 8");
      await expect(editor(page)).toContainText("Line 8");
      await expect.poll(async () => (await visibleTextLines(page)).count).toBe(5);
      await capture(page, info, "lines-8-keyboard");
      await info.attach("growth-heights", { body: Buffer.from(JSON.stringify(heights)), contentType: "application/json" });
    });

    test("contracts: attached file is inside card above the row", async ({ page }, info) => {
      await card(page).locator('input[type="file"]').setInputFiles({
        name: "phone-note.txt", mimeType: "text/plain", buffer: Buffer.from("Owned phone composer fixture\n"),
      });
      const attachment = page.getByTestId("task-chat-composer-attachments").last();
      await expect(attachment).toContainText("phone-note.txt");
      await expect(attachment).not.toContainText("Uploading");
      await capture(page, info, "attached");
      const file = await rect(attachment), outer = await rect(card(page));
      expect.soft(file.y).toBeGreaterThanOrEqual(outer.y);
      expect.soft(file.bottom).toBeLessThanOrEqual(outer.bottom);
      expect.soft(file.x).toBeGreaterThanOrEqual(outer.x);
      expect.soft(file.right).toBeLessThanOrEqual(outer.right);
      const controls = await Promise.all([add(page), editor(page), selector(page), sendButton(page)].map(rect));
      expect.soft(file.bottom).toBeLessThanOrEqual(Math.min(...controls.map(r => r.y)));
      await assertRow(page, sendButton(page), true);
    });

    test("contracts: Stop replaces send, working status, queued strip above card", async ({ page, request }, info) => {
      const before = await rect(sendButton(page));
      await hold(page, request, fixture);
      await capture(page, info, "working");
      const after = await rect(stop(page));
      expect.soft(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2);
      expect.soft(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
      await assertRow(page, stop(page), true);
      await assertStatus(page);
      await selector(page).tap();
      await expect.soft(page.getByTestId("composer-mobile-dialog")).toContainText("The current reply is unchanged.", { timeout: 500 });
      await page.keyboard.press("Escape");
      // Legacy conversation sends appear directly in history, not in the task
      // queue strip. Exercise that shared-composer state on a real owned task,
      // following composer-stop.spec.ts, rather than mocking a queue response.
      const live = await json(await request.get(`/api/companies/${fixture.company.id}/live-runs`));
      for (const run of live) await json(await request.post(`/api/heartbeat-runs/${run.id}/cancel`));
      await json(await request.patch(`/api/agents/${fixture.agent.id}`, { data: {
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "setInterval(() => console.log('Phone queue fixture working'), 250)"],
          env: { NODE_OPTIONS: "" }, graceSec: 1,
        }, replaceAdapterConfig: true,
      } }));
      const queuedTask = await json(await request.post(`/api/companies/${fixture.company.id}/issues`, { data: {
        title: "TEST phone composer queue", status: "todo", assigneeAgentId: fixture.agent.id,
      } }));
      await page.goto(`/${fixture.company.issuePrefix}/issues/${queuedTask.identifier}`);
      await expect(stop(page)).toBeVisible({ timeout: 30_000 });
      // Ordinary user sends are intentionally echoed inline on this base
      // (IssueDetail.tsx); a saved interaction answer is the real tray entry.
      const interaction = await json(await request.post(`/api/issues/${queuedTask.id}/interactions`, { data: {
        kind: "request_confirmation", continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "TEST queued phone response", acceptLabel: "Accept test" },
      } }));
      await json(await request.post(`/api/issues/${queuedTask.id}/interactions/${interaction.id}/accept`, { data: {} }));
      const queued = page.getByTestId("task-chat-queued-messages").last();
      // Accept is persisted before the browser's queued-comments refresh.
      // In the constrained full matrix the first refresh can consume the 5 s
      // default by itself; await real tray readiness, then keep geometry strict.
      await expect(queued).toBeVisible({ timeout: 30_000 });
      await capture(page, info, "queued");
      expect.soft((await rect(queued)).bottom).toBeLessThanOrEqual((await rect(card(page))).y);
      expect.soft(await card(page).locator('[data-testid="task-chat-queued-messages"]').count()).toBe(0);
    });

    test("contracts: slider touch, keys, names, Default and Escape", async ({ page }, info) => {
      await selector(page).tap();
      const sheet = page.getByTestId("composer-mobile-dialog");
      const slider = sheet.locator("#composer-run-effort");
      await expect(slider).toBeVisible();
      await expect.poll(() => sheet.evaluate(e => [...e.getAnimations({ subtree: true })].every(a => a.playState !== "running"))).toBe(true);
      const track = await rect(slider);
      expect.soft(track.height, "slider has a 52 px touch target").toBeGreaterThanOrEqual(52);
      await page.touchscreen.tap(track.right - 2, track.y + track.height / 2);
      const max = Number(await slider.getAttribute("max"));
      expect.soft(Number(await slider.inputValue())).toBe(max);
      const highest = await slider.getAttribute("aria-valuetext");
      expect.soft(highest).toBe("Extra High");
      await capture(page, info, "slider-highest");
      const markColors = await sheet.locator('.composer-run-effort-marks > span[data-selected="true"]').evaluateAll(marks =>
        marks.map(mark => getComputedStyle(mark).backgroundColor));
      expect(markColors.length, "selected stop marks exist").toBeGreaterThan(1);
      // Resolve the rail's foreground token in the same color serialization
      // as a mark; visual screenshots additionally establish actual contrast.
      const filledColor = await slider.evaluate(element => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--foreground)';
        element.parentElement!.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      for (const color of markColors) expect.soft(color, "filled marks must differ from filled rail").not.toBe(filledColor);
      await slider.focus();
      await slider.press("ArrowLeft");
      await slider.press("ArrowLeft");
      expect.soft(Number(await slider.inputValue())).toBe(max - 2);
      expect.soft(await slider.getAttribute("aria-valuetext")).toBe("Medium");
      await capture(page, info, "slider-two-left");
      await slider.press("Home");
      expect.soft(await slider.inputValue()).toBe("0");
      expect.soft(await slider.getAttribute("aria-valuetext")).toBe("Default");
      await capture(page, info, "slider-default");
      await expect.soft(sheet).toContainText("Earlier messages are unchanged.", { timeout: 500 });
      await slider.press("Escape");
      await expect(sheet).toBeHidden();
      const level = page.getByTestId("task-chat-composer-level-label").last();
      expect.soft(await level.count()).toBe(1);
      if (await level.count()) expect.soft(await level.innerText()).toBe("High");
      // Reopen and change a non-default value; the second line must follow it.
      await selector(page).tap();
      await slider.focus();
      await slider.press("End");
      await slider.press("ArrowLeft");
      const chosen = await slider.getAttribute("aria-valuetext");
      await slider.press("Escape");
      if (await level.count()) expect.soft(await level.innerText()).toBe(chosen);
      await capture(page, info, "selector-chosen-level");
      // Supplemental pointer drag: release between stops and retain a named,
      // integral stop. The native step=1 range must not rest between marks.
      await selector(page).tap();
      await slider.focus();
      await slider.press("Home");
      await slider.press("ArrowRight");
      expect(await slider.inputValue()).toBe("1");
      await expect.poll(() => sheet.evaluate(e => [...e.getAnimations({ subtree: true })].every(a => a.playState !== "running"))).toBe(true);
      const dragTrack = await rect(slider);
      const y = dragTrack.y + dragTrack.height / 2;
      const usable = dragTrack.width - 28;
      await page.mouse.move(dragTrack.x + 14 + usable / max, y);
      await page.mouse.down();
      await page.mouse.move(dragTrack.x + 14 + usable * (2.4 / max), y, { steps: 12 });
      await page.mouse.up();
      expect(await slider.inputValue()).toBe("2");
      expect(await slider.getAttribute("aria-valuetext")).toBe("Minimal");
      await capture(page, info, "slider-drag-snapped");
      await slider.press("Escape");
      await expect(sheet).toBeHidden();
    });

    test("contracts: Tab order and Enter sends", async ({ page, request }, info) => {
      await editor(page).fill("Keyboard fixture message");
      await add(page).focus();
      await expect(add(page)).toBeFocused();
      for (const control of [editor(page), selector(page), sendButton(page)]) {
        await page.keyboard.press("Tab");
        await expect.soft(control).toBeFocused({ timeout: 500 });
      }
      await capture(page, info, "keyboard-tab");
      await editor(page).focus();
      await editor(page).press("Enter");
      await expect.poll(async () => {
        const chat = await json(await request.get(fixture.chatPath));
        if (!chat) return false;
        const comments = await json(await request.get(`/api/issues/${chat.id}/comments`));
        return comments.some((c: any) => c.body === "Keyboard fixture message");
      }).toBe(true);
      await expect(editor(page)).toHaveText("");
      await capture(page, info, "keyboard-sent");
    });
  });
}

for (const theme of themes) test.describe(`desktop ${theme}`, () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, colorScheme: theme });
  test("contracts: existing actions row stays below field", async ({ page, request }, info) => {
    const fixture = await setup(request);
    try {
      await openChat(page, request, theme, fixture);
      await capture(page, info, "desktop");
      expect(await card(page).getAttribute("data-composer-layout")).not.toBe("phone-row");
      const input = await rect(editor(page));
      const actions = await rect(page.getByTestId("task-chat-composer-actions").last());
      expect(actions.y).toBeGreaterThanOrEqual(input.bottom);
      const buttons = await Promise.all([add(page), selector(page), sendButton(page)].map(rect));
      const centers = buttons.map(r => r.y + r.height / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(4);
      await selector(page).click();
      const slider = page.locator("#composer-run-effort");
      await expect(slider).toBeVisible();
      const track = await rect(slider);
      expect(track.height).toBeGreaterThanOrEqual(52);
      await page.mouse.click(track.right - 2, track.y + track.height / 2);
      const max = Number(await slider.getAttribute("max"));
      expect(await slider.inputValue()).toBe(String(max));
      expect(await slider.getAttribute("aria-valuetext")).toBe("Extra High");
      await capture(page, info, "desktop-slider-highest");
      await slider.focus();
      await slider.press("Home");
      expect(await slider.getAttribute("aria-valuetext")).toBe("Default");
      await slider.press("ArrowRight");
      expect(await slider.inputValue()).toBe("1");
      await slider.press("ArrowLeft");
      expect(await slider.inputValue()).toBe("0");
      await slider.press("End");
      expect(await slider.inputValue()).toBe(String(max));
      const usable = track.width - 28;
      const y = track.y + track.height / 2;
      await page.mouse.move(track.right - 14, y);
      await page.mouse.down();
      await page.mouse.move(track.x + 14 + usable * (2.4 / max), y, { steps: 12 });
      await page.mouse.up();
      expect(await slider.inputValue()).toBe("2");
      expect(await slider.getAttribute("aria-valuetext")).toBe("Minimal");
      await capture(page, info, "desktop-slider-drag-snapped");
      await slider.press("Escape");
      await expect(slider).toBeHidden();
    } finally {
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
      await fixture.restore();
      await json(await request.patch(`/api/companies/${fixture.company.id}`, { data: { status: "archived" } }));
    }
  });
});
