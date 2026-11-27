import { randomBytes, randomUUID } from "node:crypto";
import { agents, chatConversations, chatEndpoints, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { EXECUTION_BLOCKER_PERSON_RETRY_ACTION, getExecutionBlocker } from "./execution-blocker.js";
import { EXECUTION_FINALIZATION_DEADLINE_MESSAGE } from "./execution-control-deadline.js";
import { NEW_SESSION_RETRY_NEXT_ACTION, newSessionRetryNextAction } from "./workspace-recovery-receipt.js";
import { isChatTask } from "./fresh-continuation-retry-fold.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("execution blocker PostgreSQL read projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-blocker-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}, extraEvidence: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocker fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Blocker agent", adapterType: "process", status: "active", adapterConfig: { provider: "pi_rpc" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Blocker task", status: "blocked", assigneeAgentId: agentId });
    const payload = randomBytes(128 * 1024).toString("base64");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "legacy",
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:01:00Z"),
      errorCode: "adapter_failed", error: "Fixture failure", contextSnapshot: { issueId, prompt: payload },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner", adapterConfig: { instructions: payload } }, instructions: payload },
      stdoutExcerpt: payload, ...patch,
    }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: run.id, status: "active", nextAction: "Inspect the source run.",
      evidence: { runId: run.id, ...extraEvidence } });
    return { companyId, agentId, issueId, run };
  }

  function recordRunReads(fullRows = false) {
    const reads: unknown[][] = [];
    const recorded = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = args[0] === heartbeatRuns && fullRows ? target.select().from(heartbeatRuns) : from(...args);
          if (args[0] === heartbeatRuns) {
            const execute = query.execute.bind(query);
            query.execute = async (...executeArgs: Parameters<typeof execute>) => {
              const rows = await execute(...executeArgs); reads.push(rows); return rows;
            };
          }
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    return { recorded, reads };
  }

  async function compare(f: Awaited<ReturnType<typeof fixture>>) {
    const baseline = recordRunReads(true), projected = recordRunReads();
    const expected = await getExecutionBlocker(baseline.recorded, f.companyId, f.issueId);
    const result = await getExecutionBlocker(projected.recorded, f.companyId, f.issueId);
    expect(expected).not.toBeNull();
    expect(result).toEqual(expected);
    expect(projected.reads).toHaveLength(baseline.reads.length);
    expect(projected.reads.flat()).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(projected.reads))).toBeLessThan(4096);
    expect(Buffer.byteLength(JSON.stringify(baseline.reads))).toBeGreaterThan(128 * 1024);
    return result;
  }

  it("preserves blocker and retry decisions without returning prompts, profiles, or output", async () => {
    const f = await fixture();
    expect(await compare(f)).toMatchObject({ runId: f.run.id, agentId: f.agentId, canRetry: true, canContinue: false });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
    expect(await getExecutionBlocker(db, randomUUID(), f.issueId)).toBeNull();
  });

  it("names Retry as the person's control, so an agent reading the blocker does not re-run the work", async () => {
    const f = await fixture();
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: true });
    expect(blocker!.nextAction).toBe(`Inspect the source run. ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}`);
    expect(EXECUTION_BLOCKER_PERSON_RETRY_ACTION).toMatch(/^A person can use Retry on this task/);
    expect(EXECUTION_BLOCKER_PERSON_RETRY_ACTION).toContain("Agents cannot retry it for them.");
  });

  it.each([
    { chat: false, errorCode: "adapter_failed", error: "native_controller_recovery_missing_evidence:retained_sandbox_binding", fresh: true },
    { chat: true, errorCode: "native_provider_state_incompatible", error: "lost resume state", fresh: true },
    { chat: true, errorCode: "adapter_failed", error: "ordinary provider failure", fresh: false },
    { chat: false, errorCode: "adapter_failed", error: "ordinary provider failure", fresh: false },
  ])("discloses a fresh-session Retry before the press: chat=$chat, fresh=$fresh", async ({ chat, errorCode, error, fresh }) => {
    const f = await fixture({ errorCode, error });
    if (chat) await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: "board", conversationState: "waiting" })
      .where(eq(issues.id, f.issueId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: true });
    expect(blocker?.retryStartsNewSession).toBe(fresh);
    expect(Object.hasOwn(blocker!, "retryStartsNewSession")).toBe(true);
    expect(blocker!.nextAction).toBe(`Inspect the source run. ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}`);
    expect(blocker?.retryDisclosure).toBe(fresh ? newSessionRetryNextAction(chat) : undefined);
    if (!chat) expect(blocker?.retryDisclosure ?? "").not.toMatch(/conversation|chat/);
    expect(JSON.stringify(blocker).match(/Retry starts a new session/g)?.length ?? 0).toBe(fresh ? 1 : 0);
  });

  it.each([{ provider: "codex" }, { provider: "pi_rpc", sessionContinuity: "paperclip" }, {}])(
    "discloses the configured non-continuous Retry before the press: %j", async config => {
      const f = await fixture();
      await db.update(agents).set({ adapterConfig: config }).where(eq(agents.id, f.agentId));
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
        canRetry: true, retryStartsNewSession: true, retryDisclosure: newSessionRetryNextAction(false) });
    });

  it("keeps the shared safety classification and ordinary Retry offer for Agent Chat without a channel binding", async () => {
    const f = await fixture();
    expect(await isChatTask(db, f.companyId, f.issueId)).toBe(false);
    expect(await isChatTask(db, f.companyId, randomUUID())).toBe(true);
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: "board", conversationState: "waiting" })
      .where(eq(issues.id, f.issueId));
    expect(await isChatTask(db, f.companyId, f.issueId)).toBe(true);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: true, canContinue: false,
      nextAction: `Inspect the source run. ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
    expect(blocker?.retryDisclosure).toBeUndefined();
  });

  it.each([false, true].flatMap(connected => ["failed", "cancelled"].map(status => ({ connected, status }))))(
    "preserves today's ordinary Retry / Continue offers, connected=$connected, status=$status", async ({ connected, status }) => {
    const f = await fixture(status === "cancelled" ? { status, resultJson: {
      cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
        reason: "Provider disconnected", recordedAt: "2020-01-01T00:01:00Z" },
      acpToolInventoryComplete: true, acpPendingToolCount: 0,
    } } : {});
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: "board", conversationState: "waiting" })
      .where(eq(issues.id, f.issueId));
    if (connected) {
      const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
      await db.insert(toolApplications).values({ id: applicationId, companyId: f.companyId,
        applicationKey: `chat:discord:${endpointId}`, name: "Discord", type: "chat", status: "active" });
      await db.insert(toolConnections).values({ id: connectionId, companyId: f.companyId, applicationId,
        uid: endpointId, name: "Discord", connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
      await db.insert(chatEndpoints).values({ id: endpointId, companyId: f.companyId, connectionId,
        provider: "discord", publicId: randomUUID(), assignedAgentId: f.agentId, status: "active" });
      await db.insert(chatConversations).values({ companyId: f.companyId, endpointId, issueId: f.issueId,
        externalConversationId: "discord-thread", externalLabel: "Discord thread", state: "active" });
    }
    expect(await isChatTask(db, f.companyId, f.issueId)).toBe(true);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: !connected,
      canContinue: status === "cancelled" && !connected });
    if (connected) expect(blocker?.nextAction).toBe("Send a new chat message to continue this conversation.");
    expect(blocker?.retryStartsNewSession).toBe(connected ? undefined : false);
    expect(blocker?.retryDisclosure).toBeUndefined();
    console.info("chat-offer-proof", JSON.stringify({ issueId: f.issueId, runId: f.run.id, connected, status,
      canRetry: blocker?.canRetry, canContinue: blocker?.canContinue, safetyChat: true }));
  });

  it.each(["active", "unavailable", "endpoint_removed"])("keeps the unproven connected-chat Retry actionable: %s", async state => {
    const f = await fixture({ errorCode: "native_continuation_requires_reconciliation" });
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: "board", conversationState: "waiting" })
      .where(eq(issues.id, f.issueId));
    const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: f.companyId,
      applicationKey: `chat:discord:${endpointId}`, name: "Discord", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId: f.companyId, applicationId,
      uid: endpointId, name: "Discord", connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId: f.companyId, connectionId,
      provider: "discord", publicId: randomUUID(), assignedAgentId: f.agentId, status: "active" });
    await db.insert(chatConversations).values({ companyId: f.companyId, endpointId, issueId: f.issueId,
      externalConversationId: randomUUID(), externalLabel: "Discord thread", state });
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.canRetry).toBe(state === "active");
    if (state === "active") {
      expect(blocker?.retryStartsNewSession).toBe(true);
      expect(blocker?.retryDisclosure).toContain("could not confirm the earlier run stopped");
      expect(blocker?.nextAction).toContain("You can choose Retry after reading its new-session disclosure");
      expect(blocker?.nextAction).not.toContain("Send a new chat message");
    } else {
      expect(blocker?.retryStartsNewSession).toBeUndefined();
      expect(blocker?.retryDisclosure).toBeUndefined();
      expect(blocker?.nextAction).toContain(state === "unavailable" ? "unavailable" : "removed");
    }
  });

  it("does not disclose a new-session Retry when no Retry is offered", async () => {
    const f = await fixture({ errorCode: "native_provider_state_incompatible", error: "Original failure reason" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: false, runError: "Original failure reason", nextAction: "Inspect the source run." });
    expect(blocker?.retryStartsNewSession).toBeUndefined();
    expect(blocker?.retryDisclosure).toBeUndefined();
    expect(JSON.stringify(blocker)).not.toContain("Retry starts a new session");
  });

  it("keeps an exhausted chat blocked with an honest /new stop-proof instruction", async () => {
    const f = await fixture({}, { systemRecovery: { state: "exhausted", failure: { retryClass: "recheck_evidence" } } });
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: "board", conversationState: "waiting" })
      .where(eq(issues.id, f.issueId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.nextAction).toContain("Your messages are saved.");
    expect(blocker?.nextAction).toContain("/new does not prove the earlier run stopped");
    expect(blocker?.nextAction).not.toContain("only after Paperclip confirms the stop");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
  });

  it.each([true, false])("removes legacy action disclosure from persisted reasons, Retry offered=%s", async offered => {
    const f = await fixture({ errorCode: "native_provider_state_incompatible", error: `Original reason. ${NEW_SESSION_RETRY_NEXT_ACTION}` });
    await db.update(issueRecoveryActions).set({ nextAction: `Saved reason. ${NEW_SESSION_RETRY_NEXT_ACTION}` })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    if (!offered) await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: offered, runError: "Original reason." });
    expect(blocker!.nextAction).toBe(`Saved reason.${offered ? ` ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` : ""}`);
    expect(blocker?.retryDisclosure).toBe(offered ? NEW_SESSION_RETRY_NEXT_ACTION : undefined);
    expect(JSON.stringify(blocker).match(/Retry starts a new session/g)?.length ?? 0).toBe(offered ? 1 : 0);
  });

  it("shows plain wording and Retry for a finalization deadline saved by the previous release", async () => {
    const previousReleaseText = "Inspect the failed run and verify its provider has stopped. Reconcile any uncertain external action before explicitly continuing this task.";
    const f = await fixture({ runtimeMode: "native", errorCode: "execution_finalization_deadline_exceeded",
      error: previousReleaseText, nextAction: previousReleaseText });
    await db.update(issueRecoveryActions).set({ cause: "execution_finalization_deadline_exceeded", ownerType: "board",
      nextAction: previousReleaseText }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));

    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);

    expect(blocker).toMatchObject({ canRetry: true, runError: EXECUTION_FINALIZATION_DEADLINE_MESSAGE,
      nextAction: `${EXECUTION_FINALIZATION_DEADLINE_MESSAGE} ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
    expect(JSON.stringify(blocker)).not.toMatch(/Inspect the failed run|verify its provider|Reconcile any uncertain/);
  });

  it("retains the claimed adapter and startup receipts for a cancelled pre-provider run", async () => {
    const f = await fixture({ status: "cancelled", startedAt: null, errorCode: "operator_interrupted",
      resultJson: { startupCancellation: { beforeNativeSelection: true }, startupPreparationSettledAt: "2020-01-01T00:01:00Z" } });
    expect(await compare(f)).toMatchObject({ canRetry: true, canContinue: false });
    await db.update(heartbeatRuns).set({ processPid: 424242 }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: false });
  });

  it.each(["valid", "number", "missing"])("preserves typed pre-dispatch interaction evidence (%s)", async kind => {
    const context = { source: "connection_intent.resolved", connectionIntentResolution: "existing_connection",
      interactionKind: "connection_intent", interactionStatus: "expired", mutation: "interaction",
      ...(kind === "missing" ? {} : { interactionId: kind === "valid" ? randomUUID() : 42 }) };
    const f = await fixture({ status: "cancelled", errorCode: "issue_waiting_for_response", contextSnapshot: context,
      resultJson: { stopReason: "issue_waiting_for_response", timeoutSource: "stale_queued_run_gate",
        preDispatchResponseWait: { version: 1, providerWorkStarted: false } } });
    expect(await compare(f)).toMatchObject({ canRetry: kind === "valid" });
  });

  it.each([true, false])("preserves native no-workspace evidence and cwd presence (%s)", async hasCwd => {
    const f = await fixture({ runtimeMode: "native", driverKind: "grok_bot_mcp" }, {
      workspaceRestoreFailure: "restore_unsafe_archive",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
    });
    const input = { schema: "paperclip.native-execution-input.v6",
      binding: { runId: f.run.id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId },
      provider: { kind: "grok_bot" }, workspace: { access: "none", ...(hasCwd ? { cwd: null } : {}) },
      task: { description: randomBytes(128 * 1024).toString("base64") },
      runtimeContext: { instructions: randomBytes(128 * 1024).toString("base64") } };
    await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId,
      runnerProfileJson: { ...f.run.runnerProfileJson, nativeExecutionInput: input } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await compare(f)).toMatchObject({ workspaceRepairRequired: !hasCwd, canRetry: false });
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(stored.runnerProfileJson?.nativeExecutionInput).toEqual(input);
  });

  it.each(["run", "company", "agent", "issue", "provider", "schema", "access", "workspace", "binding", "missing_binding",
    "null_input", "array_input", "scalar_input", "number_input"])(
    "does not relax native workspace recovery for invalid input (%s)", async kind => {
      const f = await fixture({ runtimeMode: "native", driverKind: "grok_bot_mcp" }, {
        workspaceRestoreFailure: "restore_unsafe_archive",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
      });
      const input: Record<string, unknown> = {
        schema: "paperclip.native-execution-input.v6",
        binding: { runId: f.run.id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId },
        provider: { kind: "grok_bot" }, workspace: { access: "none", cwd: null },
        task: { description: randomBytes(128 * 1024).toString("base64") },
      };
      const binding = input.binding as Record<string, unknown>;
      if (kind === "run") binding.runId = randomUUID();
      if (kind === "company") binding.companyId = randomUUID();
      if (kind === "agent") binding.agentId = randomUUID();
      if (kind === "issue") binding.issueId = randomUUID();
      if (kind === "provider") input.provider = { kind: "codex" };
      if (kind === "schema") input.schema = "unsupported";
      if (kind === "access") input.workspace = { cwd: null };
      if (kind === "workspace") input.workspace = "none";
      if (kind === "binding") input.binding = [];
      if (kind === "missing_binding") delete input.binding;
      const selectedInput = kind === "null_input" ? null : kind === "array_input" ? []
        : kind === "scalar_input" ? "input" : kind === "number_input" ? 42 : input;
      await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId,
        runnerProfileJson: { ...f.run.runnerProfileJson, nativeExecutionInput: selectedInput } }).where(eq(heartbeatRuns.id, f.run.id));
      expect(await compare(f)).toMatchObject({ workspaceRepairRequired: true, canRetry: false });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].runnerProfileJson?.nativeExecutionInput).toEqual(selectedInput);
    },
  );

  it.each([null, [], "scalar", 42, { issueId: 42, taskId: false }].map(context => ({ context })))("preserves decisions for malformed context $context", async ({ context }) => {
    const f = await fixture({ contextSnapshot: context as Record<string, unknown> | null });
    expect(await compare(f)).toMatchObject({ canRetry: true });
  });
});
