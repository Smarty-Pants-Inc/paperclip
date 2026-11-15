import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type APIResponse, type Browser, type Page } from "@playwright/test";
import { closeRegisteredClients, createDb, heartbeatRuns, issueComments } from "../../packages/db/src/index.ts";

// Reasoning display, end to end on the real server and its own database:
// a saved run whose transcript holds real Codex reasoning items, shown
// inline. "after" (default) sets the person's per-agent preference on the
// agent's page and proves it follows them into a fresh browser context.
// REASONING_E2E_MODE=before runs the same capture on the base build, where
// inline reasoning was a per-browser switch (localStorage).
const MODE = process.env.REASONING_E2E_MODE === "before" ? "before" : "after";
const SHOTS = process.env.REASONING_SHOTS_DIR;
const VIEWPORTS = [{ name: "1440", width: 1440, height: 1000 }, { name: "390", width: 390, height: 844 }] as const;
const THEMES = ["light", "dark"] as const;

const REASONING = [
  "**Reading the adapter defaults**\n\nThe Codex adapter folds reasoning unless it declares otherwise, so I check its `transcriptPresentation` before changing anything.",
  "**Comparing with the agent page**\n\nThe person's choice for this agent should win. The adapter default applies only when they *have not* picked one.",
];
const REPLY = "Reasoning now follows the setting on the agent's page.";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function databaseUrl() {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  return config.database.mode === "postgres" ? config.database.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${(await readFile(
      path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8")).split("\n")[3]}/paperclip`;
}

/** Codex `exec --json` stdout, stored as the run log a real codex_local run writes. */
function codexRunLog(startedAt: number) {
  const events = [
    { type: "thread.started", thread_id: `thread-${randomUUID()}` },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: REASONING[0] } },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'rg -n liveReasoningView ui/src/adapters'", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc 'rg -n liveReasoningView ui/src/adapters'",
      aggregated_output: "ui/src/adapters/types.ts:90:    liveReasoningView?: \"fold\" | \"inline\" | \"ticker\" | \"scrollLog\";\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "item_2", type: "reasoning", text: REASONING[1] } },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: REPLY } },
    { type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 180 } },
  ];
  return events.map((event, index) => JSON.stringify({
    ts: new Date(startedAt + (index + 1) * 1000).toISOString(), stream: "stdout", chunk: `${JSON.stringify(event)}\n`, seq: index + 1,
  })).join("\n") + "\n";
}

