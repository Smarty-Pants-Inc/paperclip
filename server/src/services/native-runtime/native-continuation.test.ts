import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { buildNativeModelEnvelope } from "../../vendor/paperclip-runner/index.js";
const { executeNativeSession } = await import(new URL("../../../../packages/paperclip-runner/src/native-session-runtime.ts", import.meta.url).href) as Pick<typeof import("../../vendor/paperclip-runner/index.js"), "executeNativeSession">;
import { buildNativeContinuationPrompt, NATIVE_AUTOMATIC_CONTINUATION_REASONS } from "./native-continuation.js";

const issue = { title: "Original task", description: "Retain my long task brief." };
const message = { id: "new", body: "Yes, please proceed.", authorType: "user", authorId: "board", sourceTrust: "user", createdByRunId: null };
const answeredOld = { id: "old", updatedAt: "2026-01-01T00:00:00Z", receivedAt: "2026-01-01T00:00:00Z", answered: true };
const wake = {
  reason: "issue_commented",
  executionContinuation: {
    version: 1,
    objective: message.body,
    messages: [{ ...message, id: "old", body: "OLD_HISTORY" }, message],
    resumeDelta: { baseRunId: "prior", messages: [message] },
    completedWork: { summary: "OLD_SUMMARY" },
    humanResponses: [{ id: "old-question", result: { answer: "OLD_ANSWER" } }],
  },
  comments: [message], continuationSummary: { markdown: "OLD_SUMMARY" },
};
// Keep the original external-chat parameter fixtures byte-for-byte stable:
// their serialized values are part of the existing exact test names.
const receivedWake = { ...wake, executionContinuation: { ...wake.executionContinuation,
  messages: [{ ...wake.executionContinuation.messages[0]!, createdAt: answeredOld.receivedAt, updatedAt: answeredOld.updatedAt }, message],
  resumeDelta: { ...wake.executionContinuation.resumeDelta, receivedComments: [answeredOld] },
} };
const build = (value: unknown = receivedWake, previousIssue = issue) => buildNativeContinuationPrompt({ wakePayload: value, previousRunId: "prior", issue, previousIssue });

