import { existsSync } from "node:fs";
import { measureNativeControllerStep } from "./native-controller-step-timing.js";
import type { SandboxRunnerRetention } from "./sandbox-runner-retention.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipRunnerTransport, type PaperclipRunnerTransport } from "@paperclipai/adapter-utils/runner-connectivity";
import type { RunnerExecutionDriver } from "../../vendor/paperclip-runner/index.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";
import { controlPlaneLeaseExpiresAtUnixMs } from "../../realtime/runner-control-plane-lease.js";
import type { NativeRunTrace } from "./native-run-trace.js";
import type { Db } from "@paperclipai/db";
import { nativeRunnerCheckpointRegistration } from "./native-runner-checkpoint.js";
import { readEnvironmentRunnerIngressFailure, type PluginEnvironmentRunnerIngressFailure } from "@paperclipai/plugin-sdk";

export class NativeRunnerIngressAcquisitionError extends Error {
  constructor(readonly failure: PluginEnvironmentRunnerIngressFailure) {
    super(`Runner connection endpoint could not be acquired (HTTP ${failure.httpStatus}).`);
    this.name = "NativeRunnerIngressAcquisitionError";
  }
}

type ConnectionRegistration = NonNullable<RunnerExecutionDriver["controlPlaneRegistration"]>;
type RunnerIdentity = Parameters<ConnectionRegistration>[1];

export interface NativeRunnerExecutionDriverInput {
  target: AdapterExecutionTarget;
  sandboxRetention?: SandboxRunnerRetention;
  binding: Omit<Parameters<typeof registerRunnerPrpAuthority>[0], "authority">;
  runnerIngressAuthorized?: boolean;
  runnerPublicUrl?: string | null;
  runnerCaBundlePath?: string | null;
  /** Validate and stage environment resources before process dispatch. */
  prepareRemote?: (mode: "listen_ws" | "dial_wss") => Promise<void>;
  mapCaBundle?: (sourcePath: string) => string | Promise<string>;
  processStarted?: Promise<void>;
  processIdentityReady?: Promise<void>;
  beforeConnect?: (identity: RunnerIdentity, authority: Parameters<ConnectionRegistration>[0]) => Promise<void>;
  controllerPersistence?: { db: Db; bootId: string; authorityRunId?: string | (() => string); onFailure?: (runId: string, leaseOwner: string) => Promise<void> };
  checkpoint?: Awaited<ReturnType<ConnectionRegistration>>["checkpoint"];
  process?: Omit<RunnerExecutionDriver, "controlPlaneRegistration">;
  trace?: NativeRunTrace;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /**
   * An idle warm listen_ws owner could not reach its runner before its lease
   * neared expiry (`native_runner_ingress_unreachable`). The owner retires the
   * warm session through its ordinary close path; the checkpoint stays (#20825).
   */
  onIngressUnreachable?: (error: Error) => void;
}

/** No command is pending to the runner (an identity check, a lifecycle
 * command). Only an additional busy signal: runnerd completes turn.start when
 * it ACCEPTS a turn, so this alone calls a running turn idle (#20825). */
function controlPlaneIdle(authority: unknown): boolean {
  const commands = (authority as { store?: { state?: { commands?: unknown } } }).store?.state?.commands;
  return Array.isArray(commands)
    && !commands.some(command => (command as { status?: unknown })?.status === "pending");
}

/** An authenticated route exhausted its recovery budget while its owner was
 * busy: the runner stayed unreachable mid-turn (#20825). */
export const NATIVE_RUNNER_INGRESS_RECOVERY_EXHAUSTED = "native_runner_ingress_recovery_exhausted";

/** The run-facing failure for an authenticated route's give-up. An idle
 * retire and a lease expiry keep their own codes; an exhausted recovery is
 * named, carrying only bounded codes (never transport prose). */
function authenticatedRouteFailure(error: unknown): unknown {
  const value = (typeof error === "object" && error !== null ? error : {}) as
    { code?: unknown; causeSummary?: { failure?: unknown } };
  const ingressCode = value.code;
  if (ingressCode !== "runner_ingress_unavailable" && ingressCode !== "runner_ingress_auth_failed") return error;
  const failure = typeof value.causeSummary?.failure === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value.causeSummary.failure)
    ? value.causeSummary.failure : "unknown";
  return Object.assign(new Error(`${NATIVE_RUNNER_INGRESS_RECOVERY_EXHAUSTED}: the runner stayed unreachable for the whole recovery budget (ingress=${ingressCode} failure=${failure})`,
    { cause: error }), { code: NATIVE_RUNNER_INGRESS_RECOVERY_EXHAUSTED, ingressCode, causeSummary: value.causeSummary });
}

