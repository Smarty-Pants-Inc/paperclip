import { Router } from "express";
import { agents, companyMemberships, principalPermissionGrants, type Db } from "@paperclipai/db";
import { updateAgentPermissionGrantSchema, isUuidLike } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { assertCanManageSubordinateAgent, subordinatePermissionScope } from "../services/agent-subtree-management.js";

export function agentPermissionGrantRoutes(db: Db) {
  const router = Router();

  router.patch("/agents/:id/permission-grants", validate(updateAgentPermissionGrantSchema), async (req, res) => {
    assertAuthenticated(req);
    if (req.actor.type !== "agent") assertBoard(req);
    const id = req.params.id as string;
    if (!isUuidLike(id)) throw badRequest("Agent ID must be a UUID");
    const { permissionKey, enabled, scope } = req.body;
    // Match reportsTo updates: company lock first, then the target row, then
    // re-evaluate the entire reporting relation inside the write transaction.
    const [target] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, id));
    if (!target || !hasCompanyAccess(req, target.companyId)) throw notFound("Agent not found");
    const result = await withAccountingTransaction(db, target.companyId, async (tx, publications) => {
      const agent = await tx.select({ id: agents.id, companyId: agents.companyId, status: agents.status })
        .from(agents).where(eq(agents.id, id)).for("update").then(rows => rows[0]);
      if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
      assertCompanyAccess(req, agent.companyId);
      const txDb = tx as unknown as Db;
      const access = accessService(txDb);
      let effectiveScope = scope;
      if (req.actor.type === "agent") {
        await assertCanManageSubordinateAgent(txDb, req.actor, agent);
        if (enabled) {
          if (scope === undefined) {
            const [existingGrant] = await tx.select().from(principalPermissionGrants).where(and(
              eq(principalPermissionGrants.companyId, agent.companyId),
              eq(principalPermissionGrants.principalType, "agent"),
              eq(principalPermissionGrants.principalId, agent.id),
              eq(principalPermissionGrants.permissionKey, permissionKey),
            ));
            effectiveScope = existingGrant?.scope;
          }
          effectiveScope = await subordinatePermissionScope(txDb, req.actor, agent, permissionKey, effectiveScope);
        }
      } else if (req.actor.source !== "local_implicit"
        && !await access.canUser(agent.companyId, req.actor.userId, "users:manage_permissions")) {
        throw forbidden("Missing permission: users:manage_permissions");
      }
      const scopeUpdate = effectiveScope === undefined ? {} : { scope: effectiveScope };
      if (enabled) {
        if (agent.status === "pending_approval" || agent.status === "terminated") {
          throw conflict("Cannot grant permissions to an unapproved or terminated agent");
        }
        const membership = await tx.select().from(companyMemberships).where(and(
          eq(companyMemberships.companyId, agent.companyId),
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.principalId, agent.id),
        )).for("update").then(rows => rows[0]);
        if (!membership || membership.status !== "active") {
          throw conflict("Agent company membership is not active");
        }
        await tx.insert(principalPermissionGrants).values({
          companyId: agent.companyId, principalType: "agent", principalId: agent.id,
          permissionKey, scope: effectiveScope ?? null, grantedByUserId: req.actor.userId ?? null,
        }).onConflictDoUpdate({
          target: [principalPermissionGrants.companyId, principalPermissionGrants.principalType,
            principalPermissionGrants.principalId, principalPermissionGrants.permissionKey],
          // A legacy toggle must not silently widen an already-scoped grant.
          set: { ...scopeUpdate, grantedByUserId: req.actor.userId ?? null, updatedAt: new Date() },
        });
      } else {
        await tx.delete(principalPermissionGrants).where(and(
          eq(principalPermissionGrants.companyId, agent.companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, agent.id),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ));
      }
      const actor = getActorInfo(req);
      await logActivity(txDb, {
        companyId: agent.companyId, actorType: actor.actorType, actorId: actor.actorId,
        agentId: actor.agentId, runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
        action: "agent.permission_grant_updated", entityType: "agent", entityId: agent.id,
        details: { permissionKey, enabled, ...scopeUpdate },
      }, publications);
      return { agentId: agent.id, companyId: agent.companyId, permissionKey, enabled };
    });
    res.json(result);
  });

  return router;
}
