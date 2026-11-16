import WebSocket from "ws";
import { isSandboxLeaseStartDeniedError } from "../services/retained-sandbox-absent-error.js";
import { logger } from "../middleware/logger.js";
import { allowlistedErrnoCode, allowlistedIngressReason, allowlistedSyscall, finiteSafeInteger } from "./ingress-error-summary.js";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "../services/native-runtime/native-runner-recovery-contract.js";
import { controlPlaneLeaseExpiresAtUnixMs } from "./runner-control-plane-lease.js";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import type {
  DurablePrpControlPlane,
  PrpWireConnection,
  TransportCloseReason,
} from "../vendor/paperclip-runner/index.js";

const DEFAULT_STARTUP_DEADLINE_MS = 60_000;
const DEFAULT_RECOVERY_GRACE_MS = REMOTE_RUNNER_RECONNECT_GRACE_MS;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
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
// #20825: an idle warm owner keeps redialing after the recovery budget until
// its connection lease nears expiry. runnerd's listen_ws listener has one
// admission slot; a dead socket holds it until runnerd next writes (its lease
// renewal, up to 30 min later). Retire this long before runnerd's own lease
// expiry exit, so no relaunch loop starts behind a retired owner.
const DEFAULT_IDLE_WARM_RETIRE_MARGIN_MS = 2 * 60_000;
const DEFAULT_IDLE_WARM_MAX_BACKOFF_MS = 60_000;

