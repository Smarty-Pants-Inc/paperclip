import { PAPERCLIP_RUNNER_PI_RPC_THINKING_LEVELS, type AdapterModel } from "@paperclipai/adapter-utils";

export type PiRpcModelCapabilities = Pick<AdapterModel, "id" | "thinkingLevels" | "family">;

/** Catalog capabilities narrow native Pi choices; admission remains server-owned. */
export function piRpcThinkingLevelsForModel(model: string, row?: PiRpcModelCapabilities): readonly string[] {
  return PAPERCLIP_RUNNER_PI_RPC_THINKING_LEVELS.filter(level =>
    (!row?.thinkingLevels || row.thinkingLevels.includes(level)));
}
