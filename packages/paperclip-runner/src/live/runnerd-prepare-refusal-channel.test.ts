import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runnerPrepareRefusalCode } from "../contracts/harness-driver.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

// Channel-only probe: real authenticated Rust PRP refusal reaches the reader.
// No assertion about the independently owned recovery policy. Local peer only.
it.each(["active-turn", "descendants", "goal"] as const)("carries the specific %s prepare refusal over authenticated PRP", async blocker => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-refresh-admission-"));
  const binary = resolve(import.meta.dirname, "../../runner/target/debug/paperclip-runnerd");
  const fake = resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server");
  const identity = { runnerInstanceId: "refresh-runner", environmentLeaseId: "refresh-lease",
    runId: "old-run", normalizedSessionId: "refresh-conversation", turnId: "old-turn", itemId: "old-item" };
  const options = { provider: "codex" as const, runnerBinary: binary, codexCommand: fake,
    codexArgs: ["--state-file", join(root, "fake-state.json"), "--durable-turn-ids"],
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } };
  const first = createCapabilityRunnerdCodexTransport({ ...options, stateDirectory: join(root, "old"), prpIdentity: identity });
  let next: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  try {
    await first.transport.request("thread/start", { cwd: root, model: "gpt-test", baseInstructions: "Skill v1", dynamicTools: [] });
    await first.transport.close();
    const oldState = join(root, "old/runner/codex-provider-state.json");
    const state = JSON.parse(await readFile(oldState, "utf8"));
    expect(state.runIdentity.runId).toBe("old-run");
    if (blocker === "active-turn") {
      state.activeProviderTurnId = "unfinished-provider-turn";
      state.lifecycle = "turn_active";
      state.completedTurnAuthoritative = false;
      state.completedProviderTurnId = null;
      state.completedTurnProcessGeneration = null;
    } else if (blocker === "descendants") state.descendantThreadIds = ["old-child"];
    else state.goal = { objective: "Earlier work", status: "active", tokenBudget: null, tokensUsed: 0,
      elapsedSeconds: 0, iterations: 0, lastReason: null, createdAt: null, updatedAt: null, completedAt: null, workingNow: false };
    await writeFile(oldState, JSON.stringify(state));
    const nextState = join(root, "next/runner/codex-provider-state.json");
    await mkdir(join(root, "next/runner"), { recursive: true });
    await copyFile(oldState, nextState);
    next = createCapabilityRunnerdCodexTransport({ ...options, stateDirectory: join(root, "next"),
      prpIdentity: { ...identity, runId: "next-run", turnId: "next-turn", itemId: "next-item" } });
    const error = await next.transport.request("thread/start", { cwd: root, model: "gpt-test",
      baseInstructions: "Edited skill v2", dynamicTools: [] }).then(() => null, error => error);
    expect(error).not.toBeNull();
    const prepareRefusalCode = blocker === "active-turn" ? "provider_active_turn"
      : blocker === "descendants" ? "provider_live_descendants" : "provider_active_goal";
    expect(runnerPrepareRefusalCode(error)).toBe(prepareRefusalCode);
  } finally {
    await next?.transport.close();
    await first.transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
