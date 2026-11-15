import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse): Promise<Record<string, any>> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

for (const coordinator of [true, false]) for (const width of [1440, 390]) {
  test(`Hidden view hide/unhide (${coordinator ? "coordinator" : "classic"}, ${width})`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const company = await json(await request.post("/api/companies", { data: { name: `Hidden view ${randomUUID()}` } }));
    try {
      await json(await request.put(`/api/companies/${company.id}/workspace-preferences/me`, {
        data: { coordinatorWorkspaceEnabled: coordinator },
      }));
      const task = await json(await request.post(`/api/companies/${company.id}/issues`, {
        data: { title: "Review the release checklist", status: "backlog" },
      }));
      const other = await json(await request.post(`/api/companies/${company.id}/issues`, {
        data: { title: "Prepare the next release", status: "backlog" },
      }));
      const listRoute = `/${company.issuePrefix}/issues`;
      const taskRoute = `${listRoute}/${task.identifier}`;
      const row = (id: string) => page.locator(`[data-issue-row-details="${id}"]`);
      const selectHidden = async (checked: boolean) => {
        if (coordinator) {
          await page.getByRole("button", { name: /Change view/ }).click();
          await page.getByRole("menuitem", { name: checked ? /^Hidden/ : /^All tasks/ }).click();
        } else {
          await page.locator('button[title^="Filter"]').first().click();
          const filter = page.getByRole("checkbox", { name: "Hidden tasks only", exact: true });
          await expect(filter).toBeChecked({ checked: !checked });
          await filter.click();
          // The controlled checkbox follows React Router's asynchronous view change.
          await expect(filter).toBeChecked({ checked });
          await page.keyboard.press("Escape");
        }
      };
      await page.goto(`${listRoute}?view=all`);
      await expect(row(task.id)).toBeVisible({ timeout: 30_000 });
      await expect(row(other.id)).toBeVisible();
      await page.goto(width === 390 ? `${taskRoute}?from=inbox&fromHref=${encodeURIComponent(`/${company.issuePrefix}/inbox/mine`)}` : taskRoute);
      await expect(page.getByRole("heading", { name: task.title, exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: width === 390 ? "More actions" : "More task actions", exact: true }).first().click();
      await page.getByRole("button", { name: "Hide this task", exact: true }).click();
      await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}`))).hiddenAt).not.toBeNull();
      await page.goto(`${listRoute}?view=all`);
      await expect(row(other.id)).toBeVisible({ timeout: 30_000 });
      await expect(row(task.id)).toHaveCount(0);
      await selectHidden(true);
      await expect(page).toHaveURL(/view=hidden/);
      await expect(row(task.id)).toBeVisible();
      await expect(row(other.id)).toHaveCount(0);
      await expect(row(task.id).locator('[data-slot="hidden-task-badge"]')).toHaveText("Hidden");
      await expect(row(task.id).locator('[data-slot="hidden-task-badge"]')).toBeInViewport();
      await page.reload();
      await expect(row(task.id)).toBeVisible({ timeout: 30_000 });
      await expect(row(other.id)).toHaveCount(0);
      await expect(row(task.id).locator('[data-slot="hidden-task-badge"]')).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`${coordinator ? "" : "classic-"}hidden-view-${width}.png`) });
      await row(task.id).locator("a[data-inbox-issue-link]").first().click();
      const banner = page.getByTestId("hidden-task-banner");
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await banner.getByRole("button", { name: "Unhide", exact: true }).click();
      await expect(banner).toHaveCount(0);
      await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}`))).hiddenAt).toBeNull();
      await page.goto(`${listRoute}?view=hidden`);
      await expect(page.getByText("No hidden tasks.", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(row(task.id)).toHaveCount(0);
      await expect(row(other.id)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${coordinator ? "" : "classic-"}hidden-view-empty-${width}.png`) });
      await selectHidden(false);
      await expect(row(task.id)).toBeVisible();
      await expect(row(other.id)).toBeVisible();
      await expect(row(task.id).locator('[data-slot="hidden-task-badge"]')).toHaveCount(0);
    } finally {
      await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
    }
  });
}
