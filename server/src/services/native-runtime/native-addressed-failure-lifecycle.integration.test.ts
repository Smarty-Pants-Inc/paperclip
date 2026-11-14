import { documentService } from "../documents.js";
import { isIssueReviewVerdictInteraction } from "../issue-review-policy.js";
import { decideNativeAddressedInteractionGrant } from "./native-addressed-interaction.js";
import { nativeSessionFailureSourceCode } from "./native-session-executor.js";
import { NATIVE_ADDRESSED_INTERACTION_FAILURE_ACTION } from "./native-addressed-interaction-failure.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  authUsers,
  companyMemberships,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../issues.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { stageNativeRunnerWakeAttachments, renderNativeRunnerStagedAttachmentPrompt } from "./native-runner-file-handoff.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import {
  appendNativeAddressedInteractionFailureNotice,
  NATIVE_ADDRESSED_INTERACTION_FAILED,
  NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE,
} from "./native-addressed-interaction-failure.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { NativeAddressedInteractionAdmissionError, requireNativeAddressedInteractionGrant } from "./native-addressed-interaction.js";

const companyId = randomUUID();
const ownerAgentId = randomUUID();
const responderAgentId = randomUUID();
const humanUserId = randomUUID();

type Fixture = {
  issueId: string;
  runId: string;
  ownerRunId: string;
  execution: NativeExecutionInputV1;
  runnerInstanceId: string;
  runContextSnapshot: Record<string, unknown>;
  workspaceRoot: string;
  issueBefore: typeof issues.$inferSelect;
  ownerRunBefore: typeof heartbeatRuns.$inferSelect;
  interactionId: string | null;
};

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let home: ReturnType<typeof createIsolatedTestHome>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  home = createIsolatedTestHome();
  vi.stubEnv("PAPERCLIP_HOME", home.home);
  temporary = await startEmbeddedPostgresTestDatabase("native-addressed-lifecycle-");
  db = createDb(temporary.connectionString, { maxConnections: 6 });
  await db.insert(companies).values({ id: companyId, name: "Addressed lifecycle regression", issuePrefix: "NAL" });
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: "KA", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model" } },
    { id: responderAgentId, companyId, name: "KP", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model" } },
  ]);
  await db.insert(companyMemberships).values([ownerAgentId, responderAgentId].map(principalId => ({
    companyId, principalType: "agent", principalId, membershipRole: "member", status: "active",
  })));
  await db.insert(authUsers).values({
    id: humanUserId, name: "Human resolver", email: `${humanUserId}@example.test`,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(companyMemberships).values({
    companyId, principalType: "user", principalId: humanUserId, membershipRole: "owner", status: "active",
  });
}, 120_000);

afterAll(async () => {
  try {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  } finally {
    vi.unstubAllEnvs();
    home?.cleanup();
  }
});

