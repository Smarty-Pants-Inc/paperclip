import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, authUsers, agentWakeupRequests, closeRegisteredClients, companies, createDb,
  heartbeatRuns, issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { prepareConversationTurn, undeliveredConversationComments } from "../services/agent-conversations.js";

// Recorded incident: SMA-43. Keep reason: a real board HTTP recovery can settle
// its action without actually admitting a successor. Exercise the DB boundary,
// not a mock wake count. Provider execution is deliberately closed: these tests
// prove durable run admission, NOT a Pi answer or recovery of an existing session.
describe("SMA-43 fresh persistent-chat restore twin", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let stopOwnedPostgres: (() => void) | undefined;
  const userId = `sma43-board-${randomUUID()}`;
  const support = getEmbeddedPostgresTestSupport();

  beforeAll(async () => {
    expect((await support).supported, "embedded Postgres is required, not an expected skip").toBe(true);
    // Never accept a shared/external database for this proof.
    expect(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL).toBeUndefined();
    temporary = await startEmbeddedPostgresTestDatabase("c9-restore-twin-");
    db = createDb(temporary.connectionString);
    // Retain the owned cluster's evidence instead of running cleanup's deletion.
    // This is the existing native-pi-rpc-lease-change-managed test's stop recipe.
    const port = new URL(temporary.connectionString).port;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== port) continue;
        const dataDir = args[args.indexOf("-D") + 1]!;
        stopOwnedPostgres = () => { execFileSync(args[0]!.replace(/postgres$/, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"]); };
        console.info("C9 owned Postgres evidence", { pid, dataDir, port });
        break;
      } catch { /* unrelated or already-exited process */ }
    }
    expect(stopOwnedPostgres, "must own a bounded, non-deleting cluster stop").toBeDefined();
    closeProcessRunAdmission();
    await db.insert(authUsers).values({ id: userId, name: "Twin board user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);

  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    if (temporary) await closeRegisteredClients(temporary.connectionString);
    stopOwnedPostgres?.();
    console.info("C9 owned Postgres stopped with pg_ctl -w; data retained");
    resetProcessRunAdmissionForTests();
  });

  function appForBoard() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }
  const runRows = (issueId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId));
  const wakeRows = (agentId: string) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  const issueRow = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);

  async function fixture() {
    // Company and ready-agent seed follow the existing route test helpers. A
    // provider/lifecycle bootstrap is not needed to test queue admission.
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SMA-43 fresh twin", issuePrefix: `C9${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Persistent chat twin", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    }).returning();
    const managed = await agentInstructionsService(db).materializeManagedBundle(agent!, { "AGENTS.md": "Reply to the person in this persistent conversation.\n" });
    await db.update(agents).set({ adapterConfig: managed.adapterConfig }).where(eq(agents.id, agentId));
    expect((await agentInstructionsService(db).readFile({ ...agent!, adapterConfig: managed.adapterConfig }, "AGENTS.md")).content).toContain("persistent conversation");

    const app = appForBoard();
    const opened = await request(app).post(`/api/companies/${companyId}/chats/${agentId}`).send({}).expect(200);
    const issueId = opened.body.id as string;
    expect(opened.body).toMatchObject({ assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting", status: "in_review" });
    const message = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Help me continue my ongoing work.", clientRequestId: randomUUID() }).expect(201);
    const admitted = (await runRows(issueId)).find(run => run.contextSnapshot?.wakeCommentId === message.body.id);
    expect(admitted, "first person message admitted a real run").toBeDefined();
    // Represent provider failure after preparing the real conversation turn.
    // No provider is invoked and no unknown live process is invented.
    await prepareConversationTurn(db, admitted!);
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: issueId,
      errorCode: "twin_failed_turn", error: "Injected terminal turn failure", finishedAt: new Date(), updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, admitted!.id));
    const failed = (await runRows(issueId)).find(run => run.id === admitted!.id)!;
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });
    const firstSweep = await recovery.reconcileStrandedAssignedIssues({ companyId, issueId });
    console.info("C9 native-failed-chat sweep", firstSweep);
    // Native terminal failure is not eligible for generic legacy retry.
    expect(firstSweep).toMatchObject({ escalated: 0, continuationRequeued: 0, assignmentDispatched: 0, skipped: 1 });
    expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, issueId)).toBeNull();

    // The generic sweep cannot retry this native failed run. Use its REAL
    // escalation writer, as the assignment permits, with the exact latest row.
    await recovery.escalateStrandedAssignedIssue({ issue: await issueRow(issueId), previousStatus: "in_progress", latestRun: failed });
    const action = await issueRecoveryActionService(db).getActiveForIssue(companyId, issueId);
    expect(action).toMatchObject({ kind: "stranded_assigned_issue", status: "active", ownerType: "board", ownerAgentId: null,
      previousOwnerAgentId: agentId, returnOwnerAgentId: agentId, cause: "stranded_assigned_issue", wakePolicy: { type: "board_escalation", preservesSourceAssignee: true } });
    expect(await issueRow(issueId)).toMatchObject({ status: "blocked", assigneeAgentId: agentId, conversationState: "active" });
    return { app, companyId, agentId, issueId, failed, action: action! };
  }

  it("Try again resolves the board action, queues a successor, and admits a NEW person message", async () => {
    const f = await fixture();
    const restored = await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.action.id, outcome: "restored", sourceIssueStatus: "todo" }).expect(200);
    expect(restored.body.recoveryAction).toMatchObject({ id: f.action.id, status: "resolved", outcome: "handed_back" });
    expect(restored.body.issue).toMatchObject({ status: "todo", assigneeAgentId: f.agentId, activeRecoveryAction: null });
    expect(await issueRecoveryActionService(db).getActiveForIssue(f.companyId, f.issueId)).toBeNull();
    const restoredWake = (await wakeRows(f.agentId)).find(wake => wake.reason === "issue_recovery_action_restored");
    expect(restoredWake, "must be a durable wake, not just an HTTP 200").toBeDefined();
    expect(restoredWake!.status).not.toBe("skipped");
    expect(restoredWake!.runId).toBeTruthy();
    expect((await runRows(f.issueId)).find(run => run.id === restoredWake!.runId)).toMatchObject({ status: "queued", agentId: f.agentId });
    const next = await request(f.app).post(`/api/issues/${f.issueId}/comments`)
      .send({ body: "This is a NEW request after restore, not a retry of my old message.", clientRequestId: randomUUID() }).expect(201);
    const pending = (await wakeRows(f.agentId)).find(wake => wake.idempotencyKey === `conversation-comment:${next.body.id}`);
    // Single-owner admission correctly holds this message behind the queued
    // restore attempt. Stop only that never-started, owned run through the real
    // control-plane stop, which promotes the saved person message.
    expect(pending).toMatchObject({ reason: "issue_execution_deferred", status: "deferred_issue_execution", runId: null,
      requestedByActorType: "user", requestedByActorId: userId });
    await heartbeatService(db).cancelRun(restoredWake!.runId!, "Twin releases its never-started restore attempt", { suppressImmediateRecovery: true });
    const nextWake = (await wakeRows(f.agentId)).find(wake => wake.id === pending!.id);
    expect(nextWake).toMatchObject({ requestedByActorType: "user", requestedByActorId: userId });
    expect(nextWake!.runId).toBeTruthy();
    expect(nextWake!.runId).not.toBe(f.failed.id);
    const fresh = (await runRows(f.issueId)).find(run => run.id === nextWake!.runId);
    expect(fresh).toMatchObject({ status: "queued", agentId: f.agentId, contextSnapshot: { wakeCommentId: next.body.id } });
    expect(await undeliveredConversationComments(db, f.companyId, f.issueId)).toHaveLength(0);
    console.info("C9 restored + NEW person run", { issueId: f.issueId, actionId: f.action.id, restoredWake: restoredWake!.status, newRunStatus: fresh!.status });
  });

  it("Send for review resolves the action WITHOUT reviving execution", async () => {
    const f = await fixture();
    const before = await runRows(f.issueId);
    const resolved = await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.action.id, outcome: "restored", sourceIssueStatus: "in_review" }).expect(200);
    expect(resolved.body.recoveryAction).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(await issueRow(f.issueId)).toMatchObject({ status: "in_review", assigneeAgentId: f.agentId });
    expect(await runRows(f.issueId)).toHaveLength(before.length);
    expect((await wakeRows(f.agentId)).filter(wake => wake.reason === "issue_recovery_action_restored")).toHaveLength(0);
  });

  it("Mark task done is refused for a persistent chat, preserving the active action", async () => {
    const f = await fixture();
    const refused = await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.action.id, outcome: "restored", sourceIssueStatus: "done" }).expect(422);
    expect(refused.body.error).toContain("Conversation identity is fixed");
    expect(await issueRecoveryActionService(db).getActiveForIssue(f.companyId, f.issueId)).toMatchObject({ id: f.action.id, status: "active" });
    expect(await issueRow(f.issueId)).toMatchObject({ status: "blocked", conversationState: "active" });
  });

  it("a resolved action is NOT proof of revival when the assignee is paused", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual"], pauseReason: "manual" }).where(eq(agents.id, f.agentId));
    const before = await runRows(f.issueId);
    const resolved = await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.action.id, outcome: "restored", sourceIssueStatus: "todo" }).expect(200);
    expect(resolved.body.recoveryAction).toMatchObject({ status: "resolved", outcome: "handed_back" });
    expect(await issueRow(f.issueId)).toMatchObject({ status: "todo", assigneeAgentId: f.agentId });
    expect(await runRows(f.issueId)).toHaveLength(before.length);
    await request(f.app).post(`/api/issues/${f.issueId}/comments`)
      .send({ body: "Saved while my agent is paused.", clientRequestId: randomUUID() }).expect(201);
    expect(await runRows(f.issueId)).toHaveLength(before.length);
    expect(await undeliveredConversationComments(db, f.companyId, f.issueId)).toHaveLength(1);
    expect((await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, f.action.id), eq(issueRecoveryActions.companyId, f.companyId))))[0]).toMatchObject({ status: "resolved" });
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).some(comment => comment.body === "Saved while my agent is paused.")).toBe(true);
  });
});
