import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { proveLegacyController } from "../services/legacy-controller-lease.js";
import { currentControllerProcess } from "../services/controller-process-identity.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";
const support = await getRecoveryPostgresSupport({});
async function until(description: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) { if (await check()) return; await sleep(10); }
  throw new Error(`Timed out waiting for ${description}`);
}

function completingBackend(db: ReturnType<typeof createDb>): NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "";
    let turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity, capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; },
      startTurn: async () => {
        await db.execute(sql`insert into d11_provider_starts(run_id, app) values (${execution.binding.runId}, current_setting('application_name'))`);
        const turnId = randomUUID(); turn.resolve(turnId); return { turnId };
      },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId,
          schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
        });
        yield event(1, "turn.started", {});
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Recovered normally." });
        turn = Promise.withResolvers<string>();
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "preparation-deadline-session", identity,
        providerSessionId: "preparation-deadline-provider", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Normal native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "preparation-deadline", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    return backend;
  };
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const childInputPath = process.env.D11_BLOCKED_OWNER_INPUT;
const blocking = vi.hoisted(() => ({ resumed: false }));
vi.mock("../services/fresh-workspace-continuation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/fresh-workspace-continuation.js")>();
  return { ...actual, readFreshWorkspaceReadiness: async (...args: Parameters<typeof actual.readFreshWorkspaceReadiness>) => {
    const result = await actual.readFreshWorkspaceReadiness(...args);
    if (process.env.D11_BLOCKED_OWNER_INPUT && !blocking.resumed) {
      const { writeFileSync, readFileSync } = await import("node:fs");
      const input = JSON.parse(readFileSync(process.env.D11_BLOCKED_OWNER_INPUT, "utf8"));
      writeFileSync(input.blockedPath, JSON.stringify({ runId: args[1].id, pid: process.pid, at: Date.now(), run: args[1] }));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 105_000);
      blocking.resumed = true;
      writeFileSync(input.unblockedPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    }
    return result;
  } };
});

it.skipIf(!childInputPath)("blocked owner child", async () => {
  const input = JSON.parse(await fs.readFile(childInputPath!, "utf8"));
  const db = createDb(input.connectionString, { maxConnections: 4, applicationName: "d11proof-blocked-child" });
  const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: completingBackend(db) });
  try {
    await currentControllerProcess();
    const run = await heartbeat.wakeup(input.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: input.userId, manualUserWake: true,
      payload: { issueId: input.issueId, commentId: input.messageId },
      contextSnapshot: { issueId: input.issueId, taskKey: input.issueId, wakeCommentId: input.messageId } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    await fs.writeFile(input.childResultPath, JSON.stringify({ run: settled, resumed: blocking.resumed }, null, 2));
  } finally {
    await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
  }
}, 160_000);

