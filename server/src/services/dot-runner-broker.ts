import { aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";

/** Compatibility facade: Dot OAuth/MCP identities and deployed protocol remain unchanged. */
export { dotRunnerBroker, createDotRunnerMcpTools } from "../modules/external-agents/index.js";


/** The external-bot start gate's scope (heartbeat.ts canStartNewExternalBotWork):
 * the binding id the gate checks for this agent, or null when the gate does not
 * apply. One rule for the dispatcher and the task card. A Grok Bot agent is gated
 * on adapterConfig.externalBindingId and a Dot agent (provider "openai_dot") on
 * adapterConfig.dotBindingId: the keys pairing writes (external-agents/dot.ts pair)
 * and runtime selection's snapshot reads (heartbeat/runtime-selection.ts). FIX20:
 * without the Dot case the dispatcher claimed a Dot run whose binding was not ready
 * and the card counted the hold as startable time. */
export function externalBotStartGateBindingId(agent: { adapterType: string; adapterConfig: unknown; runtimeConfig: unknown }): string | null {
  const adapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  if (agent.adapterType !== "paperclip_runner") return null;
  const bindingKey = adapterConfig.provider === "grok_bot" ? "externalBindingId"
    : adapterConfig.provider === "openai_dot" ? "dotBindingId" : null;
  if (bindingKey === null) return null;
  const aiConnection = aiRuntimeConnectionBindingSchema.safeParse((agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection);
  if (aiConnection.success && aiConnection.data.mode === "router") return null;
  const bindingId = adapterConfig[bindingKey];
  return typeof bindingId === "string" && bindingId.trim().length > 0 ? bindingId : "";
}
