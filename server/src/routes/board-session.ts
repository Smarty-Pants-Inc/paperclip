import type { Request } from "express";
import { forbidden } from "../errors.js";

/** W1's board + source:session check, ported from 2ac6254a. Source is set by
 * authentication middleware, never a JSON assertion or responsible-user field. */
export function assertBoardSession(req: Request, code: string) {
  if (req.actor.type !== "board" || req.actor.source !== "session") {
    throw forbidden("A board session is required", { code });
  }
}
