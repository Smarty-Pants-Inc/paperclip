import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues, projects, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import type { DbTransaction } from "./tool-access/types.js";
import { boundRunIssueId, assertBoundRunIssueId } from "./run-task-binding.js";
import { lockProjectConnectionLifecycle } from "./project-connection-retirement.js";
import { readProjectConnectionScope } from "./project-connection-admission.js";

/** Server-owned admission snapshot; a wake/workspace/session project is never authority. */
export type ProjectConnectionRunContext = Readonly<{
  companyId: string;
  agentId: string;
  heartbeatRunId: string | null;
  issueId: string | null;
  projectId: string | null;
}>;

const SNAPSHOT_KEY = "projectConnectionRunContext";
const invalid = () => forbidden("Project connection run/task binding changed or is invalid; restart this run", {
  code: "project_connection_run_context_invalid",
});
type Executor = Db | DbTransaction;
type CaptureInput = Readonly<{ companyId: string; agentId: string; heartbeatRunId?: string | null; issueId?: string | null }>;

function savedBinding(value: unknown): { issueId: string | null; projectId: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !Object.hasOwn(v, "issueId") || !Object.hasOwn(v, "projectId")
    || [v.issueId, v.projectId].some(id => id !== null && (typeof id !== "string" || !isUuidLike(id)))
    || (v.issueId === null && v.projectId !== null)) throw invalid();
  return { issueId: v.issueId as string | null, projectId: v.projectId as string | null };
}

async function taskProject(db: Executor, companyId: string, issueId: string | null, lock = false) {
  if (!issueId) return null;
  if (!isUuidLike(issueId)) throw invalid();
  const query = db.select({ id: issues.id, projectId: issues.projectId }).from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  const [issue] = await (lock ? query.for("no key update") : query);
  if (!issue) throw invalid();
  if (issue.projectId) {
    const [project] = await db.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, issue.projectId), eq(projects.companyId, companyId),
    ));
    if (!project) throw invalid();
  }
  return issue.projectId;
}

/** Authenticate stored run/task binding and capture issues.projectId under admission locks. */
export async function captureProjectConnectionRunContext(db: Executor, input: CaptureInput): Promise<ProjectConnectionRunContext> {
  if (!input.heartbeatRunId) {
    // Only existing authorized server checkout callers use an issue without a run.
    const issueId = input.issueId ?? null;
    return { companyId: input.companyId, agentId: input.agentId, heartbeatRunId: null, issueId,
      projectId: await taskProject(db, input.companyId, issueId) };
  }
  if (!isUuidLike(input.heartbeatRunId)) throw invalid();
  return db.transaction(async tx => {
    const readRun = () => tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId, contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.heartbeatRunId!),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
    const [initial] = await readRun();
    if (!initial || !["queued", "running"].includes(initial.status)) throw invalid();
    assertBoundRunIssueId(initial);
    const issueId = boundRunIssueId(initial);
    if (input.issueId && input.issueId !== issueId) throw invalid();
    // Existing task-before-run ordering, then the common start/retire project row.
    const projectId = await taskProject(tx, input.companyId, issueId, true);
    if (projectId) await lockProjectConnectionLifecycle(tx, { companyId: input.companyId, projectId });
    const [run] = await readRun().for("no key update");
    if (!run || !["queued", "running"].includes(run.status)) throw invalid();
    assertBoundRunIssueId(run);
    if (boundRunIssueId(run) !== issueId) throw invalid();
    const snapshot = run.contextSnapshot ?? {};
    if (Object.hasOwn(snapshot, SNAPSHOT_KEY)) {
      const saved = savedBinding(snapshot[SNAPSHOT_KEY]);
      if (saved.issueId !== issueId || saved.projectId !== projectId) throw invalid();
    } else {
      // JSON merge preserves unrelated run context and never persists caller project hints.
      await tx.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb)
        || ${JSON.stringify({ [SNAPSHOT_KEY]: { version: 1, issueId, projectId } })}::jsonb` })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, input.companyId)));
    }
    return { companyId: input.companyId, agentId: input.agentId, heartbeatRunId: run.id, issueId, projectId };
  });
}

/** Recheck the SAME binding after provider I/O/cache; never switch scope. */
export async function revalidateProjectConnectionRunContext(db: Executor, context: ProjectConnectionRunContext): Promise<void> {
  const current = await captureProjectConnectionRunContext(db, context);
  if (current.issueId !== context.issueId || current.projectId !== context.projectId) throw invalid();
}

/** Retained ownership engages C2 before empty/legacy/ambient branches. */
export async function isProjectConnectionManagedRequired(db: Executor, input: Readonly<{ companyId: string; projectId: string }>): Promise<boolean> {
  const rows = await db.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, input.companyId), eq(toolConnections.projectId, input.projectId),
  ));
  if (rows.length === 0) return false;
  // The sole exception is one server-approved, never-activated, non-serving first draft.
  if (rows.length !== 1) return true;
  const row = rows[0]!;
  if (row.status !== "draft" || row.enabled) return true;
  let scope;
  try { scope = readProjectConnectionScope(row); } catch { return true; }
  if (!scope?.migrationPending || !scope.legacyConnectionId || !isUuidLike(scope.legacyConnectionId)) return true;
  const installs = await db.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, row.id),
  )).limit(1);
  if (installs.length) return true;
  const [legacy] = await db.select({ id: toolConnections.id }).from(toolConnections).where(and(
    eq(toolConnections.id, scope.legacyConnectionId), eq(toolConnections.companyId, input.companyId),
    sql`${toolConnections.projectId} is null`,
  ));
  return !legacy;
}
