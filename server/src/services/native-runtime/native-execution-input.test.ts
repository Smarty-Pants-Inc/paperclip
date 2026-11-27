import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// Import unchanged Runner source at runtime, without pulling its source tree
// into the server's rootDir. Types come from the existing public facade.
const { executeNativeSession } = await import(new URL("../../../../packages/paperclip-runner/src/native-session-runtime.ts", import.meta.url).href) as Pick<typeof import("../../vendor/paperclip-runner/index.js"), "executeNativeSession">;
const { nativeTaskConstraints } = await import(new URL("../../../../packages/paperclip-runner/src/backends/runtime-context.ts", import.meta.url).href) as { nativeTaskConstraints: (input: ReturnType<typeof parseNativeExecutionInput>) => string[] };
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { renderFirstTurnQueuedInput } from "./first-turn-queued-input.js";
import { shouldWakeAssigneeForIssueComment } from "../issue-comment-wakeup.js";
import { buildQueuedCommentQueueSnapshot } from "../issue-queued-comment-queue.js";
import { assertNativeTurnCommandBound, boundNativeExecutionContinuation, nativeContinuationReadState } from "./native-turn-budget.js";
import { renderNativeRunnerStagedAttachmentPrompt } from "./native-runner-file-handoff.js";
import { clearNativeFreshFallback, registerNativeFreshFallback, nativeFreshFallbackPayload, nativeQueuedTurnUpperBound, assertNativeQueuedTurnBound, nativeQueuedTurnCompositionMeasured, observeNativeTurnBudgetSession, guardNativeTurnCommands, commandEnvelopeBytes, NATIVE_TURN_KNOWN_MAX_BYTES, NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND } from "./native-turn-budget.js";
import type { ExecutionContinuationEnvelope, AskUserQuestionsInteraction } from "@paperclipai/shared";

import { formatDurableQuestionResponseSummary } from "../question-response-delivery.js";
import { nativeCompletionSource, buildNativeCompletionContract } from "./completion-contracts.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildNativeExecutionInput, budgetNativeFreshFallback } from "./native-execution-input.js";
import { decideNativeContinuation } from "./continued-session.js";
import { runnerApiOperation } from "./runner-api-catalog.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { buildNativeModelEnvelope, canonicalNativeRuntimeContextDigest, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

