import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb,
  inboxDismissals, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueService } from "../services/issues.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping attention comment reproduction: ${support.reason}`);

// Keep reason: recorded GAT-80 gate-6 catch, 2026-11-16. This pins existing
// behavior, not the desired behavior: human_only does not keep a question current.
(support.supported ? describe : describe.skip)("pending addressed question after an ordinary comment (GAT-80)", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("attention-comment-repro-");
    db = createDb(externalUrl ?? temporary!.connectionString);
  }, 30_000);
  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers);
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  it("a third party's comment removes the addressee's pending card from For you, but an agent's comment does not", async () => {
    // Each scenario has its own company and fresh issue so both controls are
    // exactly one, independent of what the preceding scenario left pending.
    for (const commenter of ["MEMBER", "AGENT"] as const) {
      const companyId = randomUUID(), agentId = randomUUID();
      const adminId = randomUUID(), memberId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: `Comment ${commenter}`, issuePrefix: commenter, requireBoardApprovalForNewAgents: false });
      for (const [id, membershipRole] of [[adminId, "admin"], [memberId, "member"]] as const) {
        await db.insert(authUsers).values({ id, name: membershipRole, email: `${id}@comment.example.test`, createdAt: new Date(), updatedAt: new Date() });
        await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole });
      }
      await db.insert(agents).values({ id: agentId, companyId, name: "Assigned worker", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
      const [issue] = await db.insert(issues).values({ companyId, title: `${commenter} ordinary comment`, status: "in_progress", assigneeAgentId: agentId, createdByUserId: adminId, originKind: "manual" }).returning();
      const card = await issueThreadInteractionService(db).create(issue!, {
        kind: "ask_user_questions", resolverPolicy: "human_only", addresseeUserId: adminId,
        payload: { version: 1, supersedeOnUserComment: false, questions: [{ id: "choice", prompt: "Which color?", selectionMode: "single", required: true, options: [{ id: "blue", label: "Blue" }, { id: "green", label: "Green" }] }] },
      }, { agentId });
      expect(card, "the control is an explicitly addressed, pending, human-only question").toMatchObject({ status: "pending", addresseeUserId: adminId, effectiveResolverPolicy: "human_only" });
      const actor = { type: "board" as const, source: "session" as const, userId: adminId, companyIds: [companyId], isInstanceAdmin: false };
      const attention = attentionService(db);
      const snapshot = async () => {
        const summary = await attention.summary(companyId, { userId: adminId, actor });
        const mine = await attention.list(companyId, { userId: adminId, actor, view: "mine" });
        const all = await attention.list(companyId, { userId: adminId, actor, view: "all" });
        expect(mine.viewCounts, "the list and summary use identical per-view counts").toEqual(summary.viewCounts);
        return { deskBadgeCount: summary.deskBadgeCount, viewCounts: summary.viewCounts, cardInMine: mine.items.some(item => item.subject.id === card.id), cardInAll: all.items.some(item => item.subject.id === card.id) };
      };
      const before = await snapshot();
      expect(before, `${commenter} control: the addressee has one For you card`).toEqual({ deskBadgeCount: 1, viewCounts: { mine: 1, unassigned: 0, company: 0, archived: 0, all: 1 }, cardInMine: true, cardInAll: true });

      // Real comment service, not a mocked attention source. A deterministic
      // strictly-later timestamp avoids depending on clock resolution or sleeps.
      await issueService(db).addComment(issue!.id, "Ordinary progress note; no answer to the question.", commenter === "MEMBER" ? { userId: memberId } : { agentId }, { createdAt: new Date(new Date(card.createdAt).getTime() + 1000) });
      const after = await snapshot();
      console.info(`GAT-80 ${JSON.stringify({ commenter, before, after })}`);
      const expectedCount = commenter === "MEMBER" ? 0 : 1;
      expect(after, commenter === "MEMBER"
        ? "a third party's comment removes the addressee's pending card from For you and Everyone"
        : "an assigned agent's comment keeps the addressee's pending card in For you and Everyone").toEqual({ deskBadgeCount: expectedCount, viewCounts: { mine: expectedCount, unassigned: 0, company: 0, archived: 0, all: expectedCount }, cardInMine: commenter === "AGENT", cardInAll: commenter === "AGENT" });
      const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(stored, "neither comment answers, expires, defers, transfers, or changes the resolver policy of the card").toMatchObject({ status: "pending", dismissedAt: null, resolvedAt: null, addresseeUserId: adminId, effectiveResolverPolicy: "human_only" });
      expect((await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]?.status, "neither comment changes issue status").toBe("in_progress");
      expect(await db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, companyId)), "no personal dismissal explains the disappearance").toEqual([]);
    }
  });
});
