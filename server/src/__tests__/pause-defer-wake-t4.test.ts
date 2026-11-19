import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// rf-5 T4 (RF5-PNOTE): a message P a person SENDS while the agent is PAUSED is
// deferred through Paperclip's own work-intent outbox (executionWait
// agent.not_invokable -> pause_lifted), and Resume's release drain runs it ONCE.
// Real routes: POST /api/agents/:id/pause, POST /api/issues/:id/comments,
// POST /api/agents/:id/resume; the REAL lifecycle worker moves pausing ->
// paused and resuming -> ready (its onReady promotes deferred work intents);
// real heartbeat admission, deferral, promotion, claim and run creation on the
// native executor path. Scripted edge only: the provider turn
// (executePaperclipNativeSession) records its run and answers with one agent
// reply comment from that run, as the optS-dd F3 harness does.
const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      fixture.calls.push(runId);
      const { issueComments, heartbeatRuns } = await import("@paperclipai/db");
      const { eq } = await import("drizzle-orm");
      const [run] = await (fixture.db as any).select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const issueId = (run?.contextSnapshot as { issueId?: string } | null)?.issueId ?? fixture.issueId;
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { createLifecycleWorker } from "../modules/agent-lifecycle/application/worker.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
const NAME = "Managed Pi";

describe.skipIf(!support.supported)("rf-5 T4: a message sent while the agent is paused runs once after Resume", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "t4-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pause-defer-t4-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "pause-defer-t4-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "t4@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.T4_EVIDENCE) await fs.appendFile(process.env.T4_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  async function seed(chat = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "T4", issuePrefix, defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: NAME, role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    // rf-5 T4 primary: a task of the paused agent that has never run.
    await db.insert(issues).values({ id: issueId, companyId, title: "A task", status: chat ? "in_progress" : "todo", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" as const, startedAt: new Date() } : {}) });
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    fixture.calls = [];
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use("/api", agentRoutes(db, {}));
    client.use(errorHandler);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    // The REAL lifecycle worker (no simulated lifecycle write).
    const worker = createLifecycleWorker(createLifecycleStore(db, createAgentLifecycleEffects()),
      createLifecycleDriver(db, {} as never), (_context, error) => { throw error; });
    const post = (body: string) => request(client).post(`/api/issues/${issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    const agentRow = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
    const pause = async () => {
      const res = await request(client).post(`/api/agents/${agentId}/pause`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    const resume = async () => {
      const res = await request(client).post(`/api/agents/${agentId}/resume`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await worker.process(agentId);
      expect(await agentRow()).toMatchObject({ lifecycleState: "ready" });
    };
    const notes = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      isNull(issueComments.authorAgentId), isNull(issueComments.authorUserId), isNull(issueComments.deletedAt))))
      .filter(row => !(row.metadata as { hidden?: boolean } | null)?.hidden);
    const sweep = (ms: number) => settleUnansweredPersonMessage(db, { companyId, issueId, now: new Date(Date.now() + ms) });
    const wakes = async () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    const runInputs = async () => {
      const out: Array<{ runId: string; status: string; commentIds: string[] }> = [];
      for (const runId of fixture.calls) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const context = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds as string[]
          : typeof context.commentId === "string" ? [context.commentId] : [];
        out.push({ runId, status: run?.status ?? "missing", commentIds: ids });
      }
      return out;
    };
    // The workers the server registers drive these product passes
    // (deferred-receipt work -> resumeDeferredExecutionReceipts; run dispatch).
    const drive = async (until: () => Promise<boolean>, timeoutMs = 60_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        // Issue-recovery work (notified by promoteDeferredWorkIntents) owns the chat outbox.
        await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        if (await until()) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      // Two more passes: a second delivery would show here.
      for (let i = 0; i < 2; i++) { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); }
      return Date.now() - t0;
    };
    const replies = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorAgentId, agentId)))).map(row => row.createdByRunId);
    return { companyId, agentId, issueId, client, heartbeat, worker, post, agentRow, pause, resume, notes, sweep,
      wakes, runInputs, drive, replies };
  }

  async function pausedAgent(chat = false) {
    const s = await seed(chat);
    await s.pause();
    await s.worker.process(s.agentId);
    expect(await s.agentRow()).toMatchObject({ lifecycleState: "paused", status: "paused" });
    return s;
  }

  it("T4: pause, send P, Resume -> P's run starts and P is answered ONCE within ~1 min; its input names P", async () => {
    const s = await pausedAgent();
    const P = (await s.post("P: please check this while you're paused.").expect(201)).body.id as string;
    // The comment route's wake is fire-and-forget: wait (bounded) for its outcome.
    const t0 = Date.now();
    let saved = [] as Awaited<ReturnType<typeof s.wakes>>;
    while (Date.now() - t0 < 5_000) {
      saved = (await s.wakes()).filter(w => (w.payload as { commentId?: string }).commentId === P);
      if (saved.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await evidence("T4 saved", saved.map(w => ({ id: w.id, status: w.status, wait: (w.payload as any)?.executionWait })));
    expect(saved).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null })]);
    expect((saved[0]!.payload as any).executionWait).toMatchObject({ reason: "agent.not_invokable", trigger: "pause_lifted" });
    expect(fixture.calls).toEqual([]);
    const resumedAt = Date.now();
    await s.resume();
    const ms = await s.drive(async () => (await s.runInputs()).some(run => run.commentIds.includes(P)));
    const inputs = await s.runInputs();
    await evidence("T4 runs", { P, inputs, ms: Date.now() - resumedAt, replies: await s.replies() });
    const carrying = inputs.filter(run => run.commentIds.includes(P));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.status).toBe("succeeded");
    expect(await s.replies()).toEqual([carrying[0]!.runId]);
    expect(ms).toBeLessThan(60_000);
    // Answered: the sweep leaves no note on P.
    await s.sweep(2 * 60_000);
    await s.sweep(11 * 60_000);
    expect((await s.notes()).map(n => n.body)).toEqual([]);
  }, 120_000);

  it("control CHAT: P sent in a chat while paused stays in the conversation outbox (no wake) and, after Resume, the existing outbox delivery runs it once", async () => {
    const s = await pausedAgent(true);
    const P = (await s.post("P chat while paused").expect(201)).body.id as string;
    await new Promise(resolve => setTimeout(resolve, 1000));
    const before = (await s.wakes()).map(w => ({ status: w.status, key: w.idempotencyKey, wait: (w.payload as any)?.executionWait?.reason, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    await s.resume();
    await s.drive(async () => (await s.runInputs()).some(run => run.commentIds.includes(P)));
    const inputs = await s.runInputs();
    await evidence("control chat", { P, before, inputs, replies: await s.replies() });
    expect(before).toEqual([]);
    const carrying = inputs.filter(run => run.commentIds.includes(P));
    expect(carrying).toHaveLength(1);
    expect(await s.replies()).toEqual([carrying[0]!.runId]);
  }, 120_000);

  it("T4b: two messages while paused -> after Resume ONE run carries both, in order; each answered once", async () => {
    const s = await pausedAgent();
    const P1 = (await s.post("P1 while paused").expect(201)).body.id as string;
    const P2 = (await s.post("P2 while paused").expect(201)).body.id as string;
    expect(fixture.calls).toEqual([]);
    await s.resume();
    await s.drive(async () => (await s.runInputs()).some(run => run.commentIds.includes(P2)));
    const inputs = await s.runInputs();
    await evidence("T4b runs", { P1, P2, inputs, replies: await s.replies() });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.commentIds).toEqual([P1, P2]);
    expect(inputs[0]!.status).toBe("succeeded");
    for (const id of [P1, P2]) expect(inputs.filter(run => run.commentIds.includes(id))).toHaveLength(1);
    expect(await s.replies()).toEqual([inputs[0]!.runId]);
  }, 120_000);

  // mcomp (merged line): SUPERSEDE-WAITNOTE-UPSTREAM-HEADER-1119 (2) makes the saved wake's executionWait line the
  // ONE line for a deferred message, and the sweep writes no note beside it (unanswered-person-message.ts
  // pendingExecutionWait). So P's one line is read from the REAL GET /api/issues/:id/queued-comments, in merged10's
  // paused words (deferred-execution-wait.ts PAUSED_EXECUTION_WAIT_MESSAGE), and the tB2 row's paused NOTE is 0.
  // supersedes(tB2 50b1e878 T4c: "P's note says the 'will run when <name> is resumed' line, once").
  it("T4c: while paused, P has ONE line: the saved message's 'starts when the agent is resumed' wait line; no note beside it", async () => {
    const s = await pausedAgent();
    const P = (await s.post("P while paused").expect(201)).body.id as string;
    await s.sweep(2 * 60_000);
    await s.sweep(11 * 60_000);
    const whilePaused = await s.notes();
    const queued = (await request(s.client).get(`/api/issues/${s.issueId}/queued-comments`).expect(200)).body;
    await evidence("T4c notes", whilePaused.map(n => ({ id: n.id, body: n.body, reason: (n.metadata as any)?.authorizationReason })));
    await evidence("T4c GET queued-comments", queued);
    expect(whilePaused.map(n => n.body)).toEqual([]);
    const lines = JSON.stringify(queued).split("Your message is saved. This agent is paused, so it starts when the agent is resumed.");
    expect(lines, JSON.stringify(queued)).toHaveLength(2);
    expect(JSON.stringify(queued)).toContain(P);
    expect(JSON.stringify(queued)).not.toContain("Send it again");
  }, 120_000);

  it("control PAUSING: a message to an agent still 'pausing' keeps today's behaviour (refused, not saved; no run)", async () => {
    const s = await seed();
    await s.pause();
    expect(await s.agentRow()).toMatchObject({ lifecycleState: "pausing", status: "paused" });
    const P = (await s.post("P while pausing").expect(201)).body.id as string;
    await new Promise(resolve => setTimeout(resolve, 500));
    const carrying = (await s.wakes()).filter(w => (w.payload as { commentId?: string }).commentId === P);
    await evidence("control pausing", carrying.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait })));
    expect(carrying.filter(w => w.status === "deferred_issue_execution")).toEqual([]);
    expect(fixture.calls).toEqual([]);
  }, 120_000);

  it("control TERMINATED: a message to a terminated agent keeps today's behaviour (refused, not saved; no run)", async () => {
    const s = await seed();
    const res = await request(s.client).post(`/api/agents/${s.agentId}/terminate`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await s.agentRow()).toMatchObject({ status: "terminated" });
    const P = (await s.post("P to terminated").expect(201)).body.id as string;
    await new Promise(resolve => setTimeout(resolve, 500));
    const carrying = (await s.wakes()).filter(w => (w.payload as { commentId?: string }).commentId === P);
    await evidence("control terminated", carrying.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait })));
    expect(carrying.filter(w => w.status === "deferred_issue_execution")).toEqual([]);
    await s.drive(async () => true, 1_000);
    expect(fixture.calls).toEqual([]);
  }, 120_000);
});