async function fixture(role: "addressed" | "assignee", withAttachment = false, options: {
  reviewPolicy?: "not_creator";
  issueStatus?: "in_progress" | "in_review";
  target?: {
    type: "issue_document";
    issueId?: string;
    documentId: string;
    key: string;
    revisionId: string;
    revisionNumber: number;
    label?: string;
  };
} = {}): Promise<Fixture> {
  const issueId = randomUUID();
  const runId = randomUUID();
  const ownerRunId = randomUUID();
  const workspaceRoot = path.join(home.home, "workspace", runId);
  await mkdir(workspaceRoot, { recursive: true });
  const addressed = role === "addressed";
  const contextSnapshot: Record<string, unknown> = { issueId };
  const [issue] = await db.insert(issues).values({
    id: issueId,
    companyId,
    title: addressed ? "Respond to an addressed confirmation" : "Continue the assigned task",
    status: options.issueStatus ?? "in_progress",
    ...(options.reviewPolicy ? { reviewPolicy: options.reviewPolicy } : {}),
    workMode: "standard",
    assigneeAgentId: addressed ? ownerAgentId : responderAgentId,
    createdByAgentId: ownerAgentId,
  }).returning();
  await db.insert(heartbeatRuns).values({
    id: ownerRunId,
    companyId,
    agentId: ownerAgentId,
    status: "running",
    runtimeMode: "native",
    nativeIssueId: issueId,
    issueId,
    scopeKind: "issue",
    contextSnapshot: { issueId },
  });
  let interactionId: string | null = null;
  if (addressed) {
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      addresseeAgentId: responderAgentId,
      createdByAgentId: ownerAgentId,
      sourceRunId: ownerRunId,
      continuationPolicy: "none",
      requestedResolverPolicy: "not_creator",
      effectiveResolverPolicy: "not_creator",
      resolverPolicyProvenance: "explicit",
      payload: {
        version: 1,
        prompt: "Confirm the requested response.",
        ...(options.target ? { target: { ...options.target, issueId: options.target.issueId ?? issueId } } : {}),
      },
    }).returning();
    interactionId = interaction.id;
    Object.assign(contextSnapshot, {
      taskId: issueId,
      sourceRunId: ownerRunId,
      interactionId,
      wakeReason: "interaction_pending",
      source: "issue.interaction.created",
    });
  }
  const [run] = await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId: responderAgentId,
    status: "running",
    runtimeMode: "native",
    nativeIssueId: issueId,
    issueId,
    scopeKind: "issue",
    invocationSource: "assignment",
    triggerDetail: "system",
    contextSnapshot,
  }).returning();
  const native = await prepareNativeHeartbeatRun({
    db,
    run,
    issue,
    environmentLeaseId: randomUUID(),
  });
  const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { companyId, runId, issueId, agentId: responderAgentId, executionWorkspaceId: runId },
    provider: { kind: "codex", model: "test-model" },
    task: { identifier: issueId, title: issue.title, description: null, prompt: "Respond to the current task.", workMode: "standard" },
    workspace: { cwd: workspaceRoot, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    completionContract: {
      id: contract.id,
      sha256: contract.canonicalSha256,
      schemaVersion: "paperclip.completion-contract.v1",
      contract: buildNativeCompletionContract(issue, { revision: contract.revision }),
    },
    interactionResponses: [],
    credentialBindings: [],
  };
  const [preparedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  await db.update(heartbeatRuns).set({
    runnerProfileJson: {
      ...(preparedRun.runnerProfileJson ?? {}),
      nativeExecutionInput: execution,
      sessionCheckpoint: { providerSessionId: "fake-provider-session", providerIdentity: { threadId: "fake-provider-thread" } },
    },
  }).where(eq(heartbeatRuns.id, runId));
  await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
  await db.update(issues).set(addressed
    ? { executionRunId: ownerRunId, checkoutRunId: ownerRunId, executionAgentNameKey: "ka", executionLockedAt: new Date() }
    : { executionRunId: runId, checkoutRunId: runId, executionAgentNameKey: "kp", executionLockedAt: new Date() })
    .where(eq(issues.id, issueId));
  if (withAttachment) {
    const storage = createStorageService(createLocalDiskStorageProvider(path.join(home.home, "storage")));
    const comment = await issueService(db).addComment(issueId, "Please inspect the attached confirmation.", { userId: "inbound-user" });
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: "confirmation.txt",
      contentType: "text/plain",
      body: Buffer.from("opaque download cancellation fixture\n"),
    });
    const attachment = await issueService(db).createAttachment({
      issueId,
      issueCommentId: comment.id,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: "inbound-user",
    });
    await db.update(issueThreadInteractions).set({ sourceCommentId: comment.id, originCommentIds: [comment.id] })
      .where(eq(issueThreadInteractions.id, interactionId!));
    expect(await db.select({ id: issueAttachments.id }).from(issueAttachments).where(eq(issueAttachments.id, attachment.id)))
      .toHaveLength(1);
    expect(await db.select({ id: assets.id }).from(assets).where(eq(assets.id, attachment.assetId))).toHaveLength(1);
  }
  const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const [issueBefore] = await db.select().from(issues).where(eq(issues.id, issueId));
  const [ownerRunBefore] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ownerRunId));
  return {
    issueId,
    runId,
    ownerRunId,
    execution,
    runnerInstanceId: native.runnerInstanceId,
    runContextSnapshot: persistedRun.contextSnapshot as Record<string, unknown>,
    workspaceRoot,
    issueBefore,
    ownerRunBefore,
    interactionId,
  };
}

async function executeFailure(input: Fixture, options: {
  failure: unknown;
  prepareAttachmentPrompt?: () => Promise<string>;
}) {
  provider.execute.mockReset().mockImplementation(async raw => {
    const callbacks = raw as { onSession?: unknown; prepareWakeAttachmentPrompt?: () => Promise<unknown> };
    await callbacks.prepareWakeAttachmentPrompt?.();
    throw options.failure;
  });
  await executePaperclipNativeSession({
    db,
    execution: input.execution,
    runContextSnapshot: input.runContextSnapshot,
    runnerInstanceId: input.runnerInstanceId,
    runnerEnvironment: {},
    useRunnerd: false,
    backend: {
      descriptor: async () => { throw new Error("Unexpected fake-provider backend descriptor call"); },
      openSession: async () => { throw new Error("Unexpected fake-provider backend open call"); },
    } as never,
    prepareAttachmentPrompt: options.prepareAttachmentPrompt ?? (async () => ""),
  }).catch(() => undefined);
  expect(provider.execute).toHaveBeenCalledTimes(1);
  const callbacks = provider.execute.mock.calls[0]?.[0] as { onSession?: unknown; prepareWakeAttachmentPrompt?: unknown };
  expect(callbacks.onSession).toEqual(expect.any(Function));
  expect(callbacks.prepareWakeAttachmentPrompt).toEqual(expect.any(Function));
}

async function executeWithoutProvider(input: Fixture) {
  provider.execute.mockReset();
  await expect(executePaperclipNativeSession({
    db,
    execution: input.execution,
    runContextSnapshot: input.runContextSnapshot,
    runnerInstanceId: input.runnerInstanceId,
    runnerEnvironment: {},
    useRunnerd: true,
    prepareAttachmentPrompt: async () => "",
  })).rejects.toBeInstanceOf(NativeAddressedInteractionAdmissionError);
  expect(provider.execute).not.toHaveBeenCalled();
}

async function settled(input: Fixture) {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId));
  return { run, coordinator };
}

