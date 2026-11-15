import { expect, test, type Page } from "@playwright/test";

// The project's pill follows its tasks: Not started with no tasks, In progress
// while a begun task is open, Done once none is open. The stored project
// status is not what the pill shows, and Configuration has no Status control.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

function projectRow(page: Page, name: string) {
  return page.getByRole("link").filter({ hasText: name });
}

// The project page's task list has settled, so the capture shows the tasks.
async function tasksLoaded(page: Page) {
  await expect(page.getByRole("status", { name: "Loading tasks" })).toHaveCount(0, { timeout: 15_000 });
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const viewport of VIEWPORTS) {
  test(`the project pill follows its tasks (${viewport.width})`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const company = await (await page.request.post("/api/companies", { data: { name: `Project pill ${viewport.name}` } })).json();
    const projectName = `My private tasks ${viewport.name}`;
    // A stored status the pill must not show.
    const projectResponse = await page.request.post(`/api/companies/${company.id}/projects`, {
      data: { name: projectName, status: "completed" },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = await projectResponse.json();
    const session = await (await page.request.get("/api/auth/get-session")).json();
    const userId: string = session.user.id;
    const capture = (name: string) => page.screenshot({ path: testInfo.outputPath(`pill-${viewport.width}-${name}.png`) });
    const listUrl = `/${company.issuePrefix}/projects`;
    const detailUrl = `/${company.issuePrefix}/projects/${project.urlKey}/issues`;

    const row = projectRow(page, projectName);
    // The count sits in the trailing column from sm up and leads the
    // description line below it; exactly one copy is visible at a time.
    const count = row.getByTestId("project-task-count").filter({ visible: true });
    const pill = row.getByTestId("project-status-pill");
    const detailPill = page.getByTestId("project-status-pill");

    // No tasks: Not started.
    await page.goto(listUrl);
    await expect(row.getByText(projectName, { exact: true })).toBeVisible();
    await expect(pill).toHaveText("Not started");
    await expect(pill).toBeVisible();
    await expect(count).toHaveText("No tasks");
    await expect(row.getByText("completed", { exact: true })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await capture("notstarted");
    await page.goto(detailUrl);
    await expect(detailPill).toHaveText("Not started");
    await tasksLoaded(page);
    await noHorizontalOverflow(page);
    await capture("detail-notstarted");

    // One task in progress: In progress.
    const issueResponse = await page.request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Write the plan", projectId: project.id, status: "in_progress", assigneeUserId: userId },
    });
    expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
    const issue = await issueResponse.json();
    await page.goto(listUrl);
    await expect(pill).toHaveText("In progress");
    await expect(pill).toBeVisible();
    await expect(count).toHaveText("1 open");
    await expect(count).toBeVisible();
    await noHorizontalOverflow(page);
    await capture("inprogress");
    await page.goto(detailUrl);
    await expect(detailPill).toHaveText("In progress");
    await expect(page.getByText("Write the plan").first()).toBeVisible();
    await tasksLoaded(page);
    await noHorizontalOverflow(page);
    await capture("detail-inprogress");

    // Cancel it: Done, and the row reads All tasks done.
    const cancelled = await page.request.patch(`/api/issues/${issue.id}`, { data: { status: "cancelled" } });
    expect(cancelled.ok()).toBe(true);
    await page.goto(listUrl);
    await expect(pill).toHaveText("Done");
    await expect(pill).toBeVisible();
    await expect(count).toHaveText("All tasks done");
    await expect(count).toHaveAttribute("title", "0 open of 1 task");
    await noHorizontalOverflow(page);
    await capture("done");
    await page.goto(detailUrl);
    await expect(detailPill).toHaveText("Done");
    await tasksLoaded(page);
    await noHorizontalOverflow(page);
    await capture("detail-done");

    // The stored status is untouched; nothing wrote it.
    expect((await (await page.request.get(`/api/projects/${project.id}`)).json()).status).toBe("completed");

    // Configuration has no hand-set Status control.
    await page.goto(`/${company.issuePrefix}/projects/${project.urlKey}/configuration`);
    await expect(page.getByText("Visibility").first()).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("project-status")).toHaveCount(0);
    await capture("configuration");
  });
}
