import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  cleanupGitHubOperationLaunchers,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  adapterExecutionTargetDuplexObservabilityRecorder,
  githubOperationLauncherDirectory,
  prepareGitHubOperationLaunchers,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import { githubBrokerEnvironment } from "@paperclipai/adapter-utils/github-launcher";

type Binding = { companyId: string; agentId: string; issueId: string; runId: string };
type LauncherInput = Parameters<typeof prepareGitHubOperationLaunchers>[0];
export type NativeGitHubAccess = Awaited<ReturnType<typeof createNativeGitHubAccess>>;

/** A process-lifetime transport, with authority only while its controller owns a run.
 * No run token or GitHub credential is stored in the provider's environment/files.
 * The resolver still checks the active run and current identity/grants per operation.
 */
export async function createNativeGitHubAccess(input: {
  scope: Omit<Binding, "runId">;
  target: LauncherInput["target"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  resolveCredentials: (binding: Binding) => Promise<unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}, startBridge = startAdapterExecutionTargetPaperclipBridge) {
  const duplexRequested = adapterExecutionTargetEnablesSandboxDuplexBridge(input.target);
  const token = randomBytes(32).toString("hex");
  const location = { runId: `native-session-${randomUUID()}`, target: input.target };
  let active: Binding | null = null;
  let activeGeneration: string | null = null;
  // Unlike the marker written into the sandbox for bridge bookkeeping, this
  // unguessable ticket is supplied only in the activated run's process env.
  let activeTicket: string | null = null;
  const runTicketGenerations = new Map<string, string>();
  let stopped = false;
  let ready = true;
  let stopping: Promise<void> | undefined;
  let bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    // Register before draining so even a zero-length or already-buffered body has
    // a completion fence. The generation and binding below are captured at headers.
    const bodyComplete = new Promise<void>(resolve => req.once("end", resolve));
    req.resume();
    const reply = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    const bearer = req.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"] ||
        Buffer.byteLength(bearer) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(bearer), Buffer.from(expected))) {
      reply(403, { error: "GitHub session authentication required" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/runtime-tools/github/credentials") {
      reply(404, { error: "Unknown GitHub session operation" });
      return;
    }
    const binding = active;
    const requestGeneration = req.headers["x-paperclip-bridge-generation"];
    const capturedGeneration = activeGeneration;
    // A readable attached:<generation> marker is not caller proof. Authenticate
    // with the ticket held by the requesting run's own inherited environment.
    const ticket = req.headers["x-paperclip-github-run-ticket"];
    const ticketGeneration = typeof ticket === "string" ? runTicketGenerations.get(ticket) : undefined;
    if (!binding || stopped || typeof ticket !== "string" || !activeTicket ||
        Buffer.byteLength(ticket) !== Buffer.byteLength(activeTicket) ||
        !timingSafeEqual(Buffer.from(ticket), Buffer.from(activeTicket)) || ticketGeneration !== capturedGeneration) {
      reply(403, { error: "No active GitHub run" });
      return;
    }
    const capturedTicket = activeTicket;
    const bridgedRequest = typeof req.headers["x-paperclip-run-id"] === "string";
    const queuedBridgeRequest = req.headers["x-paperclip-bridge-transport"] === "queue_v1";
    if (queuedBridgeRequest && typeof requestGeneration !== "string") {
      reply(403, { error: "GitHub bridge request has no run generation" });
      return;
    }
    try {
      await bodyComplete;
      if (stopped || active !== binding || activeGeneration !== capturedGeneration || activeTicket !== capturedTicket ||
          runTicketGenerations.get(capturedTicket) !== capturedGeneration ||
          ((queuedBridgeRequest || bridgedRequest) && typeof requestGeneration === "string" && requestGeneration !== capturedGeneration)) {
        reply(403, { error: "GitHub bridge request belongs to an inactive run generation" });
        return;
      }
      // Bind at receipt; body/headers cannot select a run or responsible user.
      const result = await input.resolveCredentials({ ...binding });
      if (active !== binding || stopped || activeTicket !== capturedTicket || activeGeneration !== capturedGeneration ||
          runTicketGenerations.get(capturedTicket) !== capturedGeneration) {
        reply(403, { error: "GitHub run ended during credential acquisition" });
        return;
      }
      reply(200, result);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // Never leak secret-store/provider errors. Preserve steering's retry signal.
      reply(status === 409 ? 409 : status === 403 ? 403 : 503,
        { error: "GitHub credentials unavailable" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const stop = () => stopping ??= (async () => {
    stopped = true;
    active = null;
    activeGeneration = null;
    activeTicket = null;
    runTicketGenerations.clear();
    bridge?.markOrderlyCompletion?.();
    server.closeAllConnections();
    const bridgeStop = await Promise.allSettled([bridge?.stop()]);
    const results = await Promise.allSettled([
      new Promise<void>(resolve => server.close(() => resolve())),
      cleanupGitHubOperationLaunchers(location),
    ]);
    if (bridgeStop.some(result => result.status === "rejected") || results.some(result => result.status === "rejected")) {
      await input.onLog?.("stderr", "[paperclip] GitHub session cleanup incomplete.\n").catch(() => undefined);
    }
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("GitHub broker did not listen");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      bridge = await startBridge({
        ...location,
        runtimeRootDir: input.target?.kind === "remote"
          ? githubOperationLauncherDirectory(location)
          : null,
        adapterKey: "native-github",
        hostApiToken: token,
        hostApiUrl: url,
        enableSandboxDuplexBridge: duplexRequested,
        startPaused: true,
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(input.target),
        onLog: input.onLog,
      });
      if (input.target?.kind === "remote" && !bridge) {
        throw new Error("GitHub session requires a remote callback bridge");
      }
    } catch {
      // GitHub remains optional. Stage anonymous wrappers for this session;
      // the supervisor retries transport setup on the next run.
      ready = false;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await input.onLog?.("stderr", "[paperclip] GitHub runtime transport unavailable; continuing without managed GitHub access.\n").catch(() => undefined);
    }
    const baseEnv = await prepareGitHubOperationLaunchers({
      ...location, cwd: input.cwd,
      env: {
        ...githubBrokerEnvironment({ PATH: input.env.PATH }, {
          url: ready ? bridge?.env.PAPERCLIP_API_URL ?? url : "",
          token: ready ? bridge?.env.PAPERCLIP_API_KEY ?? token : "",
        }),
        // Never retain an old run's bridge authentication override.
        PAPERCLIP_GITHUB_BRIDGE_TOKEN: ready ? bridge?.env.PAPERCLIP_API_KEY ?? token : "",
      },
    });
    return {
      get env() {
        return { ...baseEnv, PAPERCLIP_GITHUB_RUN_TICKET: ready ? activeTicket ?? "" : "" };
      },
      get ready() { return ready && !stopped && bridge?.readRunDisposition?.().failed !== true; },
      duplexRequested,
      async activate(binding: Binding) {
        if (stopped || active) throw new Error("GitHub session is closed or busy");
        if (binding.companyId !== input.scope.companyId || binding.agentId !== input.scope.agentId ||
            binding.issueId !== input.scope.issueId) throw new Error("GitHub session scope mismatch");
        // Quarantine requests left by the previous run and resume polling before
        // publishing this run's authority. The broker stays inactive throughout.
        const generation = randomUUID();
        const ticket = randomBytes(32).toString("hex");
        await bridge?.resume?.(generation);
        const owner = { ...binding };
        active = owner;
        activeGeneration = generation;
        activeTicket = ticket;
        runTicketGenerations.set(ticket, generation);
        return async () => {
          if (active === owner) {
            active = null;
            activeGeneration = null;
            if (activeTicket) runTicketGenerations.delete(activeTicket);
            activeTicket = null;
            await bridge?.pause?.();
          }
        };
      },
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
