// Synthetic image framing regression: real child/stdio, no plugin logger calls.
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
readline.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { ok: true, supportedMethods: ["executeTool"] } });
  if (request.method === "shutdown") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return setImmediate(() => process.exit(0));
  }
  const data = Buffer.from("private malformed frame bytes: never preview this").toString("base64");
  const reply = { jsonrpc: "2.0", id: request.id, result: { mcpContent: [{ type: "image", data, mimeType: "image/png" }] } };
  const invalid = request.params.parameters.mode === "version"
    ? JSON.stringify({ ...reply, jsonrpc: `data:image/png;base64,${data}` })
    : JSON.stringify(reply).slice(0, -1);
  reply.result.framing = { sizeBytes: Buffer.byteLength(invalid), sha256: require("node:crypto").createHash("sha256").update(invalid).digest("hex") };
  // A bad frame must not poison the next valid reply or leak into a host log.
  process.stdout.write(invalid + "\n" + JSON.stringify(reply) + "\n");
});
