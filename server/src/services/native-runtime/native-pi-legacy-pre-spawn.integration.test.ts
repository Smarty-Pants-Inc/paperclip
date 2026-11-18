import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, authUsers, companies, completionContracts, createDb, environments, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints } from "@paperclipai/db";
import { canBypassFailedNativePredecessor, FAILED_PREDECESSOR_P1_ENABLED, type FailedNativePredecessorProbe } from "./native-provider-work-proof.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { selectPiConversation } from "./pi-conversation-record.js";
import { findNativeSessionResumeRun } from "./native-session-resume.js";
import { resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import fixture from "./native-pi-legacy-rows.test-fixture.json" with { type: "json" };

// Keep reason: recorded daily-work incident, plus an ownership/data-safety
// boundary. These are GET dump structures, not a claim of deployed recovery.
// The GET responses omit coordinator rows. Platform-lead's 12:20Z addendum
// supplies the exact finalizations: attempt 1, generation 1, terminal_failure,
// blocked, native_continuation_requires_reconciliation, no lease/results/checkpoints.
describe.skipIf(!recoveryPostgresSupport.supported)("legacy Pi setup failures that minted new normalized ids", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startRecoveryPostgres("pi-legacy-pre-spawn-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed(chat: "SMA-43" | "SMAA-143", coordinator: "not-supplied" | "pre-claim" | "claimed" = "not-supplied") {
    const names = chat === "SMA-43" ? ["60c4eb3b", "babee269"] as const : ["bb6091b6"] as const;
    // Pseudonyms differ per test; equality/inequality relationships are exact.
    const ids = new Map<string, string>();
    const rows = JSON.parse(JSON.stringify(names.map(name => fixture.rows[name])).replace(
      /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,
      value => { if (!ids.has(value)) ids.set(value, randomUUID()); return ids.get(value)!; },
    )) as Array<(typeof fixture.rows)["babee269"] & { runnerProfileJson: Record<string, unknown> }>;
    const last = rows.at(-1)!;
    const { companyId, agentId, nativeIssueId: issueId } = last;
    await db.insert(companies).values({ id: companyId, name: `Scrubbed ${chat}`, issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi legacy replay", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } });
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Scrubbed owner", email: `${userId}@example.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(issues).values({ id: issueId, companyId, title: "Scrubbed conversation", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active", conversationSessionGeneration: last.contextSnapshot.conversationSessionGeneration });
    for (const { events, ...row } of rows) {
      await db.insert(heartbeatRuns).values({ ...row, issueId,
        createdAt: new Date(row.createdAt), finishedAt: new Date(row.finishedAt),
        processStartedAt: row.processStartedAt ? new Date(row.processStartedAt) : null } as never);
      await db.insert(heartbeatRunEvents).values(events.map(event => ({ ...event, companyId, agentId, runId: row.id })) as never);
      if (row.status === "failed" && coordinator !== "not-supplied") {
        // Claimed is the platform-lead-confirmed production row; pre-claim
        // remains a separate legacy control.
        await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: row.id,
          ...fixture.confirmedFailedFinalization,
          ...(coordinator === "pre-claim" ? { attempt: 0, controllerGeneration: 0 } : {}) });
      }
    }
    await db.insert(agentTaskSessions).values({ companyId, agentId, taskKey: issueId, adapterType: "paperclip_runner", lastRunId: last.id,
      sessionParamsJson: { sessionId: last.nativeSessionId } });
    const [current] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, nativeIssueId: issueId, status: "running", runtimeMode: "native",
      contextSnapshot: { issueId, conversationSessionGeneration: last.contextSnapshot.conversationSessionGeneration } }).returning();
    const execution = last.runnerProfileJson.nativeExecutionInput as { workspace: { cwd: string }; binding: { executionWorkspaceId: string } };
    const input = { companyId, agentId, issueId, runId: current.id,
      boundary: { provider: "pi_rpc", cwd: execution.workspace.cwd, remoteCwd: "/workspace", workspaceId: execution.binding.executionWorkspaceId, trust: "scrubbed-trust" } };
    const notices = () => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    return { rows, current, input, notices };
  }

  it.each(["SMA-43", "SMAA-143"] as const)("REFUSE %s: supplied rows alone do not include affirmative coordinator proof", async chat => {
    const h = await seed(chat);
    await expect(selectPiConversation(db, h.input)).rejects.toThrow("pi_conversation_legacy_predecessor_unproven");
    // Refusal is atomic: no silent new identity or misleading recovery notice.
    expect(await h.notices()).toHaveLength(0);
    const [session] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, h.input.issueId));
    expect(session.sessionParamsJson?.sessionId).toBe(h.rows.at(-1)!.nativeSessionId);
  }, 60_000);

  it("PASS control SMA-43: with affirmative pre-claim proof, select the real last good conversation/checkpoint", async () => {
    const h = await seed("SMA-43", "pre-claim");
    const selectedConversation = await selectPiConversation(db, h.input);
    expect(selectedConversation.id).toBe(h.rows[0]!.nativeSessionId);
    expect(selectedConversation.id).not.toBe(h.rows[1]!.nativeSessionId);
    const selected = await findNativeSessionResumeRun(db, { ...h.input, normalizedSessionId: selectedConversation.id,
      currentRunId: h.current.id, beforeCreatedAt: h.current.createdAt });
    expect(selected?.id).toBe(h.rows[0]!.id);
    expect(selected?.runnerProfileJson.sessionCheckpoint).toEqual(h.rows[0]!.runnerProfileJson.sessionCheckpoint);
    expect(await h.notices()).toHaveLength(0); // ordinary ladder owns any later history-loss notice
  }, 60_000);

  it("PASS control SMAA-143: with affirmative pre-claim proof and no supplied checkpoint, admit fresh with one durable notice", async () => {
    const h = await seed("SMAA-143", "pre-claim");
    const conversation = await selectPiConversation(db, h.input);
    expect(conversation.id).not.toBe(h.rows[0]!.nativeSessionId);
    expect(await selectPiConversation(db, h.input)).toEqual(conversation);
    expect(await h.notices()).toHaveLength(1);
    expect((await h.notices())[0]!.body).toContain("earlier conversation could not be restored");
    expect(await findNativeSessionResumeRun(db, { ...h.input, normalizedSessionId: conversation.id,
      currentRunId: h.current.id, beforeCreatedAt: h.current.createdAt })).toBeNull();
  }, 60_000);

  // Keep reason: RFL F1, real persistence on the no-checkpoint daily-work
  // fixture. The warning is a transcript boundary, never transient run status.
  it("keeps the no-checkpoint legacy history-loss notice typed, unowned and deduped on concurrent replay", async () => {
    const h = await seed("SMAA-143", "claimed");
    const conversations = await Promise.all([selectPiConversation(db, h.input), selectPiConversation(db, h.input)]);
    expect(conversations[1]).toEqual(conversations[0]);
    expect(await selectPiConversation(db, h.input)).toEqual(conversations[0]);
    const notices = await h.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      authorType: "system", createdByRunId: null, conversationSessionGeneration: null,
      presentation: { kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: false },
      metadata: { version: 1, authorizationReason: expect.stringContaining("legacy_binding_unverified:"),
        sections: [{ rows: [{ type: "run_link", runId: h.current.id, agentId: h.input.agentId, title: "Fresh conversation" }] }] },
    });
    expect(notices[0]!.metadata?.authorizationReason).toContain(conversations[0]!.id);
    expect(notices[0]!.metadata?.authorizationReason).toContain(h.rows[0]!.nativeSessionId);
  }, 60_000);

  it.each(["conversation-generation", "issue-binding", "session-binding"] as const)("never crosses a legacy %s fence", async fence => {
    const h = await seed("SMA-43", "pre-claim");
    const source = h.rows[0]!;
    const profile = source.runnerProfileJson;
    const execution = profile.nativeExecutionInput as { binding: Record<string, unknown>; session: Record<string, unknown> };
    await db.update(heartbeatRuns).set(fence === "conversation-generation"
      ? { contextSnapshot: { ...source.contextSnapshot, conversationSessionGeneration: source.contextSnapshot.conversationSessionGeneration + 1 } }
      : { runnerProfileJson: { ...profile, nativeExecutionInput: { ...execution,
        ...(fence === "issue-binding" ? { binding: { ...execution.binding, issueId: randomUUID() } }
          : { session: { ...execution.session, normalizedSessionId: randomUUID() } }) } } })
      .where(eq(heartbeatRuns.id, source.id));
    await expect(selectPiConversation(db, h.input)).rejects.toThrow("pi_conversation_legacy_predecessor_unproven");
    expect(await h.notices()).toHaveLength(0);
  }, 60_000);

  it.each(["SMA-43", "SMAA-143"] as const)("REAL %s: bypasses the confirmed attempt-1 generation-1 pre-spawn failure", async chat => {
    const h = await seed(chat, "claimed");
    const conversation = await selectPiConversation(db, h.input);
    expect(await selectPiConversation(db, h.input)).toEqual(conversation);
    if (chat === "SMA-43") {
      // Do not change conversation C: its real earlier successful checkpoint
      // remains the source; the runtime's existing recovery ladder owns notice/re-read.
      expect(conversation.id).toBe(h.rows[0]!.nativeSessionId);
      const selected = await findNativeSessionResumeRun(db, { ...h.input, normalizedSessionId: conversation.id,
        currentRunId: h.current.id, beforeCreatedAt: h.current.createdAt });
      expect(selected?.id).toBe(h.rows[0]!.id);
      expect(await h.notices()).toHaveLength(0);
    } else {
      expect(conversation.id).not.toBe(h.rows[0]!.nativeSessionId);
      expect(await h.notices()).toHaveLength(1);
      expect((await h.notices())[0]!.body).toContain("earlier conversation could not be restored");
    }
  }, 60_000);

  it.each(["SMA-43", "SMAA-143"] as const)("P2 %s: exact confirmed real failed row passes the shared gate", async chat => {
    const h = await seed(chat, "claimed"), failed = h.rows.at(-1)!;
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, failed.id));
    expect(owner).toMatchObject(fixture.confirmedFailedFinalization);
    expect(failed).toMatchObject({ processPid: null, processGroupId: null, processStartedAt: null });
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, failed.id))).toHaveLength(0);
    expect(await db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, failed.id))).toHaveLength(0);
    expect(await canBypassFailedNativePredecessor(db, { companyId: failed.companyId, runId: failed.id })).toBe(true);
  }, 60_000);

  // Keep reason: RFL F2, contradictory persisted process identity must win
  // over absent start telemetry at the shared P2 proof boundary.
  it.each(["processPid", "processGroupId", "processStartedAt", "all"] as const)(
    "P2 holds a claimed terminal-complete predecessor with recorded %s and no start events", async field => {
      const h = await seed("SMAA-143", "claimed"), failed = h.rows.at(-1)!;
      const identity = { processPid: 42424, processGroupId: 42424, processStartedAt: new Date() };
      await db.update(heartbeatRuns).set(field === "all" ? identity : { [field]: identity[field] })
        .where(eq(heartbeatRuns.id, failed.id));
      expect(await canBypassFailedNativePredecessor(db, { companyId: failed.companyId, runId: failed.id })).toBe(false);
      const selected = await findNativeSessionResumeRun(db, { ...h.input, normalizedSessionId: failed.nativeSessionId,
        currentRunId: h.current.id, beforeCreatedAt: h.current.createdAt });
      expect(selected?.id).toBe(failed.id);
      await expect(selectPiConversation(db, h.input)).rejects.toThrow("pi_conversation_legacy_predecessor_unproven");
      expect(await h.notices()).toHaveLength(0);
    }, 60_000);

  it.each(["processPid", "processGroupId", "processStartedAt"] as const)(
    "P2 holds an earlier carried run with recorded %s across controller generations", async field => {
      const h = await seed("SMAA-143", "claimed"), failed = h.rows.at(-1)!;
      const identity = { processPid: 0, processGroupId: 0, processStartedAt: new Date(failed.createdAt) };
      await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: failed.companyId, agentId: failed.agentId,
        issueId: failed.nativeIssueId, nativeIssueId: failed.nativeIssueId, nativeSessionId: failed.nativeSessionId,
        runtimeMode: "native", status: "failed", createdAt: new Date(new Date(failed.createdAt).getTime() - 1000),
        [field]: identity[field] });
      expect(await canBypassFailedNativePredecessor(db, { companyId: failed.companyId, runId: failed.id })).toBe(false);
      const selected = await findNativeSessionResumeRun(db, { ...h.input, normalizedSessionId: failed.nativeSessionId,
        currentRunId: h.current.id, beforeCreatedAt: h.current.createdAt });
      expect(selected?.id).toBe(failed.id);
      await expect(selectPiConversation(db, h.input)).rejects.toThrow("pi_conversation_legacy_predecessor_unproven");
      expect(await h.notices()).toHaveLength(0);
    }, 60_000);

  it.each(["process-start", "source-event", "result", "checkpoint", "truncated-log"] as const)(
    "P2 keeps the real claimed row HELD with %s", async control => {
      const h = await seed("SMAA-143", "claimed"), failed = h.rows.at(-1)!;
      const { companyId, agentId, nativeIssueId: issueId } = failed;
      if (control === "process-start" || control === "source-event") await db.insert(heartbeatRunEvents).values({
        companyId, agentId, runId: failed.id, seq: 1000, stream: "system",
        eventType: control === "process-start" ? "native.process_start_requested" : "native.diagnostic",
        ...(control === "source-event" ? { sourceEventId: "old-runner:event:1", sourceInstanceId: "old-runner" } : {}),
      });
      if (control === "checkpoint") await db.insert(nativeRunnerCheckpoints).values({ companyId, issueId,
        runId: failed.id, part: "header", material: {} });
      if (control === "result") {
        const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
          schemaVersion: "fixture", policyVersion: "fixture", risk: "low", completionAuthority: "server",
          incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(),
          createdByActorType: "agent", createdByActorId: agentId }).returning();
        await db.update(heartbeatRuns).set({ completionContractId: contract.id }).where(eq(heartbeatRuns.id, failed.id));
        await db.insert(nativeRunResults).values({ companyId, issueId, runId: failed.id, completionContractId: contract.id,
          serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() });
      }
      if (control === "truncated-log") await db.delete(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, failed.id), eq(heartbeatRunEvents.message, "task.run.measured")));
      expect(await canBypassFailedNativePredecessor(db, { companyId, runId: failed.id })).toBe(false);
      await expect(selectPiConversation(db, h.input)).rejects.toThrow("pi_conversation_legacy_predecessor_unproven");
      expect(await h.notices()).toHaveLength(0); // no false fresh-session notice
    }, 60_000);

  it.each(["native.process_start_requested", "native.process_identity_recorded", "runner-sourced"] as const)(
    "P2 checks an earlier carried run across controller generations: %s", async eventType => {
      const h = await seed("SMAA-143", "claimed"), failed = h.rows.at(-1)!;
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ companyId: failed.companyId, agentId: failed.agentId, id: runId,
        issueId: failed.nativeIssueId, nativeIssueId: failed.nativeIssueId, nativeSessionId: failed.nativeSessionId,
        runtimeMode: "native", status: "failed", createdAt: new Date(new Date(failed.createdAt).getTime() - 1000) });
      await db.insert(nativeRunFinalizations).values({ companyId: failed.companyId, issueId: failed.nativeIssueId,
        runId, phase: "terminal_failure", attempt: 7, controllerGeneration: 9 });
      await db.insert(heartbeatRunEvents).values({ companyId: failed.companyId, agentId: failed.agentId, runId,
        seq: 1, stream: "system", eventType, ...(eventType === "runner-sourced" ? { sourceEventId: "earlier:event:1" } : {}) });
      expect(await canBypassFailedNativePredecessor(db, { companyId: failed.companyId, runId: failed.id })).toBe(false);
      await expect(selectPiConversation(db, h.input)).rejects.toThrow("pi_conversation_legacy_predecessor_unproven");
    }, 60_000);

  it.each([false, true])("P2 never loses start evidence to Postgres microsecond precision (earlier=%s)", async earlier => {
    const h = await seed("SMAA-143", "claimed"), failed = h.rows.at(-1)!;
    await db.update(heartbeatRuns).set({ createdAt: sql`'2026-11-12T22:53:26.000900Z'::timestamptz` })
      .where(eq(heartbeatRuns.id, failed.id));
    const runId = earlier ? randomUUID() : failed.id;
    if (earlier) await db.insert(heartbeatRuns).values({ id: runId, companyId: failed.companyId, agentId: failed.agentId,
      issueId: failed.nativeIssueId, nativeIssueId: failed.nativeIssueId, nativeSessionId: failed.nativeSessionId,
      status: "failed", runtimeMode: "native", createdAt: sql`'2026-11-12T22:53:26.000500Z'::timestamptz` });
    await db.insert(heartbeatRunEvents).values({ companyId: failed.companyId, agentId: failed.agentId, runId,
      seq: 1000, stream: "system", eventType: "native.process_start_requested" });
    expect(await canBypassFailedNativePredecessor(db, { companyId: failed.companyId, runId: failed.id })).toBe(false);
  }, 60_000);

  it.each(["unprobeable", "live", "lost", "rebooted", "foreign-marker"] as const)(
    "P1 (when enabled) probes ONLY the predecessor's box and is fail-closed; disabled = HELD: %s", async control => {
      const h = await seed("SMAA-143", "claimed"), failed = h.rows.at(-1)!;
      await db.insert(heartbeatRunEvents).values({ companyId: failed.companyId, agentId: failed.agentId, runId: failed.id,
        seq: 1000, eventType: "native.process_start_requested", stream: "system" });
      const environmentId = randomUUID(), leaseId = randomUUID();
      await db.insert(environments).values({ id: environmentId, name: `predecessor box ${environmentId}`, driver: "sandbox" });
      await db.insert(environmentLeases).values({ id: leaseId, companyId: failed.companyId, environmentId,
        issueId: failed.nativeIssueId, heartbeatRunId: failed.id, provider: "fixture", providerLeaseId: "predecessor-box",
        status: "released", releasedAt: new Date(), metadata: { remoteCwd: "/old-owner-workspace" } });
      const execute: FailedNativePredecessorProbe["execute"] = vi.fn(async request => {
        expect(request.lease.id).toBe(leaseId);
        expect(request.lease.providerLeaseId).toBe("predecessor-box");
        expect(request.lease.heartbeatRunId).toBe(failed.id);
        expect(request.environment.id).toBe(environmentId);
        expect(request.bypassSession).toBe(true);
        expect(request.args?.join(" ")).toContain("/old-owner-workspace/");
        if (control === "unprobeable") throw new Error("predecessor computer replaced and unreachable");
        if (request.args?.includes("paperclip-runner-generation-marker")) return { exitCode: 0, signal: null, timedOut: false,
          stdout: `nonce\n42424\n2026-11-13T10:00:00.000Z\n${control === "foreign-marker" ? randomUUID() : failed.runnerInstanceId}\nlinux:00000000-0000-4000-8000-000000000000:100\n`, stderr: "" };
        expect(request.args).toContain("paperclip-runner-generation-check");
        return { exitCode: control === "lost" ? 45 : control === "rebooted" ? 47 : 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      });
      const predecessorEnvironmentRuntime = { execute };
      const allowed = FAILED_PREDECESSOR_P1_ENABLED && (control === "lost" || control === "rebooted");
      expect(await canBypassFailedNativePredecessor(db, { companyId: failed.companyId, runId: failed.id, predecessorEnvironmentRuntime })).toBe(allowed);
      if (!FAILED_PREDECESSOR_P1_ENABLED) expect(execute).not.toHaveBeenCalled();
      const selected = await findNativeSessionResumeRun(db, { ...h.input, normalizedSessionId: failed.nativeSessionId,
        currentRunId: h.current.id, beforeCreatedAt: h.current.createdAt, predecessorEnvironmentRuntime });
      expect(selected?.id ?? null).toBe(allowed ? null : failed.id);
      // The executor re-selects during projection restore: preserve the SAME
      // predecessor-box probe there, not just during initial admission.
      await db.update(heartbeatRuns).set({ nativeSessionId: failed.nativeSessionId }).where(eq(heartbeatRuns.id, h.current.id));
      const recovery = await resolveNativeControllerRecovery(db, { ...h.input,
        normalizedSessionId: failed.nativeSessionId, currentRunId: h.current.id, predecessorEnvironmentRuntime });
      expect(recovery.kind).toBe(allowed ? "no_prior_execution" : "missing_evidence");
      if (allowed) {
        const conversation = await selectPiConversation(db, { ...h.input, predecessorEnvironmentRuntime });
        expect(await selectPiConversation(db, { ...h.input, predecessorEnvironmentRuntime })).toEqual(conversation);
        expect(await h.notices()).toHaveLength(1);
      } else await expect(selectPiConversation(db, { ...h.input, predecessorEnvironmentRuntime }))
        .rejects.toThrow("pi_conversation_legacy_predecessor_unproven");
    }, 60_000);
});
