import { expect, it } from "vitest";
import { aiConnectionBindingSchema, isAiConnectionCompatible } from "./ai-connections.js";
import type { AiProviderRouting } from "./ai-provider-routing.js";

const binding = aiConnectionBindingSchema.parse({
  provider: "anthropic", method: "api_key", mode: "shared",
  connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222",
});
const model = "paperclip/claude-opus-5-5";
const routing: AiProviderRouting = {
  kind: "gateway", protocol: "messages", baseUrl: "https://gateway.example/v1", auth: "bearer", models: [{ id: model }],
};

it.each(["shared", "delegated"] as const)("defers a native Pi %s binding's model prefix to authoritative metadata", mode => {
  const selected = { ...binding, mode };
  // These are the two checks performed by aiConnectionService.select.
  expect(isAiConnectionCompatible(selected, "paperclip_runner", model, "pi_rpc")).toBe(true);
  expect(isAiConnectionCompatible(selected, "pi_rpc", model)).toBe(true);
  expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key", routing }, "paperclip_runner", model, "pi_rpc")).toBe(true);
});

it.each(["messages", "responses", "chat"] as const)("keeps native Pi's authoritative %s protocol check", protocol => {
  expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key", routing: { ...routing, protocol } }, "paperclip_runner", model, "pi_rpc")).toBe(protocol !== "chat");
});

it("does not loosen unrouted metadata, subscription, responsible-user, legacy Pi or ACPX/Pi checks", () => {
  expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key" }, "paperclip_runner", model, "pi_rpc")).toBe(false);
  expect(isAiConnectionCompatible({ ...binding, method: "subscription" }, "paperclip_runner", model, "pi_rpc")).toBe(false);
  expect(isAiConnectionCompatible({ provider: "anthropic", method: "api_key", mode: "responsible_user" }, "paperclip_runner", model, "pi_rpc")).toBe(false);
  expect(isAiConnectionCompatible(binding, "pi_local", model)).toBe(false);
  expect(isAiConnectionCompatible(binding, "paperclip_runner", model, "acpx", "pi")).toBe(false);
  expect(isAiConnectionCompatible(binding, "paperclip_runner", "anthropic/model", "acpx", "pi")).toBe(true);
  expect(isAiConnectionCompatible(binding, "pi_local", "anthropic/model")).toBe(true);
});
