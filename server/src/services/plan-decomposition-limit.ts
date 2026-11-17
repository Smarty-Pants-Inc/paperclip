import { createAcceptedPlanDecompositionSchemaWithLimit } from "@paperclipai/shared";

export const MAX_PLAN_DECOMPOSITION_CHILDREN = 25;
export const MAX_PLAN_DECOMPOSITION_CHILDREN_ENV = "PAPERCLIP_MAX_PLAN_DECOMPOSITION_CHILDREN";

/** Missing or invalid settings preserve the upstream per-request plan limit. */
export function resolveMaxPlanDecompositionChildren(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_PLAN_DECOMPOSITION_CHILDREN_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return MAX_PLAN_DECOMPOSITION_CHILDREN;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : MAX_PLAN_DECOMPOSITION_CHILDREN;
}

/** The server injects its limit; the shared/browser default remains 25. */
export function createServerAcceptedPlanDecompositionSchema() {
  return createAcceptedPlanDecompositionSchemaWithLimit(resolveMaxPlanDecompositionChildren());
}
