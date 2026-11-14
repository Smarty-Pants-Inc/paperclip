import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { agents, approvals, heartbeatRuns, issueApprovals, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { conversationRunsForLastMessages } from "../services/agent-conversations.js";
import { pendingNativeGovernance } from "../services/native-runtime/native-governance.js";

describeIssueRecovery("RFL independent round 3 delta attacks", () => {
  const state = issueRecoveryFixture();
  const listeners: Server[] = [];
  const at = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  const record = (name: string, data: unknown) => appendFileSync(`${process.env.TASK_OUT}/delta-attack-receipts.jsonl`, JSON.stringify({name, data}) + "\n");
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
  async function seed(f: {companyId: string; agentId: string}, issueId = randomUUID(), answered = false) {
    const runId = randomUUID(), messageId = randomUUID();
    await state.db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "RFL delta person question", status: "in_review",
      assigneeAgentId: f.agentId, responsibleUserId: "recovery-user", conversationAgentId: f.agentId,
      conversationUserId: "recovery-user", conversationState: "waiting", createdAt: at(6), updatedAt: at(3) });
    await state.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId,
      authorUserId: "recovery-user", authorType: "user", body: "Please answer", createdAt: at(5), updatedAt: at(5) });
    await state.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, issueId,
      status: "succeeded", responsibleUserId: "recovery-user", createdAt: at(4.9), startedAt: at(4.8), finishedAt: at(4),
      contextSnapshot: { issueId, wakeCommentId: messageId } });
    if (answered) await state.db.insert(issueComments).values({ companyId: f.companyId, issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: runId, origin: "comment", body: "The answer", createdAt: at(3) });
    return { ...f, issueId, runId, messageId };
  }
  type F = Awaited<ReturnType<typeof seed>>;
  async function child(f: F, source = "issue.assigned_work_invariant", alsoDirect = false) {
    const id = randomUUID();
    await state.db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "succeeded", responsibleUserId: "recovery-user", createdAt: at(3.9), startedAt: at(3.8), finishedAt: at(3.1),
      contextSnapshot: { issueId: f.issueId, previousRunId: f.runId, source, ...(alsoDirect ? {wakeCommentId: f.messageId} : {}) } });
    await state.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: id, origin: "comment", body: "Successor answer", createdAt: at(3) });
    return id;
  }
  async function responder(f: {companyId: string; agentId: string}) {
    const failures: string[] = [];
    const listener = createServer(async (request, response) => {
      try {
        let body = ""; for await (const chunk of request) body += chunk;
        const { runId } = JSON.parse(body) as {runId: string};
        const [run] = await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));
        if (!run || typeof run.contextSnapshot?.issueId !== "string") throw new Error("unknown controlled run");
        await issueService(state.db).addComment(run.contextSnapshot.issueId, "Real controlled delta answer", { agentId: f.agentId, runId });
        response.end("ok");
      } catch (error) { failures.push(String(error)); response.statusCode = 500; response.end("failed"); }
    });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve)); listeners.push(listener);
    const port = (listener.address() as {port: number}).port;
    const script = `fetch("http://127.0.0.1:${port}",{method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok)throw Error(await r.text());console.log("delta-answer")}).catch(e=>{console.error(e);process.exitCode=1})`;
    await state.db.update(agents).set({adapterConfig: {command: process.execPath, args: ["-e",script], cwd:process.cwd()}}).where(eq(agents.id,f.agentId));
    return failures;
  }
  async function flush() {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await Promise.allSettled([...state.passes]);
    await state.heartbeat.drainActiveRunExecutions();
  }
  const runs = (f: F) => state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,f.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
  const carriers = (f: F) => conversationRunsForLastMessages(state.db, {companyId:f.companyId, issues:[{issueId:f.issueId,agentId:f.agentId}]});
  const sweep = () => recoveryService(state.db,{enqueueWakeup:state.heartbeat.wakeup}).assignedWork;

  it("an answered in_review chat with latest agent message gets no continuation", async () => {
    const f = await seed(await setup(), undefined, true); await responder(f);
    await state.start(); await flush();
    const result = await runs(f); record("answered-in-review", result.map(r=>({id:r.id,status:r.status})));
    expect(result).toHaveLength(1);
  });
  it.each(["ask_user_questions", "request_confirmation", "approval"])("in_review %s gate wins and the governance service still identifies the real gate", async kind => {
    const f = await seed(await setup()); await responder(f);
    let gateId: string;
    if (kind === "approval") {
      const [approval] = await state.db.insert(approvals).values({companyId:f.companyId,type:"plan",status:"pending",payload:{title:"Please approve"}} as never).returning();
      gateId=approval.id;
      await state.db.insert(issueApprovals).values({companyId:f.companyId,issueId:f.issueId,approvalId:gateId});
    } else {
      const [interaction] = await state.db.insert(issueThreadInteractions).values({companyId:f.companyId,issueId:f.issueId,sourceRunId:f.runId,createdByAgentId:f.agentId,
        addresseeUserId:"recovery-user",kind,status:"pending",title:"Choose before continuing",payload:{version:1,questions:[]} as never,createdAt:at(3)}).returning();
      gateId=interaction.id;
    }
    await state.start(); await flush();
    const result=await runs(f);
    const gate=await pendingNativeGovernance({db:state.db,companyId:f.companyId,issueId:f.issueId,runId:f.runId,executionState:null});
    record(`in-review-gate-${kind}`,{runCount:result.length,gate});
    expect(result).toHaveLength(1);
    expect(gate).toEqual({kind:kind === "approval" ? "approval" : "interaction",id:gateId});
  });
  it.each([false,true])("one valid successor reply is attributed once even when alsoDirect=%s", async alsoDirect => {
    const f=await seed(await setup()); const id=await child(f,undefined,alsoDirect);
    const result=await carriers(f); record(`provenance-dedup-${alsoDirect}`,result);
    expect(result.filter(r=>r.runId===id)).toEqual([{issueId:f.issueId,runId:id,lastPersonCommentId:f.messageId,hasReply:true}]);
    expect(result.filter(r=>r.hasReply)).toHaveLength(1);
    expect(await sweep().listSuspects({companyId:f.companyId},null,100)).toEqual([]);
  });
  it("a previousRunId without the assigned-work source is not answer provenance", async () => {
    const f=await seed(await setup()); const id=await child(f,"unrelated_source");
    const result=await carriers(f); record("foreign-source",result);
    expect(result.some(r=>r.runId===id)).toBe(false);
    expect(result.some(r=>r.hasReply)).toBe(false);
  });
  it("an unanswered in_review state=active chat still receives one continuation", async () => {
    const conversationState = "active";
    const f=await seed(await setup()); const failures=await responder(f);
    await state.db.update(issues).set({conversationState}).where(eq(issues.id,f.issueId));
    await state.start(); await flush();
    const result=await runs(f);
    const successors=result.filter(r=>r.id!==f.runId);
    record(`nonwaiting-${conversationState}`,result.map(r=>({id:r.id,status:r.status,source:r.contextSnapshot?.source})));
    expect(failures).toEqual([]);
    expect(successors).toHaveLength(1);
    const comments=await state.db.select().from(issueComments).where(eq(issueComments.issueId,f.issueId));
    expect(comments.filter(c=>c.authorAgentId===f.agentId && c.createdByRunId===successors[0]!.id)).toHaveLength(1);
  });
  it("registered discovery reaches an unanswered chat after a full page of recovery-answered chats", async () => {
    const f=await setup();
    for(let i=1;i<=100;i++) {
      const agentId=randomUUID();
      await state.db.insert(agents).values({id:agentId,companyId:f.companyId,name:`Answered agent ${i}`,status:"idle",adapterType:"process"});
      const answered=await seed({...f,agentId},`00000000-0000-4000-8000-${String(i).padStart(12,"0")}`);
      await child(answered);
    }
    const target=await seed(f,"ffffffff-ffff-4fff-8fff-ffffffffffff");
    const failures=await responder(f);
    const page=await sweep().listSuspects({companyId:f.companyId},null,100);
    const after=await sweep().listSuspects({companyId:f.companyId},"00000000-0000-4000-8000-000000000100",100);
    record("pagination-before-registration",{page,after});
    await state.start(); await flush();
    const result=await runs(target);
    record("pagination-registered-result",{target:target.issueId,runs:result.map(r=>({id:r.id,status:r.status})),snapshot:state.worker.assignedWork!.reconciliationSnapshot(),failures});
    expect(failures).toEqual([]);
    expect(result.filter(r=>r.id!==target.runId)).toHaveLength(1);
    const comments=await state.db.select().from(issueComments).where(eq(issueComments.issueId,target.issueId));
    expect(comments.filter(c=>c.authorAgentId===f.agentId)).toHaveLength(1);
  },90000);
});