async function expectHeldOwnerUnchanged(input: Fixture) {
  const [issueAfter] = await db.select().from(issues).where(eq(issues.id, input.issueId));
  const [ownerRunAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.ownerRunId));
  expect(issueAfter).toEqual(input.issueBefore);
  expect(ownerRunAfter).toEqual(input.ownerRunBefore);
}

describe("native addressed failure lifecycle through the executor and PostgreSQL", () => {
  it.each([
    { label: "provider Error", failure: new Error("provider_stdout_closed") },
    { label: "non-Error provider rejection", failure: { reason: "provider disconnected" } },
  ])("settles a pending addressed response as terminal after $label", async ({ failure }) => {
    const input = await fixture("addressed");
    const [initialRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    const [initialCoordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId));
    expect(initialRun.status).toBe("running");
    expect(initialCoordinator).toMatchObject({ phase: "observed", attempt: 0 });
    expect(initialRun.contextSnapshot).toEqual(input.runContextSnapshot);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!)))
      .toEqual([expect.objectContaining({ status: "pending" })]);
    await expectHeldOwnerUnchanged(input);

    await executeFailure(input, { failure });

    const { run, coordinator } = await settled(input);
    expect(coordinator).toMatchObject({
      phase: "terminal_failure",
      failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED,
      nextAttemptAt: null,
      leaseOwner: null,
      recoveryState: null,
    });
    expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: NATIVE_ADDRESSED_INTERACTION_FAILED });
    const notices = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.createdByRunId, input.runId), eq(issueComments.authorType, "system"),
    ));
    expect(notices).toEqual([expect.objectContaining({ body: NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE })]);
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.addressed_interaction_failed"),
      eq(activityLog.entityId, input.issueId),
    ));
    expect(audits).toHaveLength(1);
    await expectHeldOwnerUnchanged(input);
  }, 120_000);

  it("terminalizes an unavailable issue-document refusal on an in-review addressed card once per card and reason", async () => {
    const input = await fixture("addressed", false, {
      issueStatus: "in_review",
      target: {
        type: "issue_document",
        documentId: randomUUID(),
        key: "status-brief",
        revisionId: randomUUID(),
        revisionNumber: 2,
        label: "Status brief",
      },
    });
    const [cardBefore] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
    expect(input.issueBefore).toMatchObject({ status: "in_review", createdByAgentId: ownerAgentId, assigneeAgentId: ownerAgentId });
    expect(input.ownerRunBefore).toMatchObject({ status: "running", agentId: ownerAgentId });
    expect(input.runContextSnapshot).toMatchObject({ sourceRunId: input.ownerRunId, interactionId: input.interactionId });
    expect(cardBefore).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: ownerAgentId,
      addresseeAgentId: responderAgentId,
      sourceRunId: input.ownerRunId,
      payload: { target: { type: "issue_document", issueId: input.issueId, key: "status-brief" } },
    });
    expect(input.execution.binding.agentId).toBe(responderAgentId);
    await expectHeldOwnerUnchanged(input);

    await executeWithoutProvider(input);

    const { run, coordinator } = await settled(input);
    expect(coordinator).toMatchObject({
      phase: "terminal_failure",
      failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED,
      nextAttemptAt: null,
      leaseOwner: null,
      recoveryState: null,
    });
    expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: NATIVE_ADDRESSED_INTERACTION_FAILED });
    const [pendingCard] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
    expect(pendingCard).toMatchObject({ status: "pending" });
    await expectHeldOwnerUnchanged(input);

    const cardFailureKey = `native-addressed-failure:${input.interactionId}:reason:target`;
    const readFailureNotice = () => db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorType, "system"), eq(issueComments.clientRequestId, cardFailureKey),
    ));
    const notices = await readFailureNotice();
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice.body).toMatch(/KP/i);
    expect(notice.body).toMatch(/document/i);
    expect(notice.body).toMatch(/unavailable|not available|missing|stale|no longer current|cannot be found|could not be found|does not exist|does not support|not supported/i);
    expect(notice.body).toMatch(/answer/i);
    expect(notice.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
    const metadataRows = ((notice.metadata as { sections?: Array<{ rows?: Array<Record<string, unknown>> }> } | null)?.sections ?? [])
      .flatMap(section => section.rows ?? []);
    expect(metadataRows).toEqual(expect.arrayContaining([
      { type: "agent_link", label: "Recovery owner", agentId: ownerAgentId, name: "KA" },
      expect.objectContaining({ type: "key_value", label: "Next action", value: expect.stringMatching(/answer/i) }),
    ]));

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId: responderAgentId,
      scopeKind: "issue",
      issueId: input.issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "native",
      nativeIssueId: input.issueId,
      contextSnapshot: input.runContextSnapshot,
    });
    const secondBinding = { companyId, issueId: input.issueId, agentId: responderAgentId, runId: secondRunId };
    const secondError = await requireNativeAddressedInteractionGrant(db, secondBinding).then(
      () => { throw new Error("expected_second_admission_refusal"); }, error => error as unknown,
    );
    expect(secondError).toBeInstanceOf(NativeAddressedInteractionAdmissionError);
    expect(secondError).toMatchObject({ binding: secondBinding, refusal: { reason: "target", interactionId: input.interactionId } });
    await db.update(heartbeatRuns).set({ status: "failed", nativePhase: "terminal_failure",
      errorCode: NATIVE_ADDRESSED_INTERACTION_FAILED, finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, secondRunId));
    await db.insert(nativeRunFinalizations).values({
      runId: secondRunId,
      companyId,
      issueId: input.issueId,
      phase: "terminal_failure",
      failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED,
      nextAttemptAt: null,
    });
    await expect(appendNativeAddressedInteractionFailureNotice(db, secondBinding, input.interactionId!, secondError))
      .resolves.toBeNull();
    expect(await readFailureNotice()).toHaveLength(1);
  }, 120_000);

  it("reports a paused addressed responder and leaves the pending card human-resolvable", async () => {
    const input = await fixture("addressed");
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, responderAgentId));
    try {
      await executeWithoutProvider(input);

      const { run, coordinator } = await settled(input);
      expect(coordinator).toMatchObject({
        phase: "terminal_failure",
        failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED,
        nextAttemptAt: null,
        leaseOwner: null,
        recoveryState: null,
      });
      expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: NATIVE_ADDRESSED_INTERACTION_FAILED });
      const [pendingCard] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
      expect(pendingCard).toMatchObject({ status: "pending", addresseeAgentId: responderAgentId, createdByAgentId: ownerAgentId });
      await expectHeldOwnerUnchanged(input);

      const [notice] = await db.select().from(issueComments).where(and(
        eq(issueComments.companyId, companyId), eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorType, "system"),
        eq(issueComments.clientRequestId, `native-addressed-failure:${input.interactionId}:reason:agent_status:paused`),
      ));
      expect(notice.body).toMatch(/KP/i);
      expect(notice.body).toMatch(/paused/i);
      expect(notice.body).toMatch(/resume/i);
      expect(notice.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
      const metadataRows = ((notice.metadata as { sections?: Array<{ rows?: Array<Record<string, unknown>> }> } | null)?.sections ?? [])
        .flatMap(section => section.rows ?? []);
      expect(metadataRows).toEqual(expect.arrayContaining([
        { type: "agent_link", label: "Recovery owner", agentId: ownerAgentId, name: "KA" },
        expect.objectContaining({ type: "key_value", label: "Next action", value: expect.stringMatching(/resume/i) }),
      ]));

      const resolved = await issueThreadInteractionService(db).acceptInteraction({
        id: input.issueId, companyId, projectId: null, goalId: null, status: input.issueBefore.status,
      }, input.interactionId!, {}, { userId: humanUserId });
      expect(resolved.interaction).toMatchObject({ status: "accepted", resolvedByUserId: humanUserId });
      const [humanResolvedCard] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
      expect(humanResolvedCard).toMatchObject({ status: "accepted", resolvedByUserId: humanUserId });
    } finally {
      await db.update(agents).set({ status: "active" }).where(eq(agents.id, responderAgentId));
    }
  }, 120_000);

  it("settles an F2 opaque-download cancellation through the executor without publishing a pending notice", async () => {
    const input = await fixture("addressed", true);
    const [cardBefore] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
    expect(cardBefore.status).toBe("pending");
    const storage = createStorageService(createLocalDiskStorageProvider(path.join(home.home, "storage")));
    let downloads = 0;
    let storageReads = 0;
    let stagingFailure: unknown;
    const observingStorage = {
      ...storage,
      getObject: (...args: Parameters<typeof storage.getObject>) => {
        storageReads++;
        return storage.getObject(...args);
      },
    };
    const prepareAttachmentPrompt = async () => {
      try {
        const stage = await stageNativeRunnerWakeAttachments({
          db,
          binding: {
            companyId,
            issueId: input.issueId,
            runId: input.runId,
            agentId: responderAgentId,
            workspaceRoot: input.workspaceRoot,
            executionTargetKind: "local",
          },
          storage: observingStorage,
          downloadRemoteAttachment: async source => {
            downloads++;
            expect(source).toMatchObject({ attachmentId: expect.any(String), kind: "wake" });
            await db.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: new Date() })
              .where(eq(issueThreadInteractions.id, input.interactionId!));
            return "/runner/download-cache/opaque-confirmation.txt";
          },
        });
        try {
          return renderNativeRunnerStagedAttachmentPrompt(stage.attachments);
        } finally {
          await stage.cleanup();
        }
      } catch (error) {
        stagingFailure = error;
        throw error;
      }
    };
    await executeFailure(input, { failure: new Error("provider_stdout_closed"), prepareAttachmentPrompt });

    expect(downloads).toBe(1);
    expect(storageReads).toBe(0);
    expect(stagingFailure).toMatchObject({ message: "paperclip_runner_attachment_staging_not_authorized" });
    const { run, coordinator } = await settled(input);
    expect(coordinator).toMatchObject({
      phase: "terminal_failure",
      failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED,
      nextAttemptAt: null,
      leaseOwner: null,
      recoveryState: null,
    });
    expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: NATIVE_ADDRESSED_INTERACTION_FAILED });
    const [cancelled] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
    expect(cancelled).toMatchObject({ status: "cancelled" });
    const notices = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.createdByRunId, input.runId), eq(issueComments.authorType, "system"),
    ));
    expect(notices).toEqual([]);
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.addressed_interaction_failed"),
      eq(activityLog.entityId, input.issueId),
    ));
    expect(audits).toEqual([]);
    await expectHeldOwnerUnchanged(input);
  }, 120_000);

  it("keeps an ordinary assignee interruption retryable with its actual claim and retry date", async () => {
    const input = await fixture("assignee");
    await executeFailure(input, { failure: new Error("provider_stdout_closed") });

    const { run, coordinator } = await settled(input);
    expect(coordinator).toMatchObject({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      recoveryState: "resuming_session",
      leaseOwner: null,
      nextAttemptAt: expect.any(Date),
    });
    expect((coordinator.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(coordinator.failureDetail).toMatchObject({ recoveryMode: "exact_checkpoint_resume" });
    expect(run.errorCode).toBe("provider_stdout_closed");
    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    expect(issueAfter).toMatchObject({
      status: "in_progress",
      assigneeAgentId: responderAgentId,
      executionRunId: input.runId,
      checkoutRunId: input.runId,
    });
  }, 120_000);
});

