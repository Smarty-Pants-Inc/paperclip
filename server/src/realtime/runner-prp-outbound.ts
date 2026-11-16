import WebSocket from "ws";
import { isSandboxLeaseStartDeniedError } from "../services/retained-sandbox-absent-error.js";
import { logger } from "../middleware/logger.js";
import { allowlistedErrnoCode, allowlistedIngressReason, allowlistedSyscall, finiteSafeInteger } from "./ingress-error-summary.js";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "../services/native-runtime/native-runner-recovery-contract.js";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import {
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_IN_FLIGHT,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_RESPONSE_TIMEOUT_MS,
} from "@paperclipai/adapter-utils/sandbox-callback-bridge";
import type {
  DurablePrpControlPlane,
  DurableRecoveryIdentity,
  PrpWireConnection,
  TransportCloseReason,
} from "../vendor/paperclip-runner/index.js";

const DEFAULT_STARTUP_DEADLINE_MS = 60_000;
const DEFAULT_RECOVERY_GRACE_MS = REMOTE_RUNNER_RECONNECT_GRACE_MS;
// Secure PRP uses hex ciphertext, so a maximum-size base64 HTTP body needs
// roughly twice its encoded size plus the frame header.
const MAX_FRAME_BYTES = Math.max(32 * 1024 * 1024,
  2 * (4 * Math.ceil(DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES / 3) + 64 * 1024));
const GITHUB_ACCESS_KIND = "github_access.http";
const GITHUB_ACCESS_CREDENTIALS_PATH = "/runtime-tools/github/credentials";
const GITHUB_ACCESS_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const GITHUB_ACCESS_HEADER_ALLOWLIST = new Set<string>(DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST);
const GITHUB_ACCESS_SESSION_REQUEST_LIMIT = 65_536;

type GithubAccessBinding = { companyId: string; agentId: string; issueId: string; runId: string };
type GithubAccessReply = { requestId: string; status: number; headers: Record<string, string>; bodyBase64: string };
type GithubAccessHandler = {
  getSessionBinding(identity: DurableRecoveryIdentity): GithubAccessBinding | null;
  handleRequest(frame: unknown, binding: GithubAccessBinding): Promise<unknown>;
  getCapability?: () => string | undefined;
  setRunnerIngressCapabilityRefresher?: (refresher: ((capability: string) => Promise<void>) | null) => () => void;
  onCapabilityRefreshSuccess?: () => void;
  onCapabilityRefreshFailure?: () => void;
};
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MIN_CONNECT_ATTEMPTS = 3;
// Explicit sub-handshake budgets remain hard caps; normal startup/recovery
// budgets reserve up to three actual dials, even if an event-loop stall eats
// the original deadline. A provider refresh that exhausts its deadline stops
// recovery instead of starting overlapping provider work.
function minimumConnectAttempts(budgetMs: number): number {
  return Math.max(1, Math.min(MIN_CONNECT_ATTEMPTS, Math.ceil(budgetMs / HANDSHAKE_TIMEOUT_MS)));
}
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
// Do not flood a serial listener with new handshakes while repairing its route.
const MIN_ROUTE_REACQUIRE_DELAY_MS = 1_000;
// A runner can legitimately stay silent for many minutes while its provider
// waits on a long foreground tool call. Protocol pings distinguish that quiet
// but live runner from a half-open connection (for example a preview proxy that
// drops the route without a FIN), which otherwise never emits `close` and leaves
// the run "running" forever. runnerd answers every ping with a pong.
const DEFAULT_LIVENESS_INTERVAL_MS = 20_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 90_000;

export type RunnerIngressFailureCode =
  | "runner_ingress_unavailable"
  | "runner_ingress_auth_failed"
  | "runner_connection_lease_expired"
  | "native_github_access_stale_runner_token";

export class RunnerIngressConnectionError extends Error {
  constructor(
    readonly code: RunnerIngressFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RunnerIngressConnectionError";
  }
}

export class WsJsonWireConnection implements PrpWireConnection {
  #onJson: ((value: unknown) => void) | null = null;
  #onPong: (() => void) | null = null;
  #onClose = new Set<(reason: TransportCloseReason) => void>();
  #pendingJson: unknown[] = [];
  #closeReason: TransportCloseReason | null = null;
  #lastInboundAt = Date.now();

