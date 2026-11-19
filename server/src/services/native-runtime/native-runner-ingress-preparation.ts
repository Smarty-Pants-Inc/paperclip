import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipRunnerTransport, type PaperclipRunnerTransport } from "@paperclipai/adapter-utils/runner-connectivity";
import type { NativeRunHistoricalSpan, NativeRunTrace } from "./native-run-trace.js";

type SandboxTarget = Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
type EndpointProvider = NonNullable<SandboxTarget["getRunnerIngressEndpoint"]>;
type Acquisition = { transport: PaperclipRunnerTransport } | { error: unknown };
type Preparation = { runId: string; join: (trace?: NativeRunTrace) => Promise<PaperclipRunnerTransport>; transfer: () => void };
// The run-owned callback survives workspace target projections/spreads. No
// global run-id cache, durable state, credential, or authorization is added.
const preparations = new WeakMap<EndpointProvider, Preparation>();

/** Only a resolved native warm attach may overlap acquisition with preparation.
 * Cold runners still verify their listener/artifact before acquiring ingress.
 * The caller MUST join release() in its existing preparation finally path.
 */
export function startNativeRunnerIngressPreparation(input: {
  target: AdapterExecutionTarget;
  runId: string;
  runnerIngressAuthorized: boolean;
}): { target: AdapterExecutionTarget; release: () => Promise<void> } | undefined {
  const target = input.target;
  if (!input.runnerIngressAuthorized || target.kind !== "remote" || target.transport !== "sandbox"
    || target.runnerTask || target.runnerLifecyclePolicy?.mode !== "warm"
    || target.sandboxLeaseAcquisition?.outcome !== "resumed"
    || target.effectiveCapabilities?.runnerWebSocketIngress !== true
    || !target.leaseId || !target.getRunnerIngressEndpoint) return undefined;
  const span: NativeRunHistoricalSpan = { name: "runner.ingress.acquire", parentName: "task.prepare",
    startedAtMs: Date.now(), endedAtMs: Date.now() };
  // Observe BOTH outcomes immediately. A failed endpoint is reported only at
  // the original registration join, after artifact preparation and checkpoints.
  const settled: Promise<Acquisition> = resolvePaperclipRunnerTransport({ target, runId: input.runId,
    localConnectUrl: "ws://127.0.0.1/unused", runnerIngressAuthorized: true }).then(
    transport => {
      span.endedAtMs = Date.now();
      if (transport.mode === "provider_ingress") {
        const endpoint = transport.ingress;
        let closing: Promise<void> | undefined;
        transport = { ...transport, ingress: {
          kind: endpoint.kind, websocketUrl: endpoint.websocketUrl, secretHeaders: endpoint.secretHeaders, generation: endpoint.generation,
          refresh: () => endpoint.refresh(), close: () => closing ??= endpoint.close(),
        } };
      }
      return { transport };
    },
    error => { span.endedAtMs = Date.now(); span.outcome = "failed"; return { error }; },
  );
  let transferred = false;
  let claimed = false;
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = () => {
    if (transferred) return Promise.resolve();
    released = true;
    return releasing ??= settled.then(async result => {
      // This is the same endpoint release used by connection registration when
      // setup ends before activation. Never open an unauthenticated route.
      if ("transport" in result && result.transport.mode === "provider_ingress") await result.transport.ingress.close();
    });
  };
  const join = async (trace?: NativeRunTrace) => {
    const result = await settled;
    await trace?.record(span, { deferRunLog: true });
    if (released) throw new Error("native_session_cancelled");
    if ("error" in result) throw result.error;
    if (claimed) throw new Error("runner_ingress_already_claimed");
    claimed = true;
    return result.transport;
  };
  // Registration normally consumes the transport directly below. Keep the
  // ordinary target API usable, but never return A's endpoint to another run.
  const getRunnerIngressEndpoint: EndpointProvider = async request => {
    if (request.path !== `/api/runner/v1/connect/${encodeURIComponent(input.runId)}`) {
      return target.getRunnerIngressEndpoint!(request);
    }
    const transport = await join();
    if (transport.mode !== "provider_ingress") throw new Error("runner_transport_mode_changed_after_dispatch");
    return transport.ingress;
  };
  preparations.set(getRunnerIngressEndpoint, { runId: input.runId, join, transfer: () => { transferred = true; } });
  return { target: { ...target, getRunnerIngressEndpoint }, release };
}

function preparationFor(target: AdapterExecutionTarget, runId: string) {
  if (target.kind !== "remote" || target.transport !== "sandbox" || !target.getRunnerIngressEndpoint) return undefined;
  const preparation = preparations.get(target.getRunnerIngressEndpoint);
  return preparation?.runId === runId ? preparation : undefined;
}

export function preparedNativeRunnerIngress(target: AdapterExecutionTarget, runId: string, trace?: NativeRunTrace) {
  return preparationFor(target, runId)?.join(trace);
}

/** Only a completed registration hands cleanup to the existing route owner. */
export function transferPreparedNativeRunnerIngress(target: AdapterExecutionTarget, runId: string) {
  preparationFor(target, runId)?.transfer();
}
