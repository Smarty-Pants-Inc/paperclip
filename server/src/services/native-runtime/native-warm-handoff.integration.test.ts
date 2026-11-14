import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { completionContracts, environmentLeases, environments, heartbeatRuns, issueComments, issues, nativeRunFinalizations, plugins } from "@paperclipai/db";
import { PAPERCLIP_RUNNER_INGRESS_PORT } from "@paperclipai/adapter-utils/runner-connectivity";
import { canonicalNativeRuntimeContextDigest, defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture, fakeCodexAppServer, stopOwnedProcessGroup, waitForCondition } from "../../__tests__/helpers/native-restart.js";
import { createRunnerTestTlsTunnel } from "../../__tests__/helpers/docker-command-runner.js";
import { localSandboxCommandRunner } from "../../__tests__/helpers/local-sandbox-command-runner.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { executePaperclipNativeSession, closeWarmNativeSessionsForEnvironment } from "./native-session-executor.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { materializeAsset } from "./runtime-context.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";

// Core, environment admission, embedded PG, Runner/PRP, provider history files,
// suspension, backup publication/stamp and cold restore are real. The provider
// boundary is local fixture allocations; the deterministic Codex fixture is NOT
// a live-model or Boat/production proof. Its answer comes only from CODEX_HOME.
describeEmbeddedPostgres("warm source checkpoint before replacement", () => {
  const fixture = nativeRestartFixture();
  it.each(["warm restart", "environment move", "cached warm", "older backup", "unreachable", "stop unconfirmed", "idle", "same pack", "in flight", "active provider turn"] as const)(
    "preserves the latest answered provider history: %s", async scenario => {
      expect(defaultCapabilityRunnerdBinary()).toBeTruthy();
      const first = await fixture.seedRun(`HANDOFF-${scenario}`);
      const { db, issueId } = first;
      const { companyId, agentId, runtimeRoot, temporary } = fixture.current;
      const root = join(runtimeRoot, first.runId);
      await mkdir(root, { recursive: true });
      const packRoot = join(root, "pack"); await mkdir(packRoot);
      const previousPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
      const writePack = async (letter: string) => {
        const payload = { runnerInputsDigest: letter.repeat(64), runnerSourceRevision: letter.repeat(40), target: { architecture: "x64", platform: "linux" } };
        const canonical = (v: any): string => v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
        await writeFile(join(packRoot, "provider-pack.json"), JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1", payload,
          digest: `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}` }));
      };
      await writePack("a"); process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH = packRoot;
      const key = join(root, "tls.key"), cert = join(root, "tls.crt");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
        "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
      const certificate = await readFile(cert, "utf8"), oldCAs = getCACertificates("default");
      setDefaultCACertificates([...oldCAs, certificate]);
      const tunnel = await createRunnerTestTlsTunnel({ key, cert, port: PAPERCLIP_RUNNER_INGRESS_PORT });
      const pluginId = randomUUID(), provider = `handoff-${first.runId}`;
      await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: `@fixture/${provider}`, version: "1.0.0", apiVersion: 1,
        categories: ["automation"], status: "ready", manifestJson: { id: provider, apiVersion: 1, version: "1.0.0", displayName: "Local handoff fixture",
          categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Local allocation", supportsReusableLeases: true,
            sandboxCapabilities: { reusableLeases: true, runnerWebSocketIngress: true }, configSchema: { type: "object" } }] } } as never);
      let [environment] = await db.insert(environments).values({ name: provider, driver: "sandbox", config: { provider, image: "source-a", reuseLease: true } }).returning();
      const local = localSandboxCommandRunner();
      // Real provider allocations have distinct filesystems at the same /workspace
      // path. Model that namespace here with one logical path switched ONLY after
      // source suspension/stop; box directories themselves never share files.
      const assignedCwd = join(root, "assigned-workspace");
      let acquisitions = 0, unreachable = false;
      const calls: Array<{ method: string; box?: string }> = [];
      const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease", "environmentExecute", "environmentRunnerIngressEndpoint"] }),
        call: vi.fn(async (_id: string, method: string, p: any) => {
          const box = p.providerLeaseId ?? p.lease?.providerLeaseId;
          calls.push({ method, box });
          if (method === "environmentAcquireLease") {
            const id = `box-${++acquisitions}`, cwd = join(root, id); await mkdir(cwd);
            if (acquisitions > 1) {
              expect(calls.some(c => c.method === "environmentStopLease" && c.box === "box-1")).toBe(true);
              expect(JSON.parse(await readFile(join(assignedCwd, ".paperclip-runtime/paperclip-runner/sessions",
                createHash("sha256").update(first.native.normalizedSessionId).digest("hex"), "runner/runner-state.json"), "utf8")).lifecycle).toBe("suspended");
              await unlink(assignedCwd);
            }
            await symlink(cwd, assignedCwd, "dir");
            return { providerLeaseId: id, metadata: { ...p.config, remoteCwd: assignedCwd } };
          }
          if (method === "environmentResumeLease") return { providerLeaseId: box, metadata: p.leaseMetadata };
          if (method === "environmentReleaseLease") return undefined;
          if (method === "environmentDestroyLease") throw new Error("NEVER delete a handoff source");
          if (method === "environmentStopLease" && scenario === "stop unconfirmed") return undefined;
          if (method === "environmentStopLease") return { schema: "paperclip.remote-execution-termination.v1", state: "stopped",
            companyId, runId: p.leaseMetadata.sandboxStopAndRetain.runId, leaseId: p.leaseMetadata.sandboxStopAndRetain.leaseId,
            provider, providerLeaseId: box, confirmedAt: new Date().toISOString() };
          if (method === "environmentExecute") { if (unreachable && box === "box-1") throw new Error("fixture old box unreachable"); return local.execute(p); }
          if (method === "environmentRunnerIngressEndpoint") return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${tunnel.port}${p.path}`, secretHeaders: [], generation: box };
          throw new Error(`Unexpected method ${method}`);
        }) } as unknown as PluginWorkerManager;
      let service = environmentRuntimeService(db, { pluginWorkerManager: worker });
      const acquire = (runId: string) => service.acquireRunLease({ companyId, environment: environment as never, issueId, agentId,
        heartbeatRunId: runId, adapterType: "paperclip_runner", persistedExecutionWorkspace: null });
      const target = async (lease: Awaited<ReturnType<typeof acquire>>["lease"]) => resolveEnvironmentExecutionTarget({ db, companyId, environment,
        adapterType: "paperclip_runner", leaseId: lease.id, leaseMetadata: lease.metadata, lease, environmentRuntime: service });
      const context = nativeRuntimeContextFixture();
      context.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", content: Buffer.from("Complete this conversation turn."), mode: 0o444 }]);
      context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
      const contract = async (runId: string) => {
        const [row] = await db.select({ contract: completionContracts }).from(heartbeatRuns).innerJoin(completionContracts, eq(completionContracts.id, heartbeatRuns.completionContractId)).where(eq(heartbeatRuns.id, runId));
        return { id: row.contract.id, sha256: row.contract.canonicalSha256, schemaVersion: row.contract.schemaVersion, contract: row.contract.contractJson as never };
      };
      const executionA = buildNativeExecutionInput({ companyId, agentId, runId: first.runId,
        issue: { id: issueId, identifier: "HANDOFF", title: "Remember the latest fact", description: null, workMode: "standard" }, taskPrompt: "LATEST_FACT=older-fact",
        workspace: { id: randomUUID(), cwd: root, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: first.native.normalizedSessionId,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 }, runtimeContext: context, completionContract: await contract(first.runId) });
      const report = join(root, "report.json"), codex = join(root, "codex");
      const activeTurnMarker = join(root, "active-provider-turn"), releaseTurn = join(root, "release-provider-turn");
      await writeFile(report, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "fixture answer",
        completionClaim: { contractRevision: executionA.completionContract.contract.revision, objectiveSatisfied: true,
          criteria: executionA.completionContract.contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
        evidence: [], verification: [], artifacts: [], attentionRequests: [] }));
      // This proxy persists facts in the provider's inventoried home. The ask
      // contains no fact. A missing/cold thread must answer MISSING, not pass.
      await writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{createInterface}=require('node:readline');
if(process.argv.includes('--version')){console.log('codex-cli 0.134.0');process.exit(0)}
const home=process.env.CODEX_HOME;fs.mkdirSync(home,{recursive:true});const fact=path.join(home,'latest-fact.txt');
const child=spawn(${JSON.stringify(fakeCodexAppServer)},['--state-file-in-codex-home','--terminal-result-file',${JSON.stringify(report)},'--call-log',path.join(home,'provider-calls.log'),'--durable-turn-ids']);
child.stderr.pipe(process.stderr);let answer='MISSING',contract=null,turnCount=0;const ids=new Map();
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(ids.has(q.id))q.id=ids.get(q.id);if(q.method==='turn/start'){turnCount++;const text=JSON.stringify(q.params);const m=/LATEST_FACT=([a-zA-Z0-9-]+)/.exec(text);if(m)fs.writeFileSync(fact,m[1]);answer=fs.existsSync(fact)?fs.readFileSync(fact,'utf8'):'MISSING';const visit=v=>{if(typeof v==='string'){try{const e=JSON.parse(v);if(e.completionContract)contract=e.completionContract}catch{}}else if(v&&typeof v==='object')Object.values(v).forEach(visit)};visit(q.params)}child.stdin.write(JSON.stringify(q)+'\\n')}).on('close',()=>child.stdin.end());
createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);if(r.method==='item/tool/call'&&r.params.tool==='paperclip_finish'){const id=r.id+'-'+r.params.turnId;ids.set(id,r.id);r.id=id;r.params.callId+='-'+r.params.turnId;r.params.arguments.summary=answer;if(contract)r.params.arguments.completionClaim={contractRevision:contract.revision,objectiveSatisfied:true,criteria:contract.criteria.map(c=>({criterionId:c.id,status:'satisfied',evidenceRefs:[]})),remainingWork:[]};if(${JSON.stringify(scenario === "active provider turn")}&&turnCount===2){fs.writeFileSync(${JSON.stringify(activeTurnMarker)},JSON.stringify(r.params));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseTurn)})){clearInterval(timer);process.stdout.write(JSON.stringify(r)+'\\n')}},10);return}}process.stdout.write(JSON.stringify(r)+'\\n')});child.on('exit',code=>process.exit(code??1));process.on('SIGTERM',()=>child.kill('SIGTERM'));
`, { mode: 0o700 });
      let controller: ChildProcess | undefined;
      const logs: string[] = [];
      const stopController = async () => { if (!controller) return; const current = controller; controller = undefined;
        const exited = new Promise<void>(done => current.once("exit", () => done())); current.kill("SIGKILL"); await exited; };
      const childExecute = async (options: Parameters<typeof executePaperclipNativeSession>[0], suspend = false) => {
        if (scenario === "cached warm") return executePaperclipNativeSession(options);
        if (!controller) {
          controller = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), resolve(import.meta.dirname, "../../__tests__/helpers/native-warm-handoff.test-worker.ts")],
            { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
          controller.stdout?.on("data", d => logs.push(String(d))); controller.stderr?.on("data", d => logs.push(String(d)));
          await new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error(`Worker imports timed out: ${logs.join("").slice(-3000)}`)), 180_000);
            controller!.once("message", () => { clearTimeout(timer); done(); }); controller!.once("error", fail); });
        }
        const current = controller;
        return new Promise<any>((done, fail) => {
          const timer = setTimeout(() => { current.off("message", receive); fail(new Error(`Warm turn timed out: ${logs.join("").slice(-5000)}`)); }, 120_000);
          const receive = (m: any) => { if (m.log) logs.push(m.log.text); if (m.result || m.error) {
            clearTimeout(timer); current.off("message", receive); if (m.error) fail(new Error(`${m.error}\nCONTROLLER LOG:\n${logs.join("").slice(-18000)}`)); else done(m.result); } };
          current.on("message", receive); current.send!({ connectionString: temporary.connectionString, certificate, ingressUrl: `wss://127.0.0.1:${tunnel.port}`, suspend,
            options: { ...options, db: undefined, runnerExecutionTarget: { ...options.runnerExecutionTarget, runner: undefined, getRunnerIngressEndpoint: undefined } } });
        });
      };
      const optionsFor = async (execution: typeof executionA, native: typeof first.native, lease: Awaited<ReturnType<typeof acquire>>["lease"]) => {
        await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution,
          nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", execution.provider.kind) } }).where(eq(heartbeatRuns.id, execution.binding.runId));
        return { db, execution, runnerInstanceId: native.runnerInstanceId, useRunnerd: true, runnerIngressAuthorized: true,
          runnerRemoteBinaryPath: defaultCapabilityRunnerdBinary(), runnerRemoteCodexPath: codex, runnerExecutionTarget: await target(lease) };
      };
      const nextRun = async () => {
        const id = randomUUID(); const [run] = await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running", runtimeMode: "native",
          nativeIssueId: issueId, nativeSessionId: first.native.normalizedSessionId, contextSnapshot: { issueId } }).returning();
        await db.update(issues).set({ executionRunId: id, status: "in_progress" }).where(eq(issues.id, issueId));
        return run;
      };
      let lastEnvironmentId = environment.id;
      let heldTurn: Promise<unknown> | undefined;
      try {
        const leaseA = (await acquire(first.runId)).lease;
        expect(await childExecute(await optionsFor(executionA, first.native, leaseA), scenario === "older backup")).toMatchObject({ exitCode: 0 });
        await finalizeNativeRun({ db, runId: first.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
        await service.releaseRunLeases(first.runId);
        const runB = await nextRun(), leaseB = (await acquire(runB.id)).lease;
        if (scenario === "older backup") expect(leaseB.metadata?.nativeHarnessBackup).toBeTruthy();
        const nativeB = await prepareNativeHeartbeatRun({ db, run: runB, issue: { id: issueId, title: "Remember", description: null, reviewPolicy: null }, environmentLeaseId: leaseB.id });
        await db.insert(nativeRunFinalizations).values({ runId: runB.id, companyId, issueId, phase: "observed" });
        const unique = `latest-${randomUUID()}`;
        const executionB = { ...executionA, completionContract: await contract(runB.id), binding: { ...executionA.binding, runId: runB.id }, task: { ...executionA.task, prompt: `LATEST_FACT=${unique}` } };
        const turnB = childExecute(await optionsFor(executionB, nativeB, leaseB), scenario === "idle");
        if (scenario === "active provider turn") {
          heldTurn = turnB;
          await waitForCondition("provider waiting on its live terminal tool call", () => readFile(activeTurnMarker).then(() => true, () => false), 60_000);
          const active = JSON.parse(await readFile(join(root, "box-1", ".paperclip-runtime/paperclip-runner/sessions",
            createHash("sha256").update(first.native.normalizedSessionId).digest("hex"), "filesystem/codex-home/fake-codex-state.json"), "utf8"));
          expect(active.activeTurnId).toBeTruthy(); expect(active.nextTurn).toBe(2);
          await writePack("b"); calls.length = 0;
          expect((await acquire(runB.id)).lease.providerLeaseId).toBe("box-1");
          expect(calls.some(c => c.method === "environmentStopLease" || c.method === "environmentAcquireLease")).toBe(false);
          console.info("HANDOFF_EVIDENCE", JSON.stringify({ scenario, source: "box-1", selected: "box-1", acquisitions, activeProviderTurn: active.activeTurnId, calls }));
          await writeFile(releaseTurn, "release");
          expect(await turnB).toMatchObject({ exitCode: 0 });
          return;
        }
        expect(await turnB).toMatchObject({ exitCode: 0 });
        const sessionRoot = join(root, "box-1", ".paperclip-runtime/paperclip-runner/sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"));
        const providerHome = join(sessionRoot, "filesystem/codex-home");
        expect(await readFile(join(providerHome, "latest-fact.txt"), "utf8")).toBe(unique);
        const providerBefore = JSON.parse(await readFile(join(providerHome, "fake-codex-state.json"), "utf8"));
        expect(providerBefore.nextTurn).toBe(2);
        expect(JSON.parse(await readFile(join(sessionRoot, "runner/runner-state.json"), "utf8")).lifecycle).toBe(scenario === "idle" ? "suspended" : "ready");
        if (scenario === "in flight") {
          await writePack("b"); calls.length = 0;
          expect((await acquire(runB.id)).lease.providerLeaseId).toBe("box-1");
          expect(calls.some(c => c.method === "environmentStopLease" || c.method === "environmentAcquireLease")).toBe(false);
          console.info("HANDOFF_EVIDENCE", JSON.stringify({ scenario, source: "box-1", selected: "box-1", acquisitions,
            sourceLifecycle: "ready", completedProviderTurns: providerBefore.nextTurn, calls }));
          return;
        }
        await finalizeNativeRun({ db, runId: runB.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
        await service.releaseRunLeases(runB.id);
        await stopController(); // Except the explicit cached control, parent warm map is empty.
        service = environmentRuntimeService(db, { pluginWorkerManager: worker });
        if (scenario === "environment move") {
          [environment] = await db.insert(environments).values({ name: `${provider}-moved`, driver: "sandbox", config: { provider, image: "source-a", reuseLease: true } }).returning();
          lastEnvironmentId = environment.id;
        } else if (scenario !== "same pack") await writePack("b");
        unreachable = scenario === "unreachable";
        const runC = await nextRun();
        // Environment acquisition happens under the preparing legacy controller,
        // before native selection/coordinator creation (the real admission order).
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy", issueId, nativeIssueId: null, executionStage: "preparing",
          controllerBootId: (await import("../legacy-controller-lease.js")).legacyControllerBootId,
          controllerLeaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(heartbeatRuns.id, runC.id));
        calls.length = 0;
        if (unreachable || scenario === "stop unconfirmed") {
          await expect(acquire(runC.id)).rejects.toThrow("runner_pack_reuse_blocked");
          await expect(acquire(runC.id)).rejects.toThrow("runner_pack_reuse_blocked");
          expect(acquisitions).toBe(1);
          expect(calls.some(c => c.method === "environmentStopLease" && c.box === "box-1")).toBe(true);
          expect(calls.some(c => c.method === "environmentDestroyLease")).toBe(false);
          const notices = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)); expect(notices).toHaveLength(1);
          const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseB.id));
          if (scenario === "stop unconfirmed") {
            expect(source.status).toBe("pending_cleanup"); expect(source.metadata?.sandboxStopAndRetain).toBeTruthy();
            expect(source.metadata?.sandboxStopAndRetainReceipt).toBeUndefined();
          } else {
            expect(source.status).toBe("released"); expect(source.metadata?.sandboxStopAndRetainReceipt).toBeTruthy();
          }
          console.info("HANDOFF_EVIDENCE", JSON.stringify({ scenario, admission: "blocked", acquisitions, notices: notices.length,
            sourceLeaseId: source.id, sourceStatus: source.status, stopReceipt: source.metadata?.sandboxStopAndRetainReceipt ?? null, calls }));
          return;
        }
        const leaseC = (await acquire(runC.id)).lease;
        expect(leaseC.providerLeaseId).toBe(scenario === "same pack" ? "box-1" : "box-2");
        expect(calls.some(c => c.method === "environmentDestroyLease")).toBe(false);
        const nativeC = await prepareNativeHeartbeatRun({ db, run: runC, issue: { id: issueId, title: "Recall", description: null, reviewPolicy: null }, environmentLeaseId: leaseC.id });
        await db.insert(nativeRunFinalizations).values({ runId: runC.id, companyId, issueId, phase: "observed" });
        const executionC = { ...executionB, completionContract: await contract(runC.id), binding: { ...executionA.binding, runId: runC.id }, task: { ...executionA.task, prompt: "ASK_FACT: answer the last fact you remember." } };
        const result = await executePaperclipNativeSession(await optionsFor(executionC, nativeC, leaseC));
        expect(result).toMatchObject({ exitCode: 0, summary: unique });
        const restoredHome = join(leaseC.metadata!.remoteCwd as string, ".paperclip-runtime/paperclip-runner/sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"), "filesystem/codex-home");
        const providerAfter = JSON.parse(await readFile(join(restoredHome, "fake-codex-state.json"), "utf8"));
        expect(providerAfter).toMatchObject({ threadId: providerBefore.threadId, nextTurn: 3 });
        const methods = (await readFile(join(restoredHome, "provider-calls.log"), "utf8")).split(/\r?\n/);
        expect(methods.filter(m => m === "thread/start")).toHaveLength(1);
        expect(methods.filter(m => m === "turn/start")).toHaveLength(3);
        const [savedSource] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseB.id));
        console.info("HANDOFF_EVIDENCE", JSON.stringify({ scenario, source: "box-1", selected: leaseC.providerLeaseId, acquisitions,
          latestFact: unique, answered: result.summary, providerBefore, providerAfter,
          threadStarts: methods.filter(m => m === "thread/start").length, turnStarts: methods.filter(m => m === "turn/start").length,
          sourceStatus: savedSource.status, sourceStamp: savedSource.metadata?.nativeHarnessBackup ?? null,
          stopReceipt: savedSource.metadata?.sandboxStopAndRetainReceipt ?? null, calls }));
      } finally {
        if (heldTurn) { await writeFile(releaseTurn, "release"); await heldTurn.catch(() => undefined); }
        await stopController();
        await closeWarmNativeSessionsForEnvironment({ environmentId: lastEnvironmentId, reason: "handoff fixture cleanup" });
        for (const box of ["box-1", "box-2"]) {
          const sessions = join(root, box, ".paperclip-runtime/paperclip-runner/sessions");
          for (const name of await readdir(sessions).catch(() => [])) {
            const stateRoot = join(sessions, name, "runner");
            const identity = await readFile(join(stateRoot, "runner-process.identity"), "utf8").catch(() => "");
            const pid = Number(identity.split("\n")[1]);
            if (pid) await stopOwnedProcessGroup(pid, join(assignedCwd, ".paperclip-runtime/paperclip-runner/sessions", name, "runner"));
          }
        }
        await tunnel.close(); setDefaultCACertificates(oldCAs);
        execFileSync("chmod", ["-R", "u+rwX", root]);
        if (previousPack === undefined) delete process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
        else process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH = previousPack;
      }
    }, 360_000);
});