  constructor(readonly socket: WebSocket) {
    socket.on("pong", () => {
      this.#lastInboundAt = Date.now();
      if (this.#closeReason === null) this.#onPong?.();
    });
    socket.on("message", (data, isBinary) => {
      this.#lastInboundAt = Date.now();
      if (isBinary) {
        this.close(1003);
        return;
      }
      try {
        const value = JSON.parse(data.toString()) as unknown;
        if (this.#onJson === null) {
          this.#pendingJson.push(value);
        } else {
          this.#onJson(value);
        }
      } catch {
        this.close(1007);
      }
    });
    socket.on("close", (code, reason) => {
      this.#notifyClose({ code, message: reason.toString() });
    });
    socket.on("error", (error) => {
      this.#notifyClose({ message: "websocket_error", error });
    });
  }

  sendJson(value: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(value));
    }
  }

  close(code = 1000): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(code);
    }
  }

  /**
   * Ping the runner and terminate the socket when nothing at all (frame or
   * pong) arrives within the timeout. Termination emits `close`, so the PRP
   * authority and the reconnect loop observe an ordinary transport loss and
   * the fixed recovery grace applies. Returns a stop function.
   */
  monitorLiveness(input: { intervalMs: number; timeoutMs: number }): () => void {
    this.#lastInboundAt = Date.now();
    // At least two pings fit inside the timeout, so a healthy peer always has
    // a chance to answer before the deadline, whatever the caller passes.
    const intervalMs = Math.max(1, Math.min(input.intervalMs, Math.floor(input.timeoutMs / 2)));
    let lastTickAt = Date.now();
    const ping = () => {
      try {
        this.socket.ping();
      } catch {
        // A failing ping is itself a transport loss; ws reports it via close.
      }
    };
    if (this.socket.readyState === WebSocket.OPEN) ping();
    const timer = setInterval(() => {
      if (this.#closeReason || this.socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      // A blocked server event loop delays our own timers and the runner's
      // queued pongs alike. That silence is not runner evidence; restart the
      // window instead of terminating a live runner.
      if (now - lastTickAt > intervalMs * 2) this.#lastInboundAt = now;
      lastTickAt = now;
      if (now - this.#lastInboundAt >= input.timeoutMs) {
        clearInterval(timer);
        this.socket.terminate();
        return;
      }
      ping();
    }, intervalMs);
    timer.unref?.();
    const stop = () => clearInterval(timer);
    this.onClose(stop);
    return stop;
  }

  onJson(listener: (value: unknown) => void): void {
    this.#onJson = listener;
    for (const value of this.#pendingJson.splice(0)) listener(value);
  }

  onPong(listener: () => void): void {
    this.#onPong = listener;
  }

  onClose(listener: (reason: TransportCloseReason) => void): void {
    if (this.#closeReason) listener(this.#closeReason);
    else this.#onClose.add(listener);
  }

  #notifyClose(reason: TransportCloseReason): void {
    if (this.#closeReason) return;
    this.#closeReason = reason;
    for (const listener of this.#onClose) listener(reason);
    this.#onClose.clear();
  }
}

function validateEndpoint(endpoint: RunnerIngressEndpoint): void {
  const url = new URL(endpoint.websocketUrl);
  if (
    endpoint.kind !== "authenticated_websocket" ||
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RunnerIngressConnectionError(
      "runner_ingress_unavailable",
      "The provider returned an invalid runner ingress endpoint.",
    );
  }
}

function endpointHeaders(endpoint: RunnerIngressEndpoint): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of endpoint.secretHeaders) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name) || !header.value) {
      throw new RunnerIngressConnectionError(
        "runner_ingress_unavailable",
        "The provider returned an invalid runner ingress credential.",
      );
    }
    headers[header.name] = header.value;
  }
  return headers;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function awaitWithinDeadline<T>(input: {
  operation: () => Promise<T>;
  deadline: number;
  signal: AbortSignal;
}): Promise<T> {
  if (input.signal.aborted) {
    throw new Error("runner ingress operation was cancelled");
  }
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("runner ingress operation deadline elapsed");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("runner ingress operation deadline elapsed")),
      remaining,
    );
    onAbort = () => reject(new Error("runner ingress operation was cancelled"));
    input.signal.addEventListener("abort", onAbort, { once: true });
  });
  const operation = Promise.resolve().then(input.operation);
  try {
    return await Promise.race([operation, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener("abort", onAbort);
  }
}

async function closeOwnedWire(wire: WsJsonWireConnection): Promise<void> {
  const closed = wire.socket.readyState === WebSocket.CLOSED
    ? Promise.resolve()
    : new Promise<void>((resolve) => wire.socket.once("close", () => resolve()));
  wire.close(1001);
  wire.socket.terminate();
  await closed;
}

async function openEndpoint(input: {
  endpoint: RunnerIngressEndpoint;
  signal: AbortSignal;
  deadline: number;
  onWire: (wire: WsJsonWireConnection) => void;
}): Promise<{ wire: WsJsonWireConnection; statusCode: number | null }> {
  validateEndpoint(input.endpoint);
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) {
    throw new RunnerIngressConnectionError(
      "runner_ingress_unavailable",
      "Runner ingress connection failed.",
    );
  }
  return await new Promise((resolve, reject) => {
    let statusCode: number | null = null;
    const socket = new WebSocket(input.endpoint.websocketUrl, {
      headers: endpointHeaders(input.endpoint),
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: Math.min(HANDSHAKE_TIMEOUT_MS, remaining),
    });
    const wire = new WsJsonWireConnection(socket);
    const onAbort = () => {
      wire.close(1001);
      reject(
        new RunnerIngressConnectionError(
          "runner_ingress_unavailable",
          "Runner ingress connection was cancelled.",
        ),
      );
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    socket.once("unexpected-response", (_request, response) => {
      statusCode = response.statusCode ?? null;
      response.resume();
      input.signal.removeEventListener("abort", onAbort);
      socket.terminate();
      reject(
        Object.assign(new Error("runner_ingress_upgrade_rejected"), {
          statusCode,
        }),
      );
    });
    socket.once("open", () => {
      input.signal.removeEventListener("abort", onAbort);
      resolve({ wire, statusCode });
    });
    socket.once("error", (error) => {
      input.signal.removeEventListener("abort", onAbort);
      reject(Object.assign(error, { statusCode }));
    });
    input.onWire(wire);
  });
}

function ingressErrorSummary(error: unknown): {
  code: string;
  errno: number | null;
  syscall: string;
  statusCode: number | null;
  reason: string | null;
} {
  const value = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: allowlistedErrnoCode(value.code),
    errno: finiteSafeInteger(value.errno),
    syscall: allowlistedSyscall(value.syscall),
    statusCode: finiteSafeInteger(value.statusCode),
    // Raw transport prose can carry credentials (an Authorization header, a
    // URL inside a sentence). Log only a machine reason code, never prose.
    reason: allowlistedIngressReason(message),
  };
}