describe("native continuation event projection", () => {
  it("sends a new comment once without the unchanged brief, objective, history or summary", () => {
    const text = build()!;
    expect(text.split(message.body)).toHaveLength(2);
    for (const old of [issue.description, issue.title, "OLD_HISTORY", "OLD_SUMMARY", "OLD_ANSWER"]) expect(text).not.toContain(old);
    expect(JSON.parse(text).messages[0]).toMatchObject({ authorType: "user", body: message.body });
    expect(text.length).toBeLessThan(600);
  });
  it("uses the retained delta even when an already received steer remains in prompt-only wake IDs", () => {
    const text = buildNativeContinuationPrompt({ wakePayload: { ...receivedWake, commentIds: ["old", "new"] },
      promptOnly: true, previousRunId: "prior", issue, previousIssue: issue });
    expect(text).toBe(message.body);
    expect(text).not.toContain("OLD_HISTORY");
  });
  it("preserves the empty prompt-only fallback without a verified delta", () => {
    expect(buildNativeContinuationPrompt({ wakePayload: { ...wake, commentIds: [],
      executionContinuation: { ...wake.executionContinuation, resumeDelta: undefined } },
      promptOnly: true, previousRunId: "prior", issue, previousIssue: issue })).toBe("");
  });
  it.each([false, true])("keeps an empty retained delta off the full-bootstrap path (promptOnly=%s)", promptOnly => {
    const text = buildNativeContinuationPrompt({ wakePayload: { ...receivedWake, commentIds: ["old"], comments: [],
      executionContinuation: { ...receivedWake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [], receivedComments: [answeredOld] } } },
      promptOnly, previousRunId: "prior", issue, previousIssue: issue });
    if (promptOnly) expect(text).toBe("");
    else expect(JSON.parse(text!)).toEqual({ messages: [] });
    expect(text).not.toContain("OLD_HISTORY");
  });
  it("uses exactly the run's own wake text when its verified plain-text delta is empty", () => {
    const body = "Own wake text: $& $' $` $$ — keep this exact.";
    const text = buildNativeContinuationPrompt({ wakePayload: { ...wake, commentIds: ["new"],
      comments: [{ ...message, body, fullBody: body }],
      executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [] } } },
      promptOnly: true, previousRunId: "prior", issue, previousIssue: issue });
    expect(text).toBe(body);
  });
  it("tells a resumed turn which delivered comments an earlier turn already read", () => {
    const comment = { id: "new", body: message.body, author: { type: "user", id: "board" } };
    const marked = JSON.parse(build({ ...receivedWake, comments: [{ ...comment, readByEarlierTurn: true }] })!);
    expect(marked.readByEarlierTurn).toEqual({ messageIds: ["new"], note: expect.stringContaining("may have applied it") });
    expect(JSON.parse(build({ ...wake, comments: [comment] })!).readByEarlierTurn).toBeUndefined();
  });
  it("keeps the task widgets' app context on a resumed turn", () => {
    const appContext = "## App context (untrusted)\n\n```json\n{\"app\":\"Circleback\",\"text\":\"Selected m2\"}\n```";
    const events = JSON.parse(build({ ...wake, mcpAppContext: appContext })!);
    expect(events.appContext).toBe(appContext);
    expect(events.messages[0]).toMatchObject({ body: message.body });
    expect(JSON.parse(build()!).appContext).toBeUndefined();
  });
  it("only uses a delta whose base matches the actual previous run", () => {
    expect(build({ ...wake, executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "different", messages: [message] } } })).toBeNull();
    expect(build({ ...wake, executionContinuation: null })).toBeNull();
  });
  it("delivers the current authenticated answer once, not all prior answers", () => {
    const text = build({ ...wake, interactionId: "new-question", executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [] }, humanResponses: [...wake.executionContinuation.humanResponses, { id: "new-question", kind: "ask_user_questions", status: "answered", resolvedByUserId: "board", result: { answer: "NEW_ANSWER" } }] } })!;
    expect(text.split("NEW_ANSWER")).toHaveLength(2);
    expect(text).not.toContain("OLD_ANSWER");
    expect(JSON.parse(text).humanResponses[0].resolvedByUserId).toBe("board");
  });
  it("includes external child completion and actual brief edits", () => {
    const text = build({ ...wake, reason: "issue_children_completed", childIssueSummaries: [{ id: "child", status: "done", summary: "CHILD_RESULT" }] }, { ...issue, description: "old brief" })!;
    expect(JSON.parse(text).taskChanges).toEqual({ description: issue.description });
    expect(text).toContain("CHILD_RESULT");
  });
  it.each([{ fallbackFetchNeeded: true }, { recovery: { cause: "interrupted" } }, { externalChatExecutionBound: true }, { reason: "issue_assigned" }])("retains bootstrap framing for special wakes: %j", (extra) => {
    expect(build({ ...wake, ...extra })).toBeNull();
  });
});


