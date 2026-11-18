import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { isNativePiHelloRequest, respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

const prompt = "Respond only with hello. Do not use tools or inspect files.";
const hello = { model: "faux", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
describe("native Pi faux-model setup isolation", () => {
  it("matches the exact current user prompt in all provider formats", () => {
    expect(isNativePiHelloRequest(hello)).toBe(true);
    expect(isNativePiHelloRequest({ messages: [{ role: "user", content: prompt }] })).toBe(true);
    expect(isNativePiHelloRequest({ input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }] })).toBe(true);
    expect(isNativePiHelloRequest({ input: prompt })).toBe(true);
  });
  it.each([{}, { messages: [{ role: "assistant", content: prompt }] },
    { messages: [...hello.messages, { role: "user", content: "Run the task" }] },
    { messages: [{ role: "user", content: `Quoted earlier prompt: ${prompt}` }] },
    { messages: [{ role: "user", content: "hello" }] }, { input: [{ type: "function_call_output", output: prompt }] },
  ])("does not consume or answer an ordinary scripted turn: %j", request => {
    const res = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
    expect(respondToNativePiHello(request, res as unknown as ServerResponse, "messages")).toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled(); expect(res.write).not.toHaveBeenCalled(); expect(res.end).not.toHaveBeenCalled();
  });
  it.each(["messages", "chat", "responses"])("emits only a settled hello, never a tool, for %s", protocol => {
    const res = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
    expect(respondToNativePiHello(hello, res as unknown as ServerResponse, protocol)).toBe(true);
    const output = [...res.write.mock.calls, ...res.end.mock.calls].flat().join("");
    expect(output).toContain("hello"); expect(output).not.toMatch(/tool_use|function_call|bash|sleep/);
    expect(output).toContain(protocol === "messages" ? "message_stop" : protocol === "chat" ? "[DONE]" : "response.completed");
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
