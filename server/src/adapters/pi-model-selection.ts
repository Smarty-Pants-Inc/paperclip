import { unprocessable } from "../errors.js";
import { parseObject } from "./utils.js";

export const PI_MODEL_PROVIDER_REQUIRED = "pi_model_provider_required";

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
  const parsed = parseObject(overrides);
  const overrideConfig = parseObject(parsed.adapterConfig);
  if (!("model" in overrideConfig)) return overrides;
  const model = overrideConfig.model;
  if (typeof model === "string" && /^[^/\s]+\/\S+$/.test(model)) return overrides;
  const savedModel = config.model;
  if (typeof model === "string" && model.length > 0 && !/[\s/]/.test(model)
    && typeof savedModel === "string" && /^[^/\s]+\/\S+$/.test(savedModel)) {
    return { ...parsed, adapterConfig: { ...overrideConfig, model: `${savedModel.slice(0, savedModel.indexOf("/"))}/${model}` } } as T;
  }
  throw unprocessable(
    `Pi cannot use chat model ${JSON.stringify(model)}: pick a provider/model, or clear the chat's model to use the agent default.`,
    { code: PI_MODEL_PROVIDER_REQUIRED, model, retryability: "requires_action" },
  );
}
