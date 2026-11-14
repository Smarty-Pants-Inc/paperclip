import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issueAccessGrants, issueComments, issues,
  issueThreadInteractions, nativeRunFinalizations } from "@paperclipai/db";
import { NativeAddressedInteractionAdmissionError, getNativeAddressedInteractionGrant,
  requireNativeAddressedInteractionGrant } from "../services/native-runtime/native-addressed-interaction.js";
import { authorizationService, canActorReadIssuePrivacy } from "../services/authorization.js";
import { appendNativeAddressedInteractionFailureNotice, NATIVE_ADDRESSED_INTERACTION_FAILED,
  NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE, readNativeAddressedInteractionFailure,
} from "../services/native-runtime/native-addressed-interaction-failure.js";
import { nativeProviderRecoveryEvidence, nativeSessionFailureDisposition, nativeSessionFailureSourceCode,
  nativeSessionRecoveryProjection } from "../services/native-runtime/native-session-executor.js";
import { NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT, NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE,
} from "../services/native-runtime/native-runner-ownership.js";
import { stageNativeRunnerWakeAttachments } from "../services/native-runtime/native-runner-file-handoff.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { issueService } from "../services/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let root: string;
const denial = () => new Error("paperclip_runner_attachment_staging_not_authorized");
const terminalDisposition = (code: string) => nativeSessionFailureDisposition(1, undefined,
  code as Parameters<typeof nativeSessionFailureDisposition>[2]);

beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("addressed-failure-broad-");
  db = createDb(temporary.connectionString);
  root = await mkdtemp(path.join(tmpdir(), "addressed-failure-broad-"));
}, 120_000);
afterAll(async () => {
  try { await db?.$client.end(); } finally {
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const companyId = randomUUID(), ka = randomUUID(), kp = randomUUID(), kaRunId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Addressed failure boundary", issuePrefix: `AF${companyId.slice(0, 8)}` });
  await db.insert(agents).values([ka, kp].map(id => ({ id, companyId, name: id === ka ? "KA" : "KP", status: "running",
    adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" }, permissions: {},
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } } })));
  await db.insert(companyMemberships).values([ka, kp].map(principalId => ({ companyId, principalType: "agent",
    principalId, membershipRole: "member", status: "active" })));
  const [issue] = await db.insert(issues).values({ companyId, title: "KA retains every task field", status: "in_progress",
    workMode: "standard", assigneeAgentId: ka }).returning();
  if (!issue) throw new Error("fixture_issue_missing");
  await db.insert(heartbeatRuns).values({ id: kaRunId, companyId, agentId: ka, status: "running", runtimeMode: "native",
    issueId: issue.id, nativeIssueId: issue.id, scopeKind: "issue", contextSnapshot: { issueId: issue.id } });
  await db.update(issues).set({ executionRunId: kaRunId, checkoutRunId: kaRunId, executionAgentNameKey: "ka",
    executionLockedAt: new Date("2026-11-13T11:56:00Z") }).where(eq(issues.id, issue.id));
  const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "request_confirmation",
    addresseeAgentId: kp, createdByAgentId: ka, sourceRunId: kaRunId, continuationPolicy: "none",
    requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator", resolverPolicyProvenance: "explicit",
    payload: { version: 1, prompt: "Coordination only, not authority for underlying work." } }).returning();
  if (!card) throw new Error("fixture_card_missing");
  const binding = { companyId, issueId: issue.id, agentId: kp, runId };
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: kp, status: "running", runtimeMode: "native",
    nativeIssueId: issue.id, issueId: issue.id, scopeKind: "issue", contextSnapshot: { issueId: issue.id, taskId: issue.id,
      sourceRunId: kaRunId,
      interactionId: card.id, wakeReason: "interaction_pending", source: "issue.interaction.created" },
    runnerProfileJson: { sessionCheckpoint: { providerSessionId: "boundary-checkpoint-not-a-live-pi-session" } } });
  const task = () => db.select().from(issues).where(eq(issues.id, issue.id)).then(rows => rows[0]!);
  const cards = () => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)).then(rows => rows[0]!);
  const kaRun = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, kaRunId)).then(rows => rows[0]!);
  const comments = () => db.select().from(issueComments).where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issue.id)));
  const audits = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.addressed_interaction_failed")));
  const terminalizeNoticeFixture = async () => {
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId, phase: "terminal_failure",
      failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED, nextAttemptAt: null });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), nativePhase: "terminal_failure",
      errorCode: NATIVE_ADDRESSED_INTERACTION_FAILED }).where(eq(heartbeatRuns.id, runId));
  };
  return { binding, ka, kp, kaRunId, card, task, cards, kaRun, comments, audits, terminalizeNoticeFixture };
}

