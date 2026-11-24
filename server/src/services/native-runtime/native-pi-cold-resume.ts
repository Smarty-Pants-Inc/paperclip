import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { NativeExecutionInput, PersistedNativeSession, createRunnerdCodexTransport } from "../../vendor/paperclip-runner/index.js";

import { piRetirementProves } from "./native-pi-retirement.js";
import { resolveSessionContinuity } from "./continued-session.js";

type Transport = ReturnType<typeof createRunnerdCodexTransport>["transport"];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The retained normalized ID proves continuity admission; no other provider field may change here. */
export function piModelSelectionChanged(previous: NativeExecutionInput["provider"], current: NativeExecutionInput["provider"]): boolean {
  if (previous.kind !== "pi_rpc" || current.kind !== "pi_rpc") return false;
  const { model: oldModel, piRpcThinkingLevel: oldLevel, ...oldPolicy } = previous;
  const { model, piRpcThinkingLevel, ...policy } = current;
  return (oldModel !== model || oldLevel !== piRpcThinkingLevel) && isDeepStrictEqual(oldPolicy, policy);
}

/** Check the stopped owner's actual state, not the rebind's cleared per-turn fields. */
export function assertPiColdResumeSettled(runner: unknown, provider: unknown, normalizedSessionId: string, threadId: string, retiredOwner?: Record<string, unknown>): void {
  const state = record(runner), saved = record(provider);
  // A recovered idle owner may have been stopped without a suspend command. Its exact
  // revalidated identity plus physical exit proof is supplied only by that retirement path.
  const exited = piRetirementProves(retiredOwner, state, runner, provider);
  const retired = retiredOwner && ["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId", "turnId", "itemId"]
    .every(key => typeof retiredOwner[key] === "string" && retiredOwner[key] !== "" && retiredOwner[key] === state[key]);
  if ((retiredOwner && !retired) || state.schema !== "paperclip.runner.durable.state.v1" || saved.schema !== "paperclip.runner.codex-provider-state.v1" ||
      state.normalizedSessionId !== normalizedSessionId || (!exited && state.lifecycle !== "suspended" && !(retired && state.lifecycle === "ready")) ||
      !Array.isArray(state.outbox) || (!exited && (state.outbox.length !== 0 || state.pendingTerminalDelivery != null ||
      state.pendingProviderCleanup != null || state.warmTransition != null)) ||
      record(saved.config).provider !== "pi_rpc" || saved.threadId !== threadId ||
      (!exited && (saved.activeProviderTurnId != null || saved.ambiguousTurnStartPending === true || record(saved.goal).status === "active")) ||
      Object.keys(record(record(saved.toolBridge).pending)).length !== 0) {
    throw new Error("native_pi_cold_resume_unsettled: retain the saved conversation for reconciliation");
  }
}

export const PI_RUNNER_AUTHORITY_FILES = ["runner-state.json", "codex-provider-state.json", "runner-process.identity"] as const;
const PI_CONTROLLER_AUTHORITY_ENTRIES = ["control-plane", "authority-epochs", "launch-preparation.json"] as const;

export function readPiStateFile(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("native_pi_cold_resume_state_unsafe");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

/** Archive only Runner authority. Never move the Pi runtime directory or its session files. */
export function archivePiRunnerAuthority(root: string, runnerDirectory: string | null): void {
  const archive = join(root, "continuity-breaks", `pi-runner-${randomUUID()}`);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  for (const name of PI_CONTROLLER_AUTHORITY_ENTRIES) {
    if (existsSync(join(root, name))) renameSync(join(root, name), join(archive, name));
  }
  if (runnerDirectory) {
    const destination = join(archive, "runner");
    mkdirSync(destination, { mode: 0o700 });
    for (const name of PI_RUNNER_AUTHORITY_FILES) {
      if (existsSync(join(runnerDirectory, name))) renameSync(join(runnerDirectory, name), join(destination, name));
    }
  }
}

/** Refusal may retire a runner, never the conversation. No replacement-session API is available here. */
export async function retryPiAttachOnSameSession<T extends { recovered: boolean; failureClass?: string; runnerExitConfirmed?: boolean }>(input: {
  pi: boolean;
  sessionContinuity?: "continuous" | "paperclip";
  checkpoint: PersistedNativeSession;
  recover: (checkpoint: PersistedNativeSession) => Promise<T>;
  enableColdResume: () => void;
}): Promise<T> {
  const result = await input.recover(input.checkpoint);
  if (!result.recovered && result.failureClass === "provider_attach_refused" && input.pi && resolveSessionContinuity("pi_rpc", input.sessionContinuity) === "continuous" &&
      result.runnerExitConfirmed === true && !input.checkpoint.activeTurnId && !input.checkpoint.pendingRuntimeRequests?.length) {
    input.enableColdResume();
    return input.recover(input.checkpoint);
  }
  return result;
}

/** Existing driver hook: bootstrap a new Runner before any history read, not run.attach. */
export function installPiColdResume(transport: Transport, input: {
  threadId: string;
  providerSessionId?: string | null;
  model: string;
  retireRunnerAuthority: () => Promise<void>;
}): void {
  transport.prepareConversationResume = async params => {
    if (params.threadId !== input.threadId || params.model !== input.model) throw new Error("native_pi_cold_resume_selection_mismatch");
    await input.retireRunnerAuthority();
    // threadId seeds Rust's providerSessionId; Rust then sends thread/resume to the pack.
    const opened = await transport.request("thread/start", { ...params, model: input.model });
    const thread = record(opened.thread);
    if (thread.id !== input.threadId || (input.providerSessionId && thread.sessionId !== input.providerSessionId)) {
      throw new Error("native_pi_cold_resume_identity_mismatch");
    }
    // The top-level model is the authenticated provider observation, unlike thread.model (the request).
    if (opened.model !== input.model) throw new Error("native_pi_cold_resume_model_unconfirmed");
  };
}
