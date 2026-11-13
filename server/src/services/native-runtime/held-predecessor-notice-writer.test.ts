import { randomUUID } from "node:crypto";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
  nativeRunResults } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { HELD_PREDECESSOR_NOTICE, noticeHeldUnfinishedPredecessor } from "./native-session-executor.js";
import { readUnsupersededHeldConversationNotice } from "./pi-session-recovery-notice.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("held predecessor notice writer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("held-predecessor-notice-writer-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each(["runner_state_identity_mismatch: legacy_prior_owner_terminal_state_indeterminate",
    "native_runner_warm_attachment_runner_exited: runner exited before authority rotation"])("holds visibly on %s", async message => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Held refusal", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Held agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held task", status: "in_progress", assigneeAgentId: agentId });
    for (const status of ["failed", "running"] as const) {
      await new Promise(resolve => setTimeout(resolve, 5));
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, runtimeMode: "native", nativeIssueId: issueId,
        nativeSessionId: sessionId }).returning();
      if (status === "running") await noticeHeldUnfinishedPredecessor({ db, execution: { provider: { kind: "pi_rpc" },
        binding: { companyId, agentId, issueId, runId: row!.id }, session: { normalizedSessionId: sessionId } } as never }, new Error(message));
    }
    const notices = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(comment => String((comment.metadata as Record<string, unknown> | null)?.authorizationReason ?? "")
        === `native_prior_owner_held:${sessionId}`);
    expect(notices).toHaveLength(1);
  });

  it("writes one notice per hold: none while it stands, one new notice after the same session continued", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID(), contractId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Held writer", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Held agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "45".repeat(32), createdByActorType: "system", createdByActorId: "fixture" });
    // Rows take the database clock in insertion order, like the notice itself.
    const run = async (status: "failed" | "running" | "succeeded", committed = false) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, runtimeMode: "native", nativeIssueId: issueId,
        nativeSessionId: sessionId, completionContractId: contractId }).returning();
      const [result] = committed ? await db.insert(nativeRunResults).values({ companyId, issueId, runId: row!.id,
        completionContractId: contractId, serverFingerprint: "fixture", schemaStatus: "accepted", resultJson: {},
        canonicalSha256: "fixture" }).returning() : [];
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: row!.id,
        phase: committed ? "committed" : "terminal_failure", resultId: result?.id ?? null });
      return row!.id;
    };
    // The executor's own refusal handling, for a message refused behind its unfinished predecessor.
    const refuse = (runId: string) => noticeHeldUnfinishedPredecessor({ db, execution: {
      provider: { kind: "pi_rpc" }, binding: { companyId, agentId, issueId, runId }, session: { normalizedSessionId: sessionId },
    } as never }, new Error("runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate"));
    const notices = async () => (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(comment => String((comment.metadata as Record<string, unknown> | null)?.authorizationReason ?? "")
        === `native_prior_owner_held:${sessionId}`);

    // Hold: the first refused message behind the failed predecessor posts the notice.
    await run("failed");
    const firstRefused = await run("running");
    await refuse(firstRefused);
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0]!.body).toBe(HELD_PREDECESSOR_NOTICE);
    // A second refusal while that notice stands adds none.
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, firstRefused));
    await refuse(await run("running"));
    expect(await notices()).toHaveLength(1);

    // The same session continues: a later run succeeds with a committed result.
    await run("succeeded", true);
    expect(await readUnsupersededHeldConversationNotice(db, { companyId, issueId })).toBeNull();

    // Held again: exactly ONE new notice, which stands again.
    await run("failed");
    const heldAgain = await run("running");
    await refuse(heldAgain);
    expect(await notices()).toHaveLength(2);
    expect(await readUnsupersededHeldConversationNotice(db, { companyId, issueId })).not.toBeNull();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, heldAgain));
    await refuse(await run("running"));
    expect(await notices()).toHaveLength(2);
  });
});
