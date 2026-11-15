import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

// Instance setting: show agent-created tasks in task lists by default.
// Upstream's default (hidden) is unchanged; an operator opts in with the
// documented general settings PATCH, and the project's Tasks page then shows
// an agent-authored task without any filter being touched.

const SHOTS = process.env.PAPERCLIP_E2E_SCREENSHOT_DIR;

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function setDefault(request: APIRequestContext, on: boolean) {
  const general = await json(await request.patch("/api/instance/settings/general", {
    data: { taskListsShowAgentCreatedByDefault: on },
  }));
  expect(general.taskListsShowAgentCreatedByDefault).toBe(on);
}

async function capture(page: import("@playwright/test").Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`project Tasks follow the instance agent-created default (${viewport.width})`, async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const company = await json(await request.post("/api/companies", {
      data: { name: `Agent-created default ${viewport.width}` },
    }));
    try {
      const project = await json(await request.post(`/api/companies/${company.id}/projects`, {
        data: { name: "Launch plan" },
      }));
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "Planner", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      } }));
      const key = await json(await request.post(`/api/agents/${agent.id}/keys`, { data: { name: "e2e" } }));
      const agentTask = await json(await request.post(`/api/companies/${company.id}/issues`, {
        headers: { Authorization: `Bearer ${key.token}` },
        data: { title: "Agent drafted launch checklist", status: "todo", projectId: project.id },
      }));
      expect(agentTask.createdByAgentId).toBe(agent.id);
      const personTask = await json(await request.post(`/api/companies/${company.id}/issues`, {
        data: { title: "Person reviews launch copy", status: "todo", projectId: project.id },
      }));

      const projectTasks = `/${company.issuePrefix}/projects/${project.urlKey ?? project.id}/issues`;
      const agentRow = page.locator(`[data-issue-row-id="${agentTask.id}"]`);
      const personRow = page.locator(`[data-issue-row-id="${personTask.id}"]`);

      await setDefault(request, true);
      await page.goto(projectTasks);
      await expect(personRow).toBeVisible({ timeout: 20_000 });
      await expect(agentRow).toBeVisible();
      await expect(page.locator('button[title^="Filters:"]')).toHaveCount(0);
      await capture(page, `after-setting-on-${viewport.width}.png`);

      await setDefault(request, false);
      await page.reload();
      await expect(personRow).toBeVisible({ timeout: 20_000 });
      await expect(agentRow).toHaveCount(0);
      await capture(page, `before-setting-off-${viewport.width}.png`);
    } finally {
      await setDefault(request, false);
    }
  });
}
