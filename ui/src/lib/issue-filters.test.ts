// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ExternalObjectSummary, Issue } from "@paperclipai/shared";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  issueCreationRequestFilters,
  normalizeIssueFilterState,
  resolveAgentCreatedTasksDefault,
  resolveIssueFilterWorkspaceId,
  searchIssueFilterOptions,
  shouldIncludeIssueFilterWorkspaceOption,
} from "./issue-filters";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

function makeExternalObjectSummary(overrides: Partial<ExternalObjectSummary> = {}): ExternalObjectSummary {
  return {
    total: 1,
    byStatusCategory: {},
    byLiveness: { fresh: 1 },
    highestSeverity: "neutral",
    staleCount: 0,
    authRequiredCount: 0,
    unreachableCount: 0,
    objects: [],
    ...overrides,
  };
}

it("separates monitored waits from In Progress in task filters", () => {
  const monitored = makeIssue({ id: "waiting", status: "in_progress", displayStatus: "monitoring" });
  const working = makeIssue({ id: "working", status: "in_progress" });
  const rows = [monitored, working];
  expect(applyIssueFilters(rows, { ...defaultIssueFilterState, statuses: ["monitoring"] }).map(row => row.id)).toEqual(["waiting"]);
  expect(applyIssueFilters(rows, { ...defaultIssueFilterState, statuses: ["in_progress"] }).map(row => row.id)).toEqual(["working"]);
});

