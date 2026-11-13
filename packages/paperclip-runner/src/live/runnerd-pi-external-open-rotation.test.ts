import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

// RFL F1 (prp-final verdict): a fresh external Pi open over a Core-closed
// (suspended) owner rotates its epoch in two steps: the controller's control
// plane moves into the epoch, then the box's runner state is archived. A fault
// between them must be finished on the next open, and a completed older epoch
// must never retire a newer owner. Each open stops at registration (the new
// control plane is written); no Runner or provider starts.

type Identity = { runnerInstanceId: string; environmentLeaseId: string; runId: string; normalizedSessionId: string; turnId: string; itemId: string };
const identity = (runId: string): Identity => ({ runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId,
  normalizedSessionId: "session-1", turnId: `turn-${runId}`, itemId: `item-${runId}` });
const STOP = "test stops at registration";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-external-open-rotation-"));
  roots.push(root);
  const controller = join(root, "controller"), box = join(root, "box");
  mkdirSync(controller); mkdirSync(box);
  const live = join(box, "runner-state.json");
  const box_state = (owner: Identity, lifecycle: string) =>
    writeFileSync(live, JSON.stringify({ schema: "paperclip.runner.durable.state.v1", lifecycle, ...owner }));
  let fault: "before-move" | "after-move" | "read" | undefined;
  const calls = { read: 0, archive: 0 };
  // Mirrors REMOTE_RUNNER_AUTHORITY_ARCHIVE_SCRIPT: idempotent move into the epoch.
  const archiveExternalRunnerState = async ({ archiveKey }: { archiveKey: string }) => {
    calls.archive++;
    const directory = join(box, "authority-epochs", `epoch-${archiveKey}`), archived = join(directory, "runner-state.json");
    if (existsSync(live) && !existsSync(archived)) {
      if (fault === "before-move") { fault = undefined; throw new Error("runner_remote_authority_archive_failed"); }
      mkdirSync(directory, { recursive: true }); renameSync(live, archived);
      if (fault === "after-move") { fault = undefined; throw new Error("runner_remote_authority_archive_failed"); }
    } else if (existsSync(live) && existsSync(archived) && readFileSync(live, "utf8") === readFileSync(archived, "utf8")) {
      rmSync(live);
    } else if (existsSync(live) || !existsSync(archived)) throw new Error("runner_remote_authority_archive_failed");
    return JSON.parse(readFileSync(archived, "utf8")) as Record<string, unknown>;
  };
  const readRunnerState = async () => {
    calls.read++;
    if (fault === "read") { fault = undefined; throw new Error("runner_remote_state_unavailable: probe failed"); }
    if (!existsSync(live)) throw new Error("runner_remote_state_unavailable: exit=1");
    return JSON.parse(readFileSync(live, "utf8")) as Record<string, unknown>;
  };
  const open = async (owner: Identity) => {
    const { transport } = createCapabilityRunnerdCodexTransport({
      provider: "pi_rpc", stateDirectory: controller, prpIdentity: owner, runnerBinary: join(root, "absent-runnerd"),
      runnerArtifact: { version: "0.0.0-test", digest: `sha256:${"0".repeat(64)}` },
      readRunnerState, archiveExternalRunnerState, prepareExternalRunnerState: async () => {},
      measureOperation: async (phase, work) => { if (phase === "runner.transport.prepare") throw new Error(STOP); return work(); },
    } as never);
    try {
      return await transport.request("thread/start", { cwd: root, dynamicTools: [] }).then(() => "opened", (error: Error) => error.message);
    } finally { await transport.close().catch(() => {}); }
  };
  const registered = () => {
    const path = join(controller, "control-plane", "control-plane-state.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { identity: Identity }).identity.runId : null;
  };
  const boxEpochs = () => existsSync(join(box, "authority-epochs")) ? readdirSync(join(box, "authority-epochs")) : [];
  const controllerEpochs = () => existsSync(join(controller, "authority-epochs")) ? readdirSync(join(controller, "authority-epochs")) : [];
  return { open, registered, box_state, live, calls, boxEpochs, controllerEpochs, controllerRoot: controller, setFault: (next: typeof fault) => { fault = next; } };
}

