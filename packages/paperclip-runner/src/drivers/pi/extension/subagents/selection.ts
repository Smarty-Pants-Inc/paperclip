import { PI_NATIVE_THINKING_LEVELS, PiNativeAdmissionError, resolvePiNativeConfig, type PiNativeThinkingLevel } from "../../pi-native-config.js";

export interface ChildPhysicalModel {
  readonly provider: string;
  readonly id: string;
  /** Authoritative physical family, including aliases. Unknown routing is not admission. */
  readonly family: "claude" | "other";
  readonly thinkingLevels: readonly PiNativeThinkingLevel[];
}
export type ChildModelCatalog = (qualifiedModel: string) => ChildPhysicalModel | undefined;
export type DecisionJson = null | boolean | number | string | readonly DecisionJson[] | { readonly [key: string]: DecisionJson };
export interface ChildSelection {
  readonly selectionId: string;
  readonly roleId: string;
  readonly roleDigest: string;
  readonly paretoRevision: string;
  readonly paretoChoice: string;
  readonly complexity: string;
  readonly rationale: string;
  readonly budget: DecisionJson;
  /** The actual pi-subagents public model argument, including the thinking suffix. */
  readonly model: string;
  readonly requestedModel: string;
  readonly effectiveModel: string;
  readonly effort: PiNativeThinkingLevel;
}
export function childAdmissionError(code: string, message: string): never {
  throw new PiNativeAdmissionError(`pi_child_${code}`, message);
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) childAdmissionError("selection_required", `Child selection requires ${field}.`);
  return value;
}
function snapshotBudget(value: unknown, depth = 0): DecisionJson {
  if (depth > 16) childAdmissionError("selection_invalid", "Child selection budget exceeds depth 16.");
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(item => snapshotBudget(item, depth + 1)));
  if (value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotBudget(item, depth + 1)])));
  }
  return childAdmissionError("selection_invalid", "Child selection budget must be finite plain JSON.");
}
/** No parent environment, settings, role defaults, or standalone thinking argument is consulted. */
export function validateChildSelection(value: unknown, catalog: ChildModelCatalog): ChildSelection {
  const input = object(value);
  const selectionId = requiredText(input.selectionId, "selectionId");
  const roleId = requiredText(input.roleId, "roleId");
  const roleDigest = requiredText(input.roleDigest, "roleDigest");
  const paretoRevision = requiredText(input.paretoRevision, "paretoRevision");
  const paretoChoice = requiredText(input.paretoChoice, "paretoChoice");
  const complexity = requiredText(input.complexity, "complexity");
  const rationale = requiredText(input.rationale, "rationale");
  if (input.budget === undefined || input.budget === null) childAdmissionError("selection_required", "Child selection requires budget.");
  const budget = snapshotBudget(input.budget);
  const model = requiredText(input.model, "model (explicit provider/id:level)");
  const suffix = model.lastIndexOf(":");
  const effort = model.slice(suffix + 1) as PiNativeThinkingLevel;
  if (suffix < 0 || !PI_NATIVE_THINKING_LEVELS.includes(effort)) childAdmissionError("selection_invalid", "Child model requires an explicit provider/id:level using a native Pi thinking level.");
  const requestedModel = resolvePiNativeConfig({ provider: "pi_rpc", model: model.slice(0, suffix), piRpcThinkingLevel: effort }).model;
  const physical = catalog(requestedModel);
  if (!physical || !physical.provider || !physical.id || !["claude", "other"].includes(physical.family)) childAdmissionError("physical_model_unknown", "Child catalog must resolve an authoritative physical model before admission.");
  const effectiveModel = `${physical.provider}/${physical.id}`;
  if ((physical.family === "claude" || /claude/i.test(physical.id)) && PI_NATIVE_THINKING_LEVELS.indexOf(effort) > PI_NATIVE_THINKING_LEVELS.indexOf("xhigh")) childAdmissionError("claude_effort", "Effective Claude child cannot exceed xhigh; selection is not silently clamped.");
  if (!physical.thinkingLevels.includes(effort)) childAdmissionError("thinking_unsupported", "Effective child model does not support the selected effort.");
  return Object.freeze({ selectionId, roleId, roleDigest, paretoRevision, paretoChoice, complexity, rationale, budget, model, requestedModel, effectiveModel, effort });
}
export interface ChildSelectionAck {
  readonly childSessionId: string;
  readonly effectiveModel: string;
  readonly effort: PiNativeThinkingLevel;
}
/** SDK readback (ctx.model + pi.getThinkingLevel), not a synthetic child RPC get_state. */
export function acknowledgeChildSelection(selection: ChildSelection, state: unknown): ChildSelectionAck {
  const input = object(state), model = object(input.model);
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) childAdmissionError("identity_missing", "Child session identity is missing from SDK readback.");
  if (`${model.provider}/${model.id}` !== selection.effectiveModel || input.thinkingLevel !== selection.effort) childAdmissionError("effective_mismatch", "Child effective model/effort differs from the explicit selection; no prompt is admitted.");
  return Object.freeze({ childSessionId: input.sessionId, effectiveModel: selection.effectiveModel, effort: selection.effort });
}