export type RunnerIngressFailureCode =
  | "runner_ingress_unavailable"
  | "runner_ingress_auth_failed"
  | "runner_connection_lease_expired"
  /** An idle warm owner could not reach its runner before its lease neared expiry. */
  | "native_runner_ingress_unreachable";


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
  #closeRequested: number | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("pong", () => {
      this.#lastInboundAt = Date.now();
      if (this.#closeReason === null) this.#onPong?.();
    });
    socket.on("message", (data, isBinary) => {
      this.#lastInboundAt = Date.now();
      if (isBinary) {
        this.#closeSocket(1003);
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
        this.#closeSocket(1007);
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

  /**
   * The close code a holder of this wire asked for while the socket was still
   * open: the control plane refusing the connection (it closes the wire), or
   * this module's own deadline. Null when the peer or the network closed it,
   * or for this wire's own frame-protocol closes (#20825).
   */
  get closeRequested(): number | null {
    return this.#closeRequested;
  }

  close(code = 1000): void {
    if (
      this.#closeRequested === null &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      this.#closeRequested = code;
    }
    this.#closeSocket(code);
  }

  #closeSocket(code: number): void {
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

const BOUNDED_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError"]);

/**
 * One bounded failure code for every dial failure, never "other": an errno,
 * the upgrade's HTTP status, the handshake timeout, our own closed set, or the
 * error's constructor name. Only fixed strings and integers reach the log.
 */
export function ingressFailureCode(error: unknown): string {
  const value = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const errno = allowlistedErrnoCode(value.code);
  if (errno !== "other") return errno;
  const statusCode = finiteSafeInteger(value.statusCode);
  if (statusCode !== null && statusCode >= 100 && statusCode <= 599) return `upgrade_${statusCode}`;
  if (error instanceof RunnerIngressConnectionError) return error.code;
  const message = error instanceof Error ? error.message : "";
  // ws reports its own handshake timeout without an errno code.
  if (message === "Opening handshake has timed out") return "handshake_timeout";
  if (message === "runner ingress operation deadline elapsed") return "route_refresh_deadline_elapsed";
  if (message === "runner ingress operation was cancelled") return "cancelled";
  const reason = allowlistedIngressReason(message);
  if (reason) return reason;
  const name = error instanceof Error ? error.name : "";
  return BOUNDED_ERROR_NAMES.has(name) ? `error_${name}` : "error_unclassified";
}

function ingressErrorSummary(error: unknown): {
  code: string;
  errno: number | null;
  syscall: string;
  statusCode: number | null;
  reason: string | null;
  failure: string;
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
    failure: ingressFailureCode(error),
  };
}

/** Only codes this ingress path can emit are safe to include in logs. */
export function machineReasonCode(message: string): string | null {
  return allowlistedIngressReason(message);
}

function socketClosed(wire: WsJsonWireConnection): Promise<void> {
  return new Promise((resolve) => wire.onClose(() => resolve()));
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
  /**
   * A turn needs the runner now: end any pending backoff and dial at once.
   * Returns false when this handle no longer dials (terminal, quiesced or closed).
   * Optional so existing handle doubles stay valid; this module always sets it.
   */
  redialNow?(): boolean;
}

/** An idle warm owner's long redial policy (#20825). */
export interface RunnerIngressIdleWarmPolicy {
  /** True while no turn or command is in flight on this owner. */
  isIdle: () => boolean;
  /** The control plane's lease expiry; defaults to controlPlaneLeaseExpiresAtUnixMs. */
  leaseExpiresAtUnixMs?: () => number | null;
  /** Retire this long before the lease expires. */
  marginMs?: number;
  /** Upper bound on the backoff between dials after the recovery budget. */
  maxBackoffMs?: number;
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
  /**
   * An idle warm owner does not give up at the end of the recovery budget: it
   * redials at a capped backoff until its lease expiry minus a margin, then
   * fails with `native_runner_ingress_unreachable` so its owner retires it.
   */
  idleWarm?: RunnerIngressIdleWarmPolicy;
  onStateChange?: (
    state: "connecting" | "authenticated" | "reconnecting" | "failed" | "closed",
    failureCode?: RunnerIngressFailureCode,
  ) => void;
}): RunnerPrpOutboundHandle {
  const abort = new AbortController();
  const ownedWires = new Set<WsJsonWireConnection>();
  let endpoint = input.endpoint;
  const startupBudgetStartedAt = Date.now();
  const startupBudgetMs = input.startupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS;
  const startupDeadline = startupBudgetStartedAt + startupBudgetMs;
  const recoveryGraceMs = input.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS;
  const random = input.random ?? Math.random;
  const idleWarm = input.idleWarm;
  const idleMarginMs = idleWarm?.marginMs ?? DEFAULT_IDLE_WARM_RETIRE_MARGIN_MS;
  const idleMaxBackoffMs = Math.max(1, idleWarm?.maxBackoffMs ?? DEFAULT_IDLE_WARM_MAX_BACKOFF_MS);
  const readLeaseExpiry = idleWarm?.leaseExpiresAtUnixMs ?? (() => controlPlaneLeaseExpiresAtUnixMs(input.authority));
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  let readySettled = false;
  let stopLiveness = () => {};
  let loopEnded = false;
  // A pending backoff sleep; redialNow() ends it early.
  let wakeBackoff: (() => void) | null = null;
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

  const backoff = async (ms: number): Promise<void> => {
    if (abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", finish);
        if (wakeBackoff === finish) wakeBackoff = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      abort.signal.addEventListener("abort", finish, { once: true });
      wakeBackoff = finish;
    });
  };

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
    // Budget windows. The startup window logs every failed attempt (it is at
    // most a minute). A recovery window, and each idle extension window after
    // it, logs its first failure only: one bounded line per window.
    // openWindow() reassigns this from a closure; keep the declared union
    // so control-flow narrowing does not pin it to the initial value.
    let window = "startup" as "startup" | "recovery" | "idle_extension";
    let windowStartedAt = startupBudgetStartedAt;
    let windowAttempts = 0;
    let windowLogged = false;
    let extensionAttempt = 0;
    let authenticatedOnce = false;
    const idleOwner = () => idleWarm !== undefined && authenticatedOnce && idleWarm.isIdle();
    const idleRetireAt = (): number | null => {
      const expiresAt = readLeaseExpiry();
      return expiresAt === null ? null : expiresAt - idleMarginMs;
    };
    const openWindow = (kind: "recovery" | "idle_extension", deadline: number) => {
      window = kind;
      windowStartedAt = Date.now();
      windowAttempts = 0;
      windowLogged = false;
      recoveryDeadline = deadline;
      nextAttemptDeadline = deadline;
      connectAttempts = 0;
      minimumAttempts = kind === "recovery" ? minimumConnectAttempts(deadline - Date.now()) : 1;
    };
    while (!abort.signal.aborted) {
      let dialStarted = false;
      // Set only when the control plane itself closed an unauthenticated wire.
      let controlPlaneRefused = false;
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
            windowAttempts += 1;
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
          // Before this module closes it: did the control plane already close
          // the wire (an explicit refusal), or did the peer, the network or
          // the deadline end the handshake?
          controlPlaneRefused = !abort.signal.aborted && opened.wire.closeRequested !== null;
          opened.wire.close(1008);
          throw new RunnerIngressConnectionError(
            "runner_ingress_auth_failed",
            "Runner ingress did not complete PRP authentication before the deadline.",
          );
        }
        if (abort.signal.aborted) return;
        if (!readySettled) {
          readySettled = true;
          readyResolve();
        }
        input.onStateChange?.("authenticated");
        if (abort.signal.aborted) return;
        if (window !== "startup" && windowLogged) {
          logger.info({
            event: "runner_ingress_reconnected",
            window,
            attemptsInWindow: windowAttempts,
            windowElapsedMs: Math.max(0, Date.now() - windowStartedAt),
          }, "runner ingress reconnected");
        }
        authenticatedOnce = true;
        attempt = 0;
        extensionAttempt = 0;
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
        // Every authenticated connection that closes starts a fresh budget.
        openWindow("recovery", Date.now() + recoveryGraceMs);
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
        if (window === "startup" || !windowLogged) {
          windowLogged = true;
          logger.warn({
            event: "runner_ingress_connect_attempt_failed",
            attempt: failedAttemptNumber,
            window,
            elapsedMs: Math.max(0, Date.now() - startupBudgetStartedAt),
            remainingBudgetMs: Math.max(0, recoveryDeadline - Date.now()),
            ...summary,
          }, window === "startup"
            ? "runner ingress connect attempt failed"
            : "runner ingress connect attempt failed; further failures in this budget window are not logged");
        }
        let failure: unknown = error;
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            && (error as { statusCode?: unknown }).statusCode != null
            ? Number((error as { statusCode?: unknown }).statusCode)
            : null;
        const transportFailure = leaseFailureCode === null
          && (statusCode === null || statusCode >= 500)
          && !(failure instanceof RunnerIngressConnectionError && failure.code !== "runner_ingress_unavailable");
        // An idle warm runner that answers the dial but is refused by the
        // control plane (for example its welcome's checkpoint flush fails the
        // owner fence) will not authenticate on a later dial either. Retire at
        // this first failed handshake instead of spending the lease silently.
        // Only an explicit refusal counts: a peer drop (1006) or a slow
        // authentication before auth is a handshake loss, redialed below.
        const refusedIdleReconnect = leaseFailureCode === null && idleOwner() && controlPlaneRefused
          && failure instanceof RunnerIngressConnectionError && failure.code === "runner_ingress_auth_failed";
        // An idle owner redials a handshake loss within its idle window, like a transport failure.
        const idleRedialable = transportFailure || (dialStarted && !controlPlaneRefused && leaseFailureCode === null
          && failure instanceof RunnerIngressConnectionError && failure.code === "runner_ingress_auth_failed");
        if (
          !refusedIdleReconnect &&
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
        // The recovery budget is spent. An idle warm owner whose lease still
        // has time opens another window (up to lease expiry minus the margin)
        // instead of going terminal with nobody left to dial (#20825).
        if (
          !refusedIdleReconnect && !floorRetry && idleRedialable && leaseFailureCode === null
          && Date.now() >= retryDeadline && idleOwner()
        ) {
          const retireAt = idleRetireAt();
          if (retireAt !== null && Date.now() < retireAt) {
            openWindow("idle_extension", Math.min(Date.now() + recoveryGraceMs, retireAt));
            retryDeadline = recoveryDeadline;
          }
        }
        if (!refusedIdleReconnect && leaseFailureCode === null && Date.now() < retryDeadline) {
          const base = window === "idle_extension"
            ? Math.min(idleMaxBackoffMs, RECONNECT_DELAYS_MS.at(-1)! * 2 ** Math.min(extensionAttempt, 16))
            : RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
          attempt += 1;
          if (window === "idle_extension") extensionAttempt += 1;
          // No catch-up sleeps after a stalled dial; the floor permits at most
          // two extra dials. Inside a short cold budget retain the old 250/500ms
          // cadence instead of spending the entire budget on the added spacing.
          if (!floorRetry) {
            const jitter = 0.75 + random() * 0.5;
            const routeDelay = Math.max(1, Math.round(Math.max(base, MIN_ROUTE_REACQUIRE_DELAY_MS) * jitter));
            const retryDelay = transportFailure && routeDelay < retryDeadline - Date.now()
              ? routeDelay
              : Math.max(1, Math.round(base * jitter));
            await backoff(Math.min(
              window === "idle_extension" ? idleMaxBackoffMs : Number.POSITIVE_INFINITY,
              retryDelay,
              Math.max(1, retryDeadline - Date.now()),
            ));
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
          // The window ended during this backoff. An idle owner opens another
          // window if one fits before the lease's retirement point.
          if (
            window !== "startup" && leaseFailureCode === null && idleRedialable && idleOwner()
          ) {
            const retireAt = idleRetireAt();
            if (retireAt !== null && Date.now() < retireAt) {
              openWindow("idle_extension", Math.min(Date.now() + recoveryGraceMs, retireAt));
              nextAttemptDeadline = recoveryDeadline;
              continue;
            }
          }
        }
        const retiringIdleOwner = leaseFailureCode === null && idleOwner();
        const terminal =
          leaseFailureCode !== null
            ? new RunnerIngressConnectionError(
                leaseFailureCode,
                "The runner's connection lease expired before it was renewed.",
                { cause: failure },
              )
            : retiringIdleOwner
            ? new RunnerIngressConnectionError(
                "native_runner_ingress_unreachable",
                "The idle warm runner could not be reached before its connection lease neared expiry.",
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
        // The give-up is a decision; make it visible once, with bounded fields.
        logger.warn({
          event: retiringIdleOwner ? "runner_ingress_retired" : "runner_ingress_recovery_exhausted",
          code: terminal.code,
          failure: ingressFailureCode(failure),
          window,
          attempts: failedAttemptNumber,
          elapsedMs: Math.max(0, Date.now() - startupBudgetStartedAt),
          leaseExpiresAtUnixMs: idleWarm ? readLeaseExpiry() : null,
        }, retiringIdleOwner ? "runner ingress unreachable; retiring the idle warm owner" : "runner ingress recovery exhausted");
        if (!readySettled) {
          readySettled = true;
          readyReject(terminal);
        }
        input.onStateChange?.("failed", terminal.code);
        failureReject(terminal);
        return;
      }
    }
  })().finally(() => { loopEnded = true; });

  return {
    ready,
    failure,
    quiesce() {
      stopLiveness();
      // Established wires removed their handshake abort listener. Keep their ACK path.
      abort.abort();
    },
    redialNow() {
      if (loopEnded || abort.signal.aborted) return false;
      wakeBackoff?.();
      return true;
    },
    async close() {
      abort.abort();
      await Promise.all([...ownedWires].map(closeOwnedWire));
      await loop;
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

export { controlPlaneLeaseExpiresAtUnixMs };
