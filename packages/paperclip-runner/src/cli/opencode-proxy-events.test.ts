import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  boundedOpenCodeTerminalError,
  openCodeProxyAssistantText,
  openCodeProxyItemNotification,
  openCodeProxyTerminalNotification,
  openCodeProxyToolNotification,
  shouldAnnounceOpenCodeProxyTurn,
  shouldForwardOpenCodeProxyItem,
} from "./opencode-proxy-events.js";
import { createOpenCodeProxyOutput } from "./opencode-proxy-output.js";

// Shared with runner-core: the exact producer frame, not a hand-built Rust shape.
const reasoningFixture = JSON.parse(readFileSync(new URL("../../test/fixtures/pi-facade-reasoning-delta.json", import.meta.url), "utf8"));
const methodRows = JSON.parse(readFileSync(new URL("../../test/fixtures/pi-facade-methods.json", import.meta.url), "utf8")) as Array<{
  producer: "item" | "tool" | "terminal"; eventType: string; kind?: string; method: string; event?: string; drop?: string;
}>;

describe("OpenCode runnerd proxy event boundary", () => {
  it("pins the whole Pi reasoning notification shared with the Rust outbox test", () => {
    // delta and item are facade output, not fields supplied by the Pi projector.
    const { delta: _delta, item: _item, threadId, turnId, itemId, ...payload } = reasoningFixture.params;
    expect([...payload.text].length).toBeGreaterThanOrEqual(6_000);
    expect(Buffer.byteLength(payload.text)).toBeGreaterThan(payload.text.length);
    expect(openCodeProxyItemNotification({ eventType: "item.delta", threadId, turnId, itemId, payload })).toEqual(reasoningFixture);
  });

  it("keeps the shared method table exhaustive against the facade source", () => {
    const source = readFileSync(new URL("./opencode-proxy-events.ts", import.meta.url), "utf8");
    const body = (name: string) => source.split(`export function ${name}(`)[1]!.split("\nexport function ")[0]!;
    const item = body("openCodeProxyItemNotification");
    const terminal = body("openCodeProxyTerminalNotification");
    const tool = body("openCodeProxyToolNotification");
    const eventTypes = (text: string) => [...text.split("threadId:")[0]!.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
    const itemTypes = eventTypes(item);
    const terminalTypes = eventTypes(terminal);
    const toolPhases = [...tool.split("if (!phase)")[0]!.matchAll(/"([^"]+)": "([^"]+)"/g)];
    const methodExpression = item.split("const method =")[1]!.split("const providerItem")[0]!;
    const explicitMethods = [...methodExpression.matchAll(/"([^"]+)"/g)].map(match => match[1]!)
      .filter(value => !itemTypes.includes(value) && value !== "." && value !== "/");
    // Derive the fallback family from EVERY eventType in the real signature,
    // all explicit method literals (not just names starting item/), and tools.
    const methods = new Set([
      ...itemTypes.map(type => type.replace(".", "/")),
      ...terminalTypes.map(type => type.replace(".", "/")),
      ...explicitMethods,
      ...[...source.matchAll(/method: "([^"]+)"/g)].map(match => match[1]!),
      ...toolPhases.map(match => `item/${match[2]}`),
    ]);
    expect([...new Set(methodRows.map(row => row.method))].sort()).toEqual([...methods].sort());
    const inputs = [...itemTypes.map(type => `item:${type}`), ...terminalTypes.map(type => `terminal:${type}`), ...toolPhases.map(match => `tool:${match[1]}`)];
    expect([...new Set(methodRows.map(row => `${row.producer}:${row.eventType}`))].sort()).toEqual(inputs.sort());
  });

  it.each(methodRows)("emits shared method row $producer/$eventType/$kind -> $method", row => {
    const input = { eventType: row.eventType, threadId: "pi-session", turnId: "turn-1", itemId: "fixture-item",
      payload: row.producer === "tool"
        ? { schema: "paperclip.tool.execution.v1", executionId: "fixture-item", transport: "builtin", name: "read", output: "tool output" }
        : { kind: row.kind, text: "fixture text" } };
    const frame = row.producer === "tool" ? openCodeProxyToolNotification(input)
      : row.producer === "terminal" ? openCodeProxyTerminalNotification(input as Parameters<typeof openCodeProxyTerminalNotification>[0])
      : openCodeProxyItemNotification(input as Parameters<typeof openCodeProxyItemNotification>[0]);
    expect(frame?.method).toBe(row.method);
  });
  it("drops only the duplicate session-scoped model item", () => {
    expect(shouldForwardOpenCodeProxyItem({ payload: { kind: "model" } })).toBe(false);
    expect(
      shouldForwardOpenCodeProxyItem({
        turnId: "turn-1",
        payload: { kind: "model" },
      }),
    ).toBe(true);
    expect(shouldForwardOpenCodeProxyItem({ payload: { kind: "agentMessage" } })).toBe(true);
  });

  it("keeps per-token deltas runnerd discards from queueing ahead of a tool call", () => {
    const framesBeforeToolCall = (tokens: number) => {
      vi.useFakeTimers();
      try {
        const written: Array<{ method?: string }> = [];
        const output = createOpenCodeProxyOutput(frame => written.push(frame as { method?: string }));
        const forward = (eventType: "item.started" | "item.delta" | "item.completed", itemId: string, payload: Record<string, unknown>) => {
          if (shouldForwardOpenCodeProxyItem({ eventType, turnId: "turn-1", payload }))
            output.send(openCodeProxyItemNotification({ eventType, threadId: "thread-1", turnId: "turn-1", itemId, payload }));
        };
        for (let index = 0; index < tokens; index += 1) {
          forward("item.delta", "reasoning-1", { kind: "reasoning", channel: "detail", providerPhase: "reasoning", text: `token ${index} `,
            item: { id: "reasoning-1", type: "reasoning", text: `token ${index} ` } });
          forward("item.delta", "tool-1", { kind: "tool", text: `line ${index}\n`, item: { id: "tool-1", type: "tool", state: { status: "running" } } });
        }
        forward("item.completed", "reasoning-1", { kind: "reasoning", text: "Reasoning summary.",
          item: { id: "reasoning-1", type: "reasoning", text: "Reasoning summary." } });
        output.send({ id: "opencode-1", method: "item/tool/call", params: { tool: "search_api" } });
        const position = written.findIndex(frame => frame.method === "item/tool/call");
        expect(position).toBeGreaterThanOrEqual(0);
        expect(written.some(frame => frame.method === "item/delta")).toBe(false);
        expect(written.at(position - 1)).toMatchObject({ method: "item/completed", params: { kind: "reasoning" } });
        return position;
      } finally {
        vi.useRealTimers();
      }
    };
    expect(framesBeforeToolCall(1_000)).toBe(framesBeforeToolCall(1));
  });

  it("still forwards streamed assistant text for runnerd's live reply", () => {
    const payload = { kind: "agentMessage", channel: "progress", text: "Checking the plugin.", item: { type: "agentMessage" } };
    expect(shouldForwardOpenCodeProxyItem({ eventType: "item.delta", turnId: "turn-1", payload })).toBe(true);
    expect(shouldForwardOpenCodeProxyItem({ eventType: "item.delta", turnId: "turn-1",
      payload: { kind: "text", text: "Legacy text part." } })).toBe(true);
    expect(shouldForwardOpenCodeProxyItem({ eventType: "item.delta", turnId: "turn-1",
      payload: { kind: "reasoning", text: "Private reasoning" } })).toBe(false);
    expect(shouldForwardOpenCodeProxyItem({ eventType: "item.completed", turnId: "turn-1",
      payload: { kind: "reasoning", text: "Private reasoning" } })).toBe(true);
  });

  it("announces one outer turn when SSE wins the response race", () => {
    const announced = new Set<string>();
    expect(shouldAnnounceOpenCodeProxyTurn(announced, "turn-1")).toBe(true);
    expect(shouldAnnounceOpenCodeProxyTurn(announced, "turn-1")).toBe(false);
    expect([...announced]).toEqual(["turn-1"]);
  });

  it("recognizes canonical progress messages without dropping legacy text events", () => {
    expect(
      openCodeProxyAssistantText({
        kind: "agentMessage",
        channel: "progress",
        providerPhase: "commentary",
        text: "Inspecting the workspace.",
      }),
    ).toBe("Inspecting the workspace.");
    expect(
      openCodeProxyAssistantText({
        kind: "text",
        text: "Legacy OpenCode text.",
      }),
    ).toBe("Legacy OpenCode text.");
    expect(
      openCodeProxyAssistantText({
        kind: "dynamicToolCall",
        text: "not assistant prose",
      }),
    ).toBeNull();

    expect(
      openCodeProxyItemNotification({
        eventType: "item.delta",
        threadId: "session-1",
        turnId: "turn-1",
        itemId: "message-1",
        payload: {
          kind: "agentMessage",
          channel: "progress",
          providerPhase: "commentary",
          text: "Inspecting the workspace.",
          item: {
            id: "message-1",
            type: "agentMessage",
            channel: "progress",
            phase: "commentary",
            text: "Inspecting the workspace.",
          },
        },
      }),
    ).toEqual({
      method: "item/agentMessage/delta",
      params: {
        threadId: "session-1",
        turnId: "turn-1",
        itemId: "message-1",
        kind: "agentMessage",
        channel: "progress",
        providerPhase: "commentary",
        text: "Inspecting the workspace.",
        delta: "Inspecting the workspace.",
        item: {
          id: "message-1",
          type: "agentMessage",
          channel: "progress",
          phase: "commentary",
          text: "Inspecting the workspace.",
        },
      },
    });
  });

  it("preserves actionable OpenCode failure details on the production facade frame", () => {
    expect(
      openCodeProxyTerminalNotification({
        eventType: "turn.failed",
        threadId: "session-1",
        turnId: "turn-1",
        payload: {
          status: "failed",
          error: {
            code: "provider_rate_limited",
            message: "The provider rejected this request.",
            retryAfterMs: 1_500,
          },
        },
      }),
    ).toEqual({
      method: "turn/failed",
      params: {
        threadId: "session-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            code: "provider_rate_limited",
            message: "The provider rejected this request.",
            retryAfterMs: 1_500,
          },
        },
      },
    });
  });

  it("bounds oversized OpenCode failure details without losing their diagnosis", () => {
    const error = boundedOpenCodeTerminalError({
      code: "provider_failure",
      message: "actionable failure",
      debug: "x".repeat(70 * 1024),
    });
    expect(error).toEqual({
      code: "provider_failure",
      message: "actionable failure",
      omitted: true,
      reason: "payload_limit",
    });
    expect(Buffer.byteLength(JSON.stringify(error), "utf8")).toBeLessThan(
      64 * 1024,
    );
  });
});
