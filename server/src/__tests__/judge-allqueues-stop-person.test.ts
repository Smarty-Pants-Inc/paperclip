import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companyMemberships, companies, createDb, heartbeatRuns, heartbeatRunEvents, issueComments } from "@paperclipai/db";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { CONVERSATION_CONTINUATION_POLICY } from "../services/conversation-continuation.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

const OUT = process.env.RF5_OUT!;
// Auth boundary only is planted: two persisted board users with real company
// memberships, or the process run's agent actor. No route/service is mocked.
(support.supported ? describe : describe.skip)("RF4 fully settled Stop then Send: other-person hold must stay held", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    database = await startRecoveryPostgres("paperclip-rf5-nr-");
    db = createDb(database.connectionString);
    for (const id of ["nr-sender", "nr-other"]) await db.insert(authUsers).values({ id, name: id, email: `${id}@paperclip.test`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });

  it.each((["chat"] as const).flatMap(surface => (["R2"] as Array<"R1" | "R2" | "R2b" | "twice">).map(row => ({ surface, row }))))("$row $surface", async ({ surface, row }) => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RF5 independent judge", issuePrefix: `NR${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    for (const id of ["nr-sender", "nr-other"]) await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole: "operator" });
    const turns: { runId: string; commentIds: string[]; startedAt: string }[] = [];
    const observations: any[] = [];
    const stem = `${row}-${surface}`;
    const save = () => writeFileSync(join(OUT, `${stem}.json`), JSON.stringify({ row, surface, companyId, agentId, issueId, m0, held, turns, observations }, null, 2));
    let issueId = "", m0 = "", held: string[] = [], typedId = "";
    const makeApp = (userId: string, runId?: string) => {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = runId ? { type: "agent", agentId, companyId, runId, source: "api_key" } : { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
        next();
      });
      app.use("/api", agentRoutes(db, {})); app.use("/api", issueRoutes(db, { wakeup: async () => null } as never)); app.use(errorHandler); return app;
    };
    const sender = makeApp("nr-sender"), other = makeApp("nr-other");
    const responder = express(); responder.use(express.json());
    responder.post("/respond", async (req, res) => {
      try {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, req.body.runId));
        const ctx = (run.contextSnapshot ?? {}) as any;
        const ids = Array.isArray(ctx.wakeCommentIds) ? ctx.wakeCommentIds.map(String) : typeof ctx.wakeCommentId === "string" ? [ctx.wakeCommentId] : [];
        // Same capability publication as supplied rf5 harness; no outcomes planted.
        await db.update(heartbeatRuns).set({resultJson:{...(run.resultJson ?? {}),conversationContinuation:CONVERSATION_CONTINUATION_POLICY}}).where(eq(heartbeatRuns.id,run.id));
        turns.push({ runId: run.id, commentIds: ids, startedAt: new Date().toISOString() }); save();
        if (turns.length <= (row === "R1" ? 2 : row === "twice" ? 2 : 1)) { res.json({ hold: true }); return; }
        const response = await request(makeApp("", run.id)).post(`/api/issues/${issueId}/comments`).send({ body: `Answer to ${ids.join(",")}` });
        observations.push({ label: "real agent answer POST", status: response.status, body: response.body }); save();
        if (response.status !== 201) throw new Error(`agent POST ${response.status}: ${response.text}`);
        res.json({ hold: false });
      } catch (error) { res.status(500).json({ error: String(error) }); }
    });
    const listener = responder.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => listener.once("listening", resolve));
    const port = (listener.address() as { port: number }).port;
    const cwd = await mkdtemp(join(tmpdir(), "rf5-nr-process-"));
    const script = `fetch("http://127.0.0.1:${port}/respond",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok){console.error(r.status,await r.text());process.exitCode=1;return}const j=await r.json();if(j.hold)setInterval(()=>{},1000)})`;
    await db.insert(agents).values({ id: agentId, companyId, name: "RF5 process", role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", script], cwd }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    const issue = await issueService(db).create(companyId, { title: `RF5 ${row} ${surface}`, ...(surface === "chat" ? { conversationAgentId: agentId, conversationUserId: "nr-sender", conversationState: "waiting" as const } : {}), assigneeAgentId: agentId, status: "in_review" }); issueId = issue.id;
    const heartbeat = heartbeatService(db);
    const post = async (body: string) => {
      const response = await request(sender).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      observations.push({ label: `real person POST ${body}`, status: response.status, body: response.body }); save();
      expect(response.status, response.text).toBe(201); return response.body.id as string;
    };
    const wait = async (done: () => Promise<boolean>, ms = 15000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) { if (await done()) return true; await new Promise(r => setTimeout(r, 50)); } return false;
    };
    const live = async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))).length;
    const snap = async (label: string, now?: Date) => {
      const sweep = now ? await settleUnansweredPersonMessage(db, { companyId, issueId, now }) : null;
      const gets: Record<string, any> = {};
      for (const [key, path] of [["comments", `/api/issues/${issueId}/comments`], ["queue", `/api/issues/${issueId}/queued-comments`], ["issue", `/api/issues/${issueId}`], ["agent", `/api/agents/${agentId}`], ["runs", `/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=100`]] as const) {
        const response = await request(sender).get(path);
        gets[key] = { status: response.status, body: response.body };
        writeFileSync(join(OUT, `${stem}--${label}.${key}.get.json`), response.text);
        expect(response.status, `${key}: ${response.text}`).toBe(200);
      }
      if (turns[0]) {
        const response = await request(sender).get(`/api/heartbeat-runs/${turns[0].runId}`);
        gets.m0run = { status: response.status, body: response.body };
        writeFileSync(join(OUT, `${stem}--${label}.m0run.get.json`), response.text);
      }
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      observations.push({ label, now: now?.toISOString(), sweep, gets, wakes, turns: [...turns] }); save(); return gets;
    };
    try {
      const pump = async () => {
        const saved = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId),eq(agentWakeupRequests.status,"deferred_issue_execution")));
        for(const wake of saved) if((wake.payload as any)?.queuedCommentInterrupt) await heartbeat.resumeQueuedCommentInterrupt(companyId,wake.id);
        await heartbeat.resumeQueuedRuns();
      };
      const press = async (runId: string | null) => {
        const q = await request(sender).get(`/api/issues/${issueId}/queued-comments`).expect(200);
        const r = await request(sender).post(`/api/issues/${issueId}/queued-comments/interrupt`).send({queueId:q.body.queueId,targetRunId:runId,revision:q.body.revision});
        observations.push({label:"real Interrupt POST",queue:q.body,status:r.status,body:r.body});save();expect(r.status,r.text).toBe(200);return r;
      };
      if(row === "R1") {
        m0 = await post("M0: before Stop");
        expect(await wait(async()=>turns.length===1)).toBe(true);
        const r = await request(sender).post(`/api/heartbeat-runs/${turns[0]!.runId}/cancel`).send({});
        observations.push({label:"real Stop before HELD1",status:r.status,body:r.body});save();expect(r.status,r.text).toBe(200);
        expect(await wait(async()=>await live()===0)).toBe(true);
      }
      await heartbeat.drainActiveRunExecutions();
      const n = turns.length;
      const h1 = await post("HELD1");held.push(h1);
      expect(await wait(async()=>turns.length>n)).toBe(true);
      const source = turns[n]!;
      if(row === "R2b") {
        const r=await request(makeApp("",source.runId)).post(`/api/issues/${issueId}/comments`).send({body:"partial reply to HELD1"});
        observations.push({label:"real partial answer",status:r.status,body:r.body});save();expect(r.status,r.text).toBe(201);
      }
      held.push(await post("HELD2"),await post("HELD3"));
      const foreignId=randomUUID(), foreignWake=randomUUID();
      // Foreign queues cannot be produced by another user through this owned
      // Agent Chat's comment route (403); this persisted historical row is planted.
      await db.insert(issueComments).values({id:foreignId,companyId,issueId,authorType:"user",authorUserId:"nr-other",body:"OTHER-PERSON-HELD"});
      await db.insert(agentWakeupRequests).values({id:foreignWake,companyId,agentId,source:"issue_comment",reason:"issue_execution_deferred",status:"deferred_issue_execution",requestedByActorType:"user",requestedByActorId:"nr-other",payload:{issueId,commentId:foreignId,_paperclipWakeContext:{wakeCommentId:foreignId,commentId:foreignId,wakeCommentIds:[foreignId]}}});
      await snap("before-stop");
      const stopped=await request(sender).post(`/api/heartbeat-runs/${source.runId}/cancel`).send({});
      observations.push({label:"real Stop before fully settled Send",status:stopped.status,body:stopped.body});save();expect(stopped.status,stopped.text).toBe(200);
      expect(await wait(async()=>await live()===0)).toBe(true);
      await heartbeat.drainActiveRunExecutions();await new Promise(r=>setTimeout(r,500));
      const acceptance=await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,source.runId));
      observations.push({label:"settled Stop acceptance events",acceptance,foreignId,foreignWake});save();
      await snap("before-interrupt");
      await press(null);
      if(row === "twice") {
        expect(await wait(async()=>{await pump();return turns.length>=2;})).toBe(true);
        held.push(await post("HELD4 second Interrupt"));
        await wait(async()=>{const q=await request(sender).get(`/api/issues/${issueId}/queued-comments`);return (q.body.entries ?? []).some((e:any)=>e.comment.id===held[3]);},3000);
        await press(turns[1]!.runId);
      }
      const until=Date.now()+3500; do {await pump();await new Promise(r=>setTimeout(r,100));} while(Date.now()<until);
      const final = await snap("after-interrupt");
      const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agentId));
      const successors=turns.slice(n+1).filter(t=>allRuns.some(r=>r.id===t.runId && r.status==="succeeded"));
      observations.push({label:"deciding record",held,source,successors,allRuns});save();
      const expected=held.slice(1);
      expect(successors.flatMap(t=>t.commentIds)).toEqual(expected);
      if(row !== "twice") expect(successors[0]?.commentIds,"exact input of the immediate next turn").toEqual(expected);
      expect((final.queue.body.entries ?? []),JSON.stringify(final.queue.body)).toHaveLength(0);
    } finally {
      save(); await heartbeat.cancelActiveForAgent(agentId).catch(() => undefined);
      await new Promise<void>(resolve => listener.close(() => resolve())); await rm(cwd, { recursive: true, force: true });
    }
  }, 60000);
});
