import { describe, expect, it } from "vitest";
import { piRpcThinkingLevelsForModel } from "./pi-rpc-thinking";

describe("Pi RPC model thinking levels", () => {
  it("passes through every catalog-admitted level, including Claude max", () => {
    expect(piRpcThinkingLevelsForModel("paperclip/claude-opus-5-5", {
      id: "paperclip/claude-opus-5-5", family: "Claude", thinkingLevels: ["off", "high", "xhigh", "max"],
    })).toEqual(["off", "high", "xhigh", "max"]);
  });
  it("uses Pi's catalog levels without adding a provider-specific clamp", () => {
    expect(piRpcThinkingLevelsForModel("paperclip/claude-opus-5-5")).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(piRpcThinkingLevelsForModel("paperclip/gpt-6", { id: "paperclip/gpt-6", thinkingLevels: ["max"] })).toEqual(["max"]);
  });
});
