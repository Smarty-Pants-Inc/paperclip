import { and, eq, sql, type SQL } from "drizzle-orm";
import { projects, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { forbidden, HttpError } from "../errors.js";
import { assertProjectConnectionAdmission, assertProjectConnectionRecipients } from "./project-connection-admission.js";
import type { DbTransaction } from "./tool-access/types.js";

/**
 * Project-owned tool connections: one guard for every agent-serving seam
 * (smarty-dev#20717; reader RFL C3 merged with the #20717 writer).
 *
 * A project-owned row carries the server-written `config.projectScope`
 * envelope (mirrored to `transportConfig`) and the `project_id` column. The
 * reader image could not admit any use, so it refused every such row. This
 * image carries the writer's admission (approved lead + recipient team,
 * explicit install, migrationPending, project match), so the blanket refusal
 * is replaced, seam by seam, with that admission:
 *
 * - a row with `project_id` is usable ONLY by agents inside its own project's
 *   admitted team (the writer's recipient rule against the project's current
 *   lead), and only after the writer's full admission at the same seam;
 * - every other agent, an absent agent, and a caller the owning project does
 *   not admit are refused with the reader's SAME code below;
 * - an envelope WITHOUT `project_id` (or the reverse) has no owner the writer
 *   can admit, so it stays refused for everyone (fail closed, as the reader).
 *
 * It is never a company-wide default: company installs, company policies,
 * profiles and grants never widen a project-owned row's audience.
 */
export const PROJECT_OWNED_CONNECTION_CODE = "project_connection_not_supported_by_this_server";

type OwnedShape = { id?: string; companyId?: string; projectId?: string | null; config?: unknown; transportConfig?: unknown };

const hasProjectScope = (value: unknown) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value as object, "projectScope");

/** Ownership marker: the `project_id` column OR the envelope key (whatever its value). */
export function isProjectOwnedToolConnection(connection: OwnedShape | null | undefined): boolean {
  if (!connection) return false;
  return (connection.projectId !== undefined && connection.projectId !== null)
    || hasProjectScope(connection.config) || hasProjectScope(connection.transportConfig);
}

/**
 * SQL twin for list/default reads: drop rows whose ownership cannot be
 * attributed (envelope without `project_id`). Rows WITH `project_id` pass
 * here and are narrowed per agent by {@link filterProjectOwnedConnectionsForAgent}.
 */
export function notProjectOwnedToolConnectionSql(): SQL {
  return sql`(${toolConnections.projectId} IS NOT NULL OR NOT (coalesce(${toolConnections.config} ? 'projectScope', false) OR coalesce(${toolConnections.transportConfig} ? 'projectScope', false)))`;
}

export function projectOwnedConnectionError(connectionId?: string) {
  return forbidden("This connection belongs to a project. Only that project's admitted agents can use it.", {
    code: PROJECT_OWNED_CONNECTION_CODE,
    ...(connectionId ? { connectionId } : {}),
  });
}

/** Synchronous fail-closed refusal for rows the writer cannot attribute. */
export function assertNotProjectOwnedToolConnection(connection: OwnedShape) {
  if (isProjectOwnedToolConnection(connection)) throw projectOwnedConnectionError(connection.id);
}

export function isProjectOwnedConnectionRefusal(error: unknown) {
  return error instanceof HttpError && (error.details as { code?: unknown } | undefined)?.code === PROJECT_OWNED_CONNECTION_CODE;
}

type Database = Db | DbTransaction;

/**
 * Project match + recipient team: is `agentId` inside the owning project's
 * admitted team? Uses the writer's recipient rule (explicit members of the
 * project's current lead's reporting subtree; another project's lead is a
 * boundary). A project without a lead admits nobody. This is the gate that
 * decides "own project" vs "anyone else"; the writer's full admission
 * (approval, migrationPending, custody, keys, repositories) still runs after it.
 */
export async function isAgentInOwningProjectTeam(db: Database, connection: { companyId: string; projectId: string }, agentId: string | null | undefined) {
  if (!agentId) return false;
  const [project] = await db.select({ leadAgentId: projects.leadAgentId }).from(projects)
    .where(and(eq(projects.companyId, connection.companyId), eq(projects.id, connection.projectId)));
  if (!project?.leadAgentId) return false;
  try {
    await assertProjectConnectionRecipients(db, connection.companyId, connection.projectId, project.leadAgentId, [agentId]);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return false;
    throw error;
  }
}

async function hasExplicitAgentInstall(db: Database, connection: { companyId: string; id: string }, agentId: string) {
  const rows = await db.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, connection.companyId), eq(toolConnectionInstalls.connectionId, connection.id),
    eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, agentId),
  ));
  return rows.length > 0;
}

/**
 * Use seams (token mint, tool call): refuse with the guard code unless the
 * row is an ordinary company row or the agent is inside the owning project's
 * team. Envelope-without-owner rows are refused for everyone.
 */
export async function assertProjectOwnedConnectionAudience(db: Database, connection: OwnedShape & { id: string; companyId: string }, agentId: string | null | undefined) {
  if (!isProjectOwnedToolConnection(connection)) return;
  if (!connection.projectId || !await isAgentInOwningProjectTeam(db, { companyId: connection.companyId, projectId: connection.projectId }, agentId)) {
    throw projectOwnedConnectionError(connection.id);
  }
}

/**
 * Listing seams (Git identity, discovery, installed connections): keep
 * ordinary rows; keep a project-owned row only for an agent inside its
 * owning project's team that has an EXPLICIT agent install (a company
 * install never widens it). Optionally require the run's bound project.
 */
export async function filterProjectOwnedConnectionsForAgent<T extends OwnedShape & { id: string; companyId: string }>(
  db: Database, rows: readonly T[], agentId: string | null | undefined, options: { runProjectId?: string | null } = {},
): Promise<T[]> {
  const kept: T[] = [];
  for (const row of rows) {
    if (!isProjectOwnedToolConnection(row)) { kept.push(row); continue; }
    if (!row.projectId || !agentId) continue;
    if (options.runProjectId && options.runProjectId !== row.projectId) continue;
    if (!await isAgentInOwningProjectTeam(db, { companyId: row.companyId, projectId: row.projectId }, agentId)) continue;
    if (!await hasExplicitAgentInstall(db, row, agentId)) continue;
    kept.push(row);
  }
  return kept;
}

/**
 * Management seams that grant or rebuild reach (explicit install, finish,
 * setup resume/reconnect, replacement-key reconnect): the writer's admission
 * decides, and its "caller or recipient is not this project's" refusals are
 * reported with the guard's SAME code. Other admission refusals (approval
 * changed, archived, pending migration, keys, repositories) keep the
 * writer's specific codes.
 */
const NOT_ADMITTED_CODES = new Set(["project_connection_actor_required", "project_connection_target_outside_project"]);
export function asProjectOwnedConnectionRefusal(error: unknown, connectionId: string): unknown {
  const code = error instanceof HttpError ? (error.details as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === "string" && NOT_ADMITTED_CODES.has(code) ? projectOwnedConnectionError(connectionId) : error;
}

export async function admitProjectOwnedConnection(db: Database, input: Parameters<typeof assertProjectConnectionAdmission>[1] & { connection: NonNullable<Parameters<typeof assertProjectConnectionAdmission>[1]["connection"]> }) {
  try {
    await assertProjectConnectionAdmission(db, input);
  } catch (error) {
    throw asProjectOwnedConnectionRefusal(error, input.connection.id);
  }
}
