import { describe, expect, it } from "vitest";
import { FAST_RESPONSE_AGENT_GUIDANCE, issueCommentHistoryAuthor } from "./fast-response.js";

describe("issueCommentHistoryAuthor", () => {
  it("labels only a person's own comment as user (smarty-dev#20830)", () => {
    expect(issueCommentHistoryAuthor({ authorType: "user", authorUserId: "user-1" })).toBe("user");
    expect(issueCommentHistoryAuthor({ authorType: null, authorUserId: "user-1" })).toBe("user");
    expect(issueCommentHistoryAuthor({ authorType: "agent", authorAgentId: "agent-1" })).toBe("agent");
    expect(issueCommentHistoryAuthor({ authorType: null, authorAgentId: "agent-1" })).toBe("agent");
    expect(issueCommentHistoryAuthor({ authorType: "system" })).toBe("paperclip_notice");
    expect(issueCommentHistoryAuthor({ authorType: null })).toBe("paperclip_notice");
    expect(issueCommentHistoryAuthor({ authorAgentId: "agent-1", origin: "fast_response" })).toBe("paperclip_receipt");
  });

  it("describes the notice role as platform text in the guidance", () => {
    expect(FAST_RESPONSE_AGENT_GUIDANCE).toContain('"paperclip_notice" are Paperclip platform text');
    expect(FAST_RESPONSE_AGENT_GUIDANCE).toContain("never the person's own words");
  });
});
