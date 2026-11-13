import { createHash } from "node:crypto";
import { RUNNER_LAUNCH_ENVIRONMENT_SCRIPT } from "./runner-launch-environment.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { DurableRecoveryIdentity, RunnerExecutionDriver } from "../../vendor/paperclip-runner/index.js";
import type { NativeRunnerExecutionDriverInput } from "./native-runner-execution-driver.js";

/** A trusted distribution entry point, never a project command or plugin-supplied argv. */
export const SANDBOX_RUNNER_GUARDIAN_CLIENT = "/usr/local/libexec/paperclip-runner-guardian";
const MAX_FRAME = 16 * 1024;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (identity: DurableRecoveryIdentity) => JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))));
const sameSource = (a: DurableRecoveryIdentity, b: unknown) => !!b && canonical(a) === canonical(b as DurableRecoveryIdentity);
const failure = (reason: string) => new Error(`native_sandbox_runner_${reason}`);

/** Event-driven parking fence for the launcher's independent exec monitor.
 * A late probe is invalidated before the first await in release. Detach only
 * ends local supervision: it must never synthesize remote-exit evidence.
 */
export function createSandboxRunnerSupervision() {
  let generation = 0, paused = false, detached = false;
  const waiting = new Set<() => void>();
  const notify = () => { for (const wake of waiting) wake(); waiting.clear(); };
  return {
    get generation() { return generation; }, get paused() { return paused; }, get detached() { return detached; },
    accepts: (observed: number) => !paused && !detached && observed === generation,
    pause() { paused = true; generation++; notify(); },
    resume() { if (detached) throw failure("owner_cancelled"); paused = false; generation++; notify(); },
    detach() { detached = true; generation++; notify(); },
    async waitUntilActive() { while (paused && !detached) await new Promise<void>(resolve => waiting.add(resolve)); },
  };
}
export type SandboxRunnerSupervision = ReturnType<typeof createSandboxRunnerSupervision>;
export type SandboxRunnerAllocation = {
  companyId: string; environmentId: string; providerKey: string; providerLeaseId: string;
  scopeDigest: string; accountIdentity: string; credentialIdentity: string;
};
type Cut = { identity: DurableRecoveryIdentity; lastControllerCommandSeq: number; ackedSourceSeq: number };
type Route = { quiesce(): void; close(): Promise<void> };
export type SandboxRunnerRetentionInput = {
  binding: SandboxRunnerAllocation;
  lifecycle: NonNullable<AdapterSandboxExecutionTarget["runnerLeaseLifecycle"]>;
  openDuplexChannel: NonNullable<CommandManagedRuntimeRunner["openDuplexChannel"]>;
  runnerInstanceId: string;
  commandRunner?: CommandManagedRuntimeRunner;
  supervision: SandboxRunnerSupervision;
  releasedSource?: DurableRecoveryIdentity;
  signal?: AbortSignal;
  timeoutMs?: number;
  onResumed?: (identity: DurableRecoveryIdentity) => Promise<void>;
  onRetired?: (identity: DurableRecoveryIdentity) => Promise<void>;
};

/** Host-only lease and private fd-4 carrier owner. No ticket is persisted,
 * logged, placed in command argv/environment, or minted by this owner.
 * Unknown replies are errors, not absence. Rebind changes lease callbacks, not
 * the allocation/account/scope that was admitted with the retained process.
 */
