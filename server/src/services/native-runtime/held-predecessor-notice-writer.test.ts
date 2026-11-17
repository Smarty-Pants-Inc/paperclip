import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { HELD_PREDECESSOR_NOTICE } from "./held-predecessor-notice-text.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";
import { readStandingRunNotice } from "../standing-run-notice.js";

// #21066, rf5 18:20Z: replaces the deleted executor writer's assertions with
// the sweep's real persisted notice. Same exact text/open/once-only assertions;
// classification and refusal safety stay in the executor and completion suites.
const support = await getEmbeddedPostgresTestSupport();
describe("held predecessor notice: sweep sole-owner replacement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    expect(support.supported, support.reason).toBe(true);
    database = await startEmbeddedPostgresTestDatabase("held-predecessor-sweep-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(error: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    const end = Date.now();
    await db.insert(companies).values({ id: companyId, name: "Held refusal", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Held agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held task", status: "in_progress", assigneeAgentId: agentId });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "person",
      body: "Continue the saved work.", createdAt: new Date(end - 3_000) }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: sessionId, errorCode: "adapter_failed", error,
      contextSnapshot: { issueId, commentId: message!.id }, createdAt: new Date(end - 2_000), finishedAt: new Date(end) }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: run!.id, phase: "terminal_failure",
      failureCode: "native_pre_dispatch_failure", resultId: null });
    const settle = () => settleUnansweredPersonMessage(db, { companyId, issueId, now: new Date(end + 2 * 60_000) });
    const visible = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));
    return { companyId, agentId, issueId, sessionId, message: message!, run: run!, end, settle, visible };
  }
  it.each([
    "runner_state_identity_mismatch: prior_owner_scope_mismatch",
    "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate",
    "runner_state_identity_mismatch: legacy_prior_owner_terminal_state_indeterminate",
    "native_session_cleanup_quarantined: prior session cleanup remains incomplete",
    "runner_process_termination_unconfirmed: replacement runner health could not be verified",
    "native_runner_warm_attachment_runner_exited: runner exited before authority rotation",
  ])("non-auto held refusal gets ONE open sweep notice: %s", async error => {
    const f = await fixture(error);
    expect(await f.visible()).toHaveLength(0);
    await f.settle(); await f.settle();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!).toMatchObject({ body: HELD_PREDECESSOR_NOTICE,
      presentation: { kind: "system_notice", detailsDefaultOpen: true },
      metadata: { authorizationReason: `unanswered_message:${f.message.id}`, sourceRunId: f.run.id } });
    expect(await readStandingRunNotice(db, f)).toMatchObject({ source: "unanswered", text: HELD_PREDECESSOR_NOTICE });
  });
  it("writes once per unanswered message, clears on its answer, and writes once for a later held message", async () => {
    const f = await fixture("runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate");
    await f.settle(); await f.settle();
    expect(await f.visible()).toHaveLength(1);
    const [answerRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId: f.sessionId,
      retryOfRunId: f.run.id, contextSnapshot: { issueId: f.issueId, commentId: f.message.id },
      createdAt: new Date(f.end + 1_000), finishedAt: new Date(f.end + 2_000) }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: answerRun!.id, body: "Continued the saved work.", createdAt: new Date(f.end + 3_000) });
    await f.settle();
    expect(await f.visible()).toHaveLength(0);
    expect(await readStandingRunNotice(db, f)).toBeNull();
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", body: "Continue the next part.", createdAt: new Date(f.end + 4_000) }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: f.issueId, nativeSessionId: f.sessionId, errorCode: "adapter_failed", error: f.run.error,
      contextSnapshot: { issueId: f.issueId, commentId: message!.id }, createdAt: new Date(f.end + 5_000),
      finishedAt: new Date(f.end + 6_000) });
    await f.settle(); await f.settle();
    expect(await f.visible()).toHaveLength(1);
    expect((await f.visible())[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${message!.id}`);
    expect((await f.visible())[0]!.body).toBe(HELD_PREDECESSOR_NOTICE);
  });
});