describe("LCA-05 explicit native work mode", () => {
  it.each(["standard", "planning", "ask", "skill_test"])("title and description cannot override %s mode", (workMode) => {
    for (const text of ["Inspect files", "Making a plan", "Create a report", "Research proposal", "Implement now; no plan needed"]) {
      const input = buildNativeExecutionInput({
        companyId: "10000000-0000-4000-8000-000000000001",
        runId: "50000000-0000-4000-8000-000000000005",
        agentId: "30000000-0000-4000-8000-000000000003",
        issue: { id: "20000000-0000-4000-8000-000000000002", identifier: "MODE-1", title: text, description: text, workMode },
        taskPrompt: text,
        workspace: { id: "50000000-0000-4000-8000-000000000005", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        normalizedSessionId: null,
        provider: "codex",
        codexReasoningEffort: "high",
        codexWebSearch: "disabled",
        planningContext: workMode === "planning" ? { documentId: null, baseRevisionId: null, baseRevisionNumber: 0, markdown: "", sha256: "a".repeat(64), reviewContext: {} } : null,
        completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Deliver the requested work", criteria: [{ id: "output", requirement: "Deliver the requested work" }] } },
        runtimeContext: nativeRuntimeContextFixture(),
      });
      expect(input.task.workMode).toBe(workMode);
      expect(input.provider).toMatchObject({ kind: "codex", reasoningEffort: "high", webSearch: "disabled" });
      expect(input.executionMode).toBe(workMode === "planning" ? "plan" : "default");
      expect(input.task.title).toBe(text);
    }
  });

  it.each(["standard", "planning", "ask"] as const)("preserves Cursor Cloud %s intent independently of its native harness mode", workMode => {
    const planningContext = workMode === "planning" ? { documentId: "plan-document", baseRevisionId: "plan-revision-3", baseRevisionNumber: 3,
      markdown: "# Pinned canonical plan", sha256: "a".repeat(64), reviewContext: { feedback: "Keep the requested scope" } } : null;
    const input = buildNativeExecutionInput({
      companyId: "10000000-0000-4000-8000-000000000001", runId: "50000000-0000-4000-8000-000000000005", agentId: "30000000-0000-4000-8000-000000000003",
      issue: { id: "20000000-0000-4000-8000-000000000002", identifier: "MODE-1", title: "Create the requested result", description: null, workMode },
      taskPrompt: "Follow the task's actual work mode.",
      workspace: { id: "50000000-0000-4000-8000-000000000005", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: null,
      provider: "cursor_cloud", model: "explicit-cloud-model", cursorCloud: { schema: "paperclip.cursor-cloud.config.v1", repos: [{ url: "https://github.com/example/fixture" }] },
      planningContext,
      completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Deliver the requested work", criteria: [{ id: "output", requirement: "Deliver the requested work" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(input).toMatchObject({ task: { workMode }, executionMode: workMode === "planning" ? "plan" : "default", planningContext });
    expect(buildNativeModelEnvelope(input)).toMatchObject({ task: { workMode }, executionMode: workMode === "planning" ? "plan" : "default", planningContext });
  });
});

describe("native execution input external-chat framing", () => {
  it.each([false, true])(
    "projects the authoritative selected answer into an attested native chat prompt (resumed: %s)",
    (resumedSession) => {
      const interactionId = "80000000-0000-4000-8000-000000000008";
      const sourceRunId = "90000000-0000-4000-8000-000000000009";
      const wakePayload = {
        reason: "issue_commented",
        externalChatProvider: "telegram",
        externalChatExecutionBound: true,
        interactionId,
        sourceRunId,
        interactionKind: "ask_user_questions",
        interactionStatus: "answered",
        externalInteractionContinuation: true,
        issue: {
          id: "20000000-0000-4000-8000-000000000002",
          workMode: "standard",
          status: "in_review",
        },
        externalChatQuestionResponse: {
          schema: "paperclip.external_chat_question_response.v1",
          interactionId,
          sourceRunId,
          responseDeliveryId: "10000000-0000-4000-8000-000000000011",
          sourceCommentId: "10000000-0000-4000-8000-000000000012",
          endpointId: "10000000-0000-4000-8000-000000000013",
          conversationId: "10000000-0000-4000-8000-000000000014",
          bindingSha256: "a".repeat(64),
        },
        commentIds: ["10000000-0000-4000-8000-000000000012"],
        latestCommentId: "10000000-0000-4000-8000-000000000012",
        comments: [
          {
            id: "10000000-0000-4000-8000-000000000012",
            body: "Ask for a color, then tell me the selected color.",
          },
        ],
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        fallbackFetchNeeded: false,
      };
      const args: Parameters<typeof buildNativeExecutionInput>[0] = {
        companyId: "10000000-0000-4000-8000-000000000001",
        runId: "50000000-0000-4000-8000-000000000005",
        agentId: "30000000-0000-4000-8000-000000000003",
        issue: {
          id: "20000000-0000-4000-8000-000000000002",
          identifier: "CHAT-5",
          title: "Old exact-output request",
          description: null,
          workMode: "standard",
        },
        taskPrompt:
          "Continue the user's original request with their selected answer.",
        initialCommunicationGuidance: "Initial Slack communication preferences.",
        wakePayload,
        resumedSession,
        workspace: {
          id: "50000000-0000-4000-8000-000000000005",
          cwd: "/workspace",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        normalizedSessionId: "60000000-0000-4000-8000-000000000006",
        provider: "codex",
        completionContract: {
          id: "70000000-0000-4000-8000-000000000007",
          sha256: `sha256:${"a".repeat(64)}`,
          schemaVersion: "paperclip.run-result.v1",
          contract: {
            revision: "1",
            objective: "Answer the user's selected choice",
            criteria: [
              { id: "answer", requirement: "Return the actual color." },
            ],
          },
        },
        runtimeContext: nativeRuntimeContextFixture(),
        interactionResponses: [
          {
            interactionId,
            kind: "ask_user_questions",
            response: {
              status: "answered",
              result: {
                version: 1,
                answers: [{ questionId: "color", optionIds: ["amber"] }],
                summaryMarkdown:
                  "Resolved questions and answers:\n- Choose a color: Amber",
              },
            },
          },
        ],
      };
      const input = buildNativeExecutionInput(args);
      expect(input.initialCommunicationGuidance).toBe("Initial Slack communication preferences.");
      // The runtime adds this only after deciding whether provider recovery succeeded.
      expect(input.task.prompt).not.toContain("Initial Slack communication preferences.");
      expect(input.task.title).toBe("External chat follow-up");
      expect(input.task.prompt).toContain("Amber");
      expect(input.task.prompt).not.toContain("## Questions that need a user response");
      expect(input.task.prompt).toContain(
        "semantic completion summary is the user-visible final answer",
      );
      expect(input.task.prompt).not.toContain(
        "including marking the task done",
      );
      expect(input.task.prompt.indexOf("Choose a color: Amber")).toBeLessThan(
        input.task.prompt.indexOf(
          "Ask for a color, then tell me the selected color.",
        ),
      );
      expect(wakePayload).not.toHaveProperty("questionResponse");

      const mixedModalSummary = formatDurableQuestionResponseSummary({
        id: interactionId,
        kind: "ask_user_questions",
        status: "answered",
        sourceRunId,
        payload: {
          version: 1,
          questions: [
            {
              id: "environment",
              prompt: "Choose an environment",
              selectionMode: "single",
              options: [
                { id: "maple", label: "Maple" },
                { id: "cedar", label: "Cedar" },
              ],
            },
            {
              id: "label",
              prompt: "Enter the verification label",
              selectionMode: "single",
              options: [
                {
                  id: "custom",
                  label: "Custom label",
                  freeText: true,
                },
              ],
            },
          ],
        },
        result: {
          version: 1,
          answers: [
            { questionId: "environment", optionIds: ["maple"] },
            {
              questionId: "label",
              optionIds: [],
              otherText: "amber compass 93",
            },
          ],
          summaryMarkdown: null,
        },
      } as unknown as AskUserQuestionsInteraction);
      const mixedModal = buildNativeExecutionInput({
        ...args,
        wakePayload: {
          ...wakePayload,
          comments: [
            {
              ...wakePayload.comments[0],
              body: "Ask a NEW environment and verification-label question.",
            },
          ],
        },
        interactionResponses: [
          {
            interactionId,
            kind: "ask_user_questions",
            response: {
              status: "answered",
              result: {
                version: 1,
                answers: [
                  { questionId: "environment", optionIds: ["maple"] },
                  {
                    questionId: "label",
                    optionIds: [],
                    otherText: "amber compass 93",
                  },
                ],
                summaryMarkdown: mixedModalSummary,
              },
            },
          },
        ],
      });
      expect(mixedModalSummary).toContain("Maple");
      expect(mixedModalSummary).toContain("amber compass 93");
      expect(mixedModal.task.prompt.indexOf("Maple")).toBeLessThan(
        mixedModal.task.prompt.indexOf("Ask a NEW environment"),
      );
      expect(mixedModal.task.prompt.indexOf("amber compass 93")).toBeLessThan(
        mixedModal.task.prompt.indexOf("Ask a NEW environment"),
      );
      expect(mixedModal.task.prompt).toContain(
        "only the answered questions listed above are resolved",
      );
      const unbound = buildNativeExecutionInput({
        ...args,
        interactionResponses: [
          {
            ...args.interactionResponses![0]!,
            interactionId: "10000000-0000-4000-8000-000000000019",
          },
        ],
      });
      expect(unbound.task.title).toBe("Old exact-output request");
      expect(unbound.task.prompt).not.toContain(
        "Native external-chat questions",
      );
      const earlierInteractionId = "10000000-0000-4000-8000-000000000020";
      const sequential = buildNativeExecutionInput({
        ...args,
        interactionResponses: [
          {
            interactionId: earlierInteractionId,
            kind: "ask_user_questions",
            response: {
              status: "answered",
              result: {
                version: 1,
                answers: [{ questionId: "shape", optionIds: ["circle"] }],
                summaryMarkdown: "Choose a shape: Circle",
              },
            },
          },
          ...args.interactionResponses!,
        ],
      });
      expect(sequential.task.title).toBe("External chat follow-up");
      expect(sequential.task.prompt).toContain("Circle");
      expect(sequential.task.prompt).toContain("Amber");
      expect(sequential.task.prompt).not.toContain("## Questions that need a user response");
      expect(
        sequential.task.prompt.indexOf("Choose a shape: Circle"),
      ).toBeLessThan(sequential.task.prompt.indexOf("Choose a color: Amber"));
      expect(
        sequential.interactionResponses.map(
          (response) => response.interactionId,
        ),
      ).toEqual([earlierInteractionId, interactionId]);
      expect(wakePayload).not.toHaveProperty("questionResponse");
    },
  );
  it.each([false, true])(
    "uses neutral framing and real question tools for authenticated overflow chat (resumed: %s)",
    (resumedSession) => {
      const staleRootTitle = "Reply with exactly STALE-OVERFLOW-MARKER";
      const input = buildNativeExecutionInput({
        companyId: "10000000-0000-4000-8000-000000000001",
        runId: "50000000-0000-4000-8000-000000000005",
        issue: {
          id: "20000000-0000-4000-8000-000000000002",
          identifier: "CHAT-5",
          title: staleRootTitle,
          description: "Started from Discord.",
          workMode: "standard",
        },
        taskPrompt: `Paperclip task context:\n- Title: ${JSON.stringify(staleRootTitle)}`,
        resumedSession,
        wakePayload: {
          reason: "External chat message received",
          externalChatProvider: "discord",
          checkedOutByHarness: true,
          issue: {
            id: "20000000-0000-4000-8000-000000000002",
            identifier: "CHAT-5",
            title: staleRootTitle,
            description: "Started from Discord.",
            descriptionTruncated: false,
            status: "in_progress",
            workMode: "standard",
          },
          commentWindow: {
            requestedCount: 2,
            includedCount: 1,
            missingCount: 1,
          },
          commentIds: ["comment-overflow-1", "comment-overflow-2"],
          latestCommentId: "comment-overflow-2",
          comments: [
            {
              id: "comment-overflow-2",
              issueId: "20000000-0000-4000-8000-000000000002",
              body: "Answer both queued messages.",
              bodyTruncated: false,
              authorType: "user",
            },
          ],
          fallbackFetchNeeded: true,
        },
        agentId: "30000000-0000-4000-8000-000000000003",
        workspace: {
          id: "50000000-0000-4000-8000-000000000005",
          cwd: "/workspace",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        normalizedSessionId: "60000000-0000-4000-8000-000000000006",
        provider: "codex",
        completionContract: {
          id: "70000000-0000-4000-8000-000000000007",
          sha256: `sha256:${"a".repeat(64)}`,
          schemaVersion: "paperclip.run-result.v1",
          contract: {
            revision: "1",
            objective: "Respond to all pending comments in order",
            criteria: [
              {
                id: "objective",
                requirement: "Read every current wake comment.",
              },
            ],
          },
        },
        runtimeContext: nativeRuntimeContextFixture(),
      });

      expect(input.task.title).toBe("External chat follow-up");
      expect(input.task.description).toBeNull();
      expect(input.task.prompt).toContain("read_current_wake_comments");
      expect(input.task.prompt).toContain(staleRootTitle);
    },
  );

  it.each([false, true])(
    "keeps GitHub's task-only files and service-owned recovery navigation in the closed native input (resumed: %s)",
    (resumedSession) => {
      const args: Parameters<typeof buildNativeExecutionInput>[0] = {
        companyId: "10000000-0000-4000-8000-000000000001",
        runId: "50000000-0000-4000-8000-000000000005",
        issue: {
          id: "20000000-0000-4000-8000-000000000002",
          identifier: "CHAT-5",
          title: "Send a file",
          description: null,
          workMode: "standard",
        },
        taskPrompt: "Answer the current line review.",
        wakePayload: {
          reason: "External chat message received",
          externalChatProvider: "github",
          checkedOutByHarness: true,
          issue: {
            id: "20000000-0000-4000-8000-000000000002",
            workMode: "standard",
          },
          comments: [
            {
              id: "review-comment",
              body: "Make a text file and attach it here.",
            },
          ],
          commentIds: ["review-comment"],
          latestCommentId: "review-comment",
          commentWindow: {
            requestedCount: 1,
            includedCount: 1,
            missingCount: 0,
          },
          fallbackFetchNeeded: false,
        },
        resumedSession,
        agentId: "30000000-0000-4000-8000-000000000003",
        workspace: {
          id: "50000000-0000-4000-8000-000000000005",
          cwd: "/workspace",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        normalizedSessionId: "60000000-0000-4000-8000-000000000006",
        provider: "codex",
        completionContract: {
          id: "70000000-0000-4000-8000-000000000007",
          sha256: `sha256:${"a".repeat(64)}`,
          schemaVersion: "paperclip.run-result.v1",
          contract: {
            revision: "1",
            objective: "Prepare a file",
            criteria: [
              { id: "objective", requirement: "Describe actual delivery." },
            ],
          },
        },
        runtimeContext: nativeRuntimeContextFixture(),
      };
      const input = buildNativeExecutionInput(args);
      expect(input.task.prompt).toContain(
        "This GitHub App connection cannot upload file bytes into comments or review threads",
      );
      expect(input.task.prompt).toContain(
        "do not say it is attached, displayed, downloadable, or available to open in this provider conversation",
      );
      expect(input.task.prompt).toContain(
        "Preparation does not confirm provider delivery",
      );
      expect(input.task.prompt).toContain(
        "Paperclip owns recovery navigation for unavailable GitHub attachments",
      );
      expect(input.task.prompt).toContain(
        "after an accepted response, only when the current source remains authorized and a safe configured Board URL is available",
      );
      expect(input.task.prompt).toContain(
        "A task URL missing from your prompt or tool results is not evidence that no task link can be provided",
      );
      expect(input.task.prompt).toContain(
        "Do not invent a URL or promise that a link will appear",
      );
      expect(input.task.prompt).toContain(
        "Briefly explain the unavailable input and ask the user to attach it directly to this Paperclip task or paste the needed text",
      );
      expect(input.task.prompt).toContain(
        "Never infer the file's contents or substitute an older file",
      );

      const runtimeContext = nativeRuntimeContextFixture();
      runtimeContext.skills = ["configured", "provider-mentioned"].map((name) => ({
        key: `company/test/${name}`,
        runtimeName: name,
        versionId: null,
        bundle: { ...runtimeContext.instructions.bundle },
      }));
      runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
      const skillArgs = {
        ...args,
        issue: { ...args.issue, description: "Stale provider message: /provider-mentioned" },
        taskPrompt: `${args.taskPrompt}\nGitHub message: /provider-mentioned`,
        runtimeContext,
        githubInstructionSkillKeys: ["company/test/configured", "company/other/unknown"],
      };
      const skillInput = buildNativeExecutionInput(skillArgs);
      expect(skillInput.task.description).toBe("Configured GitHub instruction skills:\n/configured");
      expect(buildNativeModelEnvelope(skillInput)).toMatchObject({ requestedSkills: ["configured"] });
      expect(buildNativeModelEnvelope(buildNativeExecutionInput({
        ...skillArgs, githubInstructionSkillKeys: [],
      }))).toMatchObject({ requestedSkills: [] });

      const wake = args.wakePayload as Record<string, unknown>;
      for (const patch of [
        { externalChatProvider: "slack" },
        { externalChatProvider: "discord" },
        { externalChatProvider: "telegram" },
        { externalChatProvider: "microsoft-teams" },
        { externalChatProvider: null },
        { externalChatProvider: "GitHub" },
        { checkedOutByHarness: false },
      ]) {
        const unrelated = buildNativeExecutionInput({
          ...args,
          wakePayload: { ...wake, ...patch },
        });
        expect(unrelated.task.prompt).not.toContain(
          "Paperclip owns recovery navigation for unavailable GitHub attachments",
        );
        if (["slack", "discord", "telegram", "microsoft-teams"].includes(patch.externalChatProvider ?? "")) {
          const unrelatedSkills = buildNativeExecutionInput({
            ...skillArgs, wakePayload: { ...wake, ...patch },
          });
          expect(unrelatedSkills.task.description).toBeNull();
          expect(buildNativeModelEnvelope(unrelatedSkills)).toMatchObject({ requestedSkills: [] });
        }
      }
    },
  );
  it.each([
    { provider: "codex", resumedSession: false },
    { provider: "codex", resumedSession: true },
    { provider: "acpx", resumedSession: false },
    { provider: "acpx", resumedSession: true },
    { provider: "opencode", resumedSession: false },
    { provider: "opencode", resumedSession: true },
  ] as const)("keeps question documentation in the tool on $provider (resumed: $resumedSession)", ({ provider, resumedSession }) => {
    const input = buildNativeExecutionInput({
      companyId: "10000000-0000-4000-8000-000000000001",
      runId: "50000000-0000-4000-8000-000000000005",
      agentId: "30000000-0000-4000-8000-000000000003",
      issue: { id: "20000000-0000-4000-8000-000000000002", identifier: "QA-1", title: "Welcome", description: null, workMode: "standard" },
      taskPrompt: "Ask whether the welcome should sound warm or formal before writing it.",
      workspace: { id: "40000000-0000-4000-8000-000000000004", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: resumedSession ? "60000000-0000-4000-8000-000000000006" : null,
      provider, resumedSession,
      acpxAgent: "claude",
      model: provider === "acpx" ? "claude-sonnet-5" : provider === "opencode" ? "openai/gpt-5.5" : "gpt-5.6-sol",
      completionContract: {
        id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Write a welcome after the user's answer", criteria: [{ id: "objective", requirement: "Use the selected tone" }] },
      },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(input.provider).toMatchObject(provider === "acpx"
      ? { kind: "acpx", permissionMode: "approve-all" }
      : provider === "opencode" ? { kind: "opencode", permissionMode: "allow" }
      : { kind: "codex", approvalPolicy: "never" });
    expect(input.task.prompt).not.toContain("## Questions that need a user response");
    expect(input.task.prompt).toContain("Use Paperclip's request_human_input for durable task questions.");
    expect(input.task.prompt).not.toContain("payload.questionSet");
  });

});


describe("native serialized-command budget", () => {
  const args: Parameters<typeof buildNativeExecutionInput>[0] = {
    companyId: "company", runId: "run", agentId: "agent", provider: "pi_rpc", normalizedSessionId: "session",
    issue: { id: "task", identifier: "BUDGET-1", title: "Continue", description: null, workMode: "standard" }, taskPrompt: "Preserve the objective.",
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(),
    completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Continue", criteria: [{ id: "output", requirement: "Continue" }] } },
  };
  function shape(count: number, chars: number, actions = 0): ExecutionContinuationEnvelope {
    const messages = Array.from({ length: count }, (_, i) => ({ id: `message-${i}`, authorType: i === count - 1 ? "user" : "agent", authorId: "author", createdByRunId: null,
      body: i === count - 1 ? "LATEST HUMAN REQUEST: preserve every write." : `message ${i}: ` + "x".repeat(Math.floor(chars / (count - 1))),
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deleted: false, sourceTrust: null }));
    return { version: 1, companyId: "company", issueId: "task", objective: "Preserve the objective.", objectiveSource: { kind: "comment", id: messages.at(-1)!.id, revision: messages.at(-1)!.updatedAt },
      trigger: { reason: "issue_reopened_via_comment", interactionId: null, sourceRunId: null }, originCommentIds: [messages[0]!.id], messages,
      completedActions: Array.from({ length: actions }, (_, i) => ({ runId: "old-run", receiptId: `receipt-${i}`, operationId: "GET /api/issues/{id}/comments", result: { status: "ok", body: "r".repeat(1974) } })),
      humanResponses: [], interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [], coverage: { kind: "full_task_history", throughCommentId: messages.at(-1)!.id, summaryThroughCommentId: null } };
  }
  function prepare(c: ExecutionContinuationEnvelope, extra: Partial<typeof args> = {}) {
    let retained = c;
    const input = buildNativeExecutionInput({ ...args, resumedSession: true, continuationProviderSessionId: "provider-generation-1", boundCommandBytes: true, wakePayload: { reason: c.trigger.reason, executionContinuation: c },
      continuationReadState: { nativeSessionId: "session", providerSessionId: "provider-generation-1", lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: c.messages.map(m => m.id) }, onContinuationBudgeted: value => { retained = value; }, ...extra });
    return { input, retained };
  }
  it.each([["long-receipts 156/87", 156, 235936, 87], ["de496399", 10, 467000, 0], ["fresh 552 KB", 10, 546500, 0], ["resumed reopen", 31, 690000, 0], ["resumed task_retry", 31, 690000, 0]] as const)("bounds %s's full snapshot and preserves every receipt", (name, count, chars, actions) => {
    const original = shape(count, chars, actions);
    if (name === "fresh 552 KB") {
      const stock = buildNativeExecutionInput({ ...args, wakePayload: { reason: original.trigger.reason, executionContinuation: original } });
      expect(commandEnvelopeBytes(buildNativeModelEnvelope(stock))).toBeGreaterThan(550000);
      expect(commandEnvelopeBytes(buildNativeModelEnvelope(stock))).toBeLessThan(555000);
    }
    if (name === "resumed task_retry") {
      original.trigger.reason = "task_retry";
      original.resumeDelta = { baseRunId: "previous", messages: [original.messages.at(-1)!] };
    }
    const { input, retained } = prepare(original, name.startsWith("resumed") ? { resumedSession: true, previousTurn: { runId: "previous", task: args.issue } } : {});
    const envelope = buildNativeModelEnvelope(input, { resumedSession: name.startsWith("resumed") } as { resumedSession: true });
    expect(commandEnvelopeBytes(envelope)).toBeLessThanOrEqual(NATIVE_TURN_KNOWN_MAX_BYTES);
    expect(retained.messages.map(m => m.id)).toEqual(expect.arrayContaining([original.messages[0]!.id, original.messages.at(-1)!.id]));
    expect(retained.completedActions).toHaveLength(actions);
    expect(input.task.prompt).toContain("History was cut for this turn:");
    expect(input.task.prompt).toContain("0 receipts omitted");
    expect(input.task.prompt).toContain('call_api with operationId="GET /api/issues/{id}/comments/{commentId}"');
    expect(runnerApiOperation("GET /api/issues/{id}/comments/{commentId}")).toMatchObject({ method: "GET", callPolicy: "rest" });
    expect(input.task.prompt).toContain("LATEST HUMAN REQUEST");
    if (name.startsWith("resumed")) expect(input.continuationPrompt).toBeNull();
    expect(original.coverage).not.toHaveProperty("truncated");
    console.log(JSON.stringify({ shape: name, knownCommandBytes: commandEnvelopeBytes(envelope), retainedMessages: retained.messages.length, coverage: retained.coverage }));
  });
  it.each(["continuous", "paperclip"])("budgets only the selected %s delta and retains the full baseline", sessionContinuity => {
    const c = shape(31, 900000);
    c.trigger.reason = "issue_commented";
    c.originCommentIds = [c.messages.at(-1)!.id];
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const wakePayload = { reason: c.trigger.reason, commentIds: c.originCommentIds, executionContinuation: c };
    const extra = { resumedSession: true, sessionContinuity, previousTurn: { runId: "previous", task: args.issue }, wakePayload };
    const stock = buildNativeExecutionInput({ ...args, ...extra });
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(stock))).toBeGreaterThan(2 * NATIVE_TURN_KNOWN_MAX_BYTES);
    const { input, retained } = prepare(c, extra);
    expect(retained).toBe(c);
    expect(JSON.stringify(input)).toBe(JSON.stringify(stock));
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input, { resumedSession: true }))).toBeLessThan(NATIVE_TURN_KNOWN_MAX_BYTES);
    expect(input.continuationPrompt).not.toContain("History was cut");
    expect(decideNativeContinuation({ ...args, ...extra, hasSession: true, previousRunId: "previous" }).promptOnly).toBe(sessionContinuity === "continuous");
  });
  it("budgets a failed-resume full bootstrap only when that fallback is selected", () => {
    // Read-operation results may still be shortened; old-generation messages may not.
    const c = shape(31, 100, 1);
    c.completedActions![0]!.result = { body: "r".repeat(900000) };
    c.trigger.reason = "issue_commented";
    c.originCommentIds = [c.messages.at(-1)!.id];
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const wake = { reason: c.trigger.reason, commentIds: c.originCommentIds, executionContinuation: c };
    const { input } = prepare(c, { wakePayload: wake, resumedSession: true, previousTurn: { runId: "previous", task: args.issue } });
    expect(input.continuationPrompt).toBe(c.messages.at(-1)!.body);
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input))).toBeGreaterThan(2 * NATIVE_TURN_KNOWN_MAX_BYTES);
    const parsedCopy = parseNativeExecutionInput(input), originalPrompt = input.task.prompt;
    const bounded = budgetNativeFreshFallback(input, wake, { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: c.messages.map(message => message.id) });
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input))).toBeLessThan(NATIVE_TURN_KNOWN_MAX_BYTES);
    expect(input.continuationPrompt).toBeNull();
    expect(bounded!.messages).toEqual(c.messages);
    expect(bounded!.coverage).toMatchObject({ nativeSessionId: "session", shortenedCompletedActions: 1, omitted: [] });
    expect(input.task.prompt).toContain("History was cut");
    const copiedEnvelope = buildNativeModelEnvelope(parsedCopy);
    copiedEnvelope.task.prompt = `late handoff\n\n${copiedEnvelope.task.prompt}\n\nlate attachment`;
    registerNativeFreshFallback("fallback-copy", originalPrompt, input.task.prompt);
    try {
      const payload = nativeFreshFallbackPayload("fallback-copy", { text: JSON.stringify(copiedEnvelope) });
      expect(JSON.parse(String(payload.text)).task.prompt).toBe(`late handoff\n\n${input.task.prompt}\n\nlate attachment`);
      expect(commandEnvelopeBytes(JSON.parse(String(payload.text)))).toBeLessThan(NATIVE_TURN_KNOWN_MAX_BYTES);
    } finally { clearNativeFreshFallback("fallback-copy"); }
  });
  it.each([100, 900000])("preserves dollar replacement tokens byte-identically through failed-resume fallback (%s)", chars => {
    const c = shape(31, 100, 1), body = "Person's exact words: $& $' $` $$ END";
    c.completedActions![0]!.result = { body: "r".repeat(chars) };
    c.messages.at(-1)!.body = body;
    c.trigger.reason = "issue_commented";
    c.originCommentIds = [c.messages.at(-1)!.id];
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const wake = { reason: c.trigger.reason, commentIds: c.originCommentIds, executionContinuation: c };
    const { input } = prepare(c, { wakePayload: wake, resumedSession: true, previousTurn: { runId: "previous", task: args.issue } });
    const originalPrompt = input.task.prompt, stale = buildNativeModelEnvelope(input);
    budgetNativeFreshFallback(input, wake, { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: c.messages.map(message => message.id) });
    const expected = input.task.prompt;
    expect(expected.split(body)).toHaveLength(2);
    expect(expected).toContain(body);
    stale.task.prompt = `handoff\n\n${stale.task.prompt}\n\nattachment`;
    registerNativeFreshFallback("dollar-copy", originalPrompt, expected);
    try {
      const payload = nativeFreshFallbackPayload("dollar-copy", { text: JSON.stringify(stale) });
      expect(JSON.parse(String(payload.text)).task.prompt).toBe(`handoff\n\n${expected}\n\nattachment`);
      expect(JSON.parse(String(payload.text)).task.prompt.split(body)).toHaveLength(2);
    } finally { clearNativeFreshFallback("dollar-copy"); }
  });
  // Pure byte guard plus real, unmodified Runner composition: no provider or
  // alternate renderer can stand in for the late joiners this bound protects.
  it.each(["fresh", "retained", "failed-resume", "pair-f1", "escaped", "attachments-128", "dynamic-constraints", "conversation", "near-line"])("server upper bound covers the real Runner's complete command (%s)", async mode => {
    const resumed = mode === "retained" || mode === "failed-resume" || mode === "pair-f1";
    const c = shape(mode === "failed-resume" ? 31 : 3, 100, mode === "failed-resume" ? 1 : 0);
    if (mode === "failed-resume") c.completedActions![0]!.result = { body: "r".repeat(900000) };
    c.trigger.reason = "issue_commented"; c.originCommentIds = [c.messages.at(-1)!.id];
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const wake = { reason: c.trigger.reason, commentIds: c.originCommentIds, executionContinuation: c };
    const { input } = prepare(c, { wakePayload: wake, resumedSession: resumed,
      ...(resumed ? { previousTurn: { runId: "previous", task: args.issue } } : {}) });
    if (mode === "conversation" && input.provider.kind === "pi_rpc") input.provider.conversationMode = true;
    if (mode === "pair-f1") input.task.prompt = "x".repeat(400029);
    const copy = parseNativeExecutionInput(input), original = input.task.prompt;
    const queued = renderFirstTurnQueuedInput([{ id: "person", createdAt: new Date("2026-01-01Z"),
      body: mode === "escaped" ? '"\\\n\u0000日本語🦖\ud800'.repeat(1000) : "Whole queued person's input. END" }]);
    const attachments = renderNativeRunnerStagedAttachmentPrompt(Array.from({ length: mode === "attachments-128" ? 128 : 1 }, (_, i) => ({
      id: `attachment-${i}`, filename: 'résumé "日本語".txt', contentType: "text/plain", byteSize: 123456789,
      workspaceRelativePath: `.paperclip-inbound/${i}/original`, unavailableReason: null,
    })));
    const attachmentPrompt = mode === "near-line" ? attachments + "a".repeat(450000) : attachments;
    const constraints = [...nativeTaskConstraints(input), ...(mode === "dynamic-constraints" ? ['custom path and answer references: ' + '"\\🦖'.repeat(3000)] : [])];
    const identity = { ...input.binding, sessionId: input.session.normalizedSessionId! };
    const checkpoint = { backendKind: "mock" as const, sessionId: "driver-bound", identity, providerSessionId: "provider-bound",
      providerRecoveryPolicy: "allow_replacement_after_resume_failure" as const, cursor: "0", activeTurnId: null,
      pendingRuntimeRequests: [], lineage: [], workingDirectory: '/workspace/"日本語"' };
    const directory = mkdtempSync(join(tmpdir(), "native-upper-bound-"));
    const core = new DurablePrpControlPlane({ stateDirectory: directory,
      identity: { runnerInstanceId: "runner-bound", environmentLeaseId: "lease-bound", runId: input.binding.runId,
        normalizedSessionId: identity.sessionId, turnId: "turn-bound", itemId: input.binding.issueId },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    guardNativeTurnCommands(core);
    let upperBound = 0, actualBytes = 0, handoff = "";
    const session = { identity: () => identity,
      async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
      async *events() {}, async result() { return null; }, async snapshot() { return checkpoint; }, async close() {},
      async startTurn(turn: { message: { text: string } }) {
        actualBytes = Buffer.byteLength(JSON.stringify(core.queueCommand("turn.start", { text: turn.message.text, turnId: "turn-bound" }, "command-bound")));
        throw new Error("bound-captured-command");
      } };
    try {
      await expect(executeNativeSession({ input: copy, persistedSession: resumed ? checkpoint : undefined,
        backend: { preparedTaskConstraints: constraints,
          async descriptor() { return { kind: "mock", name: "bound", version: "1", capabilities: await session.capabilities(),
            runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
          async openSession() { return session; }, async openReplacementSession() { return session; },
          async recoverSession() { return mode === "failed-resume" || mode === "pair-f1" ? { recovered: false, reason: "fixture history missing" } : { recovered: true, session }; } },
        controlPlane: { async openRun() {}, async checkpointSession() {}, async completeRun() {},
          async appendEvent(event) { const seq = "sourceSeq" in event ? event.sourceSeq : 0;
            return { cursor: seq, highestContiguousSourceSeq: seq, disposition: "committed" }; },
          async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } },
        getFreshSessionHandoff: async () => (handoff = "Whole handoff with quotes: \" $& $' $` $$ 🦖"),
        prepareWakeAttachmentPrompt: async () => attachmentPrompt,
        getFirstTurnQueuedInput: async () => {
          // Executor owns input; Runner parsed copy before the continuity hook.
          // Measure that SAME server object after the hook mutated it in place.
          const freshEnvelope = buildNativeModelEnvelope(input);
          upperBound = nativeQueuedTurnUpperBound(input.binding.runId, resumed ? buildNativeModelEnvelope(input, { resumedSession: true }) : freshEnvelope,
            queued, { freshEnvelope, attachmentPrompt, handoff, constraints, workingDirectory: resumed ? checkpoint.workingDirectory : null });
          return queued;
        },
        onContinuityBreak: async () => {
          if (mode === "pair-f1") {
            // Exact named pair input, at the executor's mutation/registration
            // seam; the real cutting algorithm is exercised by failed-resume.
            input.task.prompt = "b".repeat(44);
            if ("completionSources" in input) delete input.completionSources;
            input.continuationPrompt = null;
          } else budgetNativeFreshFallback(input, wake, { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: c.messages.map(message => message.id) });
          registerNativeFreshFallback(input.binding.runId, original, input.task.prompt, buildNativeModelEnvelope(copy), buildNativeModelEnvelope(input));
        }, runnerInstanceId: "runner-bound", controlPlaneInstanceId: "controller-bound",
      })).rejects.toThrow("bound-captured-command");
      expect(actualBytes).toBeGreaterThan(0);
      expect(upperBound).toBeGreaterThanOrEqual(actualBytes);
      if (mode === "pair-f1") expect(upperBound).toBeLessThanOrEqual(500000);
      console.info(JSON.stringify({ upperBoundFixture: mode, upperBound, actualBytes, margin: upperBound - actualBytes,
        ...(mode === "pair-f1" ? { originalBytes: Buffer.byteLength(original), boundedBytes: Buffer.byteLength(input.task.prompt), admitted: true } : {}) }));
    } finally { clearNativeFreshFallback(input.binding.runId); await core.stop(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("measures stock skill and optional payload fields through the real session/transport serializer", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), "native-stock-bound-"));
    try {
      const result = spawnSync(join(root, "server/node_modules/.bin/tsx"), [join(root, "server/scripts/check-native-stock-turn-bound.mjs"), root, directory],
        { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 90000);
  it.each(["cursor_cloud", "openai_dot", "muse"] as const)("starts a real Runner first turn with unmeasured %s input and nothing queued", async provider => {
    const binding = { bindingId: "external-binding", bindingGeneration: 1, companyId: args.companyId, agentId: args.agentId,
      acceptByUnixMs: Date.now() + 60000, expiresAtUnixMs: Date.now() + 120000 };
    const input = buildNativeExecutionInput({ ...args, provider, model: "fixture-model",
      ...(provider === "cursor_cloud" ? { cursorCloud: { schema: "paperclip.cursor-cloud.config.v1" as const, repos: [{ url: "https://github.com/example/fixture" }] } }
        : provider === "muse" ? { museBinding: binding } : { dotBinding: binding }) });
    const unmeasuredPayload = !nativeQueuedTurnCompositionMeasured(input.provider.kind, input.schema, {});
    expect(unmeasuredPayload).toBe(true);
    if (provider !== "cursor_cloud") expect(input.schema).toBe(provider === "muse" ? "paperclip.native-execution-input.v8" : "paperclip.native-execution-input.v6");
    const identity = { ...input.binding, sessionId: "session" };
    let started = false;
    const session = { identity: () => identity,
      async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
      async *events() {}, async result() { return null; }, async close() {},
      async snapshot() { return { backendKind: "mock" as const, sessionId: "driver", identity, providerSessionId: "provider", cursor: "0", activeTurnId: null, pendingRuntimeRequests: [], lineage: [], workingDirectory: "/workspace" }; },
      async startTurn(turn: { message: { text: string } }) {
        started = true;
        expect(turn.message.text).toContain("Preserve the objective.");
        throw new Error("unmeasured-real-turn-started");
      } };
    await expect(executeNativeSession({ input, backend: {
      async descriptor() { return { kind: "mock", name: "unmeasured", version: "1", capabilities: await session.capabilities(), runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
      async openSession() { return session; } },
      controlPlane: { async openRun() {}, async checkpointSession() {}, async completeRun() {},
        async appendEvent(event) { const seq = "sourceSeq" in event ? event.sourceSeq : 0; return { cursor: seq, highestContiguousSourceSeq: seq, disposition: "committed" }; },
        async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } },
      getFirstTurnQueuedInput: async () => {
        assertNativeQueuedTurnBound(input.binding.runId, buildNativeModelEnvelope(input), null, { unmeasuredPayload });
        return null;
      }, runnerInstanceId: "runner", controlPlaneInstanceId: "controller",
    })).rejects.toThrow("unmeasured-real-turn-started");
    expect(started).toBe(true);
    console.info(JSON.stringify({ unmeasuredRunnerTurn: provider, schema: input.schema, queued: false, started }));
  });
  it("declines unmeasured queued claims without refusing a turn; no input needs no pre-seal bound", () => {
    expect(assertNativeQueuedTurnBound("unknown", {}, "whole queued input", { unmeasuredPayload: true })).toBe(false);
    expect(assertNativeQueuedTurnBound("unknown-empty", {}, null, { unmeasuredPayload: true })).toBeUndefined();
    expect(assertNativeQueuedTurnBound("missing", { requestedSkills: ["assigned"] }, "whole queued input")).toBe(false);
    const skillInputs = Array.from({ length: 65 }, (_, i) => ({ type: "skill" as const, name: `skill_${i}`, path: `/skills/${i}/SKILL.md` }));
    expect(assertNativeQueuedTurnBound("unsupported-count", { requestedSkills: skillInputs.map(skill => skill.name) }, "queued", { skillInputs })).toBe(false);
    expect(assertNativeQueuedTurnBound("unsupported-empty", { requestedSkills: skillInputs.map(skill => skill.name) }, null, { skillInputs })).toBeUndefined();
  });
  it("observes fresh and rebound cached-session cwd without extra snapshot I/O or wrapper stacking", async () => {
    let calls = 0, cwd = "/first";
    const session = { async snapshot() { calls++; return { backendKind: "mock" as const, sessionId: "driver",
      identity: { runId: "run", companyId: "company", issueId: "task", agentId: "agent", sessionId: "session" },
      providerSessionId: "provider", cursor: "0", activeTurnId: null, pendingRuntimeRequests: [], lineage: [], workingDirectory: cwd }; } };
    const firstBackend = observeNativeTurnBudgetSession(session);
    expect(calls).toBe(0);
    await session.snapshot();
    expect(firstBackend.workingDirectory).toBe("/first");
    const wrapper = session.snapshot, nextBackend = observeNativeTurnBudgetSession(session);
    expect(session.snapshot).toBe(wrapper);
    expect(calls).toBe(1);
    cwd = "/fresh/rebound";
    await session.snapshot();
    expect(nextBackend.workingDirectory).toBe(cwd);
    expect(firstBackend.workingDirectory).toBe(cwd);
    expect(calls).toBe(2);
  });
  it.each(["task_description", "newest_message"] as const)("reports the protected %s cause without suggesting a fresh session", kind => {
    const c = shape(3, 100);
    if (kind === "newest_message") c.messages.at(-1)!.body = "x".repeat(600000);
    try {
      prepare(c, kind === "task_description" ? { issue: { ...args.issue, description: "x".repeat(600000) }, taskPrompt: "x".repeat(600000) } : {});
      throw new Error("oversized protected input was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: { kind, bytes: 600000, remedies: kind === "task_description" ? ["edit_task_description", "new_followup_task"] : ["edit_message", "delete_own_message", "new_followup_task"] } });
      expect(String(error)).not.toMatch(/new session|compact/);
    }
  });
  it("attributes a selected delta message to its source, not the equal unsent description", () => {
    const c = shape(3, 100), body = "n".repeat(400000);
    c.messages.at(-1)!.body = body;
    c.trigger.reason = "issue_commented";
    c.originCommentIds = [c.messages.at(-1)!.id];
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const issue = { ...args.issue, description: body };
    const extra = { issue, taskPrompt: body, resumedSession: true, sessionContinuity: "paperclip" as const,
      previousTurn: { runId: "previous", task: issue },
      wakePayload: { reason: c.trigger.reason, commentIds: c.originCommentIds, executionContinuation: c } };
    const selectedBytes = commandEnvelopeBytes(buildNativeModelEnvelope(buildNativeExecutionInput({ ...args, ...extra }), { resumedSession: true }));
    try { prepare(c, extra); throw new Error("oversized message was admitted"); }
    catch (error) {
      console.info(JSON.stringify({ pairProbe: "F3", descriptionBytes: Buffer.byteLength(body), newestMessageBytes: Buffer.byteLength(body), selectedBytes,
        promptCause: (error as { promptCause?: unknown }).promptCause }));
      expect(error).toMatchObject({ promptCause: { kind: "newest_message", bytes: 400000 } });
    }
  });
  it("admits the pair's exact already-budgeted server prompt (400029 to 44 bytes)", () => {
    const original = "x".repeat(400029), bounded = "b".repeat(44), runId = "pair-f1";
    registerNativeFreshFallback(runId, original, bounded);
    try {
      const envelope = { task: { prompt: bounded } };
      expect(nativeFreshFallbackPayload(runId, { text: JSON.stringify(envelope) })).toEqual({ text: JSON.stringify(envelope) });
      const bound = nativeQueuedTurnUpperBound(runId, envelope, null, { freshEnvelope: envelope });
      expect(bound).toBeLessThan(500000);
      console.info(JSON.stringify({ pairProbe: "F1", originalBytes: Buffer.byteLength(original), boundedBytes: Buffer.byteLength(bounded), bound, admitted: true }));
    } finally { clearNativeFreshFallback(runId); }
  });
  it("repairs a stale failed-resume envelope without losing stock skill prefixes or dollar tokens", () => {
    const original = "old context".repeat(40000), bounded = "Whole person: $& $' $` $$ END";
    registerNativeFreshFallback("skill-fallback", original, bounded);
    try {
      const prefix = "$first $second\n\n";
      const payload = nativeFreshFallbackPayload("skill-fallback", { text: prefix + JSON.stringify({ task: { prompt: `handoff\n\n${original}\n\nattachment` } }) });
      expect(payload.text).toBe(prefix + JSON.stringify({ task: { prompt: `handoff\n\n${bounded}\n\nattachment` } }));
    } finally { clearNativeFreshFallback("skill-fallback"); }
  });
  it.each(["same-length", "prefix", "non-json"])("fails closed on a near-original stale fallback (%s)", variant => {
    const runId = "near-original", original = "old bootstrap history ".repeat(18000), bounded = "Whole person's request $& $' $` $$ END";
    registerNativeFreshFallback(runId, original, bounded);
    try {
      const changed = variant === "prefix" ? original.slice(0, -1) : original.slice(0, -1) + "!";
      const text = variant === "non-json" ? changed : "$first $second\n\n" + JSON.stringify({ task: { prompt: changed } });
      expect(() => nativeFreshFallbackPayload(runId, { text })).toThrow(expect.objectContaining({
        code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: { kind: "stale_copy", bytes: Buffer.byteLength(changed), remedies: ["report_defect"] },
      }));
    } finally { clearNativeFreshFallback(runId); }
  });
  it.each(["unrelated", "same-length-unrelated", "bounded-late-joiner", "exact-original", "near-original"] as const)("discriminates real failed-resume bootstrap content (%s)", async mode => {
    // The stale original is BELOW the final command cap: the near-original
    // refusal must come from removed history, not the ordinary byte guard.
    const c = shape(31, 100, 1);
    c.completedActions![0]!.result = { body: "r".repeat(420000) };
    c.trigger.reason = "issue_commented";
    c.originCommentIds = [c.messages.at(-1)!.id];
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const wake = { reason: c.trigger.reason, commentIds: c.originCommentIds, executionContinuation: c };
    const { input } = prepare(c, { wakePayload: wake, resumedSession: true, previousTurn: { runId: "previous", task: args.issue } });
    const original = input.task.prompt;
    budgetNativeFreshFallback(input, wake, { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: c.messages.map(message => message.id) });
    const bounded = input.task.prompt;
    expect(bounded.length).toBeLessThan(original.length);
    const unrelated = buildNativeExecutionInput({ ...args,
      issue: { ...args.issue, id: "another-task", title: "Check a different report" },
      taskPrompt: "Read the other report and preserve its findings.",
      wakePayload: { reason: "issue_commented", comments: [{ id: "another-comment", body: "Check the new totals." }] },
    }).task.prompt;
    expect(unrelated.slice(0, 128)).toBe(original.slice(0, 128));
    expect(unrelated).not.toContain(original);
    // Change one byte in history actually removed by this cut, not boilerplate.
    const omittedBody = (c.completedActions![0]!.result as { body: string }).body;
    expect(bounded).not.toContain(omittedBody);
    const changedAt = original.indexOf(omittedBody) + Math.floor(omittedBody.length / 2);
    expect(changedAt).toBeGreaterThan(0);
    const nearOriginal = original.slice(0, changedAt) + "!" + original.slice(changedAt + 1);
    const late = "\n\nWhole late queued input: $& $' $` $$ END";
    const prompt = mode === "unrelated" ? unrelated : mode === "same-length-unrelated" ? unrelated.padEnd(original.length, "z")
      : mode === "bounded-late-joiner" ? bounded + late : mode === "exact-original" ? original + late : nearOriginal;
    const prefix = "$first $second\n\n";
    const text = prefix + JSON.stringify({ task: { prompt } });
    const runId = `real-fallback-${mode}`;
    const directory = mkdtempSync(join(tmpdir(), "native-real-fallback-"));
    const core = new DurablePrpControlPlane({ stateDirectory: directory,
      identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId, normalizedSessionId: "session", turnId: "turn", itemId: "task" },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    registerNativeFreshFallback(runId, original, bounded);
    guardNativeTurnCommands(core);
    try {
      if (mode === "near-original") {
        // Without a fallback registration this exact command fits the guard.
        const plainRun = new DurablePrpControlPlane({ stateDirectory: join(directory, "plain"),
          identity: { ...core.store.state.identity, runId: `${runId}-plain` },
          expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
        guardNativeTurnCommands(plainRun);
        try { expect(plainRun.queueCommand("turn.start", { text }, "fits-byte-guard").payload.text).toBe(text); }
        finally { await plainRun.stop(); }
        expect(() => core.queueCommand("turn.start", { text }, "near-original")).toThrow(expect.objectContaining({
          promptCause: { kind: "stale_copy", bytes: Buffer.byteLength(nearOriginal), remedies: ["report_defect"] },
        }));
        expect(core.store.state.commands).toHaveLength(0);
      } else {
        const command = core.queueCommand("turn.start", { text }, mode);
        const expected = mode === "exact-original" ? bounded + late : prompt;
        expect(command.payload.text).toBe(prefix + JSON.stringify({ task: { prompt: expected } }));
        expect(core.store.state.commands).toHaveLength(1);
        // An unrelated bootstrap is still measured, not exempted from the cap.
        expect(() => core.queueCommand("turn.start", { text, attachment: "a".repeat(500000) }, "oversized"))
          .toThrow(expect.objectContaining({ promptCause: expect.objectContaining({ kind: "command" }) }));
        expect(core.store.state.commands).toHaveLength(1);
      }
      console.info(JSON.stringify({ realFallbackDiscrimination: mode, originalBytes: Buffer.byteLength(original), boundedBytes: Buffer.byteLength(bounded),
        promptBytes: Buffer.byteLength(prompt), queuedCommands: core.store.state.commands.length }));
    } finally { clearNativeFreshFallback(runId); await core.stop(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("guards later turn.start commands after failed resume without requiring the stale bootstrap again", async () => {
    const runId = "fallback-later-turn", original = "stale original bootstrap", bounded = "bounded bootstrap";
    const directory = mkdtempSync(join(tmpdir(), "native-later-turn-"));
    const core = new DurablePrpControlPlane({ stateDirectory: directory,
      identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId, normalizedSessionId: "session", turnId: "turn", itemId: "task" },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    registerNativeFreshFallback(runId, original, bounded);
    guardNativeTurnCommands(core);
    try {
      const first = core.queueCommand("turn.start", { text: JSON.stringify({ task: { prompt: original } }) }, "first");
      expect(JSON.parse(String(first.payload.text)).task.prompt).toBe(bounded);
      for (const text of [JSON.stringify({ schema: "paperclip.native-continuation.v1", messages: [] }),
        JSON.stringify({ disposition: "continue" }), "/compact", JSON.stringify({ task: { prompt: "An unrelated later task prompt" } })]) {
        expect(core.queueCommand("turn.start", { text }, `later-${core.store.state.commands.length}`).payload.text).toBe(text);
      }
      expect(() => core.queueCommand("turn.start", { text: "later ".repeat(100000) }, "oversized-later"))
        .toThrow(NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND);
    } finally { clearNativeFreshFallback(runId); await core.stop(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([2, 10])("C31 v11: splitting 600000 bytes into %i unread messages still refuses; a short link-only follow-up passes", count => {
    const c = shape(count, 0);
    c.originCommentIds = [];
    for (const message of c.messages) { message.authorType = "user"; message.body = "x".repeat(600_000 / count); }
    expect(() => prepare(c, { continuationReadState: { lastRunAt: null, readCommentIds: [] } })).toThrow(expect.objectContaining({
      promptCause: count === 10 ? { kind: "unread_messages", bytes: 600_000, count, remedies: ["edit_message", "delete_own_message", "new_followup_task"] }
        : { kind: "unread_message", bytes: 300_000, remedies: ["edit_message", "delete_own_message", "new_followup_task"] },
    }));
    const short = buildNativeExecutionInput({ ...args, boundCommandBytes: true,
      issue: { ...args.issue, id: "follow-up", title: "Read linked request", description: "Read the long request at https://example.test/saved-text" },
      taskPrompt: "Read the long request at https://example.test/saved-text" });
    expect(() => assertNativeTurnCommandBound("turn.start", { text: JSON.stringify(buildNativeModelEnvelope(short)) })).not.toThrow();
    if (count === 10) {
      const ownerAsk = "@owner please split this request";
      c.messages.push({ ...c.messages[0]!, id: "owner-ask", body: ownerAsk });
      expect(() => prepare(c, { continuationReadState: { lastRunAt: null, readCommentIds: [] } })).toThrow(expect.objectContaining({
        promptCause: { kind: "unread_messages", bytes: 600_000 + Buffer.byteLength(ownerAsk), count: 11, remedies: ["edit_message", "delete_own_message", "new_followup_task"] },
      }));
      console.info(JSON.stringify({ recoveryRow: "owner-ask-adds-to-combined-refusal", count: 11, bytes: 600_000 + Buffer.byteLength(ownerAsk) }));
    }
    console.info(JSON.stringify({ recoveryRow: "split-versus-new-task", count, combinedBytes: 600_000, splitRefused: true, linkOnlyFollowUpAdmitted: true }));
  });
  it("C31 v11: asking the owner here wakes another refused turn and adds unread input; deleting your oversized message removes that size cause", () => {
    const c = shape(2, 0);
    c.originCommentIds = [];
    c.messages[0]!.authorType = "user";
    c.messages[0]!.body = "x".repeat(600_000);
    c.messages[1]!.body = "@owner please split this request";
    const wakes = shouldWakeAssigneeForIssueComment({ selfComment: false, resumeRequested: false,
      issueAtCommentStart: {}, reopened: false, currentStatus: "blocked" });
    expect(wakes).toBe(true);
    const readState = { lastRunAt: null, readCommentIds: [] };
    expect(() => prepare(c, { continuationReadState: readState })).toThrow(expect.objectContaining({
      promptCause: { kind: "unread_message", bytes: 600_000, remedies: ["edit_message", "delete_own_message", "new_followup_task"] },
    }));
    // execution-continuation projects a tombstoned comment as deleted + empty body.
    c.messages[0]!.body = "";
    c.messages[0]!.deleted = true;
    const { input } = prepare(c, { continuationReadState: readState });
    expect(() => assertNativeTurnCommandBound("turn.start", { text: JSON.stringify(buildNativeModelEnvelope(input)) })).not.toThrow();
    console.info(JSON.stringify({ recoveryRow: "owner-comment-and-author-delete", wakes, unreadMessagesBeforeDelete: 2,
      beforeDeleteRefused: true, afterDeleteAdmitted: true, sendsContinuationMessage: true }));
  });
  it("C31 v11: queued does not let another person edit a message", () => {
    const snapshot = (actorId: string) => buildQueuedCommentQueueSnapshot({ issueId: "task", queueId: "queue", state: "queued",
      activeRunId: null, protocol: "legacy", steeringDisposition: "unsupported", actorType: "user", actorId,
      comments: [{ id: "message", authorUserId: "author", authorAgentId: null, body: "long request",
        createdAt: new Date(0), updatedAt: new Date(0) }] });
    expect(snapshot("author").entries[0]!.canEdit).toBe(true);
    expect(snapshot("another-user").entries[0]!.canEdit).toBe(false);
    console.info(JSON.stringify({ recoveryRow: "author-only-queued-edit", authorCanEdit: true, otherCanEdit: false }));
  });
  it("names the unread SUM when no one message alone would make the turn fit", () => {
    const c = shape(3, 100);
    for (const message of c.messages) message.body = "u".repeat(250000);
    c.originCommentIds = [];
    expect(() => prepare(c, { continuationReadState: { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: [] } })).toThrow(expect.objectContaining({
      promptCause: { kind: "unread_messages", bytes: 750000, count: 3, remedies: ["edit_message", "delete_own_message", "new_followup_task"] },
    }));
  });
  it("names combined required inputs rather than blaming the largest insufficient part", () => {
    const c = shape(3, 100); c.messages.at(-1)!.body = "n".repeat(450000);
    expect(() => prepare(c, { issue: { ...args.issue, description: "d".repeat(450000) }, taskPrompt: "a".repeat(450000) })).toThrow(expect.objectContaining({
      promptCause: { kind: "protected_inputs", bytes: expect.any(Number), measure: "protected_parts", remedies: ["new_followup_task"] },
    }));
  });
  it("C31 v11: labels an envelope-only refusal instead of calling its bytes a raw-part sum", () => {
    try {
      buildNativeExecutionInput({ ...args, taskPrompt: "", boundCommandBytes: true,
        issue: { ...args.issue, title: "x".repeat(600_000) } });
      throw new Error("expected envelope-only refusal");
    } catch (error) {
      expect(error).toMatchObject({ promptCause: { kind: "protected_inputs", bytes: expect.any(Number), measure: "envelope_with_reserve" } });
    }
  });
  it("names required task input specifically and budgets an unlocatable bootstrap whole", () => {
    const c = shape(3, 100), wake = { executionContinuation: c };
    const { input } = prepare(c);
    input.task.prompt = "Older opaque bootstrap: $& $' $` $$";
    const original = input.task.prompt;
    expect(budgetNativeFreshFallback(input, wake)).toBe(c);
    expect(input.task.prompt).toBe(original);
    input.task.prompt = "x".repeat(600000);
    expect(() => budgetNativeFreshFallback(input, wake)).toThrow(expect.objectContaining({ promptCause: { kind: "protected_input", bytes: 600000, remedies: ["new_followup_task"] } }));
  });
  it("C31 read-state parsing preserves provenance and fences selected generations", () => {
    const saved = { nativeSessionId: "session", providerSessionId: "provider", lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: ["read", 3] };
    const parsed = nativeContinuationReadState(saved);
    expect(parsed).toEqual({ ...saved, readCommentIds: ["read"] });
    expect(nativeContinuationReadState(parsed, { nativeSessionId: "session", providerSessionId: "provider" }).readCommentIds).toEqual(["read"]);
    for (const target of [null, { nativeSessionId: "session", providerSessionId: "other" }, { nativeSessionId: "other", providerSessionId: "provider" }])
      expect(nativeContinuationReadState(parsed, target).readCommentIds).toEqual([]);
    expect(nativeContinuationReadState({ lastRunAt: saved.lastRunAt, readCommentIds: ["read"] },
      { nativeSessionId: "session", providerSessionId: "provider" }).readCommentIds).toEqual([]);
  });
  it.each(["old-generation", "legacy", "other-provider", "other-native-session", "fresh"] as const)("C31 fresh fallback never cuts old-only input (%s)", generation => {
    const c = shape(3, 100);
    c.messages[1]!.body = "READ_ONLY_IN_OLD_GENERATION " + "x".repeat(400000);
    c.originCommentIds = [c.messages.at(-1)!.id];
    const readState = { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: c.messages.map(m => m.id),
      ...(generation === "legacy" ? {} : { nativeSessionId: generation === "other-native-session" ? "another-session" : "session",
        providerSessionId: generation === "other-provider" ? "another-provider" : "provider-generation-1" }) };
    if (generation === "other-provider" || generation === "other-native-session" || generation === "fresh") {
      expect(() => prepare(c, { continuationReadState: readState, ...(generation === "fresh" ? { resumedSession: false } : {}) }))
        .toThrow(expect.objectContaining({ code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: expect.objectContaining({ kind: "unread_message" }) }));
      return;
    }
    c.trigger.reason = "issue_commented";
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const wakePayload = { reason: c.trigger.reason, executionContinuation: c };
    const { input } = prepare(c, { wakePayload, previousTurn: { runId: "previous", task: args.issue }, continuationReadState: readState });
    expect(() => budgetNativeFreshFallback(input, wakePayload, readState)).toThrow(expect.objectContaining({
      code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: { kind: "unread_message", bytes: 400028,
        remedies: ["edit_message", "delete_own_message", "new_followup_task"] },
    }));
    expect(input.task.prompt).toContain(c.messages[1]!.body);
    expect(c.coverage).not.toHaveProperty("omitted");
  });
  it("C31 same-generation full resume still permits exact read-message omission", () => {
    const c = shape(3, 100);
    c.messages[1]!.body = "READ_IN_THIS_GENERATION " + "x".repeat(400000);
    c.originCommentIds = [c.messages.at(-1)!.id];
    const { input, retained } = prepare(c);
    expect(retained.messages.map(m => m.id)).not.toContain(c.messages[1]!.id);
    expect(retained.coverage).toMatchObject({ omitted: expect.arrayContaining([{ id: c.messages[1]!.id, updatedAt: c.messages[1]!.updatedAt }]) });
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input))).toBeLessThanOrEqual(NATIVE_TURN_KNOWN_MAX_BYTES);
  });
  it("C31 fresh fallback refuses a snapshot already missing old-generation omitted bodies", () => {
    const c = shape(3, 100);
    Object.assign(c.coverage, { nativeSessionId: "session", providerSessionId: "provider-generation-1", omitted: [{ id: "missing-old", updatedAt: "2026-01-01T00:00:00Z" }] });
    const { input } = prepare(c);
    expect(() => budgetNativeFreshFallback(input, { executionContinuation: c })).toThrow(expect.objectContaining({
      code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: expect.objectContaining({ kind: "protected_inputs" }),
    }));
  });
  it("classifies an unread oversized message when a kept turn falls back to fresh input", () => {
    const c = shape(3, 100);
    c.messages[1]!.body = "x".repeat(600000);
    c.trigger.reason = "issue_commented";
    c.originCommentIds = [c.messages.at(-1)!.id];
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const wakePayload = { reason: c.trigger.reason, executionContinuation: c };
    const { input } = prepare(c, { wakePayload, resumedSession: true, previousTurn: { runId: "previous", task: args.issue } });
    try {
      budgetNativeFreshFallback(input, wakePayload, { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: [] });
      throw new Error("oversized unread fallback was accepted");
    } catch (error) {
      expect(error).toMatchObject({ promptCause: { kind: "unread_message", bytes: 600000 } });
      expect(String(error)).toMatch(/unread message.*new short follow-up task/);
    }
  });
  it("carries an unread comment over the queued share whole or refuses with its cause, never shortens it", () => {
    const c = shape(3, 100), readState = { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: [] };
    c.messages[1]!.body = "UNREAD: " + "u".repeat(100000) + " END OF UNREAD WORDS";
    expect(prepare(c, { continuationReadState: readState }).input.task.prompt).toContain(c.messages[1]!.body);
    c.messages[1]!.body = "u".repeat(600000);
    expect(() => prepare(c, { continuationReadState: readState })).toThrow(expect.objectContaining({
      code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: { kind: "unread_message", bytes: 600000, remedies: ["edit_message", "delete_own_message", "new_followup_task"] },
    }));
  });
  it.each(["humanResponses", "interactionResponses"] as const)("carries long %s answers whole or refuses with the answer cause", channel => {
    const c = shape(3, 100);
    const build = (body: string) => {
      const result = { version: 1, answers: [{ questionId: "scope", optionIds: [], otherText: body }] };
      c.humanResponses = channel === "humanResponses" ? [{ id: "answer", kind: "ask_user_questions", status: "answered",
        resolvedByUserId: "board", resolvedAt: "2026-01-01T00:00:00Z", result }] : [];
      return prepare(c, { interactionResponses: channel === "interactionResponses"
        ? [{ interactionId: "answer", kind: "ask_user_questions", response: { status: "answered", result } }] : [] }).input;
    };
    const body = "PERSON'S ANSWER " + "a".repeat(100000) + " END OF ANSWER";
    const input = build(body);
    expect(channel === "humanResponses" ? input.task.prompt : JSON.stringify(buildNativeModelEnvelope(input))).toContain(body);
    expect(() => build("a".repeat(600000))).toThrow(expect.objectContaining({
      code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: { kind: "human_response", bytes: expect.any(Number), remedies: ["new_followup_task"] },
    }));
  });
  it("does not label an uncut delta with its full snapshot's earlier cut", () => {
    const c = shape(3, 100);
    Object.assign(c.coverage, { truncated: true, omittedMessages: 4, omittedCompletedActions: 3 });
    c.resumeDelta = { baseRunId: "previous", messages: [c.messages.at(-1)!] };
    const prompt = renderPaperclipWakePrompt({ executionContinuation: c }, { resumedSession: true });
    expect(prompt).not.toContain("History was cut");
    expect(prompt).toContain("earlier history remains in this session");
  });
  it("keeps short native input byte-identical and leaves unbounded non-native construction unchanged", () => {
    const c = shape(3, 100);
    const stock = buildNativeExecutionInput({ ...args, wakePayload: { reason: c.trigger.reason, executionContinuation: c } });
    expect(JSON.stringify(prepare(c).input)).toBe(JSON.stringify(stock));
    const large = shape(10, 690000);
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(prepare(large, { boundCommandBytes: false }).input))).toBeGreaterThan(NATIVE_TURN_KNOWN_MAX_BYTES);
  });
  // Pure rendering regression: the production refusal was dominated by the
  // agent's own write responses, not removable messages or a large objective.
  function writeHeavyShape(): ExecutionContinuationEnvelope {
    const c = shape(32, 93000);
    const operations = [
      ...Array<string>(26).fill("POST /api/issues/{id}/comments"),
      ...Array<string>(9).fill("POST /api/companies/{companyId}/skill-sources/{sourceId}/refresh"),
      ...Array<string>(6).fill("PATCH /api/companies/{companyId}/skill-sources/{sourceId}/settings"),
      ...Array<string>(7).fill("PATCH /api/companies/{companyId}/skill-sources/{sourceId}"),
      ...Array<string>(8).fill("POST /api/companies/{companyId}/skills/{skillId}/install-update"),
      ...Array<string>(8).fill("POST /api/issues/{id}/work-products"),
    ];
    c.completedActions = operations.map((operationId, i) => ({ runId: "old-run", receiptId: `write-${i}`, operationId,
      result: { operationId, ok: true, status: 200, kind: "resource", target: `target-${i}`,
        data: { id: `resource-${i}`, key: `key-${i}`, identifier: `RESOURCE-${i}`, number: i,
          name: `Resource ${i}`, title: `Saved ${i}`, url: `https://example.test/resources/${i}`,
          // Nine refresh responses total about 91 KB, with a 24 KB largest body.
          body: "w".repeat(i === 26 ? 24000 : i >= 27 && i < 35 ? 8375 : 2600),
          nested: { id: "not-the-resource", body: "not retained" } } } }));
    return c;
  }
  it.each([false, true])("fits 64 production-shaped write receipts without omitting any message or resource identity (messages read: %s)", messagesRead => {
    const c = writeHeavyShape(), before = JSON.stringify(c), description = "d".repeat(5000);
    const extra = { issue: { ...args.issue, description }, taskPrompt: description,
      continuationReadState: { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: messagesRead ? c.messages.map(message => message.id) : [] } };
    const stock = buildNativeExecutionInput({ ...args, ...extra, wakePayload: { reason: c.trigger.reason, executionContinuation: c } });
    const beforeBytes = commandEnvelopeBytes(buildNativeModelEnvelope(stock));
    expect(c.completedActions).toHaveLength(64);
    for (const receipt of c.completedActions!) expect(runnerApiOperation(receipt.operationId).method).toMatch(/^(POST|PATCH)$/);
    const receiptBytes = Buffer.byteLength(JSON.stringify(c.completedActions));
    expect(receiptBytes).toBeGreaterThan(250000);
    expect(receiptBytes).toBeLessThan(280000);
    expect(beforeBytes).toBeGreaterThan(NATIVE_TURN_KNOWN_MAX_BYTES);
    const { input, retained } = prepare(c, extra);
    const afterBytes = commandEnvelopeBytes(buildNativeModelEnvelope(input));
    expect(afterBytes).toBeLessThanOrEqual(NATIVE_TURN_KNOWN_MAX_BYTES);
    expect(retained.messages).toEqual(c.messages);
    expect(retained.completedActions).toHaveLength(64);
    expect(retained.coverage).toMatchObject({ omittedMessages: 0, omittedCompletedActions: 0 });
    expect(JSON.stringify(c)).toBe(before);
    for (const [i, receipt] of retained.completedActions!.entries()) {
      const original = c.completedActions![i]!;
      expect(receipt).toMatchObject({ runId: original.runId, receiptId: original.receiptId, operationId: original.operationId });
      const result = receipt.result as Record<string, unknown>;
      expect(result).toMatchObject({ operationId: original.operationId, ok: true, status: 200, kind: "resource", target: `target-${i}`,
        data: { id: `resource-${i}`, key: `key-${i}`, identifier: `RESOURCE-${i}`, number: i,
          name: `Resource ${i}`, title: `Saved ${i}`, url: `https://example.test/resources/${i}` } });
      if (result.resultOmittedForSize) {
        expect(result.resultSha256).toBe(`sha256:${createHash("sha256").update(JSON.stringify(original.result)).digest("hex")}`);
        expect(result.note).toBe("Result omitted for size; the write succeeded. Re-read the target by its id if needed.");
        expect(result.data).not.toHaveProperty("body");
        expect(result.data).toHaveProperty("nested", { id: "not-the-resource" });
      }
    }
    console.info(JSON.stringify({ writeReceiptRegression: true, messagesRead, receipts: 64, receiptBytes, beforeBytes, afterBytes,
      messages: retained.messages.length, coverage: retained.coverage }));
  });
  it("also shortens write receipts when a failed resume selects the full bootstrap", () => {
    const c = writeHeavyShape(), description = "d".repeat(5000);
    const wake = { reason: c.trigger.reason, executionContinuation: c };
    const input = buildNativeExecutionInput({ ...args, issue: { ...args.issue, description }, taskPrompt: description, wakePayload: wake });
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input))).toBeGreaterThan(NATIVE_TURN_KNOWN_MAX_BYTES);
    const retained = budgetNativeFreshFallback(input, wake, { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: [] })!;
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input))).toBeLessThanOrEqual(NATIVE_TURN_KNOWN_MAX_BYTES);
    expect(retained.messages).toEqual(c.messages);
    expect(retained.completedActions).toHaveLength(64);
    expect(retained.coverage).toMatchObject({ omittedMessages: 0, omittedCompletedActions: 0, shortenedCompletedActions: expect.any(Number) });
    expect(retained.completedActions!.some(receipt => (receipt.result as Record<string, unknown>).resultOmittedForSize === true)).toBe(true);
  });
  it("leaves under-bound write receipts and the complete input byte-identical", () => {
    const c = writeHeavyShape();
    c.completedActions = c.completedActions!.slice(0, 2);
    const before = JSON.stringify(c);
    const stock = buildNativeExecutionInput({ ...args, wakePayload: { reason: c.trigger.reason, executionContinuation: c } });
    const { input, retained } = prepare(c);
    expect(retained).toBe(c);
    expect(JSON.stringify(retained)).toBe(before);
    expect(JSON.stringify(input)).toBe(JSON.stringify(stock));
  });
  it("shortens reads before larger writes, without omitting read messages", () => {
    const c = shape(3, 100, 1);
    c.completedActions![0]!.result = { ok: true, data: "r".repeat(30000) };
    c.completedActions!.push({ runId: "old-run", receiptId: "write", operationId: "POST /api/issues/{id}/comments",
      result: { ok: true, data: { id: "saved", body: "w".repeat(315000) } } });
    const { retained } = prepare(c);
    expect(retained.messages).toEqual(c.messages);
    expect(retained.completedActions![0]!.result).toMatchObject({ resultOmittedForSize: true });
    expect(retained.completedActions![1]).toEqual(c.completedActions![1]);
    expect(retained.coverage).toMatchObject({ shortenedCompletedActions: 1, omittedMessages: 0 });
  });
  it("shortens the largest successful write first and keeps top-level identity and status", () => {
    const c = shape(3, 100);
    c.completedActions = [
      { runId: "old-run", receiptId: "small", operationId: "POST /api/issues/{id}/comments", result: { id: "small", body: "s".repeat(20000) } },
      { runId: "old-run", receiptId: "large", operationId: "PATCH /api/companies/{companyId}/skill-sources/{sourceId}",
        result: { ok: true, status: 200, id: "large", key: "source", identifier: "RESOURCE-0", number: 0,
          name: "Source", title: "Saved source", url: "https://example.test/source", body: "l".repeat(330000) } },
    ];
    const { retained } = prepare(c);
    expect(retained.messages).toEqual(c.messages);
    expect(retained.completedActions![0]).toEqual(c.completedActions![0]);
    expect(retained.completedActions![1]!.result).toMatchObject({ ok: true, status: 200, id: "large", key: "source",
      identifier: "RESOURCE-0", number: 0, name: "Source", title: "Saved source", url: "https://example.test/source", resultOmittedForSize: true });
    expect(retained.coverage).toMatchObject({ shortenedCompletedActions: 1, omittedMessages: 0, omittedCompletedActions: 0 });
  });
  // Pure budget rows: a second, smaller successful write allows inspection of
  // an ineligible large result without omitting any message or receipt.
  function receiptBudgetRow(result: Record<string, unknown>) {
    const c = shape(3, 100);
    c.completedActions = [
      { runId: "old-run", receiptId: "candidate", operationId: "POST /api/issues/{id}/comments", result: { ...result, padding: "x".repeat(320000) } },
      { runId: "old-run", receiptId: "saver", operationId: "POST /api/issues/{id}/comments", result: { ok: true, status: 201, data: { id: "saver", body: "s".repeat(50000) } } },
    ];
    const before = JSON.stringify(c);
    const retained = boundNativeExecutionContinuation(c, value => commandEnvelopeBytes(value) + 10000,
      undefined, () => false, undefined, () => true);
    expect(JSON.stringify(c)).toBe(before);
    expect(retained.messages).toEqual(c.messages);
    expect(retained.completedActions).toHaveLength(2);
    expect(retained.coverage).toMatchObject({ shortenedCompletedActions: 1, omittedMessages: 0, omittedCompletedActions: 0 });
    return { original: c, retained, result: retained.completedActions![0]!.result as Record<string, unknown> };
  }
  it.each([
    ["422 validation", { ok: false, status: 422, data: { id: "refused" }, error: "validation", details: { reason: "invalid input" } }],
    ["500 unknown", { ok: false, status: 500, data: { id: "uncertain" }, error: "server_error", outcome: "unknown", guidance: "Inspect before retrying" }],
    ["transport failure", { ok: false, status: null, error: "api_transport_failure", outcome: "unknown", guidance: "Inspect before retrying" }],
    ["missing ok", { status: 200, id: "not-confirmed" }],
    ["false ok with 2xx", { ok: false, status: 200, id: "not-confirmed" }],
    ["true ok with 422", { ok: true, status: 422, id: "not-confirmed" }],
    ["true ok with 500", { ok: true, status: 500, id: "not-confirmed" }],
    ["null status", { ok: true, status: null, id: "not-confirmed" }],
    ["absent status", { ok: true, data: { id: "saved" } }],
    ["body error", { ok: true, status: 200, data: { id: "saved", error: "Save refused" } }],
    ["null body error", { ok: true, status: 200, data: { id: "saved", error: null } }],
    ["empty top-level error", { ok: true, status: 200, id: "saved", error: "" }],
    ["key without id", { ok: true, status: 200, data: { key: "saved" } }],
    ["number without id", { ok: true, status: 201, data: { number: 0 } }],
    ["nested id without own id", { ok: true, status: 201, data: { comment: { id: "comment" }, issue: { identifier: "RESOURCE-1" } } }],
    ["redirect", { ok: true, status: 302, id: "not-confirmed" }],
    ["no identity", { ok: true, status: 201, data: { name: "No target", title: "No target", status: "saved", companyId: "company" } }],
    ["empty identity", { ok: true, status: 200, data: { id: "", key: null, identifier: {}, number: null } }],
    ["21 element bulk", { ok: true, status: 200, data: Array.from({ length: 21 }, (_, i) => ({ id: `saved-${i}` })) }],
    ["bulk element missing identity", { ok: true, status: 200, data: [{ id: "saved" }, { title: "Unfindable" }] }],
  ])("keeps the entire %s write result, including errors and guidance", (_name, candidate) => {
    const { original, retained, result } = receiptBudgetRow(candidate as Record<string, unknown>);
    expect(result).toEqual(original.completedActions![0]!.result);
    expect(result).not.toHaveProperty("resultOmittedForSize");
    expect(result).not.toHaveProperty("note");
    expect(retained.completedActions![1]!.result).toMatchObject({ resultOmittedForSize: true,
      note: "Result omitted for size; the write succeeded. Re-read the target by its id if needed." });
  });
  it.each([
    ["top-level id", { ok: true, status: 200, id: "saved" }, { id: "saved" }],
    ["2xx upper edge", { ok: true, status: 299, data: { id: "saved", key: "saved" } }, { data: { id: "saved", key: "saved" } }],
    ["number zero", { ok: true, status: 201, data: { id: "saved", number: 0 } }, { data: { id: "saved", number: 0 } }],
    ["nested identities", { ok: true, status: 201, data: { id: "saved", comment: { id: "comment", body: "omitted" }, issue: { identifier: "RESOURCE-1" } } },
      { data: { id: "saved", comment: { id: "comment" }, issue: { identifier: "RESOURCE-1" } } }],
    ["20 element bulk", { ok: true, status: 200, data: Array.from({ length: 20 }, (_, i) => ({ id: `saved-${i}`, body: "omitted" })) },
      { data: Array.from({ length: 20 }, (_, i) => ({ id: `saved-${i}` })) }],
    ["document revision", { ok: true, status: 200, data: { id: "document", issueId: "issue", key: "plan", latestRevisionId: "revision", latestRevisionNumber: 3 } },
      { data: { id: "document", issueId: "issue", key: "plan", latestRevisionId: "revision", latestRevisionNumber: 3 } }],
    ["artifact", { ok: true, status: 201, artifact: { artifactId: "asset", url: "/api/assets/asset/content", byteSize: 400000, sha256: "a".repeat(64) },
      guidance: "Read the saved artifact; do not repeat this mutation." },
      { artifact: { artifactId: "asset", url: "/api/assets/asset/content", byteSize: 400000, sha256: "a".repeat(64) },
        guidance: "Read the saved artifact; do not repeat this mutation." }],
  ])("shortens a successful %s write while keeping its target and exact note", (_name, candidate, identity) => {
    const { original, retained, result } = receiptBudgetRow(candidate as Record<string, unknown>);
    expect(result).toMatchObject({ ...identity, resultOmittedForSize: true,
      note: "Result omitted for size; the write succeeded. Re-read the target by its id if needed.",
      resultSha256: `sha256:${createHash("sha256").update(JSON.stringify(original.completedActions![0]!.result)).digest("hex")}` });
    expect(result).not.toHaveProperty("padding");
    expect(retained.completedActions![1]).toEqual(original.completedActions![1]);
    if (_name === "nested identities" || _name === "20 element bulk") expect(JSON.stringify(result)).not.toContain('"body"');
  });
  it("refuses by name rather than shortening an irreducible failed write", () => {
    const c = shape(3, 100);
    c.completedActions = [{ runId: "old-run", receiptId: "failed", operationId: "POST /api/issues/{id}/comments",
      result: { ok: false, status: 422, data: { id: "refused", body: "x".repeat(400000) }, error: "validation" } }];
    expect(() => prepare(c)).toThrow(expect.objectContaining({ code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND }));
  });
  it("preserves small write and unknown receipts and counts only shortened results", () => {
    const c = shape(30, 400000, 2);
    Object.assign(c.coverage, { omittedCompletedActions: 3 });
    c.completedActions!.push({ runId: "r", receiptId: "write", operationId: "POST /api/issues/{id}/comments", result: { id: "saved", contentOmitted: true } },
      { runId: "r", receiptId: "unknown", operationId: "unknown GET", result: { marker: "do not repeat", text: "u".repeat(10000) } });
    const { retained } = prepare(c);
    expect(retained.completedActions!.slice(-2)).toEqual(c.completedActions!.slice(-2));
    expect(retained.completedActions![0]!.result).toMatchObject({ resultOmittedForSize: true, resultSha256: expect.stringMatching(/^sha256:/) });
    expect(retained.coverage).toMatchObject({ shortenedCompletedActions: 2, omittedCompletedActions: 3 });
  });
  it("never cuts unread, new, or edited-after-last-run messages; refuses an irreducible known prompt", () => {
    const c = shape(10, 690000);
    for (const extra of [{ continuationReadState: { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: [] } },
      { continuationReadState: { lastRunAt: "2025-01-01T00:00:00Z", readCommentIds: c.messages.map(m => m.id) } },
      { taskPrompt: "x".repeat(600000) }]) expect(() => prepare(c, extra)).toThrow(NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND);
    for (const message of c.messages) message.updatedAt = "2026-01-03T00:00:00Z";
    expect(() => prepare(c)).toThrow(NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND);
  });
  it("counts both escaping passes and UTF-8 in multibyte, escape-heavy history", () => {
    const c = shape(50, 300000);
    for (const m of c.messages.slice(1, -1)) m.body = '"\\\n日本語🦖'.repeat(2200);
    const { input } = prepare(c);
    const envelope = buildNativeModelEnvelope(input);
    const actual = Buffer.byteLength(JSON.stringify({ payload: { text: JSON.stringify(envelope) } }));
    expect(actual).toBe(commandEnvelopeBytes(envelope) + Buffer.byteLength('{"payload":{"text":""}}'));
    expect(commandEnvelopeBytes(envelope)).toBeLessThanOrEqual(NATIVE_TURN_KNOWN_MAX_BYTES);
  });
});

describe("follow-up context size", () => {
  it("keeps old messages out of resume deltas while retaining scoped human answers", () => {
    const message = (id: string, body: string) => ({
      id, body, authorType: "user", authorId: "board", createdAt: "2026-09-17T00:00:00Z",
      updatedAt: "2026-09-17T00:00:00Z", deleted: false, sourceTrust: null,
    });
    const oldBody = "PREVIOUS_TASK_TEXT ".repeat(1000);
    const newBody = "Actually, save the plan first.";
    const answerText = "No budget. Wait for my approval.";
    const continuation: ExecutionContinuationEnvelope = {
      version: 1, companyId: "company", issueId: "issue", objective: "Welcome",
      trigger: { reason: "issue_commented", interactionId: "answer-id", sourceRunId: null },
      originCommentIds: ["new"], messages: [message("old", oldBody), message("new", newBody)],
      resumeDelta: { baseRunId: "previous-run", messages: [message("new", newBody)] },
      humanResponses: [{ id: "answer-id", kind: "ask_user_questions", status: "answered",
        resolvedByUserId: "board", resolvedAt: "2026-09-17T00:01:00Z",
        result: { answers: [{ questionId: "scope", optionIds: [], otherText: answerText }] } }],
      interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: "new", summaryThroughCommentId: null },
    };
    const wake = { executionContinuation: continuation };
    const fresh = renderPaperclipWakePrompt(wake);
    const resumed = renderPaperclipWakePrompt(wake, { resumedSession: true });
    const contract = buildNativeCompletionContract({ title: "Welcome", description: oldBody }, {
      immediateRequest: newBody, humanResponseId: "answer-id",
    });
    expect(fresh).toContain(oldBody);
    expect(resumed).not.toContain("PREVIOUS_TASK_TEXT");
    expect(resumed.split(newBody)).toHaveLength(2);
    expect(resumed.split(answerText)).toHaveLength(2);
    expect(resumed).toContain("earlier history remains in this session");
    expect(JSON.stringify(contract)).not.toContain(oldBody);
    expect(JSON.stringify(contract)).not.toContain(answerText);
    expect(resumed.length + JSON.stringify(contract).length).toBeLessThan(fresh.length);
  });
});


describe("native completion references", () => {
  const source = nativeCompletionSource("description", "task", "Repeat. Repeat.");
  const args: Parameters<typeof buildNativeExecutionInput>[0] = {
    companyId: "company", runId: "run", agentId: "agent",
    issue: { id: "task", identifier: "PAP-1", title: "Brief", description: "Repeat. Repeat.", workMode: "standard" },
    taskPrompt: "Issue description:\nRepeat. Repeat.",
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: null,
    runtimeContext: nativeRuntimeContextFixture(),
    completionContract: {
      id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Brief", criteria: [{ id: "objective", requirement: "Repeat. Repeat." }] },
      sources: [{ id: "objective", source }],
    },
  };
  it("binds only source identities and revisions attested by the task renderer", () => {
    const input = buildNativeExecutionInput({ ...args, turnContext: {
      version: 1,
      assignment: { owner: "task_markdown", description: { id: source.id, revision: source.revision } },
      events: { owner: "wake_prompt", comments: [] },
    } });
    expect(input.completionSources).toMatchObject({ contractRevision: "1", criteria: [{ id: "objective", source }] });
    expect(input.completionContract.contract).toEqual(args.completionContract.contract);
    expect(input.task.description).toBe("Repeat. Repeat.");
  });
  it.each([
    undefined,
    { version: 1, assignment: { owner: "task_markdown", description: { id: "another-task", revision: source.revision } } },
    { version: 1, assignment: { owner: "task_markdown", description: { id: source.id, revision: "stale" } } },
  ])("keeps the full requirement when provenance is absent or stale", (turnContext) => {
    const input = buildNativeExecutionInput({ ...args, turnContext });
    expect(input.completionSources).toBeUndefined();
    expect(input.completionContract.contract).toEqual(args.completionContract.contract);
  });
});


describe("Cursor mode native execution projection", () => {
  function fixture(acpxSessionMode?: "agent" | "plan" | "ask") {
    return {
      companyId: "company-1", runId: "run-1", agentId: "agent-1",
      issue: { id: "issue-1", identifier: "MODE-1", title: "Review a plan", description: null, workMode: "standard" },
      taskPrompt: "Review the project.",
      workspace: { id: "workspace-1", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: null, provider: "acpx" as const, acpxAgent: "cursor" as const,
      model: "exact-cursor-model", acpxSessionMode, acpxPermissionMode: "deny-all" as const,
      completionContract: { id: "contract-1", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Review", criteria: [{ id: "output", requirement: "Review" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    };
  }
  it.each([undefined, "agent", "plan", "ask"] as const)("preserves mode %s independently of permissions and task planning", mode => {
    const result = buildNativeExecutionInput(fixture(mode));
    expect(result.provider).toMatchObject({ kind: "acpx", agent: "cursor", mode: mode ?? "agent", permissionMode: "deny-all" });
    expect(result.executionMode).toBe("default");
    expect(result.task.workMode).toBe("standard");
  });
  it("rejects a Cursor mode attached to another harness", () => {
    expect(() => buildNativeExecutionInput({ ...fixture("plan"), acpxAgent: "copilot" })).toThrow("only for Cursor");
  });
});

describe("Pi thinking native execution projection", () => {
  function fixture(piThinkingLevel?: "off" | "low" | "high" | "max") {
    return {
      companyId: "company-1", runId: "run-1", agentId: "agent-1",
      issue: { id: "issue-1", identifier: "MODE-1", title: "Review a plan", description: null, workMode: "standard" },
      taskPrompt: "Review the project.",
      workspace: { id: "workspace-1", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: null, provider: "acpx" as const, acpxAgent: "pi" as const,
      model: "openrouter/deepseek/deepseek-v4-flash-0731", piThinkingLevel, acpxPermissionMode: "deny-all" as const,
      completionContract: { id: "contract-1", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Review", criteria: [{ id: "output", requirement: "Review" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    };
  }
  it.each([undefined, "off", "low", "high", "max"] as const)("preserves mode %s independently of permissions and task planning", mode => {
    const result = buildNativeExecutionInput(fixture(mode));
    expect(result.provider).toMatchObject({ kind: "acpx", agent: "pi", piThinkingLevel: mode ?? "low", permissionMode: "deny-all" });
    expect(result.executionMode).toBe("default");
    expect(result.task.workMode).toBe("standard");
  });
  it.each([undefined, "continuous", "paperclip"] as const)("stores only non-default Pi RPC continuity %s independently of Agent Chat", sessionContinuity => {
    for (const conversationMode of [false, true]) {
      const f = fixture();
      const result = buildNativeExecutionInput({ ...f, provider: "pi_rpc", acpxAgent: undefined,
        piThinkingLevel: undefined, piRpcThinkingLevel: "low", sessionContinuity, conversationMode,
        issue: { ...f.issue, conversationAgentId: conversationMode ? f.agentId : null } });
      const parsed = parseNativeExecutionInput(result);
      expect(parsed.provider).toMatchObject({ kind: "pi_rpc", piRpcThinkingLevel: "low" });
      for (const provider of [result.provider, parsed.provider]) {
        if (sessionContinuity === "paperclip") expect(provider).toHaveProperty("sessionContinuity", "paperclip");
        else expect(provider).not.toHaveProperty("sessionContinuity");
      }
      if (conversationMode) expect(result.provider).toHaveProperty("conversationMode", true);
      else expect(result.provider).not.toHaveProperty("conversationMode");
      const legacy = { ...result, provider: { ...result.provider, sessionContinuity: undefined } };
      expect(parseNativeExecutionInput(legacy).provider).not.toHaveProperty("sessionContinuity");
      expect(() => parseNativeExecutionInput({ ...result, provider: { ...result.provider, sessionContinuity: "invalid" } }))
        .toThrow("input.provider.sessionContinuity must be continuous or paperclip");
    }
  });
  it("rejects a Pi thinking level attached to another harness", () => {
    expect(() => buildNativeExecutionInput({ ...fixture("low"), acpxAgent: "copilot" })).toThrow("only for Pi");
  });
});


describe("Claude effort and master home-mode compatibility", () => {
  it.each([
    ["isolated", undefined, "v5"], ["preconfigured", undefined, "v7"],
    ["isolated", "high", "v9"], ["preconfigured", "high", "v9"],
  ] as const)("retains %s home mode with effort %s in %s", (homeMode, claudeEffort, version) => {
    const value = buildNativeExecutionInput({
      companyId: "company", runId: "run", agentId: "agent",
      issue: { id: "issue", identifier: "CLA-1", title: "Useful output", description: null, workMode: "standard" },
      taskPrompt: "Create the requested file.",
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: null, provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5",
      acpxPermissionMode: "approve-all", homeMode, claudeEffort,
      completionContract: { id: "contract", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Create a file", criteria: [{ id: "output", requirement: "Create the file" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(value.schema).toBe(`paperclip.native-execution-input.${version}`);
    if (version !== "v5") expect(value).toHaveProperty("homeMode", homeMode);
    if (claudeEffort) expect(value.provider).toHaveProperty("claudeEffort", claudeEffort);
    expect(JSON.stringify(buildNativeModelEnvelope(value))).not.toContain("claudeEffort");
  });
  it.each([
    ["isolated", undefined, undefined, "v5"], ["isolated", "high", true, "v10"], ["isolated", undefined, false, "v10"],
  ] as const)("retains %s home mode with effort %s and search policy %s in %s", (homeMode, grokEffort, grokDisableWebSearch, version) => {
    const value = buildNativeExecutionInput({
      companyId: "company", runId: "run", agentId: "agent",
      issue: { id: "issue", identifier: "CLA-1", title: "Useful output", description: null, workMode: "standard" },
      taskPrompt: "Create the requested file.",
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: null, provider: "acpx", acpxAgent: "grok", model: "grok-4.7",
      acpxPermissionMode: "approve-all", homeMode, grokEffort, grokDisableWebSearch,
      completionContract: { id: "contract", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Create a file", criteria: [{ id: "output", requirement: "Create the file" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(value.schema).toBe(`paperclip.native-execution-input.${version}`);
    if (version !== "v5") expect(value).toHaveProperty("homeMode", homeMode);
    if (grokEffort) expect(value.provider).toHaveProperty("grokEffort", grokEffort);
    if (grokDisableWebSearch !== undefined) expect(value.provider).toHaveProperty("grokDisableWebSearch", grokDisableWebSearch);
    expect(JSON.stringify(buildNativeModelEnvelope(value))).not.toContain("grokEffort");
  });
});
