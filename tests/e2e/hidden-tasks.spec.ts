import { randomUUID } from "node:crypto";
import { expectHiddenTagLayout } from "./helpers/hidden-tag-layout";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

async function json<T = Record<string, any>>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

let cleanupCompanyId: string | undefined;

test.afterEach(async ({ request }) => {
  const companyId = cleanupCompanyId;
  cleanupCompanyId = undefined;
  if (companyId) await request.patch(`/api/companies/${companyId}`, { data: { status: "archived" }, timeout: 5_000 });
});

const viewports = [
  { label: "1440", width: 1440, height: 1000 },
  { label: "390", width: 390, height: 844 },
] as const;

// The default Tasks page (Coordinator workspace) and the classic task list.
const workspaces = [
  { label: "coordinator", coordinatorWorkspaceEnabled: true },
  { label: "classic", coordinatorWorkspaceEnabled: false },
] as const;

for (const workspace of workspaces) for (const viewport of viewports) {
  test(`hide a task, find it with Show hidden tasks, and unhide it (${workspace.label}, ${viewport.label})`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const company = await json(await request.post("/api/companies", { data: { name: `Hidden tasks ${randomUUID()}` } }));
    cleanupCompanyId = company.id;
    // A per-person, per-organization preference on a throwaway organization.
    await json(await request.put(`/api/companies/${company.id}/workspace-preferences/me`, {
      data: { coordinatorWorkspaceEnabled: workspace.coordinatorWorkspaceEnabled },
    }));
    // Unassigned backlog tasks: no agent, provider or run is involved.
    const task = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Review the release checklist", status: "backlog" },
    }));
    const other = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: `Keep me ${viewport.label}`, status: "backlog" },
    }));
    const listRoute = `/${company.issuePrefix}/issues`;
    const row = (id: string) => page.locator(`[data-issue-row-details="${id}"]`);
    const capture = async (name: string) => {
      await page.screenshot({ path: testInfo.outputPath(`${workspace.label}-${viewport.label}-${name}.png`), fullPage: false });
    };

    await page.goto(listRoute);
    await expect(row(task.id)).toBeVisible({ timeout: 30_000 });
    await expect(row(other.id)).toBeVisible();

    // Desktop: the task title's '…' menu. Phone: the task page has no '…' menu
    // of its own; the menu lives in the inbox toolbar of a task opened from the inbox.
    const phone = viewport.width < 768;
    const taskRoute = `/${company.issuePrefix}/issues/${task.identifier}`;
    const openTaskMenu = async () => {
      if (phone) {
        await page.goto(`${taskRoute}?from=inbox&fromHref=${encodeURIComponent(`/${company.issuePrefix}/inbox/mine`)}`);
        await expect(page.getByRole("heading", { name: task.title, exact: true }).first()).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "More actions", exact: true }).click();
      } else {
        await page.goto(taskRoute);
        await expect(page.getByRole("heading", { name: task.title, exact: true }).first()).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "More task actions" }).first().click();
      }
    };

    // 1. Hide the task from its menu.
    await openTaskMenu();
    const hideItem = page.getByRole("button", { name: "Hide this task", exact: true });
    await expect(hideItem).toBeVisible();
    await capture("01-task-menu-hide");
    await hideItem.click();
    await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}`))).hiddenAt).not.toBeNull();

    // 2. It leaves the task list.
    await page.waitForURL((url) => /\/issues\/?$/.test(url.pathname));
    await expect(row(other.id)).toBeVisible({ timeout: 30_000 });
    await expect(row(task.id)).toHaveCount(0);
    await capture("02-list-after-hide");

    // 3. Filters -> Show hidden tasks brings it back, marked as hidden.
    await page.locator('button[title^="Filter"]').first().click();
    const showHidden = page.getByRole("checkbox", { name: "Show hidden tasks" });
    await expect(showHidden).toBeVisible();
    await expect(showHidden).not.toBeChecked();
    await showHidden.click();
    await expect(showHidden).toBeChecked();
    await expect(row(task.id)).toBeVisible({ timeout: 30_000 });
    await capture("03-filters-show-hidden");
    // The choice is kept (in the address or the saved list view): reopening the list keeps it.
    const hiddenListUrl = page.url();
    await page.keyboard.press("Escape");
    await expect(row(task.id).locator('[data-slot="hidden-task-badge"]')).toHaveText("Hidden");
    await expect(row(other.id).locator('[data-slot="hidden-task-badge"]')).toHaveCount(0);
    await expectHiddenTagLayout(row(task.id), testInfo, `show-hidden-${workspace.label}-${viewport.label}`);
    await capture("04-list-hidden-marked");

    // The same menu now offers Unhide this task instead of Hide this task.
    await openTaskMenu();
    await expect(page.getByRole("button", { name: "Unhide this task", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide this task", exact: true })).toHaveCount(0);
    await capture("04b-task-menu-unhide");
    await page.keyboard.press("Escape");
    await page.goto(hiddenListUrl);
    await expect(row(task.id)).toBeVisible({ timeout: 30_000 });
    await expect(row(task.id).locator('[data-slot="hidden-task-badge"]')).toHaveText("Hidden");

    await expectHiddenTagLayout(row(task.id), testInfo, `show-hidden-reopened-${workspace.label}-${viewport.label}`);

    // 4. Open it: the banner offers Unhide.
    await row(task.id).locator("a[data-inbox-issue-link]").first().click();
    const banner = page.getByTestId("hidden-task-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("This task is hidden");
    await capture("05-banner-unhide");
    await banner.getByRole("button", { name: "Unhide", exact: true }).click();
    await expect(banner).toHaveCount(0);
    await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}`))).hiddenAt).toBeNull();
    await capture("06-after-unhide");
    await openTaskMenu();
    await expect(page.getByRole("button", { name: "Hide this task", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unhide this task", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 5. Back in the normal list (Show hidden tasks off), unmarked.
    await page.goto(hiddenListUrl);
    await page.locator('button[title^="Filter"]').first().click();
    const showHiddenAgain = page.getByRole("checkbox", { name: "Show hidden tasks" });
    await expect(showHiddenAgain).toBeChecked();
    await showHiddenAgain.click();
    await expect(showHiddenAgain).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(row(task.id)).toBeVisible({ timeout: 30_000 });
    await expect(row(other.id)).toBeVisible();
    await expect(row(task.id).locator('[data-slot="hidden-task-badge"]')).toHaveCount(0);
    await capture("07-normal-list-after-unhide");
  });
}