export function createSandboxRunnerRetention(initial: SandboxRunnerRetentionInput) {
  let input = initial;
  const binding = { ...initial.binding };
  let generation = 0, qualified = false, cancelled = false, detached = false, retired = false;
  let qualification: { runnerBinary: string; runnerDigest: string } | undefined;
  let park: (Cut & { id: string }) | undefined;
  let claimId: string | undefined;
  let released = initial.releasedSource !== undefined;
  let parkConfirmed = released, stopConfirmed = released;
  let retirementProof = false;
  let route: Route | undefined;
  let nativeDriver: RunnerExecutionDriver | undefined;
  let updateNativeDriver: ((next: NativeRunnerExecutionDriverInput) => void) | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  const assertOwner = (expected = generation) => {
    if (cancelled || detached || input.signal?.aborted || expected !== generation) throw failure("owner_cancelled");
  };
  const carrier = async (frame: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const wire = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (wire.length > MAX_FRAME) throw failure("guardian_frame_too_large");
    // No onLog, environment, ticket or arbitrary command enters this boundary.
    const channel = await input.openDuplexChannel({ command: [SANDBOX_RUNNER_GUARDIAN_CLIENT, "client", "--protocol", "1", "--runner-id", input.runnerInstanceId] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        let bytes = Buffer.alloc(0), settled = false;
        const fail = () => { if (!settled) { settled = true; reject(failure("guardian_reply_uncertain")); } };
        timer = setTimeout(fail, input.timeoutMs ?? 15_000);
        channel.onExit(fail);
        channel.onData(chunk => {
          if (settled) return;
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > MAX_FRAME) { fail(); return; }
          const end = bytes.indexOf(10);
          if (end < 0) return;
          try {
            const value: unknown = JSON.parse(bytes.subarray(0, end).toString("utf8"));
            if (end !== bytes.length - 1 || !value || typeof value !== "object" || Array.isArray(value) ||
                (value as Record<string, unknown>).id !== frame.id) { fail(); return; }
            settled = true; resolve(value as Record<string, unknown>);
          } catch { fail(); }
        });
        try { channel.write(wire); } catch { fail(); }
      });
    } finally {
      clearTimeout(timer);
      // Closing this CLIENT must not close guardian fd4, including on errors.
      await channel.close();
    }
  };
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = serial.then(work);
    serial = pending.catch(() => undefined);
    return pending;
  };
  const qualify = async (expected: { runnerBinary: string; runnerDigest: string }) => {
    assertOwner(); const epoch = generation;
    const reply = await carrier({ op: "qualify", id: `qualify_${sha(JSON.stringify(expected))}`, ...expected });
    assertOwner(epoch);
    if (reply.status !== "qualified" || reply.guardianVersion !== 1 || reply.privateHostControlVersion !== 1 ||
        reply.runnerBinary !== expected.runnerBinary || reply.runnerDigest !== expected.runnerDigest) throw failure("guardian_qualification_failed");
    qualification = { ...expected }; qualified = true;
  };
  const observe = async (source: DurableRecoveryIdentity): Promise<Cut> => {
    const reply = await carrier({ op: "observe", id: `observe_${sha(canonical(source))}`, identity: source });
    if (reply.status !== "observed" || !sameSource(source, reply.identity) ||
        !Number.isSafeInteger(reply.lastControllerCommandSeq) || Number(reply.lastControllerCommandSeq) < 0 ||
        !Number.isSafeInteger(reply.ackedSourceSeq) || Number(reply.ackedSourceSeq) < 0) throw failure("guardian_source_or_cut_mismatch");
    return { identity: { ...source }, lastControllerCommandSeq: Number(reply.lastControllerCommandSeq), ackedSourceSeq: Number(reply.ackedSourceSeq) };
  };
  const release = (source: DurableRecoveryIdentity) => exclusive(async () => {
    assertOwner(); const epoch = generation;
    if (!qualified) throw failure("guardian_qualification_required");
    // An exact retry retains the original cut, even when the ACK was lost.
    if (park && !sameSource(park.identity, source)) {
      if (released) throw failure("released_source_mismatch");
      park = undefined; claimId = undefined; parkConfirmed = false; stopConfirmed = false;
    }
    input.supervision.pause(); route?.quiesce();
    if (!park) {
      const cut = await observe(source); assertOwner(epoch);
      park = { ...cut, id: `park_${sha(canonical(source))}` };
    }
    if (!parkConfirmed) {
      const reply = await carrier({ op: "park", ...park });
      assertOwner(epoch);
      if (reply.status !== "parked") throw failure("park_refused");
      parkConfirmed = true;
    }
    if (!stopConfirmed) {
      await input.lifecycle.releaseLease(); assertOwner(epoch);
      stopConfirmed = true;
    }
    // Only a verified reusable stop/release ACK permits closing the PRP route.
    await route?.close(); assertOwner(epoch);
    route = undefined; released = true;
  });
  const resume = (source: DurableRecoveryIdentity, ticket: string) => exclusive(async (): Promise<"resumed" | "unavailable"> => {
    assertOwner(); const epoch = generation;
    if (!released || (park && !sameSource(park.identity, source)) ||
        (input.releasedSource && !sameSource(input.releasedSource, source))) throw failure("released_source_mismatch");
    const id = `claim_${sha(ticket)}`;
    if (claimId && claimId !== id) throw failure("claim_ticket_changed");
    // Reserve the exact claim ID BEFORE crossing a boundary (including a lost reply).
    claimId = id;
    const outcome = await input.lifecycle.resumeLease(); assertOwner(epoch);
    if (outcome === "unavailable") return "unavailable";
    if (outcome !== "resumed") throw failure("environment_resume_uncertain");
    stopConfirmed = false;
    if (!qualified) {
      if (!qualification) throw failure("guardian_qualification_required");
      await qualify(qualification); assertOwner(epoch);
    }
    if (!park) { park = { ...await observe(source), id: `park_${sha(canonical(source))}` }; assertOwner(epoch); }
    const reply = await carrier({ op: "claim", id, parkId: park.id, bootstrapTicket: ticket });
    assertOwner(epoch);
    if (reply.status === "absent") {
      retirementProof = sameSource(source, reply.identity) && reply.executionStopped === true &&
        reply.descendantsStopped === true && reply.sessionStateAvailable === true &&
        reply.lastControllerCommandSeq === park.lastControllerCommandSeq && reply.ackedSourceSeq === park.ackedSourceSeq;
      return "unavailable";
    }
    if (reply.status !== "claimed") throw failure("claim_refused");
    released = false; input.supervision.resume();
    await input.onResumed?.(source); assertOwner(epoch);
    return "resumed";
  });
  const retire = async () => {
    if (retired) return;
    // Fence any in-flight release/claim before waiting for its exact receipt.
    cancelled = true; generation++; input.supervision.pause(); route?.quiesce();
    await exclusive(async () => {
      if (retired) return;
      if (retirementProof && park) {
        input.supervision.detach();
        await input.onRetired?.(park.identity);
        retired = true;
        return;
      }
      // An active unparked runner is suspended by the normal transport close.
      if (!park && !released) return;
      if (released || parkConfirmed) {
        const outcome = await input.lifecycle.resumeLease();
        if (outcome !== "resumed") throw failure("retirement_unproven");
        stopConfirmed = false;
      }
      if (!park) {
        if (!input.releasedSource) throw failure("retirement_unproven");
        park = { ...await observe(input.releasedSource), id: `park_${sha(canonical(input.releasedSource))}` };
      }
      const reply = await carrier({ op: "retire", id: `retire_${sha(`${park.id}:${claimId ?? "parked"}`)}`, parkId: park.id,
        ...(claimId ? { claimId, identity: park.identity, lastControllerCommandSeq: park.lastControllerCommandSeq, ackedSourceSeq: park.ackedSourceSeq } : {}) });
      if (reply.status !== "retired" || reply.executionStopped !== true || reply.descendantsStopped !== true || reply.sessionStateAvailable !== true) throw failure("retirement_unproven");
      retirementProof = true; input.supervision.detach();
      await input.onRetired?.(park.identity);
      retired = true;
    });
  };
  return {
    qualify,
    /** A validated persisted source carries prior guardian qualification. Its
     * executable is requalified after exact environment resume, before claim. */
    expectQualification(expected: { runnerBinary: string; runnerDigest: string }) {
      if (qualification && JSON.stringify(qualification) !== JSON.stringify(expected)) throw failure("guardian_qualification_mismatch");
      qualification = { ...expected };
    },
    get driver(): RunnerExecutionDriver["releaseResume"] {
      return qualified || input.releasedSource ? { release, resume, releasedSource: input.releasedSource } : undefined;
    },
    /** The resident guardian creates fd4 as a socketpair, keeps its peer
     * across client exits, and sends only bounded fixed protocol frames. */
    async launch(request: { command: string; args: readonly string[]; cwd: string; environment: Record<string, string | undefined>; identityPath: string; identityNonce: string; diagnosticsDirectory: string }) {
      assertOwner();
      if (!qualified) throw failure("guardian_qualification_required");
      const epoch = generation;
      // A proven cold recovery may retain the durable Runner ID. Its new
      // process nonce must not collide with the previous launch's receipt.
      const reply = await carrier({ op: "launch", id: `launch_${sha(`${input.runnerInstanceId}:${request.identityNonce}`)}`, ...request,
        command: "/bin/sh", args: ["-c", RUNNER_LAUNCH_ENVIRONMENT_SCRIPT + 'exec "$@"', "paperclip-runner-env", request.command, ...request.args] });
      assertOwner(epoch);
      if (reply.status !== "launched") throw failure("guardian_launch_unconfirmed");
    },
    get released() { return released; },
    get commandRunner() { return input.commandRunner; },
    get supervision() { return input.supervision; },
    get binding() { return { ...binding }; },
    bindRoute(next: Route) { route = next; },
    retire, retiredBeforeClaim: () => retirementProof,
    proof: () => ({ kind: "sandbox" as const, guardianVersion: 1, ...binding, ...(qualification ?? {}), ...(park ? { source: park.identity } : {}) }),
    detach() { detached = true; generation++; input.supervision.detach(); route = undefined; },
    rebind(next: SandboxRunnerRetentionInput) {
      if (cancelled || retired || detached || Object.keys(binding).some(key => binding[key as keyof SandboxRunnerAllocation] !== next.binding[key as keyof SandboxRunnerAllocation]) || next.runnerInstanceId !== input.runnerInstanceId) throw failure("owner_cannot_be_rebound");
      generation++; input = next;
    },
    rebindNativeDriver(next: NativeRunnerExecutionDriverInput) { if (nativeDriver) updateNativeDriver!(next); return nativeDriver; },
    bindNativeDriver(driver: RunnerExecutionDriver, update: (next: NativeRunnerExecutionDriverInput) => void) { nativeDriver = driver; updateNativeDriver = update; },
  };
}
export type SandboxRunnerRetention = ReturnType<typeof createSandboxRunnerRetention>;
