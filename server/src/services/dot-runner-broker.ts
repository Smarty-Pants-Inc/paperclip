import { aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";

/** Compatibility facade: Dot OAuth/MCP identities and deployed protocol remain unchanged. */
export { dotRunnerBroker, createDotRunnerMcpTools } from "../modules/external-agents/index.js";


/** The external-bot start gate's scope (heartbeat.ts canStartNewExternalBotWork):
 * the binding id the gate checks for this agent, or null when the gate does not
 * apply. One rule for the dispatcher and the task card. */
export function externalBotStartGateBindingId(agent: { adapterType: string; adapterConfig: unknown; runtimeConfig: unknown }): string | null {
  const adapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  if (agent.adapterType !== "paperclip_runner" || adapterConfig.provider !== "grok_bot") return null;
  const aiConnection = aiRuntimeConnectionBindingSchema.safeParse((agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection);
  if (aiConnection.success && aiConnection.data.mode === "router") return null;
  const bindingId = adapterConfig.externalBindingId;
  return typeof bindingId === "string" && bindingId.trim().length > 0 ? bindingId : "";
}