/** Only codes this ingress path can emit are safe to include in logs. */
export function machineReasonCode(message: string): string | null {
  return allowlistedIngressReason(message);
}

function socketClosed(wire: WsJsonWireConnection): Promise<void> {
  return new Promise((resolve) => wire.onClose(() => resolve()));
}

function githubAccessFrameRequestId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && GITHUB_ACCESS_REQUEST_ID_PATTERN.test(requestId) ? requestId : null;
}

function githubAccessResponse(requestId: string, status: number, body: unknown): GithubAccessReply {
  return { requestId, status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") };
}

function validGithubAccessFrame(value: unknown): value is Record<string, unknown> & {
  kind: typeof GITHUB_ACCESS_KIND; requestId: string; method: string; path: string;
  headers: Record<string, string>; bodyBase64: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  const keys = ["kind", "requestId", "method", "path", "headers", "bodyBase64"];
  if (Object.keys(frame).length !== keys.length || keys.some(key => !Object.hasOwn(frame, key)) ||
      frame.kind !== GITHUB_ACCESS_KIND || githubAccessFrameRequestId(frame) === null ||
      typeof frame.method !== "string" || frame.method.length > 16 || typeof frame.path !== "string" || frame.path.length > 2048 ||
      typeof frame.bodyBase64 !== "string" || typeof frame.headers !== "object" || frame.headers === null || Array.isArray(frame.headers)) return false;
  const headers = frame.headers as Record<string, unknown>;
  const entries = Object.entries(headers);
  if (entries.length > 16 || entries.reduce((bytes, [name, header]) => bytes + Buffer.byteLength(name) +
      (typeof header === "string" ? Buffer.byteLength(header) : 0), 0) > 8192) return false;
  return entries.every(([name, header]) => GITHUB_ACCESS_HEADER_ALLOWLIST.has(name.toLowerCase()) &&
    typeof header === "string" && !/[\r\n\0]/.test(header));
}

function sameGithubAccessBinding(left: GithubAccessBinding, right: GithubAccessBinding | null): boolean {
  return right !== null && left.companyId === right.companyId && left.agentId === right.agentId &&
    left.issueId === right.issueId && left.runId === right.runId;
}

function decodeGithubAccessBody(bodyBase64: string): Buffer | null {
  if (bodyBase64.length > 4 * Math.ceil(DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bodyBase64)) return null;
  const body = Buffer.from(bodyBase64, "base64");
  return body.length <= DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES && body.toString("base64") === bodyBase64 ? body : null;
}

function normalizeGithubAccessReply(value: unknown, requestId: string): GithubAccessReply | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const reply = value as Record<string, unknown>;
  if (!Number.isSafeInteger(reply.status) || (reply.status as number) < 100 || (reply.status as number) > 599 ||
      typeof reply.headers !== "object" || reply.headers === null || Array.isArray(reply.headers)) return null;
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(reply.headers as Record<string, unknown>)) {
    const normalized = name.toLowerCase();
    if (["content-type", "cache-control"].includes(normalized) && typeof header === "string" && !/[\r\n\0]/.test(header)) {
      headers[normalized] = header;
    }
  }
  const rawBody = reply.bodyBase64;
  let bodyBase64: string;
  if (typeof rawBody === "string") {
    if (!decodeGithubAccessBody(rawBody)) return null;
    bodyBase64 = rawBody;
  } else if (Buffer.isBuffer(reply.body) || reply.body instanceof Uint8Array) {
    const body = Buffer.from(reply.body as Uint8Array);
    if (body.byteLength > DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES) return null;
    bodyBase64 = body.toString("base64");
  } else return null;
  return { requestId, status: reply.status as number, headers, bodyBase64 };
}

