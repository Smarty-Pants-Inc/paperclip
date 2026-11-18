// RFL SIZE RULE: explicit task-authorized real-Postgres regression, not a helper mock test.
// Reuses rf2-n5-cont3 judge-probes' real lifecycle + completion publication boundary.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, heartbeatRunEvents, issueComments, issues, authUsers, activityLog } from "@paperclipai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../issues.js";
import { resolveHeartbeatRunResponse, splitFinalAnswerComments, TRUNCATED_FINAL_UNDELIVERABLE_TEXT } from "../heartbeat-run-summary.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "../heartbeat-run-status-payload.js";
import * as usageReceipts from "../usage-receipts.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatRunState, getAdapterSessionCodec } from "./run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "./workspaces.js";
import { createHeartbeatRunCompletion, type CompleteHeartbeatRunInput, type HeartbeatRunCompletionDependencies } from "./run-completion.js";
import { createPiEventProjector, type PiProjectedEvent } from "../../../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// No hard body limit exists in addIssueCommentSchema (validators/issue.ts:1221-1232)
// or issue_comments.body (db/schema/issue_comments.ts:38). This explicit test budget
// is 250 KiB UTF-8 per posted body INCLUDING its label/note, matching the existing
// FINAL_ANSWER_INLINE_MAX_BYTES in heartbeat-run-summary.ts:358 (rc3-c1).
// It is NOT a claim that PostgreSQL text or the comment API enforces this limit.
const COMMENT_BUDGET_BYTES = 250 * 1024;
const FAILURE_NOTE = "— The answer stopped here because the connection to the model ended mid-answer. Paperclip is continuing it from exactly this point in the next reply.";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function answerOfBytes(size: number): string {
  const start = "ANSWER-START\n";
  const end = "\nUNIQUE-POSTED-ENDING: blue heron 7319; next words belong after this.\nANSWER-END";
  const lines: string[] = [start];
  let bytes = Buffer.byteLength(start) + Buffer.byteLength(end);
  for (let i = 0; ; i++) {
    const line = `${String(i).padStart(7, "0")}: café 東京 🧭 complete paragraph; no omission, no repetition.\n`;
    if (bytes + Buffer.byteLength(line) > size) break;
    lines.push(line); bytes += Buffer.byteLength(line);
  }
  return lines.join("") + "x".repeat(size - bytes) + end;
}

