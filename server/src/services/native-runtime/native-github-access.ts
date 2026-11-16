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
import {
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_RESPONSE_TIMEOUT_MS,
} from "@paperclipai/adapter-utils/sandbox-callback-bridge";
import { githubBrokerEnvironment } from "@paperclipai/adapter-utils/github-launcher";

type Binding = { companyId: string; agentId: string; issueId: string; runId: string };
type LauncherInput = Parameters<typeof prepareGitHubOperationLaunchers>[0];
type AccessTransport = "callback_bridge" | "runner_ingress";
type GitHubAccessFallbackReason = "capability_absent" | "ingress_unready" | "disconnect";
export type NativeGitHubAccessHttpRequest = {
  kind: "github_access.http";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string;
};
export type NativeGitHubAccessHttpReply = {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};
export type NativeGitHubAccess = Awaited<ReturnType<typeof createNativeGitHubAccess>>;

const CREDENTIALS_PATH = "/runtime-tools/github/credentials";
const ACCESS_TRANSPORT_ENV = "PAPERCLIP_GITHUB_ACCESS_TRANSPORT";
const INGRESS_CAPABILITY_HEADER = "x-paperclip-github-capability";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RUNNER_INGRESS_HEADERS = new Set<string>(DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST);

type HttpReply = { status: number; headers: Record<string, string>; body: Buffer };

function jsonReply(status: number, value: unknown): HttpReply {
  return {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    body: Buffer.from(JSON.stringify(value)),
  };
}

function sameToken(received: unknown, expected: string): boolean {
  const value = typeof received === "string" ? received : "";
  return Buffer.byteLength(value) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function sameBearer(received: unknown, token: string): boolean {
  return sameToken(received, `Bearer ${token}`);
}

function validHeaders(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, header]) =>
    RUNNER_INGRESS_HEADERS.has(key.toLowerCase()) && typeof header === "string" &&
    !/[\r\n\0]/.test(header));
}

function parseIngressRequest(value: unknown): NativeGitHubAccessHttpRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const expectedKeys = ["kind", "requestId", "method", "path", "headers", "bodyBase64"];
  if (Object.keys(frame).length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(frame, key)) ||
      frame.kind !== "github_access.http" || typeof frame.requestId !== "string" || !REQUEST_ID_PATTERN.test(frame.requestId) ||
      typeof frame.method !== "string" || frame.method.length > 16 || typeof frame.path !== "string" || frame.path.length > 2048 ||
      !validHeaders(frame.headers) || typeof frame.bodyBase64 !== "string") return null;
  const normalizedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(frame.headers)) {
    const normalizedName = name.toLowerCase();
    if (Object.hasOwn(normalizedHeaders, normalizedName)) return null;
    normalizedHeaders[normalizedName] = value;
  }
  return { ...frame, headers: normalizedHeaders } as NativeGitHubAccessHttpRequest;
}

function decodeBody(bodyBase64: string): Buffer | null {
  if (bodyBase64.length > 4 * Math.ceil(DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bodyBase64)) return null;
  const body = Buffer.from(bodyBase64, "base64");
  return body.length <= DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES && body.toString("base64") === bodyBase64
    ? body : null;
}

function responseFrame(requestId: string, response: HttpReply): NativeGitHubAccessHttpReply {
  return {
    requestId,
    status: response.status,
    headers: response.headers,
    bodyBase64: response.body.toString("base64"),
  };
}

/**
 * A process-lifetime transport, with authority only while its controller owns a run.
 * The random capability stays in server memory and reaches runnerd only through
 * authenticated PRP attachment; the GitHub credential is never written to disk.
 * The resolver still checks the active run and current identity/grants per operation.
 */
