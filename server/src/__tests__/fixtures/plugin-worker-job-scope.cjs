// Raw protocol probes complement the real SDK job fixture: a worker must not
// turn a forged or retired invocation id into configured-company authority.
const readline = require("node:readline");
let lastInvocationId;
let nextId = 0;
const pending = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
function config(original, invocationId, companyId = "company-a") {
  const id = `config-${++nextId}`;
  pending.set(id, original.id);
  send({ jsonrpc: "2.0", id, method: "config.get", params: { companyId },
    paperclipInvocationId: invocationId });
}
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    const id = pending.get(message.id);
    pending.delete(message.id);
    send({ jsonrpc: "2.0", id, ...(message.error ? { error: message.error } : { result: message.result }) });
    return;
  }
  switch (message.method) {
    case "initialize":
      reply(message.id, { ok: true, supportedMethods: ["runJob", "getData", "performAction"] });
      break;
    case "runJob":
      lastInvocationId = message.paperclipInvocation?.id;
      if (message.params.job.jobKey === "config") config(message, lastInvocationId);
      else if (message.params.job.jobKey !== "wait") reply(message.id, null);
      break;
    case "getData":
      if (message.params.key === "snapshot") reply(message.id, { invocationId: lastInvocationId });
      else config(message, message.params.params.invocationId);
      break;
    case "performAction":
      config(message, message.paperclipInvocation?.id, message.params.params.companyId);
      break;
    case "shutdown":
      reply(message.id, {});
      setImmediate(() => process.exit(0));
      break;
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unhandled method" } });
  }
});