type M14AddressedProviderFailureCase = {
  label: string;
  issueStatus: "in_progress" | "in_review";
  documentTarget: boolean;
};

type M14CurrentDocumentTarget = {
  type: "issue_document";
  issueId: string;
  documentId: string;
  key: string;
  revisionId: string;
  revisionNumber: number;
  label: string;
};

const m14AddressedProviderFailureCases: M14AddressedProviderFailureCase[] = [
  { label: "ordinary in_progress / null target (W1 counterexample)", issueStatus: "in_progress", documentTarget: false },
  { label: "ordinary in_progress / current document (W1 counterexample)", issueStatus: "in_progress", documentTarget: true },
  { label: "review verdict in_review / null target (M1.4 regression)", issueStatus: "in_review", documentTarget: false },
  { label: "review verdict in_review / current document (M1.4 regression)", issueStatus: "in_review", documentTarget: true },
];

describe("M1.4 addressed provider failures must never silently strand a review-verdict card", () => {
  // Keep reason: a trust-boundary failure must be visible without granting a verdict or stealing KA's execution.
  it.each(m14AddressedProviderFailureCases)("publishes one owner-facing failure notice: $label", async ({ issueStatus, documentTarget }: M14AddressedProviderFailureCase) => {
    const input = await fixture("addressed", false, { issueStatus, reviewPolicy: "not_creator" });
    const payloadCanary = "W1-M14-PRIVATE-CARD-PAYLOAD-CANARY";
    const providerCanary = "W1-M14-PRIVATE-PROVIDER-RAW-CANARY";

    let target: M14CurrentDocumentTarget | null = null;
    if (documentTarget) {
      const { document } = await documentService(db).upsertIssueDocument({
        issueId: input.issueId,
        key: "m14-review-brief",
        title: "M14 current review brief",
        format: "markdown",
        body: "Current same-issue review evidence.",
        createdByAgentId: ownerAgentId,
        createdByRunId: input.ownerRunId,
      });
      expect(document).toMatchObject({ issueId: input.issueId, createdByAgentId: ownerAgentId });
      expect(document.latestRevisionId).toEqual(expect.any(String));
      target = {
        type: "issue_document",
        issueId: input.issueId,
        documentId: document.id,
        key: document.key,
        revisionId: document.latestRevisionId!,
        revisionNumber: document.latestRevisionNumber,
        label: payloadCanary,
      };
      const current = await documentService(db).getIssueDocumentByKey(input.issueId, target.key);
      expect(current).toMatchObject({
        id: target.documentId, issueId: input.issueId, key: "m14-review-brief",
        latestRevisionId: target.revisionId, latestRevisionNumber: target.revisionNumber,
      });
      const revision = await documentService(db).getIssueDocumentRevision(input.issueId, target.key, target.revisionId);
      expect(revision).toMatchObject({
        id: target.revisionId, documentId: target.documentId, issueId: input.issueId,
        createdByAgentId: ownerAgentId, createdByRunId: input.ownerRunId, isLatest: true,
      });
    }
    await db.update(issueThreadInteractions).set({ payload: {
      version: 1, prompt: payloadCanary, ...(target ? { target } : {}),
    } }).where(eq(issueThreadInteractions.id, input.interactionId!));

    // Document/service setup may notify recovery; snapshot only after all setup writes.
    const [issueBefore] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    input.issueBefore = issueBefore;
    const [cardBefore] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
    expect(issueBefore).toMatchObject({
      status: issueStatus, reviewPolicy: "not_creator", createdByAgentId: ownerAgentId,
      assigneeAgentId: ownerAgentId, executionRunId: input.ownerRunId, checkoutRunId: input.ownerRunId,
      executionAgentNameKey: "ka", executionLockedAt: expect.any(Date),
    });
    expect(input.ownerRunBefore).toMatchObject({ companyId, agentId: ownerAgentId, status: "running" });
    expect(cardBefore).toMatchObject({
      companyId, issueId: input.issueId, kind: "request_confirmation", status: "pending",
      createdByAgentId: ownerAgentId, sourceRunId: input.ownerRunId, addresseeAgentId: responderAgentId,
      requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator",
      resolvedAt: null, resolvedByAgentId: null, resolvedByUserId: null, resolvedByRunId: null, result: null,
    });
    expect((cardBefore.payload as { target?: unknown }).target ?? null).toEqual(target);
    expect(input.runContextSnapshot).toMatchObject({
      issueId: input.issueId, taskId: input.issueId, sourceRunId: input.ownerRunId,
      interactionId: input.interactionId, wakeReason: "interaction_pending",
    });
    expect(input.runContextSnapshot.nativeReviewDecisionId).toBeUndefined();
    expect(input.runContextSnapshot.nativeReviewInteractionId).toBeUndefined();
    if (issueStatus === "in_review") {
      expect(await isIssueReviewVerdictInteraction(db, { issue: issueBefore, interaction: cardBefore })).toBe(true);
    }
    const [responder] = await db.select().from(agents).where(eq(agents.id, responderAgentId));
    expect(responder).toMatchObject({ companyId, name: "KP", status: "active" });
    expect(responderAgentId).not.toBe(issueBefore.assigneeAgentId);
    const [membership] = await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "agent"),
      eq(companyMemberships.principalId, responderAgentId),
    ));
    expect(membership).toMatchObject({ status: "active", membershipRole: "member" });
    const binding = { companyId, issueId: input.issueId, agentId: responderAgentId, runId: input.runId };
    expect(input.execution.binding).toMatchObject(binding);
    // Real authorization includes issue read/mutate scope, review policy, source provenance, and the exact target.
    expect(await decideNativeAddressedInteractionGrant(db, binding)).toMatchObject({
      allowed: true, grant: { ...binding, interaction: { id: input.interactionId, status: "pending" } },
    });
    await expectHeldOwnerUnchanged(input);

    const genericError = new Error(`provider_stdout_closed: ${providerCanary}`);
    expect(genericError).not.toBeInstanceOf(NativeAddressedInteractionAdmissionError);
    expect(nativeSessionFailureSourceCode(genericError)).toBe("provider_stdout_closed");
    await executeFailure(input, { failure: genericError });
    expect(provider.execute).toHaveBeenCalledTimes(1);
    await expect(provider.execute.mock.results[0]?.value).rejects.toBe(genericError);

    const readNotices = async (): Promise<Array<typeof issueComments.$inferSelect>> => db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorType, "system"),
    ));
    const notices = await readNotices();
    // FIRST post-provider lifecycle expectation: the intended RED is the missing owner-visible comment.
    // Do not filter by W1 key/run: an actual generic owner-visible alternative must also be observed.
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice).toMatchObject({
      body: NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE,
      createdByRunId: input.runId,
      clientRequestId: `native-addressed-failure:${input.interactionId}:reason:provider_failure`,
      presentation: { kind: "system_notice", tone: "danger" },
      metadata: { recoveryResponsibility: "user", sourceRunId: input.runId },
    });
    const metadataRows = ((notice.metadata as { sections?: Array<{ rows?: Array<Record<string, unknown>> }> } | null)?.sections ?? [])
      .flatMap(section => section.rows ?? []);
    // Static body says failure/card-pending; structured run/addressee, owner and action identify KP/KA safely.
    expect(metadataRows).toEqual(expect.arrayContaining([
      { type: "run_link", label: "Source run", runId: input.runId, agentId: responderAgentId, title: "failed" },
      { type: "agent_link", label: "Addressee", agentId: responderAgentId, name: "KP" },
      { type: "agent_link", label: "Recovery owner", agentId: ownerAgentId, name: "KA" },
      { type: "key_value", label: "Owner basis", value: "Card creator" },
      { type: "key_value", label: "Next action", value: NATIVE_ADDRESSED_INTERACTION_FAILURE_ACTION },
    ]));
    const readAudits = async (): Promise<Array<typeof activityLog.$inferSelect>> => db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.addressed_interaction_failed"),
      eq(activityLog.entityId, input.issueId),
    ));
    const audits = await readAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ details: {
      interactionId: input.interactionId, commentId: notice.id, state: "pending",
      failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED, failureReason: "provider_failure",
    } });
    const published = JSON.stringify({ body: notice.body, metadata: notice.metadata, audits });
    expect(published).not.toContain(payloadCanary);
    expect(published).not.toContain(providerCanary);
    expect(published).not.toContain(genericError.message);

    const { run, coordinator } = await settled(input);
    expect(coordinator).toMatchObject({
      phase: "terminal_failure", failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED,
      nextAttemptAt: null, leaseOwner: null, recoveryState: null, resultId: null,
    });
    expect(run).toMatchObject({
      status: "failed", nativePhase: "terminal_failure", errorCode: NATIVE_ADDRESSED_INTERACTION_FAILED,
    });
    const [cardAfter] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
    expect(cardAfter).toEqual(cardBefore);
    await expectHeldOwnerUnchanged(input);

    // Existing card/reason idempotency applies to provider failures too; no native-review context is fabricated.
    await expect(appendNativeAddressedInteractionFailureNotice(db, binding, input.interactionId!, genericError)).resolves.toBeNull();
    expect(await readNotices()).toEqual(notices);
    expect(await readAudits()).toEqual(audits);
    await expectHeldOwnerUnchanged(input);
  }, 120_000);
});

