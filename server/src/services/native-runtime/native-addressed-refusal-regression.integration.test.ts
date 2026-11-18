import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companyMemberships,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

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

// Keep this file byte-identical in the RED and FIX commits. All imports exist on
// 4bb64997b15b8f0bf7ffb68cd30742c56a8b08a5; no new admission class is imported or constructed.
// The old writer ignores an optional fourth JS argument. This local call type
// lets the very same file hand an ACTUAL executor rejection to the fixed writer.
const appendCapturedFailure = appendNativeAddressedInteractionFailureNotice as (
  connection: ReturnType<typeof createDb>,
  binding: NativeExecutionInputV1["binding"],
  interactionId: string,
  error?: unknown,
) => ReturnType<typeof appendNativeAddressedInteractionFailureNotice>;

const companyId = randomUUID();
const ownerAgentId = randomUUID();
const responderAgentId = randomUUID();
const CANARY = "ROW14-PRIVATE-PAYLOAD-7f3a-DO-NOT-PUBLISH";
const OWNER_NAME = "Card creator KA";

type Fixture = {
  issueId: string;
  runId: string;
  ownerRunId: string;
  interactionId: string;
  execution: NativeExecutionInputV1;
  runnerInstanceId: string;
  runContextSnapshot: Record<string, unknown>;
};
type CapturedAdmission = Error & {
  binding: { companyId: string; issueId: string; agentId: string; runId: string };
  refusal: { reason: string; interactionId: string | null; status?: string; audienceCode?: string };
};

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let home: ReturnType<typeof createIsolatedTestHome>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  home = createIsolatedTestHome();
  vi.stubEnv("PAPERCLIP_HOME", home.home);
  temporary = await startEmbeddedPostgresTestDatabase("native-addressed-refusal-");
  db = createDb(temporary.connectionString, { maxConnections: 6 });
  await db.insert(companies).values({ id: companyId, name: "Addressed refusal regression", issuePrefix: "NAR" });
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: OWNER_NAME, status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model" } },
    { id: responderAgentId, companyId, name: "Card responder KP", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model" } },
  ]);
  await db.insert(companyMemberships).values([ownerAgentId, responderAgentId].map(principalId => ({
    companyId, principalType: "agent", principalId, membershipRole: "member", status: "active",
  })));
}, 120_000);

afterAll(async () => {
  try {
    await db?.$client.end({ timeout: 1 });
    // This helper owns only its own temporary PostgreSQL fixture.
    await temporary?.cleanup();
  } finally {
    vi.unstubAllEnvs();
    // Deliberately retain the isolated home: it may contain native run traces.
    // Do not add a trace deletion or cleanup of caller-supplied paths here.
  }
});

