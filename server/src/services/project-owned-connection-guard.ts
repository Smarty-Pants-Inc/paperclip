import { sql, type SQL } from "drizzle-orm";
import { toolConnections } from "@paperclipai/db";
import { forbidden } from "../errors.js";

/**
 * Read-side guard for project-owned tool connections (smarty-dev#20717 RFL C3).
 *
 * A newer image can write PROJECT-OWNED connections: the server-written
 * `config.projectScope` envelope (always mirrored to `transportConfig`) plus a
 * `project_id` column this image's schema does not know. Its project-ownership
 * rules (approved lead, recipient subtree, explicit installs, migration state)
 * are not implemented here, so this image cannot admit any use of such a row.
 * It fails closed: a project-owned connection is never resolved, listed,
 * granted or used for an agent, run or tool call, and is never a company-wide
 * default. Ordinary company connections (no `projectScope` key) are unchanged.
 *
 * The writer always sets `config.projectScope` together with `project_id`, and
 * treats `project_id` without `projectScope` (or the reverse) as malformed, so
 * `projectScope` alone identifies every project-owned row and no schema read
 * is needed. The key's presence counts, whatever its value (fail closed).
 */
export const PROJECT_OWNED_CONNECTION_CODE = "project_connection_not_supported_by_this_server";

const hasProjectScope = (value: unknown) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value as object, "projectScope");

export function isProjectOwnedToolConnection(connection: { config?: unknown; transportConfig?: unknown } | null | undefined): boolean {
  if (!connection) return false;
  return hasProjectScope(connection.config) || hasProjectScope(connection.transportConfig);
}

/** SQL twin of {@link isProjectOwnedToolConnection} for list/default queries. */
export function notProjectOwnedToolConnectionSql(): SQL {
  return sql`NOT (coalesce(${toolConnections.config} ? 'projectScope', false) OR coalesce(${toolConnections.transportConfig} ? 'projectScope', false))`;
}

export function projectOwnedConnectionError(connectionId?: string) {
  return forbidden("This connection belongs to a project and cannot be used by this server version.", {
    code: PROJECT_OWNED_CONNECTION_CODE,
    ...(connectionId ? { connectionId } : {}),
  });
}

export function assertNotProjectOwnedToolConnection(connection: { id?: string; config?: unknown; transportConfig?: unknown }) {
  if (isProjectOwnedToolConnection(connection)) throw projectOwnedConnectionError(connection.id);
}
