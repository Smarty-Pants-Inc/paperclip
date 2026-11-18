// D-B4 regression rows; author of the fix: code-lead.
// RFL conditions: classify ONLY an Error reporting exit=66 timedOut=false
// (with token boundaries), retain its cause, and leave timeouts, other exits,
// and corrupt/JSON-invalid state failures unchanged. Keep reason: a recovery
// failure path that a provider/user-flow test cannot reach cheaply.
// Real seam: public Codex thread/read -> resume -> authority rotation ->
// #externalRunnerStateArchive().read, with readRunnerState injected through
// existing options. Seed a real DurablePrpControlPlane checkpoint as in
// runnerd-codex-transport.test.ts's recorded-command recovery fixture. No
// runner/provider process is needed: these failures precede their launch.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { NativeRunnerResumeStateUnavailableError } from "../contracts/harness-driver.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

async function recoverWithExternalState(read: () => Promise<Record<string, unknown>>): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "db4-missing-runner-state-"));
  const priorIdentity = {
    runnerInstanceId: "db4-runner", environmentLeaseId: "db4-lease", normalizedSessionId: "db4-session",
    runId: "prior-run", turnId: "prior-turn", itemId: "prior-item",
  };
  const artifact = { version: "0.0.0-test", digest: `sha256:${"0".repeat(64)}` };
  let resumed: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  try {
    const builder = new DurablePrpControlPlane({
      stateDirectory: join(root, "control-plane"), identity: priorIdentity,
      expectedRunnerVersion: artifact.version, expectedRunnerDigest: artifact.digest,
    });
    try {
      builder.persistRunAttachTemplate({
        provider: { kind: "codex", command: "not-launched-codex", args: [] }, workspace: { cwd: root },
      });
    } finally {
      await builder.stop();
    }
    const controlPath = join(root, "control-plane", "control-plane-state.json");
    const controlBefore = await readFile(controlPath);
    const readRunnerState = vi.fn(read);
    const prepareExternalRunnerState = vi.fn(async () => {});
    const archiveExternalRunnerState = vi.fn(async () => { throw new Error("must not archive unreadable state"); });
    const launch = vi.fn(() => { throw new Error("must not launch a runner for these failure rows"); });
    resumed = createCapabilityRunnerdCodexTransport({
      provider: "codex", stateDirectory: root,
      runnerBinary: join(root, "not-launched-runnerd"), runnerArtifact: artifact,
      prpIdentity: { ...priorIdentity, runId: "follow-up-run", turnId: "follow-up-turn", itemId: "follow-up-item" },
      resumeProviderSession: { driverSessionId: "saved-thread", providerSessionId: "saved-provider-session" },
      readRunnerState, prepareExternalRunnerState, archiveExternalRunnerState,
      runnerProcessLauncher: launch,
    });
    const failure = await resumed.transport.request("thread/read", {}).then(
      () => null,
      (error: unknown) => error,
    );
    // These checks rule out an earlier generic missing-control-plane refusal
    // and prove that the real archive read, not a copied classifier, ran.
    expect(readRunnerState).toHaveBeenCalledTimes(1);
    expect(prepareExternalRunnerState).toHaveBeenCalledTimes(1);
    expect(prepareExternalRunnerState.mock.invocationCallOrder[0]).toBeLessThan(readRunnerState.mock.invocationCallOrder[0]!);
    expect(archiveExternalRunnerState).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(await readFile(controlPath)).toEqual(controlBefore);
    return failure;
  } finally {
    try {
      await resumed?.transport.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

it.each([
  "runner_remote_state_unavailable: exit=66 timedOut=false",
  "runner_remote_state_unavailable: exit=66 timedOut=false saved state is absent",
])("D-B4 classifies proven remote absence and preserves its cause: %s", async message => {
  const original = new Error(message);
  const failure = await recoverWithExternalState(async () => { throw original; });
  expect(failure).toBeInstanceOf(NativeRunnerResumeStateUnavailableError);
  expect((failure as Error & { cause?: unknown }).cause).toBe(original);
});

it.each([
  "runner_remote_state_unavailable: exit=null timedOut=true",
  "runner_remote_state_unavailable: exit=66 timedOut=true",
  "runner_remote_state_unavailable: exit=1 timedOut=false",
  "runner_remote_state_unavailable: exit=2 timedOut=false",
  "runner_remote_state_unavailable: exit=660 timedOut=false",
  "prefix runner_remote_state_unavailable: exit=66 timedOut=false",
  "runner_remote_state_unavailable: exit=66 timedOut=falseish",
])("D-B4 RFL preserves the original non-absence error: %s", async message => {
  const original = new Error(message);
  const failure = await recoverWithExternalState(async () => { throw original; });
  expect(failure).toBe(original);
  expect(failure).not.toBeInstanceOf(NativeRunnerResumeStateUnavailableError);
});

it("D-B4 RFL preserves the original JSON SyntaxError from malformed runner state", async () => {
  let original: unknown;
  const failure = await recoverWithExternalState(async () => {
    try {
      return JSON.parse("{ malformed runner state");
    } catch (error) {
      original = error;
      throw error;
    }
  });
  expect(original).toBeInstanceOf(SyntaxError);
  expect(failure).toBe(original);
  expect(failure).not.toBeInstanceOf(NativeRunnerResumeStateUnavailableError);
});

it("D-B4 RFL leaves resolved malformed state as an ordinary authority-validation failure", async () => {
  const failure = await recoverWithExternalState(async () => ({ schema: "invalid-runner-state" }));
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(NativeRunnerResumeStateUnavailableError);
  expect((failure as Error).message).toBe("native_runner_authority_rotation_requires_settled_state");
});

it.each([
  "runner_remote_state_unavailable: exit=66 timedOut=false",
  { message: "runner_remote_state_unavailable: exit=66 timedOut=false" },
])("D-B4 RFL does not classify a non-Error rejection: %j", async original => {
  const failure = await recoverWithExternalState(async () => { throw original; });
  expect(failure).toBe(original);
  expect(failure).not.toBeInstanceOf(NativeRunnerResumeStateUnavailableError);
});
