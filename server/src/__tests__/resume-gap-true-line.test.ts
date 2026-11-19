import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, issueComments, issues,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep (PERSON CASE, merged line, RFL 11:06Z): after a person presses Resume on a paused agent, the thread never
// keeps saying '<agent> is paused'. From the Resume response until the message's run header exists the ONE line is
// the SAME note (same comment id) saying the true 'resuming' state; then the header replaces it: never two lines,
// never none, never a stale 'is paused'. Sampled every 100 ms through to WORKING.
// REAL (real timers, production defaults, nothing ticked by hand): POST /api/agents/:id/pause, POST
// /api/issues/:id/comments, POST /api/agents/:id/resume; the lifecycle worker under the delivery coordinator
// (app.ts registration); the heartbeat's recovery / dispatch / deferred-receipt works (chat outbox delivery under the
// conversation delivery lock, admission, run creation, the unanswered sweep). Every outcome is read from the real
// GETs: /api/issues/:id/comments, /queued-comments, /live-runs (the run header's source).
// PLANTED (named): the company, its member, the agent, the empty chat and (busy row) an empty second task.
// SCRIPTED EDGE ONLY (named): the provider turn (executePaperclipNativeSession) is held open per task, then answers.
// CONTROLLED (named, lock row): a competing REAL PostgreSQL transaction holds the production per-conversation
// delivery lock for ~4 s after the Resume; no service method or timer is replaced.
const fixture = vi.hoisted(() => ({
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
  holds: {} as Record<string, Promise<"answer">>,
}));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      const { issueComments, heartbeatRuns } = await import("@paperclipai/db");
      const { eq } = await import("drizzle-orm");
      const [run] = await (fixture.db as any).select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const issueId = (run?.contextSnapshot as { issueId?: string } | null)?.issueId ?? fixture.issueId;
      await (fixture.holds[issueId] ?? Promise.resolve("answer" as const));
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { startAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

const support = await getEmbeddedPostgresTestSupport();
const NAME = "Managed Pi", PERSON = "rgap-person";
// Literals, deliberately independent of the production constants.
const PAUSED = "Managed Pi is paused. Your message is saved, and it will run when Managed Pi is resumed. "
  + "A board user or Managed Pi's manager can resume Managed Pi.";
const RESUMING = "Managed Pi is resuming. Your message is saved and will start when Managed Pi is ready.";
const WORKING = "Managed Pi is working on your message.";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const captures: unknown[] = [];
const summaries: unknown[] = [];

type Variant = "ordinary" | "lock" | "busy";

describe.skipIf(!support.supported)("resume gap: from Resume to the run header the ONE line is the true 'resuming' note (real timers, 100 ms samples)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("resume-gap-true-line-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: PERSON, name: "Person", email: "rgap@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    // To refresh ui/src/components/task-chat/fixtures/resume-gap-real-route.json: set RGAP_CAPTURE_DIR.
    if (process.env.RGAP_CAPTURE_DIR) {
      await fs.mkdir(process.env.RGAP_CAPTURE_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.RGAP_CAPTURE_DIR, "resume-gap-real-route.json"), JSON.stringify(captures, null, 2) + "\n");
      await fs.writeFile(path.join(process.env.RGAP_CAPTURE_DIR, "resume-gap-samples.json"), JSON.stringify(summaries, null, 2) + "\n");
    }
    fixture.holds = {};
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  }, 60_000);

  async function row(variant: Variant) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    const prefix = "RG" + companyId.replace(/-/g, "").slice(0, 6).toUpperCase();
    await db.insert(companies).values({ id: companyId, name: "resume gap " + variant, issuePrefix: prefix,
      defaultResponsibleUserId: PERSON, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: PERSON,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: NAME, role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat with " + NAME, status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 1, identifier: prefix + "-1",
      conversationAgentId: agentId, conversationUserId: PERSON, conversationState: "active", startedAt: new Date() });
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    let release!: (outcome: "answer") => void, releaseOther!: (outcome: "answer") => void;
    fixture.holds = { [issueId]: new Promise(resolve => { release = resolve; }),
      [otherIssueId]: new Promise(resolve => { releaseOther = resolve; }) };
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true }; next();
    });
    client.use("/api", issueRoutes(db, {} as any, {})); client.use("/api", agentRoutes(db, {})); client.use(errorHandler);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const workErrors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      onError: (error, queue) => workErrors.push({ queue, error: String(error) }) });
    // The production registration and defaults (app.ts), plus the heartbeat's real queue / recovery owners.
    const lifecycle = startAgentLifecycle(db, createLifecycleDriver(db, {} as never), () => true);
    const ld = coordinator.register(DELIVERY_QUEUES.agentLifecycle, { retryMs: 1_000,
      run: () => lifecycle.sweep(), hasPending: () => lifecycle.hasPending(), nextRunAt: () => lifecycle.nextRunAt() });
    lifecycle.setWake(ld.wake);
    const get = async (url: string) => { const r = await request(client).get(url); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; };
    const post = async (url: string, data = {}) => { const r = await request(client).post(url).send(data);
      expect(r.status, JSON.stringify(r.body)).toBe(url.endsWith("/comments") ? 201 : 200); return r; };
    const agent = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
    const until = async (label: string, fn: () => Promise<boolean>, cap = 90_000) => {
      const t = Date.now(); while (!(await fn())) { if (Date.now() - t > cap) throw new Error(label + " not reached"); await sleep(100); }
    };
    /** The sweep's live notes about a person's message, as the REAL GET returns them. */
    const notesOf = (comments: any[]) => comments.filter(c => c.authorType === "system" && !c.deletedAt
      && /^(unanswered|retrying)_message:/.test(String(c.metadata?.authorizationReason ?? ""))).map(c => ({ id: c.id as string, body: c.body as string }));
    /** REAL GET: the runs whose header the thread shows for this task. */
    const headers = async (id = issueId) => (await get(`/api/issues/${id}/live-runs`) as any[])
      .filter(run => ["queued", "running"].includes(run.status)).map(run => ({ id: run.id as string, status: run.status as string, execution: run.execution ?? null,
        createdAt: run.createdAt as string, startedAt: (run.startedAt ?? null) as string | null }));
    let unlockDelivery: (() => void) | undefined, lockWork: Promise<unknown> | undefined, lockTimer: ReturnType<typeof setTimeout> | undefined;
    let otherSend: Promise<unknown> | undefined;
    const summary: any = { variant, samples: [] as any[], violations: [] as string[] };
    summaries.push(summary);
    try {
      await ld.ready;
      await post(`/api/agents/${agentId}/pause`);
      await until("paused", async () => (await agent()).lifecycleState === "paused");
      const rw = heartbeat.registerIssueStateRecoveryWork(coordinator, () => true);
      const dw = heartbeat.registerRunDispatchWork(coordinator, () => true);
      const dr = heartbeat.registerDeferredReceiptWork(coordinator, () => true);
      await Promise.all([rw.ready, dw.ready, dr.ready]);
      if (variant === "busy") await db.insert(issues).values({ id: otherIssueId, companyId, title: "Other task", status: "todo", priority: "medium",
        assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 2, identifier: prefix + "-2" });
      const M = (await post(`/api/issues/${issueId}/comments`, { body: "M: are you there?", clientRequestId: randomUUID() })).body.id as string;
      // The real sweep, on its own timer, writes the paused note after its real 15-second settle.
      await until("the real paused note", async () => notesOf(await get(`/api/issues/${issueId}/comments`)).length > 0);
      const before = notesOf(await get(`/api/issues/${issueId}/comments`));
      expect(before.map(note => note.body), "while the agent IS paused the one line is the paused note").toEqual([PAUSED]);
      const noteId = before[0]!.id;
      if (variant === "lock") {
        let acquired!: () => void;
        const ready = new Promise<void>(resolve => { acquired = resolve; });
        const held = new Promise<void>(resolve => { unlockDelivery = resolve; });
        lockWork = db.$client.begin(async connection => {
          await connection`select pg_advisory_xact_lock(hashtextextended(${"conversation-delivery:" + issueId}, 0))`;
          acquired(); await held;
        });
        await ready;
      }
      await post(`/api/agents/${agentId}/resume`);
      const t0 = Date.now();
      if (variant === "lock") lockTimer = setTimeout(() => { summary.lockReleasedMs = Date.now() - t0; unlockDelivery!(); }, 4_000);
      // The agent's ONE slot goes to its real run on ANOTHER task (real Send there, right after the Resume).
      if (variant === "busy") otherSend = post(`/api/issues/${otherIssueId}/comments`, { body: "Other task: hold this turn", clientRequestId: randomUUID() });
      let next = t0, releasedOtherAt: number | null = null;
      const seen = { resuming: 0, headerOnly: 0, working: 0, queuedBehindOther: 0 };
      const captured = new Set<string>();
      for (;;) {
        await sleep(Math.max(0, next - Date.now()));
        const ms = Date.now() - t0;
        // Header reads on BOTH sides of the thread read: a header that existed BEFORE the comments read and a
        // header that exists AFTER it bound what the reader could have seen with those comments (no read skew).
        const headersBefore = await headers();
        const [comments, queue] = await Promise.all([get(`/api/issues/${issueId}/comments`), get(`/api/issues/${issueId}/queued-comments`)]);
        const headersAfter = await headers();
        const otherRunning = variant === "busy" ? (await headers(otherIssueId)).some(run => run.status === "running") : false;
        const notes = notesOf(comments);
        const panel = queue.executionWait ?? null;
        const state = (await agent()).lifecycleState;
        const sample = { ms, lifecycleState: state, notes: notes.map(note => note.body), headersBefore: headersBefore.map(h => h.status),
          headersAfter: headersAfter.map(h => h.status), panel: Boolean(panel), otherRunning };
        summary.samples.push(sample);
        const bad = (what: string) => summary.violations.push(`+${ms} ms: ${what} ${JSON.stringify(sample)}`);
        if (notes.some(note => /is paused/.test(note.body))) bad("STALE: the thread still says 'is paused' after Resume");
        if (notes.length > 1) bad("TWO notes");
        if (notes.some(note => note.id !== noteId)) bad("a second note row");
        const [note] = notes;
        let kind: string | null = null;
        if (note?.body === RESUMING) {
          kind = "resuming"; seen.resuming += 1;
          if (headersBefore.length > 0 || panel) bad("TWO lines: the resuming note beside the run header / panel line");
        } else if (note?.body === WORKING) {
          kind = "working"; seen.working += 1;
          if (!headersAfter.some(h => h.status === "running")) bad("WORKING with no running run");
        } else if (!note) {
          if (headersAfter.length === 0 && !panel) bad("ZERO lines: no note, no run header, no panel line");
          else { kind = headersAfter.some(h => h.status === "queued") && otherRunning ? "waiting-behind" : "header"; seen.headerOnly += 1; }
          if (headersAfter.some(h => h.status === "queued") && otherRunning) seen.queuedBehindOther += 1;
        } else if (!/is paused/.test(note.body)) bad("an unexpected line");
        // One capture per state (plus the late lock-held read) for the rendered TaskChatThread rows.
        const captureKey = kind === "resuming" && variant === "lock" && ms > 3_000 ? "resuming-lock-held" : kind;
        if (captureKey && !captured.has(captureKey)) {
          captured.add(captureKey);
          captures.push({ variant, state: captureKey, ms, lifecycleState: state, messageId: M, noteId, readAt: new Date().toISOString(),
            comments, queue, run: headersAfter[0] ?? null });
        }
        if (variant === "busy" && releasedOtherAt === null && seen.queuedBehindOther >= 10) { releasedOtherAt = ms; releaseOther("answer"); }
        if (kind === "working") break;
        if (ms > 100_000) { bad("WORKING not reached"); break; }
        next += 100;
      }
      summary.seen = seen; summary.firstHeaderMs = summary.samples.find((s: any) => s.headersAfter.length > 0)?.ms ?? null;
      summary.resumingMs = summary.samples.filter((s: any) => s.notes[0] === RESUMING).map((s: any) => s.ms);
      summary.releasedOtherAt = releasedOtherAt;
      console.log("RGAP", JSON.stringify({ variant, seen, firstHeaderMs: summary.firstHeaderMs, samples: summary.samples.length,
        lockReleasedMs: summary.lockReleasedMs ?? null, violations: summary.violations.length }));
      expect(summary.violations, "a TRUE line at every read: never 'is paused' after Resume, never zero, never two").toEqual([]);
      expect(summary.samples[0].notes, "the FIRST read after the Resume response already says 'resuming' (event-driven, same note)").toEqual([RESUMING]);
      expect(seen.resuming).toBeGreaterThan(0);
      if (variant === "lock") {
        expect(summary.firstHeaderMs, "the delivery lock was really held: no run before its release").toBeGreaterThan(3_500);
        expect(summary.resumingMs.filter((ms: number) => ms > 3_000).length, "the resuming line holds for the whole lock wait").toBeGreaterThan(0);
      }
      if (variant === "busy") expect(seen.queuedBehindOther, "M's queued run waited behind the other task's running run: its header alone").toBeGreaterThanOrEqual(10);
      // Through to the answer: the note retires, and ONE note row was ever written for M.
      release("answer");
      await until("M answered", async () => (await get(`/api/issues/${issueId}/comments`)).some((c: any) => c.authorType === "agent" && !c.deletedAt));
      await until("the note retired by the answer", async () => notesOf(await get(`/api/issues/${issueId}/comments`)).length === 0, 60_000);
      const everWritten = (await db.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")))).map(r => r.id);
      expect(everWritten, "ONE note row for M, ever (rewritten in place)").toEqual([noteId]);
      expect(workErrors).toEqual([]);
    } finally {
      if (lockTimer) clearTimeout(lockTimer);
      unlockDelivery?.(); await lockWork; await otherSend?.catch(() => undefined);
      releaseOther("answer"); release("answer");
      await coordinator.stop(); await lifecycle.stop();
      await heartbeat.drainActiveRunExecutions();
      // Teardown isolation only: a finished row's company cannot be redispatched by a later row's global workers.
      await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
      fixture.holds = {};
    }
  }

  it("ordinary: Resume -> 'resuming' (same note) -> the run header -> WORKING", () => row("ordinary"), 180_000);
  it("the REAL conversation delivery lock is held ~4 s after Resume: the line says 'resuming' the whole time, never 'is paused'", () => row("lock"), 180_000);
  it("waiting behind another task's run: 'resuming' -> M's queued run header alone ('Waiting for ...') -> WORKING", () => row("busy"), 180_000);
});
