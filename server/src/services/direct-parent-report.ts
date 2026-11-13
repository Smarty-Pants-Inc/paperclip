import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, projects } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

type DirectParentReportIssue = {
  companyId: string;
  projectId?: string | null;
  executionPolicy?: unknown;
  assigneeAgentId?: string | null;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
};

export async function directParentReportDisabledForIssue(
  db: Db,
  issue: DirectParentReportIssue,
): Promise<boolean> {
  const agent = issue.assigneeAgentId
    ? await db
        .select()
        .from(agents)
        .where(eq(agents.id, issue.assigneeAgentId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;

  if (agent?.companyId === issue.companyId) {
    const runId = issue.checkoutRunId ?? issue.executionRunId;
    const run = runId
      ? await db
          .select({
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            contextSnapshot: heartbeatRuns.contextSnapshot,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, runId),
              eq(heartbeatRuns.companyId, issue.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const runContext =
      run?.agentId === agent.id &&
      run.contextSnapshot &&
      typeof run.contextSnapshot === "object"
        ? (run.contextSnapshot as Record<string, unknown>)
        : null;
    const runExecutionPolicy =
      runContext?.executionPolicy &&
      typeof runContext.executionPolicy === "object"
        ? (runContext.executionPolicy as Record<string, unknown>)
        : null;
    const project = issue.projectId
      ? await db
          .select()
          .from(projects)
          .where(eq(projects.id, issue.projectId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    const resolution = resolveCoreTrustPreset({
      companyId: issue.companyId,
      agent,
      project: project?.companyId === issue.companyId ? project : null,
      issue: {
        companyId: issue.companyId,
        executionPolicy: issue.executionPolicy,
      },
      run: runExecutionPolicy
        ? { companyId: issue.companyId, executionPolicy: runExecutionPolicy }
        : null,
    });
    return resolution.kind !== "standard";
  }

  const project = issue.projectId
    ? await db
        .select()
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  return (
    resolveCoreTrustPreset({
      companyId: issue.companyId,
      project: project?.companyId === issue.companyId ? project : null,
      issue: {
        companyId: issue.companyId,
        executionPolicy: issue.executionPolicy,
      },
    }).kind !== "standard"
  );
}
