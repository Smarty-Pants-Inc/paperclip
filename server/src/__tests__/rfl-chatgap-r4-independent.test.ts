import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { conversationRunsForLastMessages } from "../services/agent-conversations.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";

// Independent R4 regressions. Keep reason: recorded missing-answer recovery incident;
// real PostgreSQL selector + ordinary registered workers, controlled reply only.
describeIssueRecovery("RFL round 4 independent silence and pagination checks", () => {
  const state = issueRecoveryFixture();
  const listeners: Server[] = [];
  const at = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  const record = (name: string, data: unknown) => appendFileSync(`${process.env.TASK_OUT}/r4-independent-receipts.jsonl`, JSON.stringify({name, data}) + "\n");
  afterEach(async () => {
    for (const listener of listeners.splice(0)) {
      listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });
  async function setup() {
    const f = await state.fixture();
    await instanceSettingsService(state.db).updateExperimental({ enableAgentChat: true });
    return f;
  }
  async function seed(f: { companyId: string; agentId: string }, issueId = randomUUID(), kind: "waiting" | "active" | "channel-null" = "waiting") {
    const runId = randomUUID(), messageId = randomUUID();
    await state.db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Unanswered person question", status: "in_review",
      assigneeAgentId: f.agentId, responsibleUserId: "recovery-user",
      ...(kind === "channel-null" ? { originKind: "chat_channel", conversationAgentId: null, conversationUserId: null, conversationState: null }
        : { conversationAgentId: f.agentId, conversationUserId: "recovery-user", conversationState: kind }),
      createdAt: at(6), updatedAt: at(3) });
    await state.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId,
      authorUserId: "recovery-user", authorType: "user", body: "Please answer my outstanding question", createdAt: at(5), updatedAt: at(5) });
    await state.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, issueId,
      status: "succeeded", responsibleUserId: "recovery-user", createdAt: at(4.9), startedAt: at(4.8), finishedAt: at(4),
      contextSnapshot: { issueId, wakeCommentId: messageId } });
    return { ...f, issueId, runId, messageId };
  }
  type F = Awaited<ReturnType<typeof seed>>;
  async function child(f: F) {
    const id = randomUUID();
    await state.db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "succeeded", responsibleUserId: "recovery-user", createdAt: at(3.9), startedAt: at(3.8), finishedAt: at(3.1),
      contextSnapshot: { issueId: f.issueId, previousRunId: f.runId, source: "issue.assigned_work_invariant" } });
    await state.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: id, origin: "comment", body: "Already answered by ordinary successor", createdAt: at(3) });
  }
  async function responder(f: {companyId: string; agentId: string}) {
    const failures: string[] = [];
    const listener = createServer(async (request, response) => {
      try {
        let body = ""; for await (const chunk of request) body += chunk;
        const { runId } = JSON.parse(body) as {runId: string};
        const [run] = await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));
        if (!run || typeof run.contextSnapshot?.issueId !== "string") throw new Error("unknown controlled run");
        await issueService(state.db).addComment(run.contextSnapshot.issueId, "Controlled answer to the outstanding person question", { agentId: f.agentId, runId });
        response.end("ok");
      } catch (error) { failures.push(String(error)); response.statusCode = 500; response.end("failed"); }
    });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve)); listeners.push(listener);
    const port = (listener.address() as {port: number}).port;
    const script = `fetch("http://127.0.0.1:${port}",{method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok)throw Error(await r.text());console.log("answered")}).catch(e=>{console.error(e);process.exitCode=1})`;
    await state.db.update(agents).set({adapterConfig: {command: process.execPath, args: ["-e",script], cwd:process.cwd()}}).where(eq(agents.id,f.agentId));
    return failures;
  }
  const sweep = () => recoveryService(state.db,{enqueueWakeup:state.heartbeat.wakeup}).assignedWork;
  const runs = (f: F) => state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,f.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
  it.each(["waiting", "active", "channel-null"] as const)("unanswered in_review %s still receives one real reply via registered recovery", async kind => {
    const f = await seed(await setup(), undefined, kind);
    const failures = await responder(f);
    const carriers = await conversationRunsForLastMessages(state.db, { companyId: f.companyId, issues: [{issueId: f.issueId, agentId: f.agentId}] });
    const suspects = await sweep().listSuspects({ companyId:f.companyId }, null, 100);
    await state.start();
    await new Promise(resolve => setTimeout(resolve, 2500));
    await Promise.allSettled([...state.passes]);
    await state.heartbeat.drainActiveRunExecutions();
    const result = await runs(f);
    const comments = await state.db.select({ body:issueComments.body, authorAgentId:issueComments.authorAgentId, createdByRunId:issueComments.createdByRunId }).from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const [current] = await state.db.select({status:issues.status, conversationState:issues.conversationState, originKind:issues.originKind}).from(issues).where(eq(issues.id,f.issueId));
    record(`silence-${kind}`, { f, carriers, suspects, current, runs:result.map(r=>({id:r.id,status:r.status,source:r.contextSnapshot?.source})), comments, snapshot:state.worker.assignedWork!.reconciliationSnapshot(), failures });
    expect(carriers.some(r=>r.hasReply)).toBe(false);
    expect(failures).toEqual([]);
    expect(result.filter(r=>r.id!==f.runId)).toHaveLength(1);
    expect(comments.filter(c=>c.authorAgentId===f.agentId)).toHaveLength(1);
  });
  it("NULL direct-conversation state is forbidden by the real schema (channel NULL remains valid)", async () => {
    const f = await seed(await setup());
    let constraint: string | null = null;
    try { await state.db.update(issues).set({conversationState:null}).where(eq(issues.id,f.issueId)); }
    catch (error) { constraint = (error as {cause?:{constraint_name?:string}}).cause?.constraint_name ?? (error as {constraint_name?:string}).constraint_name ?? null; }
    record("null-direct-schema", { constraint });
    expect(constraint).toBe("issues_conversation_identity_check");
  });
  function countQueries() {
    const original = state.db.$client.options.debug;
    let queries = 0, pages = 0;
    state.db.$client.options.debug = (_connection, query) => {
      queries++;
      if (query.includes('from "issues"') && query.includes('order by "issues"."id" limit')) pages++;
    };
    return { get: () => ({queries,pages}), stop: () => {state.db.$client.options.debug=original;} };
  }
  async function numbered(f: {companyId:string;agentId:string}, i:number, answered:boolean) {
    const agentId = randomUUID();
    await state.db.insert(agents).values({id:agentId,companyId:f.companyId,name:`Pagination ${i}`,status:"idle",adapterType:"process"});
    const row = await seed({...f,agentId},`00000000-0000-4000-8000-${String(i).padStart(12,"0")}`);
    if (answered) await child(row);
    return row;
  }
  it("records raw SQL pages and time after 1000 successor-answered chats", async () => {
    const f=await setup();
    for(let i=1;i<=1000;i++) await numbered(f,i,true);
    const target=await seed(f,"ffffffff-ffff-4fff-8fff-ffffffffffff");
    const count=countQueries(), start=performance.now();
    let page: Awaited<ReturnType<ReturnType<typeof sweep>["listSuspects"]>>;
    try { page=await sweep().listSuspects({companyId:f.companyId},null,100); }
    finally {count.stop();}
    record("1000-answered-cost", {answered:1000,limit:100,elapsedMs:performance.now()-start,...count.get(),returned:page!.map(r=>r.id)});
    expect(page!.map(r=>r.id)).toEqual([target.issueId]);
  },180000);
  it("real registered caller resumes at last RETURNED id and never skips sliced-off eligible rows", async () => {
    const f=await setup(), expected:string[]=[];
    // Raw page 1: 50 answered + 50 eligible. Page 2: 100 eligible, 50 sliced
    // off the first return. Page 3: 51 eligible. Next caller must rescan suffix.
    for(let i=1;i<=251;i++) {
      const row=await numbered(f,i,i<=50);
      if(i>50) expected.push(row.issueId);
    }
    const calls:Array<{cursor:string|null;ids:string[]}>=[], checked:string[]=[];
    const real=sweep();
    const coordinator=createDeliveryWorkCoordinator({owner:state.db,canRun:()=>true,canReconcile:()=>true,onError:e=>state.errors.push(e)});
    const worker=registerIssueRecoveryWork(state.db,coordinator,{
      stranded:async()=>{}, orphanBlockers:async()=>{}, recoveryActions:async()=>{}, dependencies:async()=>({enqueueFailed:0}),
      locks:async()=>{},watchdogs:async()=>({incomplete:0}),schedulingSuppressed:async()=>false,
      assignedWork:{listSuspects:async(scope,cursor,limit)=>{const rows=await real.listSuspects(scope,cursor,limit);calls.push({cursor,ids:rows.map(r=>r.id)});return rows;},
        checkIssue:async scope=>{checked.push(scope.issueId);}},
    },()=>true);
    try {
      await worker.ready;
      await vi.waitFor(()=>expect(new Set(checked).size).toBe(expected.length),{timeout:30000,interval:100});
      record("caller-cursor",{calls,checked,expected,snapshot:worker.assignedWork!.reconciliationSnapshot()});
      expect(calls[1].cursor).toBe(calls[0].ids.at(-1));
      expect(calls[0].ids).toEqual(expected.slice(0,100));
      expect(calls[1].ids).toEqual(expected.slice(100,200));
      expect(calls[2].ids).toEqual(expected.slice(200));
      expect([...new Set(checked)].sort()).toEqual(expected);
    } finally {await worker.stop();await coordinator.stop();}
  },180000);
});
