import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issues, principalPermissionGrants,
} from "@paperclipai/db";
import { characterStateForAgent } from "@paperclipai/shared";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { environmentRoutes } from "../routes/environments.js";
import { issueRoutes } from "../routes/issues.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { agentFileSaveHeld } from "../services/agent-directory-working-copies.js";
import * as fileStoreModule from "../services/agent-file-store.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getStorageService } from "../storage/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: explicit BRIEF-crp2 / RFL SUPERSEDE-CLAIM-REMOVE-ENTRY-HELD-1118
// person-side integration row. The filesystem, store, DB, dispatcher and HTTP
// routers are real; only the model adapter is a deterministic process boundary.
describe("permanent-4xx held agent-file save: the person's next actions", () => {
  const adapterType = "held_save_person_test";
  const originalHome = process.env.PAPERCLIP_HOME;
  const initial = "# Persistent instructions\n";
  let home: string;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  const seen = new Map<string, { entry: string; before: string; issueId: string; markdown: string; priorSaveHeld: boolean }>();
  const applyFailures: Array<{ status: number; message: string }> = [];
  let heldRunId: string | undefined;
  let nextRunId: string | undefined;
  let releaseNext: (() => void) | undefined;
  let nextEntered = false;
  let blockNext = false;

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "held-save-person-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("held-save-person-db-");
    db = createDb(database.connectionString);
    // Observe, but do not replace or force, the real store's rejection.
    const actual = fileStoreModule.agentFileStore;
    vi.spyOn(fileStoreModule, "agentFileStore").mockImplementation((...args) => {
      const store = actual(...args);
      const apply = store.apply.bind(store);
      store.apply = async (...input) => {
        try { return await apply(...input); }
        catch (error) {
          const failure = error as { status: number; message: string };
          applyFailures.push({ status: failure.status, message: failure.message });
          throw error;
        }
      };
      return store;
    });
    heartbeat = heartbeatService(db);
    copies = agentInstructionWorkingCopyService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false, supportsInstructionsBundle: true,
      execute: async input => {
        console.log("ADAPTER_ENTER", JSON.stringify({ runId: input.runId, issueId: input.context.issueId, blockNext }));
        const entry = String(input.config.instructionsFilePath);
        seen.set(input.runId, { entry, before: await fs.readFile(entry, "utf8"),
          issueId: String(input.context.issueId), markdown: String(input.context.paperclipTaskMarkdown),
          priorSaveHeld: heldRunId ? agentFileSaveHeld(await copies.get(input.agent.companyId, heldRunId)) : false });
        if (!heldRunId) {
          heldRunId = input.runId;
          // Genuine permanent 422: canonical AGENTS.md exists, this run deletes it.
          await fs.unlink(entry);
          await fs.writeFile(path.join(path.dirname(entry), "unsaved-note.txt"), "Keep these exact held bytes\n");
        } else if (blockNext && !nextRunId) {
          nextRunId = input.runId;
          const gate = new Promise<void>(resolve => { releaseNext = resolve; });
          nextEntered = true;
          await gate;
        }
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        await input.onProviderStopped?.();
        return { exitCode: 0, signal: null, timedOut: false, resultJson: { summary: "Message received and answered." } };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 90_000);

  afterAll(async () => {
    releaseNext?.();
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    vi.restoreAllMocks();
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    if (home) {
      const writable = async (dir: string): Promise<void> => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await writable(path.join(dir, entry.name));
        }
      };
      await writable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("runs again, accepts a chat message, shows no phantom work, and offers named operator discard while a real 422 save is held", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Held save person", issuePrefix: `P${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    const root = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Editor", adapterConfig: {} });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), initial);
    const cwd = await fs.mkdtemp(path.join(home, "workspace-"));
    await db.insert(agents).values({ id: agentId, companyId, name: "Editor", adapterType, status: "idle",
      adapterConfig: { cwd, instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Run deletes configured instruction entry", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    const wake = () => heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId }, contextSnapshot: { issueId } });
    const first = await wake();
    expect(first).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(applyFailures).toContainEqual({ status: 422, message: "The configured instruction entry cannot be deleted" });
    const held = (await copies.get(companyId, first!.id))!;
    expect(held).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_SAVE_FAILED",
      receipt: { savePending: { reason: "The configured instruction entry cannot be deleted" } } });
    expect(held.processStoppedAt).toBeInstanceOf(Date);
    expect(agentFileSaveHeld(held)).toBe(true);
    console.log("PERMANENT_422", JSON.stringify({ runId: first!.id, applyFailures, state: held.state,
      errorCode: held.errorCode, savePending: held.receipt?.savePending }));
    await copies.release(companyId, first!.id);
    expect(await fs.readFile(path.join(held.localRoot, "unsaved-note.txt"), "utf8")).toBe("Keep these exact held bytes\n");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(initial);

    // (c) The same run query and avatar presentation helper AgentDetail uses.
    const assertQuiet = async (phase: string) => {
      const run = await heartbeat.getRun(first!.id);
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const pose = characterStateForAgent(agent!.status);
      console.log("PERSON_C", JSON.stringify({ phase, runId: first!.id, runStatus: run?.status, agentStatus: agent!.status, pose }));
      expect.soft(run?.status, `${phase}: held run terminal`).toBe("succeeded");
      expect.soft(run?.finishedAt, `${phase}: held run finished`).not.toBeNull();
      expect.soft(agent!.status, `${phase}: agent idle`).toBe("idle");
      expect.soft(pose, `${phase}: UI does not say working`).not.toBe("working");
    };
    await assertQuiet("held before next run");

    // (a) Real dispatcher and adapter execute while the first hold remains.
    blockNext = true;
    const next = await wake();
    try {
      await vi.waitFor(() => expect(nextEntered).toBe(true), { timeout: 10_000 });
      expect.soft((await heartbeat.getRun(next!.id))?.status).toBe("running");
      expect.soft(agentFileSaveHeld(await copies.get(companyId, first!.id))).toBe(true);
      expect.soft(seen.get(next!.id)?.before).toBe(initial);
      expect.soft(seen.get(next!.id)?.priorSaveHeld).toBe(true);
    } finally { releaseNext?.(); await heartbeat.drainActiveRunExecutions(); }
    expect.soft((await heartbeat.getRun(next!.id))?.status).toBe("succeeded");
    // The dispatcher may already have admitted a follow-up during the first
    // drain. Check that literal first successor too, not just the manual wake.
    const immediateNext = [...seen.entries()].find(([id]) => id !== first!.id)!;
    expect.soft(immediateNext[1].priorSaveHeld).toBe(true);
    expect.soft((await heartbeat.getRun(immediateNext[0]))?.status).toBe("succeeded");
    console.log("PERSON_A", JSON.stringify({ heldRunId: first!.id, immediateNextRunId: immediateNext[0],
      immediateNextSawHold: immediateNext[1].priorSaveHeld, nextRunId: next!.id,
      executed: seen.has(next!.id), status: (await heartbeat.getRun(next!.id))?.status }));

    // (b) A person's NEW chat message goes through the production comments router.
    const chatId = randomUUID();
    await db.insert(issues).values({ id: chatId, companyId, title: "Chat with Editor", status: "in_progress", issueNumber: 2,
      assigneeAgentId: agentId, responsibleUserId: userId, createdByUserId: userId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, getStorageService())); app.use("/api", environmentRoutes(db)); app.use(errorHandler);
    const message = "Can you answer a new message while the previous file save is held?";
    const response = await request(app).post(`/api/issues/${chatId}/comments`).send({ body: message, clientRequestId: randomUUID() });
    expect.soft(response.status, JSON.stringify(response.body)).toBe(201);
    await heartbeat.drainActiveRunExecutions();
    const chatRun = [...seen.entries()].find(([, input]) => input.issueId === chatId);
    expect.soft(chatRun, "chat message reaches the adapter while the old hold persists").toBeDefined();
    if (chatRun) {
      expect.soft((await heartbeat.getRun(chatRun[0]))?.status).toBe("succeeded");
      expect.soft(chatRun[1].priorSaveHeld).toBe(true);
      expect.soft(chatRun[1].markdown).toContain(message);
    }
    const [storedMessage] = await db.select().from(issueComments).where(eq(issueComments.id, String(response.body.id)));
    expect.soft(storedMessage?.body).toBe(message);
    expect.soft(agentFileSaveHeld(await copies.get(companyId, first!.id))).toBe(true);
    console.log("PERSON_B", JSON.stringify({ route: `POST /api/issues/${chatId}/comments`, status: response.status, commentId: response.body.id, chatRunId: chatRun?.[0] }));
    await assertQuiet("held after next run and chat");

    // (d) Documented named route, real authorization and discard implementation.
    const discardPath = `/api/companies/${companyId}/agent-file-holds/${first!.id}/discard`;
    const discard = await request(app).post(discardPath).send({ reason: "Permanent 422; operator accepts losing this unsaved copy" });
    expect.soft(discard.status, JSON.stringify(discard.body)).toBe(200);
    expect.soft(discard.body).toMatchObject({ state: "resolved", errorCode: "AGENT_FILES_SAVE_DISCARDED" });
    const discarded = await copies.get(companyId, first!.id);
    expect.soft(agentFileSaveHeld(discarded)).toBe(false);
    expect.soft(discarded?.receipt?.discard).toMatchObject({ actorId: userId });
    await expect.soft(fs.stat(held.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const log = await db.select().from(activityLog).where(eq(activityLog.runId, first!.id));
    expect.soft(log.find(row => row.action === "agent_files.save_discarded")).toMatchObject({ actorType: "user", actorId: userId });
    expect.soft(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(initial);
    console.log("PERSON_D", JSON.stringify({ route: `POST ${discardPath}`, status: discard.status, held: agentFileSaveHeld(discarded), state: discarded?.state }));
  }, 60_000);
});
