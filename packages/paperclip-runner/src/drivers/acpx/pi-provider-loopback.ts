import { startProviderLoopbackBroker, type LoopbackRouteAdapter, type LoopbackUpstreamAuth } from "../provider-loopback/broker.js";
import { chatLoopbackAdapter } from "../provider-loopback/chat.js";
import { messagesLoopbackAdapter } from "../provider-loopback/messages.js";
import { responsesLoopbackAdapter } from "../provider-loopback/responses.js";
import { buildPiManagedModel, originalPiModelsFile, piManagedModelDefinition, type PiManagedModel } from "../pi/pi-managed-model.js";
import { isPiModelCompat, type PiBindProvider } from "../pi/pi-bind-protocol.js";
import { PI_NATIVE_THINKING_LEVELS, type PiNativeThinkingLevel } from "../pi/pi-native-config.js";

function managedModel(model: string, thinkingLevel?: PiNativeThinkingLevel, configuration?: PiManagedModel): PiManagedModel {
  if (thinkingLevel !== undefined && !PI_NATIVE_THINKING_LEVELS.includes(thinkingLevel)) throw new Error("Pi managed model thinking level is invalid");
  if (configuration && configuration.id !== model) throw new Error("Pi managed model configuration id mismatch");
  if (configuration && Object.hasOwn(configuration, "compat") && !isPiModelCompat(configuration.compat)) throw new Error("Pi managed model has invalid compat");
  // Effort is a request, not a capability declaration. Only snapshot/catalog
  // metadata may describe support; Pi owns normalization of the requested level.
  return piManagedModelDefinition(configuration ?? { id: model });
}

const PI_MANAGED_PROVIDER_PROTOCOLS: Readonly<Record<string, { adapter: LoopbackRouteAdapter; api: PiBindProvider["api"] }>> = {
  chat: { adapter: chatLoopbackAdapter, api: "openai-completions" },
  messages: { adapter: messagesLoopbackAdapter, api: "anthropic-messages" },
  responses: { adapter: responsesLoopbackAdapter, api: "openai-responses" },
};

/** The API comes only from the active managed protocol, never model metadata. */
export function piManagedProviderApi(environment: NodeJS.ProcessEnv): PiBindProvider["api"] {
  const protocol = environment.PAPERCLIP_AI_PROVIDER_PROTOCOL ?? "";
  const route = Object.hasOwn(PI_MANAGED_PROVIDER_PROTOCOLS, protocol) ? PI_MANAGED_PROVIDER_PROTOCOLS[protocol] : undefined;
  if (!route) throw new Error("Pi managed provider protocol is unsupported");
  return route.api;
}

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
  // The real ACPX sandbox calls this before HOME projection, with no metadata.
  // No selected 1.5.2 catalog is supplied by this legacy installation path.
  const modelConfiguration = await buildPiManagedModel({ snapshot: {},
    id: input.model.startsWith("paperclip/") ? input.model.slice("paperclip/".length) : input.model,
    api: piManagedProviderApi(input.environment), originalModelsFile: originalPiModelsFile(input.environment) });
  const binding = await createPiProviderBinding({ ...input, modelConfiguration });
  const { baseUrl, api, apiKey, models } = binding.provider;
  return {
    json: piProviderJson({ baseUrl, api, apiKey, model: models[0].id, modelConfiguration: models[0] }),
    close: binding.close,
  };
}

/** Bind Pi in memory using only a revocable broker capability, never the upstream credential. */
export async function createPiProviderBinding(input: {
  model: string;
  environment: NodeJS.ProcessEnv;
  /** Native Pi only: requested level already admitted against its connection. */
  thinkingLevel?: PiNativeThinkingLevel;
  modelConfiguration?: PiManagedModel;
  onSensitiveValues?(values: readonly string[]): void;
}): Promise<{ provider: { name: "paperclip"; api: PiBindProvider["api"]; baseUrl: string; apiKey: string; models: [PiManagedModel] }; rejectedToolCount(): number | undefined; close(): Promise<void> }> {
  const protocol = input.environment.PAPERCLIP_AI_PROVIDER_PROTOCOL ?? "";
  const route = Object.hasOwn(PI_MANAGED_PROVIDER_PROTOCOLS, protocol) ? PI_MANAGED_PROVIDER_PROTOCOLS[protocol] : undefined;
  if (!route) throw new Error("Pi managed provider protocol is unsupported");
  const connection = piProviderConnection(input.model, input.environment);
  const model = managedModel(connection.model, input.thinkingLevel, input.modelConfiguration);
  // Pi 1.5.2 docs/extensions.md, before_provider_request: later handlers may
  // replace the payload. Only this owned HTTP boundary sees their final result.
  // Retain one numeric cause per revocable binding, never extension payload data.
  let rejectedToolCount: number | undefined;
  const broker = await startProviderLoopbackBroker({ adapter: route.adapter, baseUrl: connection.baseUrl, key: connection.key, auth: connection.auth, environment: input.environment,
    rejectPayload: route.api !== "openai-completions" ? undefined : payload => {
      if (Array.isArray(payload.tools) && payload.tools.length > 128) rejectedToolCount ??= payload.tools.length;
      if (rejectedToolCount === undefined) return;
      // Latch refusal for this binding: no smaller-catalog retry after a failure.
      // The driver emits the single actionable note from its own count, not
      // this response (which Pi may also project as a low-level error item).
      return { code: "pi_tool_limit_exceeded", message: "Pi provider request refused by the tool limit guard." };
    },
  });
  try {
    input.onSensitiveValues?.([broker.token, ...(connection.key ? [connection.key] : [])]);
    return {
      provider: { name: "paperclip", api: route.api, baseUrl: broker.baseURL, apiKey: broker.token, models: [model] },
      rejectedToolCount: () => rejectedToolCount,
      close: broker.close,
    };
  } catch (error) {
    await broker.close();
    throw error;
  }
}

/** Development-only direct-key configuration for the native Pi RPC fallback. */
export function directPiProviderConfiguration(input: { model: string; environment: NodeJS.ProcessEnv; thinkingLevel?: PiNativeThinkingLevel; modelConfiguration?: PiManagedModel }): { json: string; key: string } {
  const protocol = input.environment.PAPERCLIP_AI_PROVIDER_PROTOCOL ?? "";
  const route = Object.hasOwn(PI_MANAGED_PROVIDER_PROTOCOLS, protocol) ? PI_MANAGED_PROVIDER_PROTOCOLS[protocol] : undefined;
  if (!route) throw new Error("Pi managed provider protocol is unsupported");
  const connection = piProviderConnection(input.model, input.environment);
  return { json: piProviderJson({ baseUrl: connection.baseUrl, api: route.api, apiKey: connection.key, model: connection.model,
    modelConfiguration: managedModel(connection.model, input.thinkingLevel, input.modelConfiguration) }), key: connection.key };
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