describe("plain-text external chat continuation projection", () => {
  const slackComment = { ...message, author: { type: "user", id: "board" } };
  const slackWake = {
    ...wake,
    reason: "External chat message received",
    issue: { id: "task", title: "OLD_EXACT_REPLY", description: "Started from Slack", workMode: "standard" },
    externalChatProvider: "slack", checkedOutByHarness: true,
    comments: [slackComment],
    commentIds: [message.id], latestCommentId: message.id,
    commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
    attachmentOmissions: [],
  };
  const buildChat = (value: unknown = slackWake) => buildNativeContinuationPrompt({
    wakePayload: value, previousRunId: "prior", issue: slackWake.issue,
    previousIssue: slackWake.issue,
    allowExternalChat: true,
  });
  it.each(["slack", "github"])("sends the new %s message once without prior titles, history or instructions", (externalChatProvider) => {
    const text = buildChat({ ...slackWake, externalChatProvider })!;
    expect(text).not.toBeNull();
    expect(JSON.parse(text)).toEqual({ messages: [message] });
    expect(text).not.toContain("OLD_EXACT_REPLY");
    expect(text).not.toContain("OLD_HISTORY");
    expect(text.length).toBeLessThan(600);
  });
  it("excludes edited history and prior agent output outside the current Slack delivery", () => {
    const text = buildChat({ ...slackWake, executionContinuation: {
      ...wake.executionContinuation,
      resumeDelta: { baseRunId: "prior", messages: [
        { ...message, id: "old-edited", body: "STALE_DIRECTION" },
        { ...message, id: "old-reply", authorType: "agent", body: "OLD_AGENT_REPLY" },
        message,
      ] },
    } });
    expect(JSON.parse(text!).messages).toEqual([message]);
    expect(text).not.toContain("STALE_DIRECTION");
    expect(text).not.toContain("OLD_AGENT_REPLY");
  });
  it("preserves an actual task brief edit beside the current message", () => {
    const text = buildNativeContinuationPrompt({
      wakePayload: slackWake, previousRunId: "prior", allowExternalChat: true,
      issue: { ...slackWake.issue, description: "Updated scope" }, previousIssue: slackWake.issue,
    });
    expect(JSON.parse(text!).taskChanges).toEqual({ description: "Updated scope" });
  });
  it("delivers changed GitHub configuration while retaining unchanged configuration in the provider session", () => {
    const config = { key: "a".repeat(64), instructions: "CURRENT_REVIEW_POLICY" };
    const args = { wakePayload: { ...slackWake, externalChatProvider: "github", githubReviewConfigurations: [config] },
      previousRunId: "prior", issue: slackWake.issue, previousIssue: slackWake.issue, allowExternalChat: true };
    const changed = buildNativeContinuationPrompt(args)!;
    expect(JSON.parse(changed).reviewConfigurations).toEqual([config]);
    const unchanged = buildNativeContinuationPrompt({ ...args, previousGitHubReviewConfigurationKeys: [config.key] })!;
    expect(unchanged).not.toContain(config.instructions);
    expect(JSON.parse(unchanged).messages).toEqual([message]);
    expect(buildNativeContinuationPrompt({ ...args, previousRunId: "wrong" })).toBeNull();
  });
  it("accepts the verified non-assignee chat binding", () => {
    expect(buildChat({ ...slackWake, checkedOutByHarness: false, externalChatExecutionBound: true })).not.toBeNull();
  });
  it.each([
    { comments: [{ ...slackComment, attachments: [{ id: "file" }] }] },
    { comments: [{ ...slackComment, attachments: "malformed" }] },
    { comments: [{ ...slackComment, body: "EDITED_SINCE_DELTA" }] },
    { comments: [{ ...slackComment, author: { type: "user", id: "different-user" } }] },
    { attachmentOmissions: [{ commentId: message.id, notice: "Unavailable input" }] },
    { externalChatProvider: "discord" },
    { checkedOutByHarness: false },
    { truncated: true },
    { fallbackFetchNeeded: true },
    { comments: [{ ...slackComment, bodyTruncated: true }] },
    { interactionId: "approval", interactionKind: "request_confirmation" },
    { recovery: { cause: "interrupted" } },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "wrong", messages: [message] } } },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [] } } },
    { commentIds: [message.id, "missing"], latestCommentId: "missing" },
    { commentIds: [message.id, message.id], latestCommentId: message.id },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [message, message] } } },
  ])("keeps specialized or incomplete input on the full path: %j", (extra) => {
    expect(buildChat({ ...slackWake, ...extra })).toBeNull();
  });
  it("requires the constructor to explicitly opt into chat continuation", () => {
    expect(build(slackWake)).toBeNull();
  });
});