describe.skipIf(Boolean(childInputPath) || !support.supported)("D11 living blocked preparation owner", () => {
  const fixture = nativeRestartFixture({});
  it("fences every resumed-owner write after the real lease lapses and the sweep schedules its successor", async () => {
    const { companyId, agentId, temporary } = fixture.current;
    const db = createDb(temporary.connectionString, { maxConnections: 4, applicationName: "d11proof-parent" });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: completingBackend(db) });
    const proofDir = await fs.mkdtemp(path.join(tmpdir(), "blocked-owner-"));
    const evidenceDir = process.env.TASK_OUT ?? proofDir;
    await fs.mkdir(evidenceDir, { recursive: true });
    const blockedPath = path.join(proofDir, "blocked.json"), unblockedPath = path.join(proofDir, "unblocked.json");
    const childResultPath = path.join(proofDir, "child-result.json"), inputPath = path.join(proofDir, "input.json");
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;
    let childOutput = "";
    try {
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
      const [issue] = await db.insert(issues).values({ companyId, title: "One answer after a blocked owner", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" }).returning();
      const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id, authorType: "user", authorUserId: userId, body: "Please do my task exactly once." }).returning();
      await db.execute(sql`create table d11_provider_starts (run_id uuid not null, app text not null)`);
      await db.execute(sql`create table d11_stale_writes (id bigserial primary key, at timestamptz default clock_timestamp(), target text, statement text, old_row jsonb, new_row jsonb)`);
      await db.execute(sql`create function d11_audit_stale_writer() returns trigger language plpgsql as $$ begin
        insert into d11_stale_writes(target, statement, old_row, new_row) values (TG_TABLE_NAME, current_query(),
          case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end,
          case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end);
        return NEW;
      end $$`);
      await fs.writeFile(inputPath, JSON.stringify({ connectionString: temporary.connectionString, companyId, agentId, userId,
        issueId: issue!.id, messageId: message!.id, blockedPath, unblockedPath, childResultPath }), { mode: 0o600 });
      child = spawn(process.execPath, [path.join(repositoryRoot, "node_modules/vitest/vitest.mjs"), "run", "server/src/__tests__/heartbeat-blocked-owner-proof.test.ts", "--maxWorkers=2", "-t", "blocked owner child"],
        { cwd: repositoryRoot, env: { ...process.env, D11_BLOCKED_OWNER_INPUT: inputPath },
          detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      exited = once(child, "exit");
      child.stdout!.on("data", chunk => { childOutput += chunk.toString(); });
      child.stderr!.on("data", chunk => { childOutput += chunk.toString(); });
      await until("child blocks its actual preparation event loop", async () => {
        if (child!.exitCode !== null) throw new Error(`Child exited before blocking: ${childOutput}`);
        try { await fs.access(blockedPath); return true; } catch { return false; }
      }, 30_000);
      const blocked = JSON.parse(await fs.readFile(blockedPath, "utf8"));
      const runId = blocked.runId;
      const [claimed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(claimed).toMatchObject({ status: "running", executionStage: "preparing", runtimeMode: "legacy" });
      expect(await proveLegacyController(claimed!)).toMatchObject({ verdict: "alive" });
      expect((await heartbeat.reapOrphanedRuns({ staleThresholdMs: 300_000 })).runIds).not.toContain(runId);
      const sweepAt = claimed!.controllerLeaseExpiresAt!.getTime() + 30_500;
      await sleep(Math.max(0, sweepAt - Date.now()));
      expect(Date.now() - blocked.at).toBeGreaterThan(60_000);
      process.kill(blocked.pid, 0);
      const [lapsed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const ownerProofBefore = await proveLegacyController(lapsed!);
      expect(ownerProofBefore).toMatchObject({ verdict: "alive" });
      const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 300_000 });
      const sweptAt = Date.now();
      expect(reaped.runIds).toContain(runId);
      const [swept] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(swept).toMatchObject({ status: "failed", errorCode: "process_lost" });
      expect(swept!.controllerBootId).not.toBe(claimed!.controllerBootId);
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(successors).toHaveLength(1);
      expect(successors[0]!.status).toBe("scheduled_retry");
      const auditedTables = await db.execute<{ tablename: string }>(sql`
        select tablename from pg_tables where schemaname = 'public' and tablename <> 'd11_stale_writes'`);
      for (const { tablename } of auditedTables) {
        const quoted = `"${tablename.replaceAll('"', '""')}"`;
        await db.execute(sql.raw(`create trigger d11_stale_writer_audit after insert or update or delete on ${quoted} for each row execute function d11_audit_stale_writer()`));
      }
      const auditInstalledAt = Date.now();
      await exited;
      await fs.writeFile(path.join(evidenceDir, "blocked-child.log"), childOutput);
      expect(child.exitCode, childOutput).toBe(0);
      const staleWrites = await db.execute(sql`select * from d11_stale_writes order by id`);
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const childResult = JSON.parse(await fs.readFile(childResultPath, "utf8"));
      const unblocked = JSON.parse(await fs.readFile(unblockedPath, "utf8"));
      expect(unblocked.at, "the complete database audit must precede owner resume").toBeGreaterThan(auditInstalledAt);
      const proof = { runId, issueId: issue!.id, messageId: message!.id, childPid: blocked.pid, ownerProofBefore,
        blockedAt: blocked.at, leaseExpiredAt: claimed!.controllerLeaseExpiresAt, sweepDueAt: sweepAt, sweptAt, auditInstalledAt, auditedTables, unblocked,
        oldBootId: claimed!.controllerBootId, revokedBootId: swept!.controllerBootId, swept, after, staleWrites, childResult, successors };
      await fs.writeFile(path.join(evidenceDir, "blocked-owner-proof.json"), JSON.stringify(proof, null, 2));
      expect(staleWrites, "no stale progress, identity, claim, status, event or publication writes").toHaveLength(0);
      expect(after).toEqual(swept);
      const retry = await heartbeat.retryScheduledRetryNow({ issueId: issue!.id, actor: { actorType: "user", actorId: userId } });
      expect(retry).toMatchObject({ outcome: "promoted" });
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue!.id));
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue!.id));
      const providerStarts = await db.execute(sql`select * from d11_provider_starts`);
      await fs.writeFile(path.join(evidenceDir, "blocked-owner-final.json"), JSON.stringify({ allRuns, comments, providerStarts }, null, 2));
      expect(providerStarts).toHaveLength(1);
      expect(allRuns.filter(run => run.status === "succeeded")).toHaveLength(1);
      expect(comments.filter(comment => comment.authorType === "agent")).toHaveLength(1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid!, "SIGKILL");
      }
      await exited;
      await fs.writeFile(path.join(evidenceDir, "blocked-child.log"), childOutput);
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
      await fs.rm(proofDir, { recursive: true, force: true });
    }
  }, 210_000);
});
