import { createHash, randomUUID } from "node:crypto";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, agentWakeupRequests } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

// RFL G-4: recorded production catch, b13 lost every continuing conversation
// when an env secret_ref(version=latest) resolved to a newer version. Existing
// features first: doc/agent-env-github-authentication.md:5-20 documents the env
// binding; doc/logs/2026-05-24-cli-api-parity-e2e-log.md:394-404 documents rotate.
// doc/RUNNER-INTEGRATION-PLAYBOOK.md:578-587 distinguishes conversation from
// process continuity. We require the SAME conversation and a NEW process with
// fresh env, NOT reuse of a process that still has the stale secret. Keep the
// effective-run-config fingerprint's resolved-version semantics unchanged.
// Real HTTP/server/Postgres/runnerd/Pi; only the credential-free model is scripted.
// Generated sample values are not credentials. Never print their plaintext.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";
const secretKey = "PI_ROTATING_SECRET_SAMPLE";
type Bundle = ReturnType<typeof import("../vendor/paperclip-runner/index.js").createRunnerdCodexTransport>;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function piDescendant(runnerPid: number): number | null {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      children.set(ppid, [...children.get(ppid) ?? [], Number(entry)]);
    } catch { /* process exited during snapshot */ }
  }
  const visit = (pid: number): number | null => {
    for (const child of children.get(pid) ?? []) {
      try {
        const command = readFileSync(`/proc/${child}/cmdline`, "utf8").replaceAll("\0", " ");
        const comm = readFileSync(`/proc/${child}/comm`, "utf8").trim().toLowerCase();
        if (comm === "pi" || (command.includes("--mode rpc") && /(?:cli|bundle)\.js/.test(command))) return child;
      } catch { /* process exited during snapshot */ }
      const found = visit(child); if (found) return found;
    }
    return null;
  };
  return visit(runnerPid);
}