// Labels occupy their own line. Accept plain, bold, bracketed or heading labels;
// remove only that line and at most one blank separator, NEVER trim answer bytes.
const PART_LABEL = /^(?:#{1,6} )?(?:\*\*|\[)?part ([1-9]\d*) of ([1-9]\d*)(?:\*\*|\])?:?\r?\n(?:\r?\n)?/iu;

function checkWholeParts(bodies: string[], storedAnswer: string) {
  expect.soft(bodies.length, "large answer must split").toBeGreaterThan(1);
  const labels = bodies.map(body => PART_LABEL.exec(body));
  const total = labels[0] ? Number(labels[0][2]) : null;
  for (const [index, body] of bodies.entries()) {
    expect.soft(/part \d+ of \d+/u.test(body), `comment ${index + 1}: missing part k of N`).toBe(true);
    expect.soft(labels[index] !== null, `comment ${index + 1}: standalone label`).toBe(true);
    if (labels[index]) {
      expect.soft(Number(labels[index]![1]), "ordered k = 1..N").toBe(index + 1);
      expect.soft(Number(labels[index]![2]), "constant N").toBe(total);
      expect.soft(Number(labels[index]![2]), "N equals actual comment count").toBe(bodies.length);
    }
  }
  const reconstructed = bodies.map((body, index) => labels[index] ? body.slice(labels[index]![0].length) : body).join("");
  expect.soft(Buffer.byteLength(reconstructed), "whole UTF-8 byte length").toBe(Buffer.byteLength(storedAnswer));
  expect.soft(sha256(reconstructed), "posted payload SHA-256 equals STORED answer").toBe(sha256(storedAnswer));
  return reconstructed;
}

type Dependencies = HeartbeatRunCompletionDependencies;
function callbacks(db: Db, realPresentation = false) {
  const state = createHeartbeatRunState(db);
  const lifecycleDeps = {
    ...state, ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
    recovery: { escalateStrandedAssignedIssue: vi.fn() },
    companySkills: { completeTestRunForIssue: vi.fn() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn(),
    getCurrentUserRedactionOptions: vi.fn<HeartbeatLifecycleDependencies["getCurrentUserRedactionOptions"]>(async () => ({ enabled: false })),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDeps);
  return {
    ...state, ...lifecycle,
    setRunStatusIfRunning: vi.fn(lifecycle.setRunStatusIfRunning),
    setWakeupStatus: vi.fn(lifecycle.setWakeupStatus),
    upsertTaskSession: vi.fn(state.upsertTaskSession),
    clearTaskSessions: vi.fn(state.clearTaskSessions),
    classifyAndPersistRunLiveness: vi.fn<Dependencies["classifyAndPersistRunLiveness"]>(async run => run),
    completeSkillTestRunForHeartbeatOutcome: vi.fn<Dependencies["completeSkillTestRunForHeartbeatOutcome"]>(async () => null),
    refreshContinuationSummaryForRun: vi.fn<Dependencies["refreshContinuationSummaryForRun"]>(async () => null),
    findRunIssueComment: vi.fn<Dependencies["findRunIssueComment"]>(realPresentation ? lifecycle.findRunIssueComment : async () => null),
    findLatestCompletedFinalAgentMessage: vi.fn<Dependencies["findLatestCompletedFinalAgentMessage"]>(realPresentation ? lifecycle.findLatestCompletedFinalAgentMessage : async () => null),
    finalizeIssueCommentPolicy: vi.fn<Dependencies["finalizeIssueCommentPolicy"]>(async () => ({ outcome: "not_applicable", queuedRun: null })),
    handleIssueReviewPathDisposition: vi.fn<Dependencies["handleIssueReviewPathDisposition"]>(async () => undefined),
    handleRunLivenessContinuation: vi.fn<Dependencies["handleRunLivenessContinuation"]>(),
    handleSuccessfulRunHandoff: vi.fn<Dependencies["handleSuccessfulRunHandoff"]>(),
    updateRuntimeState: vi.fn<Dependencies["updateRuntimeState"]>(),
    scheduleBoundedRetryForRun: vi.fn<Dependencies["scheduleBoundedRetryForRun"]>(),
    scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<Dependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
    timerClaimWasFirstHeartbeat: vi.fn<Dependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    releaseIssueExecutionAndPromote: vi.fn<Dependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
    finalizeAgentStatus: vi.fn<Dependencies["finalizeAgentStatus"]>(async () => undefined),
    enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
    issuesSvc: { addComment: vi.fn<Dependencies["issuesSvc"]["addComment"]>() },
    recovery: { reconcileLegacyContinuation: vi.fn<Dependencies["recovery"]["reconcileLegacyContinuation"]>(), reconcileResolvedDependencyWakeBackstop: vi.fn<Dependencies["recovery"]["reconcileResolvedDependencyWakeBackstop"]>() },
    getCurrentUserRedactionOptions: lifecycleDeps.getCurrentUserRedactionOptions,
    budgetHooks: {},
    runLogStore: { finalize: vi.fn<Dependencies["runLogStore"]["finalize"]>(async () => ({ bytes: 123, sha256: "log-hash", compressed: true })) },
    traceStore: { finalize: vi.fn<Dependencies["traceStore"]["finalize"]>() },
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean }>(),
  } satisfies Dependencies;
}


const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported && !process.env.PAPERCLIP_TEST_DATABASE_URL)("RFL size: real completion publisher", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    vi.spyOn(usageReceipts, "indexPendingUsageReceipts").mockResolvedValue(new Map());
    vi.spyOn(usageReceipts, "recoverPendingRunUsageReceipts").mockResolvedValue([]);
    if (process.env.PAPERCLIP_TEST_DATABASE_URL) db = createDb(process.env.PAPERCLIP_TEST_DATABASE_URL);
    else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-rfl-size");
      db = createDb(database.connectionString);
    }
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.restoreAllMocks(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function publish(size: number, failed: boolean, livePi = false, options: { many?: boolean; missing?: boolean; codex?: boolean; text?: string; corruptLabel?: boolean; legacy?: boolean; redact?: boolean } = {}) {
    const [company] = await db.insert(companies).values({ name: "RFL size", issuePrefix: `SZ${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Completing agent", adapterType: "process" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "on_demand", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, wakeupRequestId: wake.id,
      status: "running", runtimeMode: "native", responsibleUserId: "local-board" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Give the entire numbered answer",
      status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: "local-board", conversationAgentId: agent.id,
      conversationUserId: "local-board", conversationState: "active" }).returning();
    const [boundRun] = await db.update(heartbeatRuns).set({ nativeIssueId: issue.id,
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, run.id)).returning();
    const answer = options.text ?? answerOfBytes(size);
    await db.insert(authUsers).values({id: "local-board", name: "Board", email: "board@example.test", createdAt: new Date(), updatedAt: new Date()}).onConflictDoNothing();
    expect(Buffer.byteLength(answer)).toBe(size);
    let seq = 1;
    const add = async (eventType: string, payload: unknown, itemId: string | undefined = "answer") => options.redact ? callbacks(db).appendRunEvent(boundRun, { eventType, payload: { prpEvent: { eventType, ...(eventType.startsWith("turn.") ? {} : { itemId }), turnId: "rfl-size-turn", sourceEventId: `rfl-${seq++}`, payload } } }) : db.insert(heartbeatRunEvents).values({
      companyId: company.id, runId: run.id, agentId: agent.id, seq: seq++, eventType,
      payload: { prpEvent: { eventType, ...(eventType.startsWith("turn.") ? {} : { itemId }), turnId: "rfl-size-turn", sourceEventId: `rfl-${seq}`, payload } },
    });
    let liveShape: Record<string, unknown> | undefined;
    let completedPreview: string | undefined;
    if (livePi) {
      // REAL Pi producer: do not hand-author the pointer, excerpt, page sizes,
      // channel or item identity. One native delta exercises real 96 KiB paging.
      const spillDirectory = join(process.env.TASK_OUT ?? process.env.TMPDIR ?? "/tmp", `rfl-pi-spill-${run.id}`);
      const projector = createPiEventProjector({ runId: run.id, turnId: "rfl-size-turn", spillDirectory });
      projector.project({ type: "message_start", message: { role: "assistant" } });
      const projected: PiProjectedEvent[] = [
        ...((options.many || options.redact) ? Array.from({length:3000}, (_, i) => { let a=Math.floor(i*answer.length/3000), b=Math.floor((i+1)*answer.length/3000); if (a>0 && /[\uD800-\uDBFF]/u.test(answer[a-1]!)) a--; if (b<answer.length && /[\uD800-\uDBFF]/u.test(answer[b-1]!)) b--; return projector.project({type:"message_update", assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:answer.slice(a,b)}}); }).flat() : projector.project({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer } })),
        ...projector.project({ type: "message_end", message: { role: "assistant", responseId: "rfl-live-answer",
          provider: "test", model: "test-model", stopReason: "stop", content: [{ type: "text", text: answer }],
          usage: { input: 20, output: 8, cacheRead: 5, cacheWrite: 0, totalTokens: 33, cost: { total: 0.01 } } } }),
      ].filter(event => event.payload.kind === "agentMessage");
      const deltas = projected.filter(event => event.eventType === "item.delta");
      const completions = projected.filter(event => event.eventType === "item.completed");
      expect(completions).toHaveLength(1);
      const completed = completions[0]!;
      const fullText = completed.payload.fullText as { path: string; sha256: string; bytes: number };
      completedPreview = completed.payload.text as string;
      expect(completedPreview.split("\n")[0]).toBe("This answer is longer than one message (308 KB). The full text is kept; ask me to show any part.");
      if (!options.redact) expect(fullText).toEqual({ path: join(spillDirectory, `${sha256(answer).slice(0, 32)}.txt`), sha256: sha256(answer), bytes: size });
      if (!options.redact) expect(await readFile(fullText.path, "utf8")).toBe(answer);
      expect(deltas.length).toBeGreaterThan(1);
      if (!options.redact) expect(deltas.map(event => event.payload.text).join("")).toBe(answer);
      for (const event of deltas) {
        expect(event.itemId).toBe(completed.itemId);
        expect(Buffer.byteLength(JSON.stringify(event.payload.text))).toBeLessThanOrEqual(96 * 1024);
      }
      for (const event of projected) { if (options.missing && event === deltas[1]) continue; await add(event.eventType, event.payload, event.itemId); }
      if (options.missing) await import("node:fs/promises").then(fs=>fs.unlink(fullText.path));
      // Transport-owned terminal: agent_end is deliberately not settlement.
      await add("turn.completed", {}, undefined);
      liveShape = {
        nativeInput: ["message_start", "message_update:text_delta", "message_end"],
        events: [...projected.map(event => ({ eventType: event.eventType, itemId: event.itemId, kind: event.payload.kind, channel: event.payload.channel })),
          { eventType: "turn.completed", itemId: undefined }],
        completedFirstLine: completedPreview.split("\n")[0], completedTextBytes: Buffer.byteLength(completedPreview),
        completedTextJsonBytes: Buffer.byteLength(JSON.stringify(completedPreview)), fullText,
        deltaPageCount: deltas.length,
        deltaPages: deltas.map(event => ({ bytes: Buffer.byteLength(event.payload.text as string), jsonBytes: Buffer.byteLength(JSON.stringify(event.payload.text)) })),
      };
    } else if (failed) {
      // Real stored deltas (not a prebuilt candidate), then failed terminal.
      for (let offset = 0; offset < answer.length;) {
        // Do not cut a surrogate pair across separate JSON/Postgres strings.
        let end = Math.min(offset + 997, answer.length);
        if (end < answer.length && /[\uD800-\uDBFF]/u.test(answer[end - 1]!)) end--;
        const chunk = answer.slice(offset, end);
        await add("item.delta", { kind: "agentMessage", channel: "final", text: chunk });
        offset = end;
      }
      await add("turn.failed", { error: { code: "pi_provider_error" } });
    } else {
      // Explicit requested shape: the stored completed event contains WHOLE text.
      // Do not replace it with a truncated marker to manufacture an excerpt failure.
      if (options.codex) { for(let p=0;p<answer.length;p+=1000) { let end=Math.min(p+1000,answer.length); await add("item.delta", {kind:"agentMessage",channel:"final",text:answer.slice(p,end)}); } await add("item.completed", {truncated:true,byteSize:Buffer.byteLength(answer)}); } else await add("item.completed", { kind: "agentMessage", channel: "final", text: answer });
      await add("turn.completed", {});
    }
    await db.update(heartbeatRuns).set({ nextEventSeq: seq }).where(eq(heartbeatRuns.id, run.id));
    const deps = callbacks(db, true);
    const insertedIds: string[] = [];
    const clock = Date.now();
    // Same DB-backed addComment seam as the earlier judge. No selection,
    // response resolution, splitting or completion function is mocked.
    const service = issueService(db);
    deps.issuesSvc.addComment.mockImplementation(service.addComment);
    const input: CompleteHeartbeatRunInput = {
      run: boundRun, agent, issueId: issue.id, issueRef: issue, signal: new AbortController().signal,
      output: { handle: { store: "local_file", logRef: "test-log" }, outputProgressState: { pending: { bytes: 7 } },
        flushOutputProgress: vi.fn(async () => {}), stdoutExcerpt: "not the answer", stderrExcerpt: "diagnostic" },
      session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null,
        taskKey: "rfl-size", configuredModel: "test-model", sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({
          adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null,
          environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }) },
      readFailureReportSecrets: () => [],
      adapterResult: { exitCode: failed ? 1 : 0, signal: null, timedOut: false, sessionId: "provider-session",
        sessionParams: { sessionId: "provider-session" }, usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 8 },
        usageBasis: "per_run", costUsd: 0.01, provider: "test", model: "test-model", resultJson: {},
        ...(failed ? { errorCode: "pi_provider_error" } : {}) },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null },
      configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false },
      providerTraceCapture: true, onProviderTraceFinalized: vi.fn(),
      issueContext: await createHeartbeatRunPreparation(db).getIssueExecutionContext(company.id, issue.id), onLog: vi.fn(async () => {}),
    };
    await createHeartbeatRunCompletion(db, deps).completeRun(input);
    const posted = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.createdByRunId, run.id)))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    const apiComments = await service.listComments(issue.id, {companyId:company.id,order:"asc"});
    expect(apiComments.map(c=>c.body)).toEqual(posted.map(c=>c.body));
    if (options.corruptLabel) {
      const first = posted[0]!;
      await db.update(issueComments).set({ body: first.body.replace(/^part /u, "pArt ") }).where(eq(issueComments.id, first.id));
    }
    if (options.legacy) {
      await db.delete(issueComments).where(eq(issueComments.issueId, issue.id));
      await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorAgentId: agent.id, authorType: "agent", createdByRunId: run.id, body: answer });
    }
    const storedEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)).orderBy(asc(heartbeatRunEvents.seq));
    const payloadOf = (row: typeof storedEvents[number]) => (row.payload as { prpEvent?: { payload?: { text?: string } } }).prpEvent?.payload;
    const storedAnswer = failed || livePi
      ? storedEvents.filter(row => row.eventType === "item.delta").map(row => payloadOf(row)?.text ?? "").join("")
      : payloadOf(storedEvents.find(row => row.eventType === "item.completed")!)?.text ?? "";
    if (!options.missing && !options.codex && !options.redact) expect(sha256(storedAnswer), "DB fixture really stored the whole source").toBe(sha256(answer));
    let cut: unknown = null, opening: string | null = null;
    if (failed) {
      // Namespace feature detection keeps the same test runnable on rc3-c1,
      // where the continuation API does not yet exist. Absence is a RED, not skip.
      const api = await import("../fresh-continuation-fallback.js") as unknown as {
        readSourceRunCutAnswer?: (db: Db, run: typeof boundRun, issue: typeof issues.$inferSelect) => Promise<unknown>;
        freshContinuationNote: (input: Record<string, unknown>) => string;
      };
      if (api.readSourceRunCutAnswer) {
        cut = await api.readSourceRunCutAnswer(db, boundRun, issue);
        opening = api.freshContinuationNote({ runId: run.id, unverified: [], workspace: "kept", cutAnswer: cut });
      }
    }
    const freshRun = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]!;
    const selected = await deps.findRunIssueComment(run.id, company.id, issue.id, freshRun.resultJson);
    const response = resolveHeartbeatRunResponse({resultJson:freshRun.resultJson,existingComment:selected, finalAgentMessage: await deps.findLatestCompletedFinalAgentMessage(run.id,company.id)});
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,company.id));
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId,company.id));
    const consumer = { size, options, postedParts:posted.length, apiLabels:apiComments.map(c=>c.body.split("\n")[0]), selectedCommentFirstLine:selected?.body.split("\n")[0], selectedBytes:selected?Buffer.byteLength(selected.body):0, resolvedBytes:response.text?Buffer.byteLength(response.text):0, resolvedWhole:response.text===answer, wakeRows:wakes.length, newWakeRows:wakes.length-1, activityActions:activity.map(a=>a.action), statusPayload:buildHeartbeatRunStatusLiveEventPayload(freshRun), elapsedMs:Date.now()-clock };
    console.log("CONSUMER",JSON.stringify({...consumer,statusPayload:undefined,options:{...options,text:options.text?"custom":undefined}}));
    if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT,`consumer-${options.many?"many":options.missing?"missing":options.codex?"codex":options.text?"custom":failed?"failed":livePi?"live":"intact"}-${size}.json`),JSON.stringify(consumer,null,2));
    if (options.missing) { expect(posted.map(c=>c.body)).toEqual([TRUNCATED_FINAL_UNDELIVERABLE_TEXT]); return {bodies:posted.map(c=>c.body),storedAnswer:answer,opening,cut}; }
    if (process.env.TASK_OUT) {
      const path = process.env.TASK_OUT;
      await mkdir(path, { recursive: true });
      if (livePi) await writeFile(join(path, "live-pi-events.json"), JSON.stringify(storedEvents, null, 2));
      await writeFile(join(path, `size-${livePi ? "live-pi" : failed ? "failed" : "completed"}-${size}.json`), JSON.stringify({ runId: run.id, liveShape,
        commentBudgetBytes: COMMENT_BUDGET_BYTES, sourceBytes: Buffer.byteLength(storedAnswer), sourceSha256: sha256(storedAnswer),
        posted: posted.map(comment => ({ id: comment.id, bytes: Buffer.byteLength(comment.body), sha256: sha256(comment.body), body: comment.body })),
        cut, opening, successorExecuted: false }, null, 2));
    }
    for (const [index, comment] of posted.entries()) {
      expect.soft(Buffer.byteLength(comment.body), `comment ${index + 1}: UTF-8 budget including label/note`).toBeLessThanOrEqual(COMMENT_BUDGET_BYTES);
      expect.soft(comment.body.includes("The full text is kept"), "no retained-text pointer").toBe(false);
      expect.soft(comment.body.includes("ask me to show any part"), "no request-to-retrieve pointer").toBe(false);
    }
    if (livePi) {
      expect.soft(posted.length, "live final must actually be published").toBeGreaterThan(0);
      const excerpt = completedPreview!.split("Excerpt (the start of the answer, not the whole answer):\n\n")[1]!;
      expect(excerpt.length, "producer supplies a nonempty excerpt").toBeGreaterThan(0);
      for (const comment of posted) {
        const label = PART_LABEL.exec(comment.body);
        const payload = label ? comment.body.slice(label[0].length) : comment.body;
        expect.soft(payload, "must not publish the producer's excerpt alone").not.toBe(excerpt);
        expect.soft(payload, "must not publish the completed preview as the answer").not.toBe(completedPreview);
      }
    }
    return { bodies: posted.map(comment => comment.body), storedAnswer: options.codex ? answer : storedAnswer, opening, cut, response };
  }

  it("RFL SIZE RULE (1): 300 KiB COMPLETED final is whole in ordered labelled parts", async () => {
    const { bodies, storedAnswer } = await publish(300 * 1024, false);
    checkWholeParts(bodies, storedAnswer);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("RFL SIZE RULE (2): 1 MiB COMPLETED final is whole in ordered labelled parts", async () => {
    const { bodies, storedAnswer } = await publish(1024 * 1024, false);
    checkWholeParts(bodies, storedAnswer);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("RFL SIZE RULE (3): 40 KiB COMPLETED final stays one whole unlabelled comment", async () => {
    const { bodies, storedAnswer } = await publish(40 * 1024, false);
    expect(bodies).toHaveLength(1);
    expect(/part \d+ of \d+/u.test(bodies[0]!)).toBe(false);
    expect(Buffer.byteLength(bodies[0]!)).toBe(Buffer.byteLength(storedAnswer));
    expect(sha256(bodies[0]!)).toBe(sha256(storedAnswer));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("RFL SIZE RULE (5) live Pi shape over 250 KiB", async () => {
    const { bodies, storedAnswer } = await publish(300 * 1024, false, true);
    checkWholeParts(bodies, storedAnswer);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("RFL SIZE RULE (4): failed 300 KiB stream is whole, one true note, continuation quotes posted ending", async () => {
    const { bodies, storedAnswer, opening, cut } = await publish(300 * 1024, true);
    expect.soft(bodies.join("").split(FAILURE_NOTE).length - 1, "exactly one truthful failure note").toBe(1);
    expect.soft(bodies.at(-1)?.endsWith(FAILURE_NOTE) ?? false, "failure note follows all answer text").toBe(true);
    const answerBodies = [...bodies];
    if (answerBodies.at(-1) === FAILURE_NOTE) answerBodies.pop();
    else if (answerBodies.at(-1)?.endsWith("\n\n" + FAILURE_NOTE)) answerBodies[answerBodies.length - 1] = answerBodies.at(-1)!.slice(0, -("\n\n" + FAILURE_NOTE).length);
    const reallyPosted = checkWholeParts(answerBodies, storedAnswer);
    expect.soft(Boolean(cut && typeof cut === "object" && "posted" in cut && cut.posted), "source reader verifies actual posted prefix").toBe(true);
    expect.soft(opening?.includes("Continue exactly where it stopped") ?? false, "real continuation opening").toBe(true);
    const quote = opening?.match(/<<<END OF POSTED TEXT\n([\s\S]*?)\nEND OF POSTED TEXT>>>/u)?.[1];
    expect.soft(Boolean(quote?.length), "opening has a nonempty verbatim ending quote").toBe(true);
    if (quote) {
      expect.soft(reallyPosted.endsWith(quote), "quoted ending was REALLY posted").toBe(true);
      expect.soft(storedAnswer.endsWith(quote), "quote ends at the source answer's actual ending").toBe(true);
      expect.soft(quote.includes("UNIQUE-POSTED-ENDING:"), "quote includes unique ending, not an excerpt").toBe(true);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("PROBE task-run reply must be whole", async()=>{const r=await publish(307200,false);expect(sha256(r.response!.text!)).toBe(sha256(r.storedAnswer));}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("PROBE many 3000 live Pi deltas", async()=>{const r=await publish(307200,false,true,{many:true}); checkWholeParts(r.bodies,r.storedAnswer);}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("PROBE missing delta no spill whole copy", async()=>{await publish(307200,false,true,{missing:true});}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("PROBE Codex boundary marker", async()=>{const r=await publish(307200,false,false,{codex:true,text:"a".repeat(307200)});checkWholeParts(r.bodies,r.storedAnswer);}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("PROBE exact budget", async()=>{const r=await publish(256000,false);expect(r.bodies).toEqual([r.storedAnswer]);}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("PROBE budget plus one", async()=>{const r=await publish(256001,false);checkWholeParts(r.bodies,r.storedAnswer);}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("PROBE fenced code", async()=>{const text="```ts\n"+"abc😀漢é\n".repeat(30000)+"```\n"; const r=await publish(Buffer.byteLength(text),false,false,{text});const payloads=r.bodies.map((b,i)=>{let p=b.replace(/^part \d+ of \d+\n/u,"");if(i>0)p=p.slice(6);if(i<r.bodies.length-1)p=p.slice(0,-4);return p});expect(payloads.join("")).toBe(text);expect(r.bodies.map(b=>b.replace(/^part \d+ of \d+\n/u,"")).join("")).not.toBe(text);}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);


  it("EXT label corruption reply still whole via metadata", async () => {
    const r = await publish(307200, false, false, {corruptLabel:true});
    expect(sha256(r.response!.text!)).toBe(sha256(r.storedAnswer));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("EXT label corruption continuation still posted", async () => {
    const r = await publish(307200, true, false, {corruptLabel:true});
    expect((r.cut as {posted:boolean}).posted).toBe(true);
    expect(r.opening).toContain("UNIQUE-POSTED-ENDING:");
    expect((r.cut as {partial?:boolean}).partial).toBeUndefined();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("EXT old single big metadata-free comment", async () => {
    const r = await publish(307200, false, false, {legacy:true});
    expect(sha256(r.response!.text!)).toBe(sha256(r.storedAnswer));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  it("EXT redaction compare as stored real projector and lifecycle", async () => {
    const secret = "Authorization: Bearer " + "Z".repeat(40);
    const prefix = "a bearer of good news\nlantern bearer marks\n" + secret + "\nsk-" + "A".repeat(48) + "\nghp_" + "B".repeat(36) + "\n";
    const text = prefix + answerOfBytes(307200-Buffer.byteLength(prefix));
    const r = await publish(307200, false, true, {text,redact:true});
    console.log("REDACTION",JSON.stringify({posted:r.bodies.length,first:r.bodies[0]?.slice(0,300),storedStart:r.storedAnswer.slice(0,300),storedBytes:Buffer.byteLength(r.storedAnswer)}));
    expect.soft(r.bodies.length).toBeGreaterThan(1);
    expect.soft(r.bodies.join("")).not.toContain(TRUNCATED_FINAL_UNDELIVERABLE_TEXT);
    expect.soft(r.bodies.join("")).toContain("a bearer of good news");
    expect.soft(r.bodies.join("")).toContain("lantern bearer marks");
    expect.soft(r.bodies.join("")).not.toContain("Z".repeat(40));
    expect.soft(r.bodies.join("")).not.toContain("A".repeat(48));
    expect.soft(r.bodies.join("")).not.toContain("B".repeat(36));
    checkWholeParts(r.bodies,r.storedAnswer);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
