const readline = require("node:readline");

let nextId = 0;
const pending = new Map();
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

function hostCall(request, method, params, invocationId) {
  const id = `host-${++nextId}`;
  pending.set(id, request.id);
  send({ jsonrpc: "2.0", id, method, params,
    ...(invocationId ? { paperclipInvocationId: invocationId } : {}) });
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    const id = pending.get(message.id);
    pending.delete(message.id);
    send({ jsonrpc: "2.0", id, ...(message.error ? { error: message.error } : { result: message.result }) });
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["executeTool", "getData", "performAction"] } });
  } else if (message.method === "executeTool" && message.params.toolName === "read-state") {
    hostCall(message, "state.get", message.params.parameters, message.paperclipInvocation.id);
  } else if (message.method === "performAction") {
    hostCall(message, "state.get", message.params.params, message.paperclipInvocation.id);
  } else if (message.method === "executeTool") {
    // The host holds this nested call until the test releases it. Its echoed id
    // proves that an actual agent-origin invocation remains active at the host.
    hostCall(message, "companies.get", { companyId: message.params.runContext.companyId }, message.paperclipInvocation.id);
  } else if (message.method === "getData" && message.params.key === "notification") {
    const { method, params } = message.params.params;
    setTimeout(() => {
      send({ jsonrpc: "2.0", method, params });
      // Stdout ordering makes this a barrier after the notification dispatch.
      send({ jsonrpc: "2.0", id: message.id, result: null });
    }, 0);
  } else if (message.method === "getData") {
    // A separate timer deliberately has no invocation id, as a plugin keeper
    // would. Never copy getData's id (or the concurrently running agent's id).
    const { method, params, invocationId } = message.params.params;
    setTimeout(() => hostCall(message, method, params, invocationId), 0);
  } else if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
  }
});
