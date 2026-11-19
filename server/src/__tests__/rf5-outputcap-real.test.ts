import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, companyMemberships, completionContracts, createDb, heartbeatRuns, agentWakeupRequests, issueComments, issues, nativeRunFinalizations, statusDecisions, statusDecisionEffects } from "@paperclipai/db";
import { afterAll, describe, expect, it } from "vitest";
import { nativeRestartFixture } from "./helpers/native-restart-fixture.js";
import { rf5CompletingPeer } from "./helpers/rf5-completing-peer.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { buildNativeCompletionContract } from "../services/native-runtime/completion-contracts.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../vendor/paperclip-runner/testing.js";
import { answeredPersonMessageSql } from "../services/person-message-answer.js";
import { UNANSWERED_MESSAGE_SETTLE_MS } from "../services/recovery/unanswered-person-message.js";
import { readContinuationCommentInput } from "../services/continuation-comment-input.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// Scratch producer row, not a live-model qualification. The failed provider terminal enters through
// PaperclipControlPlanePort.completeRun, the product finalizer creates its decision/outbox, and
// heartbeatService.dispatchPendingNativeStatusWakeups creates/executes the successor. Only the external
// successor provider is replaced by the supplied rf5CompletingPeer; no hand-written successor context.
describe("RF5 output cap through real finalizer and native-status dispatcher", () => {
  const fixture = nativeRestartFixture({});
  afterAll(async () => { await closeIdleWarmNativeSessionsForRestart(); });
  it.each([false, true])("real output-cap successor partial=%s", async publishedPartial => {
    const { companyId, agentId, temporary } = fixture.current;
    const db = createDb(temporary.connectionString);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: rf5CompletingPeer(db) });
    try {
      const userId = randomUUID(), issueId = randomUUID(), root = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "RF5 operator", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
      await db.update(agents).set({ status: "idle", adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", lifecycleMode: "warm", idleTimeoutMs: 60000 }, runtimeConfig: {} }).where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
      const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Finish the report", status: "in_progress", workMode: "standard", assigneeAgentId: agentId, responsibleUserId: userId, createdByUserId: userId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" }).returning();
      const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId, body: "Finish the report; an output cap is not permission to duplicate it.", createdAt: new Date(Date.now() - 900000) }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ id: root, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, responsibleUserId: userId, invocationSource: "on_demand", triggerDetail: "manual", errorCode: "pi_output_truncated", error: "Pi's final assistant response reached its output limit.", contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: message.id }, createdAt: new Date(Date.now()-899000) }).returning();
      await db.update(issues).set({ executionRunId: root }).where(eq(issues.id, issueId));
      const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
      const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const, completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
      const execution = { schema: "paperclip.native-execution-input.v1", binding: { companyId, runId: root, issueId, agentId, executionWorkspaceId: root }, provider: { kind: "pi_rpc", model: "paperclip/faux" }, task: { identifier: issueId, title: issue.title, description: null, prompt: message.body, workMode: "standard" }, workspace: { cwd: process.env.TMPDIR!, repoUrl: null, repoRef: null, branchName: null }, session: { normalizedSessionId: native.normalizedSessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } }, completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput }, interactionResponses: [], credentialBindings: [] };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, root));
      const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId: root, agentId, sessionId: native.normalizedSessionId, sourceInstanceId: native.runnerInstanceId, controlPlaneSourceInstanceId: "rf5-outputcap-real", completionContractId: contract.id, completionContractSha256: contract.canonicalSha256 });
      await port.openRun({ identity: { companyId, issueId, runId: root, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await port.appendEvent({ schema: "paperclip.prp.event.v1", runId: root, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "rf5-cap-failed", sourceSeq: 1, sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload: { status: "failed", error: { code: "pi_output_truncated", message: "Pi's final assistant response reached its output limit.", recoverable: false } } });
      await port.completeRun({ result, terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" }, turnId: native.turnId });
      let partial: typeof issueComments.$inferSelect | undefined;
      if (publishedPartial) [partial] = await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId, createdByRunId: root, body: "The report, first part..." }).returning();
      await finalizeNativeRun({ db, runId: root, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, root));
      const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, root));
      console.log("RF5_REAL_ROOT", JSON.stringify({ publishedPartial, failed, decision, finalization: await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, root)) }));
      expect(failed.status).toBe("failed"); expect(failed.errorCode).toBe("pi_output_truncated");
      expect(decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
      const dispatch = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      await heartbeat.drainActiveRunExecutions();
      const successors = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).filter(r => r.id !== root && r.contextSnapshot?.issueId === issueId);
      console.log("RF5_REAL_DISPATCH", JSON.stringify({ publishedPartial, dispatch, successors }));
      expect(successors).toHaveLength(1);
      const successor = successors[0]!;
      expect(successor.status).toBe("succeeded");
      const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false }; next(); });
      app.use("/api", issueRoutes(db, {} as any, {})); app.use(errorHandler);
      const getComments = async () => { const response = await request(app).get(`/api/issues/${issueId}/comments`); expect(response.status, JSON.stringify(response.body)).toBe(200); return response.body as Array<Record<string, any>>; };
      const before = await getComments();
      const replies = before.filter(c => c.authorType === "agent" && c.createdByRunId === successor.id);
      expect(replies.length).toBeGreaterThan(0);
      // Honour the product's terminal settle grace in real elapsed time, not a hand-written terminal timestamp.
      const settleDelay = Math.max(0, failed.finishedAt!.getTime() + UNANSWERED_MESSAGE_SETTLE_MS + 250 - Date.now());
      await new Promise(resolve => setTimeout(resolve, settleDelay));
      const snapshots: unknown[] = [];
      for (let pass = 1; pass <= 2; pass++) { await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId }); snapshots.push(await getComments()); }
      const after = snapshots.at(-1) as Array<Record<string, any>>;
      const notices = after.filter(c => c.authorType === "system" && !c.deletedAt && c.metadata?.recoveryResponsibility !== "system" && c.metadata?.authorizationReason === `unanswered_message:${message.id}`);
      const [answer] = await db.select({ answered: answeredPersonMessageSql({ id: sql`${message.id}::uuid`, companyId: sql`${companyId}::uuid`, issueId: sql`${issueId}::uuid`, createdAt: sql`${message.createdAt.toISOString()}::timestamptz` }) }).from(issues).where(eq(issues.id, issueId));
      const context = successor.contextSnapshot as Record<string, any>;
      const observed = { publishedPartial, companyId, issueId, messageId: message.id, root, successorId: successor.id, successorStatus: successor.status, successorContext: context, successorInputCarriesM: context.wakeCommentId === message.id || (context.wakeCommentIds ?? []).includes(message.id), answeredM: answer.answered, notices: notices.map(c => ({ id: c.id, body: c.body })), noticeCount: notices.length, replies, rootCarry: await readContinuationCommentInput(db, { companyId, issueId, runId: root }), dispatch, snapshots, effects: await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision.id)), wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).filter(w => w.payload?.issueId === issueId) };
      writeFileSync(`${process.env.TASK_OUT}/outputcap-real-partial-${publishedPartial}.json`, JSON.stringify(observed, null, 2));
      console.log("RF5_OUTPUTCAP_REAL", JSON.stringify(observed));
      if (partial) { const [afterPartial] = await db.select().from(issueComments).where(eq(issueComments.id, partial.id)); expect(afterPartial).toEqual(partial); }
      expect(snapshots[1]).toEqual(snapshots[0]);
      // Person-visible acceptance, not weakened to the current behaviour: successful continuation must settle M.
      expect.soft(observed.successorInputCarriesM).toBe(true);
      expect.soft(observed.answeredM).toBe(true);
      expect(observed.noticeCount).toBe(0);
    } finally { await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end(); }
  }, 120000);
});
