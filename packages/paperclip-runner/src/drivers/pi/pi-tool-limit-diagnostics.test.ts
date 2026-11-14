import { describe, expect, it } from "vitest";
import { PI_TOOL_LIMIT_ENTRY, piToolLimitEntry, piToolLimitMessage } from "./pi-tool-limit-diagnostics.js";

// Keep reason: the diagnostic crosses the opaque extension-data trust boundary.
const origin = { epoch: 2, runId: "run", turnId: "turn" };
const entry = (data: Record<string, unknown> = {}) => ({ type: "custom", customType: PI_TOOL_LIMIT_ENTRY,
  data: { origin, api: "openai-completions", cap: 128, toolCount: 129, ...data } });
describe("owned Pi tool-limit entry", () => {
  it("reads only bounded numeric fields and origin, never private payloads", () => {
    const data = entry(); Object.defineProperty(data.data, "privatePayload", { get: () => { throw new Error("must not read"); } });
    expect(piToolLimitEntry(data)).toEqual({ origin, toolCount: 129 });
    expect(piToolLimitMessage(129)).toContain("129 tools");
    expect(piToolLimitMessage(129)).toContain("ask the board");
  });
  it.each([undefined, null, {}, { ...entry(), customType: "foreign" }, entry({ origin: { ...origin, epoch: 0 } }),
    entry({ api: "anthropic-messages" }), entry({ cap: 256 }), entry({ toolCount: 128 }), entry({ toolCount: NaN }), entry({ toolCount: 129.5 })])("rejects foreign or malformed entries %#", value => {
    expect(piToolLimitEntry(value)).toBeUndefined();
  });
  it("does not inspect foreign custom-entry data", () => {
    const foreign = { type: "custom", customType: "foreign" };
    Object.defineProperty(foreign, "data", { get: () => { throw new Error("must not read"); } });
    expect(piToolLimitEntry(foreign)).toBeUndefined();
  });
});
