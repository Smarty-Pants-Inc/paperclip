import { createAcceptedPlanDecompositionSchemaWithLimit } from "@paperclipai/shared";
import { readPositiveIntegerEnvironment } from "../cap-environment.js";

export const MAX_PLAN_DECOMPOSITION_CHILDREN = 25;
export const MAX_PLAN_DECOMPOSITION_CHILDREN_ENV = "PAPERCLIP_MAX_PLAN_DECOMPOSITION_CHILDREN";

/** Absence preserves the upstream limit; malformed settings refuse startup. */
export function resolveMaxPlanDecompositionChildren(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntegerEnvironment(env, MAX_PLAN_DECOMPOSITION_CHILDREN_ENV, MAX_PLAN_DECOMPOSITION_CHILDREN);
}

/** The server injects its limit; the shared/browser default remains 25. */
export function createServerAcceptedPlanDecompositionSchema() {
  return createAcceptedPlanDecompositionSchemaWithLimit(resolveMaxPlanDecompositionChildren());
}
