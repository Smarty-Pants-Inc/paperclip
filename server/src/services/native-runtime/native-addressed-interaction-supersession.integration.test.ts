import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, createDb, heartbeatRuns,
  issueComments, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { isCurrentNotice, type IssueCommentMetadata } from "@paperclipai/shared";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";

// Keep reason: data safety at the real acceptance/transaction boundary. Historical
// W1 rows are seeded; provider-failure production belongs to the lifecycle suite.
const companyId = randomUUID();
const ownerAgentId = randomUUID();
const responderAgentId = randomUUID();
let home: ReturnType<typeof createIsolatedTestHome>;
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
type Comment = typeof issueComments.$inferSelect;

beforeAll(async () => {
  home = createIsolatedTestHome();
  vi.stubEnv("PAPERCLIP_HOME", home.home);
  temporary = await startEmbeddedPostgresTestDatabase("native-addressed-supersession-");
  db = createDb(temporary.connectionString, { maxConnections: 6 });
  await db.insert(companies).values({ id: companyId, name: "W1 history transaction", issuePrefix: "WHT" });
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: "KA", status: "active", adapterType: "paperclip_runner" },
    { id: responderAgentId, companyId, name: "KP", status: "active", adapterType: "paperclip_runner" },
  ]);
  await db.insert(companyMemberships).values([ownerAgentId, responderAgentId].map(principalId => ({
    companyId, principalType: "agent", principalId, membershipRole: "member", status: "active",
  })));
}, 120_000);

afterAll(async () => {
  try {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  } finally {
    vi.unstubAllEnvs();
    home?.cleanup();
  }
});

async function fixture(keyKind: "reason" | "legacy UUID") {
  const issueId = randomUUID();
  const ownerRunId = randomUUID();
  const cardId = randomUUID();
  const otherCardId = randomUUID();
  const failedRunIds = [randomUUID(), randomUUID()];
  const issue = { id: issueId, companyId, projectId: null, goalId: null, status: "in_review" };
  await db.insert(issues).values({
    id: issueId, companyId, title: "Review without losing W1 history", status: "in_review",
    reviewPolicy: "not_creator", workMode: "standard", assigneeAgentId: ownerAgentId,
    createdByAgentId: ownerAgentId,
  });
  await db.insert(heartbeatRuns).values({
    id: ownerRunId, companyId, agentId: ownerAgentId, status: "running", runtimeMode: "native",
    nativeIssueId: issueId, issueId, scopeKind: "issue", contextSnapshot: { issueId },
  });
  await db.update(issues).set({
    executionRunId: ownerRunId, checkoutRunId: ownerRunId,
    executionAgentNameKey: "ka", executionLockedAt: new Date(),
  }).where(eq(issues.id, issueId));
  await db.insert(issueThreadInteractions).values([cardId, otherCardId].map(id => ({
    id, companyId, issueId, kind: "request_confirmation", status: "pending",
    addresseeAgentId: responderAgentId, createdByAgentId: ownerAgentId, sourceRunId: ownerRunId,
    continuationPolicy: "none", requestedResolverPolicy: "not_creator" as const,
    effectiveResolverPolicy: "not_creator" as const, resolverPolicyProvenance: "explicit" as const,
    payload: { version: 1 as const, prompt: "Confirm the requested response." },
  })));
  await db.insert(heartbeatRuns).values(failedRunIds.map(id => ({
    id, companyId, agentId: responderAgentId, status: "failed", runtimeMode: "native",
    nativeIssueId: issueId, issueId, scopeKind: "issue" as const, nativePhase: "terminal_failure",
    errorCode: "native_addressed_interaction_failed",
    contextSnapshot: { issueId, taskId: issueId, interactionId: cardId, sourceRunId: ownerRunId },
  })));
  const key = (id: string, index = 0) => `native-addressed-failure:${id}:${keyKind === "reason"
    ? `reason:${index === 0 ? "provider_failure" : "agent_status:paused"}` : failedRunIds[index]}`;
  const metadata: IssueCommentMetadata = {
    version: 1, recoveryResponsibility: "user", sourceRunId: failedRunIds[0],
    sections: [{ title: "Card", rows: [{ type: "key_value", label: "Card", value: cardId }] }],
  };
  const oldCommentId = randomUUID();
  const historicalCardId = randomUUID();
  const seeded = await db.insert(issueComments).values([
    { clientRequestId: key(cardId), metadata },
    { clientRequestId: key(cardId, 1), metadata: { ...metadata, sourceRunId: failedRunIds[1] } },
    { clientRequestId: key(cardId) + ":history-comment", metadata: { ...metadata, supersededBy: oldCommentId } },
    { clientRequestId: key(cardId) + ":history-card", metadata: { ...metadata, supersededByInteractionId: historicalCardId } },
    { clientRequestId: key(otherCardId), metadata },
    { clientRequestId: `native-addressed-failure:${cardId}:reasonish:provider_failure`, metadata },
    { clientRequestId: `native-addressed-failure:${cardId}:${failedRunIds[0]}:trailing`, metadata },
    { clientRequestId: `native-addressed-failure:${cardId}0:reason:provider_failure`, metadata },
    { clientRequestId: key(cardId), metadata, authorType: "agent" as const, authorAgentId: responderAgentId },
  ].map(row => ({
    companyId, issueId, authorType: "system" as const, createdByRunId: failedRunIds[0],
    body: "Paperclip could not handle the addressed confirmation card; it remains pending.",
    presentation: { kind: "system_notice" as const, tone: "danger" as const, title: "Card response stopped", detailsDefaultOpen: false },
    createdAt: new Date("2025-01-01T00:00:00.000Z"), updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...row,
  }))).returning();
  // Both historical-marker rows must match the positive key grammar in BOTH
  // cases; otherwise a broken current-notice predicate could escape this test.
  await db.update(issueComments).set({ clientRequestId: keyKind === "reason"
    ? `native-addressed-failure:${cardId}:reason:audience`
    : `native-addressed-failure:${cardId}:${randomUUID()}` }).where(eq(issueComments.id, seeded[2].id));
  await db.update(issueComments).set({ clientRequestId: keyKind === "reason"
    ? `native-addressed-failure:${cardId}:reason:issue_read`
    : `native-addressed-failure:${cardId}:${randomUUID()}` }).where(eq(issueComments.id, seeded[3].id));
  const readComments = () => db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
  )).orderBy(issueComments.id);
  const readCard = () => db.select().from(issueThreadInteractions)
    .where(eq(issueThreadInteractions.id, cardId)).then(rows => rows[0]);
  const responseActor = async (interactionId: string) => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: responderAgentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, issueId, scopeKind: "issue", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId, taskId: issueId, interactionId, sourceRunId: ownerRunId,
        wakeReason: "interaction_pending", source: "issue.interaction.created" },
    });
    return { agentId: responderAgentId, runId };
  };
  return { issue, cardId, otherCardId, ownerRunId, readComments, readCard, responseActor,
    currentIds: seeded.slice(0, 2).map(row => row.id),
    historicalIds: seeded.slice(2, 4).map(row => row.id) };
}

