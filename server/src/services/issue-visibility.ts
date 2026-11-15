import { nonIdleSlackIssueCondition } from "./slack-conversation-state.js";
import { and, isNull, isNotNull, or, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

export function visibleIssueCondition(): SQL {
  return and(isNull(issues.hiddenAt), isNull(issues.harnessKind))!;
}

/**
 * Task lists can opt in to hidden tasks (`includeHidden`) so a person can find
 * and un-hide them. Harness-owned tasks stay excluded either way.
 */
export function listVisibleIssueCondition(includeHidden = false): SQL {
  return includeHidden ? isNull(issues.harnessKind) : visibleIssueCondition();
}

export function visibleIssueSql(alias = "issues") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL`;
}

/** Work queues and execution totals omit persistent conversation containers. */
export function executionIssueCondition(): SQL {
  return and(visibleIssueCondition(), isNull(issues.conversationAgentId), nonIdleSlackIssueCondition())!;
}

export function attentionIssueCondition(includeConversations = false): SQL {
  return includeConversations
    ? or(executionIssueCondition(), and(visibleIssueCondition(), isNotNull(issues.conversationAgentId)))!
    : executionIssueCondition();
}
