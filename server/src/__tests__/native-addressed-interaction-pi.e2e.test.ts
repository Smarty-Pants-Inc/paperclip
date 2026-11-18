import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueThreadInteractions,
  agentWakeupRequests, issueComments, issueAttachments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertNativePiHomeProof, prepareNativePiHomeProof, readNativePiHomeProof } from "./helpers/native-pi-home-load-proof.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

const fixture = process.env.PAPERCLIP_PI_E2E_HOME_FIXTURE;
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
type Decision = "accept" | "reject";
type Run = typeof heartbeatRuns.$inferSelect;
type Card = typeof issueThreadInteractions.$inferSelect;
type Bundle = ReturnType<typeof import("../vendor/paperclip-runner/index.js").createRunnerdCodexTransport>;
type FileProof = { id: string; commentId: string; filename: string; text: string; sha256: string; issueId: string };
type ScriptCall = { id: string; key: string; name: string; input: Record<string, unknown>; result?: any };
type Ownership = Pick<typeof issues.$inferSelect, "assigneeAgentId" | "assigneeUserId" | "executionRunId" | "checkoutRunId" | "executionAgentNameKey" | "executionLockedAt" | "status" | "statusVersion">;
type InjectedFailure = { runId: string; cardId: string; at: number; ownership: Ownership; privateCanary: string };

