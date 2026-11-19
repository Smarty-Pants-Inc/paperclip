import { and, eq } from "drizzle-orm";
import { userCompanyPreferences, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";

/** The same persisted primary-agent preference used by Principal Smarties.
 * Never infer ownership from the run, task, creator or company defaults.
 * For final revalidation, hold the agent's run-write lock before locking these
 * rows: primary-agent selection and lifecycle changes lock agent -> preference.
 */
export async function resolveAgentChatPrincipal(db: Db, companyId: string, agentId: string, lock = false): Promise<string> {
  const query = db.select({ userId: userCompanyPreferences.userId }).from(userCompanyPreferences).where(and(
    eq(userCompanyPreferences.companyId, companyId), eq(userCompanyPreferences.primaryAgentId, agentId),
  ));
  const rows = lock ? await query.for("share") : await query;
  if (rows.length !== 1) throw forbidden("This agent has no principal to message");
  return rows[0].userId;
}
