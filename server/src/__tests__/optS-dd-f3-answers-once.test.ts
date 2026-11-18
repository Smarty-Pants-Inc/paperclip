import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-optS-dd-f3 (rf-4 F3): ANSWERS-ONCE with a SUCCEEDING provider, counting
// PERSISTED agent replies. Real chat route (POST /api/issues/:id/comments on a
// conversationAgentId task), real person Stop route (POST
// /api/heartbeat-runs/:runId/cancel), real Send route (queued-comments/interrupt),
// real heartbeat admission/dispatch and Option S. The run stays LOCAL (no
// remote box: the c3-orphan harness environment). Faked edges only: the
// provider turn (first turn: busy until the person's Stop, then the executor's
// settle-then-throw after an acknowledged Stop; successor turns answer with one
// agent reply comment 'answer from <runId>' and succeed) and the provider ACK
// of the Stop (dispatched flag), as the optS-dd tests.
const fixture = vi.hoisted(() => ({
  calls: [] as { runId: string; ok: boolean }[],
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    // Provider edge of Stop: the run-only abort reached the live session (dispatched).
    cancelNativeSession: (async (runId: string, reason: string, options?: Parameters<typeof actual.cancelNativeSession>[2]) => {
      const result = await actual.cancelNativeSession(runId, reason, options!);
      if (!options || !fixture.calls.some(call => call.runId === runId) || typeof result !== "object") return result;
      const { db } = options;
      const { heartbeatRuns } = await import("@paperclipai/db");
      const { eq, sql } = await import("drizzle-orm");
      await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson},
        '{nativeCancellation,dispatched}', 'true'::jsonb)` }).where(eq(heartbeatRuns.id, runId));
      return { ...result, dispatched: true };
    }) as typeof actual.cancelNativeSession,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      if (fixture.calls.length === 0 && fixture.onFirst) {
        fixture.calls.push({ runId, ok: false });
        await fixture.onFirst({ runId });
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      fixture.calls.push({ runId, ok: true });
      // A real chat turn answers with the agent's reply comment from this run (c3-orphan harness).
      const { issueComments } = await import("@paperclipai/db");
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!support.supported)("optS-dd F3: answers-once with a succeeding provider and persisted replies", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "f3-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("optS-f3-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "optS-f3-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "f3@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    const writable = async (dir: string): Promise<void> => { const st = await fs.lstat(dir).catch(() => null); if (!st?.isDirectory() || st.isSymbolicLink()) return; await fs.chmod(dir, 0o700); for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }).catch(() => undefined); }
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.OPTS_EVIDENCE) await fs.appendFile(process.env.OPTS_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  async function heldThenStop() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "F3", issuePrefix, defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active",
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    fixture.calls = [];
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use("/api", agentRoutes(db, {}));
    client.use(errorHandler);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const post = (body: string) => request(client).post(`/api/issues/${issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    const held: string[] = [];
    let firstRunId = "";
    let stopping: Promise<unknown> | undefined;
    fixture.onFirst = async ({ runId }) => {
      firstRunId = runId;
      // Three person messages while the turn is busy: the chat route holds them.
      for (const body of ["M1 held", "M2 held", "M3 held"]) held.push((await post(body).expect(201)).body.id);
      // The person presses Stop through the real Stop route.
      stopping = request(client).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        return value?.dispatchState === "acknowledged" && row?.status === "cancelled";
      });
    };
    try {
      // M0 opens the busy turn: the chat route's own delivery path.
      await issueService(db).addComment(issueId, "M0 start", { userId }, { clientRequestId: randomUUID() });
      await deliverConversationComments(db, { id: issueId, companyId, conversationAgentId: agentId }, heartbeat.wakeup);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const stopped = await stopping as { status: number } | undefined;
      expect(stopped?.status, "person Stop route").toBe(200);
    } finally { fixture.onFirst = undefined; }
    expect(firstRunId, "first turn reached the provider").not.toBe("");
    const accepted = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, firstRunId),
      eq(heartbeatRunEvents.message, "run.stop.accepted")));
    expect(accepted.map(row => (row.payload as any)?.kind), "the Stop route wrote the person_stop row").toEqual(["person_stop"]);
    const settle = async (ms = 3_000) => {
      const t0 = Date.now();
      do {
        await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
        await new Promise(r => setTimeout(r, 150));
      } while (Date.now() - t0 < ms);
    };
    const send = async () => {
      const queue = await request(client).get(`/api/issues/${issueId}/queued-comments`).expect(200);
      return request(client).post(`/api/issues/${issueId}/queued-comments/interrupt`)
        .send({ queueId: queue.body.queueId ?? queue.body.id, targetRunId: firstRunId, revision: queue.body.revision });
    };
    return { companyId, agentId, issueId, client, heartbeat, held, post, send, settle, firstRunId: () => firstRunId };
  }

  const carried = (ctx: any): string[] => [...new Set([ctx?.commentId, ctx?.wakeCommentId, ...(ctx?.wakeCommentIds ?? [])]
    .filter(Boolean))];
  /** PERSISTED answers: each successor run, its status, the comments it carried and the agent replies it saved. */
  async function persisted(s: Awaited<ReturnType<typeof heldThenStop>>) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))
      .orderBy(heartbeatRuns.createdAt);
    const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, s.issueId),
      eq(issueComments.authorType, "agent"))).orderBy(issueComments.createdAt);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.companyId));
    const perRun = runs.filter(run => run.id !== s.firstRunId()).map(run => ({ id: run.id, status: run.status,
      errorCode: run.errorCode, error: run.error?.slice(0, 200), ids: carried(run.contextSnapshot),
      replies: replies.filter(reply => reply.createdByRunId === run.id).map(reply => reply.body) }));
    // A message is answered once per SUCCEEDED run that carried it and PERSISTED an agent reply.
    const answeredBy = (id: string) => perRun.filter(run => run.status === "succeeded" && run.replies.length > 0 && run.ids.includes(id))
      .map(run => run.id);
    const waiting = wakes.filter(w => ["deferred_issue_execution", "queued"].includes(w.status))
      .map(w => ({ id: w.id, status: w.status, wait: (w.payload as any)?.executionWait?.reason,
        ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    return { perRun, replies: replies.map(r => ({ runId: r.createdByRunId, body: r.body })), answeredBy, waiting,
      calls: [...fixture.calls] };
  }

  it("S10: three held, person Stop via the route, Send: ONE successor SUCCEEDS; M1-M3 each answered exactly once (persisted)", async () => {
    const s = await heldThenStop();
    const sent = await s.send();
    await s.settle(4_000);
    const a = await persisted(s);
    await evidence("F3-S10", { sent: sent.status, sentBody: sent.body, held: s.held, perRun: a.perRun, replies: a.replies,
      waiting: a.waiting, calls: a.calls, counts: Object.fromEntries(s.held.map(id => [id, a.answeredBy(id).length])) });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(a.perRun, JSON.stringify(a.perRun)).toHaveLength(1);
    expect(a.perRun[0]!.status).toBe("succeeded");
    expect([...a.perRun[0]!.ids].sort()).toEqual([...s.held].sort());
    expect(a.perRun[0]!.replies).toEqual([`answer from ${a.perRun[0]!.id}`]);
    expect(a.replies, "exactly one persisted agent reply").toHaveLength(1);
    for (const id of s.held) expect(a.answeredBy(id), `${id} answered exactly once`).toHaveLength(1);
    expect(a.waiting, "no waiting wake left").toEqual([]);
  }, 120_000);

  it("Send + typed M4 together: M4 answered once, then M1-M3 each once; no message twice (persisted)", async () => {
    const s = await heldThenStop();
    const [sent, typed] = await Promise.all([s.send(), s.post("M4 typed").expect(201)]);
    const m4 = typed.body.id as string;
    await s.settle(6_000);
    const a = await persisted(s);
    const queue = await request(s.client).get(`/api/issues/${s.issueId}/queued-comments`).expect(200);
    await evidence("F3-send-typed", { sent: sent.status, sentBody: sent.body, held: s.held, m4, perRun: a.perRun,
      replies: a.replies, waiting: a.waiting, calls: a.calls,
      counts: Object.fromEntries([m4, ...s.held].map(id => [id, a.answeredBy(id).length])),
      queue: { state: queue.body.state, entries: (queue.body.entries ?? []).length } });
    expect([200, 202], JSON.stringify(sent.body)).toContain(sent.status);
    for (const id of [m4, ...s.held]) expect(a.answeredBy(id), `${id} answered exactly once`).toHaveLength(1);
    expect(a.perRun.every(run => run.status === "succeeded" && run.replies.length === 1), JSON.stringify(a.perRun)).toBe(true);
    expect(a.replies, "one persisted reply per successor run").toHaveLength(a.perRun.length);
    // Order: the run answering M4 precedes (or is) the run answering M1-M3.
    const order = a.perRun.map(run => run.id);
    expect(order.indexOf(a.answeredBy(m4)[0]!)).toBeLessThanOrEqual(order.indexOf(a.answeredBy(s.held[0]!)[0]!));
    for (const id of s.held) expect(a.answeredBy(id)[0], "M1-M3 answered together").toBe(a.answeredBy(s.held[0]!)[0]);
    expect(a.waiting, "no second waiting wake").toEqual([]);
    expect((queue.body.entries ?? []).length, "nothing left held").toBe(0);
  }, 120_000);
});