it.skipIf(!enabled)("latest secret rotation refreshes the Pi process without losing its conversation or private history", async () => {
  expect(thinking).toBe("xhigh");
  expect(process.env.PAPERCLIP_PI_E2E_PROTOCOL ?? "messages").toBe("messages");
  expect(process.env.TMPDIR, "dedicated test tmpdir is required").toBeTruthy();
  if (process.platform !== "linux") throw new Error("The real process/env proof requires Linux");
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH)
    throw new Error("Set qualified PAPERCLIP_RUNNER_BINARY and PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH");
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-secret-rotation-"));
  const privateFact = `PI_PRIVATE_MEMORY_${randomUUID()}`;
  const sampleValues = [randomUUID().repeat(2), randomUUID().repeat(2)];
  const expectedHashes = sampleValues.map(sha256);
  const stages: Array<{ at: string; stage: string; detail: unknown }> = [];
  const stage = (name: string, detail: unknown = {}) => {
    stages.push({ at: new Date().toISOString(), stage: name, detail });
    console.log(`[pi-secret-rotation] ${name} ${JSON.stringify(detail)}`);
  };
  const bundles: Bundle[] = [];
  const requests: Array<{ turn: number; remembersPrivateFact: boolean; incomingContainsFact: boolean; messages: unknown[] }> = [];
  const turnProofs: Array<{ turn: number; runId: string; nativeSessionId: string | null; runnerPid: number; piPid: number;
    piStartTicks: string; envHash: string; providerSessionId: string; sessionFile: string;
    assistantHistoryRecall: boolean; latestInputContainsFact: boolean; reply: string }> = [];
  let activeTurn = 1, helloProbeRequests = 0;
  const finished = new Set<number>();
  let modelServer: Server | undefined, http: Server | undefined;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let companyId = "", agentId = "", issueId = "";
  let unsubscribe: (() => void) | undefined, changed: (() => void) | undefined;
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  for (const key of Object.keys(process.env)) if (key.startsWith("LANGFUSE_")) vi.stubEnv(key, undefined);
  vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home"));
  vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(root, "master.key"));
  vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_HTTPS", "off");
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("OTEL_SDK_DISABLED", "true");
  // Normal checks are event-driven; the bounded 250ms safety net also observes
  // startup/DB persistence boundaries that do not emit company live events.
  const waitFor = async <T>(label: string, probe: () => Promise<T | null>): Promise<T> => {
    const deadline = Date.now() + Number(process.env.PAPERCLIP_PI_E2E_WAIT_MS ?? 120_000);
    while (Date.now() < deadline) {
      const value = await probe(); if (value !== null) return value;
      if (db && agentId) {
        const failure = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
          .find(run => run.status === "failed" || run.status === "timed_out");
        if (failure) throw new Error(`${label}: run failed ${JSON.stringify({ id: failure.id, status: failure.status, errorCode: failure.errorCode, error: failure.error })}`);
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { changed = undefined; resolve(); }, 250);
        changed = () => { clearTimeout(timer); changed = undefined; resolve(); };
      });
    }
    throw new Error(`Timed out at ${label}`);
  };
  try {
    modelServer = createServer((req, res) => {
      let body = ""; req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        try {
          if (new URL(req.url ?? "", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
          const parsed = JSON.parse(body);
          if (respondToNativePiHello(parsed, res, "messages")) { helloProbeRequests++; return; }
          const remembersPrivateFact = (parsed.messages ?? []).some((message: { role: string; content: unknown }) =>
            message.role === "assistant" && JSON.stringify(message.content).includes(privateFact));
          const incomingContainsFact = JSON.stringify(parsed.messages?.at(-1)).includes(privateFact);
          requests.push({ turn: activeTurn, remembersPrivateFact, incomingContainsFact, messages: parsed.messages ?? [] });
          let contract: { revision: string; criteria: Array<{ id: string }> } | undefined;
          for (const message of parsed.messages ?? []) {
            if (message.role !== "user") continue;
            for (const part of typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? []) {
              if (part.type !== "text") continue;
              try {
                const value = JSON.parse(part.text);
                if (value.completionContract) contract = value.completionContract;
                if (value.schema === "paperclip.native-continuation.v1" && value.completion)
                  contract = { revision: value.completion.revision, criteria: value.completion.criterionIds.map((id: string) => ({ id })) };
              } catch { /* not a native envelope */ }
            }
          }
          const useFinish = !finished.has(activeTurn);
          const reply = activeTurn === 1 ? "TURN_1_SEEDED" : remembersPrivateFact ? "TURN_2_RECALL_OK" : "TURN_2_HISTORY_LOST";
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
          emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
          const text = useFinish && activeTurn === 1 ? `Private fact: ${privateFact}` : reply;
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
          emit("content_block_stop", { index: 0 });
          if (useFinish) {
            if (!contract) throw new Error("Model request lacks the current completion contract");
            finished.add(activeTurn);
            const input = { reportedWorkDisposition: "done", summary: reply,
              evidence: [{ ref: "provider:pi_rpc:agent-message" }], verification: [], attentionRequests: [], artifacts: [],
              completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
                criteria: contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: ["provider:pi_rpc:agent-message"] })), remainingWork: [] } };
            emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: `finish-${activeTurn}`, name: "paperclip_finish", input: {} } });
            emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
            emit("content_block_stop", { index: 1 });
          }
          emit("message_delta", { delta: { stop_reason: useFinish ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
          emit("message_stop", {}); res.end();
          stage("model request", { activeTurn, useFinish, remembersPrivateFact, incomingContainsFact });
        } catch (error) {
          stage("model fixture error", { error: String(error) });
          if (!res.headersSent) res.writeHead(500); res.end(String(error));
        }
      });
    });
    await new Promise<void>(resolve => modelServer!.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("No loopback model listener");
    const baseUrl = `http://127.0.0.1:${modelAddress.port}`;
    const temporary = await startEmbeddedPostgresTestDatabase("native-pi-secret-rotation-db-");
    db = createDb(temporary.connectionString);
    // Stop only our port-matched postgres; retain its database and traces.
    const pgPort = new URL(temporary.connectionString).port;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
        if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== pgPort) continue;
        const dataDir = args[args.indexOf("-D") + 1]!;
        const pgCtl = args[0].replace(/postgres$/, "pg_ctl");
        stopRetainedPostgres = async () => {
          const { closeRegisteredClients } = await import("@paperclipai/db");
          await closeRegisteredClients(temporary.connectionString);
          const result = await runChildProcess(`pi-rotation-pg-stop-${entry}`, pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"],
            { cwd: root, env: {}, timeoutSec: 30, graceSec: 1, onLog: async () => {} });
          expect(result.exitCode, "owned retained Postgres shutdown").toBe(0);
          stage("owned Postgres stopped; files retained", { pid: Number(entry), dataDir });
        };
        break;
      } catch { /* not our postgres */ }
    }
    expect(stopRetainedPostgres).toBeDefined();
    const [{ createApp }, { createStorageService }, { createLocalDiskStorageProvider }, runner, { setupRunnerPrpWebSocketServer }, { subscribeCompanyLiveEvents }] = await Promise.all([
      import("../app.js"), import("../storage/service.js"), import("../storage/local-disk-provider.js"),
      import("../vendor/paperclip-runner/index.js"), import("../realtime/runner-prp-ws.js"), import("../services/live-events.js"),
    ]);
    const realFactory = runner.createRunnerdCodexTransport;
    // Observation only: every call runs the unmodified production transport.
    vi.spyOn(runner, "createRunnerdCodexTransport").mockImplementation(options => {
      expect(options?.provider).toBe("pi_rpc"); expect(options?.piRpcThinkingLevel).toBe(thinking);
      const bundle = realFactory(options); bundles.push(bundle); return bundle;
    });
    app = await createApp(db, {
      uiMode: "none", serverPort: 0, storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
      authReady: true, companyDeletionEnabled: false, instanceId: `local-pi-${randomUUID()}`,
      localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [], decisionServiceOptions: { wakeOriginAgent: async () => undefined },
    });
    await app.locals.bundledPluginsStartup;
    http = createServer(app);
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    const address = http.address(); if (!address || typeof address === "string") throw new Error("No full server listener");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("PAPERCLIP_API_URL", apiUrl);
    setupRunnerPrpWebSocketServer(http, { apiUrl });
    const api = async (method: string, path: string, body?: unknown, expected = 200) => {
      const response = await fetch(`${apiUrl}/api${path}`, { method, headers: { "content-type": "application/json", origin: apiUrl },
        signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      // Do not include request/response bodies in a secret-route failure.
      expect(response.status, `${method} ${path}`).toBe(expected);
      return JSON.parse(text);
    };
    const company = await api("POST", "/companies", { name: "Native Pi secret rotation proof" }, 201);
    companyId = company.id;
    await api("PATCH", `/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "local-board", name: "Local proof operator", email: "local-pi@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    unsubscribe = subscribeCompanyLiveEvents(companyId, () => changed?.());
    const secret = await api("POST", `/companies/${companyId}/secrets`, { name: "Rotating sample", key: secretKey, provider: "local_encrypted", value: sampleValues[0] }, 201);
    expect(secret.latestVersion).toBe(1);
    const adapterEnv = { TMPDIR: process.env.TMPDIR!, [secretKey]: { type: "secret_ref", secretId: secret.id, version: "latest" } };
    const connection = await api("POST", `/companies/${companyId}/ai-connections`, {
      provider: "anthropic", method: "api_key", name: "Loopback only", ownership: "personal", routing: {
        kind: "local", protocol: "messages", baseUrl, auth: "none", models: [{ id: "faux", label: "Local faux", thinkingLevels: [thinking] }],
      },
    }, 201);
    const binding = { mode: "delegated", provider: "anthropic", method: "api_key", connectionId: connection.connectionId, grantId: connection.grantId };
    const agent = await api("POST", `/companies/${companyId}/agents`, {
      name: "Pi rotation proof", role: "engineer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", cwd: workspace, model: "paperclip/faux", env: adapterEnv },
      runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false, wakeOnDemand: true } },
    }, 201);
    agentId = agent.id;
    await waitFor("managed native Pi hire verified", async () => {
      const [current] = await db!.select().from(agents).where(eq(agents.id, agentId));
      if (current?.lifecycleError) throw new Error(`Native Pi hire verification failed: ${JSON.stringify(current.lifecycleError)}`);
      return current?.lifecycleState === "ready" ? current : null;
    });
    expect(helloProbeRequests).toBeGreaterThan(0);
    const patched = await api("PATCH", `/agents/${agentId}`, {
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", cwd: workspace, model: "paperclip/faux", lifecycleMode: "warm", piRpcThinkingLevel: thinking, env: adapterEnv },
      runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false, wakeOnDemand: true } },
    });
    expect(patched.lifecycleState).toBe("ready");
    // The API adds normal projection defaults; retain the entire canonical
    // binding so turn 2 still proves that no agent configuration changed.
    expect(patched.adapterConfig.env[secretKey]).toMatchObject(adapterEnv[secretKey]);
    const canonicalSecretBinding = patched.adapterConfig.env[secretKey];
    const issue = await api("POST", `/companies/${companyId}/issues`, {
      title: "Preserve Pi conversation over secret rotation", description: "Privately remember a fact, finish done, then answer the next board comment.",
      status: "backlog", assigneeAgentId: agentId,
    }, 201);
    issueId = issue.id;
    const { heartbeatService } = await import("../services/heartbeat.js");
    for (activeTurn = 1; activeTurn <= 2; activeTurn++) {
      if (activeTurn === 2) {
        const rotated = await api("POST", `/secrets/${secret.id}/rotate`, { value: sampleValues[1] });
        expect(rotated.latestVersion).toBe(2);
        const current = await api("GET", `/agents/${agentId}`);
        expect(current.adapterConfig.env[secretKey], "same latest binding, no adapter patch between turns").toEqual(canonicalSecretBinding);
        stage("secret rotated through existing API", { secretId: secret.id, previousVersion: 1, latestVersion: rotated.latestVersion, expectedHashes });
      }
      const requestOffset = requests.length;
      const body = activeTurn === 1 ? "Privately remember a fact in your own history, finish done, then reply TURN_1_SEEDED."
        : "Recall the private fact from your own Pi history. Reply with the recall verdict only (not the fact), then finish done.";
      expect(body).not.toContain(privateFact);
      await api("POST", `/issues/${issueId}/comments`, { body, clientRequestId: randomUUID() }, 201);
      const admitted = await waitFor(`turn ${activeTurn} admitted`, async () =>
        (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
          .find(run => run.nativeIssueId === issueId && !turnProofs.some(proof => proof.runId === run.id)) ?? null);
      await waitFor(`turn ${activeTurn} succeeded`, async () => {
        const [run] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id));
        return run?.status === "succeeded" ? run : null;
      });
      await heartbeatService(db).waitForRunExecutionDrain(admitted.id, { timeoutMs: 15_000 });
      const reply = await waitFor(`turn ${activeTurn} published`, async () =>
        (await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
          .find(row => row.createdByRunId === admitted.id && row.authorAgentId === agentId && row.body.startsWith(`TURN_${activeTurn}_`) && row.deletedAt === null) ?? null);
      const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id));
      expect(settled!.nativeSessionId, "a real normalized conversation was persisted").toBeTruthy();
      const runnerPid = bundles.at(-1)?.transport.processInfo?.()?.pid;
      expect(runnerPid, "observe the current production transport").toBeGreaterThan(0);
      const piPid = piDescendant(runnerPid!);
      expect(piPid, "current runner owns a real Pi child").toBeGreaterThan(0);
      const environment = Object.fromEntries(readFileSync(`/proc/${piPid}/environ`, "utf8").split("\0").filter(Boolean)
        .map(entry => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
      expect(Object.hasOwn(environment, secretKey), "Pi actually inherited the bound secret").toBe(true);
      const envHash = sha256(environment[secretKey]!);
      const sessionFile = join(environment.PAPERCLIP_PI_RUNTIME_DIR!, `${environment.PAPERCLIP_NORMALIZED_SESSION_ID}.jsonl`);
      const sessionBytes = readFileSync(sessionFile, "utf8");
      const header = sessionBytes.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.type === "session");
      expect(header?.id, "independent native Pi session header").toBeTruthy();
      await writeFile(join(root, `pi-session-turn-${activeTurn}.jsonl`), sessionBytes);
      const stat = readFileSync(`/proc/${piPid}/stat`, "utf8");
      const firstRequest = requests[requestOffset];
      expect(firstRequest, "actual model request, not a model-authored claim").toBeDefined();
      const row = { turn: activeTurn, runId: settled!.id, nativeSessionId: settled!.nativeSessionId,
        runnerPid: runnerPid!, piPid: piPid!, piStartTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!,
        envHash, providerSessionId: String(header.id), sessionFile, assistantHistoryRecall: firstRequest!.remembersPrivateFact,
        latestInputContainsFact: firstRequest!.incomingContainsFact, reply: reply.body };
      turnProofs.push(row);
      await writeFile(join(root, "turns.json"), JSON.stringify(turnProofs, null, 2));
      stage(`turn ${activeTurn} observation`, row);
      expect(envHash, `turn ${activeTurn} Pi environment matches resolved secret version ${activeTurn}`).toBe(expectedHashes[activeTurn - 1]);
      expect((await api("GET", `/issues/${issueId}`)).status).toBe("done");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(JSON.stringify(comments), "fact remains Pi-only, not replayable from the Paperclip thread").not.toContain(privateFact);
      if (activeTurn === 1) {
        expect(reply.body).toBe("TURN_1_SEEDED");
        expect(sessionBytes, "the first native session really saved the assistant-only fact").toContain(privateFact);
      } else {
        expect(settled!.contextSnapshot?.wakeReason).toBe("issue_reopened_via_comment");
        // Soft assertions retain all independent red-baseline observations.
        expect.soft(row.nativeSessionId, "secret rotation keeps the SAME nativeSessionId").toBe(turnProofs[0]!.nativeSessionId);
        expect.soft(row.providerSessionId, "the actual Pi conversation is also unchanged").toBe(turnProofs[0]!.providerSessionId);
        expect.soft(row.assistantHistoryRecall, "Pi sends its own private history").toBe(true);
        expect.soft(row.latestInputContainsFact, "new user input must not replay the private fact").toBe(false);
        expect.soft(reply.body).toBe("TURN_2_RECALL_OK");
        expect.soft(row.piPid, "rotation launches a NEW Pi process, never a stale-env warm process").not.toBe(turnProofs[0]!.piPid);
        expect.soft(row.envHash).not.toBe(turnProofs[0]!.envHash);
      }
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)), "no hidden retries").toHaveLength(2);
    stage("both rotation observations retained", { companyId, agentId, issueId, expectedHashes, turnProofs });
  } catch (error) {
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ stages, expectedHashes, requests, turnProofs }, null, 2) + "\n");
    if (db && agentId) {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      await writeFile(join(root, "runs.json"), JSON.stringify(runs, null, 2));
      for (const run of runs) {
        await writeFile(join(root, `events-${run.id}.json`), JSON.stringify(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)), null, 2));
        await heartbeatServiceForCleanup(run.id);
      }
      if (issueId) await writeFile(join(root, "comments.json"), JSON.stringify(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)), null, 2));
      await writeFile(join(root, "wakeups.json"), JSON.stringify(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)), null, 2));
    }
    unsubscribe?.();
    for (const bundle of bundles) await bundle.transport.close().catch(error => console.error("Owned runner teardown", error));
    await app?.locals.paperclipShutdown?.();
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    if (modelServer) { modelServer.closeAllConnections(); await new Promise<void>(resolve => modelServer!.close(() => resolve())); }
    await stopRetainedPostgres?.();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    console.log(`[pi-secret-rotation] evidence retained at ${root}`);
  }
  async function heartbeatServiceForCleanup(runId: string) {
    const { heartbeatService } = await import("../services/heartbeat.js");
    await heartbeatService(db!).waitForRunExecutionDrain(runId, { timeoutMs: 15_000 }).catch(error => console.error("Owned run drain", error));
  }
}, 600_000);
