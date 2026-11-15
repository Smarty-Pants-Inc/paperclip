import { expect, test, type Page } from "@playwright/test";

// A project reads finished when its work is done: once its only task is
// cancelled the Projects row says "All tasks done", and the badge keeps the
// project's own status until a person sets it in Configuration.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

function projectRow(page: Page, name: string) {
  return page.getByRole("link").filter({ hasText: name });
}

for (const viewport of VIEWPORTS) {
  test(`a project with no open task reads done, and its status is set in Configuration (${viewport.width})`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const company = await (await page.request.post("/api/companies", { data: { name: `Project done ${viewport.name}` } })).json();
    const projectName = `My private tasks ${viewport.name}`;
    const projectResponse = await page.request.post(`/api/companies/${company.id}/projects`, {
      data: { name: projectName, status: "in_progress" },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = await projectResponse.json();
    const issueResponse = await page.request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Write the plan", projectId: project.id, status: "todo" },
    });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json();

    await page.goto(`/${company.issuePrefix}/projects`);
    const row = projectRow(page, projectName);
    // The count sits in the trailing column from sm up and leads the
    // description line below it; exactly one copy is visible at a time.
    const count = row.getByTestId("project-task-count").filter({ visible: true });
    await expect(row.getByText(projectName, { exact: true })).toBeVisible();
    await expect(count).toHaveText("1 open");
    await expect(count).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`project-done-${viewport.width}-1-before.png`) });

    const cancelled = await page.request.patch(`/api/issues/${issue.id}`, { data: { status: "cancelled" } });
    expect(cancelled.ok()).toBe(true);
    await page.reload();
    await expect(count).toHaveText("All tasks done");
    await expect(count).toBeVisible();
    await expect(count).toHaveAttribute("title", "0 open of 1 task");
    // Not changed automatically: the badge is still the project's own status.
    await expect(row.getByText("in progress", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`project-done-${viewport.width}-2-all-tasks-done.png`) });

    await page.goto(`/${company.issuePrefix}/projects/${project.urlKey}/configuration`);
    const status = page.getByRole("combobox", { name: "Status", exact: true });
    await expect(status).toHaveValue("in_progress");
    await expect(status.locator("option")).toHaveText(["Backlog", "Planned", "In progress", "Completed", "Cancelled"]);
    await status.selectOption("completed");
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`project-done-${viewport.width}-3-configuration-completed.png`) });
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}`)).json()).status).toBe("completed");

    await page.goto(`/${company.issuePrefix}/projects`);
    await expect(count).toHaveText("All tasks done");
    await expect(row.getByText("completed", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`project-done-${viewport.width}-4-after.png`) });
  });
}
