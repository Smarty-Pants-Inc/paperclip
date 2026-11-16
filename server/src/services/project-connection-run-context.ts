import { and, eq, or, sql } from "drizzle-orm";
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

/** Only queue admission may create the pair; credential consumers must only read it. */
export function captureProjectConnectionRunContext(db: Executor, input: CaptureInput): Promise<ProjectConnectionRunContext> {
  return resolveRunContext(db, input, true);
}

/**
 * Queue writers call this after their task lock and before subordinate run,
 * wake, profile or agent locks. The task id comes from the writer's authorized
 * binding, never a caller project hint. Persist the returned pair atomically
 * with the new run (including scheduled retries).
 */
export async function projectConnectionAdmissionSnapshot(db: Executor, input: Readonly<{
  companyId: string; agentId: string; issueId: string | null; contextSnapshot: Record<string, unknown>;
}>): Promise<Record<string, unknown>> {
  assertBoundRunIssueId({ issueId: input.issueId, contextSnapshot: input.contextSnapshot });
  const issueId = boundRunIssueId({ issueId: input.issueId, contextSnapshot: input.contextSnapshot });
  const projectId = await taskProject(db, input.companyId, issueId, true);
  const projectIds = new Set<string>();
  if (projectId) projectIds.add(projectId);
  else {
    // D also protects an installed agent's taskless/non-project work. Use the
    // same saved install boundary and sorted lifecycle locks for that case.
    const owned = await db.select({ projectId: toolConnections.projectId }).from(toolConnections)
      .innerJoin(toolConnectionInstalls, and(eq(toolConnectionInstalls.companyId, toolConnections.companyId),
        eq(toolConnectionInstalls.connectionId, toolConnections.id)))
      .where(and(eq(toolConnections.companyId, input.companyId), or(
        and(eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, input.agentId)),
        and(eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, input.companyId)),
      )));
    for (const row of owned) if (row.projectId) projectIds.add(row.projectId);
  }
  for (const id of [...projectIds].sort()) await lockProjectConnectionLifecycle(db, { companyId: input.companyId, projectId: id });
  // Task remains locked across the lifecycle wait. Only a server-derived pair
  // survives; copied predecessor/caller pairs are not authority for a new run.
  return { ...input.contextSnapshot, [SNAPSHOT_KEY]: { version: 1, issueId, projectId } };
}

/** Read the admission pair without inventing one at first credential/cache use. */
export function readProjectConnectionRunContext(db: Executor, input: CaptureInput): Promise<ProjectConnectionRunContext> {
  return resolveRunContext(db, input, false);
}

/** Preserve the immutable DB pair through every later whole-snapshot replacement. */
export function projectConnectionRunSnapshot(snapshot: Record<string, unknown>) {
  const { [SNAPSHOT_KEY]: _untrusted, ...rest } = snapshot;
  return sql<Record<string, unknown>>`${JSON.stringify(rest)}::jsonb || case
    when ${heartbeatRuns.contextSnapshot} ? ${SNAPSHOT_KEY}
    then jsonb_build_object(${SNAPSHOT_KEY}::text, ${heartbeatRuns.contextSnapshot}->${SNAPSHOT_KEY})
    else '{}'::jsonb end`;
}

async function resolveRunContext(db: Executor, input: CaptureInput, atAdmission: boolean): Promise<ProjectConnectionRunContext> {
  if (!input.heartbeatRunId) {
    // Only existing authorized server checkout callers use an issue without a run.
    const issueId = input.issueId ?? null;
    return { companyId: input.companyId, agentId: input.agentId, heartbeatRunId: null, issueId,
      projectId: await taskProject(db, input.companyId, issueId) };
  }
  if (!isUuidLike(input.heartbeatRunId)) throw invalid();
  const allowedStatuses = atAdmission ? ["queued", "running", "scheduled_retry"] : ["queued", "running"];
  return db.transaction(async tx => {
    const readRun = () => tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId, contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.heartbeatRunId!),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
    const [initial] = await readRun();
    if (!initial || !allowedStatuses.includes(initial.status)) throw invalid();
    assertBoundRunIssueId(initial);
    const issueId = boundRunIssueId(initial);
    if (input.issueId && input.issueId !== issueId) throw invalid();
    // Credential/cache reads NEVER create a pair. Reuse the task -> project
    // lifecycle ordering so a retirement/revocation already holding that lock
    // completes before selection reads its fresh committed access state.
    if (Object.hasOwn(initial.contextSnapshot ?? {}, SNAPSHOT_KEY)) {
      const saved = savedBinding(initial.contextSnapshot![SNAPSHOT_KEY]);
      if (saved.issueId !== issueId || saved.projectId !== await taskProject(tx, input.companyId, issueId, true)) throw invalid();
      if (saved.projectId) await lockProjectConnectionLifecycle(tx, { companyId: input.companyId, projectId: saved.projectId });
      // Fresh statements after a lifecycle wait: no stale run/task snapshot may
      // be promoted to a new admission or silently switched to another project.
      const [current] = await readRun();
      if (!current || !allowedStatuses.includes(current.status)) throw invalid();
      assertBoundRunIssueId(current);
      const currentSaved = savedBinding(current.contextSnapshot?.[SNAPSHOT_KEY]);
      if (boundRunIssueId(current) !== issueId || currentSaved.issueId !== saved.issueId
        || currentSaved.projectId !== saved.projectId || saved.projectId !== await taskProject(tx, input.companyId, issueId)) throw invalid();
      return { companyId: input.companyId, agentId: input.agentId, heartbeatRunId: initial.id, ...saved };
    }
    if (!atAdmission) throw invalid();
    // Existing task-before-run ordering, then the common start/retire project row.
    const projectId = await taskProject(tx, input.companyId, issueId, true);
    if (projectId) await lockProjectConnectionLifecycle(tx, { companyId: input.companyId, projectId });
    const [run] = await readRun().for("no key update");
    if (!run || !allowedStatuses.includes(run.status)) throw invalid();
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
  const current = await readProjectConnectionRunContext(db, context);
  if (current.issueId !== context.issueId || current.projectId !== context.projectId) throw invalid();
}

/** Legacy-only, pre-seam runs retain their null-purpose runtime paths. Saved
 * admission pairs and conflicting/taskless project hints still require strict
 * validation even before the first project-owned connection exists. */
export async function requiresProjectConnectionRunContext(db: Executor, companyId: string, heartbeatRunId?: string | null): Promise<boolean> {
  if (heartbeatRunId && isUuidLike(heartbeatRunId)) {
    const [run] = await db.select({ nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
      contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, heartbeatRunId),
    ));
    if (run) {
      if (Object.hasOwn(run.contextSnapshot ?? {}, SNAPSHOT_KEY)) return true;
      try { assertBoundRunIssueId(run); } catch { return true; }
      if (!boundRunIssueId(run) && run.contextSnapshot?.projectId != null) return true;
    }
  }
  const [row] = await db.select({ id: toolConnections.id }).from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId), sql`${toolConnections.projectId} is not null`,
  )).limit(1);
  return Boolean(row);
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
