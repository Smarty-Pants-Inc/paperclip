import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { trustedBoardMutationOrigin } from "../middleware/board-mutation-guard.js";
import { validate } from "../middleware/validate.js";
import { writeProjectAppApproval } from "../services/project-app-custody.js";
import { assertCompanyAccess } from "./authz.js";
import { assertBoardSession } from "./board-session.js";

const approvalSchema = z.object({ action: z.enum(["approve", "revoke"]), projectId: z.string().uuid() }).strict();

export function projectAppCustodyRoutes(db: Db) {
  const router = Router();
  router.post("/companies/:companyId/tools/connections/:connectionId/project-app-approval", (req, _res, next) => {
    assertBoardSession(req, "project_app_board_session_required");
    assertCompanyAccess(req, z.string().uuid().parse(req.params.companyId));
    // Unlike the optional global local-mode guard, this human-only ceremony
    // never accepts a missing Origin or a foreign Origin with a safe Referer.
    const origin = req.get("origin");
    if (!origin || !trustedBoardMutationOrigin(req) || trustedBoardMutationOrigin(req) !== origin.toLowerCase()) {
      throw forbidden("A trusted browser origin is required", { code: "project_app_browser_origin_required" });
    }
    if (!req.actor.userId) throw forbidden("A signed-in human is required", { code: "project_app_board_session_required" });
    next();
  }, validate(approvalSchema), async (req, res) => {
    const ids = z.object({ companyId: z.string().uuid(), connectionId: z.string().uuid() }).parse(req.params);
    const receipt = await writeProjectAppApproval(db, { ...ids, ...approvalSchema.parse(req.body), userId: req.actor.userId! });
    res.json(receipt);
  });
  return router;
}
