// N+1 finding: two stale-owner rows; D-B8 LIFT: two no-stale-owner rows,
// through the REAL comment -> heartbeat entry. The latter use the explicitly
// allowed REAL idle-timer fallback, NOT a true server-process restart (see below).
// Keep reason: data safety / RFL G2; a replaced box must never silently
// answer without Pi history. No executor, checkpoint, result, notice or native
// run is fixture-driven. Recovery/dispatch use the production worker entries;
// a terminal, person-owned hold is NOT repaired by inventing another comment
// or run. Only the sandbox provider RPC and inference are faked.
// Like native-pi-rpc-replaced-box-followup, this is a host-namespace allocation
// fixture, NOT a Boat/container qualification. Old disks and evidence are kept.
// Opt-in: PAPERCLIP_PI_LEASE_E2E=1. Once enabled, missing qualified runner/pack/Pi
// artifacts FAIL prerequisites; there are no runtime skips or expected failures.
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import https, { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import express from "express";
import { and, eq } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it, vi } from "vitest";
import {
  agents, agentTaskSessions, authUsers, closeRegisteredClients, companies, completionContracts, createDb,
  environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues,
  issueThreadInteractions, nativeRunFinalizations, nativeRunResults, plugins,
} from "@paperclipai/db";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { PAPERCLIP_RUNNER_INGRESS_PORT } from "@paperclipai/adapter-utils/runner-connectivity";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { registerLocalRuntimeApiServer } from "../runtime-api.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import * as piConversations from "../services/native-runtime/pi-conversation-record.js";
import { closeIdleWarmNativeSessionsForRestart, nativeSessionScopeDigestIsBusy, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import * as runnerTiming from "../services/native-runtime/runner-operation-timing.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

const enabled = process.env.PAPERCLIP_PI_LEASE_E2E === "1";
const MISSING_FILE_NOTE = "My earlier conversation could not be restored: the saved Pi conversation file is missing on this computer. Starting a new one.";
const PRE_RECORD_NOTE = "My earlier conversation could not be restored (it predates conversation records). Starting a new one.";
const WARM_IDLE_MS = 300_000;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
type Birth = { pid: number; ppid: number; startTicks: string; bootId: string; command: string };
function birth(pid: number): Birth | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return { pid, ppid: Number(fields[1]), startTicks: fields[19]!,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ") };
  } catch { return null; }
}
function sameBirth(expected: Birth): boolean {
  const current = birth(expected.pid);
  return current !== null && current.startTicks === expected.startTicks && current.bootId === expected.bootId;
}
function descendants(runner: Birth): Birth[] {
  const processes = new Map<number, Birth>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const current = birth(Number(name)); if (current) processes.set(current.pid, current);
  }
  return [...processes.values()].filter(current => {
    let parent = current.ppid;
    const seen = new Set<number>();
    while (parent !== runner.pid && processes.has(parent) && !seen.has(parent)) {
      seen.add(parent); parent = processes.get(parent)!.ppid;
    }
    return parent === runner.pid;
  });
}
function sessionFile(pi: Birth): string {
  const env = Object.fromEntries(readFileSync(`/proc/${pi.pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => {
    const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  if (!env.PAPERCLIP_PI_RUNTIME_DIR || !env.PAPERCLIP_NORMALIZED_SESSION_ID) throw new Error("Pi child lacks admitted JSONL binding");
  return join(env.PAPERCLIP_PI_RUNTIME_DIR, `${env.PAPERCLIP_NORMALIZED_SESSION_ID}.jsonl`);
}

type Case = "deleted-task-session" | "cleared-session-params" | "record-kept";
type Shape = "stale-owner" | "restart";
const cases: Array<{ caseName: Case; shape: Shape; name: string }> = [
  ...(["deleted-task-session", "cleared-session-params"] as const).map(caseName => ({ caseName, shape: "stale-owner" as const,
    name: `real heartbeat entry: governed wait on a replaced box (${caseName})` })),
  ...(["deleted-task-session", "cleared-session-params"] as const).map(caseName => ({ caseName, shape: "restart" as const,
    name: `D-B8 lift: real heartbeat entry after idle-close (server restart fallback; ${caseName})` })),
  // adopt-lead 16:23Z control: Paul's 19 sessions keep the opening turn's record. Nothing deleted or
  // cleared. GREEN = answered WITH history, or answered with exactly one approved note.
  { caseName: "record-kept", shape: "restart", name: "D-B8 lift control: real heartbeat entry after idle-close, record kept (record-kept)" },
];
it.skipIf(!enabled).each(cases)(
  "$name", async ({ caseName, shape }) => {
    expect(process.platform, "real owned PID proof requires Linux").toBe("linux");
    expect(process.env.TMPDIR, "dedicated parent-owned TMPDIR required").toBeTruthy();
    const runnerBinary = process.env.PAPERCLIP_RUNNER_BINARY;
    const providerPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
    const piBinary = process.env.PI_TEST_BINARY;
    if (!runnerBinary?.startsWith("/") || !providerPack?.startsWith("/") || !piBinary?.startsWith("/"))
      throw new Error("Set absolute qualified PAPERCLIP_RUNNER_BINARY, PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH and PI_TEST_BINARY");
    await access(runnerBinary, constants.X_OK); await access(providerPack, constants.R_OK | constants.X_OK); await access(piBinary, constants.X_OK);
    const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-real-entry-"));
    const remoteCwd = join(root, "simulated-sandbox", "workspace"), localCwd = join(root, "host-workspace");
    const stagedRuntime = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID();
    const provider = `pi-real-entry-${pluginId}`, allocationIds = [`image-A-${randomUUID()}`, `image-B-${randomUUID()}`];
    const allocations = new Map(allocationIds.map(id => [id, "running" as "running" | "stopped"]));
    const leaseActive = new Map<string, boolean>(), previewBindings = new Map<string, string>();
    const privateFact = `PI_PRIVATE_REAL_ENTRY_${randomUUID()}`;
    const openingAnswer = "I am waiting for your next message.";
    const followupAnswer = `I cannot recall the earlier private fact. ANSWERED_${randomUUID()}`;
    const openingToolCallId = `finish-${randomUUID()}`;
    const requests: Array<{ runId: string | undefined; generation: number; request: Record<string, unknown>; historyPresent: boolean; reply: string | null; toolResult: unknown }> = [];
    const providerCalls: Array<{ method: string; generation: number; attempt: number; at: string; input: Record<string, unknown> }> = [];
    const commands: Array<Record<string, unknown>> = [], stages: unknown[] = [], records: unknown[] = [];
    const admissionSteps: Array<{ runId: string | undefined; generation: number; phase: string; at: string; outcome?: "ok" | "failed"; error?: string }> = [];
    const markers = new Set<string>(), runners: Birth[] = [], pis: Birth[] = [];
    let generation = 1, followupAttempt = 1;
    let activeRunId: string | undefined, openingRunId: string | undefined, followupRunId: string | undefined, retryRunId: string | undefined;
    let openingReport: Record<string, unknown> | undefined, outcome: Record<string, unknown> | undefined;
    const outcomes: Record<string, unknown>[] = [];
    let recoveryObservation: Record<string, unknown> | undefined;
    let followupCommentId: string | undefined, failure: unknown, modelFailure: unknown;
    let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
    let db: ReturnType<typeof createDb> | undefined, heartbeat: ReturnType<typeof heartbeatService> | undefined;
    let apiServer: Server | undefined, preview: ReturnType<typeof createHttpsServer> | undefined;
    let stopPostgres: (() => Promise<void>) | undefined, unsubscribe: (() => void) | undefined, changed: (() => void) | undefined;
    const previousCertificates = getCACertificates("default"), previousHttpsAgent = https.globalAgent;
    let fixtureHttpsAgent: InstanceType<typeof https.Agent> | undefined;
    const sockets = new Set<WebSocket>(), ws = new WebSocketServer({ noServer: true });
    const stage = (name: string, detail: unknown = {}) => { stages.push({ at: new Date().toISOString(), name, detail }); };
    const execute = (command: string, args: string[], options: Omit<Parameters<CommandManagedRuntimeRunner["execute"]>[0], "command" | "args"> = {}) =>
      runChildProcess(`pi-real-entry-${randomUUID()}`, command, args, { cwd: options.cwd ?? root, env: options.env ?? {}, stdin: options.stdin,
        timeoutSec: (options.commandTimeoutMs ?? options.timeoutMs ?? 30_000) / 1000, graceSec: 1,
        onLog: options.onLog ?? (async () => {}), onSpawn: options.onSpawn });
    const installImagePack = async () => {
      await mkdir(stagedRuntime, { recursive: true }); await symlink(providerPack, join(stagedRuntime, "provider-pack"), "dir");
    };
    const observeProcesses = () => {
      for (const marker of markers) try {
        const fields = readFileSync(marker, "utf8").trim().split("\n");
        const runner = birth(Number(fields[1]));
        if (!runner?.command.includes("runnerd") || fields[4] !== `linux:${runner.bootId}:${runner.startTicks}`) continue;
        if (!runners.some(owned => owned.pid === runner.pid && owned.startTicks === runner.startTicks)) runners.push(runner);
        for (const child of descendants(runner)) {
          const comm = (() => { try { return readFileSync(`/proc/${child.pid}/comm`, "utf8").trim(); } catch { return ""; } })();
          if ((comm === "pi" || child.command.includes("--mode rpc") && child.command.includes("cli.js"))
            && !pis.some(owned => owned.pid === child.pid && owned.startTicks === child.startTicks)) pis.push(child);
        }
      } catch { /* marker not yet written, or allocation replaced */ }
    };
    // Normal progress is driven by company live events. The 250ms safety net
    // covers process/DB transitions that deliberately emit no company event.
    const waitFor = async <T>(label: string, probe: () => Promise<T | null>, timeoutMs = 120_000): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (modelFailure) throw modelFailure;
        const value = await probe(); if (value !== null) return value;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { changed = undefined; resolve(); }, 250);
          changed = () => { clearTimeout(timer); changed = undefined; resolve(); };
        });
      }
      throw new Error(`Timed out: ${label}`);
    };
    const stopBoxProcesses = async () => {
      observeProcesses();
      const owned = [...runners.filter(sameBirth).flatMap(descendants), ...pis, ...runners];
      for (const child of owned) if (sameBirth(child)) process.kill(child.pid, "SIGKILL");
      await waitFor("all exact owned box process births ended", async () => owned.some(sameBirth) ? null : true, 15_000);
    };
    const taskScope = () => and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, agentId),
      eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, issueId));
    const runForComment = async (commentId: string) => waitFor("comment admitted as a heartbeat", async () =>
      (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .find(run => run.contextSnapshot?.wakeCommentId === commentId || run.contextSnapshot?.commentId === commentId) ?? null);
    const finishRun = async (runId: string) => {
      await waitFor("heartbeat terminal status", async () => {
        const run = await heartbeat!.getRun(runId);
        return run && ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status) ? run : null;
      });
      // Reuse the Stop/continue harness's real execution drain: terminal status
      // alone is not proof that session publication / workspace release ended.
      await heartbeat!.waitForRunExecutionDrain(runId, { timeoutMs: 30_000 });
      return (await heartbeat!.getRun(runId))!;
    };
    const readOutcome = async (runId = followupRunId, attempt = 1) => {
      if (!db || !followupCommentId || !runId) return undefined;
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      const notes = comments.filter(comment => comment.authorType === "system" && !comment.deletedAt).map(comment => comment.body);
      const events = run ? await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)) : [];
      const sessionRecovery = events.flatMap(event => {
        const prp = record(record(event.payload).prpEvent), payload = record(prp.payload);
        const admission = record(record(payload.providerDescriptor).piNativeAdmission);
        const contextAdmission = record(record(payload.context).piNativeAdmission);
        const recovery = admission.sessionRecovery ?? contextAdmission.sessionRecovery ?? payload.piSessionRecovery;
        return recovery ? [{ eventType: event.eventType, sessionRecovery: recovery }] : [];
      });
      const followupRequests = requests.filter(request => request.runId === runId);
      const attemptCalls = providerCalls.filter(call => call.generation === 2 && call.attempt === attempt);
      // Full inputs/timestamps stay in proof.json; group repeated dead-A RPCs
      // rather than printing hundreds of copies of their shell scripts.
      const rpcCounts: Record<string, number> = {}, executeCounts: Record<string, { count: number; firstAt: string; lastAt: string; providerLeaseId: unknown; command: unknown; args: unknown }> = {};
      for (const call of attemptCalls) {
        rpcCounts[call.method] = (rpcCounts[call.method] ?? 0) + 1;
        if (call.method !== "environmentExecute") continue;
        const providerLeaseId = record(call.input.lease).providerLeaseId;
        const key = createHash("sha256").update(JSON.stringify([providerLeaseId, call.input.command, call.input.args])).digest("hex");
        const group = executeCounts[key] ??= { count: 0, firstAt: call.at, lastAt: call.at, providerLeaseId, command: call.input.command, args: call.input.args };
        group.count += 1; group.lastAt = call.at;
      }
      const answered = run?.status === "succeeded" && comments.some(comment => comment.authorAgentId === agentId
        && comment.createdByRunId === runId && comment.body.includes(followupAnswer));
      const branch = notes.length === 1 && notes[0] === MISSING_FILE_NOTE ? "(i) missing-file"
        : notes.length === 1 && notes[0] === PRE_RECORD_NOTE ? "(ii) pre-record" : "neither";
      return { case: caseName, shape, attempt, answered, historyPresent: followupRequests.some(request => request.historyPresent), notes,
        status: run?.status ?? null, nativePhase: run?.nativePhase ?? null,
        error: run?.error ?? null, errorCode: run?.errorCode ?? null,
        coordinator: coordinator ? { phase: coordinator.phase, attempt: coordinator.attempt, recoveryState: coordinator.recoveryState,
          failureCode: coordinator.failureCode, failureDetail: coordinator.failureDetail, nextAttemptAt: coordinator.nextAttemptAt,
          leaseOwner: coordinator.leaseOwner, resultId: coordinator.resultId } : null,
        visibleComments: comments.filter(comment => !comment.deletedAt).map(comment => ({ id: comment.id, authorType: comment.authorType,
          createdByRunId: comment.createdByRunId, body: comment.body, presentation: comment.presentation, metadata: comment.metadata })),
        rpcCounts, executeCounts, sessionRecovery,
        admissionPath: admissionSteps.filter(step => step.runId === runId),
        branch, runId: run?.id ?? null, requestCount: followupRequests.length };
    };
    const logOutcome = async (runId: string, attempt: number) => {
      outcome = await readOutcome(runId, attempt);
      expect(outcome, "observe the exact admitted attempt, not another run carrying the same comment").toBeDefined();
      outcomes.push(outcome!); console.log(`E2E-REAL-ENTRY-OUTCOME: ${JSON.stringify(outcome)}`);
      const notes = outcome!.notes as string[];
      // RFL 16:40Z: pre-existing upstream new-session design when the record is deleted/cleared mid-conversation (same on c2 74ccf170 and e8f338f7); not D-B8 or S. The LIFT (a)/(b) rows assert that measured outcome explicitly below instead.
      const measuredNewSession = shape === "restart" && caseName !== "record-kept";
      if (!measuredNewSession) expect(!(outcome!.answered && !outcome!.historyPresent && notes.length === 0), "never a silent history-less answer").toBe(true);
      return outcome!;
    };
    const model = createServer((req, res) => {
      let body = ""; req.setEncoding("utf8"); req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => { void (async () => {
        if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
        const parsed = JSON.parse(body);
        if (respondToNativePiHello(parsed, res, "messages")) return;
        expect(activeRunId, "real heartbeat selection precedes inference").toBeTruthy();
        const opening = generation === 1, useFinish = opening && requests.length === 0;
        const messages = parsed.messages as Array<{ role: string; content: unknown }>;
        const latest = messages.findLast(message => message.role === "user")?.content;
        const toolResult = Array.isArray(latest) ? latest.map(record).find(block => block.type === "tool_result" && block.tool_use_id === openingToolCallId) : undefined;
        if (useFinish) {
          const [run] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, activeRunId!));
          const [contract] = await db!.select().from(completionContracts).where(eq(completionContracts.id, run!.completionContractId!));
          const criteria = record(contract!.contractJson).criteria as Array<{ id: string }>;
          const summary = "Wake only when the person sends their next free-text comment.";
          openingReport = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: openingAnswer,
            completionClaim: { contractRevision: String(contract!.revision), objectiveSatisfied: false,
              criteria: criteria.map(criterion => ({ criterionId: criterion.id, status: "not_satisfied", evidenceRefs: [] })),
              remainingWork: [{ description: summary, blocksCompletion: true }] },
            evidence: [], verification: [], attentionRequests: [], artifacts: [],
            continuation: { kind: "response_wake", idempotencyKey: `real-entry-response-${randomUUID()}`, summary } };
          expect((parsed.tools as Array<{ name: string }>).map(tool => tool.name)).toContain("paperclip_finish");
        } else if (opening) {
          expect(toolResult, "Pi executes paperclip_finish and returns its real callback receipt").toBeDefined();
          expect(record(toolResult).is_error ?? false, JSON.stringify(toolResult)).toBe(false);
        }
        const historyPresent = JSON.stringify(messages).includes(privateFact);
        const reply = useFinish ? null : opening ? openingAnswer : historyPresent ? `RECALLED_${privateFact}` : followupAnswer;
        requests.push({ runId: activeRunId, generation, request: parsed, historyPresent, reply, toolResult });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        // The private fact exists ONLY in Pi's assistant history, not a task,
        // comment, semantic-result summary, workspace file or later prompt.
        emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: useFinish ? `My private fact is ${privateFact}.` : reply } });
        emit("content_block_stop", { index: 0 });
        if (useFinish) {
          emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: openingToolCallId, name: "paperclip_finish", input: {} } });
          emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(openingReport) } });
          emit("content_block_stop", { index: 1 });
        }
        emit("message_delta", { delta: { stop_reason: useFinish ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
        emit("message_stop", {}); res.end();
      })().catch(error => { modelFailure = error; if (!res.headersSent) res.writeHead(500); res.end(String(error)); changed?.(); }); });
    });
    try {
      await mkdir(remoteCwd, { recursive: true }); await mkdir(localCwd); await installImagePack();
      const piVersion = await execute(piBinary, ["--version"]);
      expect(piVersion.exitCode).toBe(0); expect(piVersion.stdout.trim()).toBe("1.5.2");
      console.log(`E2E-PI-BINARIES: ${JSON.stringify({ case: caseName, shape, runnerBinary, runnerSha256: createHash("sha256").update(await readFile(runnerBinary)).digest("hex"),
        providerPack, PI_TEST_BINARY: piBinary, piVersion: piVersion.stdout.trim() })}`);
      for (const key of Object.keys(process.env)) if (key.startsWith("LANGFUSE_")) vi.stubEnv(key, undefined);
      vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home")); vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
      vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "controller-state", "durable-sessions"));
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2)); vi.stubEnv("PI_OFFLINE", "1"); vi.stubEnv("OTEL_SDK_DISABLED", "true");
      vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", undefined);
      await new Promise<void>(done => model.listen(0, "127.0.0.1", done));
      const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === "string") throw new Error("Messages listener missing");
      const agentHome = join(root, "pi-agent-fixture"); await mkdir(agentHome);
      await writeFile(join(agentHome, "models.json"), JSON.stringify({ providers: { paperclip: { models: [{ id: "faux", reasoning: true,
        contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } }] } } }));
      // Reuse G2's CA:true test root and separate CA:false serverAuth leaf;
      // rustls correctly rejects a CA certificate used as an ingress leaf.
      const ca = join(root, "preview-ca.crt"), caKey = join(root, "preview-ca.key");
      const key = join(root, "preview.key"), cert = join(root, "preview.crt"), csr = join(root, "preview.csr"), extensions = join(root, "preview.ext");
      await writeFile(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n");
      for (const args of [
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "1", "-subj", "/CN=Pi real-entry test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
        ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=localhost"],
        ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", extensions],
      ]) expect((await execute("openssl", args)).exitCode).toBe(0);
      const certificates = [...previousCertificates, await readFile(ca, "utf8")];
      setDefaultCACertificates(certificates); fixtureHttpsAgent = new https.Agent({ ca: certificates }); https.globalAgent = fixtureHttpsAgent;
      vi.stubEnv("PAPERCLIP_RUNNER_CA_BUNDLE_PATH", ca); vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", runnerBinary);
      preview = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) });
      preview.on("upgrade", (req, socket, head) => {
        const id = previewBindings.get(req.url ?? "");
        if (!id || !leaseActive.get(id) || req.headers["x-owned-lease"] !== id) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
        ws.handleUpgrade(req, socket, head, front => {
          const back = new WebSocket(`ws://127.0.0.1:${PAPERCLIP_RUNNER_INGRESS_PORT}${req.url}`, { perMessageDeflate: false });
          const pending: Array<{ data: RawData; binary: boolean }> = [];
          sockets.add(front); sockets.add(back);
          front.on("message", (data, binary) => { if (back.readyState === WebSocket.OPEN) back.send(data, { binary }); else pending.push({ data, binary }); });
          back.on("open", () => { for (const message of pending.splice(0)) back.send(message.data, { binary: message.binary }); });
          back.on("message", (data, binary) => { if (front.readyState === WebSocket.OPEN) front.send(data, { binary }); });
          front.on("close", () => { sockets.delete(front); back.terminate(); }); back.on("close", () => { sockets.delete(back); front.terminate(); });
          front.on("error", error => { stage("preview front error", error.message); back.terminate(); });
          back.on("error", error => { stage("preview back error", error.message); front.terminate(); });
        });
      });
      await new Promise<void>(done => preview!.listen(0, "127.0.0.1", done));
      const previewAddress = preview.address(); if (!previewAddress || typeof previewAddress === "string") throw new Error("Preview listener missing");
      temporary = await startEmbeddedPostgresTestDatabase("native-pi-real-entry-db-"); db = createDb(temporary.connectionString);
      // Preserve evidence like the base harness: stop only this exact port's
      // owned Postgres; do not call helper.cleanup(), which removes its files.
      const pgPort = new URL(temporary.connectionString).port;
      for (const entry of readdirSync("/proc")) try {
        if (!/^\d+$/.test(entry)) continue;
        const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
        if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== pgPort) continue;
        const dataDir = args[args.indexOf("-D") + 1]!;
        stopPostgres = async () => { await closeRegisteredClients(temporary!.connectionString);
          expect((await execute(args[0]!.replace(/postgres$/, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"])).exitCode).toBe(0); };
        break;
      } catch { /* unrelated process */ }
      expect(stopPostgres, "identify exact owned database for teardown").toBeDefined();
      await db.insert(authUsers).values({ id: "local-board", name: "Local proof operator", email: "pi-real-entry@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companies).values({ id: companyId, name: "Pi real heartbeat entry", issuePrefix: "PRE", requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "local-board" });
      const supportedMethods = ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease",
        "environmentInspectLease", "environmentExecute", "environmentRunnerIngressEndpoint", "environmentRealizeWorkspace"];
      await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: "pi-real-entry-provider-fixture", version: "1.0.0", apiVersion: 1,
        categories: ["automation"], status: "ready", manifestJson: { id: provider, apiVersion: 1, version: "1.0.0", displayName: "Pi real-entry provider",
          description: "Simulated allocation; production sandbox driver and heartbeat", author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Pi real-entry provider",
            sandboxCapabilities: { reusableLeases: true, runnerWebSocketIngress: true, persistentProcessSessions: false, incrementalSessionOutput: false },
            configSchema: { type: "object", properties: { image: { type: "string" }, reuseLease: { type: "boolean" } } } }] } });
      // Leave N+1's 5-minute owner untouched. D-B8 waits for the real production
      // idle timer on a still-live A, before killing A and mounting empty B.
      const idleTimeoutMs = shape === "restart" ? 30_000 : WARM_IDLE_MS;
      const environmentConfig = { provider, image: "fixture:image-A", reuseLease: true, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: idleTimeoutMs };
      await db.insert(environments).values({ id: environmentId, name: `Real-entry sandbox ${environmentId}`, driver: "sandbox", status: "active", config: environmentConfig });
      const providerCall = async (method: string, input: Record<string, unknown>, onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void>) => {
        // Record stdin as its size + sha256, never the body: the runnerd upload is a ~200 MB base64 ELF
        // (RE4 15:50Z: proof.json was 426 MB, 2 such uploads; the binary's sha is in binaries/head already).
        const recordedInput = typeof input.stdin === "string" && input.stdin.length > 4096
          ? { ...input, stdin: { bytes: Buffer.byteLength(input.stdin), sha256: createHash("sha256").update(input.stdin).digest("hex") } } : input;
        providerCalls.push({ method, generation, attempt: generation === 1 ? 0 : followupAttempt, at: new Date().toISOString(), input: recordedInput });
        const allocationId = allocationIds[generation - 1]!;
        if (method === "environmentAcquireLease") return { providerLeaseId: allocationId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
        if (method === "environmentResumeLease") {
          expect(input.providerLeaseId, "never resume dead A as B").toBe(allocationId);
          expect(allocations.get(allocationId)).toBe("running");
          return { providerLeaseId: allocationId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
        }
        if (["environmentDestroyLease", "environmentStopLease", "environmentReleaseLease"].includes(method)) {
          const id = String(input.providerLeaseId); expect(allocationIds).toContain(id);
          allocations.set(id, "stopped"); leaseActive.set(id, false);
          // A stale A teardown cannot kill B's processes at the reused path.
          if (id === allocationId) await stopBoxProcesses();
          return { providerLeaseId: id, state: method === "environmentDestroyLease" ? "destroyed" : "stopped" };
        }
        if (method === "environmentInspectLease") {
          const id = String(input.providerLeaseId);
          return { providerLeaseId: id, state: allocations.get(id) === "running" ? "active" : "stopped", observedAt: new Date().toISOString() };
        }
        if (method === "environmentRealizeWorkspace") return { cwd: remoteCwd };
        if (method === "environmentExecute" || method === "environmentRunnerIngressEndpoint") {
          // These RPCs carry the allocation under input.lease, unlike the
          // lifecycle RPCs above. Never paper over a stale lease with generation.
          const id = record(input.lease).providerLeaseId;
          expect(allocationIds, `${method}: nested lease names a box this provider allocated`).toContain(String(id));
          // A real provider refuses work on a stopped/destroyed allocation (Boat's own error
          // text, as in x-red-tl08); it never runs A's command on B. RE2 15:10Z: the product's
          // predecessor retirement targets A after replacement, so this must be an RPC error,
          // not a fixture assertion.
          if (allocations.get(String(id)) !== "running") throw new Error("Boat sandbox lease is no longer active");
          expect(id, `${method}: a running nested lease is the current box`).toBe(allocationId);
          if (method === "environmentRunnerIngressEndpoint") {
            const path = String(input.path); previewBindings.set(path, String(id)); leaseActive.set(String(id), true);
            return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
              secretHeaders: [{ name: "X-Owned-Lease", value: String(id) }], generation: `box-${generation}` };
          }
          const command: Record<string, unknown> = { method, generation, providerLeaseId: id, command: input.command, args: input.args };
          commands.push(command);
          const result = await execute(String(input.command), input.args as string[] ?? [], { cwd: input.cwd as string | undefined,
            env: input.env as Record<string, string>, stdin: input.stdin as string | undefined, timeoutMs: input.timeoutMs as number | undefined,
            commandTimeoutMs: input.commandTimeoutMs as number | undefined, onLog });
          Object.assign(command, { exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr }); observeProcesses(); return result;
        }
        throw new Error(`Unexpected provider RPC: ${method}`);
      };
      const worker = { isRunning: (id: string) => id === pluginId, getWorker: (id: string) => id === pluginId ? { supportedMethods } : undefined,
        stopAll: async () => {}, stopWorker: async () => {}, onConfigApplied: () => () => {},
        call: async (id: string, method: string, input: Record<string, unknown>, _timeout?: number, onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void>) => {
          expect(id).toBe(pluginId); return providerCall(method, input, onLog);
        } } as unknown as PluginWorkerManager;
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
      heartbeat = heartbeatService(db, { environmentRuntime: runtime, pluginWorkerManager: worker });
      await db.insert(agents).values({ id: agentId, companyId, name: "Real-entry Pi", role: "engineer", defaultEnvironmentId: environmentId,
        adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", cwd: localCwd, lifecycleMode: "warm", piRpcThinkingLevel: "xhigh",
          env: { TMPDIR: process.env.TMPDIR!, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentHome, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none",
            PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${modelAddress.port}` } }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
      await db.insert(issues).values({ id: issueId, companyId, title: "Remember a Pi-only fact", status: "in_review", assigneeAgentId: agentId,
        conversationAgentId: agentId, conversationUserId: "local-board", conversationState: "waiting" });
      unsubscribe = subscribeCompanyLiveEvents(companyId, () => changed?.());
      if (shape === "restart") {
        // Observation only: forward the real timing wrapper and its work once,
        // including the original return/error. No executor/transport replacement.
        const realMeasure = runnerTiming.measureRunnerOperation;
        vi.spyOn(runnerTiming, "measureRunnerOperation").mockImplementation(async <T>(phase: string, work: () => Promise<T>, attributes?: Record<string, number | boolean>): Promise<T> => {
          const step: typeof admissionSteps[number] = { runId: activeRunId, generation, phase, at: new Date().toISOString() };
          admissionSteps.push(step);
          try { const result = await realMeasure(phase, work, attributes); step.outcome = "ok"; return result; }
          catch (error) { step.outcome = "failed"; step.error = String(error); throw error; }
        });
      }
      const realSelect = piConversations.selectPiConversation;
      vi.spyOn(piConversations, "selectPiConversation").mockImplementation(async (database, input) => {
        const selected = await realSelect(database, input);
        if (input.companyId !== companyId || input.agentId !== agentId || input.issueId !== issueId) return selected;
        activeRunId = input.runId;
        if (generation === 1) openingRunId = input.runId;
        else if (followupAttempt === 1) followupRunId = input.runId;
        else retryRunId = input.runId;
        markers.add(join(stagedRuntime, "sessions", createHash("sha256").update(selected.id).digest("hex"), "runner", "runner-process.identity"));
        if (generation === 2) {
          // R1: earliest post-selection seam: the real selectPiConversation
          // RETURN in heartbeat/runtime-selection.ts:546. Acquire/ingress during
          // workspace/instruction preparation is earlier than selection. This
          // observation-only wrapper queries AFTER its transaction commits and
          // BEFORE the heartbeat builds/checkpoints/persists native execution;
          // it forwards the original record without changing any input/output.
          const [session] = await database.select().from(agentTaskSessions).where(taskScope());
          const conversation = piConversations.readPiConversation(session?.sessionParamsJson);
          const observation = { case: caseName, shape, attempt: followupAttempt, runId: input.runId,
            exists: conversation !== null, id: conversation?.id ?? null, generation: conversation?.generation ?? null };
          records.push(observation); console.log(`E2E-REAL-ENTRY-RECORD: ${JSON.stringify(observation)}`);
          expect(conversation, "runtime selection wrote a Pi conversation BEFORE native preparation").toMatchObject({ id: selected.id, generation: selected.generation });
          const [run] = await database.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
          // Same-run native recovery deliberately retains its first attempt's
          // input. A newly admitted heartbeat must not have persisted it yet.
          if (followupAttempt === 1 || input.runId !== followupRunId)
            expect(run?.runnerProfileJson?.nativeExecutionInput, "R1 precedes native input/bootstrap persistence").toBeUndefined();
        }
        return selected;
      });
      // Real production comment route, not a synthetic wake or an executor
      // call. Auth is the sole HTTP fixture: the owning local board person.
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true, companyIds: [companyId] }; next(); });
      const { createStorageService } = await import("../storage/service.js");
      const { createLocalDiskStorageProvider } = await import("../storage/local-disk-provider.js");
      app.use("/api", issueRoutes(db, createStorageService(createLocalDiskStorageProvider(join(root, "storage"))), { pluginWorkerManager: worker }));
      app.use(errorHandler); apiServer = createServer(app); registerLocalRuntimeApiServer(apiServer);
      await new Promise<void>(done => apiServer!.listen(0, "127.0.0.1", done));
      const address = apiServer.address(); if (!address || typeof address === "string") throw new Error("API listener missing");
      const apiUrl = `http://127.0.0.1:${address.port}`; vi.stubEnv("PAPERCLIP_API_URL", apiUrl);
      const comment = async (body: string) => {
        const response = await fetch(`${apiUrl}/api/issues/${issueId}/comments`, { method: "POST", headers: { "content-type": "application/json", origin: apiUrl },
          signal: AbortSignal.timeout(30_000), body: JSON.stringify({ body, clientRequestId: randomUUID() }) });
        const text = await response.text(); expect(response.status, text).toBe(201); return JSON.parse(text) as { id: string };
      };
      const openingComment = await comment("Tell me a private fact, keep it in your own conversation, then wait for my next free-text message.");
      const admitted = await runForComment(openingComment.id); openingRunId = admitted.id;
      const opening = await finishRun(admitted.id);
      expect(opening.status, JSON.stringify({ error: opening.error, errorCode: opening.errorCode })).toBe("succeeded");
      expect(opening.runtimeMode).toBe("native");
      expect(opening.resultJson).toMatchObject({ prpReportedWorkDisposition: "yielded",
        nativeTerminal: { runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } });
      const openingEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, opening.id));
      const proposed = openingEvents.filter(event => event.eventType === "run.result.proposed"), accepted = openingEvents.filter(event => event.eventType === "run.result.accepted");
      expect(proposed, "opening wait must be proposed by Pi's real finish callback").toHaveLength(1); expect(accepted).toHaveLength(1);
      expect(record(proposed[0]!.payload).prpEvent).toMatchObject({ sourceKind: "runner", payload: openingReport });
      expect(record(record(accepted[0]!.payload).prpEvent).payload).toMatchObject({ result: openingReport });
      expect(accepted[0]!.seq).toBeGreaterThan(proposed[0]!.seq);
      const results = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, opening.id));
      expect(results).toHaveLength(1); expect(results[0]?.schemaStatus).toBe("accepted");
      expect(record(results[0]?.resultJson).result).toMatchObject({ reportedWorkDisposition: "yielded", continuation: { kind: "response_wake" } });
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId)), "free-text SMA-1 wait has no interaction card").toEqual([]);
      expect(requests.filter(request => request.generation === 1)).toHaveLength(2);
      const [openingTaskSession] = await db.select().from(agentTaskSessions).where(taskScope());
      const openingConversation = piConversations.readPiConversation(openingTaskSession?.sessionParamsJson);
      expect(openingConversation).toMatchObject({ id: opening.nativeSessionId, generation: 1 });
      expect(openingTaskSession?.lastRunId, "opening publication completed before either legacy-shape mutation").toBe(opening.id);
      const [openingLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, opening.id));
      expect(openingLease).toMatchObject({ environmentId, providerLeaseId: allocationIds[0] });
      observeProcesses(); expect(runners.filter(sameBirth)).toHaveLength(1); expect(pis.filter(sameBirth)).toHaveLength(1);
      const openingSessionFile = sessionFile(pis.find(sameBirth)!);
      stage("Pi JSONL located from admitted child environment", { openingSessionFile,
        location: openingSessionFile.startsWith(`${remoteCwd}/`) ? "box workspace" : "controller runtime" });
      expect(await readFile(openingSessionFile, "utf8")).toContain(privateFact);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some(row => row.body.includes(privateFact)), "private fact is only in Pi, not the Paperclip thread/handoff source").toBe(false);
      expect(comments.filter(row => row.authorType === "system")).toEqual([]);
      const execution = parseNativeExecutionInput(opening.runnerProfileJson!.nativeExecutionInput);
      const stateRoot = scopedRunnerdStateRoot(execution);
      const checkpointPath = join(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "sessions", `${basename(stateRoot)}.json`);
      const checkpoint = await readFile(checkpointPath);
      expect(opening.runnerProfileJson?.sessionCheckpoint, "G2 also retains the real DB checkpoint").toBeTruthy();
      expect(record(record(JSON.parse(checkpoint.toString("utf8"))).snapshot).semanticResult).toMatchObject({ reportedWorkDisposition: "yielded", continuation: { kind: "response_wake" } });
      const backupRoot = join(stateRoot, "failover-backups");
      expect(existsSync(backupRoot) ? readdirSync(backupRoot, { recursive: true }) : [], "G2 natural backup state; no backups removed").toEqual([]);
      let retainedCheckpoint = checkpoint;
      if (shape === "restart") {
        // RESTART FALLBACK (not a true server restart): this harness owns the
        // HTTP issueRoutes/heartbeat services and the R1 selection spy in the
        // Vitest process. x-red's fork only runs executePaperclipNativeSession,
        // so reusing it would bypass this row's required real comment entry.
        // Production shutdown: heartbeat/recovery.ts:486-491 calls
        // closeIdleWarmNativeSessionsForRestart (executor.ts:1160-1165).
        // Production next boot: index.ts:1771 calls recoverNativeRunsAfterRestart;
        // controller-process-identity.ts captures a NEW process identity on boot.
        // Calling those in this same process is NOT a restart. Instead let
        // executor.ts:9114-9162's REAL runnerIdleTimeoutMs timer retire the warm
        // owner. No fake timers, registry clearing, identity rotation or restart
        // recovery call is substituted. A must still be live for real close.
        const scopeDigest = basename(stateRoot);
        expect(execution.session.lifecyclePolicy).toMatchObject({ mode: "warm", idleTimeoutMs });
        expect(nativeSessionScopeDigestIsBusy(scopeDigest), "D-B8 opening has a real registered warm owner before idle retirement").toBe(true);
        const idleWaitStartedAt = Date.now();
        await waitFor("D-B8 real idle timer retired the opening warm scope", async () =>
          nativeSessionScopeDigestIsBusy(scopeDigest) ? null : true, idleTimeoutMs + 120_000);
        // The scoped probe covers both the warm owner and its in-flight close;
        // dead process births alone would reproduce N+1, not prove retirement.
        expect(nativeSessionScopeDigestIsBusy(scopeDigest), "no stale warm owner or unfinished idle close before replacement").toBe(false);
        retainedCheckpoint = await readFile(checkpointPath);
        const naturalBackups = existsSync(backupRoot) ? readdirSync(backupRoot, { recursive: true }) : [];
        const retirement = { case: caseName, shape, method: "real-idle-timer-fallback", trueProcessRestart: false,
          idleTimeoutMs, idleWaitStartedAt, retiredAt: new Date().toISOString(), scopeDigest, ownerPresent: false,
          naturalBackups, checkpointChanged: !retainedCheckpoint.equals(checkpoint),
          survivingOpeningBirths: [...runners, ...pis].filter(sameBirth) };
        stage("opening warm owner retired by real idle timer", retirement);
        console.log(`E2E-REAL-ENTRY-RESTART: ${JSON.stringify(retirement)}`);
        // Keep every natural backup/checkpoint; if one restores private history,
        // R2 below must expose that outcome, not remove evidence to force GREEN.
        expect(await readFile(openingSessionFile, "utf8")).toContain(privateFact);
      }
      // Reuse G2's external image-swap mechanics: stop exact measured A births,
      // retain the measured JSONL, move its whole disk aside, mount empty B at
      // the SAME path. N+1 does not gracefully close A or mutate controller state;
      // D-B8's explicitly logged idle retirement above is its only extra step.
      await stopBoxProcesses(); allocations.set(allocationIds[0]!, "stopped"); leaseActive.set(allocationIds[0]!, false);
      await rename(openingSessionFile, join(root, "A-pi-conversation-retained.jsonl"));
      const oldDisk = join(root, "image-A-disk-retained"); await rename(remoteCwd, oldDisk); await mkdir(remoteCwd);
      expect(readdirSync(remoteCwd), "replacement B starts with a truly empty disk").toEqual([]);
      stage("box A stopped; empty B replaces its disk", { oldDisk, remoteCwd, oldProviderLeaseId: allocationIds[0], newProviderLeaseId: allocationIds[1] });
      generation = 2; await installImagePack();
      expect(existsSync(openingSessionFile), "A's measured Pi JSONL is absent on B").toBe(false);
      expect(await readFile(join(root, "A-pi-conversation-retained.jsonl"), "utf8")).toContain(privateFact);
      expect((await readFile(checkpointPath)).equals(retainedCheckpoint), "controller warm envelope survives the box swap unmodified").toBe(true);
      if (shape === "restart") expect(nativeSessionScopeDigestIsBusy(basename(stateRoot)), "D-B8 has no stale A owner at answer admission").toBe(false);
      await db.update(environments).set({ config: { ...environmentConfig, image: "fixture:image-B" } }).where(eq(environments.id, environmentId));
      // The ONLY case delta, immediately before the person replies. Never seed
      // a replacement conversation or a native run/checkpoint by hand.
      if (caseName === "deleted-task-session") {
        const removed = await db.delete(agentTaskSessions).where(taskScope()).returning();
        expect(removed.map(row => row.id)).toEqual([openingTaskSession!.id]);
        expect(await db.select().from(agentTaskSessions).where(taskScope())).toEqual([]);
      } else if (caseName === "record-kept") {
        // The control: the opening turn's record stays exactly as the heartbeat wrote it.
        const [still] = await db.select().from(agentTaskSessions).where(taskScope());
        expect(still?.id, "record-kept: the opening record is untouched").toBe(openingTaskSession!.id);
        expect(still?.sessionParamsJson).toEqual(openingTaskSession!.sessionParamsJson);
      } else {
        const [kept] = await db.update(agentTaskSessions).set({ sessionParamsJson: null }).where(taskScope()).returning();
        expect(kept!.id).toBe(openingTaskSession!.id); expect(kept!.sessionParamsJson).toBeNull();
        expect(kept!.lastRunId).toBe(openingTaskSession!.lastRunId);
      }
      const response = await comment("What fact did I tell you?"); followupCommentId = response.id;
      const next = await runForComment(response.id); followupRunId = next.id;
      expect(next.id).not.toBe(opening.id);
      const followup = await finishRun(next.id);
      expect(followup.runtimeMode, "follow-up must take the real native heartbeat path too").toBe("native");
      const first = await logOutcome(followup.id, 1);
      let restartAfterSweep: Record<string, unknown> | undefined;
      if (shape === "restart") {
        // Run upstream recovery before asserting admission and saved history.
        expect(followup.finishedAt).not.toBeNull();
        const settledRecovery = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
        restartAfterSweep = await logOutcome(followup.id, 1);
        recoveryObservation = { case: caseName, shape, trueProcessRestart: false, method: "real-idle-timer-fallback",
          settledRecovery, afterRecovery: restartAfterSweep };
        console.log(`E2E-REAL-ENTRY-RECOVERY: ${JSON.stringify(recoveryObservation)}`);
        console.log(`E2E-REAL-ENTRY-ADMISSION: ${JSON.stringify({ case: caseName, shape, runId: followup.id,
          status: restartAfterSweep.status, errorCode: restartAfterSweep.errorCode, admissionPath: restartAfterSweep.admissionPath,
          sessionRecovery: restartAfterSweep.sessionRecovery })}`);
        if (caseName === "record-kept") {
          const observed = restartAfterSweep;
          const keptNotes = observed.notes as string[];
          // 'answered' in readOutcome matches only the no-history reply; the control also accepts the
          // with-history reply (K0b 16:34Z: the agent replied RECALLED_<fact>).
          const keptReplies = (observed.visibleComments as Array<{ authorType: string; createdByRunId: string | null; body: string }>)
            .filter(comment => comment.authorType === "agent" && comment.createdByRunId === followup.id
              && (comment.body.includes(`RECALLED_${privateFact}`) || comment.body.includes(followupAnswer)));
          expect(keptReplies, `control: the person's answer is answered: ${JSON.stringify(observed).slice(0, 600)}`).toHaveLength(1);
          if (keptReplies[0]!.body.includes(`RECALLED_${privateFact}`)) expect(observed.historyPresent, "a RECALLED reply carries the history").toBe(true);
          expect(observed.historyPresent === true || (keptNotes.length === 1 && [MISSING_FILE_NOTE, PRE_RECORD_NOTE].includes(keptNotes[0]!)),
            "control: answered WITH history, or exactly one approved note").toBe(true);
          return;
        }
        // RFL 16:40Z: pre-existing upstream new-session design when the record is deleted/cleared mid-conversation (same on c2 74ccf170 and e8f338f7); not D-B8 or S.
        // Measured on faace293, e8f338f7 and c2 (CL1/K1b/K2b 16:2x-16:39Z): answered, history ABSENT,
        // 0 notes, and the follow-up selects a NEW generation-1 Pi conversation record.
        {
          const observed = restartAfterSweep;
          const followupRecord = records.find(observation => record(observation).attempt === 1) as Record<string, unknown> | undefined;
          expect(observed.answered, `measured: the follow-up answers: ${JSON.stringify(observed).slice(0, 400)}`).toBe(true);
          expect(observed.historyPresent, "measured: history ABSENT in the model request").toBe(false);
          expect(observed.notes, "measured: 0 notes after the 15 s sweep").toEqual([]);
          expect(followupRecord, "measured: a record exists before preparation").toMatchObject({ exists: true, generation: 1 });
          expect(followupRecord!.id, "measured: a NEW conversation record, not the opening's").not.toBe(openingConversation!.id);
          return;
        }
      }
      expect(records.filter(observation => record(observation).attempt === 1), "R1 observes the FOLLOW-UP real selection").toHaveLength(1);
      const nextLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, followup.id));
      expect(nextLeases).toHaveLength(1); expect(nextLeases[0]).toMatchObject({ environmentId, providerLeaseId: allocationIds[1] });
      expect(providerCalls.filter(call => call.generation === 2).map(call => call.method)).toContain("environmentAcquireLease");
      expect(providerCalls.filter(call => call.generation === 2 && call.method === "environmentResumeLease").some(call => call.input.providerLeaseId === allocationIds[0])).toBe(false);

      const assertHistoryLossOutcome = (observed: Record<string, unknown>, runId: string) => {
        const followupRequests = requests.filter(request => request.runId === runId);
        expect(observed.answered, JSON.stringify(observed)).toBe(true);
        expect(followupRequests.length, "Pi must actually ask the faux model on B").toBeGreaterThan(0);
        expect(observed.historyPresent, "private opening history is absent from B's model request").toBe(false);
        for (const request of followupRequests) expect(JSON.stringify(request.request), "no private fact replay via system, user, handoff or assistant content").not.toContain(privateFact);
        const notes = observed.notes as string[];
        expect(notes, "exactly ONE system history-loss note").toHaveLength(1);
        expect([MISSING_FILE_NOTE, PRE_RECORD_NOTE], "only branch (i) or (ii) is acceptable").toContain(notes[0]);
        expect(observed.branch).not.toBe("neither");
      };
      // Since RFL 16:40Z every restart-shape row returns above with its measured outcome, so this
      // D-B8 R2 block is kept only as the record of the original lift target; the widened type keeps
      // it compiling.
      if ((shape as Shape) === "restart") {
        // Never count a refusal + unanswered-message note as R2 GREEN.
        const afterSweep = restartAfterSweep!;
        assertHistoryLossOutcome(afterSweep, followup.id);
        const path = admissionSteps.filter(step => step.runId === followup.id);
        expect(path.some(step => step.phase === "runner.transport.resume"), "D-B8 follow-up reached the actual Pi resume ladder").toBe(true);
        expect(path.some(step => step.phase === "runner.transport.cold_start" && step.outcome === "ok"), "D-B8 Pi cold admission reached a real provider session").toBe(true);
        // Branch (ii) is allowed, but branch (i) needs a runner-owned typed
        // recovery receipt, not just text that happens to look like its note.
        if ((afterSweep.notes as string[])[0] === MISSING_FILE_NOTE)
          expect((afterSweep.sessionRecovery as Array<{ sessionRecovery: unknown }>).some(entry =>
            record(entry.sessionRecovery).code === "pi_session_file_missing"), "D-B8 runner reports pi_session_file_missing").toBe(true);
        const notesBeforeReplay = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
          .filter(comment => comment.authorType === "system" && !comment.deletedAt).map(comment => comment.id);
        await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
        expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
          .filter(comment => comment.authorType === "system" && !comment.deletedAt).map(comment => comment.id), "D-B8 sweep replay does not add a second note").toEqual(notesBeforeReplay);
      } else if (followup.status === "succeeded") {
        assertHistoryLossOutcome(first, followup.id);
      } else {
        expect(first).toMatchObject({ status: "failed", errorCode: "native_predecessor_retirement_unproven", answered: false, requestCount: 0, notes: [] });
        followupAttempt = 2;
        // These are the worker/timer's production entries, NOT retryScheduledRetryNow,
        // a fresh person message, or an inserted heartbeat/coordinator/marker.
        // Native retry: heartbeat.ts:1860 / recovery.ts:2287. Scheduled heartbeat
        // retry: heartbeat/dispatch-work.ts:26. Use persisted due times and real
        // time: passing a future `now` would not prove production admission.
        const [beforeRecovery] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, followup.id));
        if (beforeRecovery?.phase === "retryable_failure" && beforeRecovery.nextAttemptAt)
          await waitFor("persisted native retry deadline", async () => Date.now() >= beforeRecovery.nextAttemptAt!.getTime() ? true : null);
        const [sessionBeforeRecovery] = await db.select().from(agentTaskSessions).where(taskScope());
        const conversationBeforeRecovery = piConversations.readPiConversation(sessionBeforeRecovery?.sessionParamsJson);
        const nativeRecovery = await heartbeat.recoverNativeRunsAfterRestart(new Date(), [followup.id], { trigger: "same_run_retry" });
        if (nativeRecovery.claims.some(claim => claim.runId === followup.id)) {
          retryRunId = followup.id;
          // Some same-run restart paths reuse persisted input and do not select
          // again. Read R1 BEFORE invoking that production preparation entry.
          const observation = { case: caseName, shape, attempt: 2, runId: followup.id, seam: "before-production-native-recovery",
            exists: conversationBeforeRecovery !== null, id: conversationBeforeRecovery?.id ?? null,
            generation: conversationBeforeRecovery?.generation ?? null };
          records.push(observation); console.log(`E2E-REAL-ENTRY-RECORD: ${JSON.stringify(observation)}`);
          expect(conversationBeforeRecovery, "same-run R1 exists before production recovery preparation").not.toBeNull();
        }
        const successorRuns = async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
          .filter(run => run.id !== opening.id && run.id !== followup.id);
        const scheduled = (await successorRuns()).filter(run => run.status === "scheduled_retry");
        expect(scheduled.length, "no duplicate automatic retry for one message").toBeLessThanOrEqual(1);
        if (scheduled[0]?.scheduledRetryAt)
          await waitFor("persisted heartbeat retry deadline", async () => Date.now() >= scheduled[0]!.scheduledRetryAt!.getTime() ? true : null);
        const promotion = await heartbeat.promoteDueScheduledRetries();
        const deferredDeadlines: number[] = [];
        const strandedRecovery = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId,
          onDeferredDeadline: at => deferredDeadlines.push(at) });
        // The same dispatch worker also redrives durable queued admissions.
        const queuedDispatch = await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
        const successors = await successorRuns();
        expect(successors.length, "only the production scheduler/recovery can create the next attempt").toBeLessThanOrEqual(1);
        if (successors[0]) retryRunId = successors[0].id;
        recoveryObservation = { case: caseName, shape, nativeRecovery, promotion, strandedRecovery, queuedDispatch, deferredDeadlines,
          beforeRecovery: beforeRecovery ?? null, successorRunIds: successors.map(run => run.id) };

        if (retryRunId) {
          const retried = await finishRun(retryRunId);
          expect(retried.runtimeMode).toBe("native");
          const second = await logOutcome(retried.id, 2);
          expect(records.filter(observation => record(observation).attempt === 2 && record(observation).exists === true).length,
            "R1 is repeated before the production retry's preparation, not inferred from attempt 1").toBeGreaterThan(0);
          assertHistoryLossOutcome(second, retried.id);
        } else {
          // The A -> B fixture currently takes this path. Fallback marks only
          // THIS run's leases matching the error's sandbox A; this run owns B
          // (predecessor-retirement-fallback.ts:44-49), so no marker/contract is
          // installed. b78a335e's before-provider-turn exception does not apply:
          // only the providerAdmissionPersisted catch creates that typed error;
          // predecessor retirement passes through its own typed error unchanged.
          // Preservation makes observed terminal_failure/blocked
          // (native-failed-workspace-recovery.ts:166-176), not retryable_failure.
          // Never manufacture attempt:2 to make the successful-reply R2 pass.
          // Drive upstream's recovery owner. A failure notice is not a history-loss reply.
          const settledRecovery = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
          const afterRecovery = await readOutcome(followup.id, 1);
          const visibleComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
          const visibleNotes = visibleComments.filter(comment => comment.authorType === "system" && !comment.deletedAt);
          recoveryObservation = { ...recoveryObservation, automaticNextAttempt: false, settledRecovery, afterRecovery };
          console.log(`E2E-REAL-ENTRY-RECOVERY: ${JSON.stringify(recoveryObservation)}`);
          expect(nativeRecovery.claims).toEqual([]);
          expect(promotion).toMatchObject({ promoted: 0, runIds: [] });
          expect(beforeRecovery).toMatchObject({ phase: "terminal_failure", recoveryState: "blocked", nextAttemptAt: null });
          expect(nextLeases.every(lease => record(lease.metadata).replaceBeforeReuse === undefined), "no production replacement marker on B").toBe(true);
          expect(afterRecovery).toMatchObject({ status: "failed", answered: false, requestCount: 0, branch: "neither" });
          expect(visibleNotes, "exactly one upstream failure notice, not a fabricated history-loss reply").toHaveLength(1);
          expect(visibleComments.filter(comment => !comment.deletedAt).map(comment => comment.id).sort(),
            "the person sees the unchanged opening exchange, their unanswered message, and this one failure note")
            .toEqual([...comments.filter(comment => !comment.deletedAt).map(comment => comment.id), response.id, visibleNotes[0]!.id].sort());
          expect(visibleComments.filter(comment => !comment.deletedAt && comment.createdByRunId === followup.id && comment.authorAgentId === agentId)).toEqual([]);
          expect(await successorRuns(), "the recovery sweep did not invent a new attempt").toEqual([]);
          expect(records).toHaveLength(1);
          // A second production pass proves notice deduplication, not just a
          // single successful write. It must neither retry nor add a note.
          await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
          expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
            .filter(comment => comment.authorType === "system" && !comment.deletedAt).map(comment => comment.id)).toEqual([visibleNotes[0]!.id]);
          expect(await successorRuns()).toEqual([]);
        }
      }
    } catch (error) { failure = error; throw error; }
    finally {
      const cleanupErrors: unknown[] = [];
      // Preserve the latest admitted attempt even when a preceding assertion
      // failed. Never send a second message to repair a failed run.
      if (!outcome || retryRunId && !outcomes.some(observed => observed.attempt === 2)) try {
        outcome = await readOutcome(retryRunId ?? followupRunId, retryRunId ? 2 : 1);
        if (outcome) { outcomes.push(outcome); console.log(`E2E-REAL-ENTRY-OUTCOME: ${JSON.stringify(outcome)}`); }
      } catch (error) { cleanupErrors.push(error); }
      if (db && heartbeat) {
        try {
          const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
          for (const run of runs) {
            if (["running", "queued"].includes(run.status)) await heartbeat.cancelRun(run.id, "Owned real-entry fixture teardown");
            await heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 30_000 });
          }
          await heartbeat.drainActiveRunExecutions();
        } catch (error) { cleanupErrors.push(error); }
      }
      try {
        const closure = await closeIdleWarmNativeSessionsForRestart();
        // This shape's premise: the opening run's warm owner sits on dead box A, so its close
        // can only fail with the provider's lease-gone error (RE4/RE5 15:41Z). Record exactly
        // that as evidence; any other failure, or a busy owner, still fails the row.
        const expectedDeadBox = (failure: { providerLeaseId?: string | null; reason?: string }) =>
          String(failure.providerLeaseId ?? "").startsWith("image-A-") && failure.reason === "close failed: Boat sandbox lease is no longer active";
        // The warm registry is process-wide: a previous case's dead-A owner (its database already
        // stopped) is closed here too (PRE 16:03Z: CONNECTION_ENDED). Judge only THIS case's owners.
        const ownedHere = (failure: { runId?: string | null }) => failure.runId === openingRunId || failure.runId === followupRunId;
        const unexpected = closure.failures.filter(failure => ownedHere(failure) && !expectedDeadBox(failure));
        await writeFile(join(root, "warm-closure.json"), JSON.stringify(closure, null, 2));
        if (unexpected.length || closure.busy) cleanupErrors.push({ ...closure, unexpected });
      } catch (error) { cleanupErrors.push(error); }
      // A model assertion must not prevent exact owned process cleanup.
      modelFailure = undefined;
      try { await stopBoxProcesses(); } catch (error) { cleanupErrors.push(error); }
      unsubscribe?.(); vi.restoreAllMocks();
      for (const socket of sockets) socket.terminate(); ws.close();
      if (preview?.listening) await new Promise<void>(done => preview!.close(() => done()));
      if (apiServer?.listening) { apiServer.closeAllConnections(); await new Promise<void>(done => apiServer!.close(() => done())); }
      model.closeAllConnections(); if (model.listening) await new Promise<void>(done => model.close(() => done()));
      if (db) for (const [name, table] of [["runs", heartbeatRuns], ["events", heartbeatRunEvents], ["leases", environmentLeases], ["comments", issueComments], ["task-sessions", agentTaskSessions], ["native-finalizations", nativeRunFinalizations]] as const) {
        // One JSON line per row: RE2 15:10Z hit 'Invalid string length' stringifying a whole table at once.
        try {
          const file = join(root, `${name}.jsonl`); await writeFile(file, "");
          for (const row of await db.select().from(table)) await appendFile(file, `${JSON.stringify(row)}\n`);
        } catch (error) { cleanupErrors.push(error); }
      }
      try { await stopPostgres?.(); } catch (error) { cleanupErrors.push(error); }
      fixtureHttpsAgent?.destroy(); https.globalAgent = previousHttpsAgent; setDefaultCACertificates(previousCertificates); vi.unstubAllEnvs();
      await writeFile(join(root, "proof.json"), JSON.stringify({ case: caseName, shape, openingRunId, followupRunId, retryRunId, records, outcomes, outcome, recoveryObservation, admissionSteps, requests, providerCalls, commands, stages,
        processes: { runners, pis, remainingOwned: [...runners, ...pis].filter(sameBirth) }, failure: failure instanceof Error ? failure.stack : failure,
        cleanupErrors: cleanupErrors.map(String) }, null, 2));
      console.log(`Pi real-entry governed-wait evidence retained: ${root}`);
      if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "real-entry body/cleanup failed; evidence retained");
    }
  }, 600_000,
);