// Adapted from the BASE lifecycle fixture. A later wake reuses the real card,
// source run and issue, but gets its own native run/session/coordinator/workspace.
async function fixture(previous?: Fixture): Promise<Fixture> {
  const issueId = previous?.issueId ?? randomUUID();
  const ownerRunId = previous?.ownerRunId ?? randomUUID();
  const runId = randomUUID();
  const workspaceRoot = path.join(home.home, "workspace", runId);
  await mkdir(workspaceRoot, { recursive: true });
  if (!previous) {
    await db.insert(issues).values({
      id: issueId, companyId, title: "Respond to an addressed confirmation", status: "in_progress",
      workMode: "standard", assigneeAgentId: ownerAgentId, createdByAgentId: ownerAgentId,
    });
    await db.insert(heartbeatRuns).values({
      id: ownerRunId, companyId, agentId: ownerAgentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, issueId, scopeKind: "issue", contextSnapshot: { issueId },
    });
  }
  let interactionId = previous?.interactionId;
  if (!interactionId) {
    const [card] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "request_confirmation", addresseeAgentId: responderAgentId,
      createdByAgentId: ownerAgentId, sourceRunId: ownerRunId, continuationPolicy: "none",
      requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator", resolverPolicyProvenance: "explicit",
      payload: { version: 1, prompt: CANARY },
    }).returning();
    interactionId = card.id;
  }
  const contextSnapshot = {
    issueId, taskId: issueId, sourceRunId: ownerRunId, interactionId,
    wakeReason: "interaction_pending", source: "issue.interaction.created",
  };
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  const [run] = await db.insert(heartbeatRuns).values({
    id: runId, companyId, agentId: responderAgentId, status: "running", runtimeMode: "native",
    nativeIssueId: issueId, issueId, scopeKind: "issue", invocationSource: "assignment", triggerDetail: "system", contextSnapshot,
  }).returning();
  const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
  const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { companyId, runId, issueId, agentId: responderAgentId, executionWorkspaceId: runId },
    provider: { kind: "codex", model: "test-model" },
    task: { identifier: issueId, title: issue.title, description: null, prompt: CANARY, workMode: "standard" },
    workspace: { cwd: workspaceRoot, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    completionContract: {
      id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
      contract: buildNativeCompletionContract(issue, { revision: contract.revision }),
    },
    interactionResponses: [], credentialBindings: [],
  };
  const [preparedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  await db.update(heartbeatRuns).set({ runnerProfileJson: {
    ...(preparedRun.runnerProfileJson ?? {}), nativeExecutionInput: execution,
    sessionCheckpoint: { providerSessionId: "fixture-provider-session", providerIdentity: { threadId: "fixture-provider-thread" } },
  } }).where(eq(heartbeatRuns.id, runId));
  await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
  if (!previous) {
    await db.update(issues).set({
      executionRunId: ownerRunId, checkoutRunId: ownerRunId, executionAgentNameKey: "ka", executionLockedAt: new Date(),
    }).where(eq(issues.id, issueId));
  }
  const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return { issueId, ownerRunId, runId, interactionId, execution, runnerInstanceId: native.runnerInstanceId,
    runContextSnapshot: persistedRun.contextSnapshot as Record<string, unknown> };
}