function githubAccessRequestDispatcher(handler: GithubAccessHandler) {
  const inFlight = new Set<string>();
  const seen = new Set<string>();
  return async (value: unknown, identity: DurableRecoveryIdentity): Promise<GithubAccessReply> => {
    const requestId = githubAccessFrameRequestId(value);
    if (requestId === null) return githubAccessResponse("invalid-request", 403, { error: "GitHub ingress request refused" });
    if (seen.has(requestId)) return githubAccessResponse(requestId, 409, { error: "GitHub ingress request already used" });
    if (seen.size >= GITHUB_ACCESS_SESSION_REQUEST_LIMIT) {
      return githubAccessResponse(requestId, 503, { error: "GitHub ingress request capacity unavailable" });
    }
    seen.add(requestId);
    if (inFlight.size >= DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_IN_FLIGHT) {
      return githubAccessResponse(requestId, 503, { error: "GitHub ingress request capacity unavailable" });
    }
    if (!validGithubAccessFrame(value)) return githubAccessResponse(requestId, 403, { error: "GitHub ingress request refused" });
    if (!decodeGithubAccessBody(value.bodyBase64)) return githubAccessResponse(requestId, 413, { error: "GitHub request body exceeds the configured size limit" });
    if (value.method !== "POST" || value.path !== GITHUB_ACCESS_CREDENTIALS_PATH) {
      return githubAccessResponse(requestId, 404, { error: "Unknown GitHub session operation" });
    }
    const binding = handler.getSessionBinding(identity);
    if (!binding) return githubAccessResponse(requestId, 403, { error: "No active GitHub run" });
    inFlight.add(requestId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = Promise.resolve().then(() => handler.handleRequest(value, binding));
      const result = await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("github_access_response_timeout"), { githubAccessTimeout: true })),
            DEFAULT_SANDBOX_CALLBACK_BRIDGE_RESPONSE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!sameGithubAccessBinding(binding, handler.getSessionBinding(identity))) {
        return githubAccessResponse(requestId, 403, { error: "GitHub ingress run binding changed" });
      }
      return normalizeGithubAccessReply(result, requestId) ??
        githubAccessResponse(requestId, 503, { error: "GitHub credentials unavailable" });
    } catch (error) {
      const timeout = typeof error === "object" && error !== null &&
        (error as { githubAccessTimeout?: unknown }).githubAccessTimeout === true;
      return githubAccessResponse(requestId, timeout ? 504 : 503,
        { error: timeout ? "GitHub credential request timed out" : "GitHub credentials unavailable" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlight.delete(requestId);
    }
  };
}

