/**
 * W1 (RFL 00:24Z): board-session-only, write-only project instance secrets.
 * The board session replaces the lifecycle acknowledgement as write authority;
 * native storage and transactional key-only activity remain unchanged.
 */
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { pluginCompanySettings, plugins, projects, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { persistActivity, publishActivity } from "../services/activity-log.js";
import { validateProjectInstanceSecretChanges } from "../services/project-instance-secrets.js";
import { secretService } from "../services/secrets.js";

export function pluginInstanceSecretWriteRoutes(db: Db): Router {
  const router = Router();
  router.put("/companies/:companyId/plugins/:pluginId/projects/:projectId/instance-secrets/:key", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "session") {
      throw forbidden("A board session is required", { code: "instance_secret_write_board_only" });
    }
    const { companyId, pluginId, projectId, key } = req.params;
    const isCompanyAdmin = req.actor.companyIds?.includes(companyId) && req.actor.memberships?.some(
      (membership) => membership.companyId === companyId && membership.status === "active"
        && (membership.membershipRole === "owner" || membership.membershipRole === "admin"),
    );
    if (!req.actor.isInstanceAdmin && !isCompanyAdmin) {
      throw forbidden("Company admin access is required", { code: "instance_secret_write_admin_required" });
    }
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    const [settings] = await db.select().from(pluginCompanySettings).where(and(
      eq(pluginCompanySettings.pluginId, pluginId), eq(pluginCompanySettings.companyId, companyId),
    ));
    if (plugin?.status !== "ready" || settings?.enabled === false
      || !plugin.manifestJson?.capabilities?.includes("projects.instance-secrets")) {
      throw conflict("Plugin instance secrets are unavailable", { code: "instance_secret_plugin_unavailable" });
    }
    if (!plugin.manifestJson.instanceSecretKeys?.includes(key)) {
      throw unprocessable("Instance secret key is not declared", { code: "instance_secret_key_undeclared" });
    }
    const [project] = await db.select().from(projects).where(and(
      eq(projects.id, projectId), eq(projects.companyId, companyId),
    ));
    if (!project) {
      throw notFound("Project not found", { code: "instance_secret_project_missing" });
    }
    if (project.archivedAt) {
      throw conflict("Project is archived", { code: "instance_secret_project_archived" });
    }
    const value: unknown = req.body?.value;
    if (typeof value !== "string") {
      throw unprocessable("Invalid instance secret value", { code: "instance_secret_value_invalid" });
    }
    try {
      validateProjectInstanceSecretChanges({ [key]: value });
    } catch {
      throw unprocessable("Invalid instance secret value", { code: "instance_secret_value_invalid" });
    }
    const { publication } = await db.transaction(async (tx) => {
      try {
        await secretService(tx).projectInstance.set({ companyId, pluginId, projectId }, key, value);
      } catch {
        throw new Error("Project instance secret storage unavailable");
      }
      return persistActivity(tx as unknown as Db, {
        companyId, actorType: "user", actorId: req.actor.userId!,
        action: "project.instance_secret.saved", entityType: "project", entityId: projectId,
        details: { key },
      });
    });
    publishActivity(publication);
    res.status(204).end();
  });
  return router;
}
