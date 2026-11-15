import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type APIResponse, type Browser, type Page } from "@playwright/test";
import { eq } from "../../server/node_modules/drizzle-orm/index.js";
import {
  agents, closeRegisteredClients, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues,
} from "../../packages/db/src/index.ts";
import { createPiEventProjector } from "../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.ts";

// Look-only reasoning, end to end on the real server and its own database.
// A paperclip_runner agent on the pi_rpc provider (every one of Paul's agents)
// finishes a native run while its task chat is open. The run's persisted
// events hold two reasoning items, projected from Pi 1.5.2 RPC wire events by
// the runner's own Pi projector. With nothing clicked, each fresh browser shows
// that reasoning inline: plain italic muted text at the answer's left edge,
// with no per-chat switch. A stale folded per-browser value changes nothing.
// (A task reopened later keeps its older runs' output behind the existing
// "More run output" history control; that compaction is not part of this look.)
const SHOTS = process.env.REASONING_SHOTS_DIR;
const VIEWPORTS = [{ name: "1440", width: 1440, height: 1000 }, { name: "390", width: 390, height: 844 }] as const;
const THEMES = ["light", "dark"] as const;

const REASONING = [
  "**Reading the runner defaults**\n\nThe native runner declares how its reasoning shows, so I check its `transcriptPresentation` before changing anything.",
  "**Checking the chat**\n\nThe reasoning should read inline with *no* click, set apart only by italics and a quieter tone.",
];
const REPLY = "Reasoning from the runner now reads inline in the chat.";
const COMMAND = "rg -n liveReasoningView ui/src/adapters";

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

/** Pi 1.5.2 RPC stdout for one turn: think, run one command, think, answer. */
function piWire(startedAt: number) {
  const usage = { input: 1200, output: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 1290, cost: { total: 0 } };
  const assistant = (responseId: string, at: number, content: unknown[], stopReason: string) => ({
    type: "message_end",
    message: { role: "assistant", provider: "openai", model: "gpt-5.1", responseId, timestamp: at, stopReason, usage, content },
  });
  const thinking = (index: number, value: string) => [
    { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: index } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: index, delta: value } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: index, content: value } },
  ];
  return [
    { type: "message_start", message: { role: "assistant" } },
    ...thinking(0, REASONING[0]!),
    assistant("resp_1", startedAt + 2_000, [
      { type: "thinking", thinking: REASONING[0] },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: COMMAND } },
    ], "toolUse"),
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: COMMAND } },
    { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false, durationMs: 40,
      result: { content: [{ type: "text", text: "ui/src/adapters/types.ts:90:    liveReasoningView?: \"fold\" | \"inline\" | \"ticker\" | \"scrollLog\";\n" }] } },
    { type: "message_start", message: { role: "assistant" } },
    ...thinking(0, REASONING[1]!),
    assistant("resp_2", startedAt + 6_000, [
      { type: "thinking", thinking: REASONING[1] },
      { type: "text", text: REPLY },
    ], "stop"),
  ];
}

type Db = ReturnType<typeof createDb>;

/** A company and a paperclip_runner / pi_rpc agent, seeded without a provider launch. */
async function seedAgent(request: APIRequestContext, db: Db) {
  const company = await json(await request.post("/api/companies", { data: { name: `Reasoning look-only ${Date.now()}` } }));
  const [agent] = await db.insert(agents).values({
    id: randomUUID(), companyId: company.id, name: "Pi Reasoner", role: "engineer", status: "idle", lifecycleState: "ready",
    adapterType: "paperclip_runner",
    adapterConfig: { provider: "pi_rpc", model: "gpt-5.1", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  }).returning();
  return { company, agent: agent! };
}

/** An in-progress task assigned to the agent; assigned after creation so no run is admitted. */
async function seedTask(request: APIRequestContext, db: Db, companyId: string, agentId: string, label: string) {
  const issue = await json(await request.post(`/api/companies/${companyId}/issues`, { data: {
    title: `Show the runner's reasoning inline (${label})`, description: "Reasoning should read inline without a click.",
    status: "backlog",
  } }));
  await db.update(issues).set({ status: "in_progress", assigneeAgentId: agentId }).where(eq(issues.id, issue.id));
  return issue as { id: string; identifier: string };
}

/**
 * The agent's finished native turn: the heartbeat run, its persisted PRP
 * events (projected from Pi RPC wire events by the runner's own projector,
 * thinking included) and the reply comment.
 */
async function seedNativeRun(db: Db, companyId: string, agentId: string, issueId: string) {
  const runId = randomUUID();
  const startedAt = Date.now() - 9_000;
  const commentId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId, companyId, agentId, issueId, nativeIssueId: issueId, invocationSource: "assignment",
    status: "succeeded", runtimeMode: "native", nativePhase: "committed",
    startedAt: new Date(startedAt), finishedAt: new Date(startedAt + 8_500),
    contextSnapshot: { issueId },
    resultJson: { presentationDecision: { commentId } },
  });
  const projector = createPiEventProjector({ runId, turnId: "turn-1", includeThinking: true });
  const projected = piWire(startedAt).flatMap((event) => projector.project(event));
  expect(projected.filter((event) => event.eventType === "item.completed" && event.payload.kind === "reasoning")).toHaveLength(2);
  await db.insert(heartbeatRunEvents).values(projected.map((event, index) => {
    const seq = index + 1;
    const sourceEventId = `pi-${runId}-${seq}`;
    return {
      companyId, runId, agentId, seq, eventType: event.eventType, stream: "system", level: "info",
      sourceInstanceId: "pi-runner", sourceEventId, sourceSeq: seq, protocolSchemaVersion: 1,
      payload: { prpEvent: {
        schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId, sourceSeq: seq, sourceInstanceId: "pi-runner",
        sourceKind: "runner", priority: 1, normalizedSessionId: `pi-session-${runId}`,
        emittedAt: new Date(startedAt + seq * 100).toISOString(), ...event,
      } },
      createdAt: new Date(startedAt + seq * 100),
    };
  }));
  await db.insert(issueComments).values({
    id: commentId, companyId, issueId, authorType: "agent", authorAgentId: agentId, body: REPLY,
    createdByRunId: runId, createdAt: new Date(startedAt + 8_000),
  });
  return { runId, persistedEvents: projected.length };
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