async function executeCaptured(input: Fixture, connection = db, providerFailure?: Error): Promise<unknown> {
  provider.execute.mockReset().mockImplementation(async raw => {
    // Only the generic provider-failure cases should cross this boundary. Do
    // not fake a successful/no-provider backend to manufacture an admission error.
    const callbacks = raw as { prepareWakeAttachmentPrompt?: () => Promise<unknown> };
    await callbacks.prepareWakeAttachmentPrompt?.();
    throw providerFailure ?? new Error("unexpected_provider_execution");
  });
  let rejection: unknown;
  try {
    await executePaperclipNativeSession({
      db: connection, execution: input.execution, runContextSnapshot: input.runContextSnapshot,
      runnerInstanceId: input.runnerInstanceId, runnerEnvironment: {},
      ...(providerFailure === undefined ? { useRunnerd: true } : {
        useRunnerd: false,
        backend: {
          descriptor: async () => { throw new Error("Unexpected fake-provider backend descriptor call"); },
          openSession: async () => { throw new Error("Unexpected fake-provider backend open call"); },
        } as never,
      }),
      prepareAttachmentPrompt: async () => "",
    });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  if (providerFailure !== undefined) {
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(rejection).toBe(providerFailure);
  }
  return rejection;
}

function expectCapturedAdmission(error: unknown, input: Fixture, reason: string, details: Record<string, unknown> = {}) {
  expect(error).toMatchObject({
    name: "NativeAddressedInteractionAdmissionError",
    message: "native_addressed_interaction_no_longer_available",
    binding: { companyId, issueId: input.issueId, agentId: responderAgentId, runId: input.runId },
    refusal: { reason, ...details },
  });
  const captured = error as CapturedAdmission;
  expect([null, input.interactionId]).toContain(captured.refusal.interactionId);
  expect(provider.execute).not.toHaveBeenCalled();
  return captured;
}

async function settled(input: Fixture, connection = db) {
  const [run] = await connection.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
  const [coordinator] = await connection.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId));
  return { run, coordinator };
}
async function expectTerminal(input: Fixture, connection = db) {
  const { run, coordinator } = await settled(input, connection);
  expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: NATIVE_ADDRESSED_INTERACTION_FAILED });
  expect(run.finishedAt).toBeInstanceOf(Date);
  expect(coordinator).toMatchObject({
    phase: "terminal_failure", failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED,
    nextAttemptAt: null, leaseOwner: null, recoveryState: null, resultId: null,
  });
}
async function protectedState(input: Fixture) {
  const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
  const [sourceRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.ownerRunId));
  const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId));
  return { issue, sourceRun, card };
}
async function systemNotes(input: Fixture, connection = db) {
  return connection.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, input.issueId), eq(issueComments.authorType, "system"),
  ));
}
async function failureAudits(input: Fixture, connection = db) {
  return connection.select().from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.entityId, input.issueId), eq(activityLog.action, "issue.addressed_interaction_failed"),
  ));
}
async function expectNotes(input: Fixture, count: number, connection = db) {
  const notes = await systemNotes(input, connection);
  expect(notes).toHaveLength(count);
  const audits = await failureAudits(input, connection);
  expect(audits).toHaveLength(count);
  for (const note of notes) {
    expect(note).toMatchObject({ authorType: "system", authorAgentId: null, authorUserId: null, issueId: input.issueId, companyId });
    expect(typeof note.clientRequestId).toBe("string");
    expect(note.clientRequestId?.length).toBeGreaterThan(0);
    expect(JSON.stringify([note.body, note.presentation, note.metadata]).toLowerCase()).not.toContain(CANARY.toLowerCase());
  }
  expect(JSON.stringify(audits.map(audit => audit.details)).toLowerCase()).not.toContain(CANARY.toLowerCase());
  const [card] = await connection.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, input.interactionId));
  expect(card).toMatchObject({ status: "pending", resolvedByAgentId: null, resolvedByRunId: null, resolvedByUserId: null, resolvedAt: null });
  return notes;
}
function expectTruthNote(note: typeof issueComments.$inferSelect, input: Fixture, cause: RegExp, ownerId = ownerAgentId) {
  expect(note).toMatchObject({ createdByRunId: input.runId, presentation: { kind: "system_notice" } });
  expect(note.body).toMatch(cause);
  expect(note.body).toMatch(/card remains pending/i);
  expect(note.body).toMatch(/automatic retry is stopped/i);
  expect(note.body).toMatch(/person|administrator|approval flow/i);
  const rows = note.metadata?.sections.flatMap(section => section.rows) ?? [];
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "agent_link", label: "Recovery owner", agentId: ownerId }),
    expect.objectContaining({ type: "key_value", label: "Owner basis", value: "Card creator" }),
    expect.objectContaining({ type: "key_value", label: "Card", value: input.interactionId }),
  ]));
}
async function setPayload(input: Fixture, extra: Record<string, unknown>) {
  await db.update(issueThreadInteractions).set({ payload: { version: 1, prompt: CANARY, ...extra } as never })
    .where(eq(issueThreadInteractions.id, input.interactionId));
}
async function resetAvailability() {
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, responderAgentId));
  await db.update(companies).set({ status: "active" }).where(eq(companies.id, companyId));
}