describe("authorized acceptance supersedes only current same-card W1 history", () => {
  it.each(["reason", "legacy UUID"] as const)("%s keys: isolation, rollback, preservation and replay", async keyKind => {
    const f = await fixture(keyKind);
    const service = issueThreadInteractionService(db);
    const before = await f.readComments();
    const cardBefore = await f.readCard();
    expect(before).toHaveLength(9);
    for (const id of f.currentIds) expect(isCurrentNotice(before.find(row => row.id === id)!.metadata)).toBe(true);
    for (const id of f.historicalIds) expect(isCurrentNotice(before.find(row => row.id === id)!.metadata)).toBe(false);

    const otherActor = await f.responseActor(f.otherCardId);
    const otherAccepted = await service.acceptInteraction(f.issue, f.otherCardId, {}, otherActor);
    expect(otherAccepted.interaction.status).toBe("accepted");
    const afterOther = await f.readComments();
    const otherNote = before.find(row => row.clientRequestId?.startsWith(`native-addressed-failure:${f.otherCardId}:`))!;
    // The other card may legitimately mark its own note, never the original's.
    expect(afterOther.filter(row => row.id !== otherNote.id)).toEqual(before.filter(row => row.id !== otherNote.id));
    expect(await f.readCard()).toEqual(cardBefore);

    await expect(service.acceptInteraction(f.issue, f.cardId, {}, {
      agentId: ownerAgentId, runId: f.ownerRunId,
    })).rejects.toMatchObject({ status: 403, details: { code: "interaction_addressee_mismatch" } });
    expect(await f.readComments()).toEqual(afterOther);
    expect(await f.readCard()).toEqual(cardBefore);

    const actor = await f.responseActor(f.cardId);
    const rollbackError = new Error("counter-test abort after acceptance hook");
    let inTransactionComments: Comment[] | undefined;
    let inTransactionStatus: string | undefined;
    await expect(service.acceptInteraction(f.issue, f.cardId, {}, actor, {
      afterResolveInTransaction: async (tx, interaction) => {
        inTransactionStatus = interaction.status;
        inTransactionComments = await tx.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
        throw rollbackError;
      },
    })).rejects.toBe(rollbackError);
    expect(inTransactionStatus).toBe("accepted");
    expect(await f.readCard()).toEqual(cardBefore);
    expect(await f.readComments()).toEqual(afterOther);

    const accepted = await service.acceptInteraction(f.issue, f.cardId, {}, actor);
    expect(accepted.interaction).toMatchObject({ status: "accepted", resolvedByAgentId: responderAgentId, resolvedByRunId: actor.runId });
    const after = await f.readComments();
    expect(after).toHaveLength(before.length);
    for (const previous of afterOther) {
      const persisted = after.find(row => row.id === previous.id)!;
      if (!f.currentIds.includes(previous.id)) {
        expect(persisted).toEqual(previous);
      } else {
        // Only metadata's one history marker and updatedAt may change.
        const { metadata, updatedAt: _updatedAt, ...stable } = persisted;
        const { metadata: oldMetadata, updatedAt: _oldUpdatedAt, ...oldStable } = previous;
        expect(stable).toEqual(oldStable);
        const { supersededByInteractionId: _marker, ...preservedMetadata } = metadata!;
        expect(preservedMetadata).toEqual(oldMetadata);
      }
    }
    const acceptedCard = await f.readCard();
    await expect(service.acceptInteraction(f.issue, f.cardId, {}, actor)).rejects.toMatchObject({ status: 409 });
    expect(await f.readCard()).toEqual(acceptedCard);
    expect(await f.readComments()).toEqual(after);

    // Deliberately last: the no-fix base reaches every counter above and fails
    // only because real successful acceptance lacks the required history marker.
    for (const id of f.currentIds) {
      expect(after.find(row => row.id === id)!.metadata).toMatchObject({ supersededByInteractionId: f.cardId });
      expect(isCurrentNotice(after.find(row => row.id === id)!.metadata)).toBe(false);
      // Also prove the hook ran before the callback that forced rollback.
      expect(inTransactionComments!.find(row => row.id === id)!.metadata).toMatchObject({ supersededByInteractionId: f.cardId });
    }
  }, 60_000);
});