/** No box around inline reasoning; its text starts at the answer text's left edge. */
async function plainGeometry(page: Page) {
  return page.evaluate((reply) => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-reasoning-display="inline"]'));
    const answer = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="task-chat-agent-bubble"] p'))
      .find((node) => node.textContent?.includes(reply));
    const textLeft = (node: Element) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return Math.round(range.getClientRects()[0]!.left * 10) / 10;
    };
    return {
      answerLeft: answer ? textLeft(answer) : null,
      answerFontSize: answer ? getComputedStyle(answer).fontSize : null,
      blocks: blocks.map((block) => {
        const style = getComputedStyle(block);
        const lines = Array.from(block.querySelectorAll(".task-chat-reasoning-headline, .task-chat-reasoning-markdown p"));
        return {
          state: block.dataset.state,
          border: style.borderTopWidth + " " + style.borderLeftWidth,
          background: style.backgroundColor,
          radius: style.borderTopLeftRadius,
          paddingBlock: style.paddingTop + " " + style.paddingBottom,
          bullets: block.querySelectorAll("ul, li, .rounded-full").length,
          fontSize: lines[0] ? getComputedStyle(lines[0]).fontSize : null,
          lineLefts: lines.map(textLeft),
        };
      }),
    };
  }, REPLY);
}

async function captureMatrix(browser: Browser, request: APIRequestContext, db: Db) {
  const { company, agent } = await seedAgent(request, db);
  const report: Record<string, unknown> = { agentId: agent.id, adapterType: agent.adapterType,
    provider: (agent.adapterConfig as { provider?: string }).provider };
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const label = `${viewport.name}-${theme}`;
      const issue = await seedTask(request, db, company.id, agent.id, label);
      // A fresh context each time; the only stored value is the stale folded
      // per-browser choice the removed switch used to write.
      const context = await browser.newContext({ viewport, colorScheme: theme });
      await context.addInitScript((value) => {
        window.localStorage.setItem("paperclip.theme", value);
        window.localStorage.setItem("paperclip:task-chat:reasoning-display:v1", "fold");
      }, theme);
      const page = await context.newPage();
      // Paul has the chat open; the agent's turn lands while he watches.
      await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
      await expect(page.getByText("Reasoning should read inline without a click.").first()).toBeVisible({ timeout: 30_000 });
      const run = await seedNativeRun(db, company.id, agent.id, issue.id);
      await expect(page.getByText(REPLY, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      const inline = page.locator('[data-reasoning-display="inline"]');
      // Inline with no click.
      await expect(inline).toHaveCount(2, { timeout: 30_000 });
      await expect(inline.nth(0)).toContainText("Reading the runner defaults");
      await expect(inline.nth(1)).toContainText("Checking the chat");
      // No per-chat switch.
      await expect(page.getByTestId("task-chat-reasoning-display-toggle")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Reasoning:/ })).toHaveCount(0);
      await inline.last().evaluate((node) => node.scrollIntoView({ block: "center" }));
      const measured = await reasoningContrast(page);
      expect(measured.length).toBeGreaterThanOrEqual(4);
      for (const line of measured) {
        expect(line.fontStyle, JSON.stringify(line)).toBe("italic");
        expect(line.contrast, JSON.stringify(line)).toBeGreaterThanOrEqual(4.5);
      }
      // Plain text in the turn: no box, indent or bullet; the answer's size and left edge.
      const geometry = await plainGeometry(page);
      report[label] = { issue: issue.identifier, ...run, contrast: measured, geometry };
      expect(geometry.answerLeft, JSON.stringify(geometry)).not.toBeNull();
      for (const block of geometry.blocks) {
        expect(block.border, JSON.stringify(block)).toBe("0px 0px");
        expect(block.background, JSON.stringify(block)).toBe("rgba(0, 0, 0, 0)");
        expect(block.radius, JSON.stringify(block)).toBe("0px");
        expect(block.paddingBlock, JSON.stringify(block)).toBe("0px 0px");
        expect(block.bullets, JSON.stringify(block)).toBe(0);
        expect(block.fontSize, JSON.stringify(block)).toBe(geometry.answerFontSize);
        for (const left of block.lineLefts) {
          expect(Math.abs(left - geometry.answerLeft!), JSON.stringify(geometry)).toBeLessThanOrEqual(0.5);
        }
      }
      if (SHOTS) {
        await mkdir(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, `lookonly-${label}.png`), fullPage: false });
      }
      await context.close();
    }
  }
  if (SHOTS) await writeFile(path.join(SHOTS, "lookonly-measurements.json"), JSON.stringify(report, null, 2));
  return company;
}

test("look-only reasoning: a paperclip_runner/pi_rpc run's reasoning is inline and plain with no click and no switch", async ({ browser, request }) => {
  test.setTimeout(300_000);
  const url = await databaseUrl();
  const db = createDb(url);
  let companyId: string | null = null;
  try {
    companyId = (await captureMatrix(browser, request, db)).id;
  } finally {
    if (companyId) await request.patch(`/api/companies/${companyId}`, { data: { status: "archived" } }).catch(() => undefined);
    await closeRegisteredClients(url);
  }
});
