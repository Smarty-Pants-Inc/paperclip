import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OpenCodeServerDriver } from "../drivers/opencode/opencode-server-driver.js";
import { createLiveWorkflowRuntime, retainLiveWorkflowRuntime } from "./live-workflow-evidence.js";

type MockTurnEvent =
  | {
      seq: number;
      at: string;
      turnId: string;
      kind: "usage";
      usage: {
        providerRequests: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        reasoningTokens: number;
        costNanodollars: number;
      };
    }
  | {
      seq: number;
      at: string;
      turnId: string;
      kind: "activity";
      reason: string;
    };

const liveSessionMocks = vi.hoisted(() => ({
  shutdown: vi.fn(),
  createOptions: [] as Array<{
    transportOptions?: { environment?: NodeJS.ProcessEnv };
  }>,
  sendMessage: vi.fn(),
  snapshot: vi.fn(),
  interrupt: vi.fn(),
  suspend: vi.fn(),
  restore: vi.fn(),
  subscribedSessionIds: [] as string[],
  unsubscribedSessionIds: [] as string[],
  turnListener: null as null | ((event: MockTurnEvent) => void),
}));

vi.mock("../live/live-session.js", () => ({
  InMemoryCapabilityLiveSessionStore: class {},
  CapabilityLiveSessionService: class {
    constructor(options: {
      transportOptions?: { environment?: NodeJS.ProcessEnv };
    }) {
      liveSessionMocks.createOptions.push(options);
    }

    session(sessionId: string, subscriptionLabel: string) {
      return {
        id: sessionId,
        subscribe: (
          listener: NonNullable<typeof liveSessionMocks.turnListener>,
        ) => {
          liveSessionMocks.subscribedSessionIds.push(subscriptionLabel);
          liveSessionMocks.turnListener = listener;
          return () => {
            liveSessionMocks.unsubscribedSessionIds.push(subscriptionLabel);
            if (liveSessionMocks.turnListener === listener) {
              liveSessionMocks.turnListener = null;
            }
          };
        },
        sendMessage: liveSessionMocks.sendMessage,
        pendingInteractions: () => [],
        snapshot: liveSessionMocks.snapshot,
        interrupt: liveSessionMocks.interrupt,
        suspend: liveSessionMocks.suspend,
      };
    }

    async create() {
      return this.session("session-shutdown-test", "created");
    }

    async restore(sessionId: string) {
      liveSessionMocks.restore(sessionId);
      return this.session(sessionId, "restored");
    }

    async shutdown(sessionId: string, reason: string) {
      return liveSessionMocks.shutdown(sessionId, reason);
    }
  },
}));

import { runnerWorkflowCase } from "./workflow-catalog.js";
import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import {
  advanceDelegationReturnMockState,
  executeLiveRunnerWorkflow,
  scorableLiveWorkflowCalls,
  unexpectedLiveWorkflowCalls,
} from "./live-workflow-executor.js";
import {
  RUNNER_LIVE_CANDIDATE_SLOTS,
  type RunnerLiveScheduleEntry,
} from "./live-workflow-matrix.js";

