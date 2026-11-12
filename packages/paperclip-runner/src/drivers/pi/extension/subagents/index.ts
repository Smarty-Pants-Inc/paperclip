import { registerRequiredChildExtensions, type RegisterRequiredChildExtensionsInput, type RequiredChildExtensionRegistration } from "pi-subagents/required-child-extensions";

/** Invoke on the parent's session_start; dispose on shutdown/reload before re-registering. */
export function registerSubagentBridge(
  input: { readonly sessionId: string; readonly childBridgePath: string },
  register: (input: RegisterRequiredChildExtensionsInput) => RequiredChildExtensionRegistration = registerRequiredChildExtensions,
): RequiredChildExtensionRegistration {
  return register({ sessionId: input.sessionId, extensions: [{ id: "paperclip-child-bridge", path: input.childBridgePath }], requireForAllRunners: true });
}
export { createSubagentScope } from "./host.js";
export type { ChildBridgeSink, ChildClosure, ChildReadyReceipt, ChildToolEvent, StopReceipt } from "./host.js";
export { validateChildSelection, acknowledgeChildSelection } from "./selection.js";
export type { ChildModelCatalog, ChildSelection } from "./selection.js";
export { validateRoleTemplate } from "./role-template.js";
export { createSubagentLifecycle } from "./lifecycle.js";
export type { LivenessProvider, LivenessRegistry, SubagentEventBus } from "./lifecycle.js";
