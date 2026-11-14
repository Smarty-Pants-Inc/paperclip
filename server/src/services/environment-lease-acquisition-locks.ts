import { and, eq, inArray } from "drizzle-orm";
import { companies, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

type AcquisitionScope = {
  companyId: string;
  environmentId: string;
  assertCompanyBinding?: boolean;
  issueId?: string | null;
  heartbeatRunId?: string | null;
  executionWorkspaceId?: string | null;
  leaseId?: string | null;
};
const parentColumns = {
  id: environmentLeases.id,
  companyId: environmentLeases.companyId,
  environmentId: environmentLeases.environmentId,
  issueId: environmentLeases.issueId,
  heartbeatRunId: environmentLeases.heartbeatRunId,
  executionWorkspaceId: environmentLeases.executionWorkspaceId,
};
type LeaseParents = Pick<typeof environmentLeases.$inferSelect, keyof typeof parentColumns>;
const ids = (...values: (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))].sort();

export async function lockEnvironmentLeaseAcquisitionParents(db: Db, scope: AcquisitionScope): Promise<LeaseParents | null> {
  const previous = scope.leaseId
    ? (await db.select(parentColumns).from(environmentLeases).where(and(
      eq(environmentLeases.id, scope.leaseId), eq(environmentLeases.companyId, scope.companyId),
    )))[0] ?? null
    : null;
  if (scope.leaseId && (!previous || previous.environmentId !== scope.environmentId)) {
    throw conflict("Reusable sandbox lease ownership changed during acquisition.");
  }
  const company = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, scope.companyId)).for("key share");
  if (company.length !== 1) throw conflict("Sandbox acquisition company no longer exists.");
  const issueIds = ids(scope.issueId, previous?.issueId);
  if (issueIds.length) {
    const locked = await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, scope.companyId), inArray(issues.id, issueIds),
    )).orderBy(issues.id).for("update");
    if (locked.length !== issueIds.length) throw conflict("Sandbox acquisition task ownership changed.");
  }
  const runIds = ids(scope.heartbeatRunId, previous?.heartbeatRunId);
  if (runIds.length) {
    const locked = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scope.companyId), inArray(heartbeatRuns.id, runIds),
    )).orderBy(heartbeatRuns.id).for("update");
    if (locked.length !== runIds.length) throw conflict("Sandbox acquisition run ownership changed.");
  }
  const workspaceIds = ids(scope.executionWorkspaceId, previous?.executionWorkspaceId);
  if (workspaceIds.length) {
    const locked = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, scope.companyId), inArray(executionWorkspaces.id, workspaceIds),
    )).orderBy(executionWorkspaces.id).for("update");
    if (locked.length !== workspaceIds.length) throw conflict("Sandbox acquisition workspace ownership changed.");
  }
  if (!scope.assertCompanyBinding) {
    await db.select({ id: environments.id }).from(environments)
      .where(inArray(environments.id, ids(scope.environmentId, previous?.environmentId))).orderBy(environments.id).for("key share");
  }
  return previous;
}

export async function lockEnvironmentLeaseAcquisitionSource(db: Db, previous: LeaseParents | null): Promise<void> {
  if (!previous) return;
  const [current] = await db.select(parentColumns).from(environmentLeases).where(and(
    eq(environmentLeases.id, previous.id), eq(environmentLeases.companyId, previous.companyId),
  )).for("update");
  if (!current || current.environmentId !== previous.environmentId || current.issueId !== previous.issueId || current.heartbeatRunId !== previous.heartbeatRunId ||
      current.executionWorkspaceId !== previous.executionWorkspaceId) {
    throw conflict("Reusable sandbox lease ownership changed during acquisition.");
  }
}
