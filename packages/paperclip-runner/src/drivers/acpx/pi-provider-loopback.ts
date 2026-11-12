import { startProviderLoopbackBroker, type LoopbackRouteAdapter, type LoopbackUpstreamAuth } from "../provider-loopback/broker.js";
import { messagesLoopbackAdapter } from "../provider-loopback/messages.js";
import { responsesLoopbackAdapter } from "../provider-loopback/responses.js";

const PI_MANAGED_PROVIDER_PROTOCOLS: Readonly<Record<string, { adapter: LoopbackRouteAdapter; api: string }>> = {
  messages: { adapter: messagesLoopbackAdapter, api: "anthropic-messages" },
  responses: { adapter: responsesLoopbackAdapter, api: "openai-responses" },
};

/** Managed connections are runner-owned; native Pi providers keep their existing configuration path. */
export function usesPiProviderLoopback(model: string, environment?: NodeJS.ProcessEnv): boolean {
  return model.startsWith("paperclip/") && Boolean(environment?.PAPERCLIP_AI_PROVIDER_URL || environment?.PAPERCLIP_AI_PROVIDER_PROTOCOL);
}

/** Materialize only a session capability in Pi's models.json, never the upstream credential. */
export async function startPiProviderLoopback(input: {
  model: string;
  environment: NodeJS.ProcessEnv;
  onSensitiveValues?(values: readonly string[]): void;
}): Promise<{ json: string; close(): Promise<void> }> {
  const protocol = input.environment.PAPERCLIP_AI_PROVIDER_PROTOCOL ?? "";
  const route = Object.hasOwn(PI_MANAGED_PROVIDER_PROTOCOLS, protocol) ? PI_MANAGED_PROVIDER_PROTOCOLS[protocol] : undefined;
  if (!route) throw new Error("Pi managed provider protocol is unsupported");
  const model = input.model.slice("paperclip/".length);
  const baseUrl = input.environment.PAPERCLIP_AI_PROVIDER_URL;
  const auth = input.environment.PAPERCLIP_AI_PROVIDER_AUTH;
  const key = input.environment.PAPERCLIP_AI_PROVIDER_KEY ?? "";
  if (!model || !baseUrl || !["bearer", "api_key", "none"].includes(auth ?? "") || (auth !== "none" && !key)) {
    throw new Error("Pi managed provider connection is incomplete");
  }
  const broker = await startProviderLoopbackBroker({ adapter: route.adapter, baseUrl, key, auth: auth as LoopbackUpstreamAuth, environment: input.environment });
  try {
    input.onSensitiveValues?.([broker.token, ...(key ? [key] : [])]);
    return {
      json: `${JSON.stringify({ providers: { paperclip: { baseUrl: broker.baseURL, api: route.api, apiKey: broker.token, models: [{ id: model }] } } })}\n`,
      close: broker.close,
    };
  } catch (error) {
    await broker.close();
    throw error;
  }
}
