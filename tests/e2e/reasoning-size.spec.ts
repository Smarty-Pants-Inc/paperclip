import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { eq } from "../../server/node_modules/drizzle-orm/index.js";
import {
  agents, closeRegisteredClients, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues,
} from "../../packages/db/src/index.ts";
import { createPiEventProjector } from "../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.ts";

// Real built UI and throwaway server/database; no provider is launched.
// Exercise classic task chat, Coordinator task chat, and the person's standing
// Coordinator chat explicitly: never infer the workspace from a default.
const SHOTS = process.env.REASONING_SHOTS_DIR;
const VIEWPORTS = [{ name: "1440", width: 1440, height: 1000 }, { name: "390", width: 390, height: 844 }] as const;


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


async function measure(page: Page) {
  return page.evaluate((reply) => {
    const answer = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="task-chat-agent-bubble"] p'))
      .find((node) => node.textContent === reply);
    if (!answer) throw new Error("Missing the final answer paragraph for the seeded turn");
    const metrics = (node: Element) => {
      const style = getComputedStyle(node);
      const range = document.createRange();
      range.selectNodeContents(node);
      return { fontSize: style.fontSize, lineHeight: style.lineHeight, left: range.getClientRects()[0]!.left };
    };
    return {
      url: location.pathname,
      coordinatorWorkspace: Boolean(answer.closest(".coordinator-workspace")),
      answer: { ...metrics(answer), html: answer.outerHTML, parent: answer.parentElement!.outerHTML,
        conversationText: answer.closest('[data-conversation-text]')?.getAttribute('data-conversation-text') ?? null,
        nativeFinalResponse: Boolean(answer.closest('[data-testid="task-chat-final-response"]')) },
      reasoning: Array.from(document.querySelectorAll('[data-reasoning-display="inline"] :is(.task-chat-reasoning-headline, .task-chat-reasoning-markdown p)'))
        .map((node) => ({ ...metrics(node), text: node.textContent })),
    };
  }, REPLY);
}

for (const view of ["task", "coordinator-task", "coordinator"] as const) {
  for (const arrival of (view === "coordinator" ? ["saved"] : ["saved", "watching"])) {
  for (const viewport of VIEWPORTS) {
    test(`reasoning matches its answer: ${view} ${viewport.name} ${arrival}`,  async ({ browser, request }) => {
      test.setTimeout(90_000);
      const url = await databaseUrl();
      const db = createDb(url);
      const { company, agent } = await seedAgent(request, db);
      const previous = await json(await request.get("/api/workspace-preferences/me"));
      const experimental = await json(await request.get("/api/instance/settings/experimental"));
      const preferencePath = `/api/companies/${company.id}/workspace-preferences/me`;
      const context = await browser.newContext({ viewport, colorScheme: "dark" });
      try {
        await json(await request.put(preferencePath, { data: { coordinatorWorkspaceEnabled: view !== "task" } }));
        await json(await request.patch("/api/instance/settings/experimental", { data: { enableAgentChat: true, enableClassicTaskInterface: false } }));
        const issue = await seedTask(request, db, company.id, agent.id, `${view}-${viewport.name}`);
        if (view === "coordinator") {
          await db.update(issues).set({ conversationAgentId: agent.id, conversationUserId: previous.userId,
            conversationState: "waiting" }).where(eq(issues.id, issue.id));
        }
        if (arrival === "saved") await seedNativeRun(db, company.id, agent.id, issue.id);
        await context.addInitScript(() => window.localStorage.setItem("paperclip.theme", "dark"));
        const page = await context.newPage();
        await page.goto(view === "coordinator" ? `/${company.issuePrefix}/chats/${agent.id}` : `/${company.issuePrefix}/issues/${issue.identifier}`);
        if (arrival === "watching") {
          await expect(page.getByText("Reasoning should read inline without a click.").first()).toBeVisible({ timeout: 30_000 });
          await seedNativeRun(db, company.id, agent.id, issue.id);
        }
        await expect(page.getByText(REPLY, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
        const more = page.getByRole("button", { name: "More run output", exact: true });
        if (await more.isVisible()) await more.click();
        const inline = page.locator('[data-reasoning-display="inline"]');
        await expect(inline).toHaveCount(2, { timeout: 30_000 });
        await inline.last().evaluate((node) => node.scrollIntoView({ block: "center" }));
        await page.evaluate(() => document.fonts.ready);
        const measured = await measure(page);
        const label = `${process.env.REASONING_SIZE_BRANCH ?? "size"}-${view}-${viewport.name}${arrival === "watching" ? "-watching" : ""}`;
        await test.info().attach(label, { body: JSON.stringify(measured, null, 2), contentType: "application/json" });
        if (SHOTS) {
          await mkdir(SHOTS, { recursive: true });
          await writeFile(path.join(SHOTS, `${label}.json`), JSON.stringify(measured, null, 2));
          await page.screenshot({ path: path.join(SHOTS, `${label}-dark.png`) });
        }
        expect(measured.coordinatorWorkspace).toBe(view !== "task");
        expect(measured.reasoning).toHaveLength(4);
        expect.soft(measured.answer.conversationText, "Every final-answer renderer uses the conversation typography contract").toBe("final");
        for (const line of measured.reasoning) {
          expect.soft(line.fontSize, JSON.stringify(measured)).toBe(measured.answer.fontSize);
          expect.soft(line.lineHeight, JSON.stringify(measured)).toBe(measured.answer.lineHeight);
          expect.soft(Math.abs(line.left - measured.answer.left), JSON.stringify(measured)).toBeLessThanOrEqual(0.5);
        }
      } finally {
        await context.close();
        await request.put(preferencePath, { data: { coordinatorWorkspaceEnabled: previous.coordinatorWorkspaceEnabled } });
        await request.patch("/api/instance/settings/experimental", { data: {
          enableAgentChat: experimental.enableAgentChat, enableClassicTaskInterface: experimental.enableClassicTaskInterface,
        } });
        await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
        await closeRegisteredClients(url);
      }
    });
  }
  }
}
