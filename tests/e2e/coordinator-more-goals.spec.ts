import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

/**
 * E2E: the coordinator sidebar's More flyout lists Goals when the instance
 * experimental flag `enableGoalsSidebarLink` is on, and Goals opens the
 * company's goals page. Desktop opens More from the sidebar; phone opens the
 * sidebar from the menu button first.
 */

async function json<T = Record<string, any>>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

const CAPTURE_DIR = process.env.PAPERCLIP_E2E_CAPTURE_DIR;
let cleanup: { companyId: string; enableGoalsSidebarLink: boolean; coordinatorWorkspaceEnabled: boolean } | undefined;

test.afterEach(async ({ request }) => {
  const state = cleanup;
  cleanup = undefined;
  if (!state) return;
  await request.patch("/api/instance/settings/experimental", { data: { enableGoalsSidebarLink: state.enableGoalsSidebarLink } });
  await request.put(`/api/companies/${state.companyId}/workspace-preferences/me`, { data: { coordinatorWorkspaceEnabled: state.coordinatorWorkspaceEnabled } });
  await request.patch(`/api/companies/${state.companyId}`, { data: { status: "archived" } });
});

test.use({ hasTouch: true });
for (const width of [1440, 390]) test(`More lists Goals and opens the goals page when the Goals link is on (${width})`, async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.route("**/api/announcements/current", route => route.fulfill({ json: null }));
  const original = await json(await request.get("/api/instance/settings/experimental"));
  const company = await json(await request.post("/api/companies", { data: { name: `Goals in More ${randomUUID().slice(0, 8)}` } }));
  const preferences = await json(await request.get("/api/workspace-preferences/me"));
  cleanup = { companyId: company.id, enableGoalsSidebarLink: original.enableGoalsSidebarLink === true, coordinatorWorkspaceEnabled: preferences.coordinatorWorkspaceEnabled === true };
  await json(await request.put(`/api/companies/${company.id}/workspace-preferences/me`, { data: { coordinatorWorkspaceEnabled: true } }));
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableGoalsSidebarLink: true } }));
  await json(await request.post(`/api/companies/${company.id}/goals`, { data: { title: "Ship the coordinator sidebar", level: "company", status: "active" } }));

  const shot = async (name: string) => {
    const file = CAPTURE_DIR ? `${CAPTURE_DIR}/goals-more-${width}-${name}.png` : testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: file });
  };

  await page.goto(`/${company.issuePrefix}/issues`);
  if (width === 390) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
  }
  const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
  await navigation.getByRole("button", { name: "More workspace pages" }).click();
  const more = page.getByRole("dialog", { name: "More workspace pages" });
  const goals = more.getByRole("link", { name: "Goals", exact: true });
  await expect(goals).toBeVisible();
  await expect(goals).toHaveAttribute("href", `/${company.issuePrefix}/goals`);
  const labels = await more.getByRole("link").allTextContents();
  expect(labels.slice(0, 4)).toEqual(["Search", "Dashboard", "Projects", "Goals"]);
  await shot("1-more-open");

  await goals.click();
  await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/goals$`));
  await expect(page.getByText("Ship the coordinator sidebar")).toBeVisible();
  await shot("2-goals-page");

  // Flag off: Goals leaves More.
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableGoalsSidebarLink: false } }));
  await page.goto(`/${company.issuePrefix}/issues`);
  if (width === 390) await page.getByRole("button", { name: "Open sidebar" }).click();
  await navigation.getByRole("button", { name: "More workspace pages" }).click();
  await expect(more.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
  await expect(more.getByRole("link", { name: "Goals", exact: true })).toHaveCount(0);
  await shot("3-flag-off-more");
});