// Embedded PostgreSQL rows exercise the saved-run coverage owner and real Runner turn composition.
describe("retained automatic wake rows", () => {
  // Keep the added stall row present when this exact gate is run on the older base.
  const reasons = [...new Set([...NATIVE_AUTOMATIC_CONTINUATION_REASONS, "issue_blocker_stalled"])];
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retained-automatic-wake-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Continuation rows", issuePrefix: `R${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", adapterType: "paperclip_runner" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const taskId = randomUUID(), sessionId = randomUUID();
    const issue = { id: taskId, identifier: "RESUME-1", title: "Continue the requested work", description: null, workMode: "standard" };
    await db.insert(issues).values({ id: taskId, companyId, title: issue.title, status: "in_progress", assigneeAgentId: agentId });
    const history = Array.from({ length: 10 }, (_, index) => ({ id: randomUUID(), companyId, issueId: taskId, authorType: "user" as const, authorUserId: "board",
      body: `SAVED_HISTORY_${index}:` + "h".repeat(34000), createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)), updatedAt: new Date("2026-01-01T01:00:00Z") }));
    await db.insert(issueComments).values(history);
    const baseline = await buildExecutionContinuation({ db, companyId, issueId: taskId, agentId, context: {}, summary: null, exposeLowTrustRaw: false });
    const args = { companyId, agentId, provider: "pi_rpc" as const, sessionContinuity: "continuous" as const, normalizedSessionId: sessionId, issue, taskPrompt: "Continue the requested work.",
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Continue", criteria: [{ id: "output", requirement: "Finish the requested work" }] } } };
    let priorId = randomUUID();
    let previousInput = buildNativeExecutionInput({ ...args, runId: priorId, wakePayload: { reason: "issue_assigned", executionContinuation: baseline } });
    async function save(runId: string, snapshot: typeof baseline, execution = previousInput) {
      const identity = { runId, companyId, agentId, issueId: taskId, sessionId };
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", nativeIssueId: taskId, nativeSessionId: sessionId, status: "succeeded",
        contextSnapshot: { issueId: taskId, executionContinuation: snapshot },
        runnerProfileJson: { nativeExecutionInput: execution, sessionCheckpoint: {
          sessionId: "retained-driver", identity, providerSessionId: "provider-generation-1", cursor: "99",
        } }, resultJson: { continuousReplies: { delivered: { questionCommentIds: snapshot.messages.map(message => message.id) } } } });
      await db.insert(heartbeatRunEvents).values([
        { companyId, runId, agentId, seq: 0, sourceSeq: 1, sourceEventId: `${runId}:session`, eventType: "session.resumed",
          payload: { prpEvent: { normalizedSessionId: sessionId, payload: { providerSessionId: "provider-generation-1" } } } },
        { companyId, runId, agentId, seq: 1, sourceSeq: 2, sourceEventId: `${runId}:accepted`, eventType: "turn.accepted", stream: "system", level: "info",
          payload: { prpEvent: { normalizedSessionId: sessionId, turnId: `${runId}:turn`, payload: {} } } },
        { companyId, runId, agentId, seq: 2, sourceSeq: 3, sourceEventId: `${runId}:output`, eventType: "item.completed",
          payload: { prpEvent: { normalizedSessionId: sessionId, turnId: `${runId}:turn`, payload: { kind: "agentMessage", channel: "final", text: "Recorded turn result" } } } },
      ]);
    }
    await save(priorId, baseline);
    let wakeNumber = 0;
    const deliveredItems: string[] = [];
    return { args, taskId, sessionId, baseline, previousInput, priorId, historyBytes: Buffer.byteLength(history.map(m => m.body).join("")),
      async next(reason: string, options: { noDelta?: boolean; newItems?: boolean; patch?: Record<string, unknown> } = {}) {
        const runId = randomUUID(), previousRunId = priorId;
        wakeNumber++;
        const body = `NEW_PERSON_ITEM_${runId}`, childResult = `NEW_CHILD_RESULT_${runId}`, appContext = `NEW_OWED_WIDGET_EVENT_${runId}`;
        const stallItems = reason === "issue_blocker_stalled" ? [`STALLED_TASK_${runId}`, `RECOVERY_ACTION_${runId}`, `BOARD_NEEDS_${runId}`] : [];
        let commentId: string | undefined;
        if (options.newItems) {
          commentId = randomUUID();
          await db.insert(issueComments).values({ id: commentId, companyId, issueId: taskId, authorType: "user", authorUserId: "board", body,
            createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, wakeNumber)), updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, wakeNumber)) });
        }
        const snapshot = await buildExecutionContinuation({ db, companyId, issueId: taskId, agentId, runId, previousContextRunId: priorId,
          nativeSessionId: sessionId, nativeProviderSessionId: "provider-generation-1", context: { wakeReason: reason, ...(commentId ? { commentId } : {}) }, summary: null, exposeLowTrustRaw: false });
        expect(snapshot.resumeDelta?.messages.map(m => m.id)).toEqual(commentId ? [commentId] : []);
        if (options.noDelta) delete snapshot.resumeDelta;
        const [current] = await db.select().from(issues).where(eq(issues.id, taskId));
        const wakePayload = { reason, issue: { ...issue, status: current!.status }, executionContinuation: snapshot,
          ...(stallItems.length ? { dependencyBlockedInteraction: true, blockerStall: {
            stalledIssueId: randomUUID(), stalledIssueTitle: stallItems[0], stalledIssueStatus: "blocked", relation: "child",
            recoveryAction: { kind: stallItems[1], cause: "provider unavailable", status: "waiting", ownerType: "board", nextAction: stallItems[2] },
          } } : {}),
          ...(commentId ? { commentIds: [commentId], latestCommentId: commentId, comments: [{ id: commentId, body, author: { type: "user", id: "board" } }],
            childIssueSummaries: [{ id: "child", status: "done", summary: childResult }], unresolvedBlockerIssueIds: ["owed-blocker"], mcpAppContext: appContext } : {}) };
        const input = buildNativeExecutionInput({ ...args, runId, resumedSession: true,
          previousTurn: { runId: previousRunId, task: issue, nativeExecutionInput: previousInput }, wakePayload, ...options.patch });
        const envelope = buildNativeModelEnvelope(input, { resumedSession: true });
        const prompt = "events" in envelope ? envelope.events : envelope.task.prompt;
        // This is the real Runner startTurn boundary, not a substitute prompt renderer.
        const identity = { ...input.binding, sessionId };
        const checkpoint = { backendKind: "mock" as const, sessionId: "retained-driver", identity, providerSessionId: "provider-generation-1", cursor: "99", activeTurnId: null,
          pendingRuntimeRequests: [], lineage: [], workingDirectory: "/workspace" };
        let turnPrompt = "", turns = 0;
        const session = { identity: () => identity, async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() {}, async result() { return null; }, async snapshot() { return checkpoint; }, async close() {},
          async startTurn(turn: { message: { text: string } }) { turns++; turnPrompt = turn.message.text; throw new Error("captured-retained-turn"); } };
        await expect(executeNativeSession({ input, persistedSession: checkpoint,
          backend: { async descriptor() { return { kind: "mock", name: "retained-row", version: "1", capabilities: await session.capabilities(), runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
            async openSession() { return session; }, async recoverSession() { return { recovered: true, session }; } },
          controlPlane: { async openRun() {}, async checkpointSession() {}, async completeRun() {}, async appendEvent(event) { const seq = "sourceSeq" in event ? event.sourceSeq : 0; return { cursor: seq, highestContiguousSourceSeq: seq, disposition: "committed" }; }, async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } },
          runnerInstanceId: "runner", controlPlaneInstanceId: "controller",
        })).rejects.toThrow("captured-retained-turn");
        const owedItems = [...(options.newItems ? [body, childResult, appContext, "owed-blocker"] : []), ...stallItems];
        const priorItemOccurrences = deliveredItems.map(item => turnPrompt.split(item).length - 1);
        console.info("AUTOMATIC_WAKE_ROW " + JSON.stringify({ reason, noDelta: !!options.noDelta, newItems: !!options.newItems, wakeNumber, taskId, previousRunId, runId, sessionId, historyBytes: Buffer.byteLength(baseline.messages.map(m => m.body).join("")),
          promptBytes: Buffer.byteLength(prompt), turnPromptBytes: Buffer.byteLength(turnPrompt), turns, containsHistory: turnPrompt.includes("SAVED_HISTORY_"),
          owedOccurrences: owedItems.map(item => turnPrompt.split(item).length - 1), priorItemOccurrences,
          promptPreview: prompt.slice(0, 1200) }));
        await save(runId, snapshot, input); priorId = runId; previousInput = input;
        if (options.newItems) deliveredItems.push(body, childResult, appContext);
        deliveredItems.push(...stallItems);
        return { input, prompt, turnPrompt, turns, body, childResult, appContext, owedItems, priorItemOccurrences };
      } };
  }
  // Start the gate with three EMPTY deltas: automatic intent must still create a short turn.
  it.each(reasons.flatMap(reason => [false, true].flatMap(noDelta => [false, true].map(newItems => [reason, noDelta, newItems] as const))))("starts three flat %s turns on the same retained session (no delta: %s, new items: %s)", async (reason, noDelta, newItems) => {
    const f = await fixture(), bytes: number[] = [];
    expect(f.historyBytes).toBeGreaterThan(340000);
    const rows = [];
    for (let wake = 1; wake <= 3; wake++) rows.push(await f.next(reason, { noDelta, newItems }));
    for (const row of rows) {
      bytes.push(Buffer.byteLength(row.prompt));
      expect(row.turns).toBe(1);
      expect(row.priorItemOccurrences.every(count => count === 0)).toBe(true);
      expect(row.turnPrompt).not.toContain("SAVED_HISTORY_");
      expect(row.prompt).toContain(`resumed: ${reason.replaceAll("_", " ")}`);
      expect(row.prompt).toMatch(/continue/i);
      expect(row.prompt).toContain("in_progress");
      for (const item of row.owedItems) {
        expect(row.prompt.split(item)).toHaveLength(2);
        expect(row.turnPrompt.split(item)).toHaveLength(2);
      }
      if (reason === "issue_blocker_stalled") {
        expect(row.turnPrompt).toContain("then stop");
        expect(row.turnPrompt).toContain("Do not redo the dependency's assigned work");
      }
      expect(bytes.at(-1)).toBeLessThan(8192);
    }
    expect(new Set(bytes).size).toBe(1);
  });
  it.each(reasons.flatMap(reason => [false, true].map(noDelta => [reason, noDelta] as const)))("keeps %s small and starts a turn with every newly owed item once (no delta: %s)", async (reason, noDelta) => {
    const f = await fixture();
    const row = await f.next(reason, { newItems: true, noDelta });
    expect(row.turns).toBe(1);
    expect(Buffer.byteLength(row.prompt)).toBeLessThan(8192);
    expect(row.turnPrompt).not.toContain("SAVED_HISTORY_");
    expect(row.prompt).toContain(`resumed: ${reason.replaceAll("_", " ")}`);
    expect(row.prompt).toContain("in_progress");
    expect(row.prompt).toMatch(/continue/i);
    for (const item of row.owedItems) expect(row.prompt.split(item)).toHaveLength(2);
  });
  it.each([false, true])("keeps the selected-turn byte guard and source attribution for automatic wakes (unclaimed: %s)", async unclaimed => {
    const f = await fixture();
    const newest = { ...f.baseline.messages.at(-1)!, id: randomUUID(), body: "NEW_OVERSIZED_PERSON_MESSAGE:" + "n".repeat(600000) };
    const snapshot = { ...f.baseline, messages: [...f.baseline.messages, newest], resumeDelta: { baseRunId: f.priorId, messages: [newest] } };
    try {
      buildNativeExecutionInput({ ...f.args, runId: randomUUID(), resumedSession: true, boundCommandBytes: true,
        previousTurn: { runId: f.priorId, task: f.args.issue, nativeExecutionInput: f.previousInput },
        wakePayload: { reason: "issue_continuation_needed", issue: { ...f.args.issue, status: "in_progress" }, nativeTaskUnclaimed: unclaimed, executionContinuation: snapshot } });
      throw new Error("oversized automatic wake admitted");
    } catch (error) {
      expect(error).toMatchObject({ code: "native_turn_prompt_exceeds_command_bound", promptCause: { kind: "newest_message", bytes: Buffer.byteLength(newest.body) } });
    }
  });
  it.each(["fresh", "unknown previous session", "session mismatch", "run mismatch", "delta mismatch", "conversation reset", "attachment", "question", "approval", "provider update", "unclaimed", "stall without context"])("preserves required bootstrap or specialized framing: %s", async kind => {
    const f = await fixture();
    const snapshot = { ...f.baseline, resumeDelta: { baseRunId: f.priorId, messages: [] } };
    const previous = structuredClone(f.previousInput);
    if (kind === "session mismatch") previous.session.normalizedSessionId = randomUUID();
    if (kind === "run mismatch") previous.binding.runId = randomUUID();
    if (kind === "delta mismatch") snapshot.resumeDelta.baseRunId = randomUUID();
    const wakePayload = { reason: kind === "stall without context" ? "issue_blocker_stalled" : "issue_continuation_needed", issue: { ...f.args.issue, status: "in_progress" }, executionContinuation: snapshot,
      ...(kind === "attachment" ? { attachmentOmissions: [{ commentId: "file", notice: "Unavailable attachment" }] } : {}),
      ...(kind === "question" ? { questionResponse: { interactionId: "question", summaryMarkdown: "Selected choice" } } : {}),
      ...(kind === "approval" ? { interactionId: "approval", interactionKind: "request_confirmation" } : {}),
      ...(kind === "provider update" ? { chatCompletionUpdates: [{ body: "Provider update" }] } : {}),
      ...(kind === "unclaimed" ? { nativeTaskUnclaimed: true } : {}) };
    const input = buildNativeExecutionInput({ ...f.args, runId: randomUUID(), resumedSession: kind !== "fresh", conversationMode: kind === "conversation reset",
      previousTurn: { runId: f.priorId, task: f.args.issue, ...(kind === "unknown previous session" ? {} : { nativeExecutionInput: previous }) }, wakePayload });
    if (kind === "unclaimed") {
      expect(input.continuationPrompt).toContain("without an accepted completion report");
      expect(input.continuationPrompt).not.toContain("SAVED_HISTORY_");
    } else {
      expect(input.continuationPrompt ?? null).toBeNull();
      expect(input.task.prompt).toContain("SAVED_HISTORY_");
    }
  });
});
