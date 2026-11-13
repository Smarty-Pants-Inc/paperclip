// Admin-only, one-key maintenance entry point. Not registered as a worker tool.
// Disable/drain the plugin and obtain positive host evidence before calling.
export { reconcileWake } from "./backstop.js";
export type { WakeReconciliation } from "./backstop.js";