describe("issue filters", () => {
  it("hides automation by default while an opt-in includes every creation source", () => {
    const issues = [makeIssue({ id: "human", createdByUserId: "person" }), makeIssue({ id: "agent", createdByAgentId: "agent" }), makeIssue({ id: "routine", originKind: "routine_execution", createdByUserId: "person" }), makeIssue({ id: "system" })];
    expect(applyIssueFilters(issues, defaultIssueFilterState, null, true).map((issue) => issue.id)).toEqual(["human"]);
    expect(applyIssueFilters(issues, { ...defaultIssueFilterState, showAgentCreatedTasks: true }, null, true)).toEqual(issues);
    // Membership and task-detail collections can explicitly bypass creation visibility.
    expect(applyIssueFilters(issues, defaultIssueFilterState, null, false)).toEqual(issues);
    expect(countActiveIssueFilters(defaultIssueFilterState, true)).toBe(0);
    expect(countActiveIssueFilters({ ...defaultIssueFilterState, showAgentCreatedTasks: true }, true)).toBe(1);
  });

  it("selects only routine executions even when automatic tasks are hidden", () => {
    const routine = makeIssue({ id: "routine", originKind: "routine_execution", createdByUserId: "person" });
    const issues = [makeIssue({ id: "manual", createdByUserId: "person" }), routine,
      makeIssue({ id: "agent", createdByAgentId: "agent" }), makeIssue({ id: "channel", originKind: "chat_channel" })];
    const filters = { ...defaultIssueFilterState, routineTasksOnly: true };
    expect(applyIssueFilters(issues, filters, null, true)).toEqual([routine]);
    expect(applyIssueFilters(issues, { ...filters, statuses: ["done"] })).toEqual([]);
    expect(countActiveIssueFilters(filters, true)).toBe(1);
    expect(normalizeIssueFilterState({ routineTasksOnly: true }).routineTasksOnly).toBe(true);
    expect(normalizeIssueFilterState({ routineTasksOnly: "true" }).routineTasksOnly).toBe(false);
  });

  it("defaults legacy and invalid preferences to hidden without losing other filters", () => {
    expect(normalizeIssueFilterState({ hideRoutineExecutions: false, statuses: ["todo"] })).toMatchObject({ showAgentCreatedTasks: false, statuses: ["todo"] });
    expect(normalizeIssueFilterState({ showAgentCreatedTasks: "true" }).showAgentCreatedTasks).toBe(false);
    expect(normalizeIssueFilterState({ showAgentCreatedTasks: true }).showAgentCreatedTasks).toBe(true);
  });

  it("searches filter options case-insensitively without mutating the source", () => {
    const options = [{ name: "Alpha Agent" }, { name: "Release QA" }];
    expect(searchIssueFilterOptions(options, "  qa ", (option) => option.name)).toEqual([
      { name: "Release QA" },
    ]);
    expect(options).toHaveLength(2);
  });

  it("filters issues by creator across agents and users", () => {
    const issues = [
      makeIssue({ id: "agent-match", createdByAgentId: "agent-1" }),
      makeIssue({ id: "user-match", createdByUserId: "user-1" }),
      makeIssue({ id: "excluded", createdByAgentId: "agent-2", createdByUserId: "user-2" }),
    ];

    const filtered = applyIssueFilters(issues, {
      ...defaultIssueFilterState,
      creators: ["agent:agent-1", "user:user-1"],
    });

    expect(filtered.map((issue) => issue.id)).toEqual(["agent-match", "user-match"]);
  });

  it("counts creator filters as an active filter group", () => {
    expect(countActiveIssueFilters({
      ...defaultIssueFilterState,
      creators: ["user:user-1"],
    })).toBe(1);
  });

  it("filters issues to live issue ids when live-only is enabled", () => {
    const issues = [
      makeIssue({ id: "live-issue" }),
      makeIssue({ id: "idle-issue" }),
    ];

    const filtered = applyIssueFilters(
      issues,
      { ...defaultIssueFilterState, liveOnly: true },
      null,
      false,
      new Set(["live-issue"]),
    );

    expect(filtered.map((issue) => issue.id)).toEqual(["live-issue"]);
  });

  it("counts the live-only filter as an active filter group", () => {
    expect(countActiveIssueFilters({
      ...defaultIssueFilterState,
      liveOnly: true,
    })).toBe(1);
  });

  it("does not treat default project workspaces as workspace filter matches", () => {
    const issue = makeIssue({
      id: "default-workspace-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
    });
    const workspaceContext = {
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(issue, workspaceContext)).toBeNull();
    expect(applyIssueFilters(
      [issue],
      { ...defaultIssueFilterState, workspaces: ["workspace-default"] },
      null,
      false,
      undefined,
      workspaceContext,
    )).toEqual([]);
  });

  it("does not treat shared default execution workspaces as workspace filter matches", () => {
    const issue = makeIssue({
      id: "shared-default-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
      executionWorkspaceId: "execution-shared-default",
    });
    const workspaceContext = {
      executionWorkspaceById: new Map([[
        "execution-shared-default",
        { mode: "shared_workspace", projectWorkspaceId: "workspace-default" },
      ]]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(issue, workspaceContext)).toBeNull();
    expect(shouldIncludeIssueFilterWorkspaceOption(
      { id: "execution-shared-default", mode: "shared_workspace", projectWorkspaceId: "workspace-default" },
      new Set(["workspace-default"]),
    )).toBe(false);
  });

  it("keeps non-default project and isolated execution workspaces filterable", () => {
    const featureIssue = makeIssue({
      id: "feature-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-feature",
    });
    const executionIssue = makeIssue({
      id: "execution-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
      executionWorkspaceId: "execution-isolated",
    });
    const workspaceContext = {
      executionWorkspaceById: new Map([[
        "execution-isolated",
        { mode: "isolated_workspace", projectWorkspaceId: "workspace-default" },
      ]]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(featureIssue, workspaceContext)).toBe("workspace-feature");
    expect(resolveIssueFilterWorkspaceId(executionIssue, workspaceContext)).toBe("execution-isolated");
    expect(shouldIncludeIssueFilterWorkspaceOption({ id: "workspace-feature" }, new Set(["workspace-default"]))).toBe(true);
    expect(shouldIncludeIssueFilterWorkspaceOption(
      { id: "execution-isolated", mode: "isolated_workspace", projectWorkspaceId: "workspace-default" },
      new Set(["workspace-default"]),
    )).toBe(true);
  });

  it.each([
    ["failed", ["failed-issue", "blocked-issue"]],
    ["auth_required", ["auth-issue"]],
    ["stale", ["stale-issue"]],
    ["none", ["none-issue"]],
  ])("filters issues by external-object status token %s", (externalObjectStatus, expectedIssueIds) => {
    const issues = [
      makeIssue({ id: "failed-issue" }),
      makeIssue({ id: "blocked-issue" }),
      makeIssue({ id: "auth-issue" }),
      makeIssue({ id: "stale-issue" }),
      makeIssue({ id: "none-issue" }),
      makeIssue({ id: "fresh-issue" }),
    ];
    const summaries = new Map<string, ExternalObjectSummary>([
      ["failed-issue", makeExternalObjectSummary({ byStatusCategory: { failed: 1 }, highestSeverity: "danger" })],
      ["blocked-issue", makeExternalObjectSummary({ byStatusCategory: { blocked: 1 }, highestSeverity: "danger" })],
      ["auth-issue", makeExternalObjectSummary({
        byLiveness: { auth_required: 1 },
        highestSeverity: "danger",
        authRequiredCount: 1,
      })],
      ["stale-issue", makeExternalObjectSummary({
        byLiveness: { stale: 1 },
        highestSeverity: "warning",
        staleCount: 1,
      })],
      ["fresh-issue", makeExternalObjectSummary({ byStatusCategory: { succeeded: 1 }, highestSeverity: "success" })],
    ]);

    const filtered = applyIssueFilters(
      issues,
      { ...defaultIssueFilterState, externalObjectStatuses: [externalObjectStatus] },
      null,
      false,
      undefined,
      {
        externalObjectSummaryByIssueId: summaries,
        externalObjectSummariesReady: true,
      },
    );

    expect(filtered.map((issue) => issue.id)).toEqual(expectedIssueIds);
  });

  it("does not apply external-object filters before summaries are ready", () => {
    const filtered = applyIssueFilters(
      [makeIssue({ id: "issue-1" })],
      { ...defaultIssueFilterState, externalObjectStatuses: ["none"] },
      null,
      false,
      undefined,
      { externalObjectSummaryByIssueId: new Map(), externalObjectSummariesReady: false },
    );

    expect(filtered).toEqual([]);
  });

  describe("instance default for agent-created tasks", () => {
    // Stored filter shapes of the collections that offer the filter: the
    // Tasks and project lists (task-collection v1 envelopes) and the
    // inbox-style list (inbox issueFilters). None carries an explicit choice.
    const storedWithoutChoice = {
      tasks: { showAgentCreatedTasks: false, statuses: ["todo"], sortField: "created" },
      project: { showAgentCreatedTasks: false, priorities: ["high"] },
      inbox: { showAgentCreatedTasks: false, labels: ["label-1"], workspaces: [] },
    };

    it.each(Object.entries(storedWithoutChoice))("requests agent-created tasks for the %s list when the setting is on", (_name, stored) => {
      const state = resolveAgentCreatedTasksDefault(normalizeIssueFilterState(stored), true);
      expect(state.showAgentCreatedTasks).toBe(true);
      expect(issueCreationRequestFilters(state, true)).toMatchObject({ includeAgentCreatedTasks: true });
    });

    it.each(Object.entries(storedWithoutChoice))("keeps the upstream hidden default for the %s list when the setting is off", (_name, stored) => {
      const state = resolveAgentCreatedTasksDefault(normalizeIssueFilterState(stored), false);
      expect(issueCreationRequestFilters(state, true)).toMatchObject({ includeAgentCreatedTasks: false });
      // A v1 or legacy true without a recorded choice falls to the default too.
      const legacyTrue = resolveAgentCreatedTasksDefault(normalizeIssueFilterState({ ...stored, showAgentCreatedTasks: true }), false);
      expect(legacyTrue.showAgentCreatedTasks).toBe(false);
    });

    it("keeps other stored filters while resolving the default", () => {
      const state = resolveAgentCreatedTasksDefault(normalizeIssueFilterState(storedWithoutChoice.tasks), true);
      expect(state.statuses).toEqual(["todo"]);
    });

    it("lets an explicit choice win in both directions and survive a reload", () => {
      const hidden = normalizeIssueFilterState(JSON.parse(JSON.stringify({ ...defaultIssueFilterState, showAgentCreatedTasks: false, showAgentCreatedTasksExplicit: true })));
      expect(hidden.showAgentCreatedTasksExplicit).toBe(true);
      expect(resolveAgentCreatedTasksDefault(hidden, true).showAgentCreatedTasks).toBe(false);
      const shown = normalizeIssueFilterState({ showAgentCreatedTasks: true, showAgentCreatedTasksExplicit: true });
      expect(resolveAgentCreatedTasksDefault(shown, false).showAgentCreatedTasks).toBe(true);
    });

    it("clears filters back to the setting's default", () => {
      const explicit = { ...defaultIssueFilterState, statuses: ["done"], showAgentCreatedTasks: false, showAgentCreatedTasksExplicit: true };
      // Every list's Clear merges defaultIssueFilterState over its state.
      const cleared = { ...explicit, ...defaultIssueFilterState };
      expect(cleared.statuses).toEqual([]);
      expect(resolveAgentCreatedTasksDefault(cleared, true).showAgentCreatedTasks).toBe(true);
      expect(resolveAgentCreatedTasksDefault(cleared, false).showAgentCreatedTasks).toBe(false);
    });

    it("counts the filter as active only when it differs from the setting's default", () => {
      const onByDefault = resolveAgentCreatedTasksDefault(defaultIssueFilterState, true);
      expect(countActiveIssueFilters(onByDefault, true, true)).toBe(0);
      expect(countActiveIssueFilters({ ...onByDefault, showAgentCreatedTasks: false, showAgentCreatedTasksExplicit: true }, true, true)).toBe(1);
      expect(countActiveIssueFilters({ ...defaultIssueFilterState, showAgentCreatedTasks: true }, true)).toBe(1);
    });
  });
});
