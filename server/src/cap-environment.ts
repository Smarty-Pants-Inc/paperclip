const CAP_ENVIRONMENT_VARIABLES = [
  "PAPERCLIP_CROSS_ISSUE_INFLUENCE_LIMIT",
  "PAPERCLIP_AGENT_TASK_HIERARCHY_DEPTH",
  "PAPERCLIP_MAX_ACTIVE_CHILD_ISSUES",
  "PAPERCLIP_MAX_PLAN_DECOMPOSITION_CHILDREN",
  "PAPERCLIP_BOARD_CHAT_MAX_CONCURRENT",
  "PAPERCLIP_STATUS_CARD_AGENT_MAX_CARDS",
  "PAPERCLIP_FRESH_CONTINUATIONS_PER_CHAIN",
  "PAPERCLIP_DEFAULT_MAX_REVIEW_ROUNDS",
] as const;

/** Only absence selects the owner's default; a typo must never restore a cap. */
export function readPositiveIntegerEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name];
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive safe integer.`);
  }
  return value;
}

/** Validate even settings whose owning service would otherwise read them lazily. */
export function validateCapEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of CAP_ENVIRONMENT_VARIABLES) {
    // Defaults remain with the owning services; this pass validates explicit values only.
    readPositiveIntegerEnvironment(env, name, 1);
  }
}
