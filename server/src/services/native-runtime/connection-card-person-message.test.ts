import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { issueService } from "../issues.js";
import { pendingGovernedWaitCondition } from "./native-session-executor.js";
import type { NativeExecutionInput } from "@paperclipai/paperclip-runner";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("a pending connection card and the person's next message", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const temp = await startEmbeddedPostgresTestDatabase("paperclip-conn-card-");
    cleanup = temp.cleanup;
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "paul", name: "Paul", email: "paul@example.test", createdAt: new Date(), updatedAt: new Date() });
  });
  afterAll(async () => { await db?.$client.end(); await cleanup?.(); });

  /** Run A raised the Connect GitHub card; returns what run B's wait check sees. */
  async function scenario(wake: "person_after" | "none" | "person_before") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runA = randomUUID(), runB = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Conn card", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "paul", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "general", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runA, companyId, agentId, status: "succeeded", responsibleUserId: "paul", contextSnapshot: { issueId } });
    const older = wake === "person_before" ? await issueService(db).addComment(issueId, "Hand this to the lead", { userId: "paul" }) : null;
    const card = await issueThreadInteractionService(db).createConnectionIntent({ id: issueId, companyId }, {
      payload: { version: 1, serviceSlug: "github", serviceName: "GitHub", serviceLogoUrl: null, requestingAgentId: agentId, requestingAgentName: "Chat", phase: "requested" },
      sourceRunId: runA, addresseeUserId: "paul", idempotencyKey: `connection-intent:${runA}:github`,
    });
    expect(card).toMatchObject({ kind: "connection_intent", status: "pending" });
    const newer = wake === "person_after" ? await issueService(db).addComment(issueId, "What is the status of r2?", { userId: "paul" }) : null;
    const wakeComment = newer ?? older;
    await db.insert(heartbeatRuns).values({ id: runB, companyId, agentId, status: "running", responsibleUserId: "paul",
      contextSnapshot: { issueId, ...(wakeComment ? { wakeCommentIds: [wakeComment.id], wakeCommentId: wakeComment.id } : { wakeReason: "issue_status_changed" }) } });
    const parks = async (runId: string) => (await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
      .where(pendingGovernedWaitCondition({ binding: { companyId, issueId, agentId, runId }, interactionResponses: [] } as unknown as NativeExecutionInput)))[0]?.id ?? null;
    return { cardId: card.id, runA: await parks(runA), runB: await parks(runB) };
  }

  it("R1 a message sent while a connection card is pending is answered by its run", async () => {
    expect((await scenario("person_after")).runB).toBeNull();
  });
  it("R2 the run that raised the card still parks", async () => {
    const result = await scenario("person_after");
    expect(result.runA).toBe(result.cardId);
  });
  it("R3 a later wake with no newer person message (status/automation) still parks", async () => {
    const result = await scenario("none");
    expect(result.runB).toBe(result.cardId);
  });
  it("R4 a person message older than the card still parks", async () => {
    const result = await scenario("person_before");
    expect(result.runB).toBe(result.cardId);
  });
});