async function waitForPrpReady(input: {
  isAuthenticated: () => boolean;
  wire: WsJsonWireConnection;
  deadline: number;
  signal: AbortSignal;
}): Promise<boolean> {
  while (
    !input.signal.aborted &&
    input.wire.socket.readyState === WebSocket.OPEN &&
    Date.now() < input.deadline
  ) {
    if (input.isAuthenticated()) return true;
    await delay(25, input.signal);
  }
  return false;
}

export interface RunnerPrpOutboundHandle {
  readonly ready: Promise<void>;
  /** Rejects only when active-run recovery has exhausted its retry policy. */
  readonly failure: Promise<never>;
  /** Stop liveness and reconnect work, preserving an established receive/ACK path. */
  quiesce(): void;
  close(): Promise<void>;
}

/**
 * Keep a Paperclip-originated provider-ingress WebSocket attached to one PRP
 * authority. Authentication is the readiness signal; HTTP success alone is not.
 */
export function connectRunnerPrpIngress(input: {
  authority: DurablePrpControlPlane;
  endpoint: RunnerIngressEndpoint;
  startupDeadlineMs?: number;
  recoveryGraceMs?: number;
  /** How often to ping an authenticated runner connection. */
  livenessIntervalMs?: number;
  /** Silence after which an authenticated connection is treated as lost. */
  livenessTimeoutMs?: number;
  random?: () => number;
  onStateChange?: (
    state: "connecting" | "authenticated" | "reconnecting" | "failed" | "closed",
    failureCode?: RunnerIngressFailureCode,
  ) => void;
  /** Ephemeral authenticated PRP request handler; never enters durable event state. */
  githubAccess?: GithubAccessHandler;
}): RunnerPrpOutboundHandle {
  const abort = new AbortController();
  const ownedWires = new Set<WsJsonWireConnection>();
  let endpoint = input.endpoint;
  const startupBudgetStartedAt = Date.now();
  const startupBudgetMs = input.startupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS;
  const startupDeadline = startupBudgetStartedAt + startupBudgetMs;
  const recoveryGraceMs = input.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS;
  const random = input.random ?? Math.random;
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  let readySettled = false;
  let stopLiveness = () => {};
  let unregisterGithubAccessHandler = () => {};
  let unregisterGithubCapabilityRefresher: (() => void) | null = null;
  if (input.githubAccess) {
    unregisterGithubAccessHandler = input.authority.setGithubAccessHttpHandler(
      githubAccessRequestDispatcher(input.githubAccess),
    );
  }
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let failureReject!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    failureReject = reject;
  });
  // The owning native session normally races this promise against the provider
  // turn. A turn can finish first, though, and a later preview outage must not
  // become an unhandled process-level rejection. Keep the original promise
  // rejected for explicit observers while registering an internal handler.
  void failure.catch(() => undefined);
  void ready.catch(() => undefined);

  const loop = (async () => {
    let attempt = 0;
    let failedAttemptNumber = 0;
    let recoveryDeadline = startupDeadline;
    let nextAttemptDeadline = startupDeadline;
    let connectAttempts = 0;
    let minimumAttempts = minimumConnectAttempts(startupBudgetMs);
    // A runner whose connection lease lapsed exits without another
    // authenticated frame. Keep the authority's reason so the run log and the
    // terminal error name it instead of a generic transport loss.
    let leaseFailureCode: RunnerIngressFailureCode | null = null;
    while (!abort.signal.aborted) {
      let dialStarted = false;
      try {
        input.onStateChange?.(attempt === 0 ? "connecting" : "reconnecting");
        if (abort.signal.aborted) return;
        // The event loop may have stalled before even constructing the socket.
        if (
          minimumAttempts > 1 && connectAttempts < minimumAttempts
          && leaseFailureCode === null && !input.authority.connectionLeaseFailure
          && Date.now() >= nextAttemptDeadline
        ) {
          nextAttemptDeadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
        }
        const opened = await openEndpoint({
          endpoint,
          signal: abort.signal,
          deadline: nextAttemptDeadline,
          onWire: (wire) => {
            dialStarted = true;
            connectAttempts += 1;
            ownedWires.add(wire);
            wire.socket.once("close", () => ownedWires.delete(wire));
          },
        });
        if (abort.signal.aborted) return;
        const attachment = input.authority.attachWireConnection(opened.wire);
        const authenticated = await waitForPrpReady({
          isAuthenticated: attachment.isAuthenticated,
          wire: opened.wire,
          deadline: nextAttemptDeadline,
          signal: abort.signal,
        });
        if (!authenticated) {
          opened.wire.close(1008);
          throw new RunnerIngressConnectionError(
            "runner_ingress_auth_failed",
            "Runner ingress did not complete PRP authentication before the deadline.",
          );
        }
        if (abort.signal.aborted) return;
        if (input.githubAccess?.getCapability) {
          const capability = input.githubAccess.getCapability();
          try {
            if (!capability) throw new Error("native_github_access_stale_runner_token");
            await input.authority.refreshGithubAccessCapability(capability);
            input.githubAccess.onCapabilityRefreshSuccess?.();
            if (!unregisterGithubCapabilityRefresher) {
              unregisterGithubCapabilityRefresher = input.githubAccess.setRunnerIngressCapabilityRefresher?.(
                nextCapability => input.authority.refreshGithubAccessCapability(nextCapability),
              ) ?? (() => {});
            }
          } catch (error) {
            input.githubAccess.onCapabilityRefreshFailure?.();
            throw new RunnerIngressConnectionError(
              "native_github_access_stale_runner_token",
              "Runner GitHub capability refresh was not acknowledged.",
              { cause: error },
            );
          }
        }
        if (!readySettled) {
          readySettled = true;
          readyResolve();
        }
        input.onStateChange?.("authenticated");
        if (abort.signal.aborted) return;
        attempt = 0;
        leaseFailureCode = null;
        stopLiveness = opened.wire.monitorLiveness({
          intervalMs: input.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS,
          timeoutMs: input.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS,
        });
        if (abort.signal.aborted) { stopLiveness(); return; }
        try {
          await socketClosed(opened.wire);
        } finally {
          stopLiveness();
        }
        if (abort.signal.aborted) return;
        recoveryDeadline = Date.now() + recoveryGraceMs;
        nextAttemptDeadline = recoveryDeadline;
        connectAttempts = 0;
        minimumAttempts = minimumConnectAttempts(recoveryGraceMs);
        const leaseFailure = input.authority.connectionLeaseFailure ?? null;
        if (leaseFailure) {
          leaseFailureCode = "runner_connection_lease_expired";
          input.onStateChange?.("reconnecting", leaseFailureCode);
        }
      } catch (error) {
        // close() owns intentional shutdown. openEndpoint rejects its pending
        // handshake when the abort signal fires, but that cancellation is not
        // an active-run transport failure and must not reject the long-lived
        // failure promise (an unobserved rejection here can terminate Node).
        if (abort.signal.aborted) return;
        if (input.authority.connectionLeaseFailure) leaseFailureCode = "runner_connection_lease_expired";
        // Intentional close() is not a failed attempt; log only real failures.
        failedAttemptNumber += 1;
        const summary = ingressErrorSummary(error);
        logger.warn({
          event: "runner_ingress_connect_attempt_failed",
          attempt: failedAttemptNumber,
          elapsedMs: Math.max(0, Date.now() - startupBudgetStartedAt),
          remainingBudgetMs: Math.max(0, recoveryDeadline - Date.now()),
          ...summary,
        }, "runner ingress connect attempt failed");
        let failure: unknown = error;
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            && (error as { statusCode?: unknown }).statusCode != null
            ? Number((error as { statusCode?: unknown }).statusCode)
            : null;
        const transportFailure = leaseFailureCode === null
          && (statusCode === null || statusCode >= 500)
          && !(failure instanceof RunnerIngressConnectionError && failure.code !== "runner_ingress_unavailable");
        if (
          leaseFailureCode === null &&
          (statusCode === 401 || statusCode === 403) &&
          Date.now() < recoveryDeadline
        ) {
          try {
            const refreshedEndpoint = await awaitWithinDeadline({
              operation: () => endpoint.refresh(),
              deadline: recoveryDeadline,
              signal: abort.signal,
            });
            // Preview credentials can rotate without changing the sandbox
            // generation. Refresh every rejected credential, but never let a
            // successful refresh reset or step past the fixed recovery budget.
            if (Date.now() < recoveryDeadline) {
              endpoint = refreshedEndpoint;
              continue;
            }
          } catch (refreshError) {
            if (abort.signal.aborted) return;
            failure = refreshError;
            if (isSandboxLeaseStartDeniedError(refreshError)) leaseFailureCode = "runner_connection_lease_expired";
          }
        }
        // A timed-out dial is an attempt, not evidence that three attempts ran.
        // Reserve one bounded repair+dial window for each missing attempt. Do
        // not apply this floor to auth/known-expired leases, invalid endpoints,
        // or a refresh that itself used up the provider-operation deadline.
        const floorRetry = transportFailure && dialStarted
          && connectAttempts < minimumAttempts && Date.now() >= recoveryDeadline;
        let retryDeadline = floorRetry ? Date.now() + HANDSHAKE_TIMEOUT_MS : recoveryDeadline;
        if (leaseFailureCode === null && Date.now() < retryDeadline) {
          const base = RECONNECT_DELAYS_MS[
            Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)
          ]!;
          attempt += 1;
          // No catch-up sleeps after a stalled dial; the floor permits at most
          // two extra dials. Inside a short cold budget retain the old 250/500ms
          // cadence instead of spending the entire budget on the added spacing.
          if (!floorRetry) {
            const jitter = 0.75 + random() * 0.5;
            const routeDelay = Math.max(1, Math.round(Math.max(base, MIN_ROUTE_REACQUIRE_DELAY_MS) * jitter));
            const retryDelay = transportFailure && routeDelay < retryDeadline - Date.now()
              ? routeDelay
              : Math.max(1, Math.round(base * jitter));
            await delay(
              Math.min(retryDelay, Math.max(1, retryDeadline - Date.now())),
              abort.signal,
            );
          }
          if (abort.signal.aborted) return;
          // Expiry can become known while the backoff timer is pending.
          if (input.authority.connectionLeaseFailure) leaseFailureCode = "runner_connection_lease_expired";
          // A stall during backoff must not spend an unmade dial either.
          if (
            !floorRetry && transportFailure && leaseFailureCode === null && dialStarted
            && connectAttempts < minimumAttempts && Date.now() >= retryDeadline
          ) {
            retryDeadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
          }
          if (Date.now() < retryDeadline) {
            // Re-post the route on this same sandbox before another handshake.
            // Keep the original budget except for the bounded missing-attempt
            // windows above; never turn auth/lease failure into route repair.
            if (transportFailure && leaseFailureCode === null) {
              try {
                const refreshedEndpoint = await awaitWithinDeadline({
                  operation: () => endpoint.refresh(),
                  deadline: retryDeadline,
                  signal: abort.signal,
                });
                if (Date.now() < retryDeadline) endpoint = refreshedEndpoint;
              } catch (refreshError) {
                if (abort.signal.aborted) return;
                failure = refreshError;
                if (isSandboxLeaseStartDeniedError(refreshError)) leaseFailureCode = "runner_connection_lease_expired";
              }
            }
            if (leaseFailureCode === null && Date.now() < retryDeadline) {
              nextAttemptDeadline = retryDeadline;
              continue;
            }
          }
        }
        const terminal =
          leaseFailureCode !== null
            ? new RunnerIngressConnectionError(
                leaseFailureCode,
                "The runner's connection lease expired before it was renewed.",
                { cause: failure },
              )
            : failure instanceof RunnerIngressConnectionError
            ? failure
            : new RunnerIngressConnectionError(
                statusCode === 401 || statusCode === 403
                  ? "runner_ingress_auth_failed"
                  : "runner_ingress_unavailable",
                "Runner ingress connection failed.",
                { cause: failure },
              );
        if (failure instanceof Error) {
          Object.assign(terminal, { causeSummary: ingressErrorSummary(failure) });
        }
        if (!readySettled) {
          readySettled = true;
          readyReject(terminal);
        }
        input.onStateChange?.("failed", terminal.code);
        failureReject(terminal);
        return;
      }
    }
  })();

  return {
    ready,
    failure,
    quiesce() {
      stopLiveness();
      // Established wires removed their handshake abort listener. Keep their ACK path.
      abort.abort();
    },
    async close() {
      abort.abort();
      await Promise.all([...ownedWires].map(closeOwnedWire));
      await loop;
      unregisterGithubAccessHandler();
      unregisterGithubCapabilityRefresher?.();
      await endpoint.close();
      input.onStateChange?.("closed");
      if (!readySettled) {
        readySettled = true;
        readyReject(
          new RunnerIngressConnectionError(
            "runner_ingress_unavailable",
            "Runner ingress was closed before it became ready.",
          ),
        );
      }
    },
  };
}

export const __runnerPrpOutboundTesting = { awaitWithinDeadline };