it.each([
  { name: "injected staging denial", error: denial(), raw: "native_session_interrupted" },
  { name: "provider interruption", error: new Error("provider_stdout_closed"), raw: "provider_stdout_closed" },
  { name: "arbitrary provider failure", error: new Error("unlisted provider interruption"), raw: "native_session_interrupted" },
  { name: "non-Error rejection", error: { reason: "provider disconnected" }, raw: "native_session_interrupted" },
  { name: "non-Error string", error: "unexpected transport loss", raw: "native_session_interrupted" },
])("terminalizes the persisted response-only role for $name despite a resumable checkpoint", async ({ error, raw }) => {
  const f = await fixture();
  const taskBefore = await f.task(), cardBefore = await f.cards(), kaBefore = await f.kaRun();
  expect(nativeSessionFailureSourceCode(error)).toBe(raw);
  expect(terminalDisposition(nativeSessionFailureSourceCode(error)).phase).toBe("retryable_failure");
  const failure = await readNativeAddressedInteractionFailure(db, f.binding);
  expect(failure).toEqual({ interactionId: f.card.id, state: "pending" });
  const evidence = await nativeProviderRecoveryEvidence({ db, runId: f.binding.runId,
    executionTargetKind: "local", sourceFailureCode: nativeSessionFailureSourceCode(error) });
  expect(evidence).toMatchObject({ recoveryMode: "exact_checkpoint_resume", checkpointExists: true, providerSessionEstablished: true });
  expect(terminalDisposition(failure ? NATIVE_ADDRESSED_INTERACTION_FAILED : raw)).toEqual({
    phase: "terminal_failure", failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED, nextAttemptAt: null,
  });
  expect(await f.task()).toEqual(taskBefore);
  expect(await f.cards()).toEqual(cardBefore);
  expect(await f.kaRun()).toEqual(kaBefore);
});

it("writes one static system notice and audit under concurrent repeated terminal notice handling, without changing KA or the card", async () => {
  const f = await fixture();
  const taskBefore = await f.task(), cardBefore = await f.cards(), kaBefore = await f.kaRun();
  await f.terminalizeNoticeFixture();
  const publications = await Promise.all([1, 2].map(() => appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id)));
  expect(publications.filter(Boolean)).toHaveLength(1);
  expect(await appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id)).toBeNull();
  expect(await f.comments()).toEqual([expect.objectContaining({ authorType: "system", authorAgentId: null, authorUserId: null,
    createdByRunId: f.binding.runId, body: NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE,
    clientRequestId: `native-addressed-failure:${f.card.id}` })]);
  expect(await f.audits()).toEqual([expect.objectContaining({ actorType: "system", actorId: "system", runId: f.binding.runId,
    details: expect.objectContaining({ interactionId: f.card.id, state: "pending", failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED }) })]);
  expect(await f.task()).toEqual(taskBefore);
  expect(await f.cards()).toEqual(cardBefore);
  expect(await f.kaRun()).toEqual(kaBefore);
});

