import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { isRunnerResumeStateUnavailable, NativeRunnerResumeStateUnavailableError } from "../contracts/harness-driver.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

// REG-26: "lost-*" leave the prior Runner's last state unsuspended, as a
// provider stop under an idle warm Runner does. Only the exact proven-lost
// identity may rotate it; an unproven or other identity keeps the refusal.
it.each(["restore", "refuse", "foreign-state", "lost-proven", "lost-unproven", "lost-other-identity"] as const)(
  "continues a completed warm handoff through external cold-state preparation: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "runnerd-warm-cold-restore-"));
    const saved = await mkdtemp(join(tmpdir(), "runnerd-warm-saved-"));
    const callsPath = join(root, "calls.log");
    const identity = {
      runnerInstanceId: "cold-restore-runner",
      environmentLeaseId: "cold-restore-lease",
      runId: "first-run",
      normalizedSessionId: "cold-restore-session",
      turnId: "first-turn",
      itemId: "first-item",
    };
    const options = {
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(root, "--call-log", callsPath, "--record-process-start"),
      stateDirectory: root,
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 2_000,
    };
    const first = createCapabilityRunnerdCodexTransport({ ...options, prpIdentity: identity });
    let resumed: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    try {
      const opened = await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
      const openedThread = opened.thread as { id: string; sessionId: string };
      const thread = { id: openedThread.id, sessionId: openedThread.sessionId };
      await first.transport.attachRun!({ runId: "second-run", turnId: "second-turn", itemId: "second-item" });
      expect((await first.transport.request("thread/read", {})).thread).toMatchObject(thread);
      await first.transport.close();
      const controlPath = join(root, "control-plane", "control-plane-state.json");
      const controlBytes = await readFile(controlPath);
      const control = JSON.parse(controlBytes.toString());
      expect(control.completedWarmTransition.receipt.newIdentity.runId).toBe("second-run");
      const savedRunner = join(saved, "runner");
      await rename(join(root, "runner"), savedRunner);
      const savedState = JSON.parse(await readFile(join(savedRunner, "runner-state.json"), "utf8"));
      expect(savedState).toMatchObject({ lifecycle: "suspended", runId: "second-run" });
      const callsBefore = await readFile(callsPath, "utf8");
      const sentinel = "workspace content must survive cold provider recovery";
      await writeFile(join(root, "workspace-sentinel.txt"), sentinel);
      let prepared = false;
      const prepare = vi.fn(async () => {
        if (prepared) return;
        if (mode === "refuse") throw new Error("fixture cold restore authority refused");
        await cp(savedRunner, join(root, "runner"), { recursive: true, errorOnExist: true });
        if (mode === "foreign-state") {
          await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
            ...savedState, normalizedSessionId: "another-session",
          }));
        }
        if (mode.startsWith("lost-")) {
          await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ ...savedState, lifecycle: "ready" }));
        }
        prepared = true;
      });
      const read = vi.fn(async () => JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8")));
      const archive = vi.fn(async (request: { archiveKey: string }) => {
        const state = await read();
        const directory = join(root, "authority-epochs", request.archiveKey);
        await mkdir(directory, { recursive: true });
        await rename(join(root, "runner", "runner-state.json"), join(directory, "runner-state.json"));
        return state;
      });
      resumed = createCapabilityRunnerdCodexTransport({
        ...options,
        prpIdentity: { ...identity, runId: "third-run", turnId: "third-turn", itemId: "third-item" },
        resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId },
        readRunnerState: read,
        prepareExternalRunnerState: prepare,
        archiveExternalRunnerState: archive,
        ...(mode === "lost-proven" || mode === "lost-other-identity" ? { lostRunnerSource: { ...identity,
          runId: mode === "lost-proven" ? "second-run" : "another-run", turnId: "second-turn", itemId: "second-item" } } : {}),
      });
      if (mode === "refuse") {
        await expect(resumed.transport.request("thread/read", {})).rejects.toThrow("fixture cold restore authority refused");
        expect(read).not.toHaveBeenCalled();
        expect(archive).not.toHaveBeenCalled();
        expect(await readFile(callsPath, "utf8")).toBe(callsBefore);
        expect(await readFile(controlPath)).toEqual(controlBytes);
      } else if (mode === "foreign-state" || mode === "lost-unproven" || mode === "lost-other-identity") {
        await expect(resumed.transport.request("thread/read", {})).rejects.toThrow("native_runner_authority_rotation_requires_settled_state");
        expect(read).toHaveBeenCalled();
        expect(archive).not.toHaveBeenCalled();
        expect(await readFile(callsPath, "utf8")).toBe(callsBefore);
        expect(await readFile(controlPath)).toEqual(controlBytes);
      } else {
        expect((await resumed.transport.request("thread/read", {})).thread).toMatchObject(thread);
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
        const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
        expect(calls.filter(call => call === "thread/start")).toHaveLength(1);
        expect(calls.filter(call => call === "thread/resume")).toHaveLength(1);
        expect(calls.filter(call => call === "turn/start")).toHaveLength(0);
        expect(JSON.parse(await readFile(controlPath, "utf8")).identity.runId).toBe("third-run");
        if (mode === "lost-proven") {
          // Archived exactly as the lost Runner left it, never deleted.
          expect(JSON.parse(await readFile(join(root, "authority-epochs", archive.mock.calls[0]![0].archiveKey,
            "runner-state.json"), "utf8"))).toMatchObject({ lifecycle: "ready", runId: "second-run" });
        }
        expect(await readFile(join(root, "workspace-sentinel.txt"), "utf8")).toBe(sentinel);
      }
    } finally {
      await Promise.allSettled([first.transport.close(), resumed?.transport.close()]);
      await rm(root, { recursive: true, force: true });
      await rm(saved, { recursive: true, force: true });
    }
  },
  30_000,
);

// Staging class P: a follow-up's new sandbox holds no Runner control-plane
// state and no archived authority epoch for the saved session. The refusal is
// typed so the driver can tell the runtime the saved state cannot resume here.
it.each(["local", "external"] as const)("names a resume that finds no saved %s Runner state", async (placement) => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-resume-state-absent-"));
  const prepare = vi.fn(async () => {});
  try {
    const resumed = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(root),
      stateDirectory: root,
      prpIdentity: { runnerInstanceId: "absent-runner", environmentLeaseId: "absent-lease", runId: "follow-up-run",
        normalizedSessionId: "absent-session", turnId: "follow-up-turn", itemId: "follow-up-item" },
      resumeProviderSession: { driverSessionId: "thread-saved", providerSessionId: "provider-saved" },
      ...(placement === "external" ? {
        readRunnerState: vi.fn(async () => { throw new Error("no runner state"); }),
        prepareExternalRunnerState: prepare,
        archiveExternalRunnerState: vi.fn(async () => { throw new Error("nothing to archive"); }),
      } : {}),
    });
    const failure = await resumed.transport.request("thread/read", {}).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeRunnerResumeStateUnavailableError);
    expect(isRunnerResumeStateUnavailable(failure)).toBe(true);
    expect((failure as Error).message).toBe("PRP provider resume state is unavailable");
    await resumed.transport.close().catch(() => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
