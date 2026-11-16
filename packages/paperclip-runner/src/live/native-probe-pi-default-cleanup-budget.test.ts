import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import type { HarnessSession } from "../contracts/harness-driver.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { PiEnvironmentProbeCleanupError } from "../drivers/pi/pi-environment-probe.js";
import {
  createCapabilityRunnerdCodexTransport,
  NativeEnvironmentProbeCleanupError,
  probeNativeRunnerEnvironment,
  type CapabilityRunnerdProcessEvidence,
} from "./runnerd-codex-transport.js";

const runId = "environment-probe";
const normalizedSessionId = "environment-probe";
const model = "neutral/noncatalog-model";
const event = (eventType: PrpEvent["eventType"], payload: Record<string, unknown> = {}, extra: Partial<PrpEvent> = {}): PrpEvent => ({
  schema: "paperclip.prp.event.v1", sourceEventId: "test", sourceSeq: 1, sourceInstanceId: "stub", sourceKind: "runner",
  runId, normalizedSessionId, turnId: "probe-turn", eventType, schemaVersion: 1, priority: 1,
  emittedAt: "2026-11-12T00:00:00.000Z", payload, ...extra,
});

function fakePiSession(retirementMs: number) {
  const ready = Promise.withResolvers<void>();
  const closeStarted = Promise.withResolvers<void>();
  let closeOperation: Promise<void> | undefined;
  let retirementConfirmed = false;
  let subscribed = false;
  const close = vi.fn((_input?: { reason?: string }) => {
    if (!closeOperation) {
      closeStarted.resolve();
      closeOperation = new Promise<void>(resolve => setTimeout(() => {
        retirementConfirmed = true;
        resolve();
      }, retirementMs));
    }
    return closeOperation;
  });
  const session: HarnessSession = {
    ids: () => ({ driverSessionId: "fixture-pi", providerSessionId: "fixture-pi-native" }),
    events: async function* () {
      subscribed = true;
      yield event("session.started", { context: { model, piRpcThinkingLevel: "off" } });
      await ready.promise;
      yield event("item.completed", { kind: "agentMessage", channel: "final", text: "hello" });
      yield event("turn.completed", {});
    },
    startTurn: vi.fn(async () => {
      expect(subscribed).toBe(true);
      ready.resolve();
      return { turnId: "probe-turn" };
    }),
    close,
    snapshot: async () => { throw new Error("probe must not persist an idle setup session"); },
  };
  return { session, close, closeStarted: closeStarted.promise, retirementConfirmed: () => retirementConfirmed };
}

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  { retirementMs: 15_000, succeeds: true },
  { retirementMs: 70_000, succeeds: false },
])("uses the default Pi cleanup budget through probeNativeRunnerEnvironment ($retirementMs ms close)", async ({ retirementMs, succeeds }) => {
  vi.useFakeTimers();
  const root = await mkdtemp(join(tmpdir(), "native-probe-pi-default-budget-"));
  const fixture = fakePiSession(retirementMs);
  let cleanupConfirmed = false;
  let result: { value?: Awaited<ReturnType<typeof probeNativeRunnerEnvironment>>; error?: unknown } | undefined;
  const probe = probeNativeRunnerEnvironment({
    runtimeDirectory: root,
    provider: "pi_rpc",
    model,
    environment: {},
    // The operation itself must be allowed to outlive 60 s so this test isolates cleanup.
    // Deliberately omit cleanupTimeoutMs: the default PI_PROBE_CLEANUP_BUDGET_MS path is under test.
    timeoutMs: 120_000,
    onCleanupConfirmed: async () => { cleanupConfirmed = true; },
    transportOptions: { piRpcThinkingLevel: "off" },
  }).then(value => { result = { value }; return result; }, error => { result = { error }; return result; });

  // The native probe owns a HarnessSession. Reuse the lowest fake-session seam
  // exercised by pi-environment-probe.test.ts while keeping both probe functions real.
  const prototypeBundle = createCapabilityRunnerdCodexTransport({ stateDirectory: join(root, "prototype-transport") });
  const transportPrototype = Object.getPrototypeOf(prototypeBundle.transport) as {
    evidence(this: unknown): CapabilityRunnerdProcessEvidence;
  };
  const originalEvidence = transportPrototype.evidence;
  const evidenceSpy = vi.spyOn(transportPrototype, "evidence").mockImplementation(function (this: unknown) {
    return { ...originalEvidence.call(this), providerDriver: "pi_rpc" };
  });
  const openSessionSpy = vi.spyOn(CodexAppServerDriver.prototype, "openSession").mockImplementation(async input => {
    expect(input).toMatchObject({ runId, normalizedSessionId });
    return fixture.session;
  });

  try {
    await fixture.closeStarted;
    if (succeeds) {
      await vi.advanceTimersByTimeAsync(retirementMs);
      const outcome = await probe;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({
        provider: "pi_rpc", providerDriver: "pi_rpc", effectiveModel: model, helloProbePassed: true,
      });
      expect(fixture.close).toHaveBeenCalled();
      expect(fixture.retirementConfirmed()).toBe(true);
      expect(cleanupConfirmed).toBe(true);
    } else {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.retirementConfirmed()).toBe(false);
      expect(cleanupConfirmed).toBe(false);
      await vi.advanceTimersByTimeAsync(retirementMs - 60_000);
      const outcome = await probe;
      expect(outcome.error).toBeInstanceOf(Error);
      expect(outcome.error).toMatchObject({
        message: expect.stringMatching(/cleanup|retirement|timed out/i),
      });
      if (outcome.error instanceof PiEnvironmentProbeCleanupError) {
        expect(outcome.error.cleanupError).toMatchObject({ message: "Pi probe retirement timed out." });
        await outcome.error.retired;
      } else if (outcome.error instanceof NativeEnvironmentProbeCleanupError) {
        // Older RED revisions can time out the outer join first; retire the same
        // owned fake close before checking cleanup confirmation.
        await outcome.error.retired.catch(() => undefined);
        await outcome.error.retryCleanup?.();
      } else {
        throw outcome.error;
      }
      expect(fixture.retirementConfirmed()).toBe(true);
      expect(cleanupConfirmed).toBe(true);
    }
  } finally {
    if (!fixture.retirementConfirmed()) await vi.advanceTimersByTimeAsync(retirementMs);
    if (result?.error instanceof NativeEnvironmentProbeCleanupError) await result.error.retryCleanup?.().catch(() => undefined);
    await probe;
    openSessionSpy.mockRestore();
    evidenceSpy.mockRestore();
    await prototypeBundle.transport.close().catch(() => undefined);
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