it.each(["private issue", "toolAction", "secretProposal"] as const)(
  "reports a captured %s refusal only as a system owner notice without granting receiver authority or copying protected payloads", async kind => {
    const f = await fixture();
    const canary = `PROTECTED_CARD_PAYLOAD_${randomUUID()}`;
    const payload = { ...f.card.payload, prompt: canary,
      ...(kind === "toolAction" ? { toolAction: { toolName: canary, arguments: { privateValue: canary } } } : {}),
      ...(kind === "secretProposal" ? { secretProposal: { name: canary, value: canary } } : {}),
    } as typeof f.card.payload;
    await db.update(issueThreadInteractions).set({ payload }).where(eq(issueThreadInteractions.id, f.card.id));
    if (kind === "private issue") {
      await db.update(issues).set({ visibility: "private", privacyRootIssueId: f.binding.issueId })
        .where(eq(issues.id, f.binding.issueId));
    }
    const actor = { type: "agent" as const, companyId: f.binding.companyId, agentId: f.kp,
      runId: f.binding.runId, source: "agent_jwt" as const };
    const taskBefore = await f.task(), cardBefore = await f.cards(), ownerBefore = await f.kaRun();
    const readGrants = () => db.select().from(issueAccessGrants).where(eq(issueAccessGrants.issueId, f.binding.issueId));
    const grantsBefore = await readGrants();
    const membershipsBefore = await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, f.binding.companyId));
    const receiverCanRead = () => canActorReadIssuePrivacy(db, actor, taskBefore);
    if (kind === "private issue") {
      expect(await receiverCanRead()).toBe(false);
      expect((await authorizationService(db).decide({ actor, action: "issue:read",
        resource: { type: "issue", companyId: f.binding.companyId, issueId: f.binding.issueId } })).allowed).toBe(false);
      expect(await canActorReadIssuePrivacy(db, { ...actor, agentId: f.ka, runId: f.kaRunId }, taskBefore)).toBe(true);
    }
    expect(await getNativeAddressedInteractionGrant(db, f.binding)).toBeNull();
    expect(await readNativeAddressedInteractionFailure(db, f.binding)).toBeNull();
    const error = await requireNativeAddressedInteractionGrant(db, f.binding).then(
      () => { throw new Error("expected_real_admission_refusal"); }, error => error as unknown,
    );
    expect(error).toBeInstanceOf(NativeAddressedInteractionAdmissionError);
    expect(error).toMatchObject({ binding: f.binding, refusal: { interactionId: f.card.id,
      reason: kind === "private issue" ? "issue_read" : kind === "toolAction" ? "tool_action" : "secret_proposal" } });
    expect(nativeSessionFailureSourceCode(error)).toBe(NATIVE_ADDRESSED_INTERACTION_FAILED);
    expect(await readNativeAddressedInteractionFailure(db, f.binding, error)).toEqual({ interactionId: f.card.id, state: "pending" });
    await f.terminalizeNoticeFixture();
    const publications = await Promise.all([1, 2].map(() => appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id, error)));
    expect(publications.filter(Boolean)).toHaveLength(1);
    const comments = await f.comments();
    expect(comments).toEqual([expect.objectContaining({ authorType: "system", authorAgentId: null, authorUserId: null,
      clientRequestId: `native-addressed-failure:${f.card.id}`, presentation: expect.objectContaining({ tone: "danger" }) })]);
    const notice = comments[0]!;
    expect(JSON.stringify({ body: notice.body, metadata: notice.metadata })).not.toContain(canary);
    const rows = ((notice.metadata as { sections?: Array<{ rows?: Array<Record<string, unknown>> }> } | null)?.sections ?? [])
      .flatMap(section => section.rows ?? []);
    expect(rows).toEqual(expect.arrayContaining([
      { type: "agent_link", label: "Recovery owner", agentId: f.ka, name: "KA" },
      { type: "key_value", label: "Owner basis", value: "Card creator" },
    ]));
    expect(rows.some(row => row.label === "Recovery action")).toBe(false);
    expect(await f.audits()).toHaveLength(1);
    expect(await readGrants()).toEqual(grantsBefore);
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, f.binding.companyId))).toEqual(membershipsBefore);
    expect(await f.task()).toEqual(taskBefore);
    expect(await f.cards()).toEqual(cardBefore);
    expect(await f.kaRun()).toEqual(ownerBefore);
    if (kind === "private issue") {
      expect(await receiverCanRead()).toBe(false);
      expect((await authorizationService(db).decide({ actor, action: "issue:read",
        resource: { type: "issue", companyId: f.binding.companyId, issueId: f.binding.issueId } })).allowed).toBe(false);
    }
    expect(await getNativeAddressedInteractionGrant(db, f.binding, { phase: "resolved" })).toBeNull();
  },
);

