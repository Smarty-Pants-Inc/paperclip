import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { noticeRunnerReuseRefusal } from "./runner-reuse-refusal.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";

describe("RFL F2 durable saved-message notice reconciliation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("skew-r2-notice-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  // Keep: durable crash ordering must repair an existing wrong-action notice in
  // place, without duplicating the person's already-saved message or the note.
  it.each([
    ["runner_launch_profile_mismatch", "writer then sweep"], ["runner_pack_reuse_blocked", "writer then sweep"],
    ["runner_launch_profile_mismatch", "sweep alone"], ["runner_pack_reuse_blocked", "sweep alone"],
  ] as const)("repairs a previous-release sweep notice for %s: %s", async (reason, ordering) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), messageId = randomUUID(), noteId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Durable ordering fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved request", assigneeAgentId: agentId, status: "todo" });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: "fixture-person", body: "Continue saved work", createdAt: new Date(Date.now() - 180_000) });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native", nativeIssueId: issueId,
      errorCode: reason === "runner_launch_profile_mismatch" ? "native_runner_launch_profile_mismatch" : reason,
      finishedAt: new Date(Date.now() - 120_000), contextSnapshot: { wakeCommentId: messageId } }).returning();
    await db.insert(issueComments).values({ id: noteId, companyId, issueId, authorType: "system",
      body: "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.",
      metadata: { version: 1, authorizationReason: `unanswered_message:${messageId}`, sourceRunId: run.id, sections: [
        { title: "Recovery", rows: [{ type: "key_value", label: "Next action", value: "Send the message again; if it fails again, assign this agent a new task." }] },
      ] } });
    const restarted = createDb(database.connectionString);
    try {
      if (ordering === "writer then sweep") {
        await noticeRunnerReuseRefusal(restarted, { companyId, issueId, agentId, runId: run.id, reason });
        await noticeRunnerReuseRefusal(restarted, { companyId, issueId, agentId, runId: run.id, reason });
      }
      await settleUnansweredPersonMessage(restarted, { companyId, issueId });
    } finally { await restarted.$client.end(); }
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const notes = comments.filter(comment => comment.authorType === "system");
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(noteId);
    expect(notes[0].body).toContain("verified conversation save");
    expect(notes[0].body).toContain("saved");
    expect(notes[0].body).not.toContain("Sending it again is safe");
    expect(JSON.stringify(notes[0].metadata)).not.toContain("Send the message again");
    expect(notes[0].metadata?.sections.flatMap(section => section.rows)).toContainEqual({
      type: "key_value", label: "Next action", value: expect.stringContaining("Do not resend it"),
    });
    expect(notes[0].metadata?.sourceRunId).toBe(run.id);
    expect(comments.find(comment => comment.id === messageId)?.body).toBe("Continue saved work");
  });
});