it.skipIf(!enabled)("F3: separate legitimate KA creator turns yield A/B; real later owners survive KP responses, C staging failure and fresh D with inert duplicate", async () => {
  expect(process.platform).toBe("linux");
  expect(fixture && existsSync(join(fixture, "SHA256SUMS")), "qualified public Pi home is required, not a silent skip").toBe(true);
  expect(process.env.PAPERCLIP_PI_E2E_EVIDENCE).toBeTruthy();
  expect(process.env.PAPERCLIP_PI_E2E_PROTOCOL).toBe("messages");
  expect(process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL).toBe("xhigh");
  expect(process.env.PAPERCLIP_RUNNER_BINARY).toBeTruthy();
  expect(process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH).toBeTruthy();
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE!, "f3-cardwake-"));
  const workspaces = { ka: join(root, "workspace-ka"), kp: join(root, "workspace-kp") };
  await Promise.all(Object.values(workspaces).map(path => mkdir(path)));
  const marker = `F3_${randomUUID()}`;
  const stages: Array<{ at: string; name: string; detail: unknown }> = [];
  const requests: any[] = [];
  const nativeReceipts: any[] = [];
  const files: FileProof[] = [];
  const calls = new Map<string, ScriptCall[]>();
  const bundles: Bundle[] = [];
  const addressedRuns = new Map<Decision, string>();
  const decisions: Decision[] = ["accept", "reject"];
  const statuses = { accept: "accepted", reject: "rejected" } as const;
  const cards = new Map<Decision, Card>();
  const continuationsSeen = new Set<string>();
  const creatorRuns = new Map<Decision, string>();
  const ownerRuns = new Map<number, string>();
  const holdingOwners = new Map<string, { runId: string; ownership: Ownership }>();
  const governedYields: unknown[] = [];
  let allowB = false;
  let primaryError: string | undefined;
  const terminalScripts = new Set<string>();
  const pendingObserved = new Set<string>();
  const homes = new Map<string, Awaited<ReturnType<typeof prepareNativePiHomeProof>>>();
  const injectedCode = "paperclip_runner_attachment_staging_not_authorized";
  const responseFailureCode = "native_addressed_interaction_failed";
  const failureCardKey = `${marker}:failure-C`;
  const nextCardKey = `${marker}:next-D`;
  const userEventReceipts: unknown[] = [];
  let failureCardArmed = false;
  let releaseKA = false;
  let kaOwnership: Ownership | undefined;
  let nextCard: Card | undefined;
  let nextRunId: string | undefined;
  let duplicateObserved: unknown;
  let injectedFailure: InjectedFailure | undefined;
  let injectionClaimed = false;
  let failureNoteId: string | undefined;
  let failureObserved: unknown;
  let db: ReturnType<typeof createDb> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
  let http: Server | undefined;
  let model: Server | undefined;
  let apiUrl = "", companyId = "", agentKA = "", agentKP = "", issueId = "", otherIssueId = "", sourceRunId = "";
  let changed: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let fixtureFailure: Error | undefined;
  let hello = 0, serial = 0, passed = false;
  const sourceComments = new Map<Decision, string>();
  let commonCommentId = "";
  const stage = (name: string, detail: unknown = {}) => {
    stages.push({ at: new Date().toISOString(), name, detail });
    console.log(`[f3-cardwake] ${name} ${JSON.stringify(detail)}`);
    changed?.();
  };
  const allRuns = () => db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  const taskCards = () => db!.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
  const task = async () => (await db!.select().from(issues).where(eq(issues.id, issueId)))[0]!;
  const taskOwnership = (issue: typeof issues.$inferSelect): Ownership => ({
    assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
    executionRunId: issue.executionRunId, checkoutRunId: issue.checkoutRunId,
    executionAgentNameKey: issue.executionAgentNameKey, executionLockedAt: issue.executionLockedAt,
    status: issue.status, statusVersion: issue.statusVersion,
  });
  const isKnownInjectedFailure = (run: Run) => !!injectedFailure && run.id === injectedFailure.runId
    && run.agentId === agentKP && run.companyId === companyId && run.nativeIssueId === issueId
    && run.contextSnapshot?.interactionId === injectedFailure.cardId
    && run.status === "failed" && run.errorCode === responseFailureCode;
  const wait = async <T>(label: string, probe: () => Promise<T | null>, timeout = 120_000): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (fixtureFailure) throw fixtureFailure;
      const value = await probe();
      if (value !== null) return value;
      if (db && companyId) {
        const failed = (await allRuns()).find(run => ["failed", "timed_out", "cancelled"].includes(run.status) && !isKnownInjectedFailure(run));
        if (failed) throw new Error(`${label}: unexpected actual run failure ${JSON.stringify({ id: failed.id, status: failed.status, errorCode: failed.errorCode, error: failed.error })}`);
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { changed = undefined; resolve(); }, 250);
        changed = () => { clearTimeout(timer); changed = undefined; resolve(); };
      });
    }
    throw new Error(`Timed out: ${label}`);
  };
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(`${apiUrl}/api${path}`, {
      method, headers: { "content-type": "application/json", origin: apiUrl }, signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(response.status, `${method} ${path}: ${text}`).toBe(expected);
    return JSON.parse(text);
  };
  const upload = async (targetIssueId: string, commentId: string, filename: string) => {
    const text = `${marker}:BYTES:${filename}:${randomUUID()}\n`;
    const body = new FormData();
    body.set("issueCommentId", commentId);
    body.set("file", new Blob([text], { type: "text/plain" }), filename);
    const response = await fetch(`${apiUrl}/api/companies/${companyId}/issues/${targetIssueId}/attachments`, {
      method: "POST", headers: { origin: apiUrl }, body, signal: AbortSignal.timeout(30_000),
    });
    const output = await response.text();
    expect(response.status, output).toBe(201);
    const saved = JSON.parse(output);
    expect(saved.issueCommentId).toBe(commentId);
    files.push({ id: saved.id, commentId, filename, text, sha256: createHash("sha256").update(text).digest("hex"), issueId: targetIssueId });
    return saved;
  };
  const envelopes = (messages: any[]) => messages.flatMap(message => {
    if (message.role !== "user") return [];
    return (typeof message.content === "string" ? [{ text: message.content }] : message.content ?? []).flatMap((part: any) => {
      try { const value = JSON.parse(part.text); return value.schema === "paperclip.native-model-envelope.v3" ? [value] : []; }
      catch { return []; }
    });
  });
  const resultText = (result: any): string => typeof result.content === "string" ? result.content
    : (result.content ?? []).map((part: any) => part.text ?? "").join("\n");
  const send = (response: ServerResponse, call?: ScriptCall, text = "Coordination only; no underlying action is authorized.") => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (type: string, value: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(value as object) })}\n\n`);
    emit("message_start", { message: { id: `msg-${++serial}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
    emit("content_block_start", { index: 0, content_block: call ? { type: "tool_use", id: call.id, name: call.name, input: {} } : { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    emit("message_stop", {});
    response.end();
  };
  const ownership = async (run: Run) => {
    const issue = await task();
    expect(issue.assigneeAgentId, "KP never becomes task assignee").toBe(agentKA);
    if (run.agentId === agentKP) {
      expect(issue.executionRunId, "KP never steals execution lock").not.toBe(run.id);
      expect(issue.checkoutRunId, "KP never steals checkout lock").not.toBe(run.id);
      const cardId = run.contextSnapshot?.interactionId;
      const phase = cardId === cards.get("accept")?.id ? "A" : "BCD";
      const holder = holdingOwners.get(phase);
      expect(holder, `${phase}: a real later KA turn must hold execution and checkout`).toBeDefined();
      expect(taskOwnership(issue), `${phase}: KP cannot change any physical KA ownership/status field`).toEqual(holder!.ownership);
      expect(issue.companyId).toBe(companyId);
      expect(issue.id).toBe(issueId);
      expect(issue.executionRunId).toBe(holder!.runId);
      expect(issue.checkoutRunId).toBe(holder!.runId);
      expect((await allRuns()).find(candidate => candidate.id === holder!.runId)).toMatchObject({
        companyId, agentId: agentKA, nativeIssueId: issueId, runtimeMode: "native", status: "running",
      });
    }
    for (const id of [issue.executionRunId, issue.checkoutRunId].filter(Boolean)) {
      expect((await allRuns()).find(candidate => candidate.id === id)?.agentId, "any held task lock belongs to KA").toBe(agentKA);
    }
    stage("task ownership observed", { observingRunId: run.id, assigneeAgentId: issue.assigneeAgentId,
      executionRunId: issue.executionRunId, checkoutRunId: issue.checkoutRunId,
      executionAgentNameKey: issue.executionAgentNameKey, executionLockedAt: issue.executionLockedAt, status: issue.status });
    return issue;
  };
  const expectedFiles = async (card: Card) => {
    const origins = new Set([card.sourceCommentId, ...card.originCommentIds].filter((id): id is string => typeof id === "string"));
    const current = await db!.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId));
    return files.filter(file => file.issueId === issueId && origins.has(file.commentId)
      && current.some(row => row.id === file.id && row.companyId === companyId && row.issueCommentId === file.commentId));
  };
  const assertPendingFailureBoundary = async () => {
    expect(injectedFailure).toBeDefined();
    const failure = injectedFailure!;
    const runs = await allRuns();
    const failed = runs.find(run => run.id === failure.runId)!;
    expect(failed, "the exact injected automatic run is terminal, not a restart-recovery wait").toMatchObject({
      id: failure.runId, companyId, agentId: agentKP, status: "failed", runtimeMode: "native", nativeIssueId: issueId,
      errorCode: responseFailureCode, scheduledRetryAt: null,
    });
    expect(failed.finishedAt).toBeInstanceOf(Date);
    expect(failed.finishedAt!.getTime() - failure.at, "failure becomes terminal within 15 seconds, not fifteen-minute restart recovery").toBeLessThanOrEqual(15_000);
    const coordinators = await db!.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, failure.runId));
    expect(coordinators).toHaveLength(1);
    expect(coordinators[0]).toMatchObject({ companyId, issueId, phase: "terminal_failure", failureCode: responseFailureCode,
      recoveryState: null, recoveryRequestId: null, nextAttemptAt: null, controlDeadlineAt: null, leaseOwner: null, leaseExpiresAt: null });
    expect(JSON.stringify(coordinators)).not.toMatch(/awaiting_retry|awaiting_runner_reattach|native_restart_recovery_blocked/);
    expect(runs.filter(run => run.retryOfRunId === failure.runId), "native automatic RETRY is not executed by this fixture").toEqual([]);
    expect(runs.filter(run => run.agentId === agentKP && run.contextSnapshot?.interactionId === failure.cardId), "no automatic duplicate turn for the failed pending card").toEqual([failed]);
    expect(requests.some(request => request.runId === failure.runId), "injection is before any business model request; model HTTP 500 is never the fault").toBe(false);
    expect(calls.has(failure.runId)).toBe(false);
    const current = (await taskCards()).find(card => card.id === failure.cardId)!;
    expect(current).toMatchObject({ status: "pending", result: null, resolvedAt: null, resolvedByAgentId: null, resolvedByRunId: null, resolvedByUserId: null });
    const publicCards = await api("GET", `/issues/${issueId}/interactions`);
    expect(publicCards.find((card: any) => card.id === failure.cardId)).toMatchObject({ status: "pending", result: null, resolvedByAgentId: null, resolvedByRunId: null, resolvedByUserId: null });
    expect(taskOwnership(await task()), "failure settlement cannot mutate any captured KA ownership field").toEqual(failure.ownership);
    expect(runs.find(run => run.id === holdingOwners.get("BCD")!.runId)?.status, "KA3 retains the live physical execution").toBe("running");
    for (const decision of decisions) expect((await taskCards()).find(card => card.id === cards.get(decision)!.id)).toMatchObject({
      status: statuses[decision], sourceRunId: creatorRuns.get(decision), resolvedByAgentId: agentKP, resolvedByRunId: addressedRuns.get(decision),
    });
    const publicComments = await api("GET", `/issues/${issueId}/comments`);
    expect(Array.isArray(publicComments)).toBe(true);
    const notes = publicComments.filter((comment: any) => !comment.deletedAt && JSON.stringify(comment).includes(failure.runId));
    expect(notes, "exactly one failure line is visible through the real issue-thread API, not only private events").toHaveLength(1);
    const note = notes[0]!;
    expect(JSON.stringify(note), "the visible note identifies this pending card").toContain(failure.cardId);
    expect(note.body).toBe("Paperclip could not handle the addressed confirmation card; it remains pending.");
    expect(note.body).toMatch(/(?:card|confirmation|response)/i);
    expect(note.body).toMatch(/(?:remain\w*|still)\s+pending/i);
    expect(note.body).not.toMatch(/automatic recovery blocked|restart.recovery.blocked|awaiting.retry/i);
    expect(JSON.stringify(note), "no private injected error cause may leak to the user-visible response").not.toContain(failure.privateCanary);
    expect(note.body).not.toMatch(/\n\s*at\s+\S+|Bearer\s+\S+/);
    if (failureNoteId) expect(note.id, "failure notice is stable, not appended again").toBe(failureNoteId);
    failureNoteId = note.id;
    const wakes = await db!.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const cardWakes = wakes.filter(wake => wake.agentId === agentKP && wake.payload?.interactionId === failure.cardId);
    expect(cardWakes, "one original pending-card wake before any fresh user event").toHaveLength(1);
    expect(cardWakes[0]).toMatchObject({ runId: failure.runId, idempotencyKey: `interaction-pending:${failure.cardId}` });
    expect(wakes.some(wake => JSON.stringify(wake.payload).includes(failureNoteId!)), "the failure note must not wake KA or KP in a loop").toBe(false);
    expect(runs.some(run => JSON.stringify(run.contextSnapshot).includes(failureNoteId!))).toBe(false);
    failureObserved = { run: failed, coordinator: coordinators[0], card: current, publicCard: publicCards.find((card: any) => card.id === failure.cardId),
      note, ownership: taskOwnership(await task()), cardWakes, observedAt: new Date().toISOString() };
    stage("terminal + visible + pending + KA unchanged observed", failureObserved);
  };
  try {
    for (const actor of ["ka", "kp"]) {
      const homeRoot = join(root, `home-${actor}`);
      await mkdir(homeRoot);
      const home = await prepareNativePiHomeProof(homeRoot, fixture!);
      const path = join(home.agentDir, "models.json");
      const models = JSON.parse(await readFile(path, "utf8"));
      models.providers.paperclip.models.push({ id: `faux-${actor}`, reasoning: true, contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } });
      await writeFile(path, JSON.stringify(models, null, 2));
      homes.set(actor, home);
    }
    for (const key of Object.keys(process.env)) if (key.startsWith("LANGFUSE_")) vi.stubEnv(key, undefined);
    vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", join(root, "storage"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_HTTPS", "off");
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    model = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { void (async () => {
        try {
          expect(new URL(request.url ?? "", "http://127.0.0.1").pathname).toBe("/v1/messages");
          const parsed = JSON.parse(body);
          if (respondToNativePiHello(parsed, response, "messages")) { hello++; return; }
          expect(["faux-ka", "faux-kp"]).toContain(parsed.model);
          const actor = parsed.model === "faux-ka" ? "ka" : "kp";
          const agentId = actor === "ka" ? agentKA : agentKP;
          const active = (await allRuns()).filter(run => run.agentId === agentId && run.status === "running");
          expect(active, "model request binds to one actual system-created running row").toHaveLength(1);
          const run = active[0]!;
          expect(run.runtimeMode).toBe("native");
          expect(run.nativeIssueId).toBe(issueId);
          const envelope = envelopes(parsed.messages ?? []).at(-1);
          expect(envelope, "real Pi receives the public native model envelope").toBeTruthy();
          const native = readNativePiHomeProof(homes.get(actor)!.receiptPath);
          expect(native?.pid, "the real native Pi process wrote its own observer receipt").toBeGreaterThan(0);
          await assertNativePiHomeProof(homes.get(actor)!, native!.pid);
          requests.push({ runId: run.id, agentId, actor, piPid: native!.pid, envelope, messages: parsed.messages,
            tools: (parsed.tools ?? []).map((tool: any) => tool.name) });
          const runCalls = calls.get(run.id) ?? [];
          calls.set(run.id, runCalls);
          const previous = runCalls.at(-1);
          if (previous && !previous.result) {
            const latest = parsed.messages.at(-1);
            const result = Array.isArray(latest?.content) ? latest.content.find((part: any) => part.type === "tool_result" && part.tool_use_id === previous.id) : undefined;
            expect(result, `${previous.key}: actual tool result must return through Pi to the model`).toBeDefined();
            previous.result = result;
            stage("actual tool result returned", { runId: run.id, key: previous.key, callId: previous.id, result });
          }
          const next = (key: string, name: string, input: Record<string, unknown>) => {
            expect((parsed.tools ?? []).map((tool: any) => tool.name)).toContain(name);
            const call = { id: `f3-call-${++serial}`, key, name, input };
            runCalls.push(call);
            stage("model requested actual tool", { runId: run.id, agentId, ...call });
            send(response, call);
          };
          const completed = (key: string) => runCalls.find(call => call.key === key && call.result);
          if (actor === "ka") {
            sourceRunId ||= run.id;
            if (run.id === sourceRunId) ownerRuns.set(1, run.id);
            if (run.contextSnapshot?.interactionId) {
              for (const row of envelope.interactionResponses ?? []) if ([...cards.values()].some(card => card.id === row.interactionId)
                && ["accepted", "rejected"].includes(row.response?.status)) continuationsSeen.add(row.interactionId);
              terminalScripts.add(run.id);
              send(response);
              return;
            }
            await wait("the real HTTP wake receipt binds the owner turn", async () => [...ownerRuns.values()].includes(run.id) ? true : null, 15_000);
            const ownerNumber = [...ownerRuns.entries()].find(([, id]) => id === run.id)![0];
            await ownership(run);
            if (!completed("checkout")) return next("checkout", "call_api", {
              operationId: "POST /api/issues/{id}/checkout", pathParams: { id: issueId },
              body: { agentId: agentKA, expectedStatuses: ["todo", "in_progress", "in_review", "blocked"] },
            });
            expect(completed("checkout")!.result.is_error).not.toBe(true);
            const snapshot = taskOwnership(await task());
            expect(snapshot.executionRunId).toBe(run.id);
            expect(snapshot.checkoutRunId).toBe(run.id);
            if (ownerNumber > 1) {
              const phase = ownerNumber === 2 ? "A" : "BCD";
              holdingOwners.set(phase, { runId: run.id, ownership: snapshot });
              if (ownerNumber === 3) kaOwnership = snapshot;
              stage("legitimate later KA owner physically holding", { ownerNumber, phase, runId: run.id, snapshot });
              await wait(ownerNumber === 2 ? "A finishes before KA2 creates B" : "B/C/D and duplicate D finish before KA3 returns", async () => (ownerNumber === 2 ? allowB : releaseKA) ? true : null);
              expect(taskOwnership(await task()), `${phase}: the held owner snapshot is unchanged before release`).toEqual(snapshot);
            }
            if (ownerNumber === 3) {
              nativeReceipts.push({ runId: run.id, actor, receipt: native });
              terminalScripts.add(run.id);
              send(response);
              return;
            }
            const decision: Decision = ownerNumber === 1 ? "accept" : "reject";
            creatorRuns.set(decision, run.id);
            const key = `create-${decision}`;
            if (!completed(key)) return next(key, "call_api", {
              operationId: "POST /api/issues/{id}/interactions", pathParams: { id: issueId }, body: {
                kind: "request_confirmation", idempotencyKey: `${marker}:${decision}`, title: `F3 ${decision} coordination`,
                summary: `${marker}:${decision}`, sourceCommentId: sourceComments.get(decision), addresseeAgentId: agentKP,
                resolverPolicy: "not_creator", continuationPolicy: "wake_assignee",
                payload: { version: 1, prompt: `${marker}:${decision}`, supersedeOnUserComment: false },
              },
            });
            expect(completed(key)!.result.is_error).not.toBe(true);
            nativeReceipts.push({ runId: run.id, actor, receipt: native });
            send(response, undefined, "Waiting for this turn's one addressed coordination response.");
            return;
          }
          expect(run.id, "the injected run must never reach the model").not.toBe(injectedFailure?.runId);
          await wait("persisted addressed card and real later KA owner hold", async () => {
            const id = run.contextSnapshot?.interactionId;
            const phase = id === cards.get("accept")?.id ? "A" : "BCD";
            return (cards.size > 0 && holdingOwners.has(phase)) ? true : null;
          });
          await ownership(run);
          const normalDecision = decisions.find(value => cards.get(value)?.id === run.contextSnapshot?.interactionId);
          const card = normalDecision ? cards.get(normalDecision)! : (await taskCards()).find(row => row.id === run.contextSnapshot?.interactionId && row.idempotencyKey === nextCardKey);
          expect(card, "every model-reaching KP run is exactly A, B or the next new user card D; C never reaches the model").toBeDefined();
          if (!card) throw new Error("Unexpected unbound KP business-model turn");
          const decision: Decision = normalDecision ?? "accept";
          const scriptKey = normalDecision ?? "next";
          expect(run.contextSnapshot).toMatchObject({ issueId, interactionId: card!.id, wakeReason: "interaction_pending" });
          if (normalDecision) {
            const prior = addressedRuns.get(normalDecision);
            expect(prior === undefined || prior === run.id, "one successful real Pi run per normal addressed card").toBe(true);
            addressedRuns.set(normalDecision, run.id);
          } else {
            expect(nextRunId === undefined || nextRunId === run.id, "D has exactly one fresh KP turn, not a failed-run reuse or duplicate").toBe(true);
            expect(run.id).not.toBe(injectedFailure?.runId);
            nextCard = card!;
            nextRunId = run.id;
          }
          expect(new Set([...addressedRuns.values(), ...(nextRunId ? [nextRunId] : [])]).size).toBe(addressedRuns.size + (nextRunId ? 1 : 0));
          const nativeTools = native!.toolExecutions ?? [];
          for (const call of runCalls.filter(call => call.result)) {
            expect(nativeTools.some((event: any) => event.type === "tool_execution_end" && event.toolCallId === call.id && event.toolName === call.name),
              `${call.key}: the real Pi observer records tool execution, not just a model response`).toBe(true);
          }
          if (!pendingObserved.has(card.id)) {
            const current = (await taskCards()).find(row => row.id === card.id)!;
            expect(current).toMatchObject({ status: "pending", result: null, resolvedAt: null, resolvedByAgentId: null, resolvedByRunId: null, resolvedByUserId: null });
            expect(envelope.interactionResponses).toContainEqual(expect.objectContaining({ interactionId: card.id,
              response: expect.objectContaining({ status: "pending", payload: expect.objectContaining({ prompt: `${marker}:${scriptKey}` }) }) }));
            pendingObserved.add(card.id);
            stage("actual pending card delivered", { runId: run.id, interactionId: card.id, scriptKey });
          }
          if (normalDecision) {
            expect(card.sourceCommentId).toBe(sourceComments.get(normalDecision));
            expect(card.originCommentIds, "the shared actual user comment is a distinct card origin").toContain(commonCommentId);
          } else {
            expect(card).toMatchObject({ sourceCommentId: commonCommentId, sourceRunId: null, createdByUserId: "local-board", createdByAgentId: null });
          }
          const expected = await expectedFiles(card);
          expect(expected.map(file => file.filename).sort()).toEqual(normalDecision ? [`${normalDecision}.txt`, "common-origin.txt"].sort() : ["common-origin.txt"]);
          const prompt = envelope.task?.prompt;
          expect(typeof prompt, "current staged descriptors are in this native turn's task prompt").toBe("string");
          const descriptors = prompt.split("\n").filter((line: string) => line.startsWith("- {")).flatMap((line: string) => {
            try { const value = JSON.parse(line.slice(2)); return typeof value.id === "string" && "workspaceRelativePath" in value ? [value] : []; }
            catch { return []; }
          });
          expect(descriptors.map((file: any) => file.id).sort(), "row sourceCommentId UNION originCommentIds REPLACES broader wake selection").toEqual(expected.map(file => file.id).sort());
          for (const descriptor of descriptors) expect(descriptor).toMatchObject({ unavailableReason: null, workspaceRelativePath: expect.any(String) });
          const forbidden = files.filter(file => !expected.some(own => own.id === file.id));
          for (const file of forbidden) {
            expect(prompt).not.toContain(file.id);
            expect(JSON.stringify(parsed.messages), "unrelated bytes are not delivered into KP history").not.toContain(file.text.trim());
          }
          if (!completed("read-staged")) {
            const paths = descriptors.map((file: any) => file.runnerLocalPath ?? file.workspaceRelativePath);
            const python = [
              "import hashlib,json,pathlib", `paths=${JSON.stringify(paths)}`,
              "files=[{'path':p,'text':pathlib.Path(p).read_text(),'sha256':hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()} for p in paths]",
              "staged=[hashlib.sha256(p.read_bytes()).hexdigest() for p in pathlib.Path('.paperclip-inbound').rglob('*') if p.is_file() and p.stat().st_size]",
              "print(json.dumps({'f3Read':True,'files':files,'staged':staged}))",
            ].join("; ");
            const shell = `'${python.replaceAll("'", "'\\''")}'`;
            return next("read-staged", "bash", { command: `python3 -c ${shell}` });
          }
          const read = completed("read-staged")!.result;
          expect(read.is_error).not.toBe(true);
          const line = resultText(read).split("\n").find(value => value.startsWith('{"f3Read":'));
          expect(line, "the actual native bash output, not a harness read, contains staged bytes").toBeDefined();
          const proof = JSON.parse(line!);
          expect(proof.files.map((file: any) => file.text).sort()).toEqual(expected.map(file => file.text).sort());
          expect(proof.files.map((file: any) => file.sha256).sort()).toEqual(expected.map(file => file.sha256).sort());
          expect(proof.staged.sort(), "KP's nonempty staging slots contain only this card's bytes").toEqual(expected.map(file => file.sha256).sort());
          if (!completed("deny-before")) return next("deny-before", "call_api", {
            operationId: "PATCH /api/issues/{id}", pathParams: { id: issueId }, body: { status: "done", assigneeAgentId: agentKP },
          });
          const assertDenied = (key: string) => {
            const result = completed(key)!.result;
            const text = resultText(result);
            expect(result.is_error === true || /"ok"\s*:\s*false/.test(text) || /"status"\s*:\s*(?:403|409)/.test(text), `${key}: actual tool must refuse unrelated downstream mutation: ${text}`).toBe(true);
            expect(text, `${key}: an arbitrary tool/HTTP failure is not authorization evidence`).toMatch(/only resolve its addressed confirmation|exact addressed response|paperclip_runner_tool_binding_not_authorized/);
          };
          assertDenied("deny-before");
          if (!completed("resolve-own")) return next("resolve-own", "call_api", {
            operationId: `POST /api/issues/{id}/interactions/{interactionId}/${decision}`,
            pathParams: { id: issueId, interactionId: card.id }, body: decision === "reject" ? { reason: "Coordination rejected; no downstream action authorized." } : {},
          });
          const current = (await taskCards()).find(row => row.id === card.id)!;
          expect(current, "only KP's actual answer tool resolves its addressed card").toMatchObject({
            status: statuses[decision!], result: { outcome: statuses[decision!] }, resolvedByAgentId: agentKP, resolvedByRunId: run.id, resolvedByUserId: null,
          });
          if (!completed("deny-after")) return next("deny-after", "call_api", {
            operationId: "PATCH /api/issues/{id}", pathParams: { id: issueId }, body: { status: "done", assigneeAgentId: agentKP },
          });
          assertDenied("deny-after");
          const unchanged = await ownership(run);
          expect(unchanged.executionRunId, "the later KA owner still holds its real task lock while KP finishes").toBe(holdingOwners.get(normalDecision === "accept" ? "A" : "BCD")!.runId);
          expect(unchanged.status).not.toBe("done");
          nativeReceipts.push({ runId: run.id, actor, receipt: native });
          terminalScripts.add(scriptKey);
          stage("KP completed actual read + response + downstream refusal script", { decision, scriptKey, cardId: card.id, runId: run.id, piPid: native!.pid });
          send(response, undefined, `Coordination ${statuses[decision!]}. No downstream action authorized or performed.`);
        } catch (error) {
          fixtureFailure = error instanceof Error ? error : new Error(String(error));
          stage("fixture assertion failed", fixtureFailure.stack);
          if (!response.headersSent) response.writeHead(500);
          response.end("F3 loopback fixture assertion failed; inspect retained evidence.");
        }
      })(); });
    });
    await new Promise<void>(resolve => model!.listen(0, "127.0.0.1", resolve));
    const modelAddress = model.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("No loopback model listener");
    temporary = await startEmbeddedPostgresTestDatabase("f3-cardwake-db-");
    db = createDb(temporary.connectionString);
    const handoff = await import("../services/native-runtime/native-runner-file-handoff.js");
    const { getNativeAddressedInteractionGrant } = await import("../services/native-runtime/native-addressed-interaction.js");
    const realStage = handoff.stageNativeRunnerWakeAttachments;
    vi.spyOn(handoff, "stageNativeRunnerWakeAttachments").mockImplementation(async input => {
      const binding = input.binding;
      if (failureCardArmed && !injectionClaimed && binding.companyId === companyId && binding.issueId === issueId && binding.agentId === agentKP) {
        const run = (await allRuns()).find(row => row.id === binding.runId);
        const card = (await taskCards()).find(row => row.companyId === companyId && row.issueId === issueId && row.addresseeAgentId === agentKP && row.id === run?.contextSnapshot?.interactionId && row.idempotencyKey === failureCardKey);
        if (card && !injectionClaimed) {
          injectionClaimed = true;
          try {
            expect(run).toMatchObject({ companyId, agentId: agentKP, nativeIssueId: issueId, runtimeMode: "native", status: "running",
              contextSnapshot: { interactionId: card.id, wakeReason: "interaction_pending" } });
            expect(card).toMatchObject({ companyId, issueId, idempotencyKey: failureCardKey, createdByAgentId: null, createdByUserId: "local-board", addresseeAgentId: agentKP,
              status: "pending", result: null, resolvedAt: null, resolvedByAgentId: null, resolvedByRunId: null, resolvedByUserId: null });
            const grant = await getNativeAddressedInteractionGrant(db!, binding, { requireRunning: true, phase: "pending" });
            expect(grant?.interaction.id, "the actual current grant is valid before the explicit stage fault; authorization is not mocked").toBe(card.id);
            const original = await ownership(run!);
            expect(original.executionRunId, "the legitimate KA3 lock is held at fault injection").toBe(holdingOwners.get("BCD")!.runId);
            expect(taskOwnership(original), "C's creation and staging cannot change the original KA snapshot").toEqual(kaOwnership);
            expect((await allRuns()).find(row => row.id === holdingOwners.get("BCD")!.runId)?.status).toBe("running");
            expect(requests.some(request => request.runId === binding.runId)).toBe(false);
            injectedFailure = { runId: binding.runId, cardId: card.id, at: Date.now(), ownership: taskOwnership(original), privateCanary: `F3_PRIVATE_ERROR_CAUSE_${randomUUID()}` };
          } catch (error) {
            fixtureFailure = error instanceof Error ? error : new Error(String(error));
            stage("stage fault precondition failed; not product evidence", fixtureFailure.stack);
            throw error;
          }
          stage("explicit one-shot stage fault injected", { runId: binding.runId, interactionId: card.id, companyId, issueId, agentId: agentKP,
            errorCode: injectedCode, ownership: injectedFailure!.ownership, grantWasReal: true });
          throw new Error(injectedCode, { cause: new Error(injectedFailure!.privateCanary) });
        }
      }
      return realStage(input);
    });
    const [{ createApp }, { createStorageService }, { createLocalDiskStorageProvider }, runner, { setupRunnerPrpWebSocketServer }, { subscribeCompanyLiveEvents }] = await Promise.all([
      import("../app.js"), import("../storage/service.js"), import("../storage/local-disk-provider.js"),
      import("../vendor/paperclip-runner/index.js"), import("../realtime/runner-prp-ws.js"), import("../services/live-events.js"),
    ]);
    const realFactory = runner.createRunnerdCodexTransport;
    vi.spyOn(runner, "createRunnerdCodexTransport").mockImplementation(options => {
      expect(options?.provider).toBe("pi_rpc");
      expect(options?.piRpcThinkingLevel).toBe("xhigh");
      const bundle = realFactory(options);
      bundles.push(bundle);
      return bundle;
    });
    app = await createApp(db, {
      uiMode: "none", serverPort: 0, storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
      authReady: true, companyDeletionEnabled: false, instanceId: `f3-${randomUUID()}`, localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
    });
    await app.locals.bundledPluginsStartup;
    http = createServer(app);
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    vi.stubEnv("PAPERCLIP_API_URL", apiUrl);
    setupRunnerPrpWebSocketServer(http, { apiUrl });
    companyId = (await api("POST", "/companies", { name: "F3 disposable real Pi addressed-card qualification" }, 201)).id;
    await api("PATCH", `/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "local-board", name: "F3 fixture operator", email: "f3@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    unsubscribe = subscribeCompanyLiveEvents(companyId, () => changed?.());
    const connection = await api("POST", `/companies/${companyId}/ai-connections`, {
      provider: "anthropic", method: "api_key", name: "Scripted credential-free loopback model", ownership: "personal", routing: {
        kind: "local", protocol: "messages", baseUrl: `http://127.0.0.1:${modelAddress.port}`, auth: "none",
        models: ["ka", "kp"].map(actor => ({ id: `faux-${actor}`, label: actor.toUpperCase(), thinkingLevels: ["xhigh"] })),
      },
    }, 201);
    const connectionBinding = { mode: "delegated", provider: "anthropic", method: "api_key", connectionId: connection.connectionId, grantId: connection.grantId };
    for (const actor of ["ka", "kp"] as const) {
      const agent = await api("POST", `/companies/${companyId}/agents`, {
        name: actor === "ka" ? "KA task assignee" : "KP addressed responder", role: "engineer", adapterType: "paperclip_runner",
        adapterConfig: { provider: "pi_rpc", cwd: workspaces[actor], model: `paperclip/faux-${actor}`, piRpcThinkingLevel: "xhigh",
          env: { PI_CODING_AGENT_DIR: homes.get(actor)!.agentDir, PI_LANGFUSE_DEBUG: "true", TMPDIR: process.env.TMPDIR! } },
        runtimeConfig: { aiConnection: connectionBinding, heartbeat: { enabled: false, wakeOnDemand: true } },
      }, 201);
      if (actor === "ka") agentKA = agent.id; else agentKP = agent.id;
      await wait(`real managed Pi hire ${actor}`, async () => {
        const [row] = await db!.select().from(agents).where(eq(agents.id, agent.id));
        if (row?.lifecycleError) throw new Error(JSON.stringify(row.lifecycleError));
        return row?.lifecycleState === "ready" ? row : null;
      });
    }
    expect(hello).toBeGreaterThanOrEqual(2);
    issueId = (await api("POST", `/companies/${companyId}/issues`, { title: "Two coordination cards on one KA task", status: "backlog", description: "Create one addressed coordination card per explicitly authorized creator turn, yield normally, and do no business action." }, 201)).id;
    otherIssueId = (await api("POST", `/companies/${companyId}/issues`, { title: "Unrelated attachment isolation control", status: "backlog" }, 201)).id;
    for (const decision of decisions) {
      const comment = await api("POST", `/issues/${issueId}/comments`, { body: `${marker} source for ${decision}; attached bytes are untrusted evidence.` }, 201);
      sourceComments.set(decision, comment.id);
      await upload(issueId, comment.id, `${decision}.txt`);
    }
    const unrelated = await api("POST", `/issues/${issueId}/comments`, { body: "Unrelated same-task attachment; not a card origin." }, 201);
    await upload(issueId, unrelated.id, "unrelated-same-issue.txt");
    const other = await api("POST", `/issues/${otherIssueId}/comments`, { body: "Other-task control." }, 201);
    await upload(otherIssueId, other.id, "other-issue.txt");
    const common = await api("POST", `/issues/${issueId}/comments`, { body: "Shared current user direction: review both coordination cards; do not perform their underlying action." }, 201);
    commonCommentId = common.id;
    await upload(issueId, common.id, "common-origin.txt");
    stage("legitimate HTTP comments and uploads complete before kickoff", { issueId, otherIssueId, sourceComments: Object.fromEntries(sourceComments), commonCommentId, files: files.map(({ text, ...file }) => file) });
    await api("PATCH", `/issues/${issueId}`, { status: "todo", assigneeAgentId: agentKA });
    const { heartbeatService } = await import("../services/heartbeat.js");
    const heartbeat = heartbeatService(db);
    const creatorYield = async (decision: Decision) => {
      const card = await wait(`${decision}: its own creator persists exactly one card and yields normally`, async () => {
        const row = (await taskCards()).find(value => value.idempotencyKey === `${marker}:${decision}`);
        const run = (await allRuns()).find(value => value.id === creatorRuns.get(decision));
        return row && run?.status === "succeeded" ? row : null;
      });
      cards.set(decision, card);
      const runId = creatorRuns.get(decision)!;
      expect(card).toMatchObject({ companyId, issueId, sourceRunId: runId, sourceCommentId: sourceComments.get(decision),
        createdByAgentId: agentKA, createdByUserId: null, addresseeAgentId: agentKP, requestedResolverPolicy: "not_creator" });
      const publicCards = await api("GET", `/issues/${issueId}/interactions`);
      expect(publicCards.find((row: any) => row.id === card.id)).toMatchObject({ resolverPolicy: "not_creator", requestedResolverPolicy: "not_creator", sourceRunId: runId });
      await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: 15_000 });
      const run = (await allRuns()).find(value => value.id === runId)!;
      expect(run.resultJson).toMatchObject({ finalizationReasonCode: "governed_response_waiting" });
      const [coordinator] = await db!.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(coordinator).toMatchObject({ phase: "committed" });
      expect(coordinator!.resultId).toBeTruthy();
      const events = await db!.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      const accepted = events.flatMap(event => {
        const prp = (event.payload as any)?.prpEvent;
        return prp?.eventType === "run.result.accepted" ? [prp.payload.result] : [];
      });
      expect(accepted).toContainEqual(expect.objectContaining({ reportedWorkDisposition: "yielded",
        continuation: expect.objectContaining({ kind: "response_wake", idempotencyKey: `interaction-response:${card.id}` }),
        evidence: expect.arrayContaining([{ ref: `interaction:${card.id}` }]) }));
      const script = calls.get(runId)!;
      expect(script.map(call => call.key)).toEqual(["checkout", `create-${decision}`]);
      const native = readNativePiHomeProof(homes.get("ka")!.receiptPath);
      for (const call of script) expect(native?.toolExecutions.some((event: any) => event.type === "tool_execution_end"
        && event.toolCallId === call.id && event.toolName === call.name && !event.isError)).toBe(true);
      governedYields.push({ decision, card, run, coordinator, accepted, script, native });
      stage("one card per actual creator turn durably yielded", { decision, runId, cardId: card.id });
    };
    const freshOwner = async (number: number) => {
      const body = { source: "on_demand", triggerDetail: "manual", reason: `${marker}:KA${number}:hold-coordination-only`,
        forceFreshSession: true, idempotencyKey: `${marker}:owner-${number}`, payload: { issueId, commentId: commonCommentId } };
      const receipt = await api("POST", `/agents/${agentKA}/wakeup`, body, 202);
      userEventReceipts.push({ event: `KA${number}-fresh-authorized-user-wake`, body, response: receipt });
      if (!receipt.id || receipt.status === "skipped") throw new Error(`BLOCKER: real fresh KA${number} owner turn not admitted with older pending card: ${JSON.stringify(receipt)}`);
      expect([...ownerRuns.values()]).not.toContain(receipt.id);
      ownerRuns.set(number, receipt.id);
      changed?.();
      try {
        await wait(`KA${number} holds real execution and checkout despite older pending card`, async () => holdingOwners.get(number === 2 ? "A" : "BCD") ?? null, 30_000);
      } catch (error) {
        stage("fresh owner admission blocker", { number, receipt, runs: await allRuns(), issue: await task(), error: String(error) });
        throw error;
      }
      const [wake] = await db!.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.wakeupRequestId));
      expect(wake).toMatchObject({ agentId: agentKA, companyId, runId: receipt.id, requestedByActorType: "user", requestedByActorId: "local-board", idempotencyKey: body.idempotencyKey });
    };
    const answered = async (decision: Decision) => {
      await wait(`${decision}: real KP script and terminal successful settlement`, async () => {
        const run = (await allRuns()).find(value => value.id === addressedRuns.get(decision));
        return terminalScripts.has(decision) && run?.status === "succeeded" ? true : null;
      });
      await heartbeat.waitForRunExecutionDrain(addressedRuns.get(decision)!, { timeoutMs: 15_000 });
      expect(taskOwnership(await task())).toEqual(holdingOwners.get(decision === "accept" ? "A" : "BCD")!.ownership);
    };
    await creatorYield("accept");
    await freshOwner(2);
    await answered("accept");
    allowB = true;
    changed?.();
    await creatorYield("reject");
    expect(creatorRuns.get("accept")).not.toBe(creatorRuns.get("reject"));
    await freshOwner(3);
    await answered("reject");
    expect(taskOwnership(await task())).toEqual(kaOwnership);
    const userCardBody = (idempotencyKey: string, scriptKey: string) => ({
      kind: "request_confirmation", idempotencyKey, title: `F3 ${scriptKey} user coordination`, summary: `${marker}:${scriptKey}`,
      sourceCommentId: commonCommentId, addresseeAgentId: agentKP, resolverPolicy: "anyone", continuationPolicy: "none",
      payload: { version: 1, prompt: `${marker}:${scriptKey}`, supersedeOnUserComment: false },
    });
    const failureBody = userCardBody(failureCardKey, "failure-C");
    failureCardArmed = true;
    stage("C fault armed before real user POST by persisted idempotency key", { companyId, issueId, agentKP, failureCardKey, kaOwnership });
    const createdC = await api("POST", `/issues/${issueId}/interactions`, failureBody, 201);
    userEventReceipts.push({ event: "C-created", body: failureBody, response: createdC });
    await wait("C's first automatic KP turn reaches the exact one-shot pre-model stage fault", async () => injectedFailure ?? null);
    expect(injectedFailure!.cardId).toBe(createdC.id);
    const failure = injectedFailure!;
    await wait("failed addressee run and coordinator terminal immediately", async () => {
      const failed = (await allRuns()).find(run => run.id === failure.runId);
      const [coordinator] = await db!.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, failure.runId));
      return failed && isKnownInjectedFailure(failed) && coordinator?.phase === "terminal_failure" ? true : null;
    }, Math.max(1, 15_000 - (Date.now() - failure.at)));
    await wait("one public pending-card failure note", async () => {
      const comments = await api("GET", `/issues/${issueId}/comments`);
      return Array.isArray(comments) && comments.some((comment: any) => !comment.deletedAt && JSON.stringify(comment).includes(failure.runId)) ? true : null;
    }, 15_000);
    await heartbeat.waitForRunExecutionDrain(failure.runId, { timeoutMs: 15_000 });
    await assertPendingFailureBoundary();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await assertPendingFailureBoundary();
    const nextBody = userCardBody(nextCardKey, "next");
    const createdD = await api("POST", `/issues/${issueId}/interactions`, nextBody, 201);
    userEventReceipts.push({ event: "D-created", body: nextBody, response: createdD });
    expect(createdD.id, "D is a new user card, not a C resend or recovery").not.toBe(failure.cardId);
    await wait("D resolves in exactly one fresh successful real Pi turn while C remains pending", async () => {
      if (!nextRunId || !terminalScripts.has("next")) return null;
      const run = (await allRuns()).find(row => row.id === nextRunId);
      const [coordinator] = await db!.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, nextRunId));
      return run?.status === "succeeded" && coordinator?.phase === "committed" ? true : null;
    });
    expect(nextCard!.id).toBe(createdD.id);
    expect(nextRunId).not.toBe(failure.runId);
    await heartbeat.waitForRunExecutionDrain(nextRunId!, { timeoutMs: 15_000 });
    await assertPendingFailureBoundary();
    const dSnapshot = async () => ({
      cardIds: (await taskCards()).filter(card => card.idempotencyKey === nextCardKey).map(card => card.id).sort(),
      runIds: (await allRuns()).filter(run => run.agentId === agentKP && run.contextSnapshot?.interactionId === createdD.id).map(run => run.id).sort(),
      wakeIds: (await db!.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.agentId === agentKP && wake.payload?.interactionId === createdD.id).map(wake => wake.id).sort(),
    });
    const beforeDuplicate = await dSnapshot();
    expect(beforeDuplicate.cardIds).toEqual([createdD.id]);
    expect(beforeDuplicate.runIds).toEqual([nextRunId]);
    expect(beforeDuplicate.wakeIds).toHaveLength(1);
    const duplicateD = await api("POST", `/issues/${issueId}/interactions`, nextBody, 201);
    userEventReceipts.push({ event: "D-duplicate-after-terminal", body: nextBody, response: duplicateD });
    expect(duplicateD.id, "the same D idempotency key returns the original card after terminal success").toBe(createdD.id);
    expect(await dSnapshot(), "duplicate D cannot produce even a second wake row").toEqual(beforeDuplicate);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const afterDuplicate = await dSnapshot();
    expect(afterDuplicate, "duplicate D stays inert across bounded observation; no second card, wake or run").toEqual(beforeDuplicate);
    duplicateObserved = { beforeDuplicate, afterDuplicate, at: new Date().toISOString(), quietWindowMs: 1500 };
    await assertPendingFailureBoundary();
    stage("C remains pending; D terminal duplicate suppressed with original KA ownership held", duplicateObserved);
    releaseKA = true;
    changed?.();
    await wait("all system-created turns terminal with exactly the known failure", async () => {
      const runs = await allRuns();
      return runs.length >= 6 && runs.every(run => run.status === "succeeded" || isKnownInjectedFailure(run)) ? runs : null;
    });
    for (const run of await allRuns()) await heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 15_000 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const finalCards = await taskCards();
    expect(finalCards).toHaveLength(4);
    expect(finalCards.find(card => card.id === failure.cardId)).toMatchObject({ status: "pending", result: null, resolvedAt: null, resolvedByAgentId: null, resolvedByRunId: null, resolvedByUserId: null });
    const finalRuns = await allRuns();
    expect(finalRuns.filter(run => run.agentId === agentKP)).toHaveLength(4);
    expect(finalRuns.filter(run => run.status !== "succeeded")).toEqual([expect.objectContaining({ id: failure.runId, status: "failed", errorCode: responseFailureCode })]);
    expect(finalRuns.filter(run => run.agentId === agentKP && run.status === "succeeded").map(run => run.id).sort()).toEqual([...addressedRuns.values(), nextRunId!].sort());
    expect(new Set([...addressedRuns.values(), nextRunId!]).size).toBe(3);
    expect(pendingObserved.size).toBe(3);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const nextWakes = wakes.filter(wake => wake.agentId === agentKP && wake.payload?.interactionId === nextCard!.id);
    expect(nextWakes, "one original D event wake despite its terminal duplicate HTTP delivery").toHaveLength(1);
    expect(nextWakes[0]).toMatchObject({ runId: nextRunId, idempotencyKey: `interaction-pending:${nextCard!.id}`, requestedByActorType: "user", payload: { interactionId: nextCard!.id } });
    expect(wakes.filter(wake => wake.agentId === agentKP)).toHaveLength(4);
    expect(wakes.some(wake => JSON.stringify(wake.payload).includes(failureNoteId!)), "failure note never becomes a wake cause").toBe(false);
    expect(finalRuns.some(run => JSON.stringify(run.contextSnapshot).includes(failureNoteId!)), "no automatic failure-note run loop after KA release").toBe(false);
    for (const scriptKey of ["accept", "reject", "next"] as const) {
      const decision: Decision = scriptKey === "reject" ? "reject" : "accept";
      const card = finalCards.find(row => row.id === (scriptKey === "next" ? nextCard!.id : cards.get(scriptKey)!.id))!;
      const runId = scriptKey === "next" ? nextRunId! : addressedRuns.get(scriptKey)!;
      expect(card).toMatchObject({ status: statuses[decision], result: { outcome: statuses[decision] }, sourceRunId: scriptKey === "next" ? null : creatorRuns.get(scriptKey),
        resolvedByAgentId: agentKP, resolvedByRunId: runId, resolvedByUserId: null });
      expect(card.resolvedAt).toBeInstanceOf(Date);
      const run = finalRuns.find(row => row.id === runId)!;
      expect(run).toMatchObject({ agentId: agentKP, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId });
      expect(run.contextSnapshot).toMatchObject({ wakeReason: "interaction_pending", interactionId: card.id });
      const [finalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(finalization, "actual native finalizer committed the KP outcome").toMatchObject({ phase: "committed" });
      expect(finalization!.resultId).toBeTruthy();
      expect(wakes.filter(wake => wake.agentId === agentKP && wake.payload?.interactionId === card.id), "exactly one original pending wake per A/B/D card").toHaveLength(1);
      expect(wakes.filter(wake => wake.agentId === agentKP && wake.idempotencyKey === `interaction-pending:${card.id}`), "one original automatic pending wake per card").toHaveLength(1);
      if (scriptKey === "next") expect(wakes.filter(wake => wake.agentId === agentKA && wake.payload?.interactionId === card.id), "board D explicitly requests no continuation").toHaveLength(0);
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      const prp = events.flatMap(event => (event.payload as any)?.prpEvent ? [(event.payload as any).prpEvent] : []);
      expect(prp.some(event => event.eventType === "tool.execution.completed"), "actual KP tools crossed durable PRP").toBe(true);
      expect(JSON.stringify(events)).not.toContain("pi_rpc_transport_failed");
      expect(Number(run.usageJson?.inputTokens ?? 0) + Number(run.usageJson?.outputTokens ?? 0)).toBeGreaterThan(0);
      const script = calls.get(runId)!;
      expect(script.map(call => call.key)).toEqual(["read-staged", "deny-before", "resolve-own", "deny-after"]);
      expect(script.every(call => call.result)).toBe(true);
    }
    const [failedCoordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, failure.runId));
    expect(failedCoordinator).toMatchObject({ phase: "terminal_failure", failureCode: responseFailureCode, recoveryState: null, nextAttemptAt: null, leaseOwner: null });
    expect(finalRuns.find(run => run.id === failure.runId)).toMatchObject({ status: "failed", errorCode: responseFailureCode, scheduledRetryAt: null });
    expect(finalRuns.filter(run => run.retryOfRunId === failure.runId)).toEqual([]);
    const finalComments = await api("GET", `/issues/${issueId}/comments`);
    expect(finalComments.filter((comment: any) => !comment.deletedAt && JSON.stringify(comment).includes(failure.runId)).map((comment: any) => comment.id)).toEqual([failureNoteId]);
    expect((await task()).assigneeAgentId).toBe(agentKA);
    expect((await task()).status).not.toBe("done");
    expect(finalRuns.every(run => run.status === "succeeded" || isKnownInjectedFailure(run))).toBe(true);
    expect(wakes.some(wake => ["queued", "deferred_issue_execution", "pending"].includes(wake.status))).toBe(false);
    expect(injectionClaimed).toBe(true);
    stage("FLOW_ASSERTIONS_PASSED", { companyId, issueId, sourceRunId, creatorRuns: Object.fromEntries(creatorRuns), ownerRuns: Object.fromEntries(ownerRuns), injectedFailureRunId: failure.runId, failureNoteId,
      acceptanceInterpretation: "lead e15e0620-e1e0-45a9-b4a4-674aaaa354a1 12:19:56Z: A/B resolved; separate C pending; next new D event one successful KP turn; terminal D duplicate inert; no same-card rewake",
      failureCardKey, nextCardKey, nextRunId, nativeAutomaticRetry: "UNPROVEN_NOT_EXECUTED", addressedRuns: Object.fromEntries(addressedRuns),
      finalRuns: finalRuns.map(run => ({ id: run.id, status: run.status, agentId: run.agentId })) });
    passed = true;
  } catch (error) {
    primaryError = error instanceof Error ? error.stack : String(error);
    stage("NOT_QUALIFIED", primaryError);
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    const cleanup = async (label: string, action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); }
    };
    if (db && companyId) {
      await cleanup("save database evidence", async () => {
        for (const [name, table] of [["runs", heartbeatRuns], ["cards", issueThreadInteractions], ["wakeups", agentWakeupRequests], ["comments", issueComments], ["attachments", issueAttachments], ["issues", issues], ["agents", agents], ["finalizations", nativeRunFinalizations]] as const) {
          await writeFile(join(root, `${name}.json`), JSON.stringify(await db!.select().from(table as any).where(eq((table as any).companyId, companyId)), null, 2));
        }
        for (const run of await allRuns()) await writeFile(join(root, `events-${run.id}.json`), JSON.stringify(await db!.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)), null, 2));
      });
      await cleanup("drain owned runs", async () => {
        const { heartbeatService } = await import("../services/heartbeat.js");
        const heartbeat = heartbeatService(db!);
        for (const run of await allRuns()) {
          if (!passed && ["running", "queued", "scheduled_retry"].includes(run.status)) await heartbeat.cancelRun(run.id);
          await heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 15_000 });
        }
      });
    }
    await cleanup("unsubscribe live events", async () => { unsubscribe?.(); });
    const processOwners: unknown[] = [];
    await cleanup("capture owned process identities", async () => {
      processOwners.push(...bundles.map(bundle => bundle.transport.processInfo?.()).filter(Boolean));
    });
    for (const bundle of bundles) await cleanup("close owned runner transport", () => bundle.transport.close());
    await cleanup("app shutdown", async () => { await app?.locals.paperclipShutdown?.(); });
    for (const [name, home] of homes) await cleanup(`save native Pi receipt ${name}`, async () => {
      const receipt = readNativePiHomeProof(home.receiptPath);
      await writeFile(join(root, `native-${name}.final.json`), JSON.stringify(receipt, null, 2));
      if (passed) {
        expect(receipt?.extensionErrors).toEqual([]);
        expect(receipt?.networkRequests.filter((request: any) => request.method === "POST" && !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(request.origin))).toEqual([]);
      }
    });
    for (const server of [http, model]) if (server) await cleanup("close loopback listener", async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    await cleanup("embedded database shutdown", async () => { await temporary?.cleanup(); });
    await cleanup("save proof", async () => writeFile(join(root, "proof.json"), JSON.stringify({ schema: "f3-addressed-real-pi-failure-prepared.v1", passed: passed && !cleanupErrors.length, primaryError,
      creatorRuns: Object.fromEntries(creatorRuns), ownerRuns: Object.fromEntries(ownerRuns), holdingOwners: Object.fromEntries(holdingOwners), governedYields,
      qualification: "real Pi + runnerd + PRP + HTTP app + embedded PostgreSQL; credential-free scripted loopback model; native automatic RETRY UNPROVEN_NOT_EXECUTED; A/B resolved, separate C pending, next new D event successful, D duplicate POST after terminal inert; no same-card rewake",
      companyId, issueId, otherIssueId, agentKA, agentKP, sourceRunId, commonCommentId,
      injectedFailure, failureObserved, failureNoteId, failureCardKey, nextCardKey, nextRunId, nextCard, userEventReceipts, duplicateObserved, kaOwnership,
      addressedRuns: Object.fromEntries(addressedRuns), pendingObserved: [...pendingObserved], continuationsSeen: [...continuationsSeen],
      processOwners, cleanupErrors, stages, requests, nativeReceipts, calls: Object.fromEntries(calls), files,
    }, null, 2)));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    console.log(`[f3-cardwake] evidence ${root}`);
    if (!primaryError) expect(cleanupErrors, "owned process and database teardown must complete; parent must independently confirm terminal processes").toEqual([]);
  }
}, 360_000);