async function measureNativeRunnerSpan<T>(
  trace: NativeRunTrace | undefined,
  name: string,
  fn: () => Promise<T>,
  options: { parentName?: string } = {},
): Promise<T> {
  return measureNativeControllerStep(name.replaceAll(".", "_"), () => trace ? trace.measure(name, fn, options) : fn());
}

/**
 * Select the remote runner transport before any artifact is staged or provider
 * endpoint is acquired. Sandbox ingress is available only to a run already
 * authorized by native runtime selection.
 */
export function resolveRemoteRunnerTransportMode(input: {
  target: AdapterExecutionTarget;
  runnerIngressAuthorized: boolean;
}): "listen_ws" | "dial_wss" {
  if (input.target.kind !== "remote") {
    throw new Error("runner_transport_ineligible: remote target is required");
  }
  const requiredMode =
    input.target.transport === "sandbox" &&
    input.target.effectiveCapabilities?.runnerWebSocketIngress === true
      ? "listen_ws"
      : "dial_wss";
  if (requiredMode === "listen_ws" && !input.runnerIngressAuthorized) {
    throw new Error("runner_ingress_unavailable");
  }
  return requiredMode;
}

type RemotePreparation = Pick<NativeRunnerExecutionDriverInput,
  "target" | "runnerIngressAuthorized" | "runnerPublicUrl" | "runnerCaBundlePath" | "prepareRemote"> & { runId: string };

async function resolveOutboundTransport(input: RemotePreparation): Promise<PaperclipRunnerTransport> {
  const transport = await resolvePaperclipRunnerTransport({ target: input.target, runId: input.runId,
    localConnectUrl: "ws://127.0.0.1/unused", runnerPublicUrl: input.runnerPublicUrl,
    runnerCaBundlePath: input.runnerCaBundlePath, runnerIngressAuthorized: input.runnerIngressAuthorized === true });
  if (transport.mode === "direct_outbound" && transport.caBundlePath && !existsSync(transport.caBundlePath)) {
    throw new Error("runner_direct_wss_failed: configured runner CA bundle is unavailable");
  }
  return transport;
}

/** Resolve artifacts before provider-profile binding. Endpoint acquisition stays
 * in connection registration; outbound eligibility is checked before staging.
 */
export async function prepareNativeRemoteRunner(input: RemotePreparation) {
  const mode = resolveRemoteRunnerTransportMode({ target: input.target,
    runnerIngressAuthorized: input.runnerIngressAuthorized === true });
  if (mode === "dial_wss") await resolveOutboundTransport(input);
  if (!input.prepareRemote) throw new Error("runner_remote_preparation_unavailable");
  await input.prepareRemote(mode);
}

/** Built-in environment lifecycle. PRP commands and authentication are shared;
 * only environment preparation, process ownership, and connection routing vary.
 */
