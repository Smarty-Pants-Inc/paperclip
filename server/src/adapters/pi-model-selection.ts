import type { Db } from "@paperclipai/db";
import { aiConnectionMetadataSchema, aiRoutingBaseUrl, aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { listGatewayModels } from "../services/gateway-models.js";
import { parseObject } from "./utils.js";
import { PaperclipRunnerProviderProfileError, piRpcThinking, projectPaperclipRunnerTaskConfig } from "../services/native-runtime/provider-profile.js";

export const PI_MODEL_PROVIDER_REQUIRED = "pi_model_provider_required";

/** Validate the same effective reasoning selection that the Pi runtime consumes. */
export function validatePiReasoningSelection(
  agent: { adapterType: string; adapterConfig: unknown },
  overrides?: unknown,
): void {
  const saved = parseObject(agent.adapterConfig);
  if (agent.adapterType !== "paperclip_runner" || saved.provider !== "pi_rpc") return;
  try {
    const config = overrides === undefined ? saved : projectPaperclipRunnerTaskConfig(
      "pi_rpc", saved, parseObject(parseObject(overrides).adapterConfig),
    );
    piRpcThinking(config);
  } catch (error) {
    if (error instanceof PaperclipRunnerProviderProfileError) throw unprocessable(error.message);
    throw error;
  }
}

/** PATCH-only preflight. Call before any persistence transaction, never from
 * synchronous run normalization: a catalog outage must not block a save/run.
 */
export async function validatePiGatewayModelSelection(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string; adapterConfig: unknown; runtimeConfig: unknown },
  responsibleUserId: string | null,
  overrides?: unknown,
): Promise<void> {
  const saved = parseObject(agent.adapterConfig);
  if (agent.adapterType !== "paperclip_runner" || saved.provider !== "pi_rpc") return;
  const config = overrides === undefined ? saved : projectPaperclipRunnerTaskConfig(
    "pi_rpc", saved, parseObject(parseObject(overrides).adapterConfig),
  );
  if (typeof config.model !== "string" || !config.model) return;
  const binding = aiRuntimeConnectionBindingSchema.safeParse(parseObject(agent.runtimeConfig).aiConnection).data;
  // Router pools own their model selection; unmanaged Pi providers have no
  // server-owned gateway connection to consult.
  if (!binding || binding.mode === "router") return;
  const service = aiConnectionService(db);
  const selection = await service.select({ companyId: agent.companyId, agentId: agent.id, userId: responsibleUserId,
    adapterType: agent.adapterType, runnerProvider: "pi_rpc", model: config.model, binding,
    allowLegacyValidation: true,
  }).catch(() => null);
  if (!selection) return; // Existing connection validation owns access/config errors.
  const route = aiConnectionMetadataSchema.safeParse(selection.connection.config.ai).data?.routing;
  if (!route || !["gateway", "local"].includes(route.kind)) return;
  const models = await listGatewayModels(aiRoutingBaseUrl(route, "pi_rpc"), async (): Promise<Record<string, string>> => {
    if (route.auth === "none") return {};
    const credential = await service.runtimeCredential(selection);
    return route.auth === "api_key" ? { "x-api-key": credential } : { Authorization: `Bearer ${credential}` };
  });
  // Strip only the managed provider prefix. A namespaced gateway ID retains
  // all subsequent slashes (for example paperclip/qwen/qwen3 -> qwen/qwen3).
  const id = config.model.startsWith("paperclip/") ? config.model.slice("paperclip/".length) : config.model;
  if (models && !models.has(id)) {
    throw unprocessable(`Pi cannot use model ${JSON.stringify(config.model)}: not offered by the gateway`);
  }
}

/** Reject an unqualified Pi model before allocating a runtime. */
export function validatePiRunSelection(
  agent: { adapterType: string; adapterConfig: unknown },
  overrides: unknown,
): void {
  const saved = parseObject(agent.adapterConfig);
  if (agent.adapterType !== "paperclip_runner" || saved.provider !== "pi_rpc") return;
  const config = { ...saved, ...parseObject(parseObject(overrides).adapterConfig) };
  if (typeof config.model !== "string" || !/^[^/\s]+\/\S+$/.test(config.model)) {
    throw unprocessable(
      `Pi cannot use model ${JSON.stringify(config.model)}: pick a provider/model, or clear the chat's model after fixing the agent default.`,
      { code: PI_MODEL_PROVIDER_REQUIRED, model: config.model, retryability: "requires_action" },
    );
  }
}

/** A bare chat selection inherits only this agent's explicitly saved Pi provider. */
export function normalizePiIssueModelSelection<T>(
  agent: { adapterType: string; adapterConfig: unknown },
  overrides: T,
): T {
  const config = parseObject(agent.adapterConfig);
  if (agent.adapterType !== "paperclip_runner" || config.provider !== "pi_rpc") return overrides;
  let normalized = overrides;
  const parsed = parseObject(overrides);
  const overrideConfig = parseObject(parsed.adapterConfig);
  if ("model" in overrideConfig) {
    const model = overrideConfig.model;
    if (!(typeof model === "string" && /^[^/\s]+\/\S+$/.test(model))) {
      const savedModel = config.model;
      if (typeof model === "string" && model.length > 0 && !/[\s/]/.test(model)
        && typeof savedModel === "string" && /^[^/\s]+\/\S+$/.test(savedModel)) {
        normalized = { ...parsed, adapterConfig: { ...overrideConfig, model: `${savedModel.slice(0, savedModel.indexOf("/"))}/${model}` } } as T;
      } else {
        throw unprocessable(
          `Pi cannot use chat model ${JSON.stringify(model)}: pick a provider/model, or clear the chat's model to use the agent default.`,
          { code: PI_MODEL_PROVIDER_REQUIRED, model, retryability: "requires_action" },
        );
      }
    }
  }
  // Validate the normalized projection that runtime admission will actually use.
  validatePiReasoningSelection(agent, normalized);
  return normalized;
}