type RefusalCase = {
  name: string; reason: string; cause: RegExp; details?: Record<string, unknown>;
  apply: (input: Fixture) => Promise<void>;
};
const REFUSALS: RefusalCase[] = [
  { name: "agent paused", reason: "agent_status", details: { status: "paused" }, cause: /agent is paused/i,
    apply: async () => { await db.update(agents).set({ status: "paused" }).where(eq(agents.id, responderAgentId)); } },
  { name: "agent terminated", reason: "agent_status", details: { status: "terminated" }, cause: /agent has been terminated/i,
    apply: async () => { await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, responderAgentId)); } },
  { name: "unavailable document target", reason: "target", details: { targetReason: "unavailable" }, cause: /exact linked document.*current revision is unavailable/i,
    apply: async input => { await setPayload(input, { target: { type: "issue_document", issueId: input.issueId,
      documentId: randomUUID(), key: CANARY.toLowerCase(), revisionId: randomUUID(), revisionNumber: 1, label: CANARY } }); } },
  { name: "governed tool action", reason: "tool_action", cause: /governed tool action.*independent authorization/i,
    apply: async input => { await setPayload(input, { toolAction: { toolName: CANARY, arguments: { privateValue: CANARY } } }); } },
  { name: "protected secret proposal", reason: "secret_proposal", cause: /protected secret change.*independent authorization/i,
    apply: async input => { await setPayload(input, { secretProposal: { name: CANARY, value: CANARY } }); } },
  { name: "unsupported card kind", reason: "interaction_kind", cause: /kind of card is not supported/i,
    apply: async input => { await db.update(issueThreadInteractions).set({ kind: "ask_user_questions" }).where(eq(issueThreadInteractions.id, input.interactionId)); } },
  { name: "changed addressee", reason: "addressee_agent", cause: /not for the card's current addressed agent/i,
    apply: async input => { await db.update(issueThreadInteractions).set({ addresseeAgentId: ownerAgentId }).where(eq(issueThreadInteractions.id, input.interactionId)); } },
  { name: "source-run mismatch", reason: "source_run_binding", cause: /different creating runs/i,
    apply: async input => { await db.update(issueThreadInteractions).set({ sourceRunId: null }).where(eq(issueThreadInteractions.id, input.interactionId)); } },
  { name: "completed task", reason: "issue_closed", cause: /task is done or cancelled/i,
    apply: async input => { await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.issueId)); } },
  { name: "hidden task", reason: "issue_hidden", cause: /task is hidden/i,
    apply: async input => { await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, input.issueId)); } },
  { name: "private task", reason: "issue_read", cause: /could not read this task.*access rules/i,
    apply: async input => { await db.update(issues).set({ visibility: "private", privacyRootIssueId: input.issueId }).where(eq(issues.id, input.issueId)); } },
  { name: "paused company", reason: "company_status", details: { status: "paused" }, cause: /company is not active/i,
    apply: async () => { await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId)); } },
];

