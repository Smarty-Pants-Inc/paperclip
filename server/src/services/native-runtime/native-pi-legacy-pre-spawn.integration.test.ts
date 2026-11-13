import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentTaskSessions, authUsers, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { selectPiConversation } from "./pi-conversation-record.js";
import { findNativeSessionResumeRun } from "./native-session-resume.js";
import fixture from "./native-pi-legacy-rows.test-fixture.json" with { type: "json" };

// Keep reason: recorded daily-work incident, plus an ownership/data-safety
// boundary. These are GET dump structures, not a claim of deployed recovery.
// The GET responses did not contain coordinator rows. Never invent that proof
// in the real-row replay; a separate, explicitly labelled control supplies it.
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
        // SUPPLEMENTARY CONTROL ONLY. These values are deliberately not in the
        // fixture or attributed to the GET dump's production coordinator.
        await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: row.id,
          phase: "terminal_failure", attempt: coordinator === "pre-claim" ? 0 : 1,
          controllerGeneration: coordinator === "pre-claim" ? 0 : 1,
          failureCode: "native_continuation_requires_reconciliation" });
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

  it.each(["SMA-43", "SMAA-143"] as const)("keeps %s held if the supplementary coordinator was claimed", async chat => {
    const h = await seed(chat, "claimed");
    await expect(selectPiConversation(db, h.input)).rejects.toThrow("pi_conversation_legacy_predecessor_unproven");
  }, 60_000);
});
