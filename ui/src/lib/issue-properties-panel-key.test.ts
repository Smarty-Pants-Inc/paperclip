import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { buildIssuePropertiesPanelKey } from "./issue-properties-panel-key";

function createIssue(overrides: Partial<Issue> = {}) {
  return {
    id: "issue-1",
    status: "in_progress" as const,
    priority: "medium" as const,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    projectId: "project-1",
    projectWorkspaceId: null,
    parentId: null,
    createdByUserId: "user-1",
    hiddenAt: null,
    labelIds: ["label-1"],
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    blocks: [],
    blockedBy: [],
    ancestors: [],
    updatedAt: new Date("2026-04-12T12:00:00.000Z"),
    ...overrides,
  };
}

describe("buildIssuePropertiesPanelKey", () => {
  it("ignores plain updatedAt churn", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ updatedAt: new Date("2026-04-12T12:05:00.000Z") }),
      [],
    );

    expect(second).toBe(first);
  });

  it("changes when a displayed property changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({ assigneeAgentId: "agent-2" }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when the same parent becomes private and readable again", () => {
    const parent: NonNullable<Issue["ancestors"]>[number] = {
      id: "parent-1",
      identifier: "PAP-2",
      title: "Readable parent",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      projectId: null,
      goalId: null,
      project: null,
      goal: null,
    };
    const readable = buildIssuePropertiesPanelKey(
      createIssue({ parentId: parent.id, ancestors: [parent] }),
      [],
    );
    const locked = buildIssuePropertiesPanelKey(
      createIssue({ parentId: parent.id, ancestors: [{ id: parent.id, identifier: null, locked: true }] }),
      [],
    );
    const restored = buildIssuePropertiesPanelKey(
      createIssue({ parentId: parent.id, ancestors: [parent] }),
      [],
    );
    const renamed = buildIssuePropertiesPanelKey(
      createIssue({ parentId: parent.id, ancestors: [{ ...parent, title: "Renamed parent" }] }),
      [],
    );

    expect(JSON.parse(readable).parentSummary).toEqual({
      id: parent.id,
      identifier: parent.identifier,
      title: parent.title,
    });
    expect(JSON.parse(locked).parentSummary).toEqual({ id: parent.id, identifier: null, locked: true });
    expect(locked).not.toBe(readable);
    expect(locked).not.toContain(parent.title);
    expect(locked).not.toContain(parent.identifier!);
    expect(restored).not.toBe(locked);
    expect(restored).toBe(readable);
    expect(renamed).not.toBe(restored);
  });

  it("changes when watchdog configuration changes", () => {
    const first = buildIssuePropertiesPanelKey(createIssue({ watchdog: null }), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({
        watchdog: {
          id: "watchdog-1",
          companyId: "company-1",
          issueId: "issue-1",
          watchdogAgentId: "agent-1",
          instructions: "Keep the tree moving.",
          status: "active",
          watchdogIssueId: null,
          lastObservedFingerprint: null,
          lastReviewedFingerprint: null,
          lastTriggeredAt: null,
          lastCompletedAt: null,
          triggerCount: 0,
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        },
      }),
      [],
    );

    expect(second).not.toBe(first);
  });

  it("changes when workspace detail hydrates after opening from a cached issue", () => {
    const first = buildIssuePropertiesPanelKey(createIssue(), []);
    const second = buildIssuePropertiesPanelKey(
      createIssue({
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
        currentExecutionWorkspace: {
          id: "workspace-1",
          companyId: "company-1",
          projectId: "project-1",
          projectWorkspaceId: "project-workspace-1",
          sourceIssueId: "issue-1",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "PAP-1 workspace",
          status: "active",
          deliveryState: "unknown",
          cwd: "/tmp/paperclip/PAP-1",
          repoUrl: null,
          baseRef: "master",
          branchName: "PAP-1-workspace",
          providerType: "git_worktree",
          providerRef: "/tmp/paperclip/PAP-1",
          derivedFromExecutionWorkspaceId: null,
          lastUsedAt: new Date("2026-04-12T12:01:00.000Z"),
          openedAt: new Date("2026-04-12T12:01:00.000Z"),
          closedAt: null,
          cleanupEligibleAt: null,
          cleanupReason: null,
          config: null,
          metadata: null,
          runtimeServices: [],
          createdAt: new Date("2026-04-12T12:01:00.000Z"),
          updatedAt: new Date("2026-04-12T12:01:00.000Z"),
        },
      }),
      [],
    );

    expect(second).not.toBe(first);
  });
});
