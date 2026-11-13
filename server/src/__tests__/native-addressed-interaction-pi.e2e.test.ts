import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueThreadInteractions, agentWakeupRequests, issueComments } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { prepareNativePiHomeProof } from "./helpers/native-pi-home-load-proof.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

const fixture = process.env.PAPERCLIP_PI_E2E_HOME_FIXTURE;
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1"
  && !!fixture && existsSync(join(fixture, "SHA256SUMS"))
  && !!process.env.PAPERCLIP_PI_E2E_EVIDENCE;
it.skipIf(!enabled).each(["accept", "reject"] as const)("%s-right: A creates a card; automatic nonassignee B wake resolves it in the same successful run; continuation is once", async decision => {
  const expectedStatus = decision === "accept" ? "accepted" : "rejected";
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE!, `cardwake-${decision}-`));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const marker = `RFL_REQUEST_${decision}_${randomUUID()}`;
  const stages: unknown[] = [], modelRequests: any[] = [], bundles: any[] = [];
  const stage = (name: string, detail: unknown = {}) => { stages.push({ at: new Date().toISOString(), name, detail }); console.log(`[cardwake] ${name} ${JSON.stringify(detail)}`); };
  let db: ReturnType<typeof createDb> | undefined, temporary: any, app: any, http: Server | undefined, model: Server | undefined;
  let apiUrl = "", companyId = "", agentA = "", agentB = "", issueId = "", cardId = "";
  let changed: (() => void) | undefined, unsubscribe: (() => void) | undefined;
  let hello = 0, n = 0;
  const calls = new Map<string, Set<string>>();
  const allRuns = () => db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  const wait = async <T>(label: string, probe: () => Promise<T | null>, timeout = 90000): Promise<T> => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await probe(); if (value !== null) return value;
      if (companyId && db) { const failed = (await allRuns()).find(r => ["failed", "timed_out"].includes(r.status)); if (failed) throw new Error(`${label}: ${JSON.stringify({ id: failed.id, agentId: failed.agentId, status: failed.status, errorCode: failed.errorCode, error: failed.error })}`); }
      await new Promise<void>(resolve => { const timer = setTimeout(() => { changed = undefined; resolve(); }, 200); changed = () => { clearTimeout(timer); changed = undefined; resolve(); }; });
    }
    throw new Error(`Timed out: ${label}`);
  };
  const send = (res: ServerResponse, tool?: { name: string; input: any }, text = "Coordination response recorded.") => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (type: string, value: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit("message_start", { message: { id: `msg-${++n}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
    emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `call-${n}`, name: tool.name, input: {} } : { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } });
    emit("content_block_stop", { index: 0 }); emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }); emit("message_stop", {}); res.end();
  };
  const envelopes = (messages: any[]) => {
    const found: any[] = [];
    for (const msg of messages) if (msg.role === "user") for (const part of typeof msg.content === "string" ? [{ text: msg.content }] : msg.content ?? []) {
      if (typeof part.text === "string") try { const value = JSON.parse(part.text); if (value.schema === "paperclip.native-model-envelope.v3") found.push(value); } catch {}
    }
    return found;
  };
  const api = async (method: string, path: string, body?: any, expected = 200) => {
    const response = await fetch(`${apiUrl}/api${path}`, { method, headers: { "content-type": "application/json", origin: apiUrl }, signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); expect(response.status, `${method} ${path}: ${text}`).toBe(expected); return JSON.parse(text);
  };
  try {
    const home = await prepareNativePiHomeProof(root, process.env.PAPERCLIP_PI_E2E_HOME_FIXTURE!);
    const { readFile } = await import("node:fs/promises");
    const modelsPath = join(home.agentDir, "models.json");
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    models.providers.paperclip.models.push(...["faux-a", "faux-b"].map(id => ({ id, reasoning: true, contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } })));
    await writeFile(modelsPath, JSON.stringify(models, null, 2));
    for (const key of Object.keys(process.env)) if (key.startsWith("LANGFUSE_")) vi.stubEnv(key, undefined);
    vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home")); vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state")); vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_HTTPS", "off"); vi.stubEnv("PI_OFFLINE", "1"); vi.stubEnv("OTEL_SDK_DISABLED", "true");
    model = createServer((req, res) => {
      let body = ""; req.setEncoding("utf8"); req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          if (respondToNativePiHello(parsed, res, "messages")) { hello++; return; }
          const envelope = envelopes(parsed.messages ?? []).at(-1);
          modelRequests.push({ path: req.url, envelope, messages: parsed.messages, tools: (parsed.tools ?? []).map((t: any) => t.name) });
          if (!envelope) throw new Error("No real native model envelope in Pi input");
          expect(["faux-a", "faux-b"]).toContain(parsed.model);
          const actorId = parsed.model === "faux-b" ? agentB : agentA;
          const active = (await allRuns()).filter(r => r.agentId === actorId && r.status === "running");
          expect(active, "one running row correlates the real model request").toHaveLength(1);
          const issueId = active[0]!.nativeIssueId ?? active[0]!.contextSnapshot?.issueId;
          if (typeof issueId !== "string") throw new Error("Native model request has no bound issue");
          const binding = { runId: active[0]!.id, agentId: actorId, issueId };
          const done = calls.get(binding.runId) ?? new Set<string>(); calls.set(binding.runId, done);
          const next = (key: string, name: string, input: any) => { done.add(key); stage("model tool", { runId: binding.runId, agentId: binding.agentId, key, name, input }); send(res, { name, input }); };
          stage("model context", { binding, interactionResponses: envelope.interactionResponses, trigger: envelope.trigger });
          if (binding.agentId === agentA) {
            const priorCard = await db!.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, binding.issueId));
            if (!priorCard.length && !done.has("create")) {
              return next("create", "call_api", { operationId: "POST /api/issues/{id}/interactions", pathParams: { id: binding.issueId }, body: {
                kind: "request_confirmation", idempotencyKey: `cardwake:${binding.issueId}`, title: "Review this handoff", summary: marker,
                addresseeAgentId: agentB, resolverPolicy: "not_creator", continuationPolicy: "wake_assignee", payload: { version: 1, prompt: marker, supersedeOnUserComment: false },
              } });
            }
            if (!priorCard.length) throw new Error("Agent A's actual create tool failed; no card exists");
            cardId = priorCard[0]!.id;
            if (priorCard[0]!.status !== "pending") {
              expect(priorCard[0]!.status).toBe(expectedStatus);
              expect(envelope.interactionResponses ?? [], "requester receives the resolved card in its actual continuation input").toContainEqual(expect.objectContaining({ interactionId: cardId, response: expect.objectContaining({ status: expectedStatus }) }));
              stage("A received resolution continuation", { decision, cardId, runId: binding.runId });
            }
            return send(res, undefined, priorCard[0]!.status === "pending" ? "Awaiting the addressed agent's response on the saved card." : "The addressed response was received. Coordination is complete.");
          }
          if (binding.agentId !== agentB) throw new Error("Unexpected business agent");
          if (!done.has(decision)) {
            const request = (envelope.interactionResponses ?? []).find((r: any) => r.response?.status === "pending" && r.response?.payload?.prompt === marker);
            expect(request, "B receives the actual pending card request in its native input").toBeTruthy();
            cardId = request.interactionId;
            expect((parsed.tools ?? []).map((tool: any) => tool.name), "B's real provider tools expose call_api").toContain("call_api");
            return next(decision, "call_api", { operationId: `POST /api/issues/{id}/interactions/{interactionId}/${decision}`, pathParams: { id: binding.issueId, interactionId: cardId }, body: decision === "reject" ? { reason: "This handoff is not accepted; no underlying action is authorized." } : {} });
          }
          const [card] = await db!.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cardId));
          expect(card, "real B tool resolved the correct answer, not the harness").toMatchObject({ status: expectedStatus, result: { outcome: expectedStatus }, resolvedByAgentId: agentB, resolvedByRunId: binding.runId });
          stage("B verified its real resolution", { decision, cardId, runId: binding.runId });
          send(res, undefined, `I ${expectedStatus} the addressed handoff card. No underlying action has been authorized or performed.`);
        } catch (error) { stage("model fixture error", String(error)); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
      });
    });
    await new Promise<void>(resolve => model!.listen(0, "127.0.0.1", resolve));
    const modelAddr = model.address() as any;
    temporary = await startEmbeddedPostgresTestDatabase("judge-cardwake-db-"); db = createDb(temporary.connectionString);
    const [{ createApp }, { createStorageService }, { createLocalDiskStorageProvider }, runner, { setupRunnerPrpWebSocketServer }, { subscribeCompanyLiveEvents }] = await Promise.all([
      import("../app.js"), import("../storage/service.js"), import("../storage/local-disk-provider.js"), import("../vendor/paperclip-runner/index.js"), import("../realtime/runner-prp-ws.js"), import("../services/live-events.js"),
    ]);
    const realFactory = runner.createRunnerdCodexTransport;
    vi.spyOn(runner, "createRunnerdCodexTransport").mockImplementation(options => { const bundle = realFactory(options); bundles.push(bundle); return bundle; });
    app = await createApp(db, { uiMode: "none", serverPort: 0, storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))), deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: true, companyDeletionEnabled: false, instanceId: `cardwake-${randomUUID()}`, localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [], decisionServiceOptions: { wakeOriginAgent: async () => undefined } });
    await app.locals.bundledPluginsStartup; http = createServer(app); await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(http.address() as any).port}`; vi.stubEnv("PAPERCLIP_API_URL", apiUrl); setupRunnerPrpWebSocketServer(http, { apiUrl });
    companyId = (await api("POST", "/companies", { name: "RFL disposable card wake proof" }, 201)).id;
    await api("PATCH", `/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "local-board", name: "RFL judge", email: "judge@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    unsubscribe = subscribeCompanyLiveEvents(companyId, () => changed?.());
    const connection = await api("POST", `/companies/${companyId}/ai-connections`, { provider: "anthropic", method: "api_key", name: "Credential-free loopback", ownership: "personal", routing: { kind: "local", protocol: "messages", baseUrl: `http://127.0.0.1:${modelAddr.port}`, auth: "none", models: [{ id: "faux-a", label: "Requester", thinkingLevels: ["xhigh"] }, { id: "faux-b", label: "Addressee", thinkingLevels: ["xhigh"] }] } }, 201);
    const binding = { mode: "delegated", provider: "anthropic", method: "api_key", connectionId: connection.connectionId, grantId: connection.grantId };
    for (const name of ["A requester", "B addressee"]) {
      const agent = await api("POST", `/companies/${companyId}/agents`, { name, role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", cwd: workspace, model: name.startsWith("A") ? "paperclip/faux-a" : "paperclip/faux-b", piRpcThinkingLevel: "xhigh", env: { PI_CODING_AGENT_DIR: home.agentDir, TMPDIR: process.env.TMPDIR! } }, runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false, wakeOnDemand: true } } }, 201);
      if (name.startsWith("A")) agentA = agent.id; else agentB = agent.id;
      await wait(`hire ${name}`, async () => { const [row] = await db!.select().from(agents).where(eq(agents.id, agent.id)); if (row?.lifecycleError) throw new Error(JSON.stringify(row.lifecycleError)); return row?.lifecycleState === "ready" ? row : null; });
    }
    expect(hello).toBeGreaterThanOrEqual(2); stage("both real Pi hires verified", { companyId, agentA, agentB });
    const issue = await api("POST", `/companies/${companyId}/issues`, { title: "RFL agent-to-agent addressed card", description: "Create an addressed handoff card for B; wait for the response; finish after the continuation.", status: "todo", assigneeAgentId: agentA }, 201);
    issueId = issue.id;
    expect(issue.assigneeAgentId).toBe(agentA);
    expect(agentB).not.toBe(agentA);
    const resolved = await wait("B resolves from the card wake", async () => { const rows = await db!.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId)); return rows.find(r => r.status === expectedStatus) ?? null; });
    cardId = resolved.id;
    const bRun = await wait("B run succeeds", async () => (await allRuns()).find(r => r.id === resolved.resolvedByRunId && r.status === "succeeded") ?? null);
    expect(bRun.agentId).toBe(agentB); expect(bRun.contextSnapshot).toMatchObject({ interactionId: cardId, wakeReason: "interaction_pending" });
    expect(resolved).toMatchObject({ status: expectedStatus, result: { outcome: expectedStatus }, createdByAgentId: agentA, addresseeAgentId: agentB, resolvedByAgentId: agentB, resolvedByRunId: bRun.id, resolvedByUserId: null });
    expect(stages).toContainEqual(expect.objectContaining({ name: "B verified its real resolution", detail: { decision, cardId, runId: bRun.id } }));
    const { heartbeatService } = await import("../services/heartbeat.js"); const heartbeat = heartbeatService(db);
    const aContinuation = await wait("requester continuation succeeds", async () => { const rows = await allRuns(); return rows.find(r => r.agentId === agentA && r.id !== resolved.sourceRunId && r.status === "succeeded") ?? null; });
    expect(aContinuation.contextSnapshot).toMatchObject({ interactionId: cardId });
    expect(stages).toContainEqual(expect.objectContaining({ name: "A received resolution continuation", detail: { decision, cardId, runId: aContinuation.id } }));
    expect(await api("GET", `/issues/${issueId}`)).toMatchObject({ assigneeAgentId: agentA });
    for (const run of await allRuns()) await heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 15000 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const bWakes = wakes.filter(w => w.agentId === agentB && w.payload?.interactionId === cardId);
    const continuations = wakes.filter(w => w.agentId === agentA && w.payload?.interactionId === cardId);
    expect(bWakes, "one card -> one pending wake").toHaveLength(1);
    expect(continuations, "requester continuation occurs exactly once").toHaveLength(1);
    const finalRuns = await allRuns();
    expect(finalRuns.filter(r => r.agentId === agentB)).toHaveLength(1);
    expect(finalRuns.filter(r => r.agentId === agentA)).toHaveLength(2);
    expect(finalRuns.every(r => r.status === "succeeded"), "no hidden failed or looping run").toBe(true);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).toHaveLength(1);
    stage("GREEN", { decision, card: resolved, bRunId: bRun.id, bWakes, continuations });
  } catch (error) { stage("RED", error instanceof Error ? error.stack : String(error)); throw error; }
  finally {
    if (db && companyId) {
      if (issueId) await writeFile(join(root, "issue.json"), JSON.stringify(await api("GET", `/issues/${issueId}`), null, 2));
      for (const [name, table] of [["runs", heartbeatRuns], ["cards", issueThreadInteractions], ["wakeups", agentWakeupRequests], ["comments", issueComments], ["agents", agents]] as const) await writeFile(join(root, `${name}.json`), JSON.stringify(await db.select().from(table as any).where(eq((table as any).companyId, companyId)), null, 2));
      for (const run of await allRuns()) await writeFile(join(root, `events-${run.id}.json`), JSON.stringify(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)), null, 2));
      const { heartbeatService } = await import("../services/heartbeat.js");
      for (const run of await allRuns()) { if (["running", "queued"].includes(run.status)) await heartbeatService(db).cancelRun(run.id).catch(() => {}); await heartbeatService(db).waitForRunExecutionDrain(run.id, { timeoutMs: 15000 }).catch(() => {}); }
    }
    await writeFile(join(root, "proof.json"), JSON.stringify({ decision, expectedStatus, companyId, agentA, agentB, issueId, cardId, marker, stages, modelRequests }, null, 2));
    unsubscribe?.(); for (const b of bundles) await b.transport.close().catch(() => {});
    await app?.locals.paperclipShutdown?.();
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    if (model) { model.closeAllConnections(); await new Promise<void>(resolve => model!.close(() => resolve())); }
    await temporary?.cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); console.log(`[cardwake] evidence ${root}`);
  }
}, 300000);