describe("addressed admission refusals through the native executor and PostgreSQL", () => {
  it.each(REFUSALS)("captures $name without provider work, retry, payload disclosure, card resolution or owner mutation", async testCase => {
    const input = await fixture();
    await testCase.apply(input);
    const before = await protectedState(input);
    try {
      const error = await executeCaptured(input);
      expectCapturedAdmission(error, input, testCase.reason, testCase.details);
      await expectTerminal(input);
      const [note] = await expectNotes(input, 1);
      expectTruthNote(note, input, testCase.cause);
      const [audit] = await failureAudits(input);
      expect(audit.details).toMatchObject({ interactionId: input.interactionId, commentId: note.id, refusalReason: testCase.reason });
      expect(await protectedState(input)).toEqual(before);
      // Re-delivery must use the captured error, not re-decide the live agent or company.
      await resetAvailability();
      await expect(appendCapturedFailure(db, input.execution.binding, input.interactionId, error)).resolves.toBeNull();
      expect(await systemNotes(input)).toEqual([note]);
      expect(await failureAudits(input)).toHaveLength(1);
    } finally {
      await resetAvailability();
    }
  }, 120_000);

  it.each(["other execution lock", "no execution lock"] as const)(
    "F1: a paused addressee who is ALSO the assignee keeps task ownership/status/locks with %s", async lock => {
      const input = await fixture();
      await db.update(issues).set({ assigneeAgentId: responderAgentId,
        ...(lock === "no execution lock" ? { executionRunId: null, checkoutRunId: null, executionAgentNameKey: null, executionLockedAt: null } : {}),
      }).where(eq(issues.id, input.issueId));
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, responderAgentId));
      const before = await protectedState(input);
      expect(before.issue.executionRunId).toBe(lock === "no execution lock" ? null : input.ownerRunId);
      expect(before.issue.checkoutRunId).toBe(lock === "no execution lock" ? null : input.ownerRunId);
      try {
        const error = await executeCaptured(input);
        expectCapturedAdmission(error, input, "agent_status", { status: "paused" });
        await expectTerminal(input);
        const [note] = await expectNotes(input, 1);
        expectTruthNote(note, input, /agent is paused/i);
        // The run is response-only, not the task execution owner even when it
        // names the same agent. In particular no-lock must NOT become blocked.
        expect(await protectedState(input)).toEqual(before);
      } finally {
        await resetAvailability();
      }
    }, 120_000,
  );

  it("F2: provider failure first, then an actual paused refusal publishes a second truth note with a different key", async () => {
    const first = await fixture();
    const providerFailure = new Error(`provider_stdout_closed ${CANARY}`);
    const firstError = await executeCaptured(first, db, providerFailure);
    expect(firstError).toBe(providerFailure);
    expect(provider.execute).toHaveBeenCalledTimes(1);
    await expectTerminal(first);
    const [providerNote] = await expectNotes(first, 1);
    expect(providerNote.body).toBe(NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE);
    const second = await fixture(first);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, responderAgentId));
    const before = await protectedState(second);
    try {
      const pausedError = await executeCaptured(second);
      expectCapturedAdmission(pausedError, second, "agent_status", { status: "paused" });
      await expectTerminal(second);
      const notes = await expectNotes(second, 2);
      expect(notes).toContainEqual(providerNote);
      const pausedNote = notes.find(note => note.id !== providerNote.id)!;
      expectTruthNote(pausedNote, second, /agent is paused/i);
      expect(pausedNote.clientRequestId).not.toBe(providerNote.clientRequestId);
      expect(await protectedState(second)).toEqual(before);
      await expect(appendCapturedFailure(db, first.execution.binding, first.interactionId, firstError)).resolves.toBeNull();
      await expect(appendCapturedFailure(db, second.execution.binding, second.interactionId, pausedError)).resolves.toBeNull();
      await expectNotes(second, 2);
    } finally {
      await resetAvailability();
    }
  }, 120_000);

  it("F2: generic provider_failure dedupes across runs without parsing admission-like error text", async () => {
    const first = await fixture();
    const firstFailure = new Error(`provider_stdout_closed ${CANARY}`);
    expect(await executeCaptured(first, db, firstFailure)).toBe(firstFailure);
    expect(provider.execute).toHaveBeenCalledTimes(1);
    await expectTerminal(first);
    const [firstNote] = await expectNotes(first, 1);
    const second = await fixture(first);
    const textOnly = new Error(`native_addressed_interaction_no_longer_available agent_status paused ${CANARY}`);
    const secondError = await executeCaptured(second, db, textOnly);
    expect(secondError).toBe(textOnly);
    expect((secondError as Partial<CapturedAdmission>).refusal).toBeUndefined();
    expect(provider.execute).toHaveBeenCalledTimes(1);
    await expectTerminal(second);
    expect(await expectNotes(second, 1)).toEqual([firstNote]);
  }, 120_000);

  it("F2: different audience codes share the top-level audience reason, not a new subtype key", async () => {
    const first = await fixture();
    await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "human_only" })
      .where(eq(issueThreadInteractions.id, first.interactionId));
    const firstError = await executeCaptured(first);
    expectCapturedAdmission(firstError, first, "audience", { audienceCode: "interaction_human_only" });
    await expectTerminal(first);
    const [firstNote] = await expectNotes(first, 1);
    expectTruthNote(firstNote, first, /human decision/i);
    // A second audience restriction on the SAME card. Keep source attribution
    // valid so this really reaches audience, rather than source_run_creator.
    await db.update(heartbeatRuns).set({ agentId: responderAgentId }).where(eq(heartbeatRuns.id, first.ownerRunId));
    await db.update(issueThreadInteractions).set({ createdByAgentId: responderAgentId, effectiveResolverPolicy: "not_creator" })
      .where(eq(issueThreadInteractions.id, first.interactionId));
    const second = await fixture(first);
    const secondError = await executeCaptured(second);
    expectCapturedAdmission(secondError, second, "audience", { audienceCode: "interaction_creator_excluded" });
    await expectTerminal(second);
    expect(await expectNotes(second, 1)).toEqual([firstNote]);
  }, 120_000);

  it("F2: paused→paused after a fresh pool is one note; paused→terminated→pending_approval→error adds distinct status truths", async () => {
    const first = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, responderAgentId));
    const restarted = createDb(temporary.connectionString, { maxConnections: 2 });
    try {
      const firstError = await executeCaptured(first);
      expectCapturedAdmission(firstError, first, "agent_status", { status: "paused" });
      await expectTerminal(first);
      const [pausedNote] = await expectNotes(first, 1);
      expectTruthNote(pausedNote, first, /agent is paused/i);
      const sameReason = await fixture(first);
      const sameError = await executeCaptured(sameReason, restarted);
      expectCapturedAdmission(sameError, sameReason, "agent_status", { status: "paused" });
      await expectTerminal(sameReason, restarted);
      expect(await expectNotes(sameReason, 1, restarted)).toEqual([pausedNote]);
      await expect(appendCapturedFailure(restarted, sameReason.execution.binding, sameReason.interactionId, sameError)).resolves.toBeNull();
      const keys = new Set([pausedNote.clientRequestId]);
      const statuses = [
        { status: "terminated", cause: /agent has been terminated/i },
        { status: "pending_approval", cause: /agent is awaiting approval/i },
        { status: "error", cause: /agent is in an error state/i },
      ] as const;
      for (const [index, value] of statuses.entries()) {
        const next = await fixture(first);
        await db.update(agents).set({ status: value.status }).where(eq(agents.id, responderAgentId));
        const error = await executeCaptured(next, restarted);
        expectCapturedAdmission(error, next, "agent_status", { status: value.status });
        await expectTerminal(next, restarted);
        const notes = await expectNotes(next, index + 2, restarted);
        const newNote = notes.find(note => !keys.has(note.clientRequestId))!;
        expect(newNote).toBeDefined();
        expectTruthNote(newNote, next, value.cause);
        keys.add(newNote.clientRequestId);
        expect(keys.size).toBe(index + 2);
      }
    } finally {
      await restarted.$client.end({ timeout: 1 });
      await resetAvailability();
    }
  }, 120_000);

  it("F2: captured same-reason refusals racing across pools and runs publish once, and a fresh pool cannot publish again", async () => {
    const first = await fixture();
    // Hold publication closed, not admission: cancellation is fixture state.
    // The paused gate fires first; the real terminal writer cannot publish on
    // a non-pending card. Reopening the fixture lets us race the FIRST insert.
    await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, first.interactionId));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, responderAgentId));
    const secondPool = createDb(temporary.connectionString, { maxConnections: 3 });
    try {
      const firstError = await executeCaptured(first);
      expectCapturedAdmission(firstError, first, "agent_status", { status: "paused" });
      await expectTerminal(first);
      const second = await fixture(first);
      const secondError = await executeCaptured(second, secondPool);
      expectCapturedAdmission(secondError, second, "agent_status", { status: "paused" });
      await expectTerminal(second, secondPool);
      expect(await systemNotes(first)).toHaveLength(0);
      expect(await failureAudits(first)).toHaveLength(0);
      await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, first.interactionId));
      const results = await Promise.all([
        appendCapturedFailure(db, first.execution.binding, first.interactionId, firstError),
        appendCapturedFailure(secondPool, second.execution.binding, second.interactionId, secondError),
        appendCapturedFailure(secondPool, first.execution.binding, first.interactionId, firstError),
        appendCapturedFailure(db, second.execution.binding, second.interactionId, secondError),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const [note] = await expectNotes(first, 1);
      expectTruthNote(note, note.createdByRunId === first.runId ? first : second, /agent is paused/i);
      const thirdPool = createDb(temporary.connectionString, { maxConnections: 1 });
      try {
        await expect(appendCapturedFailure(thirdPool, first.execution.binding, first.interactionId, firstError)).resolves.toBeNull();
        await expect(appendCapturedFailure(thirdPool, second.execution.binding, second.interactionId, secondError)).resolves.toBeNull();
        expect(await expectNotes(first, 1, thirdPool)).toEqual([note]);
      } finally {
        await thirdPool.$client.end({ timeout: 1 });
      }
    } finally {
      await secondPool.$client.end({ timeout: 1 });
      await resetAvailability();
    }
  }, 120_000);

  it("F2: a historical static C8 per-run note suppresses provider_failure ONLY, not an actual paused refusal", async () => {
    const first = await fixture();
    const [legacy] = await db.insert(issueComments).values({
      companyId, issueId: first.issueId, authorType: "system", authorAgentId: null, authorUserId: null,
      createdByRunId: first.ownerRunId,
      clientRequestId: `native-addressed-failure:${first.interactionId}:${first.ownerRunId}`,
      body: "Paperclip could not handle the addressed confirmation card; it remains pending.",
    }).returning();
    const firstError = await executeCaptured(first, db, new Error(`provider_stdout_closed ${CANARY}`));
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(firstError).toMatchObject({ message: `provider_stdout_closed ${CANARY}` });
    await expectTerminal(first);
    expect(await systemNotes(first)).toEqual([legacy]);
    expect(await failureAudits(first)).toHaveLength(0);
    const second = await fixture(first);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, responderAgentId));
    try {
      const secondError = await executeCaptured(second);
      expectCapturedAdmission(secondError, second, "agent_status", { status: "paused" });
      await expectTerminal(second);
      const notes = await systemNotes(second);
      expect(notes).toHaveLength(2);
      expect(notes).toContainEqual(legacy);
      const pausedNote = notes.find(note => note.id !== legacy.id)!;
      expectTruthNote(pausedNote, second, /agent is paused/i);
      expect(pausedNote.clientRequestId).not.toBe(legacy.clientRequestId);
      const audits = await failureAudits(second);
      expect(audits).toHaveLength(1);
      expect(JSON.stringify([notes, audits])).not.toContain(CANARY);
      expect((await protectedState(second)).card.status).toBe("pending");
    } finally {
      await resetAvailability();
    }
  }, 120_000);

  it("does not accept a plain Error's text or a real refusal from another run as authority to report a governed card", async () => {
    const first = await fixture();
    const second = await fixture();
    await setPayload(first, { toolAction: { toolName: CANARY, arguments: { value: CANARY } } });
    await setPayload(second, { toolAction: { toolName: CANARY, arguments: { value: CANARY } } });
    await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, second.interactionId));
    const firstError = await executeCaptured(first);
    expectCapturedAdmission(firstError, first, "tool_action");
    const secondError = await executeCaptured(second);
    expectCapturedAdmission(secondError, second, "tool_action");
    await expectTerminal(second);
    await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, second.interactionId));
    await expect(appendCapturedFailure(db, second.execution.binding, second.interactionId, firstError)).resolves.toBeNull();
    await expect(appendCapturedFailure(db, second.execution.binding, second.interactionId, new Error("native_addressed_interaction_no_longer_available"))).resolves.toBeNull();
    expect(await systemNotes(second)).toHaveLength(0);
    expect(await failureAudits(second)).toHaveLength(0);
    await expect(appendCapturedFailure(db, second.execution.binding, second.interactionId, secondError)).resolves.not.toBeNull();
    const [note] = await expectNotes(second, 1);
    expectTruthNote(note, second, /governed tool action/i);
  }, 120_000);
});