it.each([
  { kind: "kind", reason: "interaction_kind" },
  { kind: "addressee", reason: "addressee_agent" },
  { kind: "source", reason: "source_run_binding" },
  { kind: "in_review", reason: "audience" },
])("carries the real $kind admission refusal through the failure reader and owner notice writer", async ({ kind, reason }) => {
  const f = await fixture();
  if (kind === "kind") await db.update(issueThreadInteractions).set({ kind: "ask_user_questions" }).where(eq(issueThreadInteractions.id, f.card.id));
  if (kind === "addressee") await db.update(issueThreadInteractions).set({ addresseeAgentId: f.ka }).where(eq(issueThreadInteractions.id, f.card.id));
  if (kind === "source") await db.update(issueThreadInteractions).set({ sourceRunId: null }).where(eq(issueThreadInteractions.id, f.card.id));
  if (kind === "in_review") await db.update(issues).set({ status: "in_review", createdByAgentId: f.ka, reviewPolicy: "human_only" }).where(eq(issues.id, f.binding.issueId));
  const taskBefore = await f.task(), cardBefore = await f.cards(), ownerBefore = await f.kaRun();
  const error = await requireNativeAddressedInteractionGrant(db, f.binding).then(
    () => { throw new Error("expected_real_admission_refusal"); }, error => error as unknown,
  );
  expect(error).toBeInstanceOf(NativeAddressedInteractionAdmissionError);
  expect(error).toMatchObject({ binding: f.binding, refusal: { reason, interactionId: f.card.id } });
  expect(nativeSessionFailureSourceCode(error)).toBe(NATIVE_ADDRESSED_INTERACTION_FAILED);
  expect(await readNativeAddressedInteractionFailure(db, f.binding, error)).toEqual({ interactionId: f.card.id, state: "pending" });
  await f.terminalizeNoticeFixture();
  expect(await appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id, error)).toBeTruthy();
  expect(await appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id, error)).toBeNull();
  expect(await f.comments()).toEqual([expect.objectContaining({ authorType: "system", authorAgentId: null, authorUserId: null,
    clientRequestId: `native-addressed-failure:${f.card.id}` })]);
  expect(await f.audits()).toEqual([expect.objectContaining({ details: expect.objectContaining({ refusalReason: reason }) })]);
  expect(await f.task()).toEqual(taskBefore);
  expect(await f.cards()).toEqual(cardBefore);
  expect(await f.kaRun()).toEqual(ownerBefore);
});