// The first owner registers, then Core closes it: its own state reads suspended.
async function closedFirstOwner() {
  const f = fixture();
  expect(await f.open(identity("first"))).toContain(STOP);
  expect(f.registered()).toBe("first");
  f.box_state(identity("first"), "suspended");
  return f;
}

it("rotates a Core-closed owner once and registers the successor", async () => {
  const f = await closedFirstOwner();
  expect(await f.open(identity("second"))).toContain(STOP);
  expect(f.registered()).toBe("second");
  expect(f.calls.archive).toBe(1);
  expect(existsSync(f.live)).toBe(false);
  expect(f.boxEpochs()).toHaveLength(1);
});

it("finishes an interrupted rotation on retry: the box archive failed after the control plane moved", async () => {
  const f = await closedFirstOwner();
  f.setFault("before-move");
  expect(await f.open(identity("second"))).toContain("runner_remote_authority_archive_failed");
  expect(f.registered(), "no successor registers over an unarchived owner").toBeNull();
  expect(f.controllerEpochs()).toHaveLength(1);
  expect(existsSync(f.live)).toBe(true);
  expect(await f.open(identity("second"))).toContain(STOP);
  expect(f.calls.archive, "the retry finished the same epoch").toBe(2);
  expect(existsSync(f.live)).toBe(false);
  expect(f.boxEpochs()).toHaveLength(1);
  expect(f.registered()).toBe("second");
});

it("registers on retry when the box archive moved but its reply was lost", async () => {
  const f = await closedFirstOwner();
  f.setFault("after-move");
  expect(await f.open(identity("second"))).toContain("runner_remote_authority_archive_failed");
  expect(f.registered()).toBeNull();
  expect(existsSync(f.live)).toBe(false);
  expect(await f.open(identity("second"))).toContain(STOP);
  expect(f.registered()).toBe("second");
  expect(f.boxEpochs()).toHaveLength(1);
});

it("keeps the owner when the box read fails before the control plane moves, then rotates on retry", async () => {
  const f = await closedFirstOwner();
  f.setFault("read");
  expect(await f.open(identity("second"))).toContain("runner_remote_state_unavailable");
  expect(f.registered(), "the prior authority is untouched").toBe("first");
  expect(f.controllerEpochs().filter(epoch => existsSync(join(f.controllerRoot, "authority-epochs", epoch, "control-plane")))).toEqual([]);
  expect(await f.open(identity("second"))).toContain(STOP);
  expect(f.registered()).toBe("second");
  expect(f.calls.archive).toBe(1);
});

it("never lets a completed older epoch retire a newer owner", async () => {
  const f = await closedFirstOwner();
  expect(await f.open(identity("second"))).toContain(STOP);
  // The successor's control plane is gone from this controller (a restored or
  // lost root), while its own suspended state sits on the box.
  rmSync(join(f.controllerRoot, "control-plane"), { recursive: true, force: true });
  f.box_state(identity("second"), "suspended");
  const before = f.calls.archive;
  expect(await f.open(identity("third"))).toContain(STOP);
  expect(f.calls.archive, "the older epoch retired nothing").toBe(before);
  expect(JSON.parse(readFileSync(f.live, "utf8")).runId).toBe("second");
  expect(f.boxEpochs()).toHaveLength(1);
});

it("never rotates a live owner whose close did not succeed", async () => {
  const f = fixture();
  expect(await f.open(identity("first"))).toContain(STOP);
  f.box_state(identity("first"), "ready");
  expect(await f.open(identity("second"))).toContain("native_runner_authority_rotation_requires_settled_state");
  expect(f.registered()).toBe("first");
  expect(f.calls.archive).toBe(0);
  expect(JSON.parse(readFileSync(f.live, "utf8")).lifecycle).toBe("ready");
});
