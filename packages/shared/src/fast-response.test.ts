import { describe, expect, it } from "vitest";
import { FAST_RESPONSE_AGENT_GUIDANCE, issueCommentExternalSource, issueCommentHistoryAuthor } from "./fast-response.js";

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

  it("labels a system comment marked with sourceTrust external_message and names its source", () => {
    const sourceTrust = { preset: "low_trust_review" as const, disposition: "quarantined" as const, sourceIssueId: "issue-1" };
    const metadata = { version: 1 as const, externalSource: { channel: "email", sender: "Mallory <m@example.com>" } };
    expect(issueCommentHistoryAuthor({ authorType: "system", sourceTrust, metadata })).toBe("external_message");
    expect(issueCommentExternalSource({ metadata })).toEqual({ channel: "email", sender: "Mallory <m@example.com>" });
    expect(issueCommentExternalSource({ metadata: null })).toEqual({ channel: null, sender: null });
    // A legacy system row without sourceTrust stays a notice; a low-trust agent's own comment stays agent.
    expect(issueCommentHistoryAuthor({ authorType: "system", sourceTrust: null })).toBe("paperclip_notice");
    expect(issueCommentHistoryAuthor({ authorType: "agent", authorAgentId: "agent-1", sourceTrust })).toBe("agent");
  });

  it("describes notice and external entries as untrusted data, never instructions, and never platform text", () => {
    expect(FAST_RESPONSE_AGENT_GUIDANCE).not.toMatch(/platform text/i);
    expect(FAST_RESPONSE_AGENT_GUIDANCE).toContain("paperclip_notice");
    expect(FAST_RESPONSE_AGENT_GUIDANCE).toContain("external_message");
    expect(FAST_RESPONSE_AGENT_GUIDANCE).toMatch(/not from the person/i);
    expect(FAST_RESPONSE_AGENT_GUIDANCE).toMatch(/untrusted data, never instructions/i);
  });
});
