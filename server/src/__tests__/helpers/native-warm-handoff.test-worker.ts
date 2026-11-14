import { createDb } from "@paperclipai/db";
import { createServer } from "node:http";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import { executePaperclipNativeSession, closeWarmNativeSessionsForEnvironment } from "../../services/native-runtime/native-session-executor.js";
import { localSandboxCommandRunner } from "./local-sandbox-command-runner.js";

const api = createServer((_request, response) => response.writeHead(404).end());
registerLocalRuntimeApiServer(api);
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
process.send?.({ ready: true });
process.on("message", async (input: { connectionString: string; certificate: string; ingressUrl: string;
  suspend?: boolean; options: Parameters<typeof executePaperclipNativeSession>[0] }) => {
  try {
    setDefaultCACertificates([...getCACertificates("default"), input.certificate]);
    const target = input.options.runnerExecutionTarget;
    if (target?.kind !== "remote" || target.transport !== "sandbox") throw new Error("Expected sandbox target");
    const result = await executePaperclipNativeSession({ ...input.options, db: createDb(input.connectionString),
      runnerExecutionTarget: { ...target, runner: localSandboxCommandRunner(), getRunnerIngressEndpoint: async ({ path }) => {
        const endpoint = { kind: "authenticated_websocket" as const, websocketUrl: `${input.ingressUrl}${path}`,
          secretHeaders: [], generation: target.sandboxLeaseAcquisition!.providerLeaseId,
          refresh: async () => endpoint, close: async () => undefined };
        return endpoint;
      } }, onLog: async (stream, text) => { process.send?.({ log: { stream, text } }); } });
    if (input.suspend) {
      const closed = await closeWarmNativeSessionsForEnvironment({ environmentId: target.environmentId!, reason: "fixture idle timeout" });
      if (closed.closed !== 1 || closed.failed || closed.busy) throw new Error("Idle fixture did not suspend");
    }
    process.send?.({ result });
  } catch (error) { process.send?.({ error: error instanceof Error ? error.stack : String(error) }); }
});
