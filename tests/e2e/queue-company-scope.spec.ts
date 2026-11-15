import path from "node:path";
import { writeFile } from "node:fs/promises";
import { test, expect, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("an offline task stays held after switching companies until explicit Send", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const a = await json(await request.post("/api/companies", { data: { name: `Queue company A ${Date.now()}` } }));
  const b = await json(await request.post("/api/companies", { data: { name: `Queue company B ${Date.now()}` } }));
  // Avoid first-agent onboarding, without requiring a provider or starting work.
  for (const company of [a, b]) {
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
      data: { name: "Queue fixture", role: "engineer", adapterType: "process", runner: "legacy",
        adapterConfig: { command: "/usr/bin/true" }, runtimeConfig: { heartbeat: { enabled: false } } },
    }));
    await json(await request.patch(`/api/agents/${agent.id}`, { data: { status: "paused" } }));
  }
  let blocked = true;
  const creates: Array<{ companyId: string; key: string }> = [];
  await page.route("**/api/companies/*/issues", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const companyId = new URL(route.request().url()).pathname.split("/")[3]!;
    creates.push({ companyId, key: route.request().postDataJSON().idempotencyKey });
    if (blocked) return route.abort("internetdisconnected");
    return route.continue();
  });
  const openNewTask = async () => {
    await page.getByRole("button", { name: /^New task$/i }).first().click({ timeout: 15_000 });
    await expect(page.getByRole("dialog", { name: "New task", exact: true })).toBeVisible();
  };
  const tasksInA = async () => json(await request.get(`/api/companies/${a.id}/issues`));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${a.issuePrefix}/dashboard`);
    await openNewTask();
    await page.getByRole("textbox", { name: "editable markdown" }).fill("Keep this task in its original company");
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    await expect.poll(() => creates.length).toBeGreaterThan(0);
    const originalKey = creates[0]!.key;
    expect(originalKey).toBeTruthy();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.includes(":pending-create:queue:") && key.includes(":request:")))).toBe(true);

    // Switch the actual selected company while the failed create is mounted.
    await expect(page.getByRole("dialog", { name: "New task", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: `Open ${a.name} organization switcher`, exact: true }).click();
    await page.getByRole("menuitem", { name: b.name }).click({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/${b.issuePrefix}/`));
    blocked = false;
    const attemptsBeforeRecovery = creates.length;
    await openNewTask();
    const draft = page.getByRole("textbox", { name: "editable markdown" });
    const draftInB = "Keep this new draft in company B";
    await draft.fill(draftInB);
    const attention = page.getByText(`A task you created in ${a.name} hasn't been sent yet.`, { exact: true });
    await expect(attention).toBeVisible();
    // Span the first automatic resend delay; a drain-only guard would still POST A.
    await page.waitForTimeout(4_000);
    expect(creates).toHaveLength(attemptsBeforeRecovery);
    expect(await tasksInA()).toHaveLength(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await expect(attention).toBeVisible();
      await expect(page.getByRole("button", { name: `Send to ${a.name}`, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
      const capture = process.env.TASK_OUT
        ? path.join(process.env.TASK_OUT, `r5-attention-${width}.png`)
        : testInfo.outputPath(`r5-attention-${width}.png`);
      await page.screenshot({ path: capture, animations: "disabled" });
      await testInfo.attach(`attention-${width}`, { path: capture, contentType: "image/png" });
    }
    await page.getByRole("button", { name: `Send to ${a.name}`, exact: true }).click();
    await expect(attention).toBeHidden();
    await expect(draft).toHaveText(draftInB);
    await expect.poll(async () => (await tasksInA()).length).toBe(1);
    expect(creates.at(-1)).toEqual({ companyId: a.id, key: originalKey });
    expect(await json(await request.get(`/api/companies/${b.id}/issues`))).toHaveLength(0);
    const receipt = {
      companyA: { id: a.id, name: a.name }, companyB: { id: b.id, name: b.name },
      attentionText: `A task you created in ${a.name} hasn't been sent yet.`,
      originalKey, attemptsBeforeRecovery, creates, tasksInAAfterSend: 1, tasksInB: 0,
      preservedDraftInB: draftInB, screenshots: [1440, 390],
    };
    await testInfo.attach("queue-company-scope-receipt", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });
    if (process.env.TASK_OUT) await writeFile(path.join(process.env.TASK_OUT, "r5-e2e-receipt.json"), JSON.stringify(receipt, null, 2));
  } finally {
    await request.patch(`/api/companies/${a.id}`, { data: { status: "archived" } }).catch(() => {});
    await request.patch(`/api/companies/${b.id}`, { data: { status: "archived" } }).catch(() => {});
  }
});
