import type { ServerResponse } from "node:http";

// Exact production setup prompt. Ordinary turns (including mentions in history)
// must retain their script slots; never classify by model name or tool presence.
const helloPrompt = "Respond only with hello. Do not use tools or inspect files.";
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function isNativePiHelloRequest(value: unknown): boolean {
  const body = record(value);
  if (typeof body.input === "string") return body.input.trim() === helloPrompt;
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const latest = record(messages.at(-1));
  if (latest.role !== "user") return false;
  const parts = typeof latest.content === "string" ? [{ type: "text", text: latest.content }] : latest.content;
  return Array.isArray(parts) && parts.some(part => {
    const content = record(part);
    return ["text", "input_text"].includes(String(content.type)) && typeof content.text === "string" && content.text.trim() === helloPrompt;
  });
}

/** A real loopback provider response, not a probe bypass or scripted run turn. */
export function respondToNativePiHello(value: unknown, res: ServerResponse, protocol: string): boolean {
  if (!isNativePiHelloRequest(value)) return false;
  const model = record(value).model;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (type: string, payload: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  if (protocol === "messages") {
    emit("message_start", { message: { id: "setup-hello", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } });
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    emit("message_stop", {});
    res.end();
  } else if (protocol === "chat") {
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]) res.write(`data: ${JSON.stringify({ id: "setup-hello", object: "chat.completion.chunk", model, ...chunk })}\n\n`);
    res.end("data: [DONE]\n\n");
  } else if (protocol === "responses") {
    const message = { id: "setup-hello-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] };
    const response = { id: "setup-hello", object: "response", status: "completed", model, output: [message], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
    emit("response.content_part.added", { item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: "hello" });
    emit("response.output_text.done", { item_id: message.id, output_index: 0, content_index: 0, text: "hello" });
    emit("response.content_part.done", { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
    emit("response.output_item.done", { output_index: 0, item: message });
    emit("response.completed", { response });
    res.end();
  } else throw new Error(`Unsupported native Pi loopback protocol: ${protocol}`);
  return true;
}
