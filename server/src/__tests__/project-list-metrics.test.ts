import { describe, expect, it } from "vitest";
import { buildProjectListMetricMaps, deriveProjectStatus } from "../services/projects.ts";

describe("buildProjectListMetricMaps", () => {
  it("maps task counts by project, coercing string counts to numbers", () => {
    const { taskCountByProjectId } = buildProjectListMetricMaps(
      [
        { projectId: "p1", count: 24 },
        { projectId: "p2", count: 11 as unknown as number },
      ],
      [],
    );

    expect(taskCountByProjectId.get("p1")).toBe(24);
    expect(taskCountByProjectId.get("p2")).toBe(11);
  });

  it("maps open task counts by project, coercing string counts to numbers", () => {
    const { openTaskCountByProjectId } = buildProjectListMetricMaps(
      [
        { projectId: "p1", count: 24, openCount: 3 },
        { projectId: "p2", count: 11, openCount: "0" as unknown as number },
      ],
      [],
    );

    expect(openTaskCountByProjectId.get("p1")).toBe(3);
    expect(openTaskCountByProjectId.get("p2")).toBe(0);
  });

  it("ignores task-count rows with a null project id", () => {
    const { taskCountByProjectId } = buildProjectListMetricMaps(
      [{ projectId: null, count: 5 }],
      [],
    );

    expect(taskCountByProjectId.size).toBe(0);
  });

  it("maps positive budgets with their window kind", () => {
    const { budgetByProjectId } = buildProjectListMetricMaps(
      [],
      [
        { scopeId: "p1", amount: 120_000, windowKind: "calendar_month_utc" },
        { scopeId: "p2", amount: 50_000, windowKind: "lifetime" },
      ],
    );

    expect(budgetByProjectId.get("p1")).toEqual({ amountCents: 120_000, windowKind: "calendar_month_utc" });
    expect(budgetByProjectId.get("p2")).toEqual({ amountCents: 50_000, windowKind: "lifetime" });
  });

  it("omits zero/negative budgets so they do not surface as 'set'", () => {
    const { budgetByProjectId } = buildProjectListMetricMaps(
      [],
      [
        { scopeId: "p1", amount: 0, windowKind: "lifetime" },
        { scopeId: "p2", amount: -10, windowKind: "lifetime" },
      ],
    );

    expect(budgetByProjectId.size).toBe(0);
  });
});

// The project's pill follows its tasks; the stored projects.status is not read.
describe("deriveProjectStatus", () => {
  it("is Not started when the project has no tasks", () => {
    expect(deriveProjectStatus({ taskCount: 0, openTaskCount: 0, begunTaskCount: 0 })).toBe("not_started");
  });

  it("is In progress while a task is open and work has begun", () => {
    expect(deriveProjectStatus({ taskCount: 3, openTaskCount: 1, begunTaskCount: 1 })).toBe("in_progress");
  });

  it("is Not started while every open task is still waiting and none has begun", () => {
    expect(deriveProjectStatus({ taskCount: 2, openTaskCount: 2, begunTaskCount: 0 })).toBe("not_started");
  });

  it("is Done when the project has tasks and none is open", () => {
    expect(deriveProjectStatus({ taskCount: 4, openTaskCount: 0, begunTaskCount: 2 })).toBe("done");
    // Only cancelled or hidden tasks: nothing is left to do.
    expect(deriveProjectStatus({ taskCount: 1, openTaskCount: 0, begunTaskCount: 0 })).toBe("done");
  });

  it("maps a derived status per project from the aggregate row", () => {
    const { derivedStatusByProjectId } = buildProjectListMetricMaps(
      [
        { projectId: "busy", count: 3, openCount: 2, begunCount: 1 },
        { projectId: "waiting", count: 2, openCount: 2, begunCount: 0 },
        { projectId: "finished", count: 2, openCount: "0" as unknown as number, begunCount: 2 },
      ],
      [],
    );

    expect(derivedStatusByProjectId.get("busy")).toBe("in_progress");
    expect(derivedStatusByProjectId.get("waiting")).toBe("not_started");
    expect(derivedStatusByProjectId.get("finished")).toBe("done");
    expect(derivedStatusByProjectId.get("empty")).toBeUndefined();
  });
});
