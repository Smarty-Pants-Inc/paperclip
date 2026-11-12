import { describe, expect, it } from "vitest";
import { assertNativeMcpPolicy, describeNativeMcpCall } from "./policy.js";

const policy = { providerToolNames: ["read", "codemode"], launchToolSelectors: ["read", "codemode"], config: { mcpServers: { computer: { command: "computer" } } } };
const origin = { epoch: 2, runId: "run-2", turnId: "turn-2" };
const call = { toolCallId: "script-call/0", toolName: "mcp__computer__echo", parentToolCallId: "script-call" };
const parent = { toolCallId: "script-call", toolName: "codemode" };
const tools = [{ name: call.toolName, sourceInfo: { path: "builtin:mcp", source: "builtin" }, namespace: { name: "mcp__computer" } }];

describe("static native MCP codemode policy (trust boundary)", () => {
  it("admits default home codemode exposure with zero provider-facing mcp__ declarations", () => {
    expect(() => assertNativeMcpPolicy(policy)).not.toThrow();
  });
  it("rejects even one direct provider declaration; it must inspect the actual provider boundary", () => {
    expect(() => assertNativeMcpPolicy({ ...policy, providerToolNames: [...policy.providerToolNames, call.toolName] })).toThrow();
  });
  it.each(["mcp__*", "+mcp__computer__*", "-mcp__computer__echo"])("rejects %s --tools selectors", selector => {
    expect(() => assertNativeMcpPolicy({ ...policy, launchToolSelectors: [...policy.launchToolSelectors, selector] })).toThrow();
  });
  it.each(["direct", "deferred"])("rejects %s home exposure rather than rewriting the person's config", exposure => {
    expect(() => assertNativeMcpPolicy({ ...policy, config: { mcpServers: { computer: { command: "computer", exposure } } } })).toThrow();
    expect(() => assertNativeMcpPolicy({ ...policy, config: { mcpServers: { computer: { command: "computer", toolExposure: { echo: exposure } } } } })).toThrow();
  });
  it("requires active codemode and a post-start enabled computer source", () => {
    expect(() => assertNativeMcpPolicy({ ...policy, providerToolNames: ["read"] })).toThrow();
    expect(() => assertNativeMcpPolicy({ ...policy, config: { mcpServers: {} } })).toThrow();
    expect(() => assertNativeMcpPolicy({ ...policy, config: { mcpServers: { computer: { command: "computer", enabled: false } } } })).toThrow();
  });
  it("describes the real native nested path with immutable captured origin, not current run lookup", () => {
    const captured = describeNativeMcpCall({ event: call, parent, tools, origin });
    expect(captured).toEqual({ ...call, namespace: "mcp__computer", source: "builtin:mcp", origin });
    origin.runId = "run-after-bind";
    expect(captured.origin.runId).toBe("run-2");
    origin.runId = "run-2";
  });
  it("denies direct, mismatched parent and same-name replacement sources", () => {
    expect(() => describeNativeMcpCall({ event: { ...call, parentToolCallId: undefined }, parent, tools, origin })).toThrow();
    expect(() => describeNativeMcpCall({ event: call, parent: { ...parent, toolCallId: "other" }, tools, origin })).toThrow();
    expect(() => describeNativeMcpCall({ event: call, parent, tools: [{ ...tools[0], sourceInfo: { path: "/unadmitted/replacement.ts", source: "extension" } }], origin })).toThrow();
  });
});
