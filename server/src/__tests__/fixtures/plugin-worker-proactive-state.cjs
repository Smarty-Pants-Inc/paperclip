const readline = require("node:readline");

let nextId = 0;
const pending = new Map();
const keepers = new Map();
let lastKeeperInvocation;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (request, promise) => Promise.resolve(promise).then(
  result => send({ jsonrpc: "2.0", id: request.id, result }),
  error => send({ jsonrpc: "2.0", id: request.id, error }),
);
function requestHost(method, params, invocationId) {
  const id = `host-${++nextId}`;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({ jsonrpc: "2.0", id, method, params,
    ...(invocationId ? { paperclipInvocationId: invocationId } : {}) });
  return result;
}
const hostCall = (request, method, params, invocationId) => reply(request, requestHost(method, params, invocationId));

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error); else waiter.resolve(message.result);
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["executeTool", "getData", "performAction"] } });
  } else if ((message.method === "executeTool" && message.params.toolName === "keeper") ||
      (message.method === "performAction" && message.params.key === "keeper")) {
    const invocation = message.paperclipInvocation;
    lastKeeperInvocation = invocation;
    const key = message.params.parameters ?? message.params.params;
    let release;
    const resume = new Promise(resolve => { release = resolve; });
    // Start real keeper work INSIDE the live hook. It survives the hook's
    // response, retaining its original invocation id just like an SDK async task.
    const work = (async () => {
      const before = await requestHost("state.get", key, invocation.id);
      // Withhold the hook response to exercise the manager's real RPC deadline.
      if (!key.expire) send({ jsonrpc: "2.0", id: message.id, result: { invocation, before } });
      const operations = await resume;
      const results = [];
      for (const { method, params } of operations) results.push(await requestHost(method, params, invocation.id));
      if (key.expire) send({ jsonrpc: "2.0", id: message.id, result: { invocation, before } });
      return results;
    })();
    work.catch(() => {});
    keepers.set(invocation.id, { release, work });
  } else if (message.method === "executeTool" && message.params.toolName === "read-state") {
    hostCall(message, "state.get", message.params.parameters, message.paperclipInvocation.id);
  } else if (message.method === "performAction") {
    hostCall(message, "state.get", message.params.params, message.paperclipInvocation.id);
  } else if (message.method === "executeTool") {
    // Keep an unrelated agent invocation active while the keeper runs.
    hostCall(message, "companies.get", { companyId: message.params.runContext.companyId }, message.paperclipInvocation.id);
  } else if (message.method === "getData" && message.params.key === "keeper-capture") {
    send({ jsonrpc: "2.0", id: message.id, result: { invocation: lastKeeperInvocation } });
  } else if (message.method === "getData" && message.params.key === "keeper-resume") {
    const { invocationId, operations } = message.params.params;
    const keeper = keepers.get(invocationId);
    keepers.delete(invocationId);
    keeper.release(operations);
    reply(message, keeper.work);
  } else if (message.method === "getData" && message.params.key === "notification") {
    const { method, params, invocationId } = message.params.params;
    setTimeout(() => {
      send({ jsonrpc: "2.0", method, params, ...(invocationId ? { paperclipInvocationId: invocationId } : {}) });
      send({ jsonrpc: "2.0", id: message.id, result: null });
    }, 0);
  } else if (message.method === "getData") {
    const { method, params, invocationId } = message.params.params;
    setTimeout(() => hostCall(message, method, params, invocationId), 0);
  } else if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
  }
});