describe("live workflow executor infrastructure failures", () => {
  beforeEach(async () => {
    const evidence = await mkdtemp(join(tmpdir(), "eval-retention-test-"));
    vi.stubEnv("PAPERCLIP_RUNNER_EVAL_EVIDENCE_DIR", join(evidence, "evidence"));
    liveSessionMocks.shutdown.mockReset();
    liveSessionMocks.createOptions.length = 0;
    liveSessionMocks.subscribedSessionIds.length = 0;
    liveSessionMocks.unsubscribedSessionIds.length = 0;
    liveSessionMocks.turnListener = null;
    liveSessionMocks.sendMessage.mockReset().mockResolvedValue({
      status: "completed",
      turnId: "turn-shutdown-test",
    });
    liveSessionMocks.interrupt.mockReset().mockResolvedValue({});
    liveSessionMocks.suspend.mockReset().mockResolvedValue({});
    liveSessionMocks.restore.mockReset();
    liveSessionMocks.snapshot.mockReset().mockReturnValue({
      sessionId: "session-shutdown-test",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Keep: sole-copy data safety (#20417). The executor's authority is a test
  // double, but a real provider subprocess and production driver write the raw
  // trace at the executor-selected path; cleanup and all filesystem I/O are real.
  it.each([false, true])("retains actual provider trace bytes after eval cleanup (failure=%s)", async failure => {
    let before = Buffer.alloc(0);
    liveSessionMocks.sendMessage.mockImplementationOnce(async () => {
      const environment = liveSessionMocks.createOptions.at(-1)!.transportOptions!.environment!;
      const tracePath = environment.PAPERCLIP_PROVIDER_TRACE_PATH!;
      const command = join(dirname(tracePath), "fake-opencode-server.mjs");
      await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), command);
      await chmod(command, 0o700);
      const driver = new OpenCodeServerDriver({ model: "openrouter/test-model", command,
        runtimeDirectory: dirname(tracePath), environment: { PATH: process.env.PATH, PAPERCLIP_PROVIDER_TRACE_PATH: tracePath } });
      const session = await driver.openSession({ runId: "retention-proof", normalizedSessionId: "retention-proof", workingDirectory: dirname(tracePath) });
      try {
        await session.startTurn({ message: { role: "user", text: "hello" } });
        for await (const event of session.events()) if (["turn.completed", "turn.failed"].includes(event.eventType)) break;
      } finally { await session.close({ reason: "retention proof" }); }
      before = await readFile(tracePath);
      expect(before.length).toBeGreaterThan(0);
      if (failure) throw new Error("failure after provider trace capture");
      return { status: "completed", turnId: "retention-proof" };
    });
    const candidate = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const entry: RunnerLiveScheduleEntry = { executionId: `trace-retention-${failure}`, caseId: "final-response",
      candidateId: candidate.id, slotId: candidate.slotId, repetition: 1, providerTrace: "raw", budget: candidate.budget };
    const pending = executeLiveRunnerWorkflow({ entry, candidate, evalCase: runnerWorkflowCase("final-response") });
    if (failure) await expect(pending).rejects.toThrow("failure after provider trace capture");
    else await pending;
    const evidence = process.env.PAPERCLIP_RUNNER_EVAL_EVIDENCE_DIR!;
    const files: string[] = [];
    async function visit(root: string): Promise<void> {
      for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const filename = join(root, item.name);
        if (item.isDirectory()) await visit(filename);
        else if (item.name === "provider-trace.ndjson") files.push(filename);
      }
    }
    await visit(evidence);
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const retained = await Promise.all(files.map(async path => ({ path, sha256: hash(await readFile(path)) })));
    const receipt = { failure, beforeBytes: before.length, beforeSha256: hash(before), retained };
    // Preserve actual pre-cleanup bytes even in RED; this proof copy is not in
    // the production evidence namespace and cannot make its assertion pass.
    const proof = join(dirname(evidence), "proof"); await mkdir(proof, { mode: 0o700 });
    await writeFile(join(proof, "provider-trace.ndjson"), before, { mode: 0o600 });
    await writeFile(join(proof, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log("eval raw byte retention", JSON.stringify(receipt));
    expect(retained.some(file => file.sha256 === receipt.beforeSha256)).toBe(true);
  }, 30_000);

  it("logs the exact retained path and metadata without reading or logging file contents", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const root = await createLiveWorkflowRuntime("logged-evidence");
      await writeFile(join(root, "provider-trace.ndjson"), "opaque trace\n");
      await retainLiveWorkflowRuntime(root);
      const [leaf] = await readdir(dirname(root));
      expect(stderr).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({ level: "info", event: "native_evidence_retained",
        source: root, destination: join(dirname(root), leaf!), scope: dirname(root).split(/[\\/]/).at(-1), totalBytes: 13, fileCount: 1 })}\n`);
    } finally { stderr.mockRestore(); }
  });

  it("leaves pending eval trace bytes intact when the metadata walk exceeds its depth bound", async () => {
    const root = await createLiveWorkflowRuntime("bounded-inventory");
    await writeFile(join(root, "provider-trace.ndjson"), "opaque original\n");
    await mkdir(join(root, ...Array.from({ length: 129 }, () => "deep")), { recursive: true });
    await expect(retainLiveWorkflowRuntime(root)).rejects.toThrow("live_eval_evidence_inventory_limit");
    expect(await readFile(join(root, "provider-trace.ndjson"), "utf8")).toBe("opaque original\n");
  });

  it("leaves pending eval trace bytes intact when evidence permissions are unsafe", async () => {
    const root = await createLiveWorkflowRuntime("unsafe-evidence");
    const trace = join(root, "provider-trace.ndjson");
    await writeFile(trace, "opaque original\n");
    await chmod(dirname(root), 0o755);
    await expect(retainLiveWorkflowRuntime(root)).rejects.toThrow("live_eval_evidence_directory_unsafe");
    expect(await readFile(trace, "utf8")).toBe("opaque original\n");
    await chmod(dirname(root), 0o700);
    await retainLiveWorkflowRuntime(root);
  });

  it("allows read-only context support without permitting extra effects", () => {
    const calls = [
      "get_task_context",
      "get_task_history",
      "finish_task",
      "create_task",
    ];
    expect(unexpectedLiveWorkflowCalls(calls, ["finish_task"])).toEqual([
      "create_task",
    ]);
    expect(scorableLiveWorkflowCalls(calls, ["finish_task"])).toEqual([
      "finish_task",
      "create_task",
    ]);
  });

  it("keeps required read-only calls in trajectory scoring", () => {
    expect(
      scorableLiveWorkflowCalls(
        ["get_task_context", "get_task_history"],
        ["get_task_context"],
      ),
    ).toEqual(["get_task_context"]);
  });

  it("advances a delegated child through the authoritative return wake", async () => {
    const grants = ["delegation:tasks:create", "dependencies:write"];
    const adapter = new CapabilityMockControlPlaneAdapter({
      actors: [
        {
          id: "actor-1",
          companyId: "company-1",
          name: "Workflow eval actor",
          role: "engineer",
          status: "active",
          budgetId: "budget-actor-1",
          capabilityGrants: grants,
        },
      ],
    });
    await adapter.start();
    await adapter.openFixtureRun({
      identity: {
        runId: "delegation-parent",
        sessionId: "delegation-session",
        companyId: "company-1",
        issueId: "task-1",
        agentId: "actor-1",
      },
      backendKind: "runner",
      capabilities: grants,
    });
    const created = await adapter.applyCommand({
      runId: "delegation-parent",
      idempotencyKey: "create-child",
      command: {
        kind: "create_task",
        title: "Independent verification",
        description: "Verify the external boundary.",
        assigneeActorId: "actor-1",
      },
    });
    const childTaskId = created.entityRefs
      .find((entityRef) => entityRef.startsWith("task:"))!
      .slice("task:".length);
    await adapter.applyCommand({
      runId: "delegation-parent",
      idempotencyKey: "set-child-dependency",
      command: {
        kind: "set_dependencies",
        blockedByTaskIds: [childTaskId],
      },
    });

    const advanced = await advanceDelegationReturnMockState({
      mockState: adapter.serialize(),
      parentRunId: "delegation-parent",
      parentSessionId: "delegation-session",
      parentTaskId: "task-1",
      capabilities: grants,
    });
    expect(advanced).not.toBeNull();
    const restored = CapabilityMockControlPlaneAdapter.restore(
      advanced!.mockState,
    );
    expect(restored.snapshot().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: childTaskId, status: "done" }),
        expect.objectContaining({
          id: "task-1",
          status: "in_progress",
          checkoutRunId: advanced!.returnRunId,
        }),
      ]),
    );
    expect(restored.snapshot().blockers).toEqual([]);
    expect(restored.snapshot().wakes).toContainEqual(
      expect.objectContaining({
        taskId: "task-1",
        reason: "blockers_resolved",
      }),
    );
    await expect(
      restored.applyCommand({
        runId: advanced!.returnRunId,
        idempotencyKey: "finish-parent",
        command: { kind: "finish_task", summary: "Return completed." },
      }),
    ).resolves.toMatchObject({ disposition: "applied" });
  });

  it("classifies shutdown failures as retryable infrastructure errors and redacts them", async () => {
    const leakedSecret = "sk-shutdown-secret-value";
    liveSessionMocks.shutdown.mockRejectedValueOnce(
      new Error(`shutdown failed with ${leakedSecret}`),
    );
    const candidate = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const entry: RunnerLiveScheduleEntry = {
      executionId: "shutdown-failure",
      caseId: "final-response",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    let thrown: unknown;
    try {
      await executeLiveRunnerWorkflow({
        entry,
        candidate,
        evalCase: runnerWorkflowCase(entry.caseId),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "RunnerWorkflowInfrastructureError",
      code: "live_provider_execution_failed",
      retryable: true,
      message: "shutdown failed with [REDACTED]",
    });
    expect(String((thrown as Error).message)).not.toContain(leakedSecret);
    expect(liveSessionMocks.shutdown).toHaveBeenCalledWith(
      "session-shutdown-test",
      "Runner live workflow eval complete",
    );
  });

  it("passes only the selected candidate's required provider credential", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-candidate-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-candidate-secret");
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-candidate-secret");
    vi.stubEnv("CODEX_API_KEY", "unqualified-codex-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "unqualified-claude-secret");
    vi.stubEnv("GITHUB_TOKEN", "unrelated-host-secret");
    vi.stubEnv("PAPERCLIP_AUTH_HEADER", "Bearer unrelated-control-secret");
    vi.stubEnv("RUNNER_EVAL_CANARY", "preserved-nonsecret-value");
    const candidates = [
      RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!,
      RUNNER_LIVE_CANDIDATE_SLOTS[1]!.candidates[0]!,
      RUNNER_LIVE_CANDIDATE_SLOTS[3]!.candidates[0]!,
    ];

    for (const candidate of candidates) {
      const entry: RunnerLiveScheduleEntry = {
        executionId: `credential-isolation-${candidate.id}`,
        caseId: "final-response",
        candidateId: candidate.id,
        slotId: candidate.slotId,
        repetition: 1,
        providerTrace: "raw",
        budget: candidate.budget,
      };
      await executeLiveRunnerWorkflow({
        entry,
        candidate,
        evalCase: runnerWorkflowCase(entry.caseId),
      });

      const environment =
        liveSessionMocks.createOptions.at(-1)?.transportOptions?.environment;
      expect(environment?.RUNNER_EVAL_CANARY).toBe("preserved-nonsecret-value");
      expect(environment?.PAPERCLIP_PROVIDER_TRACE_PATH).toMatch(
        /provider-trace\.ndjson$/,
      );
      for (const credential of [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "CODEX_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GITHUB_TOKEN",
        "PAPERCLIP_AUTH_HEADER",
      ]) {
        if (candidate.qualification.requiredEnvironment.includes(credential)) {
          expect(environment?.[credential]).toBe(process.env[credential]);
        } else {
          expect(environment).not.toHaveProperty(credential);
        }
      }
    }
  });

  it("keeps launch-only smoke exceptions explicit and rejects a wrong marker", async () => {
    liveSessionMocks.snapshot.mockReturnValue({
      sessionId: "session-smoke-marker",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [
        {
          id: "assistant-smoke-marker",
          role: "assistant",
          text: "a different response",
        },
      ],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    });
    const candidate = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const entry: RunnerLiveScheduleEntry = {
      executionId: "local-smoke-marker",
      caseId: "final-response",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    const observation = await executeLiveRunnerWorkflow({
      entry,
      candidate,
      evalCase: runnerWorkflowCase(entry.caseId),
      allowMissingUsage: true,
      expectedAssistantText: "PAPERCLIP_LOCAL_PROVIDER_SMOKE_OK",
      promptOverride: "Return the smoke marker.",
    });

    expect(liveSessionMocks.sendMessage).toHaveBeenCalledWith(
      "Return the smoke marker.",
      { allowMissingUsage: true },
    );
    expect(observation.presentation.checks).toContainEqual(
      expect.objectContaining({
        id: "expected-assistant-text",
        passed: false,
      }),
    );
  });

  it("fails the candidate budget and stops before a paid continuation", async () => {
    liveSessionMocks.snapshot.mockReturnValue({
      sessionId: "session-budget-test",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [
        {
          receiptId: "usage-budget-test",
          attemptId: "attempt-budget-test",
          providerResponseId: "response-budget-test",
          turnId: "turn-budget-test",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 80,
          outputTokens: 40,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 20_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      stateHistory: [],
      workspaceDiffs: [],
    });
    const source = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const candidate = {
      ...source,
      budget: {
        ...source.budget,
        maxTotalTokens: 100,
        maxCostUsd: 0.01,
      },
    };
    const entry: RunnerLiveScheduleEntry = {
      executionId: "candidate-budget-exceeded",
      caseId: "steering-causality",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    const observation = await executeLiveRunnerWorkflow({
      entry,
      candidate,
      evalCase: runnerWorkflowCase(entry.caseId),
    });

    expect(liveSessionMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 130, costUsd: 0.02 },
      failure: {
        code: "candidate_budget_exceeded",
        category: "candidate",
        retryable: false,
      },
    });
    expect(observation.lifecycle.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "token-budget", passed: false }),
        expect.objectContaining({ id: "cost-budget", passed: false }),
      ]),
    );
  });

  it("stops at an exact terminal budget before a paid continuation", async () => {
    liveSessionMocks.snapshot.mockReturnValue({
      sessionId: "session-budget-reached",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [
        {
          receiptId: "usage-budget-reached",
          attemptId: "attempt-budget-reached",
          providerResponseId: "response-budget-reached",
          turnId: "turn-budget-reached",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 10_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      stateHistory: [],
      workspaceDiffs: [],
    });
    const source = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const candidate = {
      ...source,
      budget: {
        ...source.budget,
        maxTotalTokens: 100,
        maxCostUsd: 0.01,
      },
    };
    const entry: RunnerLiveScheduleEntry = {
      executionId: "candidate-budget-reached",
      caseId: "steering-causality",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    const observation = await executeLiveRunnerWorkflow({
      entry,
      candidate,
      evalCase: runnerWorkflowCase(entry.caseId),
    });

    expect(liveSessionMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 100, costUsd: 0.01 },
      failure: {
        code: "candidate_budget_reached",
        category: "candidate",
        retryable: false,
      },
    });
    expect(observation.lifecycle.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "token-budget", passed: true }),
        expect.objectContaining({ id: "cost-budget", passed: true }),
        expect.objectContaining({
          id: "candidate-budget-stop",
          passed: false,
        }),
      ]),
    );
  });

  it("interrupts an active paid turn as soon as live usage reaches its budget", async () => {
    const emptySnapshot = {
      sessionId: "session-live-budget-test",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    };
    const exceededSnapshot = {
      ...emptySnapshot,
      usageLedger: [
        {
          receiptId: "usage-live-budget-test",
          attemptId: "attempt-live-budget-test",
          providerResponseId: "response-live-budget-test",
          turnId: "turn-live-budget-test",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 80,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costNanodollars: 10_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    let interrupted = false;
    let turnResolved = false;
    let resolveTurn:
      ((value: { status: string; turnId: string }) => void) | null = null;
    liveSessionMocks.snapshot.mockImplementation(() =>
      interrupted ? exceededSnapshot : emptySnapshot,
    );
    liveSessionMocks.sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
          queueMicrotask(() => {
            const usageEvent = {
              seq: 1,
              at: "2026-09-01T00:00:00.000Z",
              turnId: "turn-live-budget-test",
              kind: "usage",
              usage: {
                providerRequests: 1,
                inputTokens: 80,
                outputTokens: 20,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                costNanodollars: 10_000_000,
              },
            } as const;
            liveSessionMocks.turnListener?.(usageEvent);
            liveSessionMocks.turnListener?.({ ...usageEvent, seq: 2 });
          });
        }),
    );
    liveSessionMocks.interrupt.mockImplementationOnce(async () => {
      expect(turnResolved).toBe(false);
      interrupted = true;
      turnResolved = true;
      resolveTurn?.({
        status: "interrupted",
        turnId: "turn-live-budget-test",
      });
      return exceededSnapshot;
    });
    const source = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const candidate = {
      ...source,
      budget: {
        ...source.budget,
        maxTotalTokens: 100,
        maxCostUsd: 0.01,
      },
    };
    const entry: RunnerLiveScheduleEntry = {
      executionId: "candidate-live-budget-stop",
      caseId: "steering-causality",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    const observation = await executeLiveRunnerWorkflow({
      entry,
      candidate,
      evalCase: runnerWorkflowCase(entry.caseId),
    });

    expect(liveSessionMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(liveSessionMocks.interrupt).toHaveBeenCalledWith(
      expect.stringContaining("candidate reported usage budget stop"),
    );
    expect(liveSessionMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 100, costUsd: 0.01 },
      failure: {
        code: "candidate_budget_reached",
        category: "candidate",
        retryable: false,
      },
    });
  });

  it("reattaches the budget interrupt before a restored-session continuation", async () => {
    const emptySnapshot = {
      sessionId: "session-restored-budget-test",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    };
    const reachedSnapshot = {
      ...emptySnapshot,
      usageLedger: [
        {
          receiptId: "usage-restored-budget-test",
          attemptId: "attempt-restored-budget-test",
          providerResponseId: "response-restored-budget-test",
          turnId: "turn-restored-budget-test",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 10_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    let interrupted = false;
    let resolveRestoredTurn:
      ((value: { status: string; turnId: string }) => void) | null = null;
    liveSessionMocks.snapshot.mockImplementation(() =>
      interrupted ? reachedSnapshot : emptySnapshot,
    );
    liveSessionMocks.sendMessage
      .mockResolvedValueOnce({
        status: "completed",
        turnId: "turn-before-restore",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRestoredTurn = resolve;
            queueMicrotask(() => {
              liveSessionMocks.turnListener?.({
                seq: 1,
                at: "2026-09-01T00:00:00.000Z",
                turnId: "turn-restored-budget-test",
                kind: "usage",
                usage: {
                  providerRequests: 1,
                  inputTokens: 70,
                  outputTokens: 20,
                  cachedInputTokens: 0,
                  reasoningTokens: 10,
                  costNanodollars: 10_000_000,
                },
              });
            });
          }),
      );
    liveSessionMocks.interrupt.mockImplementationOnce(async () => {
      interrupted = true;
      resolveRestoredTurn?.({
        status: "interrupted",
        turnId: "turn-restored-budget-test",
      });
      return reachedSnapshot;
    });
    const source = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const candidate = {
      ...source,
      budget: {
        ...source.budget,
        maxTotalTokens: 100,
        maxCostUsd: 0.01,
      },
    };
    const entry: RunnerLiveScheduleEntry = {
      executionId: "restored-session-budget-stop",
      caseId: "restart-recovery",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    const observation = await executeLiveRunnerWorkflow({
      entry,
      candidate,
      evalCase: runnerWorkflowCase(entry.caseId),
    });

    expect(liveSessionMocks.restore).toHaveBeenCalledWith(
      "session-shutdown-test",
    );
    expect(liveSessionMocks.subscribedSessionIds).toEqual([
      "created",
      "restored",
    ]);
    expect(liveSessionMocks.unsubscribedSessionIds).toEqual([
      "created",
      "restored",
    ]);
    expect(liveSessionMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(liveSessionMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 100, costUsd: 0.01 },
      failure: {
        code: "candidate_budget_reached",
        category: "candidate",
        retryable: false,
      },
    });
  });

  it("keeps an exact-cap provider-terminal race classified as a budget failure", async () => {
    const emptySnapshot = {
      sessionId: "session-exact-cap-race",
      authority: {},
      mockState: JSON.stringify({ tasks: [] }),
      transcript: [],
      evidence: [],
      authorizationRecords: [],
      attempts: [],
      usageLedger: [],
      stateHistory: [],
      workspaceDiffs: [],
    };
    const completedSnapshot = {
      ...emptySnapshot,
      mockState: JSON.stringify({ tasks: [{ id: "task-1", status: "done" }] }),
      transcript: [
        {
          role: "assistant",
          text: "The requested work is complete.",
        },
      ],
      evidence: [
        {
          id: "call-finish-task",
          kind: "tool_call",
          data: { operationId: "finish_task" },
        },
        {
          id: "result-finish-task",
          kind: "tool_result",
          data: { operationId: "finish_task", result: { ok: true } },
        },
      ],
      attempts: [{ attemptId: "attempt-exact-cap-race", status: "succeeded" }],
      usageLedger: [
        {
          receiptId: "usage-exact-cap-race",
          attemptId: "attempt-exact-cap-race",
          providerResponseId: "response-exact-cap-race",
          turnId: "turn-exact-cap-race",
          providerCalls: 1,
          providerRequests: 1,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 10_000_000,
          observedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      stateHistory: [{ revision: 1 }, { revision: 2 }],
    };
    let providerCompleted = false;
    liveSessionMocks.snapshot.mockImplementation(() =>
      providerCompleted ? completedSnapshot : emptySnapshot,
    );
    liveSessionMocks.sendMessage.mockImplementationOnce(async () => {
      liveSessionMocks.turnListener?.({
        seq: 1,
        at: "2026-09-01T00:00:00.000Z",
        turnId: "turn-exact-cap-race",
        kind: "activity",
        reason: "turn_started",
      });
      liveSessionMocks.turnListener?.({
        seq: 2,
        at: "2026-09-01T00:00:00.001Z",
        turnId: "turn-exact-cap-race",
        kind: "usage",
        usage: {
          providerRequests: 1,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          costNanodollars: 10_000_000,
        },
      });
      // The terminal wins the race with the best-effort interrupt, but the
      // already-observed exact-cap stop remains authoritative for scoring.
      providerCompleted = true;
      return { status: "completed", turnId: "turn-exact-cap-race" };
    });
    const source = RUNNER_LIVE_CANDIDATE_SLOTS[0]!.candidates[0]!;
    const candidate = {
      ...source,
      budget: {
        ...source.budget,
        maxTotalTokens: 100,
        maxCostUsd: 0.01,
      },
    };
    const entry: RunnerLiveScheduleEntry = {
      executionId: "candidate-exact-cap-race",
      caseId: "final-response",
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };

    const observation = await executeLiveRunnerWorkflow({
      entry,
      candidate,
      evalCase: runnerWorkflowCase(entry.caseId),
    });

    expect(liveSessionMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      classification: "candidate_failure",
      metrics: { totalTokens: 100, costUsd: 0.01 },
      failure: {
        code: "candidate_budget_reached",
        category: "candidate",
        retryable: false,
      },
    });
    expect(observation.lifecycle.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "terminal-authority", passed: true }),
        expect.objectContaining({ id: "token-budget", passed: true }),
        expect.objectContaining({ id: "cost-budget", passed: true }),
        expect.objectContaining({ id: "candidate-budget-stop", passed: false }),
        expect.objectContaining({ id: "semantic-disposition", passed: true }),
      ]),
    );
  });
});
