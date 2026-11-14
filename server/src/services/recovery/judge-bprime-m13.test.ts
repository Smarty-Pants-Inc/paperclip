// Independent judge checks. Isolated PostgreSQL; no production access or mocked decisions.
// Keep reasons: SMA-183 delayed follow-up, SMAA-1907 admission gap, durable notice/data safety.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { heartbeatService } from "../heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("independent M1.3 bounded notice and retention judge", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("judge-bprime-m13-"); db = createDb(temp.connectionString); }, 60000);
  afterAll(async () => { if (db) await heartbeatService(db).drainActiveRunExecutions(); await db?.$client.end(); await temp?.cleanup(); });
  async function fixture(opts: { oldRefusal?: boolean; codeOnly?: boolean; carries?: boolean; pending?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID(), runId = randomUUID();
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() + ms);
    await db.insert(authUsers).values({ id:userId, name:"Judge", email:userId+"@example.test", emailVerified:true, createdAt:now, updatedAt:now });
    await db.insert(companies).values({ id: companyId, name: "Independent M13", issuePrefix: companyId.slice(0,8), defaultResponsibleUserId:userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", status: "active", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", assigneeAgentId: agentId, status: "blocked", conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    const [m] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId, body: "Please continue", createdAt: at(-5*60000) }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, issueId, runtimeMode: "native", status: "failed",
      createdAt: at(opts.oldRefusal ? -3*3600000 : -4*60000), finishedAt: at(opts.oldRefusal ? -3*3600000+1000 : -3*60000),
      errorCode: opts.pending ? "adapter_failed" : "native_continuation_requires_reconciliation",
      error: opts.pending ? "Provider unavailable" : opts.codeOnly ? null : "native_controller_recovery_missing_evidence:snapshot_binding",
      contextSnapshot: { issueId, ...(opts.carries ? { wakeCommentId: m!.id } : {}) } });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: opts.pending ? "system" : "board", status: opts.pending ? "resolved" : "active",
      cause: "native_continuation_requires_reconciliation", fingerprint: "judge:"+runId, nextAction: "Inspect the saved state", evidence: opts.pending ? { runId, continuationDelivery: "pending", freshContinuation: { sourceRunId: runId } } : { runId } }).returning();
    const settle = (ahead=0, q=db) => settleUnansweredPersonMessage(q, { companyId, issueId, now: at(ahead) });
    const all = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    const live = async () => (await all()).filter(n => !n.deletedAt);
    return { companyId, agentId, issueId, runId, userId, messageId: m!.id, holdId: hold!.id, now, at, settle, all, live };
  }
  it("delayed follow-up: a three-hour-old reconciliation refusal must still prohibit resend-safe advice", async () => {
    const f = await fixture({ oldRefusal: true });
    await f.settle();
    const n = await f.live();
    expect(n).toHaveLength(1);
    expect(n[0]!.body, "a durable unresolved refusal does not expire after one hour").not.toMatch(/sending it again is safe/i);
    expect(n[0]!.body).toMatch(/can(?:not|'t) continue/i);
  });
  it("code-only active reconciliation hold must not say resend is safe (RFL 09:16 ruling)", async () => {
    const f = await fixture({ codeOnly: true });
    await f.settle();
    const n = await f.live();
    expect(n).toHaveLength(1);
    expect(n[0]!.body).not.toMatch(/sending it again is safe/i);
  });
  it.each([false,true])("real resend admission with codeOnly=%s has no new run while reconciliation blocks it", async codeOnly => {
    const f = await fixture({codeOnly});
    await db.update(heartbeatRuns).set({nativePhase:"terminal_failure"}).where(eq(heartbeatRuns.id,f.runId));
    await db.insert(nativeRunFinalizations).values({companyId:f.companyId, issueId:f.issueId, runId:f.runId, phase:"terminal_failure", recoveryState:"blocked", failureCode:"native_continuation_requires_reconciliation"});
    const [message] = await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issueId,authorType:"user",authorUserId:f.userId,body:"Sending again",createdAt:new Date()}).returning();
    const admitted = await heartbeatService(db).wakeup(f.agentId,{source:"on_demand",triggerDetail:"manual",reason:"issue_commented",requestedByActorType:"user",requestedByActorId:f.userId,
      payload:{issueId:f.issueId,commentId:message!.id},contextSnapshot:{issueId:f.issueId,taskId:f.issueId,wakeReason:"issue_commented",wakeCommentId:message!.id}});
    const runs=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId,f.issueId));
    console.log("resend admission receipt",JSON.stringify({codeOnly,admitted:admitted?.id??null,runCount:runs.length}));
    expect(admitted).toBeNull();
    expect(runs).toHaveLength(1);
  },60000);
  it.each(["failed", "cancelled", "pending", "coalesced"])("pending continuation -> %s: bounded wait ends with one durable note, no new run", async delivery => {
    const f = await fixture({ carries: true, pending: true });
    expect((await f.settle()).kind).toBe("pending");
    expect(await f.live()).toHaveLength(0);
    await db.update(issueRecoveryActions).set({ evidence: { runId: f.runId, continuationDelivery: delivery, freshContinuation: { sourceRunId: f.runId } } }).where(eq(issueRecoveryActions.id, f.holdId));
    const ahead = delivery === "failed" || delivery === "cancelled" ? 1000 : 121000;
    expect((await f.settle(ahead)).kind).toBe("noticed");
    await f.settle(ahead+1000);
    expect(await f.live()).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))).some(a => a.action === "issue.unanswered_message_wait")).toBe(true);
  });
  it("two independent clients then restart: one durable message key and retained held-note history", async () => {
    const f = await fixture();
    const other = createDb(temp.connectionString);
    try { await Promise.all([f.settle(0), f.settle(0, other)]); } finally { await other.$client.end(); }
    const first = await f.live();
    expect(first).toHaveLength(1);
    const restarted = createDb(temp.connectionString);
    try { expect((await f.settle(1000, restarted)).kind).toBe("noticed_before"); } finally { await restarted.$client.end(); }
    const [user] = await db.insert(issueComments).values({ companyId:f.companyId, issueId:f.issueId, authorType:"user", authorUserId:f.userId, body:"Again?", createdAt:f.at(2000) }).returning();
    const [foreignSystem] = await db.insert(issueComments).values({ companyId:f.companyId, issueId:f.issueId, authorType:"system", body:"Keep this unrelated notice", createdAt:f.at(-10000), metadata: { version:1, sections:[], authorizationReason:"other_notice:keep" } }).returning();
    const [oldAgent] = await db.insert(issueComments).values({ companyId:f.companyId, issueId:f.issueId, authorType:"agent", authorAgentId:f.agentId, body:"Earlier agent history", createdAt:f.at(-10*60000) }).returning();
    const [trace] = await db.insert(heartbeatRunEvents).values({ companyId:f.companyId, runId:f.runId, agentId:f.agentId, seq:1, eventType:"judge.trace", stream:"system", level:"info", message:"Retain trace" }).returning();
    await f.settle(130000);
    const rows = await f.all();
    // RFL-AUTHORIZED (M1.5, never-delete): exactly ONE current held note; the earlier note is present, deleted_at NULL, supersededBy = the new id.
    const cur1=rows.filter(n=>!n.deletedAt&&!n.metadata?.supersededBy&&!(n.metadata as Record<string,unknown>|null)?.supersededByInteractionId&&n.metadata?.authorizationReason?.startsWith("unanswered_message:"));
    expect(cur1).toHaveLength(1);
    expect(cur1[0]!.presentation?.title).toBe("This conversation can't continue");
    expect(rows.find(n=>n.id===first[0]!.id)?.deletedAt).toBeNull();
    expect(rows.find(n=>n.id===first[0]!.id)?.metadata?.supersededBy).toBe(cur1[0]!.id);
    expect(rows.find(n=>n.id===first[0]!.id)?.body).toBe(first[0]!.body);
    expect(rows.find(n=>n.id===foreignSystem!.id)?.deletedAt).toBeNull();
    const retained = await db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issueId),isNull(issueComments.deletedAt)));
    expect(retained.map(n=>n.id)).toEqual(expect.arrayContaining([f.messageId,user!.id,oldAgent!.id,foreignSystem!.id]));
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.id,trace!.id))).toHaveLength(1);
  });
  it("a queued message behind a reconciliation hold must not promise it will start by itself", async () => {
    const f = await fixture({codeOnly:true});
    await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,issueId:f.issueId,nativeIssueId:f.issueId,runtimeMode:"native",status:"queued",createdAt:f.at(-60000),contextSnapshot:{issueId:f.issueId,wakeCommentId:f.messageId}});
    expect((await f.settle()).kind).toBe("pending");
    await f.settle(121000);
    const n=await f.live();
    expect(n).toHaveLength(1);
    expect(n[0]!.body,"the durable hold still blocks the queued message").not.toContain("it will start by itself");
    expect(n[0]!.body).toMatch(/can(?:not|'t) continue/i);
  });
  it("upgrading a waiting note to held must supersede the earlier live held note too", async () => {
    const f=await fixture({codeOnly:true});
    await f.settle();
    const [first]=await f.live();
    expect(first!.body).toMatch(/can(?:not|'t) continue/i);
    await db.update(issueRecoveryActions).set({status:"resolved"}).where(eq(issueRecoveryActions.id,f.holdId));
    const [second]=await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issueId,authorType:"user",authorUserId:f.userId,body:"Try once more",createdAt:f.at(1000)}).returning();
    const [queued]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,issueId:f.issueId,nativeIssueId:f.issueId,runtimeMode:"native",status:"queued",createdAt:f.at(2000),contextSnapshot:{issueId:f.issueId,wakeCommentId:second!.id}}).returning();
    expect((await f.settle(3000)).kind).toBe("pending");
    await f.settle(124000);
    expect((await f.live()).map(n=>n.body)).toContain("Your message is waiting for the agent to be free; it will start by itself.");
    await db.update(issueRecoveryActions).set({status:"active"}).where(eq(issueRecoveryActions.id,f.holdId));
    await db.update(heartbeatRuns).set({status:"failed",finishedAt:f.at(125000),errorCode:"native_continuation_requires_reconciliation",error:"native_controller_recovery_missing_evidence:snapshot_binding"}).where(eq(heartbeatRuns.id,queued!.id));
    await f.settle(150000);
    // RFL-AUTHORIZED (M1.5, never-delete): exactly ONE current held note; the earlier note is present, deleted_at NULL, supersededBy = the new id.
    const n=(await f.live()).filter(x=>!x.metadata?.supersededBy&&!(x.metadata as Record<string,unknown>|null)?.supersededByInteractionId);
    expect(n.map(x=>x.body),"exactly ONE current note for the conversation, and it is the held note").toHaveLength(1);
    expect(n[0]!.presentation?.title).toBe("This conversation can't continue");
    expect(n[0]!.metadata?.authorizationReason).toBe("unanswered_message:"+second!.id);
    const earlier=(await f.all()).find(x=>x.id===first!.id)!;
    expect(earlier.deletedAt).toBeNull();
    expect(earlier.metadata?.supersededBy).toBe(n[0]!.id);
    expect(earlier.body).toBe(first!.body);
  });
  it("a later held message must not soft-delete a previous same-run progress/history note", async () => {
    const f=await fixture({carries:true});
    await db.update(issueRecoveryActions).set({status:"resolved"}).where(eq(issueRecoveryActions.id,f.holdId));
    await db.update(heartbeatRuns).set({errorCode:"native_session_interrupted",error:"native session transport interrupted",finishedAt:f.at(-60000)}).where(eq(heartbeatRuns.id,f.runId));
    await db.insert(nativeRunFinalizations).values({companyId:f.companyId,issueId:f.issueId,runId:f.runId,phase:"retryable_failure",nextAttemptAt:f.at(60000)});
    expect((await f.settle()).kind).toBe("pending");
    await f.settle(121000);
    const [progress]=await f.live();
    expect(progress!.body).toBe("Coder is still trying to reach its workspace; your message is kept.");
    await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issueId,authorType:"user",authorUserId:f.userId,body:"Still there?",createdAt:f.at(122000)});
    await db.update(issueRecoveryActions).set({status:"active"}).where(eq(issueRecoveryActions.id,f.holdId));
    await db.update(nativeRunFinalizations).set({phase:"terminal_failure",nextAttemptAt:null}).where(eq(nativeRunFinalizations.runId,f.runId));
    await db.update(heartbeatRuns).set({errorCode:"native_continuation_requires_reconciliation",error:"native_controller_recovery_missing_evidence:snapshot_binding",finishedAt:f.at(130000)}).where(eq(heartbeatRuns.id,f.runId));
    await f.settle(300000);
    const kept=(await f.all()).find(x=>x.id===progress!.id)!;
    expect(kept,"the original progress row remains").toBeDefined();
    expect(kept.deletedAt,"progress history is not an earlier HELD note and must not vanish").toBeNull();
    expect(kept.body).toBe(progress!.body);
  });
  it("two OS processes and a third after restart share the same Postgres message key", async () => {
    const f = await fixture();
    const child = async () => {
      const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)), fileURLToPath(new URL("./judge-bprime-worker.ts", import.meta.url))], {
        env: { ...process.env, JUDGE_DB_URL: temp.connectionString, JUDGE_COMPANY:f.companyId, JUDGE_ISSUE:f.issueId, JUDGE_NOW:f.now.toISOString() }, timeout:60000,
      });
      return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {pid:number; kind:string};
    };
    const first = await Promise.all([child(),child()]);
    expect(new Set(first.map(r=>r.pid)).size).toBe(2);
    expect(first.map(r=>r.kind).sort()).toEqual(["noticed","noticed_before"]);
    const third = await child();
    expect(first.map(r=>r.pid)).not.toContain(third.pid);
    expect(third.kind).toBe("noticed_before");
    expect(await f.live()).toHaveLength(1);
    console.log("independent OS process receipt", JSON.stringify({ first,third }));
  },150000);
  it("an informational continuation-path notice is not a terminal explanation of the unanswered message", async () => {
    const f = await fixture({ carries:true, pending:true });
    await db.update(issueRecoveryActions).set({ evidence:{ runId:f.runId, continuationDelivery:"failed", freshContinuation:{ sourceRunId:f.runId } } }).where(eq(issueRecoveryActions.id,f.holdId));
    const [child] = await db.insert(heartbeatRuns).values({ companyId:f.companyId, agentId:f.agentId, issueId:f.issueId, nativeIssueId:f.issueId, runtimeMode:"native", status:"failed", retryOfRunId:f.runId, createdAt:f.at(-2*60000), finishedAt:f.at(-60000), errorCode:"adapter_failed", contextSnapshot:{ issueId:f.issueId } }).returning();
    await db.insert(issueComments).values({ companyId:f.companyId, issueId:f.issueId, authorType:"system", body:"Trying to recover automatically.", createdAt:f.at(-90000), presentation:{ kind:"system_notice", title:"Recovery is starting", tone:"info", detailsDefaultOpen:false }, metadata:{ version:1, sections:[], sourceRunId:child!.id, recoveryResponsibility:"system" } });
    const result=await f.settle();
    expect(result.kind, "a progress note is not a final disposition").toBe("noticed");
  });
});