// RED derived directly from the kept authenticated-HTTP judge case. Only the
// post-accept supersession expectation and fresh service readback are tightened.
import { writeFileSync } from "node:fs";
import { createApp } from "../../app.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { heartbeatService } from "../heartbeat.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";
import { escalateExhaustedIssueReviewPathRecovery } from "../recovery/review-path-recovery-escalation.js";
import { agentWakeupRequests } from "@paperclipai/db";

const judgeResults: unknown[] = [];
afterAll(() => {
  if (process.env.JUDGE_REPORT) writeFileSync(process.env.JUDGE_REPORT, JSON.stringify(judgeResults, null, 2));
});

it.each([false, true])("M1.5: same-card HTTP acceptance supersedes the original failure note (document=%s)", async documentTarget => {
  const input = await fixture("addressed", false, { issueStatus: "in_review", reviewPolicy: "not_creator" });
  const personMessage = await issueService(db).addComment(input.issueId, "Please review the current work.", { userId: humanUserId });
  await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: input.issueId, wakeCommentId: personMessage.id } })
    .where(eq(heartbeatRuns.id, input.ownerRunId));
  await db.update(issueThreadInteractions).set({ sourceCommentId: personMessage.id, originCommentIds: [personMessage.id] })
    .where(eq(issueThreadInteractions.id, input.interactionId!));
  if (documentTarget) {
    const { document } = await documentService(db).upsertIssueDocument({ issueId: input.issueId, key: "judge-review", title: "Judge review", format: "markdown", body: "Current review evidence", createdByAgentId: ownerAgentId, createdByRunId: input.ownerRunId });
    const target = {
      type: "issue_document" as const, issueId: input.issueId, documentId: document.id, key: document.key,
      revisionId: document.latestRevisionId!, revisionNumber: document.latestRevisionNumber,
    };
    const current = await documentService(db).getIssueDocumentByKey(input.issueId, target.key);
    expect(current).toMatchObject({ id: target.documentId, issueId: input.issueId, key: target.key,
      latestRevisionId: target.revisionId, latestRevisionNumber: target.revisionNumber });
    const revision = await documentService(db).getIssueDocumentRevision(input.issueId, target.key, target.revisionId);
    expect(revision).toMatchObject({ id: target.revisionId, documentId: target.documentId, issueId: input.issueId,
      createdByAgentId: ownerAgentId, createdByRunId: input.ownerRunId, isLatest: true });
    await db.update(issueThreadInteractions).set({ payload: { version: 1, prompt: "Review this revision", target } })
      .where(eq(issueThreadInteractions.id, input.interactionId!));
  }
  const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
  const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
  expect(await isIssueReviewVerdictInteraction(db, { issue, interaction: card })).toBe(true);
  expect(await decideNativeAddressedInteractionGrant(db, input.execution.binding)).toMatchObject({ allowed: true });
  await executeFailure(input, { failure: new Error("provider_stdout_closed") });
  const readNotes = () => db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, input.issueId), eq(issueComments.authorType, "system"),
  ));
  const firstNotes = await readNotes();
  expect(firstNotes).toHaveLength(1);
  const [firstNote] = firstNotes;
  expect(firstNote).toMatchObject({ body: NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE,
    createdByRunId: input.runId, deletedAt: null, presentation: { kind: "system_notice", tone: "danger" } });
  const { run: failedRun } = await settled(input);
  expect(await escalateExhaustedIssueReviewPathRecovery(db, { run: failedRun, issueId: input.issueId })).toBeNull();
  const heartbeat = heartbeatService(db);
  const activeOwnerSweep = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId: input.issueId, unanswered: true });
  const firstBprime = await settleUnansweredPersonMessage(db, { companyId, issueId: input.issueId, now: new Date(Date.now() + 20 * 60_000) });
  expect(firstBprime.kind).toBe("answered");
  expect(await readNotes()).toEqual(firstNotes);

  // The creator legitimately finishes its review handoff; no active owner can mask the pending-card path.
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.ownerRunId));
  await db.update(issues).set({ executionRunId: null, checkoutRunId: null, executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, input.issueId));
  const [waitingIssue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
  const attention = (await issueService(db).listReviewAttention(companyId, [waitingIssue])).get(input.issueId);
  const afterOwnerExitSweep = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId: input.issueId, unanswered: true });
  const secondSweep = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId: input.issueId, unanswered: true });
  const secondBprime = await settleUnansweredPersonMessage(db, { companyId, issueId: input.issueId, now: new Date(Date.now() + 20 * 60_000) });
  expect(await readNotes()).toEqual(firstNotes);
  const wakes = await db.select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));

  // A new authorized response run answers the very same card via the real authenticated loopback route.
  const responseRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: responseRunId, companyId, agentId: responderAgentId, status: "running",
    runtimeMode: "native", nativeIssueId: input.issueId, issueId: input.issueId, scopeKind: "issue",
    contextSnapshot: input.runContextSnapshot });
  expect(await decideNativeAddressedInteractionGrant(db, { ...input.execution.binding, runId: responseRunId })).toMatchObject({ allowed: true });
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID()); // isolated test-only signing key; never printed
  const app = await createApp(db, { uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
    deploymentMode: "authenticated", deploymentExposure: "private", authReady: true, companyDeletionEnabled: false,
    managedPluginAutoInstall: [], localPluginDir: path.join(home.home, "plugins"),
    storageService: createStorageService(createLocalDiskStorageProvider(path.join(home.home, "storage"))),
    decisionServiceOptions: { wakeOriginAgent: async () => null } });
  let server: ReturnType<typeof app.listen> | undefined;
  try {
    await app.locals.bundledPluginsStartup;
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("judge_loopback_address_missing");
    const token = createLocalAgentJwt(responderAgentId, companyId, "paperclip_runner", responseRunId);
    if (!token) throw new Error("judge_test_token_missing");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/issues/${input.issueId}/interactions/${input.interactionId}/accept`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
    });
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({ status: 200, body: {
      status: "accepted", resolvedByAgentId: responderAgentId, resolvedByRunId: responseRunId, resolvedByUserId: null,
    } });
  } finally {
    await app.locals.paperclipShutdown?.();
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, responseRunId));
  const postAnswerSweep = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId: input.issueId, unanswered: true });
  const postAnswerBprime = await settleUnansweredPersonMessage(db, { companyId, issueId: input.issueId, now: new Date(Date.now() + 20 * 60_000) });
  const finalNotes = await readNotes();
  const [finalCard] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId!));
  const activities = await db.select({ action: activityLog.action, actorType: activityLog.actorType, actorId: activityLog.actorId,
    agentId: activityLog.agentId, runId: activityLog.runId, details: activityLog.details })
    .from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, input.issueId)));
  const [finalNote] = finalNotes;
  const finalMetadata = finalNote?.metadata as Record<string, unknown> | null;
  const { supersededByInteractionId: reportedSupersession, ...reportedHistoryMetadata } = finalMetadata ?? {};
  const noteHistoricalContentPreserved = Boolean(finalNote && firstNote && finalNote.id === firstNote.id
    && finalNote.body === firstNote.body && JSON.stringify(finalNote.presentation) === JSON.stringify(firstNote.presentation)
    && JSON.stringify(reportedHistoryMetadata) === JSON.stringify(firstNote.metadata) && finalNote.deletedAt === null);
  judgeResults.push({ documentTarget, issueId: input.issueId, interactionId: input.interactionId, failedRunId: input.runId,
    responseRunId, attention, firstBprime, activeOwnerSweep, afterOwnerExitSweep, secondSweep, secondBprime,
    postAnswerSweep, postAnswerBprime, wakeCount: wakes.length, firstNotes, finalNotes,
    finalCard: { status: finalCard.status, resolvedByAgentId: finalCard.resolvedByAgentId, resolvedByRunId: finalCard.resolvedByRunId },
    activities, reportedSupersession, noteHistoricalContentPreserved });

  expect(finalNotes).toHaveLength(firstNotes.length);
  expect(finalNotes.map(note => note.id)).toEqual(firstNotes.map(note => note.id));
  const { supersededByInteractionId, ...retainedMetadata } = finalMetadata ?? {};
  // RED on ef821: require the same card ID marker after a real HTTP 200 accept.
  expect(supersededByInteractionId).toBe(input.interactionId);
  expect(supersededByInteractionId).not.toBe(responseRunId);
  expect(finalNote.body).toBe(firstNote.body);
  expect(finalNote.presentation).toEqual(firstNote.presentation);
  expect(retainedMetadata).toEqual(firstNote.metadata);
  expect(finalNote.createdByRunId).toBe(input.runId);
  expect(finalNote.createdAt).toEqual(firstNote.createdAt);
  expect(finalNote.deletedAt).toBeNull();
  expect(finalCard).toMatchObject({ status: "accepted", resolvedByAgentId: responderAgentId,
    resolvedByRunId: responseRunId, resolvedByUserId: null });
  const acceptedAudit = activities.find(row => row.action === "issue.thread_interaction_accepted");
  expect(acceptedAudit).toMatchObject({ actorType: "agent", actorId: responderAgentId, agentId: responderAgentId,
    runId: responseRunId, details: expect.objectContaining({ interactionId: input.interactionId, interactionStatus: "accepted" }) });

  // A new service read must retain the durable marker and historical note bytes.
  const service = issueService(db);
  const listed = await service.listComments(input.issueId, { companyId, order: "asc" });
  const listedFailureNote = listed.find(comment => comment.id === firstNote.id);
  const fetchedFailureNote = await service.getComment(firstNote.id);
  for (const freshNote of [listedFailureNote, fetchedFailureNote]) {
    expect(freshNote).toMatchObject({ id: firstNote.id, body: firstNote.body, presentation: firstNote.presentation, deletedAt: null });
    expect((freshNote?.metadata as Record<string, unknown> | null)?.supersededByInteractionId).toBe(input.interactionId);
  }
  expect(activities).toEqual(expect.arrayContaining([expect.objectContaining({ action: "issue.thread_interaction_accepted",
    details: expect.objectContaining({ interactionId: input.interactionId }) })]));
}, 120_000);
