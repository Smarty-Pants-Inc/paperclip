import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { resolveCrossIssueInfluenceLimit } from "../services/cross-issue-influence-limit.js";
import { resolveAgentTaskHierarchyDepth } from "../services/issue-hierarchy.js";
import { resolveMaxActiveChildIssues } from "../services/issues.js";
import { resolveMaxPlanDecompositionChildren } from "../services/plan-decomposition-limit.js";
import { resolveBoardChatMaxConcurrent } from "../routes/board-chat.js";
import { resolveStatusCardAgentMaxCards } from "../services/status-cards.js";
import { resolveFreshContinuationsPerChain } from "../services/fresh-continuation-fallback.js";

const knobs = [
  ["PAPERCLIP_CROSS_ISSUE_INFLUENCE_LIMIT", 20, resolveCrossIssueInfluenceLimit],
  ["PAPERCLIP_AGENT_TASK_HIERARCHY_DEPTH", 2, resolveAgentTaskHierarchyDepth],
  ["PAPERCLIP_MAX_ACTIVE_CHILD_ISSUES", 25, resolveMaxActiveChildIssues],
  ["PAPERCLIP_MAX_PLAN_DECOMPOSITION_CHILDREN", 25, resolveMaxPlanDecompositionChildren],
  ["PAPERCLIP_BOARD_CHAT_MAX_CONCURRENT", 3, resolveBoardChatMaxConcurrent],
  ["PAPERCLIP_STATUS_CARD_AGENT_MAX_CARDS", 20, resolveStatusCardAgentMaxCards],
  ["PAPERCLIP_FRESH_CONTINUATIONS_PER_CHAIN", 2, resolveFreshContinuationsPerChain],
] as const;

// Keep: operator configuration trust boundary; reproduces the CAPS-2 judge's
// real catch, where a typo silently restored the cap the operator raised.
describe.each(knobs)("%s configuration", (name, defaultValue, resolveLimit) => {
  beforeEach(() => {
    for (const [knob] of knobs) vi.stubEnv(knob, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the upstream default only when absent", () => {
    expect(() => loadConfig(null)).not.toThrow();
    expect(resolveLimit({})).toBe(defaultValue);
  });

  it("accepts a valid high value rather than restoring the old cap", () => {
    vi.stubEnv(name, " 1000 ");
    expect(() => loadConfig(null)).not.toThrow();
    expect(resolveLimit()).toBe(1000);
    expect(resolveLimit({ [name]: "0001000" })).toBe(1000);
    expect(resolveLimit({ [name]: String(Number.MAX_SAFE_INTEGER) })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["1O00", "-1", "not-a-number", "0", "1.5", "9007199254740992", "", " ", "1000junk", "1e3"])(
    "refuses startup for explicit malformed value %j, naming the exact knob",
    (raw) => {
      vi.stubEnv(name, raw);
      expect(() => loadConfig(null)).toThrow(`Invalid ${name}: expected a positive safe integer.`);
    },
  );

  it.each(["1O00", "-1", "not-a-number", "0", "1.5", "9007199254740992", "", " ", "1000junk", "1e3"])(
    "never silently falls back on a lazy read of malformed value %j",
    (raw) => {
      expect(() => resolveLimit({ [name]: raw })).toThrow(`Invalid ${name}: expected a positive safe integer.`);
    },
  );
});
