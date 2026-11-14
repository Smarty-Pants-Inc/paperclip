import { expect, test, type APIResponse, type Page } from "@playwright/test";

// A pending card docked over the task-chat composer (the composer takeover)
// must leave Send on screen and clickable on a phone, keyboard closed and
// open, while the card's own actions stay reachable inside its scroll box.

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function sendIsOnScreenAndHittable(page: Page, shot: string) {
  const send = page.getByTestId("task-chat-composer-send");
  await expect(send).toHaveCount(1);
  // Let the dock settle after a resize before measuring.
  await page.waitForTimeout(300);
  if (process.env.PHONE_DOCK_SHOTS) await page.screenshot({ path: `${process.env.PHONE_DOCK_SHOTS}/${shot}.png` });
  const r = await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('[data-testid="task-chat-composer-send"]')!;
    const rect = b.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const hit = cy >= 0 && cy <= innerHeight ? document.elementFromPoint(cx, cy) : null;
    return {
      cy, innerHeight,
      hits: !!hit && (hit === b || b.contains(hit)),
      hit: hit?.outerHTML.slice(0, 160) ?? null,
    };
  });
  await test.info().attach(`send-${shot}`, { body: JSON.stringify(r), contentType: "application/json" });
  // Soft, so a failing run still measures (and screenshots) both viewports.
  expect.soft(r.cy, `Send centre ${r.cy} inside the ${r.innerHeight}px screen`).toBeLessThan(r.innerHeight);
  expect.soft(r.cy).toBeGreaterThan(0);
  expect.soft(r.hits, `Send not covered (hit: ${r.hit})`).toBe(true);
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("phone: a docked pending card leaves Send visible and clickable", async ({ page, request }) => {
  test.setTimeout(90_000);
  const company = await json(await request.post("/api/companies", { data: { name: `Phone takeover ${Date.now()}` } }));
  try {
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Choose the rollout plan", status: "backlog",
    } }));
    const longText = "Before I continue I need you to weigh the trade-offs below. ".repeat(12);
    await json(await request.post(`/api/issues/${issue.id}/interactions`, { data: {
      kind: "ask_user_questions", title: "Rollout plan", continuationPolicy: "none",
      payload: { version: 1, questions: [{
        id: "plan", prompt: `Which rollout plan should I follow? ${longText}`,
        helpText: longText, selectionMode: "single", required: true,
        options: [
          { id: "staged", label: "Staged rollout", description: longText.slice(0, 300) },
          { id: "all", label: "Everyone at once", description: longText.slice(0, 300) },
          { id: "hold", label: "Hold until next week", description: longText.slice(0, 300) },
        ],
      }] },
    } }));
    await page.route("**/api/workspace-preferences/me", async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: true } });
    });
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    const card = page.getByTestId("task-chat-composer-takeover");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-chat-history-loading")).toHaveCount(0, { timeout: 10_000 });

    // Keyboard closed: type a draft (never Enter, never click Send).
    await page.getByRole("textbox", { name: "editable markdown" }).focus();
    await page.keyboard.type("hel");
    await sendIsOnScreenAndHittable(page, "390x844");

    // Keyboard open: the layout viewport shrinks by a 336px keyboard.
    await page.setViewportSize({ width: 390, height: 508 });
    await sendIsOnScreenAndHittable(page, "390x508");

    // The card's own submit stays reachable inside the card's scroll box.
    await card.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const submit = card.getByRole("button", { name: /submit answers|next/i }).last();
    await expect(submit).toBeInViewport();
    const hit = await submit.evaluate(el => {
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!h && (h === el || el.contains(h));
    });
    expect(hit, "card submit is not covered").toBe(true);
  } finally {
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } }).catch(() => {});
  }
});
