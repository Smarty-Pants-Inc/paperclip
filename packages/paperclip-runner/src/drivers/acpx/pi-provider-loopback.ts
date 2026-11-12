import { startProviderLoopbackBroker, type LoopbackRouteAdapter, type LoopbackUpstreamAuth } from "../provider-loopback/broker.js";
import { chatLoopbackAdapter } from "../provider-loopback/chat.js";
import { messagesLoopbackAdapter } from "../provider-loopback/messages.js";
import { responsesLoopbackAdapter } from "../provider-loopback/responses.js";
import type { PiBindModel } from "../pi/pi-bind-protocol.js";
import { PI_NATIVE_THINKING_LEVELS, type PiNativeThinkingLevel } from "../pi/pi-native-config.js";

type PiManagedModel = Pick<PiBindModel, "id" | "reasoning" | "thinkingLevelMap">;

function managedModel(model: string, thinkingLevel?: PiNativeThinkingLevel): PiManagedModel {
  // The native caller supplies a level already admitted against the selected
  // connection. Do not advertise any other capability. Pi docs/models-configuration.md:
  // reasoning defaults false; a null thinkingLevelMap entry is unsupported.
  if (thinkingLevel === undefined || thinkingLevel === "off") return { id: model };
  if (!PI_NATIVE_THINKING_LEVELS.includes(thinkingLevel)) throw new Error("Pi managed model thinking level is invalid");
  return { id: model, reasoning: true, thinkingLevelMap: Object.fromEntries(
    PI_NATIVE_THINKING_LEVELS.map(level => [level, level === thinkingLevel ? level : null]),
  ) };
}

const PI_MANAGED_PROVIDER_PROTOCOLS: Readonly<Record<string, { adapter: LoopbackRouteAdapter; api: string }>> = {
  chat: { adapter: chatLoopbackAdapter, api: "openai-completions" },
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
  const binding = await createPiProviderBinding(input);
  const { baseUrl, api, apiKey, models } = binding.provider;
  return {
    json: piProviderJson({ baseUrl, api, apiKey, model: models[0].id }),
    close: binding.close,
  };
}

/** Bind Pi in memory using only a revocable broker capability, never the upstream credential. */
export async function createPiProviderBinding(input: {
  model: string;
  environment: NodeJS.ProcessEnv;
  /** Native Pi only: requested level already admitted against its connection. */
  thinkingLevel?: PiNativeThinkingLevel;
  onSensitiveValues?(values: readonly string[]): void;
}): Promise<{ provider: { name: "paperclip"; api: string; baseUrl: string; apiKey: string; models: [PiManagedModel] }; close(): Promise<void> }> {
  const protocol = input.environment.PAPERCLIP_AI_PROVIDER_PROTOCOL ?? "";
  const route = Object.hasOwn(PI_MANAGED_PROVIDER_PROTOCOLS, protocol) ? PI_MANAGED_PROVIDER_PROTOCOLS[protocol] : undefined;
  if (!route) throw new Error("Pi managed provider protocol is unsupported");
  const connection = piProviderConnection(input.model, input.environment);
  const model = managedModel(connection.model, input.thinkingLevel);
  const broker = await startProviderLoopbackBroker({ adapter: route.adapter, baseUrl: connection.baseUrl, key: connection.key, auth: connection.auth, environment: input.environment });
  try {
    input.onSensitiveValues?.([broker.token, ...(connection.key ? [connection.key] : [])]);
    return {
      provider: { name: "paperclip", api: route.api, baseUrl: broker.baseURL, apiKey: broker.token, models: [model] },
      close: broker.close,
    };
  } catch (error) {
    await broker.close();
    throw error;
  }
}

/** Development-only direct-key configuration for the native Pi RPC fallback. */
export function directPiProviderConfiguration(input: { model: string; environment: NodeJS.ProcessEnv; thinkingLevel?: PiNativeThinkingLevel }): { json: string; key: string } {
  const protocol = input.environment.PAPERCLIP_AI_PROVIDER_PROTOCOL ?? "";
  const route = Object.hasOwn(PI_MANAGED_PROVIDER_PROTOCOLS, protocol) ? PI_MANAGED_PROVIDER_PROTOCOLS[protocol] : undefined;
  if (!route) throw new Error("Pi managed provider protocol is unsupported");
  const connection = piProviderConnection(input.model, input.environment);
  return { json: piProviderJson({ baseUrl: connection.baseUrl, api: route.api, apiKey: connection.key, model: connection.model,
    modelConfiguration: managedModel(connection.model, input.thinkingLevel) }), key: connection.key };
}

function piProviderConnection(modelName: string, environment: NodeJS.ProcessEnv): { model: string; baseUrl: string; auth: LoopbackUpstreamAuth; key: string } {
  const model = modelName.startsWith("paperclip/") ? modelName.slice("paperclip/".length) : modelName;
  const baseUrl = environment.PAPERCLIP_AI_PROVIDER_URL;
  const auth = environment.PAPERCLIP_AI_PROVIDER_AUTH;
  const key = environment.PAPERCLIP_AI_PROVIDER_KEY ?? "";
  if (!model || !baseUrl || !["bearer", "api_key", "none"].includes(auth ?? "") || (auth !== "none" && !key)) {
    throw new Error("Pi managed provider connection is incomplete");
  }
  return { model, baseUrl, auth: auth as LoopbackUpstreamAuth, key };
}

function piProviderJson(input: { baseUrl: string; api: string; apiKey: string; model: string; modelConfiguration?: PiManagedModel }): string {
  return `${JSON.stringify({ providers: { paperclip: { baseUrl: input.baseUrl, api: input.api, apiKey: input.apiKey, models: [input.modelConfiguration ?? { id: input.model }] } } })}\n`;
}
