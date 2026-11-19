import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { PiRpcTransport, type PiRpcRecord, type PiRpcTransportOptions } from "../../../../packages/paperclip-runner/src/drivers/pi/pi-rpc-transport.js";

/** Real pinned Pi process; only its credential-free loopback model is scripted.
 * Hold the first provider response until all POSTs have crossed the real route.
 * Pi itself drains one steering input at each tool boundary. */
export class B6RealPiPeer {
  requests: Array<{ type: string; input?: PiRpcRecord; at: number }> = [];
  facadeCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  consumed: string[] = []; replies: string[] = []; pending: string[] = [];
  sessionFile?: string; transport?: PiRpcTransport; active = false;
  held?: () => void; released = false; finishing = false; initialTool = false;
  bodies: string[] = [];
  beforeBoundary?: () => Promise<void>;
  releasing?: Promise<void>;
  closeGate?: Promise<void>;
  holdClose() {
    let release!: () => void; this.closeGate = new Promise<void>(resolve => { release = resolve; });
    return release;
  }
  seen = new Set<string>(); answered = new Set<string>(); modelRequests: unknown[] = [];
  get pid() { return this.transport?.pid ?? null; }
  get exited() { return this.transport?.exited ?? false; }
  modelUrl = "";
  server = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body); this.modelRequests.push(parsed);
        for (const message of parsed.messages ?? []) if (message.role === "user") {
          const content = typeof message.content === "string" ? message.content : (message.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
          let initialPrompt: string | undefined;
          try { initialPrompt = JSON.parse(content).task?.prompt; } catch { /* An ordinary steered user message is plain text. */ }
          for (const marker of this.bodies) if (content.trim() === marker || initialPrompt?.includes(marker)) this.seen.add(marker);
        }
        const respond = () => {
          const done = (this.bodies.length > 0 && this.bodies.every(body => this.seen.has(body))) || (this.finishing && !this.pending.length);
          const fresh = [...this.seen].filter(s => !this.answered.has(s));
          for (const marker of fresh) { this.answered.add(marker); this.replies.push(`ANSWER:${marker}`); }
          const text = fresh.length ? fresh.map(s => `ANSWER:${s}`).join("\n") : done ? "ORIGINAL_WORK_FINISHED" : undefined;
          this.respond(res, parsed.model, text, !done);
        };
        if (!this.released && !(this.initialTool && this.modelRequests.length === 1)) this.held = respond; else respond();
      } catch (error) { res.writeHead(500).end(String(error)); }
    });
  });
  async start() {
    await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address(); if (!addr || typeof addr === "string") throw new Error("No B6 model listener");
    this.modelUrl = `http://127.0.0.1:${addr.port}`;
  }
  environment(agentHome: string) {
    return { PI_CODING_AGENT_DIR: agentHome, PAPERCLIP_AI_PROVIDER_URL: this.modelUrl,
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none", PI_OFFLINE: "1" };
  }
  command = fileURLToPath(new URL("../../../../packages/paperclip-runner/node_modules/.bin/pi", import.meta.url));
  attach(options: PiRpcTransportOptions) { this.transport = new PiRpcTransport(options); return this as unknown as PiRpcTransport; }
  async request(type: string, input?: PiRpcRecord, options?: any) {
    this.requests.push({ type, input, at: Date.now() });
    if (type === "prompt") this.active = true;
    if (type === "steer") this.pending.push(String(input?.message));
    return this.transport!.request(type, input, options);
  }
  async *events() {
    for await (const event of this.transport!.events()) {
      const message = event.message as any;
      if (event.type === "message_start" && message?.role === "user") {
        const text = (message.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
        const index = this.pending.indexOf(text);
        if (index >= 0) { this.pending.splice(index, 1); this.consumed.push(text); }
      }
      if (event.type === "agent_settled") this.active = false;
      yield event;
    }
  }
  boundary() {
    this.releasing ??= (async () => {
      // The loopback model is a controlled boundary, not a speed benchmark.
      // Release only after the fixture's native ACK receipts have caught up;
      // raw Pi reads must not race an unrelated initial event-ingestion backlog.
      await this.beforeBoundary?.();
      this.released = true; const held = this.held; this.held = undefined; held?.();
    })();
    void this.releasing.catch(() => undefined); // close joins and reports it
  }
  finish() { this.finishing = true; this.boundary(); }
  send(event: PiRpcRecord) { if (event.type === "process_exit") void this.transport?.close(); }
  async close() {
    try { await this.releasing; await this.closeGate; }
    finally {
      await this.transport?.close();
      this.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => this.server.close(error => error && (error as any).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    }
  }
  respond(res: ServerResponse, model: unknown, text: string | undefined, keepGoing: boolean) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit("message_start", { message: { id: `b6-${this.modelRequests.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    let index = 0;
    if (text !== undefined) {
      emit("content_block_start", { index, content_block: { type: "text", text: "" } });
      emit("content_block_delta", { index, delta: { type: "text_delta", text } });
      emit("content_block_stop", { index }); index++;
    }
    if (keepGoing) {
      emit("content_block_start", { index, content_block: { type: "tool_use", id: `b6-tool-${this.modelRequests.length}`, name: "bash", input: {} } });
      emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "true" }) } });
      emit("content_block_stop", { index });
    }
    emit("message_delta", { delta: { stop_reason: keepGoing ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
    emit("message_stop", {}); res.end();
  }
}
