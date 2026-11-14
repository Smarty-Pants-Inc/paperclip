// Independent judge checks. Isolated PostgreSQL; no production access or mocked decisions.
// Keep reasons: SMA-183 delayed follow-up, SMAA-1907 admission gap, durable notice/data safety.
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { isCurrentNotice } from "@paperclipai/shared";
import { heartbeatService } from "../heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";
const support = await getEmbeddedPostgresTestSupport();
// RFL VERDICT-bprime-np2-ddeb8e64 (10:22Z), F1/F2/F3, built on RFL's own fixture and cases from
// judge-bprime-m13.test.ts (sha256 in .local/rfl-bprime-np2/SHA256SUMS). Changed only where org 09:18Z
// (never delete; mark superseded) replaces the soft-delete expectation: F2's last assertion, and one added
// assertion in F3 (a later message's held note supersedes only earlier HELD notes, never progress).
describe.skipIf(!support.supported)("RFL bprime-np2 (10:22Z) F1/F2/F3: notice-state precedence and history (M1.4, Smarty fork, TEMPORARY)", () => {
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
    const current = async () => (await live()).filter(n => isCurrentNotice(n.metadata)); // RFL 11:43Z: the shared rule
    return { companyId, agentId, issueId, runId, userId, messageId: m!.id, holdId: hold!.id, now, at, settle, all, live, current };
  }
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
    const n=await f.current();
    expect(n.map(x=>x.body),"one CURRENT held note for the conversation after an in-place waiting-note upgrade").toHaveLength(1);
    expect(n[0]!.metadata?.authorizationReason).toBe("unanswered_message:"+second!.id);
    // org 09:18Z: the earlier held note is kept (never deleted) and marked superseded by the current one.
    const kept=(await f.all()).find(x=>x.id===first!.id)!;
    expect(kept.deletedAt).toBeNull();
    expect((kept.metadata as Record<string, unknown> | null)?.supersededBy).toBe(n[0]!.id);
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
    // A later message's held note supersedes only earlier HELD notes, never progress history.
    expect((kept.metadata as Record<string, unknown> | null)?.supersededBy, "progress is not an earlier held note").toBeUndefined();
  });
});