it("classifies a real F2 download-time card cancellation as terminal, denies the grant and emits no pending line", async () => {
  const f = await fixture();
  const workspaceRoot = path.join(root, f.binding.runId);
  await mkdir(workspaceRoot);
  const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "storage")));
  const comment = await issueService(db).addComment(f.binding.issueId, "Read the attached card file.", { userId: "inbound-user" });
  const stored = await storage.putFile({ companyId: f.binding.companyId, namespace: `issues/${f.binding.issueId}`,
    originalFilename: "card.txt", contentType: "text/plain", body: Buffer.from("REAL_CARD_DOWNLOAD_INPUT\n") });
  const attachment = await issueService(db).createAttachment({ issueId: f.binding.issueId, issueCommentId: comment.id,
    provider: stored.provider, objectKey: stored.objectKey, contentType: stored.contentType, byteSize: stored.byteSize,
    sha256: stored.sha256, originalFilename: stored.originalFilename, createdByUserId: "inbound-user" });
  await db.update(issueThreadInteractions).set({ sourceCommentId: comment.id, originCommentIds: [comment.id] })
    .where(eq(issueThreadInteractions.id, f.card.id));
  expect(await getNativeAddressedInteractionGrant(db, f.binding)).toMatchObject({ interaction: { id: f.card.id, status: "pending" } });
  const taskBefore = await f.task(), kaBefore = await f.kaRun();
  let downloads = 0, storageReads = 0;
  const outcome = await stageNativeRunnerWakeAttachments({ db,
    binding: { ...f.binding, workspaceRoot, executionTargetKind: "local" },
    storage: { ...storage, getObject: (...args) => { storageReads++; return storage.getObject(...args); } },
    downloadRemoteAttachment: async source => {
      downloads++;
      expect(source).toMatchObject({ attachmentId: attachment.id, sourceCommentId: comment.id, kind: "wake" });
      await db.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: new Date() })
        .where(eq(issueThreadInteractions.id, f.card.id));
      return "/runner/download-cache/card.txt";
    },
  }).then(stage => ({ stage, error: null as unknown }), error => ({ stage: null, error: error as unknown }));
  try {
    expect(downloads).toBe(1);
    expect(storageReads).toBe(0);
    expect(outcome.stage).toBeNull();
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).toMatchObject({ message: "paperclip_runner_attachment_staging_not_authorized" });
    expect(nativeSessionFailureSourceCode(outcome.error)).toBe("native_session_interrupted");
    expect(await getNativeAddressedInteractionGrant(db, f.binding)).toBeNull();
    const failure = await readNativeAddressedInteractionFailure(db, f.binding);
    expect(failure).toEqual({ interactionId: f.card.id, state: "cancelled" });
    expect(terminalDisposition(failure ? NATIVE_ADDRESSED_INTERACTION_FAILED : nativeSessionFailureSourceCode(outcome.error)))
      .toEqual({ phase: "terminal_failure", failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED, nextAttemptAt: null });
    const cancelled = await f.cards();
    await f.terminalizeNoticeFixture();
    expect(await appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id)).toBeNull();
    expect(await f.comments()).toEqual([expect.objectContaining({ id: comment.id })]);
    expect(await f.audits()).toEqual([]);
    expect(await f.cards()).toEqual(cancelled);
    expect(await f.task()).toEqual(taskBefore);
    expect(await f.kaRun()).toEqual(kaBefore);
  } finally { await outcome.stage?.cleanup(); }
});

it.each(["accepted", "rejected", "cancelled", "expired"])("retains ordinary role after %s without reopening or claiming pending", async status => {
  const f = await fixture();
  await db.update(issueThreadInteractions).set({ status, resolvedAt: new Date(),
    ...(["accepted", "rejected"].includes(status) ? { resolvedByAgentId: f.kp, resolvedByRunId: f.binding.runId,
      result: { version: 1 as const, outcome: status as "accepted" | "rejected" } } : {}),
  }).where(eq(issueThreadInteractions.id, f.card.id));
  const before = await f.cards();
  expect(await readNativeAddressedInteractionFailure(db, f.binding)).toEqual({ interactionId: f.card.id, state: status });
  expect(terminalDisposition(NATIVE_ADDRESSED_INTERACTION_FAILED).phase).toBe("terminal_failure");
  await f.terminalizeNoticeFixture();
  expect(await appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id)).toBeNull();
  expect(await f.comments()).toEqual([]);
  expect(await f.audits()).toEqual([]);
  expect(await f.cards()).toEqual(before);
});

it("does not turn role classification into permission for human-only cards or paused addressees", async () => {
  const f = await fixture();
  await db.update(issueThreadInteractions).set({ requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only" })
    .where(eq(issueThreadInteractions.id, f.card.id));
  await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.kp));
  const before = await f.cards();
  expect(await getNativeAddressedInteractionGrant(db, f.binding)).toBeNull();
  expect(await readNativeAddressedInteractionFailure(db, f.binding)).toEqual({ interactionId: f.card.id, state: "pending" });
  expect(await getNativeAddressedInteractionGrant(db, f.binding)).toBeNull();
  expect(await f.cards()).toEqual(before);
});

