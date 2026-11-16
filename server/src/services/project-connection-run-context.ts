import type { Db } from "@paperclipai/db";
import type { DbTransaction } from "./tool-access/types.js";

/** Lane C. No caller project ID exists in this capture input. */
export type ProjectConnectionRunContext = Readonly<{
  companyId: string;
  agentId: string;
  heartbeatRunId: string | null;
  issueId: string | null;
  projectId: string | null;
}>;

/** Authenticate stored run/task binding and capture issues.projectId under admission locks. */
export async function captureProjectConnectionRunContext(
  _db: Db | DbTransaction,
  _input: Readonly<{ companyId: string; agentId: string; heartbeatRunId?: string | null; issueId?: string | null }>,
): Promise<ProjectConnectionRunContext> {
  throw new Error("Project connection run context not implemented (Stage 0, lane C)");
}

/** Recheck the SAME binding after provider I/O/cache; never switch scope. */
export async function revalidateProjectConnectionRunContext(
  _db: Db | DbTransaction,
  _context: ProjectConnectionRunContext,
): Promise<void> {
  throw new Error("Project connection run revalidation not implemented (Stage 0, lane C)");
}

/** Retained owned history engages C2 before all legacy/null/ambient fallback. */
export async function isProjectConnectionManagedRequired(
  _db: Db | DbTransaction,
  _input: Readonly<{ companyId: string; projectId: string }>,
): Promise<boolean> {
  throw new Error("Project connection managed-required policy not implemented (Stage 0, lane C)");
}
