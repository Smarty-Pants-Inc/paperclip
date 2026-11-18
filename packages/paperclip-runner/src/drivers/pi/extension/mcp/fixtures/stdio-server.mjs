// Credential-free, finite MCP stdio fixture. Pi owns the real transport/client.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = process.argv[2];
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "nativehome-computer-fixture", version: "1.0.0" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Return a deterministic nonce", inputSchema: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"] } }] };
  else if (request.method === "tools/call" && request.params.name === "echo") {
    const nonce = request.params.arguments.nonce;
    appendFileSync(marker, JSON.stringify({ nonce }) + "\n");
    result = { content: [{ type: "text", text: nonce }] };
  } else if (request.method === "ping") result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
