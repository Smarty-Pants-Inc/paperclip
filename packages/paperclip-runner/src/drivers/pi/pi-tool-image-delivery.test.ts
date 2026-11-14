// Keep: MCP/provider trust boundary. Exercise the pinned Pi provider serializers,
// not a mock serializer. No credentials or network/model calls.
import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";

const data = Buffer.from("synthetic image serializer acceptance").toString("base64");
const image = { type: "image", data, mimeType: "image/png" };
const model = (api: string, provider: string) => ({
  id: "image-test", name: "Image test", api, provider, baseUrl: "https://never-used.invalid",
  input: ["text", "image"], reasoning: false, contextWindow: 100000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}) as any;
const context = (api: string, provider: string) => ({ messages: [
  { role: "user", content: "Inspect one frame", timestamp: 1 },
  { role: "assistant", content: [{ type: "toolCall", id: "frame1", name: "capture_frame", arguments: {} }], api, provider, model: "image-test", stopReason: "toolUse", timestamp: 2,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  { role: "toolResult", toolCallId: "frame1", toolName: "capture_frame", content: [{ type: "text", text: "one frame" }, image], isError: false, timestamp: 3 },
] }) as any;

describe("pinned Pi tool-result image delivery", () => {
  it("places an image block in Anthropic's tool_result content", async () => {
    let payload: any;
    const stream = anthropicStream(model("anthropic-messages", "anthropic"), context("anthropic-messages", "anthropic"), {
      client: { beta: { messages: { create() { throw new Error("Network must never run"); } } } } as any,
      onPayload(value) { payload = value; throw new Error("Stop before network"); },
    });
    await stream.result();
    const blocks = payload.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
    const result = blocks.find((block: any) => block.type === "tool_result");
    expect(result.content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  });

  it("delivers a Chat Completions image as an adjacent user image_url message", () => {
    const messages = convertMessages(model("openai-completions", "openai"), context("openai-completions", "openai"), {} as any);
    const blocks = messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
    expect(blocks).toContainEqual(expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: `data:image/png;base64,${data}` }) }));
  });

  it("records the upstream limitation: Chat Completions text-only models omit tool images", () => {
    const textModel = { ...model("openai-completions", "openai"), input: ["text"] };
    expect(JSON.stringify(convertMessages(textModel, context("openai-completions", "openai"), {} as any))).not.toContain(data);
  });
});
