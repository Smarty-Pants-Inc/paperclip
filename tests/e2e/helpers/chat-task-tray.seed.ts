import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";
import { and, eq } from "../../../server/node_modules/drizzle-orm/index.js";
import {
  agents, agentWakeupRequests, announcementDismissals, authUsers, chatTaskHandoffs, closeRegisteredClients,
  companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRelations, issues,
} from "../../../packages/db/src/index.ts";
import { json } from "../agent-chat.shared";

export type TrayScenario = 0 | 1 | 5 | 24;
export type TrayTask = { id: string; identifier: string; title: string; status: string; updatedAt: string; assigneeAgentId: string | null };

/** Refuse external DBs, developer homes and non-loopback servers before any write. */
async function throwawayDatabase(request: APIRequestContext) {
  const configPath = await realpath(process.env.PAPERCLIP_E2E_SERVER_CONFIG!);
  const temporaryRoot = await realpath(os.tmpdir());
  expect(configPath.startsWith(path.join(temporaryRoot, "paperclip-e2e-home-"))).toBe(true);
  expect(configPath.endsWith("/instances/playwright-e2e/config.json")).toBe(true);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  expect(config.database.mode).toBe("embedded-postgres");
  const dataDir = await realpath(config.database.embeddedPostgresDataDir);
  expect(dataDir.startsWith(configPath.split("/instances/")[0] + path.sep)).toBe(true);
  const health = await request.get("/api/health");
  expect(new URL(health.url()).hostname).toBe("127.0.0.1");
  expect(new URL(health.url()).port).toBe(process.env.PAPERCLIP_E2E_PORT ?? "3199");
  expect(health.ok()).toBe(true);
  const port = (await readFile(path.join(dataDir, "postmaster.pid"), "utf8")).split("\n")[3];
  expect(port).toMatch(/^\d+$/);
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

/** Stable scenario contents; UUIDs isolate independent invocations in the same test DB.
 * Working children are persisted task state, NOT dispatched runs. No provider is invoked.
 */
export async function seedChatTaskTray(request: APIRequestContext, count: TrayScenario) {
  const url = await throwawayDatabase(request);
  const db = createDb(url);
  const originalFlags = await json(await request.get("/api/instance/settings/experimental"));
  const companyId = randomUUID(), agentId = randomUUID(), conversationId = randomUUID();
  const viewerUserId = "local-board", sessionGeneration = 3;
  const prefix = `TR${companyId.slice(0, 6).toUpperCase()}`;
  const now = Date.now();
  const tasks: TrayTask[] = [];
  let dismissedAnnouncementId: string | null = null;
  // Two pairs share updatedAt to exercise identifier tie-breaking.
  const changedAt = (index: number) => new Date(now - (Math.floor(index / 2) + 1) * 3_600_000);
  try {
    await json(await request.patch("/api/instance/settings/experimental", {
      data: { enableAgentChat: true, enableClassicTaskInterface: false },
    }));
    await db.insert(companies).values({ id: companyId, name: `Task tray ${count}`, issuePrefix: prefix, issueCounter: 100 });
    await db.insert(authUsers).values({ id: viewerUserId, name: "Tray reviewer", email: "tray-reviewer@example.test",
      createdAt: new Date(now), updatedAt: new Date(now) }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: viewerUserId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Tray Smarty", role: "general", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "process.exit(99)"] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }, createdByUserId: viewerUserId });
    await db.insert(issues).values({ id: conversationId, companyId, title: "Task tray review chat", status: "in_review",
      conversationAgentId: agentId, conversationUserId: viewerUserId, conversationState: "waiting",
      conversationSessionGeneration: sessionGeneration, assigneeAgentId: agentId,
      visibility: "private", privacyRootIssueId: conversationId, responsibleUserId: viewerUserId,
      createdAt: new Date(now - 7 * 86_400_000) });
    await db.insert(issueComments).values({ companyId, issueId: conversationId, authorType: "agent", authorAgentId: agentId,
      conversationSessionGeneration: sessionGeneration, body: "Here are the tasks from this chat. Open the tray to review them.",
      createdAt: new Date(now - 2 * 86_400_000) });
    const statuses = count === 24
      ? [...Array<string>(8).fill("in_progress"), ...Array<string>(8).fill("blocked"), ...Array<string>(8).fill("todo")]
      : count === 5 ? ["in_progress", "in_progress", "todo", "backlog", "todo"]
        : count === 1 ? ["in_progress"] : [];
    for (const [index, status] of [...statuses, "done", "done", "done", "cancelled", "cancelled"].entries()) {
      const id = randomUUID(), identifier = `${prefix}-${index + 1}`;
      const title = `${index >= count ? "Hidden terminal" : "Open"} ${String(index + 1).padStart(2, "0")} — ${status === "blocked" ? index < 14 ? "Waiting for the running child" : "Reviewer: approve the draft" : "Prepare the detailed release checklist with a deliberately long title for narrow screens"}`;
      const personWait = count === 24 && index >= 14 && index < 16;
      // An agent-assigned in_progress task with no live run projects to todo.
      // Use human/unassigned working rows, not fake active runs. Agent owners
      // remain represented among the blocked and up-next rows.
      const assigneeAgentId = status !== "in_progress" && index % 3 === 0 ? agentId : null;
      const assigneeUserId = status === "in_progress"
        ? index % 2 === 0 ? viewerUserId : null : index % 3 === 1 ? viewerUserId : null;
      await db.insert(issues).values({ id, companyId, title, status, identifier, issueNumber: index + 1,
        createdByUserId: viewerUserId, responsibleUserId: viewerUserId,
        assigneeAgentId, assigneeUserId,
        unblockDescriptor: status === "blocked" ? {
          owner: personWait ? { userId: viewerUserId } : { agentId },
          action: personWait ? "Approve the draft" : "Finish the running child",
        } : null,
        createdAt: new Date(now - 86_400_000 + index * 1_000), updatedAt: changedAt(index) });
      await db.insert(chatTaskHandoffs).values({ taskId: id, companyId, conversationId, agentId, sessionGeneration,
        createdAt: new Date(now - 86_400_000 + index * 1_000) });
      if (count === 24 && index >= 8 && index < 14) {
        const childId = randomUUID();
        await db.insert(issues).values({ id: childId, companyId, title: `Running child ${index - 7}`, status: "in_progress",
          parentId: id, assigneeAgentId: agentId, responsibleUserId: viewerUserId, createdByUserId: viewerUserId });
        await db.insert(issueRelations).values({ companyId, issueId: childId, relatedIssueId: id, type: "blocks" });
      }
      tasks.push({ id, identifier, title, status, updatedAt: changedAt(index).toISOString(), assigneeAgentId });
    }
    // Dismiss the actual first-session overlay through its supported API. On
    // phones it covers the composer and intercepts clicks; do not force clicks
    // through it or hide it with injected CSS. Restore the preference below.
    const announcement = await json(await request.get("/api/announcements/current"));
    if (announcement) {
      const response = await request.post(`/api/announcements/${encodeURIComponent(announcement.id)}/dismiss`, { data: { companyId } });
      expect(response.status()).toBe(204);
      dismissedAnnouncementId = announcement.id;
    }
  } catch (error) {
    await closeRegisteredClients(url);
    throw error;
  }
  return {
    companyId, agentId, conversationId, viewerUserId, sessionGeneration, tasks,
    route: `/${prefix}/chats/${agentId}`,
    async assertQuiescent() {
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakes.filter(wake => !["cancelled", "consumed", "failed", "skipped"].includes(wake.status))).toEqual([]);
      // A deliberately disabled wake is a terminal audit record, not pending work.
      for (const wake of wakes.filter(wake => wake.status === "skipped")) {
        expect(wake).toMatchObject({ reason: "heartbeat.wakeOnDemand.disabled", runId: null });
      }
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs).toEqual([]);
      return { providerRunIds: runs.map(run => run.id), wakeups: wakes.map(wake => ({ id: wake.id, status: wake.status, reason: wake.reason })) };
    },
    async createTask() {
      // Exercise the real supported producer: accept a suggested task in this chat.
      const interaction = await json(await request.post(`/api/issues/${conversationId}/interactions`, { data: {
        kind: "suggest_tasks", payload: { version: 1, tasks: [{ clientKey: "new-task", title: "New task shimmer probe",
          initialPlan: "No execution: render the new handoff only." }] },
      } }));
      return json(await request.post(`/api/issues/${conversationId}/interactions/${interaction.id}/accept`, { data: {} }));
    },
    async dispose() {
      try {
        await json(await request.post(`/api/agents/${agentId}/pause`));
        const agent = await json(await request.get(`/api/agents/${agentId}`));
        expect(agent.status).toBe("paused");
        await json(await request.patch(`/api/companies/${companyId}`, { data: { status: "archived" } }));
      } finally {
        try {
          if (dismissedAnnouncementId) await db.delete(announcementDismissals).where(and(
            eq(announcementDismissals.userId, viewerUserId), eq(announcementDismissals.announcementId, dismissedAnnouncementId),
          ));
          await json(await request.patch("/api/instance/settings/experimental", { data: {
            enableAgentChat: originalFlags.enableAgentChat, enableClassicTaskInterface: originalFlags.enableClassicTaskInterface,
          } }));
        } finally { await closeRegisteredClients(url); }
      }
    },
  };
}

export type TraySeed = Awaited<ReturnType<typeof seedChatTaskTray>>;
