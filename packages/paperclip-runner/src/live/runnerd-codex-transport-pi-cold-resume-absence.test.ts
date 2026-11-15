// D-B8 (v2) regression rows; author of the fix: code-lead.
// RFL conditions: ONLY under providerRecoveryPolicy
// allow_replacement_after_governed_wait, and ONLY an Error matching D-B4's exact
// /^runner_remote_state_unavailable: exit=66 timedOut=false(?:\s|$)/ proves
// absent external Runner state and permits Pi cold resume. Timeouts, other
// exits, near-matching exits and JSON parse failures preserve the ORIGINAL
// read error object; a returned state preserves the ORIGINAL resume error.
// Keep reason: recovery/data-safety failure path not cheaply reachable in a user flow.
// Real seam: public prepareConversationResume(params, recovery), with
// recovery.allowMissingProviderState=true -> the real missing-checkpoint
// resume -> #preparePiConversationResume ->
// public thread/read -> cold start. No existing src/**/*.test.ts covers the
// ladder keywords; setup follows the absent-state row in
// runnerd-codex-transport-cold-restore.test.ts and the prepared-launch seam in
// runnerd-codex-transport-release-resume.test.ts. The real launch factory builds
// an inert descriptor; registration observes the persisted cold-resume marker
// and stops BEFORE runner/provider launch. This is not a real Pi process proof,
// and neither the ladder nor its error classifier is copied or mocked.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NativeRunnerResumeStateUnavailableError } from "../contracts/harness-driver.js";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import {
  createRunnerProviderLaunch,
  runnerLaunchRequirementsDigest,
  type RunnerProviderLaunchRequirements,
} from "./runner-provider-launch.js";

const savedPiThread = "db8-saved-pi-thread";