async function seedChat(request: APIRequestContext) {
  const url = await databaseUrl();
  const db = createDb(url);
  const company = await json(await request.post("/api/companies", { data: { name: `Reasoning display ${Date.now()}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Reasoner", role: "engineer", adapterType: "codex_local", runner: "legacy",
    adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
    title: "Make reasoning follow the agent setting", description: "Show how reasoning should be displayed.",
    status: "backlog", assigneeAgentId: agent.id,
  } }));
  const runId = randomUUID();
  const startedAt = Date.now() - 60_000;
  const logRef = path.join(company.id, agent.id, `${runId}.ndjson`);
  const logFile = path.join(path.dirname(process.env.PAPERCLIP_E2E_SERVER_CONFIG!), "data", "run-logs", logRef);
  const log = codexRunLog(startedAt);
  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, log, { mode: 0o600 });
  await db.insert(heartbeatRuns).values({
    id: runId, companyId: company.id, agentId: agent.id, issueId: issue.id, invocationSource: "assignment",
    status: "succeeded", runtimeMode: "legacy", startedAt: new Date(startedAt), finishedAt: new Date(startedAt + 9_000),
    contextSnapshot: { issueId: issue.id }, logStore: "local_file", logRef, logBytes: Buffer.byteLength(log),
  });
  await db.insert(issueComments).values({
    companyId: company.id, issueId: issue.id, authorType: "agent", authorAgentId: agent.id, body: REPLY,
    createdByRunId: runId, createdAt: new Date(startedAt + 8_000),
  });
  return { company, agent, issue, runId, close: () => closeRegisteredClients(url) };
}

async function openChat(page: Page, prefix: string, identifier: string) {
  await page.goto(`/${prefix}/issues/${identifier}`);
  await expect(page.getByText(REPLY, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  // A saved compact reply loads its run transcript on request.
  const more = page.getByRole("button", { name: "More run output", exact: true });
  if (await more.isVisible().catch(() => false)) await more.click();
  await expect(page.getByText("Ran 1 command", { exact: false }).or(page.locator('[data-reasoning-display="inline"]')).first())
    .toBeVisible({ timeout: 30_000 }).catch(() => undefined);
}

/** Measured contrast of each reasoning line against the surface it sits on. */
async function reasoningContrast(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000"; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255] as const;
    };
    const over = (top: readonly number[], bottom: readonly number[]) =>
      [0, 1, 2].map((i) => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);
    const surface = (node: Element | null): number[] => {
      const layers: (readonly number[])[] = [];
      for (let cursor = node; cursor; cursor = cursor.parentElement) {
        const layer = rgba(getComputedStyle(cursor).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] >= 1) break;
      }
      return layers.reverse().reduce<number[]>((acc, layer) => over(layer, acc), [255, 255, 255, 1]);
    };
    const luminance = (rgb: readonly number[]) => {
      const [r, g, b] = rgb.slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: readonly number[], b: readonly number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const nodes = Array.from(document.querySelectorAll('[data-reasoning-display="inline"] :is(.task-chat-reasoning-headline, .task-chat-reasoning-markdown p)'));
    return nodes.map((node) => {
      const style = getComputedStyle(node);
      const bg = surface(node);
      return { text: node.textContent?.slice(0, 32), fontStyle: style.fontStyle, color: style.color,
        contrast: Math.round(ratio(over(rgba(style.color), bg), bg) * 100) / 100 };
    });
  });
}

async function capture(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function scrollToReasoning(page: Page) {
  await page.locator('[data-reasoning-display="inline"]').first().scrollIntoViewIfNeeded();
}

async function captureMatrix(browser: Browser, chat: Awaited<ReturnType<typeof seedChat>>, label: string) {
  const report: Record<string, unknown> = {};
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      // A fresh context each time: nothing carries over from another browser.
      const context = await browser.newContext({ viewport, colorScheme: theme });
      if (MODE === "before") {
        await context.addInitScript(() => window.localStorage.setItem("paperclip:task-chat:reasoning-display:v1", "inline"));
      }
      await context.addInitScript((value) => window.localStorage.setItem("paperclip.theme", value), theme);
      const page = await context.newPage();
      await openChat(page, chat.company.issuePrefix, chat.issue.identifier);
      const inline = page.locator('[data-reasoning-display="inline"]');
      await expect(inline).toHaveCount(2, { timeout: 30_000 });
      await expect(inline.nth(0)).toContainText("Reading the adapter defaults");
      await expect(inline.nth(1)).toContainText("Comparing with the agent page");
      await scrollToReasoning(page);
      const measured = await reasoningContrast(page);
      report[`${viewport.name}-${theme}`] = measured;
      if (MODE === "after") {
        // The per-chat switch is gone.
        await expect(page.getByTestId("task-chat-reasoning-display-toggle")).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Reasoning:/ })).toHaveCount(0);
        for (const line of measured) {
          expect(line.fontStyle, JSON.stringify(line)).toBe("italic");
          expect(line.contrast, JSON.stringify(line)).toBeGreaterThanOrEqual(4.5);
        }
      }
      await capture(page, `${label}-${viewport.name}-${theme}`);
      await context.close();
    }
  }
  if (SHOTS) await writeFile(path.join(SHOTS, `${label}-contrast.json`), JSON.stringify(report, null, 2));
  return report;
}

test("reasoning display: inline reasoning look and the agent-page preference that follows the person", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const chat = await seedChat(request);
  try {
    if (MODE === "before") {
      await captureMatrix(browser, chat, "before");
      return;
    }

    // 1. Unset: the adapter default (Codex folds), even with the old
    //    per-browser value present. No inline reasoning, no switch.
    const first = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await first.addInitScript(() => window.localStorage.setItem("paperclip:task-chat:reasoning-display:v1", "inline"));
    const page = await first.newPage();
    await openChat(page, chat.company.issuePrefix, chat.issue.identifier);
    await expect(page.locator('[data-reasoning-display="inline"]')).toHaveCount(0);
    await expect(page.getByTestId("task-chat-reasoning-display-toggle")).toHaveCount(0);

    // 2. Set it on the agent's page. It is the person's preference, not the agent's.
    const agentBefore = await json(await request.get(`/api/agents/${chat.agent.id}`));
    const revisionsBefore = await json(await request.get(`/api/agents/${chat.agent.id}/config-revisions`));
    await page.goto(`/${chat.company.issuePrefix}/agents/${chat.agent.urlKey ?? chat.agent.id}/runtime`);
    const setting = page.getByTestId("agent-display-settings");
    await expect(setting).toBeVisible({ timeout: 30_000 });
    await expect(setting.getByRole("radio", { name: "Folded" })).toHaveAttribute("aria-checked", "true");
    await expect(setting).toContainText("Default for this harness: Folded");
    await setting.scrollIntoViewIfNeeded();
    await capture(page, "agent-page-setting-unset-1440");
    const saved = page.waitForResponse((response) => response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/companies/${chat.company.id}/workspace-preferences/me`);
    await setting.getByRole("radio", { name: "Inline" }).click();
    expect((await saved).ok()).toBe(true);
    await expect(setting.getByRole("radio", { name: "Inline" })).toHaveAttribute("aria-checked", "true");
    await capture(page, "agent-page-setting-inline-1440");
    const mine = await json(await request.get("/api/workspace-preferences/me"));
    expect(mine.agentReasoningDisplay).toEqual({ [chat.agent.id]: "inline" });
    // The agent row and its configuration history are untouched.
    const agentAfter = await json(await request.get(`/api/agents/${chat.agent.id}`));
    expect(agentAfter.updatedAt).toBe(agentBefore.updatedAt);
    expect(agentAfter.adapterConfig).toEqual(agentBefore.adapterConfig);
    expect(agentAfter.runtimeConfig).toEqual(agentBefore.runtimeConfig);
    expect(await json(await request.get(`/api/agents/${chat.agent.id}/config-revisions`))).toEqual(revisionsBefore);
    await first.close();

    // 3. A fresh browser context (no localStorage at all) follows the preference,
    //    at 1440 and 390, light and dark.
    await captureMatrix(browser, chat, "after");

    // Agent page at 390 too.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phonePage = await phone.newPage();
    await phonePage.goto(`/${chat.company.issuePrefix}/agents/${chat.agent.urlKey ?? chat.agent.id}/runtime`);
    const phoneSetting = phonePage.getByTestId("agent-display-settings");
    await expect(phoneSetting.getByRole("radio", { name: "Inline" })).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await phoneSetting.scrollIntoViewIfNeeded();
    await capture(phonePage, "agent-page-setting-inline-390");
    await phone.close();
  } finally {
    await request.patch(`/api/companies/${chat.company.id}`, { data: { status: "archived" } }).catch(() => undefined);
    await chat.close();
  }
});
