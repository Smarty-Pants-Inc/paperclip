import { principalPermissionGrants, type Db } from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";
import type { AuthorizationActor } from "./authorization.js";
import { assertCanManageSubordinateAgent, subordinatePermissionScope } from "./agent-subtree-management.js";

/** PATCH and package replay share this live actor gate. Call within the
 * company-locked writer, after resolving package IDs and reporting links. */
export async function authorizeAgentPermissionGrant(
  db: Db, actor: AuthorizationActor, target: { id: string; companyId: string },
  permissionKey: PermissionKey, enabled: boolean, scope?: Record<string, unknown> | null,
) {
  let effectiveScope = scope;
  if (actor.type === "agent") {
    await assertCanManageSubordinateAgent(db, actor, target);
    if (enabled) {
      if (scope === undefined) {
        const [existingGrant] = await db.select().from(principalPermissionGrants).where(and(
          eq(principalPermissionGrants.companyId, target.companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, target.id),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ));
        effectiveScope = existingGrant?.scope;
      }
      effectiveScope = await subordinatePermissionScope(db, actor, target, permissionKey, effectiveScope);
    }
  } else if (actor.source !== "local_implicit"
    && !await accessService(db).canUser(target.companyId, actor.userId, "users:manage_permissions")) {
    throw forbidden("Missing permission: users:manage_permissions");
  }
  return effectiveScope;
}
