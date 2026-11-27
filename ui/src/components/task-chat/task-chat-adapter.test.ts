import { describe, expect, it } from "vitest";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { ISSUE_COMMENT_PRESENTATION_KINDS, UNRECOVERED_FILES_NOTICE_KIND } from "@paperclipai/shared";
import { unrecoverableSavedFilesNotice } from "../../../../server/src/services/system-recovery-state";
import { isUnrecoveredFilesNotice } from "./adjacent-errors";
import {
  commentsToTaskChatItems,
  formatTaskChatTimestamp,
} from "./task-chat-adapter";

describe("commentsToTaskChatItems", () => {
  it("preserves distinct human IDs, photos and viewer ownership, including after a profile refresh", () => {
    const comments = ["alex", "sam"].map(authorUserId => ({
      id: `comment-${authorUserId}`, authorType: "user", authorUserId,
      authorAgentId: null, body: "A human message", createdAt: "2026-10-09T20:42:00Z",
    } as unknown as IssueChatComment));
    const userProfileMap = new Map([
      ["alex", { label: "Alex Morgan", image: "/alex.png" }],
      ["sam", { label: "Sam Rivera", image: "/sam.png" }],
    ]);
    expect(commentsToTaskChatItems(comments, { currentUserId: "alex", userProfileMap })).toMatchObject([
      { authorUserId: "alex", authorName: "Alex Morgan", authorAvatarUrl: "/alex.png", isCurrentUser: true },
      { authorUserId: "sam", authorName: "Sam Rivera", authorAvatarUrl: "/sam.png", isCurrentUser: false },
    ]);
    expect(commentsToTaskChatItems(comments, { currentUserId: "sam", userProfileMap })).toMatchObject([
      { authorUserId: "alex", isCurrentUser: false },
      { authorUserId: "sam", isCurrentUser: true },
    ]);
    expect(commentsToTaskChatItems(comments, { currentUserId: "alex" })).toMatchObject([
      { authorName: "You", isCurrentUser: true, authorAvatarUrl: null },
      { authorName: "User", isCurrentUser: false, authorAvatarUrl: null },
    ]);
    // Directory hydration changes presentation without changing canonical message IDs.
    expect(commentsToTaskChatItems(comments, { currentUserId: "alex", userProfileMap })[1]).toMatchObject({
      id: "comment-sam", authorName: "Sam Rivera", authorAvatarUrl: "/sam.png",
    });
  });

  it("does not infer ownership from matching names or an unresolved viewer", () => {
    const comment = { id: "other", authorType: "user", authorUserId: "other", body: "Hello" } as IssueChatComment;
    expect(commentsToTaskChatItems([comment], {
      currentUserId: "me", userLabelMap: new Map([["me", "Alex"], ["other", "Alex"]]),
    })[0]).toMatchObject({ authorName: "Alex", isCurrentUser: false });
    expect(commentsToTaskChatItems([comment])[0]).toMatchObject({ authorName: "User", isCurrentUser: false });
  });
  it("carries inbound channel attribution into the human bubble", () => {
    expect(commentsToTaskChatItems([{
      id: "photon-comment",
      body: "From my phone",
      authorType: "user",
      authorUserId: "local-board",
      metadata: { version: 1, sourceChannel: "imessage-photon", sections: [] },
      createdAt: "2026-09-12T12:00:00Z",
    } as unknown as IssueChatComment])).toMatchObject([{
      author: "human", sourceChannel: "imessage-photon", text: "From my phone",
    }]);
  });
  it("classifies a recovered local-board comment as an agent bubble", () => {
    const items = commentsToTaskChatItems([{
      id: "c-recovered",
      body: "Recovered agent reply.",
      authorType: "user",
      authorUserId: "local-board",
      authorAgentId: null,
      derivedAuthorAgentId: "agent-1",
      createdAt: "2026-08-07T09:00:00.000Z",
    } as unknown as IssueChatComment]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "message", author: "agent" });
  });

  it("never tags posted comments interstitial — the run's final reply keeps its bubble", () => {
    const comments = [
      {
        id: "c1",
        body: "Here is the finished work.",
        authorType: "agent",
        authorAgentId: "agent-1",
        runId: "run-1",
        createdAt: "2026-07-31T12:00:10.000Z",
      } as unknown as IssueChatComment,
    ];
    const items = commentsToTaskChatItems(comments);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe("message");
    if (item.kind !== "message") return;
    expect(item.author).toBe("agent");
    expect(item.interstitial).toBeUndefined();
  });

  it("classifies system comments as system even with a derivable run→agent linkage (PAP-443)", () => {
    const comments = [
      {
        id: "c-sys",
        body: "Paperclip automatically retried dispatch, but it still has no live execution path.",
        authorType: "system",
        authorAgentId: null,
        derivedAuthorAgentId: "agent-1",
        createdAt: "2026-08-07T09:00:00.000Z",
      } as unknown as IssueChatComment,
    ];
    const items = commentsToTaskChatItems(comments);
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item.kind !== "message") throw new Error("expected message item");
    expect(item.author).toBe("system");
  });

  it("attaches verification caveats using durable comment run provenance", () => {
    const verificationCaveats = [{
      commandOrCheck: "external-validator",
      reasonCode: "tool_unavailable",
      detail: "The optional validator is unavailable.",
    }];
    const comments = [{
      id: "c-final",
      body: "Implemented and locally verified.",
      authorType: "agent",
      authorAgentId: "agent-1",
      createdByRunId: "run-1",
      createdAt: "2026-08-22T09:00:00.000Z",
    } as unknown as IssueChatComment];

    const items = commentsToTaskChatItems(comments, {
      verificationCaveatsByRunId: new Map([["run-1", verificationCaveats]]),
    });

    expect(items).toEqual([expect.objectContaining({
      kind: "message",
      verificationCaveats,
    })]);
  });

  it("carries presentation, metadata, and the raw timestamp for system comments", () => {
    const presentation = {
      kind: "system_notice",
      tone: "warning",
      title: "Run recovery",
      detailsDefaultOpen: true,
    };
    const metadata = {
      version: 1,
      sections: [{ rows: [{ type: "text", label: "Reason", text: "quota" }] }],
    };
    const comments = [
      {
        id: "c-sys",
        body: "Recovery notice.",
        authorType: "system",
        presentation,
        metadata,
        runAgentId: "agent-1",
        createdAt: new Date("2026-08-07T09:00:00.000Z"),
      } as unknown as IssueChatComment,
      {
        id: "c-agent",
        body: "Agent reply.",
        authorType: "agent",
        authorAgentId: "agent-1",
        presentation: null,
        metadata,
        createdAt: "2026-08-07T09:01:00.000Z",
      } as unknown as IssueChatComment,
    ];
    const items = commentsToTaskChatItems(comments);
    const [sys, agent] = items;
    if (sys.kind !== "message" || agent.kind !== "message") throw new Error("expected messages");
    expect(sys.presentation).toEqual(presentation);
    expect(sys.metadata).toEqual(metadata);
    expect(sys.runAgentId).toBe("agent-1");
    expect(sys.createdAtIso).toBe("2026-08-07T09:00:00.000Z");
    // Non-system authors keep the item lean — no structured notice fields.
    expect(agent.presentation).toBeUndefined();
    expect(agent.metadata).toBeUndefined();
    expect(agent.runAgentId).toBeUndefined();
    // All durable messages retain their source time for the Coordinator
    // relative footer; the classic preformatted timestamp remains unchanged.
    expect(agent.createdAtIso).toBe("2026-08-07T09:01:00.000Z");
  });

  it("keeps the regular comment time for a causally repositioned steered follow-up", () => {
    const createdAt = "2026-09-04T14:09:33.000Z";
    const conversationAnchorAt = "2026-09-04T14:10:14.000Z";
    const [item] = commentsToTaskChatItems([
      {
        id: "c-steered",
        body: "Use three seconds instead.",
        authorType: "user",
        authorUserId: "user-1",
        authorAgentId: null,
        followUpRequested: true,
        consumedByRunId: "run-1",
        steeredIntoRunId: "run-1",
        conversationAnchorAt,
        createdAt,
      } as unknown as IssueChatComment,
    ]);

    expect(item).toMatchObject({
      kind: "message",
      timestamp: formatTaskChatTimestamp(createdAt),
    });
  });

  it("preserves human identity for steered and ordinary messages", () => {
    const comment = {
      id: "steered-by-colleague", body: "Check the latest result.",
      authorType: "user", authorUserId: "colleague", steeredIntoRunId: "run-1",
      createdAt: "2026-09-04T14:09:33.000Z",
    } as unknown as IssueChatComment;
    const ctx = {
      currentUserId: "viewer",
      userProfileMap: new Map([["colleague", { label: "Sam Rivera", image: "/api/assets/sam/content" }]]),
    };
    for (const steeredIntoRunId of ["run-1", null]) {
      expect(commentsToTaskChatItems([{ ...comment, steeredIntoRunId }], ctx)[0]).toMatchObject({
        authorName: "Sam Rivera", authorAvatarUrl: "/api/assets/sam/content", isCurrentUser: false,
      });
    }
    expect(commentsToTaskChatItems([{ ...comment, authorUserId: "viewer" }], ctx)[0]).toMatchObject({
      isCurrentUser: true,
    });
  });

  it("keeps the regular comment time for a successor-run follow-up", () => {
    const createdAt = "2026-09-04T14:09:33.000Z";
    const conversationAnchorAt = "2026-09-04T14:10:35.000Z";
    const [item] = commentsToTaskChatItems([
      {
        id: "c-delivered",
        body: "Use three seconds instead.",
      authorType: "user",
      authorUserId: "user-1",
      authorAgentId: null,
      followUpRequested: true,
      consumedByRunId: "run-2",
      conversationAnchorAt,
      createdAt,
      } as unknown as IssueChatComment,
    ]);

    expect(item).toMatchObject({
      kind: "message",
      timestamp: formatTaskChatTimestamp(createdAt),
    });
  });

  it("keeps an ordinary first message on the compact timestamp", () => {
    const createdAt = "2026-09-04T14:09:33.000Z";
    const [item] = commentsToTaskChatItems([
      {
        id: "c-initial",
        body: "Start the task.",
        authorType: "user",
        authorUserId: "user-1",
        authorAgentId: null,
        consumedByRunId: "run-1",
        conversationAnchorAt: "2026-09-04T14:10:35.000Z",
        createdAt,
      } as unknown as IssueChatComment,
    ]);

    expect(item).toMatchObject({
      kind: "message",
      timestamp: formatTaskChatTimestamp(createdAt),
    });
  });

  it("routes an agent-authored workspace-ready notice through the system renderer", () => {
    const presentation = {
      kind: "system_notice",
      tone: "info",
      title: "Workspace ready · fix/workspace-ready-notice",
      detailsDefaultOpen: false,
      density: "compact",
    } as const;
    const metadata = {
      version: 1,
      sections: [
        {
          title: "Workspace",
          rows: [
            { type: "key_value", label: "Strategy", value: "git_worktree" },
            {
              type: "key_value",
              label: "Branch",
              value: "fix/workspace-ready-notice",
            },
            { type: "key_value", label: "CWD", value: "/worktrees/workspace-ready-notice" },
          ],
        },
      ],
    } as const;
    const items = commentsToTaskChatItems([
      {
        id: "workspace-ready",
        body: "## Workspace Ready\n\n- Strategy: `git_worktree`",
        authorType: "agent",
        authorAgentId: "agent-1",
        createdByRunId: "run-1",
        presentation,
        metadata,
        createdAt: "2026-09-02T12:59:03.318Z",
      } as unknown as IssueChatComment,
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "workspace-ready",
      kind: "message",
      author: "system",
      presentation,
      metadata,
      runAgentId: null,
      createdAtIso: "2026-09-02T12:59:03.318Z",
    });
    expect(items[0]).toHaveProperty("authorName", undefined);
    expect(items[0]).toHaveProperty("agentIcon", undefined);
  });

  it("qualifies only the fresh-session marker in the unrecovered-files interval, independent of input order", () => {
    const marker = (id: string, at: string) => ({ id, authorType: "system", body: "New session · Earlier messages and files are still available.",
      conversationSessionGeneration: 0, metadata: { version: 1, sourceRunId: id, sections: [] }, createdAt: at,
      updatedAt: id === "fresh-workspace" ? "2026-11-27T11:44:27Z" : at });
    const lost = { id: "lost", authorType: "system", body: "Paperclip could not recover the unsaved files from the previous run: the saved files are unavailable.",
      createdAt: "2026-11-27T11:44:26Z" };
    const items = commentsToTaskChatItems([
      marker("later-session", "2026-11-27T12:00:00Z"), lost,
      marker("fresh-workspace", "2026-11-27T11:44:00Z"),
    ] as unknown as IssueChatComment[]);
    expect(items.find(item => item.id === "fresh-workspace")).toMatchObject({ kind: "marker",
      detail: "Earlier messages are kept. Files the stopped run did not save or push were not brought into this workspace." });
    expect(items.find(item => item.id === "later-session")).toMatchObject({ kind: "marker", detail: "Earlier messages and files are still available." });
    const ordinary = commentsToTaskChatItems([marker("ordinary", "2026-11-27T11:44:00Z")] as unknown as IssueChatComment[]);
    expect(ordinary[0]).toMatchObject({ detail: "Earlier messages and files are still available." });
    const deleted = commentsToTaskChatItems([marker("ordinary", "2026-11-27T11:44:00Z"), { ...lost, deletedAt: lost.createdAt }] as unknown as IssueChatComment[]);
    expect(deleted[0]).toMatchObject({ detail: "Earlier messages and files are still available." });
  });

  it.each(["allocation_ownership_ambiguous", "source_unavailable", "historical_source_missing"] as const)(
    "recognises the real server's %s receipt, not a copied test sentence", code => {
      const body = unrecoverableSavedFilesNotice({ code, retryClass: "service_required", evidenceFingerprint: "receipt" });
      const [item] = commentsToTaskChatItems([{ id: "lost", authorType: "system", body,
        createdAt: "2026-11-27T11:44:26Z" }] as unknown as IssueChatComment[]);
      expect(item.kind).toBe("message");
      if (item.kind !== "message") throw new Error("Expected the recovery receipt");
      expect(isUnrecoveredFilesNotice(item)).toBe(true);
    });

  it("prefers a semantic kind over wording while retaining the legacy system-notice envelope", () => {
    const text = unrecoverableSavedFilesNotice({ code: "source_unavailable", retryClass: "service_required", evidenceFingerprint: "receipt" });
    expect(isUnrecoveredFilesNotice({ author: "system", text: "New server wording", presentation: { kind: UNRECOVERED_FILES_NOTICE_KIND } })).toBe(true);
    for (const kind of ISSUE_COMMENT_PRESENTATION_KINDS.filter(kind => kind !== "system_notice")) {
      expect(isUnrecoveredFilesNotice({ author: "system", text, presentation: { kind } })).toBe(false);
    }
    for (const kind of [null, "system_notice", "files_unrecovered", "recovery_notice", "other_recovery_outcome"]) {
      expect(isUnrecoveredFilesNotice({ author: "system", text, presentation: { kind } })).toBe(true);
      expect(isUnrecoveredFilesNotice({ author: "system", text: "Workspace ready.", presentation: { kind } })).toBe(false);
    }
    for (const author of ["human", "agent"] as const) {
      expect(isUnrecoveredFilesNotice({ author, text, presentation: { kind: UNRECOVERED_FILES_NOTICE_KIND } })).toBe(false);
    }
    expect(isUnrecoveredFilesNotice({ author: "system", text: `Someone quoted: ${text}` })).toBe(false);
  });

  it.each([false, true])("assigns a receipt to the following session, never the previous one (backdated=%s)", backdated => {
    const marker = (id: string, createdAt: string, updatedAt = createdAt) => ({ id, authorType: "system",
      body: "New session · Earlier messages and files are still available.", conversationSessionGeneration: 0,
      metadata: { version: 1, sourceRunId: id, sections: [] }, createdAt, updatedAt });
    const previous = marker("previous", "2026-11-27T11:00:00Z");
    const fresh = marker("fresh", backdated ? "2026-11-27T11:44:00Z" : "2026-11-27T11:44:30Z", "2026-11-27T11:44:31Z");
    const later = marker("later", "2026-11-27T12:00:00Z");
    const lost = { id: "lost", authorType: "system", createdAt: "2026-11-27T11:44:26Z",
      body: unrecoverableSavedFilesNotice({ code: "source_unavailable", retryClass: "service_required", evidenceFingerprint: "receipt" }) };
    for (const comments of [[later, lost, previous, fresh], [previous, fresh, lost, later]]) {
      const items = commentsToTaskChatItems(comments as unknown as IssueChatComment[]);
      expect(items.find(item => item.id === "fresh")).toMatchObject({ kind: "marker",
        detail: "Earlier messages are kept. Files the stopped run did not save or push were not brought into this workspace." });
      for (const id of ["previous", "later"]) expect(items.find(item => item.id === id)).toMatchObject({
        detail: "Earlier messages and files are still available." });
    }
    // A not-yet-published marker must not transfer the warning backwards.
    expect(commentsToTaskChatItems([previous, lost] as unknown as IssueChatComment[])[0]).toMatchObject({
      detail: "Earlier messages and files are still available." });
  });

  it("does not qualify an unrelated session hours after recovery failed to start", () => {
    const lost = { id: "lost", authorType: "system", createdAt: "2026-11-27T11:00:00Z",
      body: unrecoverableSavedFilesNotice({ code: "source_unavailable", retryClass: "service_required", evidenceFingerprint: "receipt" }) };
    const later = { id: "unrelated", authorType: "system", createdAt: "2026-11-27T14:00:00Z",
      body: "New session · Earlier messages and files are still available.", conversationSessionGeneration: 1 };
    const items = commentsToTaskChatItems([lost, later] as unknown as IssueChatComment[]);
    expect(items.find(item => item.id === "unrelated")).toMatchObject({
      detail: "Earlier messages and files are still available." });
  });

  it("keeps an agent comment with message presentation as an agent bubble", () => {
    const [item] = commentsToTaskChatItems([
      {
        id: "agent-message",
        body: "Implementation is complete.",
        authorType: "agent",
        authorAgentId: "agent-1",
        presentation: { kind: "message" },
        metadata: { version: 1, sections: [] },
        createdAt: "2026-09-02T13:00:00.000Z",
      } as unknown as IssueChatComment,
    ]);

    expect(item).toMatchObject({ kind: "message", author: "agent" });
    if (item.kind !== "message") throw new Error("expected message item");
    expect(item.presentation).toBeUndefined();
    expect(item.metadata).toBeUndefined();
  });
});
