import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { PiRpcDriver } from "../../../../packages/paperclip-runner/src/drivers/pi/pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "../../../../packages/paperclip-runner/src/drivers/pi/pi-rpc-transport.js";

export type CapturedPiModelRequest = { at: number; input: string; body: Record<string, unknown> };

/** Real Pi, with only inference controlled. Capture bytes at the model HTTP
 * boundary, not wake ids or a synthesized userMessage receipt. No paid provider
 * or credentials. PI_TEST_BINARY selects the pinned runtime; otherwise use pi.
 */
export async function openPiModelInputPeer(root: string, runId: string, heldTool = false) {
  const modelRequests: CapturedPiModelRequest[] = [];
  const commands: Array<{ type: string; input?: PiRpcRecord }> = [];
  const gates = new Set<ServerResponse>();
  let released = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/gate") {
      if (released) res.end("tool finished");
      else gates.add(res);
      return;
    }
    try {
      let bytes = "";
      for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes) as Record<string, unknown>;
      const messages = body.messages as Array<{ role?: string; content?: unknown }>;
      const input = messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content
        : Array.isArray(message.content) ? message.content.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "").join("\n");
      modelRequests.push({ at: Date.now(), input, body });
      const n = modelRequests.length;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
        id: `queue-model-${n}`, object: "chat.completion.chunk", model: "faux", choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      if (heldTool && n === 1) {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Model peer has no loopback port");
        const script = `fetch("http://127.0.0.1:${address.port}/gate").then(r=>r.text()).then(console.log)`;
        const command = `${JSON.stringify(process.execPath)} -e '${script}'`;
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "held-model-tool", type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command }) } }] });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "Answered the received queue input." });
        chunk({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model peer has no loopback port");
  const releaseBoundary = () => {
    released = true;
    for (const gate of gates) gate.end("tool finished");
    gates.clear();
  };
  try {
    const session = await new PiRpcDriver({
      command: process.env.PI_TEST_BINARY ?? "pi", model: "paperclip/faux", piRpcThinkingLevel: "off",
      runtimeDirectory: join(root, "model-sessions"), shutdownTimeoutMs: 1000,
      environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "model-agent"), HOME: root,
        PATH: process.env.PATH ?? "", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`,
        PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      transportFactory: options => {
        const transport = new PiRpcTransport(options);
        const request = transport.request.bind(transport);
        transport.request = (type, input) => { commands.push({ type, input }); return request(type, input); };
        return transport;
      },
    }).openSession({ runId, normalizedSessionId: `model-input-${runId}`, workingDirectory: root });
    return { session, modelRequests, commands, releaseBoundary,
      async close() {
        releaseBoundary();
        try { await session.close({ reason: "model-input peer cleanup" }); }
        finally {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      },
    };
  } catch (error) {
    releaseBoundary();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
}

/** Feed the adapter's production-rendered input to Pi and retain the actual
 * request observed by its model. One model response, no tools or follow-ups.
 */
export async function capturePiModelInput(root: string, runId: string, input: string) {
  const peer = await openPiModelInputPeer(root, runId);
  let terminal!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { terminal = resolve; fail = reject; });
  const pump = (async () => {
    for await (const event of peer.session.events()) {
      if (event.eventType === "turn.completed") terminal();
      if (event.eventType === "turn.failed") fail(new Error(JSON.stringify(event)));
    }
  })().catch(fail);
  const timer = setTimeout(() => fail(new Error("Pi model-input capture did not finish")), 10_000);
  try {
    await peer.session.startTurn({ message: { role: "user", text: input } });
    await done;
    return peer.modelRequests;
  } finally {
    clearTimeout(timer);
    await peer.close();
    await pump;
  }
}
