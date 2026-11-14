import { expect, it } from "vitest";
import { buildIssueChatMessages, type IssueChatComment } from "./issue-chat-messages";

// Recorded F1 wait -> proof transition. The old comment receives an atomic
// supersededByCommentId merge, but the person's chat must not stack both notes.
it("shows only the current F1 note after its predecessor is superseded", () => {
  const oldId = "11111111-1111-4111-8111-111111111111";
  const nextId = "22222222-2222-4222-8222-222222222222";
  const base = { companyId: "company", issueId: "issue", authorType: "system", authorAgentId: null, authorUserId: null,
    deletedAt: null, presentation: { kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: false } };
  const comments = [
    { ...base, id: oldId, createdAt: new Date("2026-11-14T18:25:18Z"), updatedAt: new Date("2026-11-14T18:40:38Z"),
      body: "I'm stopping the earlier attempt before starting fresh. Your message is saved; the fresh thread will read this conversation's history.",
      metadata: { version: 1, authorizationReason: "fresh_provider_thread_pending:session", sections: [], supersededByCommentId: nextId } },
    { ...base, id: nextId, createdAt: new Date("2026-11-14T18:40:38Z"), updatedAt: new Date("2026-11-14T18:40:38Z"),
      body: "The earlier provider thread could not be safely restored. Starting a fresh thread in this conversation from its saved history. Earlier actions with unknown outcomes are not confirmed or replayed.",
      metadata: { version: 1, authorizationReason: "fresh_provider_thread_pending:session", sections: [] } },
  ] as IssueChatComment[];
  const messages = buildIssueChatMessages({ comments, interactions: [], timelineEvents: [], linkedRuns: [], liveRuns: [] });
  console.log("F1-VISIBLE-NOTES", JSON.stringify(messages.map(m => ({ id: m.id, role: m.role, content: m.content }))));
  expect(messages.map(m => m.id)).toEqual([nextId]);
});