export function createNativeRunnerExecutionDriver(input: NativeRunnerExecutionDriverInput): RunnerExecutionDriver {
  // A cached transport retains this driver object. Rebind ALL host callbacks,
  // including PRP preparation/checkpoint, rather than just the lease pair.
  const retained = input.sandboxRetention?.rebindNativeDriver(input);
  if (retained) return retained;
  // A fresh cold controller uses the ordinary suspended-source maintenance
  // lane. Only a released adoption/rebound cached owner fences source work to
  // the current business epoch while it claims and attaches that live source.
  let retainedRunAuthority = input.sandboxRetention?.released === true;
  const checkpoint: NativeRunnerExecutionDriverInput["checkpoint"] = input.sandboxRetention ? async settlement => {
    await input.sandboxRetention!.retire();
    await input.checkpoint?.(settlement);
  } : input.checkpoint;
  const driver: RunnerExecutionDriver = {
    ...input.process,
    get authorityRunId() {
      const owner = retainedRunAuthority ? input.controllerPersistence?.authorityRunId : undefined;
      return typeof owner === "function" ? owner() : owner ?? input.process?.authorityRunId;
    },
    ...(input.sandboxRetention ? {
      readRunnerState: input.process?.readRunnerState ? () => input.process!.readRunnerState!() : undefined,
      prepareExternalRunnerState: input.process?.prepareExternalRunnerState ? () => input.process!.prepareExternalRunnerState!() : undefined,
      archiveExternalRunnerState: input.process?.archiveExternalRunnerState ? archive => input.process!.archiveExternalRunnerState!(archive) : undefined,
    } : {}),
    get releaseResume() { return input.sandboxRetention?.driver ?? input.process?.releaseResume; },
    onStagedRunAttachment: input.controllerPersistence && input.binding.issueId
      ? async (authority, proof) => {
          // Both journals use the current business lease. Install persistence
          // before staging; endpoint acquisition still belongs to attachment.
          const register = nativeRunnerCheckpointRegistration({ ...input.controllerPersistence!,
            binding: { companyId: input.binding.companyId, issueId: input.binding.issueId!, runId: input.binding.runId },
          });
          // A restored stage already publishes under the target. Its writer
          // must exist before registration flushes that restored revision.
          const identities = authority.store?.state.stagedRunAttachment
            ? [proof.targetIdentity, proof.sourceIdentity] : [proof.sourceIdentity, proof.targetIdentity];
          for (const identity of identities) await register(authority, identity);
        }
      : undefined,
    controlPlaneRegistration: async (authority, attachmentIdentity) => {
      await measureNativeRunnerSpan(input.trace, "runner.checkpoint.register", async () => {
        await measureNativeControllerStep("before_connect", () => input.beforeConnect?.(attachmentIdentity, authority));
        if (input.controllerPersistence && input.binding.issueId) {
          await measureNativeControllerStep("checkpoint_registration", () => nativeRunnerCheckpointRegistration({ ...input.controllerPersistence!,
            binding: { companyId: input.binding.companyId, issueId: input.binding.issueId!, runId: input.binding.runId },
          })(authority, attachmentIdentity));
        }
      }, { parentName: "runner.session.startup" });
      return measureNativeRunnerSpan(
        input.trace,
        "runner.transport.connect",
        async () => {
          if (input.target.kind === "local") {
            const selectedAtMs = Date.now();
            await input.trace?.record({
              name: "runner.transport.selected",
              parentName: "runner.transport.connect",
              startedAtMs: selectedAtMs,
              endedAtMs: selectedAtMs,
              attributes: {
                mode: "local_loopback",
                connectionOwner: "runnerd",
              },
            });
            await input.onLog?.(
              "stderr",
              "[paperclip-runner] transport mode=local_loopback state=connecting\n",
            );
            const registration = await measureNativeRunnerSpan(
              input.trace,
              "runner.prp.route.register",
              () =>
                registerRunnerPrpAuthority({
                  ...input.binding,
                  runId:
                    attachmentIdentity?.runId ??
                    input.binding.runId,
                  authority,
                }),
            );
            return {
              ...registration,
              startupFailureCode: "runner_local_connect_failed" as const,
            };
          }

          if (!input.prepareRemote) throw new Error("runner_remote_preparation_unavailable");
          const requiredMode = resolveRemoteRunnerTransportMode({
            target: input.target,
            runnerIngressAuthorized: input.runnerIngressAuthorized === true,
          });
          let transport: PaperclipRunnerTransport;
          if (requiredMode === "dial_wss") {
            // Validate eligibility before staging any artifact.
            transport = await measureNativeRunnerSpan(
              input.trace,
              "runner.transport.resolve",
              () => resolveOutboundTransport({ ...input, runId: attachmentIdentity?.runId ?? input.binding.runId }),
            );
            await measureNativeRunnerSpan(
              input.trace,
              "runner.artifact.prepare",
              () => input.prepareRemote!(requiredMode),
            );
          } else {
            await measureNativeRunnerSpan(
              input.trace,
              "runner.artifact.prepare",
              () => input.prepareRemote!(requiredMode),
            );
            // Provider endpoint acquisition happens only after runnerd is staged
            // and its listener capability has been verified.
            try {
              transport = await measureNativeRunnerSpan(
                input.trace,
                "runner.ingress.acquire",
                () =>
                  resolvePaperclipRunnerTransport({
                    target: input.target,
                    runId: attachmentIdentity?.runId ?? input.binding.runId,
                    localConnectUrl: "ws://127.0.0.1/unused",
                    runnerPublicUrl: input.runnerPublicUrl,
                    runnerCaBundlePath: input.runnerCaBundlePath,
                    runnerIngressAuthorized: true,
                  }),
              );
            } catch (error) {
              const failure = readEnvironmentRunnerIngressFailure(error);
              if (failure) throw new NativeRunnerIngressAcquisitionError(failure);
              throw error;
            }
          }

          const selectedAtMs = Date.now();
          await input.trace?.record({
            name: "runner.transport.selected",
            parentName: "runner.transport.connect",
            startedAtMs: selectedAtMs,
            endedAtMs: selectedAtMs,
            attributes: {
              mode: transport.mode,
              connectionOwner:
                transport.mode === "provider_ingress"
                  ? "paperclip"
                  : "runnerd",
            },
          });

          await input.onLog?.(
            "stderr",
            `[paperclip-runner] transport mode=${transport.mode} state=connecting\n`,
          );

          if (transport.mode === "direct_outbound") {
            const caBundlePath = transport.caBundlePath && input.mapCaBundle
              ? await input.mapCaBundle(transport.caBundlePath)
              : transport.caBundlePath;
            const inbound = await measureNativeRunnerSpan(
              input.trace,
              "runner.prp.route.register",
              () =>
                registerRunnerPrpAuthority({
                  ...input.binding,
                  runId:
                    attachmentIdentity?.runId ??
                    input.binding.runId,
                  authority,
                }),
              { parentName: "runner.transport.connect" },
            );
            input.sandboxRetention?.bindRoute({ quiesce: () => {}, close: () => inbound.release() });
            return {
              connection: {
                mode: "connect" as const,
                connectUrl: transport.connectUrl,
                ...(caBundlePath ? { caBundlePath } : {}),
              },
              startupFailureCode: "runner_direct_wss_failed" as const,
              checkpoint,
              ready: input.processIdentityReady ? async () => { await input.processIdentityReady; } : undefined,
              release: async reason => { if (reason === "detach") input.sandboxRetention?.detach(); await inbound.release(); },
            };
          }

          if (transport.mode !== "provider_ingress") {
            throw new Error("runner_transport_mode_changed_after_dispatch");
          }
          if (!input.processStarted) {
            await transport.ingress.close();
            throw new Error("runner_process_start_barrier_unavailable");
          }
          let outbound: ReturnType<typeof connectRunnerPrpIngress> | null =
            null;
          let activation: Promise<void> | null = null;
          let ingress = transport.ingress;
          let released = false;
          // One failure promise for the registration, readable right after
          // activate() (before the route exists) and following route
          // replacement. Only an authenticated route's exhausted recovery
          // rejects it; startup failures surface through ready().
          let rejectRouteFailure!: (error: unknown) => void;
          const routeFailure = new Promise<never>((_resolve, reject) => { rejectRouteFailure = reject; });
          void routeFailure.catch(() => undefined);
          let reportedUnreachable = false;
          // The owner's idleness, bound by the transport (its settled idle
          // warm owner predicate). Unbound means busy.
          let ownerIdle: (() => boolean) | null = null;
          const openRoute = (startupDeadlineMs?: number) => {
            const route = connectRunnerPrpIngress({
              authority, endpoint: ingress, startupDeadlineMs,
              // #20825: an idle warm route redials past the recovery budget
              // until the control plane's lease expiry minus a margin. Idle is
              // the OWNER's idleness; a pending CP command is an extra busy signal.
              idleWarm: {
                isIdle: () => ownerIdle !== null && ownerIdle() === true && controlPlaneIdle(authority),
                leaseExpiresAtUnixMs: () => controlPlaneLeaseExpiresAtUnixMs(authority),
              },
              onStateChange: (state, failureCode) => {
                void input.onLog?.("stderr",
                  `[paperclip-runner] transport mode=provider_ingress state=${state}${failureCode ? ` failure=${failureCode}` : ""}\n`);
              },
            });
            let authenticated = false;
            void route.ready?.then(() => { authenticated = true; }, () => undefined);
            void route.failure?.catch((error: unknown) => {
              if (!authenticated || released || outbound !== route) return;
              rejectRouteFailure(authenticatedRouteFailure(error));
              const code = (error as { code?: unknown })?.code;
              if (code === "native_runner_ingress_unreachable" && !reportedUnreachable) {
                reportedUnreachable = true;
                input.onIngressUnreachable?.(error instanceof Error ? error : new Error(String(code)));
              }
            });
            return route;
          };
          const closeRoute = async () => {
            released = true;
            if (outbound) await outbound.close();
            else await ingress.close();
          };
          input.sandboxRetention?.bindRoute({ quiesce: () => outbound?.quiesce(), close: closeRoute });
          return {
            connection: {
              mode: "listen" as const,
              listenAddress: transport.listenAddress,
              listenPort: transport.listenPort,
              listenPath: transport.listenPath,
            },
            activate: () => {
              activation = measureNativeRunnerSpan(
                input.trace,
                "runner.transport.activation",
                async () => {
                  await measureNativeRunnerSpan(
                    input.trace,
                    "runner.ingress.wait_for_process",
                    () => input.processStarted!,
                  );
                  if (released) return;
                  outbound = openRoute();
                },
                { parentName: "runner.session.startup" },
              );
              // Cancellation can release the sandbox while activation is
              // still waiting for the remote runner process. Attach a
              // rejection observer immediately; `ready()` still awaits the
              // original promise and reports the same startup failure, but
              // an early teardown can no longer crash the controller with
              // an unhandled plugin RPC rejection.
              void activation.catch(() => undefined);
            },
            ready: async () => {
              await measureNativeRunnerSpan(
                input.trace,
                "runner.transport.ready",
                async () => {
                  await measureNativeControllerStep("ingress_activation", () => activation);
                  if (!outbound)
                    throw new Error("runner_ingress_unavailable");
                  await measureNativeRunnerSpan(
                    input.trace,
                    "runner.prp.authenticate",
                    () => outbound!.ready,
                  );
                  await measureNativeControllerStep("process_identity_ready", () => input.processIdentityReady);
                },
                { parentName: "runner.session.startup" },
              );
            },
            ensureConnected: async ({ deadline, signal }) => {
              const assertOpen = () => {
                if (released || signal.aborted || Date.now() >= deadline) throw new Error("runner_ingress_reopen_cancelled");
              };
              assertOpen();
              await activation;
              assertOpen();
              const count = authority.activeRunnerConnectionCount();
              if (count === 1) return;
              if (count !== 0) throw new Error("runner_ingress_owner_ambiguous");
              // A route that is still redialing (an idle warm owner past its
              // recovery budget) dials at once for the arriving turn. Keep it:
              // closing it would leave nobody dialing if this reopen fails.
              if (outbound?.redialNow?.()) {
                while (authority.activeRunnerConnectionCount() === 0) {
                  assertOpen();
                  await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(25, deadline - Date.now()))));
                }
                assertOpen();
                if (authority.activeRunnerConnectionCount() !== 1) throw new Error("runner_ingress_owner_ambiguous");
                return;
              }
              // Refresh the existing authenticated capability. Never acquire a
              // second allocation, change run identity, or launch a process.
              const refreshed = await ingress.refresh();
              if (refreshed.generation !== ingress.generation) {
                await refreshed.close();
                throw new Error("runner_ingress_owner_changed");
              }
              if (released || signal.aborted || Date.now() >= deadline) {
                await refreshed.close();
                throw new Error("runner_ingress_reopen_cancelled");
              }
              await outbound?.close();
              if (released || signal.aborted || Date.now() >= deadline) {
                await refreshed.close();
                throw new Error("runner_ingress_reopen_cancelled");
              }
              ingress = refreshed;
              const next = outbound = openRoute(Math.max(1, deadline - Date.now()));
              let onAbort: (() => void) | undefined;
              try {
                await Promise.race([
                  next.ready,
                  new Promise<never>((_resolve, reject) => {
                    onAbort = () => { next.quiesce(); reject(new Error("runner_ingress_reopen_cancelled")); };
                    signal.addEventListener("abort", onAbort, { once: true });
                    if (signal.aborted) onAbort();
                  }),
                ]);
                assertOpen();
                if (authority.activeRunnerConnectionCount() !== 1) throw new Error("runner_ingress_owner_ambiguous");
              } catch (error) {
                await next.close();
                throw error;
              } finally {
                if (onAbort) signal.removeEventListener("abort", onAbort);
              }
            },
            get failure() {
              return routeFailure;
            },
            bindOwnerIdle: (isIdle: () => boolean) => { ownerIdle = isIdle; },
            startupFailureCode: "runner_ingress_unavailable" as const,
            checkpoint,
            quiesce: () => { outbound?.quiesce(); },
            release: async reason => {
              if (reason === "detach") input.sandboxRetention?.detach();
              await closeRoute();
            },
          };
        },
      );
    },
  };
  input.sandboxRetention?.bindNativeDriver(driver, next => { input = next; retainedRunAuthority = true; });
  return driver;
}
