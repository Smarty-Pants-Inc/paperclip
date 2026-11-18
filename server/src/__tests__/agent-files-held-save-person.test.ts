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
  issues, principalPermissionGrants,
} from "@paperclipai/db";
import { characterStateForAgent } from "@paperclipai/shared";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { environmentRoutes } from "../routes/environments.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { agentFileSaveHeld } from "../services/agent-directory-working-copies.js";
import * as fileStoreModule from "../services/agent-file-store.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createHeartbeatAgentStatus } from "../services/heartbeat/agent-status.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: explicit BRIEF-crp2 / RFL SUPERSEDE-CLAIM-REMOVE-ENTRY-HELD-1118
// person-side integration row: (c) no phantom 'working' (normal finalize and
// planted stale-running state) and (d) the named HTTP discard. The filesystem,
// store, DB, dispatcher and HTTP routers are real; only the model adapter is a
// deterministic process boundary. (a)/(b) live in the native harness.
// Fixture ruling: rf-3, 2026-11-18, smarty-dev#20787#issuecomment-6993289033.
// Missing companion: a real interrupted/crashed producer followed by the stale
// reconciler; the agents-table write below does NOT prove crash recovery.
describe("permanent-4xx held agent-file save: the person's next actions", () => {
  const adapterType = "held_save_person_test";
  const originalHome = process.env.PAPERCLIP_HOME;
  const initial = "# Persistent instructions\n";
  let home: string;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  const applyFailures: Array<{ status: number; message: string }> = [];
  let heldRunId: string | undefined;

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
        const entry = String(input.config.instructionsFilePath);
        if (!heldRunId) {
          heldRunId = input.runId;
          // Genuine permanent 422: canonical AGENTS.md exists, this run deletes it.
          await fs.unlink(entry);
          await fs.writeFile(path.join(path.dirname(entry), "unsaved-note.txt"), "Keep these exact held bytes\n");
        }
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        await input.onProviderStopped?.();
        return { exitCode: 0, signal: null, timedOut: false, resultJson: { summary: "Message received and answered." } };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 90_000);

  afterAll(async () => {
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

  it("shows no phantom work (normal finalize + planted after-crash state) and offers named operator discard while a real 422 save is held", async () => {
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

    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db));
    app.use("/api", environmentRoutes(db)); app.use(errorHandler);

    // (c) Real GETs, not a DB read: AgentDetail's agentsApi.get uses /agents/:id
    // (ui/src/api/agents.ts); its avatar maps that response through this helper.
    const agentPath = `/api/agents/${agentId}`;
    const runPath = `/api/heartbeat-runs/${first!.id}`;
    const assertQuiet = async (phase: string) => {
      const agentResponse = await request(app).get(agentPath);
      const runResponse = await request(app).get(runPath);
      expect(agentResponse.status, JSON.stringify(agentResponse.body)).toBe(200);
      expect(runResponse.status, JSON.stringify(runResponse.body)).toBe(200);
      const agent = agentResponse.body, run = runResponse.body;
      const pose = characterStateForAgent(agent.status);
      console.log("PERSON_C", JSON.stringify({ phase, runId: first!.id, agentRoute: `GET ${agentPath}`, agentHttpStatus: agentResponse.status,
        runRoute: `GET ${runPath}`, runHttpStatus: runResponse.status, runStatus: run.status, agentStatus: agent.status, pose }));
      expect.soft(run.status, `${phase}: held run terminal`).toBe("succeeded");
      expect.soft(run.finishedAt, `${phase}: held run finished`).not.toBeNull();
      expect.soft(agent.status, `${phase}: agent idle`).toBe("idle");
      expect.soft(pose, `${phase}: UI does not say working`).not.toBe("working");
    };
    await assertQuiet("held, normally finalized");
    // (c) PLANTED after-crash state, not a real crash: explicitly seed an old
    // running agents row with no live run and only this real held save. The real
    // stranded-status reconciler settles it; the hold stays exactly as it was.
    // rf-3 fixture ruling, 2026-11-18 (smarty-dev#20787 C1 required 2).
    await heartbeat.drainActiveRunExecutions();
    await db.update(agents).set({ status: "running", updatedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(agents.id, agentId));
    const planted = await request(app).get(agentPath);
    expect(planted.status, JSON.stringify(planted.body)).toBe(200);
    expect(planted.body.status).toBe("running");
    expect(characterStateForAgent(planted.body.status)).toBe("working");
    const reconciled = await createHeartbeatAgentStatus(db).reconcileStrandedAgentStatuses(() => new Set(), { companyId, agentId });
    const heldAfterCrash = await copies.get(companyId, first!.id);
    console.log("PERSON_C_PLANTED_CRASH", JSON.stringify({ fixture: "planted agents-table stale-running write", ruling: "rf-3, 2026-11-18",
      beforeGetStatus: planted.body.status, reconciled, held: agentFileSaveHeld(heldAfterCrash), state: heldAfterCrash?.state }));
    expect.soft(reconciled, "a held save alone never keeps the agent running").toEqual([agentId]);
    expect.soft(agentFileSaveHeld(heldAfterCrash), "the hold stays visible as a hold").toBe(true);
    expect.soft(heldAfterCrash?.nextAttemptAt).toEqual(held.nextAttemptAt);
    await assertQuiet("held, after planted stale-running state was reconciled");

    // (a) next run and (b) chat answer moved to the native harness, where Paul's
    // agents run: native-session-executor.test.ts "claim-remove-entry-held-person"
    // (rf-3, smarty-dev#20787 C1 required 3). (c) and (d) stay here: the
    // real agent/avatar GET and the documented HTTP discard with its authority.

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
