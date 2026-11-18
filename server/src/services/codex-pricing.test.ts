import { describe, expect, it } from "vitest";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { priceCodexReceipt } from "./codex-pricing.js";

const receipt: AdapterUsageCheckpoint = { complete: true, usageBasis: "per_run", provider: "openai", biller: "openai",
  billingType: "metered_api", model: "paperclip/gpt-6-astra", costUsd: null, costStatus: "unpriced",
  usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 10, outputTokens: 5 } };

describe("complete OpenAI receipt pricing", () => {
  it("prices a single Paperclip gateway namespace against the exact model card", () => {
    const priced = priceCodexReceipt(receipt);
    expect(priced.costUsdExact).toBe("0.001295000");
    expect(priced.costStatus).toBe("estimated");
  });

  it("does not guess nested or unknown gateway model identities", () => {
    for (const model of ["paperclip/gateway/gpt-6-astra", "paperclip/gpt-6-astra-custom"]) {
      const original = { ...receipt, model };
      expect(priceCodexReceipt(original)).toBe(original);
    }
  });
});