type Policy = "allow_replacement_after_governed_wait" | "allow_replacement_after_resume_failure" | "same_session_only";
async function exerciseColdResumeLadder(read: () => Promise<Record<string, unknown>>,
  providerRecoveryPolicy: Policy = "allow_replacement_after_governed_wait") {
  const root = await mkdtemp(join(tmpdir(), "db8-pi-cold-resume-"));
  const controlPath = join(root, "control-plane", "control-plane-state.json");
  const stopAtRegistration = new Error("D-B8 fixture stops after cold-resume marker persistence");
  const readRunnerState = vi.fn(read);
  const prepareExternalRunnerState = vi.fn(async () => {});
  const launch = vi.fn(() => { throw new Error("D-B8 fixture must not launch a process"); });
  const phases: string[] = [];
  let originalResumeError: unknown;
  let registeredTemplate: unknown;
  const prepareLaunch = vi.fn(async (requirements: RunnerProviderLaunchRequirements) => {
    const provider = createRunnerProviderLaunch(requirements, {
      options: {}, root, cwd: root, codexHome: root,
      providerNodeCommand: join(root, "not-launched-node"),
      piProxyPath: join(root, "not-launched-pi-proxy.cjs"),
      opencodeProxyPath: "", acpxSidecarPath: "",
    });
    // Only the transport's cold-resume ladder may add the saved Pi ID.
    expect(provider).not.toHaveProperty("providerSessionId");
    return { configurationId: "db8-inert-pi-launch",
      requirementsDigest: runnerLaunchRequirementsDigest(requirements), provider };
  });
  const register = vi.fn(async (core: DurablePrpControlPlane) => {
    registeredTemplate = structuredClone(core.store.state.runAttachTemplate);
    throw stopAtRegistration;
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    provider: "pi_rpc", stateDirectory: root,
    runnerBinary: join(root, "not-launched-runnerd"),
    runnerArtifact: { version: "0.0.0-test", digest: `sha256:${"0".repeat(64)}` },
    prpIdentity: { runnerInstanceId: "db8-runner", environmentLeaseId: "db8-lease",
      normalizedSessionId: "db8-session", runId: "follow-up-run", turnId: "follow-up-turn", itemId: "follow-up-item" },
    resumeProviderSession: { driverSessionId: savedPiThread, providerSessionId: savedPiThread },
    // Explicit null is required by the ladder: no in-flight turn is recoverable.
    resumeActiveTurnId: null,
    providerRecoveryPolicy,
    piRpcThinkingLevel: "off",
    readRunnerState, prepareExternalRunnerState, prepareLaunch,
    runnerProcessLauncher: launch, controlPlaneRegistration: register,
    measureOperation: async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
      phases.push(phase);
      try { return await work(); }
      catch (error) {
        // Observe, rather than replace, the error from the real #resumeWork.
        if (phase === "runner.transport.resume") originalResumeError = error;
        throw error;
      }
    },
  });
  try {
    const params = { threadId: savedPiThread, cwd: root, model: "openai/gpt-5", dynamicTools: [] };
    expect(bundle.transport.prepareConversationResume).toBeTypeOf("function");
    const preparationFailure = await bundle.transport.prepareConversationResume!(params, {
      allowMissingProviderState: true,
    }).then(() => undefined, (error: unknown) => error);
    expect(originalResumeError).toBeInstanceOf(NativeRunnerResumeStateUnavailableError);
    expect(phases.filter(phase => phase === "runner.transport.resume")).toHaveLength(1);
    expect(prepareExternalRunnerState).toHaveBeenCalledTimes(1);
    expect(readRunnerState).toHaveBeenCalledTimes(1);
    expect(prepareExternalRunnerState.mock.invocationCallOrder[0]).toBeLessThan(readRunnerState.mock.invocationCallOrder[0]!);
    // Preparation alone never starts a fresh thread. The initial exact-ID
    // thread/read consumes the ladder's cold-resume start parameters.
    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(existsSync(controlPath)).toBe(false);
    let coldReadFailure: unknown;
    let persistedTemplate: unknown;
    if (preparationFailure === undefined) {
      coldReadFailure = await bundle.transport.request("thread/read", { threadId: savedPiThread }).then(
        () => undefined, (error: unknown) => error,
      );
      if (existsSync(controlPath)) {
        persistedTemplate = JSON.parse(await readFile(controlPath, "utf8")).runAttachTemplate;
      }
    }
    expect(launch).not.toHaveBeenCalled();
    if (preparationFailure !== undefined) {
      expect(phases).not.toContain("runner.transport.cold_start");
      expect(prepareLaunch).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(registeredTemplate).toBeUndefined();
      expect(existsSync(controlPath)).toBe(false);
    }
    return { preparationFailure, originalResumeError, coldReadFailure, stopAtRegistration,
      registeredTemplate, persistedTemplate, phases,
      preparationCount: prepareLaunch.mock.calls.length, registrationCount: register.mock.calls.length };
  } finally {
    try { await bundle.transport.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

// Expected: RED before D-B8; GREEN after D-B8.
it("D-B8 RFL permits Pi cold resume for exact exit=66 timedOut=false absence", async () => {
  const absence = new Error("runner_remote_state_unavailable: exit=66 timedOut=false");
  const result = await exerciseColdResumeLadder(async () => { throw absence; });
  expect(result.preparationFailure).toBeUndefined();
  expect(result.coldReadFailure).not.toBe(absence);
  expect(result.coldReadFailure).toBe(result.stopAtRegistration);
  expect(result.phases.filter(phase => phase === "runner.transport.cold_start")).toHaveLength(1);
  expect(result.preparationCount).toBe(1);
  expect(result.registrationCount).toBe(1);
  const marker = { provider: { kind: "pi_rpc", providerSessionId: savedPiThread } };
  expect(result.registeredTemplate).toMatchObject(marker);
  expect(result.persistedTemplate).toMatchObject(marker);
});

// Expected: GREEN before and after D-B8. Outside a governed wait the plain policy's
// replacement session (with the task-history handoff) must decide, so even the exact
// absence keeps the original error and the ladder does not cold-resume.
it.each(["allow_replacement_after_resume_failure", "same_session_only"] as const)(
  "D-B8 RFL keeps the original absence error outside a governed wait: %s", async policy => {
  const absence = new Error("runner_remote_state_unavailable: exit=66 timedOut=false");
  const result = await exerciseColdResumeLadder(async () => { throw absence; }, policy);
  expect(result.preparationFailure).toBe(absence);
  expect(result.persistedTemplate).toBeUndefined();
});

// Expected: every negative is GREEN both before and after D-B8.
it.each([
  "runner_remote_state_unavailable: exit=66 timedOut=true",
  "runner_remote_state_unavailable: exit=1 timedOut=false",
  "runner_remote_state_unavailable: exit=2 timedOut=false",
  "runner_remote_state_unavailable: exit=660 timedOut=false",
])("D-B8 RFL preserves the original non-absence error without cold resume: %s", async message => {
  const original = new Error(message);
  const result = await exerciseColdResumeLadder(async () => { throw original; });
  expect(result.preparationFailure).toBe(original);
  expect(result.preparationFailure).not.toBe(result.originalResumeError);
  expect(result.persistedTemplate).toBeUndefined();
});

it("D-B8 RFL preserves the original JSON SyntaxError without cold resume", async () => {
  let original: unknown;
  const result = await exerciseColdResumeLadder(async () => {
    try { return JSON.parse("{ malformed runner state"); }
    catch (error) { original = error; throw error; }
  });
  expect(original).toBeInstanceOf(SyntaxError);
  expect(result.preparationFailure).toBe(original);
  expect(result.preparationFailure).not.toBe(result.originalResumeError);
  expect(result.persistedTemplate).toBeUndefined();
});

it("D-B8 RFL preserves the original resume error when external Runner state exists", async () => {
  const result = await exerciseColdResumeLadder(async () => ({
    schema: "paperclip.runner.durable.state.v1", runnerInstanceId: "db8-runner",
    environmentLeaseId: "db8-lease", normalizedSessionId: "db8-session",
    runId: "prior-run", turnId: "prior-turn", itemId: "prior-item", lifecycle: "suspended",
  }));
  expect(result.preparationFailure).toBe(result.originalResumeError);
  expect(result.persistedTemplate).toBeUndefined();
});