export async function createNativeGitHubAccess(input: {
  scope: Omit<Binding, "runId">;
  target: LauncherInput["target"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  resolveCredentials: (binding: Binding) => Promise<unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  fallbackReason?: GitHubAccessFallbackReason;
  /** Explicit executor selection; an absent value supports direct legacy callers. */
  transport?: AccessTransport;
}, startBridge = startAdapterExecutionTargetPaperclipBridge) {
  const runnerIngressEligible = input.target?.kind === "remote" && input.target.transport === "sandbox" &&
    input.target.effectiveCapabilities?.runnerWebSocketIngress === true;
  const transport: AccessTransport = input.transport ?? "callback_bridge";
  if (transport === "runner_ingress" && !runnerIngressEligible) {
    throw new Error("native_github_runner_ingress_ineligible");
  }
  const duplexRequested = adapterExecutionTargetEnablesSandboxDuplexBridge(input.target);
  let token = randomBytes(32).toString("hex");
  const redactLogValue = (value: string) => value
    .replaceAll(token, "[redacted]")
    .replaceAll(Buffer.from(token).toString("base64"), "[redacted]");
  const location = { runId: `native-session-${randomUUID()}`, target: input.target };
  let active: Binding | null = null;
  let activeGeneration: string | null = null;
  let activeOnLog = input.onLog;
  let stopped = false;
  let ready = true;
  let staleRunnerCapability = false;
  let runnerIngressCapabilityRefresher: ((capability: string) => Promise<void>) | null = null;
  let stopping: Promise<void> | undefined;
  let bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

  const current = (binding: Binding, generation: string) =>
    !stopped && active === binding && activeGeneration === generation;

  const acquireCredentials = async (binding: Binding, generation: string): Promise<HttpReply> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const acquisition = Promise.resolve().then(() => input.resolveCredentials({ ...binding }));
      // The runner ingress method uses the callback bridge's response deadline;
      // a late resolver result is observed but never becomes a second reply.
      const result = await Promise.race([
        acquisition,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("response_timeout"), { status: 504 })),
            DEFAULT_SANDBOX_CALLBACK_BRIDGE_RESPONSE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!current(binding, generation)) return jsonReply(403, { error: "GitHub run ended during credential acquisition" });
      const response = jsonReply(200, result);
      return response.body.byteLength <= DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES
        ? response : jsonReply(503, { error: "GitHub credentials unavailable" });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // Never leak secret-store/provider errors. Preserve steering's retry signal.
      return jsonReply(status === 409 ? 409 : status === 403 ? 403 : status === 504 ? 504 : 503,
        { error: status === 504 ? "GitHub credential request timed out" : "GitHub credentials unavailable" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const httpHandler = transport === "callback_bridge" ? async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const startedAt = performance.now();
    const requestOnLog = activeOnLog;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const bodyComplete = new Promise<void>(resolve => req.once("end", resolve));
    let bodyBytes = 0;
    let oversized = false;
    req.on("data", chunk => {
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES) oversized = true;
    });
    req.resume();
    const recordRequest = async (response: HttpReply) => {
      const record = {
        method: redactLogValue(req.method ?? ""), path: redactLogValue(req.url ?? ""), status: response.status,
        responseSize: response.body.byteLength, requestId: randomUUID(), transport: "bridge",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
      };
      const line = `[paperclip-runner] github_access.request ${JSON.stringify(record)}\n`;
      await Promise.resolve(requestOnLog?.("stderr", line)).catch(() => undefined);
    };
    const reply = async (response: HttpReply) => {
      await recordRequest(response);
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    };
    if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"] || !sameBearer(req.headers.authorization, token)) {
      await reply(jsonReply(403, { error: "GitHub session authentication required" }));
      return;
    }
    if (req.method !== "POST" || req.url !== CREDENTIALS_PATH) {
      await reply(jsonReply(404, { error: "Unknown GitHub session operation" }));
      return;
    }
    const binding = active;
    const capturedGeneration = activeGeneration;
    const requestGeneration = req.headers["x-paperclip-bridge-generation"];
    const bridgedRequest = typeof req.headers["x-paperclip-run-id"] === "string";
    const queueTransport = req.headers["x-paperclip-bridge-transport"] === "queue_v1";
    if (!binding || stopped) {
      await reply(jsonReply(403, { error: "No active GitHub run" }));
      return;
    }
    if ((bridgedRequest || queueTransport) && typeof requestGeneration !== "string") {
      await reply(jsonReply(403, { error: "GitHub bridge request has no run generation" }));
      return;
    }
    await bodyComplete;
    if (oversized) {
      await reply(jsonReply(413, { error: "GitHub request body exceeds the configured size limit" }));
      return;
    }
    if (!current(binding, capturedGeneration!) ||
        ((bridgedRequest || queueTransport) && requestGeneration !== capturedGeneration)) {
      await reply(jsonReply(403, { error: "GitHub bridge request belongs to an inactive run generation" }));
      return;
    }
    await reply(await acquireCredentials(binding, capturedGeneration!));
  } : null;

  const server = httpHandler ? createServer(httpHandler) : null;
  if (server) {
    server.requestTimeout = DEFAULT_SANDBOX_CALLBACK_BRIDGE_RESPONSE_TIMEOUT_MS;
    server.headersTimeout = 10_000;
  }
  const stop = () => stopping ??= (async () => {
    stopped = true;
    active = null;
    activeGeneration = null;
    runnerIngressCapabilityRefresher = null;
    bridge?.markOrderlyCompletion?.();
    server?.closeAllConnections();
    const bridgeStop = await Promise.allSettled([bridge?.stop()]);
    const results = await Promise.allSettled([
      new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()),
      cleanupGitHubOperationLaunchers(location),
    ]);
    if (bridgeStop.some(result => result.status === "rejected") || results.some(result => result.status === "rejected")) {
      await input.onLog?.("stderr", "[paperclip] GitHub session cleanup incomplete.\n").catch(() => undefined);
    }
  })();
  try {
    let url = "";
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("GitHub broker did not listen");
      url = `http://127.0.0.1:${address.port}`;
    }
    if (transport === "callback_bridge") {
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
          maxBodyBytes: DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
          forwardTimeoutMs: DEFAULT_SANDBOX_CALLBACK_BRIDGE_RESPONSE_TIMEOUT_MS,
          startPaused: true,
          getRunGeneration: () => activeGeneration ?? undefined,
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
        await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
        await input.onLog?.("stderr", "[paperclip] GitHub runtime transport unavailable; continuing without managed GitHub access.\n").catch(() => undefined);
      }
    }
    const launcherUrl = transport === "runner_ingress" ? "" : ready ? bridge?.env.PAPERCLIP_API_URL ?? url : "";
    const launcherToken = transport === "runner_ingress" || !ready ? "" : bridge?.env.PAPERCLIP_API_KEY ?? token;
    const ingressEnvironment: Record<string, string> = transport === "runner_ingress"
      ? { [ACCESS_TRANSPORT_ENV]: "runner_ingress" }
      : {};
    const env = await prepareGitHubOperationLaunchers({
      ...location, cwd: input.cwd,
      env: {
        ...githubBrokerEnvironment({ PATH: input.env.PATH, ...ingressEnvironment }, {
          url: launcherUrl,
          token: launcherToken,
        }),
        ...(transport === "callback_bridge" ? { PAPERCLIP_GITHUB_BRIDGE_TOKEN: launcherToken } : {}),
        ...ingressEnvironment,
      },
    });
    return {
      env,
      transport,
      get ready() { return ready && !stopped && !staleRunnerCapability && (transport === "runner_ingress" || bridge?.readRunDisposition?.().failed !== true); },
      getRunnerIngressCapability() { return transport === "runner_ingress" ? token : undefined; },
      setRunnerIngressCapabilityRefresher(refresher: ((capability: string) => Promise<void>) | null) {
        if (transport !== "runner_ingress") return () => {};
        runnerIngressCapabilityRefresher = refresher;
        return () => {
          if (runnerIngressCapabilityRefresher === refresher) runnerIngressCapabilityRefresher = null;
        };
      },
      markRunnerIngressReady() { if (transport === "runner_ingress") staleRunnerCapability = false; },
      markRunnerIngressStale() { if (transport === "runner_ingress") staleRunnerCapability = true; },
      duplexRequested,
      async handleRunnerIngressHttpRequest(frame: unknown, sessionBinding: Binding, recordLog = true): Promise<NativeGitHubAccessHttpReply> {
        const startedAt = performance.now();
        const requestOnLog = activeOnLog;
        const parsed = parseIngressRequest(frame);
        const requestId = typeof frame === "object" && frame !== null && typeof (frame as { requestId?: unknown }).requestId === "string"
          ? (frame as { requestId: string }).requestId : "invalid-request";
        const respond = async (response: HttpReply) => {
          const record = {
            method: redactLogValue(parsed?.method ?? ""), path: redactLogValue(parsed?.path ?? ""), status: response.status,
            responseSize: response.body.byteLength, requestId: redactLogValue(parsed?.requestId ?? requestId),
            transport: "prp", durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          };
          if (recordLog) {
            await Promise.resolve(requestOnLog?.("stderr", `[paperclip-runner] github_access.request ${JSON.stringify(record)}\n`)).catch(() => undefined);
          }
          return responseFrame(requestId, response);
        };
        if (!parsed) return respond(jsonReply(403, { error: "GitHub ingress request refused" }));
        const body = decodeBody(parsed.bodyBase64);
        if (!body) return respond(jsonReply(413, { error: "GitHub request body exceeds the configured size limit" }));
        if (staleRunnerCapability) return respond(jsonReply(503, { error: "native_github_access_stale_runner_token" }));
        // Retain the launcher's existing per-request capability check; the
        // authenticated PRP identity below adds session authority, not a substitute.
        if (!sameToken(parsed.headers[INGRESS_CAPABILITY_HEADER], token)) {
          return respond(jsonReply(403, { error: "GitHub session authentication required" }));
        }
        if (sessionBinding.companyId !== input.scope.companyId || sessionBinding.agentId !== input.scope.agentId ||
            sessionBinding.issueId !== input.scope.issueId) {
          return respond(jsonReply(403, { error: "GitHub session scope mismatch" }));
        }
        const binding = active;
        const generation = activeGeneration;
        if (!binding || stopped || binding.runId !== sessionBinding.runId) {
          return respond(jsonReply(403, { error: "No active GitHub run" }));
        }
        if (parsed.method !== "POST" || parsed.path !== CREDENTIALS_PATH) {
          return respond(jsonReply(404, { error: "Unknown GitHub session operation" }));
        }
        if (!current(binding, generation!)) {
          return respond(jsonReply(403, { error: "GitHub request belongs to an inactive run generation" }));
        }
        return respond(await acquireCredentials(binding, generation!));
      },
      async recordRunnerIngressRequest(frame: unknown, response: NativeGitHubAccessHttpReply, durationMs: number) {
        const parsed = parseIngressRequest(frame);
        const requestId = typeof frame === "object" && frame !== null && typeof (frame as { requestId?: unknown }).requestId === "string"
          ? (frame as { requestId: string }).requestId : "invalid-request";
        const record = {
          method: redactLogValue(parsed?.method ?? ""), path: redactLogValue(parsed?.path ?? ""), status: response.status,
          responseSize: Buffer.from(response.bodyBase64, "base64").byteLength,
          requestId: redactLogValue(parsed?.requestId ?? requestId), transport: "prp",
          durationMs: Math.max(0, Math.round(durationMs)),
        };
        await Promise.resolve(activeOnLog?.("stderr", `[paperclip-runner] github_access.request ${JSON.stringify(record)}\n`)).catch(() => undefined);
      },
      getSessionBinding(sessionBinding: Binding): Binding | null {
        const binding = active;
        if (!binding || stopped || binding.companyId !== sessionBinding.companyId ||
            binding.agentId !== sessionBinding.agentId || binding.issueId !== sessionBinding.issueId ||
            binding.runId !== sessionBinding.runId) return null;
        return { ...binding };
      },
      async activate(binding: Binding, onLog?: typeof input.onLog) {
        if (stopped || active) throw new Error("GitHub session is closed or busy");
        if (binding.companyId !== input.scope.companyId || binding.agentId !== input.scope.agentId ||
            binding.issueId !== input.scope.issueId) throw new Error("GitHub session scope mismatch");
        const generation = randomUUID();
        if (transport === "runner_ingress") token = randomBytes(32).toString("hex");
        if (transport === "callback_bridge") await bridge?.resume?.(generation);
        const owner = { ...binding };
        activeOnLog = onLog ?? input.onLog;
        active = owner;
        activeGeneration = generation;
        try {
          if (transport === "runner_ingress" && runnerIngressCapabilityRefresher) {
            await runnerIngressCapabilityRefresher(token);
            staleRunnerCapability = false;
          }
        } catch (error) {
          if (active === owner) {
            active = null;
            activeGeneration = null;
            activeOnLog = input.onLog;
          }
          staleRunnerCapability = true;
          throw error;
        }
        return async () => {
          if (active === owner) {
            active = null;
            activeGeneration = null;
            activeOnLog = input.onLog;
            if (transport === "callback_bridge") await bridge?.pause?.();
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
