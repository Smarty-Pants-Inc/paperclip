import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, authUsers, companyMemberships, completionContracts, environmentLeases, environments,
  heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { agentInstructionWorkingCopyService } from "../agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../agent-instructions.js";
import { createNativeRunTrace } from "./native-run-trace.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

// Diagnostic RED for S3. PG, working-copy capture/apply and native warm-owner
// settlement/reservation are real. Only the provider session is replaced, as
// in the existing native-session-executor PG tests. No network latency is added.
// This measures the instruction-directory reservation, not all B preparation;
// runtime compilation, artifact verification and real-Pi acceptance are absent.
// Keep RED-only until the native-home/workspace and durable-seal seams exist.
const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({
  ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(),
  executeNativeSession: provider.execute,
}));
import { closeIdleWarmNativeSessionsForRestart, executePaperclipNativeSession,
  reserveWarmNativeInstructionDirectory } from "./native-session-executor.js";

const execFile = promisify(execFileCallback);

describeEmbeddedPostgres("S3 settlement to immediate-follow-up span", () => {
  const environment = nativeRestartFixture();
  it("B's directory reservation does not inherit A's durable instruction checkpoint", async () => {
    const fixture = await environment.seedRun("S3-IMMEDIATE");
    const { db, runId, issueId } = fixture;
    const { companyId, agentId, paperclipHome } = environment.current;
    const userId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    const remoteCwd = join(paperclipHome, "s3-remote");
    const canonical = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "S3", adapterConfig: {} });
    await mkdir(canonical, { recursive: true });
    await mkdir(remoteCwd, { recursive: true });
    await writeFile(join(canonical, "AGENTS.md"), "Keep all file-save and run ownership checks.\n");
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: canonical,
      instructionsEntryFile: "AGENTS.md" } }).where(eq(agents.id, agentId));
    await db.update(heartbeatRuns).set({ responsibleUserId: userId }).where(eq(heartbeatRuns.id, runId));
    await db.insert(environments).values({ id: environmentId, name: "S3 local transport of real commands", driver: "sandbox" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      provider: "fixture", providerLeaseId: "s3-allocation", leasePolicy: "reuse_by_environment", metadata: { remoteCwd } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue: { id: issueId, title: "S3", description: null, reviewPolicy: null }, environmentLeaseId: leaseId });
    const commands: string[] = [];
    const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "fixture", environmentId, leaseId, remoteCwd,
      sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: "s3-allocation" },
      runner: { execute: async (input: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string;
        stdin?: string; timeoutMs?: number }) => {
        commands.push(`${input.command} ${(input.args ?? []).join(" ")}`);
        const env = { PATH: process.env.PATH, ...input.env }, args = [...(input.args ?? [])];
        if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
          Object.assign(env, { PAPERCLIP_TEST_STDIN: input.stdin });
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        const result = await execFile(input.command, args, { env, cwd: input.cwd, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString() };
      } } };
    const copies = agentInstructionWorkingCopyService(db);
    const copy = (await copies.prepare({ companyId, agentId, runId, cwd: remoteCwd, target, warm: true }))!;
    expect(copy).not.toBeNull();
    await writeFile(join(copy.executionRoot, "memory.md"), "A's final tool-written memory must be durable before handoff.\n");
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, agentId, issueId, runId, executionWorkspaceId: environmentId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: "S3", title: "S3", description: null, prompt: "Finish A", workMode: "standard" },
      workspace: { cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: { ...contract.contractJson, revision: String(contract.revision) } } as NativeExecutionInputV1["completionContract"],
      interactionResponses: [], credentialBindings: [],
    };
    provider.execute.mockImplementation(async options => {
      await options.onSession({ close: async () => {} });
      return { result: { summary: "A completed" }, terminal: { runTerminalState: "succeeded" },
        turnId: native.turnId, normalizedSessionId: execution.session.normalizedSessionId,
        providerSessionId: "s3-session", driverKind: "test", driverVersion: "1", nativeEventCount: 0,
        highestContiguousSourceSeq: 0, usage: null };
    });
    const spans: Array<Record<string, unknown>> = [];
    const trace = createNativeRunTrace({ runId: randomUUID(), onEvent: async event => {
      if (event.eventType === "run.performance.span") spans.push(event.payload as Record<string, unknown>);
    } });
    let checkpointStarted!: () => void;
    const checkpointStart = new Promise<void>(resolve => { checkpointStarted = resolve; });
    let first: ReturnType<typeof executePaperclipNativeSession> | undefined;
    let successor: ReturnType<typeof reserveWarmNativeInstructionDirectory> | undefined;
    try {
      first = executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId,
        backend: { kind: "test" } as never, runnerExecutionTarget: target,
        instructionWorkingCopy: { runId, root: copy.executionRoot, collectStopped: async () => {
          await copies.collectStopped({ companyId, runId, target });
        }, hasChanges: () => copies.hasChanges({ companyId, runId, target }), checkpointWarm: async () => {
          checkpointStarted();
          const saved = await trace.measure("heartbeat.instruction_checkpoint", () => copies.checkpointWarm({ companyId, runId, target }));
          return saved?.state === "warm_saved" && saved.errorCode === null;
        } },
      });
      await Promise.race([checkpointStart, first.then(() => { throw new Error("A never checkpointed"); })]);
      const settled = process.env.PAPERCLIP_S3_SETTLED === "1";
      if (settled) await first;
      const spanName = settled ? "heartbeat.prepare.settled_follow_up" : "heartbeat.prepare.immediate_follow_up";
      successor = trace.measure(spanName, () => reserveWarmNativeInstructionDirectory({
        companyId, agentId, previousRunId: runId, runId: randomUUID(), target,
        canReuse: () => copies.canReuseWarm(companyId, agentId, runId),
      }));
      expect((await first).exitCode).toBe(0);
      const reservation = await successor;
      expect(reservation).not.toBeNull();
      expect(await readFile(join(canonical, "memory.md"), "utf8")).toContain("A's final tool-written memory");
      await reservation!.release();
      await trace.finish("ok");
      const report = JSON.stringify({ scenario: settled ? "settled" : "immediate", spans, commandCount: commands.length }, null, 2);
      console.log("S3_SPANS", report);
      if (process.env.PAPERCLIP_S3_SPAN_REPORT_PATH) await writeFile(process.env.PAPERCLIP_S3_SPAN_REPORT_PATH, report);
      const immediate = spans.find(span => span.span === spanName)!;
      const boundMs = Number(process.env.PAPERCLIP_S3_SPAN_BOUND_MS ?? "100");
      expect(immediate.durationMs, "B inherits A's checkpoint on base; no pre-armed instruction seal is available").toBeLessThan(boundMs);
    } finally {
      await first?.catch(() => undefined);
      await successor?.catch(() => undefined);
      await closeIdleWarmNativeSessionsForRestart();
      await trace.finish("failed");
    }
  }, 60_000);
});