it("leaves ordinary assignee and nativeReview interruption disposition unchanged and excludes foreign or governed identities", async () => {
  const f = await fixture();
  const interruption = new Error("provider_stdout_closed");
  expect(await readNativeAddressedInteractionFailure(db, { ...f.binding, agentId: f.ka, runId: f.kaRunId })).toBeNull();
  expect(terminalDisposition(nativeSessionFailureSourceCode(interruption)).phase).toBe("retryable_failure");
  expect(await readNativeAddressedInteractionFailure(db, { ...f.binding, companyId: randomUUID() })).toBeNull();
  expect(await readNativeAddressedInteractionFailure(db, { ...f.binding, issueId: randomUUID() })).toBeNull();
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.binding.runId));
  for (const extra of [{ nativeReviewInteractionId: f.card.id, nativeReviewDecisionId: randomUUID() },
    { nativeReviewDecisionId: randomUUID() }, { wakeReason: "issue_commented" }, { taskId: randomUUID() }]) {
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...run!.contextSnapshot, ...extra } }).where(eq(heartbeatRuns.id, f.binding.runId));
    expect(await readNativeAddressedInteractionFailure(db, f.binding)).toBeNull();
    expect(terminalDisposition(nativeSessionFailureSourceCode(interruption)).phase).toBe("retryable_failure");
  }
  await db.update(heartbeatRuns).set({ contextSnapshot: run!.contextSnapshot }).where(eq(heartbeatRuns.id, f.binding.runId));
  for (const column of ["assigneeAgentId", "executionRunId", "checkoutRunId"] as const) {
    const before = await f.task();
    await db.update(issues).set({ [column]: column === "assigneeAgentId" ? f.kp : f.binding.runId }).where(eq(issues.id, f.binding.issueId));
    expect(await readNativeAddressedInteractionFailure(db, f.binding)).toBeNull();
    await db.update(issues).set({ [column]: before[column] }).where(eq(issues.id, f.binding.issueId));
  }
  for (const extra of [{ toolAction: {} }, { secretProposal: {} }, { target: { type: "custom", key: "native_completion_review" } }]) {
    await db.update(issueThreadInteractions).set({ payload: { ...f.card.payload, ...extra } as typeof f.card.payload }).where(eq(issueThreadInteractions.id, f.card.id));
    expect(await readNativeAddressedInteractionFailure(db, f.binding)).toBeNull();
  }
  await db.update(issueThreadInteractions).set({ payload: f.card.payload, addresseeAgentId: f.ka }).where(eq(issueThreadInteractions.id, f.card.id));
  expect(await readNativeAddressedInteractionFailure(db, f.binding)).toBeNull();
  expect(await f.comments()).toEqual([]);
});

it("keeps the existing physical ownership terminal code and forbids a pending notice for its still-running run", async () => {
  const f = await fixture();
  expect(await readNativeAddressedInteractionFailure(db, f.binding)).toBeTruthy();
  const source = nativeSessionFailureSourceCode(new Error(NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT));
  expect(source).toBe(NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT);
  expect(terminalDisposition(source)).toEqual({ phase: "terminal_failure", failureCode: source, nextAttemptAt: null });
  expect(nativeSessionRecoveryProjection({ phase: "terminal_failure", failureCode: source, agentId: f.kp }).issueStatus).toBeNull();
  await db.insert(nativeRunFinalizations).values({ ...{ companyId: f.binding.companyId, issueId: f.binding.issueId, runId: f.binding.runId },
    phase: "terminal_failure", failureCode: source, recoveryState: "blocked", nextAttemptAt: null });
  await db.update(heartbeatRuns).set({ nativePhase: "terminal_failure", errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE })
    .where(eq(heartbeatRuns.id, f.binding.runId));
  expect(await appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id)).toBeNull();
  expect(await f.comments()).toEqual([]);
});

it("rechecks pending status and exact identity under lock and rolls notice and audit back together", async () => {
  const f = await fixture();
  expect(await readNativeAddressedInteractionFailure(db, f.binding)).toBeTruthy();
  await f.terminalizeNoticeFixture();
  await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, f.card.id));
  expect(await appendNativeAddressedInteractionFailureNotice(db, f.binding, f.card.id)).toBeNull();
  expect(await f.comments()).toEqual([]);
  await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, f.card.id));
  expect(await appendNativeAddressedInteractionFailureNotice(db, f.binding, randomUUID())).toBeNull();
  await expect(db.transaction(async tx => {
    await appendNativeAddressedInteractionFailureNotice(tx as unknown as typeof db, f.binding, f.card.id);
    throw new Error("rollback_boundary");
  })).rejects.toThrow("rollback_boundary");
  expect(await f.comments()).toEqual([]);
  expect(await f.audits()).toEqual([]);
});
