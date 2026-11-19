// Real hire HTTP -> lifecycle coordinator -> embedded PostgreSQL -> installed
// Boat plugin worker -> loopback Boat HTTP. Only Boat and model APIs are stand-ins.
// Explicit prerequisites: built Boat 0.1.17-spare.6, runnerd, provider pack, and
// an isolated /home/user mount (Boat's actual default guest workspace). The
// worker wrapper uses Boat's exported NODE_ENV=test operator-file path seam;
// no plugin hook, managed-environment service, or lifecycle effect is replaced.
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiConnectionService } from "../services/ai-connections.js";
import { secretService } from "../services/secrets.js";
import { reconcileRetainedAiCleanup } from "../services/retained-ai-credential-cleanup.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startRealPluginLoader } from "./helpers/plugin-real-loader.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";
import { startHireBoatHttpStandin } from "./helpers/hire-boat-http-standin.js";

const boatSource = process.env.PAPERCLIP_HIRE_BOAT_PACKAGE;
if (!boatSource) throw new Error("Set PAPERCLIP_HIRE_BOAT_PACKAGE to built Boat 85a00a62f (0.1.17-spare.6)");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("real hire route / real Boat worker / Boat HTTP", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let app: Awaited<ReturnType<typeof startRealPluginLoader>>;
  let boat: Awaited<ReturnType<typeof startHireBoatHttpStandin>>;
  let root: string;
  let pluginId: string;
  let rpcErrorsPath: string;
  let rpcRequestsPath: string;
  let rpcErrorOffset = 0;
  let model: ReturnType<typeof createServer>;
  let preview: ReturnType<typeof createHttpsServer>;
  const sockets = new Set<WebSocket>();
  let ws: WebSocketServer;
  const previousCAs = getCACertificates("default");
  let modelUrl: string;
  let hellos = 0;

  // A deferred A has a REAL scheduled retry. Isolate whole cases so an old
  // company's retry cannot create boxes inside the next never-hide window.
  // Within each case A and B share this uninterrupted app/database/worker.
  beforeEach(async () => {
    ws = new WebSocketServer({ noServer: true });
    sockets.clear(); hellos = 0; rpcErrorOffset = 0;
    expect(process.env.PAPERCLIP_HIRE_BOAT_NAMESPACE, "Run through fixtures/hire-boat-namespace.sh; never use the host guest path").toBe("1");
    expect(process.env.PAPERCLIP_RUNNER_BINARY).toBeTruthy();
    expect(process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH).toBeTruthy();
    // A namespace supplied by fixtures/hire-boat-namespace.sh owns this path.
    await mkdir("/home/user/paperclip-workspace", { recursive: true });
    root = await mkdtemp(join(tmpdir(), "hire-boat-real-"));
    console.info("REAL_HIRE_STAGE", "root", root);
    vi.stubEnv("PAPERCLIP_HOME", join(root, "home"));
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "hire-boat-real");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", process.env.PAPERCLIP_RUNNER_BINARY);
    vi.stubEnv("PI_OFFLINE", "1"); vi.stubEnv("OTEL_SDK_DISABLED", "true");
    boat = await startHireBoatHttpStandin();
    const allowed = join(root, "ALLOWED"), mountinfo = join(root, "mountinfo");
    await writeFile(allowed, `${boat.baseUrl}\n`);
    await writeFile(mountinfo, `1 0 0:1 / ${root} ro - tmpfs tmpfs ro\n`);
    rpcErrorsPath = join(root, "boat-rpc-errors.jsonl");
    await writeFile(rpcErrorsPath, "");
    rpcRequestsPath = join(root, "boat-rpc-requests.jsonl");
    await writeFile(rpcRequestsPath, "");
    const packageRoot = join(root, "boat-package");
    await cp(boatSource!, packageRoot, { recursive: true, dereference: false });
    // Boat's documented test-only URL-authority seam, evaluated inside the
    // real subprocess before its unchanged plugin is passed to runWorker.
    await writeFile(join(packageRoot, "dist", "worker.js"), `import {runWorker} from '@paperclipai/plugin-sdk';\nimport {readFileSync,appendFileSync} from 'node:fs';\nconst requests=new Map();let input='';process.stdin.on('data',chunk=>{input+=chunk.toString();let end;while((end=input.indexOf('\\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);try{const message=JSON.parse(line);if(message.method){const request={method:message.method,providerLeaseId:message.params?.lease?.providerLeaseId??message.params?.providerLeaseId,receivedAtNs:process.hrtime.bigint().toString()};requests.set(message.id,request);appendFileSync(${JSON.stringify(rpcRequestsPath)},JSON.stringify(request)+'\\n')}}catch{}}});\nconst output=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,...args)=>{try{for(const line of chunk.toString().trim().split('\\n')){const message=JSON.parse(line);if(message.error)appendFileSync(${JSON.stringify(rpcErrorsPath)},JSON.stringify({...message,request:requests.get(message.id),atNs:process.hrtime.bigint().toString()})+'\\n')}}catch{}return output(chunk,...args)};\nimport {getCACertificates,setDefaultCACertificates} from 'node:tls';\nimport plugin,{setFaultProxyPathsForTest} from './plugin.js';\nsetDefaultCACertificates([...getCACertificates('default'),readFileSync(${JSON.stringify(join(root, "cert.pem"))},'utf8')]);\nprocess.env.NODE_ENV='test';\nsetFaultProxyPathsForTest(${JSON.stringify({ allowedFile: allowed, mountinfoFile: mountinfo })});\nrunWorker(plugin,import.meta.url);\n`);
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    expect(packageJson.version).toBe("0.1.17-spare.6");
    model = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (respondToNativePiHello(body, res, "messages")) { hellos++; return; }
      res.writeHead(400).end("Only the native hello is allowed");
    });
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === "string") throw new Error("Model listener missing");
    modelUrl = `http://127.0.0.1:${modelAddress.port}`;
    const key = join(root, "key.pem"), cert = join(root, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=hire-row-43127.on.boat.dev", "-addext", "subjectAltName=DNS:hire-row-43127.on.boat.dev,IP:127.0.0.1"], { stdio: "ignore" });
    const ca = await readFile(cert, "utf8");
    setDefaultCACertificates([...previousCAs, ca]);
    preview = createHttpsServer({ key: await readFile(key), cert: ca }, (req, res) => { void boat.serveStorage(req, res); });
    preview.on("upgrade", (req, socket, head) => {
      if (req.headers.cookie !== "_port_auth=local-only") { socket.destroy(); return; }
      ws.handleUpgrade(req, socket, head, front => {
        const back = new WebSocket(`ws://127.0.0.1:43127${req.url}`, { perMessageDeflate: false });
        sockets.add(front); sockets.add(back);
        const pending: Array<{ data: RawData; binary: boolean }> = [];
        front.on("message", (data, binary) => { if (back.readyState === WebSocket.OPEN) back.send(data, { binary }); else pending.push({ data, binary }); });
        back.on("open", () => { for (const item of pending.splice(0)) back.send(item.data, { binary: item.binary }); });
        back.on("message", (data, binary) => { if (front.readyState === WebSocket.OPEN) front.send(data, { binary }); });
        front.on("close", () => { sockets.delete(front); back.terminate(); });
        back.on("close", () => { sockets.delete(back); front.terminate(); });
        front.on("error", error => { console.error("PREVIEW_FRONT_ERROR", error); back.terminate(); }); back.on("error", error => { console.error("PREVIEW_BACK_ERROR", error); front.terminate(); });
      });
    });
    await new Promise<void>(resolve => preview.listen(443, "127.0.0.1", resolve));
    const previewAddress = preview.address(); if (!previewAddress || typeof previewAddress === "string") throw new Error("Preview listener missing");
    boat.setPreviewPort(previewAddress.port);
    // The namespace fixture maps this private-preview hostname to loopback.
    // HTTPS and WebSocket use real sockets, normal DNS, and certificate checks.
    console.info("REAL_HIRE_STAGE", "starting embedded PG");
    database = await startEmbeddedPostgresTestDatabase("hire-boat-real-db-"); db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "local-board", name: "Hire row board", email: "hire-row@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    console.info("REAL_HIRE_STAGE", "starting actual app");
    app = await startRealPluginLoader(db);
    console.info("REAL_HIRE_STAGE", "installing actual Boat", packageRoot);
    const plugin = await app.install(packageRoot); pluginId = plugin.id;
  }, 120_000);

  afterEach(async () => {
    boat?.failManifest();
    boat?.finishStop();
    await app?.close();
    for (const socket of sockets) socket.terminate();
    ws.close();
    for (const server of [model, preview]) if (server) {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await boat?.close(); await database?.cleanup();
    setDefaultCACertificates(previousCAs);
    vi.unstubAllEnvs();
  }, 60_000);

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Same-grant real hire row", issuePrefix: `H${companyId.slice(0, 7)}`, defaultResponsibleUserId: "local-board", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", membershipRole: "owner", status: "active" });
    const account = await aiConnectionService(db).save(companyId, "local-board", {
      provider: "anthropic", method: "api_key", name: "Loopback hello, no provider credential", ownership: "personal", allAgents: true, agentIds: [],
      routing: { kind: "local", protocol: "messages", baseUrl: modelUrl, auth: "none", models: [{ id: "faux", thinkingLevels: ["off"] }] },
    }, "");
    const [environment] = await db.insert(environments).values({ name: `Boat ${companyId}`, driver: "sandbox", status: "active", config: {
      provider: "boat", apiKey: "stand-in-only", apiBaseUrl: boat.baseUrl, reuseLease: false, timeoutMs: 120_000,
    } }).returning();
    const secrets = secretService(db);
    const boatKey = await secrets.create(companyId, { name: "Boat HTTP stand-in key", provider: "local_encrypted", value: "stand-in-only" });
    await secrets.createBinding({ companyId, secretId: boatKey.id, targetType: "environment", targetId: environment!.id, configPath: "apiKey" });
    await db.update(environments).set({ config: { ...environment!.config, apiKey: boatKey.id } }).where(eq(environments.id, environment!.id));
    const hire = async (name: string) => {
      const response = await app.api<{ agent: { id: string } }>(`/companies/${companyId}/agent-hires`, {
        name, role: "engineer", adapterType: "paperclip_runner", defaultEnvironmentId: environment!.id,
        adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off", lifecycleMode: "per_turn" },
        runtimeConfig: { heartbeat: { enabled: false }, aiConnection: { mode: "delegated", provider: "anthropic", method: "api_key", ...account } },
      });
      return response.agent.id;
    };
    const row = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
    async function ready(id: string) {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const value = await row(id);
        if (value.lifecycleState === "ready") return value;
        if (value.lifecycleOperation?.transientFailures) {
          throw new Error(`Hire failed or remains pending: ${JSON.stringify(value)}`);
        }
        await pause(100);
      }
      throw new Error(`Hire did not become ready: ${JSON.stringify(await row(id))}; Boat=${JSON.stringify(boat.calls)}`);
    }
    return { companyId, account, environment: environment!, hire, row, ready };
  }

  it("HEALTHY: A and B hired through HTTP both become ready on one real AI grant", async () => {
    boat.begin("healthy");
    const f = await fixture();
    const a = await f.hire("Healthy A"); const afterA = await f.ready(a);
    const b = await f.hire("Healthy B"); const afterB = await f.ready(b);
    console.info("REAL_HIRE_HEALTHY", JSON.stringify({ a: { id: a, state: afterA.lifecycleState, operation: afterA.lifecycleOperation }, b: { id: b, state: afterB.lifecycleState, operation: afterB.lifecycleOperation }, grant: f.account.grantId, hellos, pluginId }));
    expect(afterA.lifecycleState).toBe("ready"); expect(afterB.lifecycleState).toBe("ready");
    expect(hellos).toBeGreaterThanOrEqual(2);
    // Boat does not attest an immutable image here: Core deliberately records
    // no reusable digest. Readiness still requires its real passing hello.
    expect(afterA.harnessVerifiedAt).toBeNull(); expect(afterA.harnessVerifiedDigest).toBeNull();
    expect(afterB.harnessVerifiedAt).toBeNull(); expect(afterB.harnessVerifiedDigest).toBeNull();
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.environmentId, f.environment.id));
    expect(leases.length).toBeGreaterThanOrEqual(2); expect(leases.every(lease => lease.releasedAt)).toBe(true);
  }, 540_000);

  async function pending(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const row = await f.row(id);
      if ((row.lifecycleOperation?.transientFailures ?? 0) > 0) return row;
      await pause(100);
    }
    throw new Error(`Hire never deferred: ${JSON.stringify(await f.row(id))}`);
  }
  async function workerPid() {
    const dashboard = await app.api<{ worker: { pid: number; status: string } }>(`/plugins/${pluginId}/dashboard`);
    expect(dashboard.worker.status).toBe("running");
    return dashboard.worker.pid;
  }

  for (const mechanism of ["closed-gate", "ingress-503"] as const) for (const state of ["stopped", "active"] as const) {
    it(`${mechanism} / ${state === "stopped" ? "FAULT ROW" : "NEVER HIDE"}: same-grant B after A's lease is gone; Boat inspect=${state}`, async () => {
      boat.begin(state, mechanism);
      rpcErrorOffset = (await readFile(rpcErrorsPath, "utf8").catch(() => "")).length;
      const beforePid = await workerPid();
      const f = await fixture();
      const a = await f.hire(`Gone A (${state})`);
      if (mechanism === "closed-gate") {
        const deadline = Date.now() + 90_000;
        // Observe, never invoke or replace, the release of A's actual lease.
        // Its real cleanup deadline expires while the Boat response is held.
        let release;
        do {
          release = (await readFile(rpcRequestsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
            .find(request => request.method === "environmentReleaseLease" && request.providerLeaseId === boat.faultBox);
          if (release) break;
          await pause(20);
        } while (Date.now() < deadline);
        expect(release, "the real setup-test release must reach the unchanged worker").toBeDefined();
        expect(boat.manifestHeld, "retirement's first HTTP response is still held at release").toBe(true);
        boat.failManifest();
        while (!boat.stopHeld && Date.now() < deadline) await pause(20);
        expect(boat.stopHeld, "the real release must close admission, drain, and reach POST /stop").toBe(true);
        console.info("REAL_BOAT_RELEASE_BARRIER", JSON.stringify(release));
      } else await pending(f, a);
      let [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.environmentId, f.environment.id));
      const readErrors = async () => (await readFile(rpcErrorsPath, "utf8")).slice(rpcErrorOffset).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      let boundaryNs: bigint;
      if (mechanism === "closed-gate") {
        // The plugin's REAL terminal hook has closed admission. Hold its
        // already-sent stop response so the database release cannot yet fence
        // the concurrent retirement call before it reaches the plugin itself.
        expect(boat.calls.filter(call => call.boxId === lease!.providerLeaseId && call.path.endsWith("/stop"))).toHaveLength(1);
        expect(lease!.releasedAt).toBeNull();
        // Join the ACTUAL retained owner installed by A's real probe. This
        // invokes its real retryRetirement closure; no cleanup, lease or RPC
        // is manufactured. The lifecycle worker itself remains untouched.
        const deadline = Date.now() + 20_000;
        let rejection;
        let retirementFailure: unknown;
        do {
          // The initial retired promise can still be settling when POST /stop
          // arrives. Join it through the real reconciler, never mutate its map.
          retirementFailure = await reconcileRetainedAiCleanup({ companyId: f.companyId, accountKey: f.account.grantId }).catch(error => error);
          rejection = (await readErrors()).find(message => message.error.code === -32002 && message.error.message === "Boat sandbox lease is no longer active.");
          if (rejection) break;
          await pause(20);
        } while (Date.now() < deadline);
        expect(rejection, "the real retained retirement must reach Boat's CLOSED activity gate").toBeDefined();
        expect(rejection.error).toEqual({ code: -32002, message: "Boat sandbox lease is no longer active." });
        expect(rejection.request).toMatchObject({ method: "environmentExecute", providerLeaseId: lease!.providerLeaseId });
        // hrtime is host-monotonic across these actual processes. The window
        // starts when the worker emits the rejection, NOT when polling sees it.
        boundaryNs = BigInt(rejection.atNs);
        console.info("REAL_BOAT_GATE_REJECTION", JSON.stringify(rejection));
        boat.finishStop();
        expect(retirementFailure).toMatchObject({ status: 422, details: { code: "ai_credential_cleanup_pending" } });
      } else {
        const leaseGone = (await readErrors()).filter(message => message.error.code === -32002);
        console.info("REAL_BOAT_RPC_LEASE_GONE", JSON.stringify(leaseGone));
        expect(leaseGone.length, "the separate R1 ingress-503 control is preserved").toBeGreaterThan(0);
        boundaryNs = process.hrtime.bigint();
      }
      const observedCalls = () => boat.calls.filter(call => BigInt(call.atNs) >= boundaryNs);
      const afterA = await pending(f, a);
      [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.environmentId, f.environment.id));
      expect(boat.faulted).toBe(true);
      expect(afterA.lifecycleState).toBe("verifying");
      expect(afterA.harnessVerifiedAt).toBeNull();
      expect(lease).toMatchObject({ heartbeatRunId: null, leasePolicy: "ephemeral", providerLeaseId: boat.faultBox });
      expect(lease!.releasedAt).toBeTruthy();
      const beforeHellos = hellos;
      const b = await f.hire(`Same-grant B (${state})`);
      let afterB: Awaited<ReturnType<typeof f.row>>;
      // Friday's per-agent cleanup gate admits an independent B even while
      // A remains pending. Never turn that newer isolation back into a grant
      // gate just to preserve the old ACTIVE control's B-verifying assertion.
      {
        try { afterB = await f.ready(b); }
        catch (error) { console.info("REAL_HIRE_FAULT", JSON.stringify({ state, a: afterA, b: await f.row(b), lease, calls: observedCalls(), beforePid, afterPid: await workerPid() })); throw error; }
        expect(afterB.harnessVerifiedAt).toBeNull(); expect(afterB.harnessVerifiedDigest).toBeNull();
        expect(hellos).toBeGreaterThan(beforeHellos);
      }
      // Join A's real retained entry after the real release. prepareManagedAiRuntime
      // also starts this reconciliation in the background; joining its owner
      // makes the receipt/no-receipt oracle independent of B's isolation.
      const cleanup = reconcileRetainedAiCleanup({ companyId: f.companyId, accountKey: f.account.grantId });
      if (state === "stopped") await expect(cleanup).resolves.toBeUndefined();
      else await expect(cleanup).rejects.toMatchObject({ details: { code: "ai_credential_cleanup_pending" } });
      expect((await f.row(a)).lifecycleState, "A's real failure stays visible").toBe("verifying");
      const [proved] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id));
      if (state === "stopped") expect(proved!.metadata?.remoteExecutionTermination).toMatchObject({ runId: null, leaseId: lease!.id, providerLeaseId: lease!.providerLeaseId, state: "stopped" });
      else expect(proved!.metadata?.remoteExecutionTermination).toBeUndefined();
      const after = observedCalls();
      expect(after.filter(call => call.boxId === boat.faultBox && call.method !== "GET"), "no execute/destroy/stop/resume after the real -32002").toEqual([]);
      expect(after.filter(call => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(1);
      expect(afterB.runtimeConfig).toMatchObject({ aiConnection: { grantId: f.account.grantId } });
      const afterPid = await workerPid(); expect(afterPid).toBe(beforePid);
      console.info("REAL_HIRE_FAULT", JSON.stringify({ mechanism, boundaryNs: boundaryNs.toString(), state, a: { id: a, state: afterA.lifecycleState, error: afterA.lifecycleError }, b: { id: b, state: afterB.lifecycleState, error: afterB.lifecycleError, verifiedAt: afterB.harnessVerifiedAt, digest: afterB.harnessVerifiedDigest }, grant: f.account.grantId, lease: proved, calls: after.map(({ command, ...call }) => call), beforePid, afterPid }));
    }, 420_000);
  }
});
