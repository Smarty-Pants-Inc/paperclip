// smarty-dev#21273 (run 974bfc09, SMA-627): a task Retry resumed a native Pi
// session on a brand-new box. An earlier attempt had already moved the prior
// control plane into its authority epoch on the controller, so the rotation
// resumed from that archive and asked the new box to archive Runner state it
// never held: `runner_remote_authority_archive_failed`, finalization blocked.
// The saved checkpoint must be staged onto the new box first (the host
// preparation that a first-attempt rotation runs before its read). No Runner
// or provider starts: each resume stops before the launch.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

const STOP = "test stops at the runner launch";
// Past the rotation, the launch stops at the absent Pi executable or the launcher.
const PAST_ROTATION = /test stops at the runner launch|runner_native_pi_executable_required/;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const artifact = { version: "0.0.0-test", digest: `sha256:${"0".repeat(64)}` };
const identity = (runId: string) => ({ runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId,
  normalizedSessionId: "session-1", turnId: `turn-${runId}`, itemId: `item-${runId}` });
const prior = identity("prior");
const suspended = JSON.stringify({ schema: "paperclip.runner.durable.state.v1", lifecycle: "suspended", ...prior });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-resume-new-box-"));
  roots.push(root);
  const controller = join(root, "controller");
  mkdirSync(controller);
  const builder = new DurablePrpControlPlane({ stateDirectory: join(controller, "control-plane"), identity: prior,
    expectedRunnerVersion: artifact.version, expectedRunnerDigest: artifact.digest });
  try {
    builder.persistRunAttachTemplate({ provider: { kind: "pi_rpc", command: "not-launched-pi", args: [] }, workspace: { cwd: root } });
  } finally { await builder.stop(); }
  let box = join(root, "box-old");
  mkdirSync(box);
  const live = () => join(box, "runner-state.json");
  // The old box holds the prior run's own suspended state, as its checkpoint does.
  writeFileSync(live(), suspended);
  let boxLost = false;
  const calls = { prepare: 0, read: 0, archive: 0 };
  // Host preparation restores the saved checkpoint onto a box that lacks it.
  const prepareExternalRunnerState = async () => {
    calls.prepare++;
    if (!existsSync(live()) && !existsSync(join(box, "authority-epochs"))) writeFileSync(live(), suspended);
  };
  const readRunnerState = async () => {
    calls.read++;
    if (!existsSync(live())) throw new Error("runner_remote_state_unavailable: exit=66 timedOut=false");
    return JSON.parse(readFileSync(live(), "utf8")) as Record<string, unknown>;
  };
  // Mirrors REMOTE_RUNNER_AUTHORITY_ARCHIVE_SCRIPT and its executor mapping.
  const archiveExternalRunnerState = async ({ archiveKey }: { archiveKey: string }) => {
    calls.archive++;
    if (boxLost) throw new Error("runner_remote_authority_archive_failed");
    const directory = join(box, "authority-epochs", `epoch-${archiveKey}`), archived = join(directory, "runner-state.json");
    if (existsSync(live()) && !existsSync(archived)) { mkdirSync(directory, { recursive: true }); renameSync(live(), archived); }
    else if (existsSync(live()) && existsSync(archived) && readFileSync(live(), "utf8") === readFileSync(archived, "utf8")) rmSync(live());
    else if (!existsSync(live()) && !existsSync(archived)) throw new Error("runner_remote_authority_archive_absent");
    else if (existsSync(live())) throw new Error("runner_remote_authority_archive_failed");
    return JSON.parse(readFileSync(archived, "utf8")) as Record<string, unknown>;
  };
  const resume = async (runId: string) => {
    const { transport } = createCapabilityRunnerdCodexTransport({
      provider: "pi_rpc", stateDirectory: controller, prpIdentity: identity(runId),
      runnerBinary: join(root, "not-launched-runnerd"), runnerArtifact: artifact,
      resumeProviderSession: { driverSessionId: "saved-thread", providerSessionId: "saved-provider-session" },
      readRunnerState, prepareExternalRunnerState, archiveExternalRunnerState,
      runnerProcessLauncher: () => { throw new Error(STOP); },
    } as never);
    try {
      return await transport.request("thread/read", {}).then(() => "resumed", (error: Error) => error.message);
    } finally { await transport.close().catch(() => {}); }
  };
  const controllerEpochs = () => existsSync(join(controller, "authority-epochs"))
    ? readdirSync(join(controller, "authority-epochs")).filter(epoch => existsSync(join(controller, "authority-epochs", epoch, "control-plane")))
    : [];
  const boxEpochFiles = () => existsSync(join(box, "authority-epochs"))
    ? readdirSync(join(box, "authority-epochs")).map(epoch => readFileSync(join(box, "authority-epochs", epoch, "runner-state.json"), "utf8"))
    : [];
  return {
    resume, calls, live, controllerEpochs, boxEpochFiles,
    loseBox: () => { boxLost = true; },
    boxBack: () => { boxLost = false; },
    // Boat creates a brand-new box: no sessions/, no runner-state, no epochs.
    newBox: () => { boxLost = false; box = join(root, "box-new"); mkdirSync(box); },
  };
}

it("a Retry that resumes on a new empty box stages the checkpoint before it archives the prior Runner state", async () => {
  const f = await fixture();
  f.loseBox();
  // Attempt 1: the controller moved the prior control plane into its epoch,
  // then the box was lost before its Runner state was archived.
  expect(await f.resume("retry-1")).toContain("runner_remote_authority_archive_failed");
  expect(f.controllerEpochs()).toHaveLength(1);
  f.newBox();
  expect(existsSync(f.live())).toBe(false);
  // Attempt 2 (the Retry) resumes the committed rotation on the new box.
  const prepareBefore = f.calls.prepare;
  const outcome = await f.resume("retry-2");
  expect(outcome).not.toContain("runner_remote_authority_archive");
  expect(outcome).toMatch(PAST_ROTATION);
  // The restored suspended state was archived once, never deleted or replaced.
  expect(f.boxEpochFiles()).toEqual([suspended]);
  expect(existsSync(f.live())).toBe(false);
  expect(f.calls.prepare - prepareBefore, "the new box was prepared once, before its archive").toBe(1);
});

it("a resumed rotation on a box that already archived the state does not prepare or re-stage it", async () => {
  const f = await fixture();
  f.loseBox();
  expect(await f.resume("retry-1")).toContain("runner_remote_authority_archive_failed");
  // The same box comes back with its live state; this time the archive succeeds.
  f.boxBack();
  const prepareBefore = f.calls.prepare;
  expect(await f.resume("retry-2")).toMatch(PAST_ROTATION);
  expect(f.calls.prepare, "an archived box is never prepared before its archive").toBe(prepareBefore);
  expect(f.boxEpochFiles()).toEqual([suspended]);
});
