import { randomUUID } from "node:crypto";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  completionContracts,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { noticeHeldUnfinishedPredecessor } from "../native-runtime/native-session-executor.js";
import { settleUnansweredPersonMessage, unansweredPersonMessageCommentCondition } from "./unanswered-person-message.js";

// C9 (Smarty fork): a person's message that nothing answers gets exactly ONE
// visible notice from the stranded sweep, in plain words, with the code in the
// metadata. Each case is a REAL shape: a refusal string from .local/SILENT-F.md
// or a production record shape named in the test title, on an agent with
// managed instructions. "Visible" is the v2 chat filter (TaskChatThread.tsx:930):
// a system comment is hidden only when recoveryResponsibility is "system".
const HELD = "Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.";
const NOT_ANSWERED = "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.";
const NO_RUN = "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
const NO_REPLY = "This run finished without a reply to your message. Sending it again is safe.";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("unanswered person message notice (C9, the stranded sweep)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("unanswered-person-message-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(input: { status?: string; chat?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `user-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Unanswered fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", adapterType: "paperclip_runner", status: "active",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    const chat = input.chat ?? true;
    await db.insert(issues).values({ id: issueId, companyId, title: chat ? "Chat with Managed Pi" : "A task", assigneeAgentId: agentId,
      status: input.status ?? (chat ? "in_progress" : "blocked"),
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: input.status === "in_review" ? "waiting" : "active" } : {}) });
    let clock = Date.now() - 900_000;
    const at = (stepMs = 1_000) => new Date(clock += stepMs);
    const message = async (body = "Please continue.", stepMs?: number) => {
      const [row] = await db.insert(issueComments).values({ companyId, issueId, body, authorType: "user", authorUserId: userId,
        createdAt: at(stepMs) }).returning();
      return row!.id;
    };
    const run = async (r: { commentId?: string | null; status: string; error?: string | null; errorCode?: string | null;
      retryOfRunId?: string; wakeReason?: string; finishedAgoMs?: number }) => {
      const contextSnapshot: Record<string, unknown> = { issueId, wakeReason: r.wakeReason ?? "issue_commented" };
      if (r.commentId) contextSnapshot.wakeCommentId = r.commentId;
      const created = at();
      const finishedAt = r.finishedAgoMs === undefined ? created : new Date(Date.now() - r.finishedAgoMs);
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: r.status, runtimeMode: "native",
        nativeIssueId: issueId, contextSnapshot, error: r.error ?? null, errorCode: r.errorCode ?? null,
        retryOfRunId: r.retryOfRunId ?? null, createdAt: created,
        finishedAt: ["running", "queued", "scheduled_retry"].includes(r.status) ? null : finishedAt }).returning();
      return row!.id;
    };
    const reply = async (runId: string) => {
      await db.insert(issueComments).values({ companyId, issueId, body: "Here is my answer.", authorType: "agent", authorAgentId: agentId,
        createdByRunId: runId, createdAt: at() });
    };
    const boardHold = async (cause: string, runId: string, kind = "active_run_watchdog") => {
      const [row] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind, status: "active",
        ownerType: "board", cause, fingerprint: `${kind}:${runId}`, evidence: { runId },
        nextAction: "Saved work recovered. Retry or send a message to continue." }).returning();
      return row!.id;
    };
    // The fixture runs on a clock in the past (so the settle grace has
    // elapsed); a notice the sweep writes now is re-stamped onto that clock so
    // later messages and answers come after it, as they do in production.
    const sweep = async () => {
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId });
      const fresh = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, issueId),
        eq(issueComments.authorType, "system"), gt(issueComments.createdAt, new Date(clock))));
      for (const row of fresh) await db.update(issueComments).set({ createdAt: at() }).where(eq(issueComments.id, row.id));
    };
    // What the v2 chat panel shows: system comments not classified "system".
    const visible = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(comment => (comment.metadata as Record<string, unknown> | null)?.recoveryResponsibility !== "system");
    return { companyId, agentId, issueId, userId, message, run, reply, boardHold, sweep, visible, at };
  }

  const codeOf = (comment: { metadata: unknown }) => {
    const sections = ((comment.metadata as Record<string, unknown>)?.sections ?? []) as Array<{ rows: Array<{ label?: string; value?: string }> }>;
    return sections.flatMap(section => section.rows).find(row => row.label === "Failure code")?.value;
  };

  it("J-F0 mixed stranded sweep must not throw or starve other conversations", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message("gate message"), status: "failed", errorCode: "runner_remote_state_unavailable" });
    const normalIds: string[] = [];
    for (let i=0;i<5;i++) {
      const issueId=randomUUID(), commentId=randomUUID(); normalIds.push(issueId);
      await db.insert(issues).values({ id:issueId, companyId:f.companyId, title:`ordinary ${i}`, status:"in_progress", assigneeAgentId:f.agentId,
        conversationAgentId:f.agentId, conversationUserId:`${f.userId}-${i}`, conversationState:"active" });
      await db.insert(issueComments).values({id:commentId,companyId:f.companyId,issueId,body:"Please answer",authorType:"user",authorUserId:f.userId,createdAt:new Date(Date.now()-900000)});
      await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,nativeIssueId:issueId,status:"failed",runtimeMode:"native",
        errorCode:"adapter_failed",contextSnapshot:{issueId,wakeReason:"issue_commented",wakeCommentId:commentId},createdAt:new Date(Date.now()-899000),finishedAt:new Date(Date.now()-898000)});
    }
    const errors:string[]=[];
    for(let pass=0;pass<3;pass++) {
      try { await heartbeatService(db).reconcileStrandedAssignedIssues({companyId:f.companyId}); }
      catch(error) { errors.push(String(error)); }
    }
    const before=await db.select().from(issueComments).where(and(eq(issueComments.companyId,f.companyId),eq(issueComments.authorType,"system")));
    for(const issueId of normalIds) await heartbeatService(db).reconcileStrandedAssignedIssues({companyId:f.companyId,issueId});
    const after=await db.select().from(issueComments).where(and(eq(issueComments.companyId,f.companyId),eq(issueComments.authorType,"system")));
    console.log("J-F0",JSON.stringify({errors,normalNoticesBefore:before.filter(c=>normalIds.includes(c.issueId)).length,normalNoticesAfter:after.filter(c=>normalIds.includes(c.issueId)).length}));
    expect(errors).toEqual([]);
    expect(before.filter(c=>normalIds.includes(c.issueId))).toHaveLength(5);
  });
});
