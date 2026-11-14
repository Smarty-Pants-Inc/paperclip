import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { controllerInstances, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { abandonNativeRunnerCheckpointCommands, loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { lockSourceRecoveryCoordinators } from "./native-source-recovery-ownership.js";
import { isSettledRemoteWarmControlState } from "./remote-warm-session-recovery.js";
import { provesNoNativeRunProviderWork } from "./native-provider-work-proof.js";
import { currentProcessProbe, proveOwnerGone } from "../owner-proof.js";
import { proveControllerInstance } from "../controller-instance-lease.js";
import { OWNABLE_KINDS, resolveFenceHolders } from "../recovery/ownership-registry.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const lifecycle = new Set(["runner.drain", "runner.suspend", "runner.shutdown"]);
export const NATIVE_LEGACY_LIFECYCLE_SKEW_MS = 5_000;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Input = { db: Db; root: string; bytes: string; identity: Record<string, string>;
  companyId: string; agentId: string; issueId: string; currentRunId: string };

/** B1's fallback is ONLY for boots the record-driven reconciler cannot reach.
 * Keep the inventory's process/fence-owner tables stable through the documented fence:
 * row locks alone miss inserts and records becoming in-progress. SHARE permits
 * concurrent provers/readers, but excludes ownership INSERT/UPDATE/DELETE. These
 * are all tables from which OWNABLE_KINDS can produce a process/fence owner (including
 * the heartbeat/environment inputs to accepted-result owner classification).
 * No controller-table SHARE lock here: the prover must still renew/fence, and
 * two preflights must never upgrade competing SHARE locks on that table. */
async function proveOwnerlessController(db: Db, bootId: string, renewedAt: Date) {
  try {
    return await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`set local lock_timeout = '1s'`);
      await tx.execute(sql`lock table agents, environment_leases, execution_workspace_runtime_leases,
        heartbeat_runs, issue_recovery_actions, native_run_finalizations, sandbox_creation_operations,
        workspace_operations in share mode`);
      for (const kind of OWNABLE_KINDS) {
        if (!kind.listInProgress) continue;
        for (let offset = 0; ; offset += 200) {
          const listed = await kind.listInProgress(tx, 200, offset);
          await resolveFenceHolders(tx, listed.records);
          if (listed.records.some(({ owner }) => owner.kind === "process" ? owner.stamp.bootId === bootId
            : owner.kind === "fence" && (owner.stamp.fenceToken === bootId || owner.fence.currentFenceToken === bootId))) {
            return "expired" as const;
          }
          if (!listed.truncated) break;
          // The report uses the same per-kind cap. An incomplete inventory
          // cannot prove ownerlessness; never silently treat it as empty.
          if (offset + 200 >= 2_000) return "expired" as const;
        }
      }
      return proveControllerInstance(tx, bootId, renewedAt);
    });
  } catch (error) {
    for (let cause: unknown = error; cause && typeof cause === "object"; cause = record(cause).cause) {
      if (record(cause).code === "55P03") return "expired" as const;
    }
    throw error;
  }
}

/** A plan grants no admission. The caller must first prove the terminal owner,
 * released lease, stopped controller, local lifecycle and every quarantine.
 * commit then repeats the proof under source locks and durably abandons the
 * commands before the caller may retire the old authority. */
export async function planNativeLifecycleSettlement(input: Input): Promise<{
  commands: Record<string, unknown>[]; commit: () => Promise<string>;
} | null> {
  const control = record(JSON.parse(input.bytes));
  const commands = (Array.isArray(control.commands) ? control.commands : []).map(record)
    .filter(command => lifecycle.has(String(command.type)) && command.status === "pending");
  if (!commands.length || !Array.isArray(control.commands)) return null;
  const allCommands = control.commands.map(record);
  const projected = { ...control, commands: allCommands
    .filter(command => !commands.some(candidate => candidate.commandId === command.commandId)) };
  if (!isSettledRemoteWarmControlState(projected, input.identity)) return null;
  const answered = new Set(projected.commands.filter(command => command.type === "semantic_tool.result" && command.status === "completed")
    .map(command => record(command.payload).sourceEventId));
  if ((control.committedEvents as unknown[]).map(record).some(event =>
    ["semantic_tool.input", "mcp_app.tool_input"].includes(String(event.eventType)) && !answered.has(event.sourceEventId))) return null;
  // A command already released to an old Runner cannot be recalled server-side.
  // Do not call it abandoned. The PRP send path checkpoints this count BEFORE
  // sending, so zero in both durable sources proves it was never released.
  if (control.commandDeliveryCounts == null || commands.some(command => Number(record(control.commandDeliveryCounts)[String(command.commandId)] ?? 0) !== 0)) return null;
  const hasLegacyCommands = commands.some(command => command.issuer === undefined);
  const current = await currentNativeControllerIdentity();
  const binding = { companyId: input.companyId, issueId: input.issueId, runId: input.identity.runId! };
  const prove = async (db: Pick<Db, "select" | "execute">, fenceOwnerless = false): Promise<boolean> => {
    const boots = hasLegacyCommands ? await db.select().from(controllerInstances) : [];
    const boot = boots.find(row => row.bootId === current.bootId);
    const [prior] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId),
      eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.nativeIssueId, input.issueId)));
    const snapshot = record(prior?.runnerProfileJson?.sessionCheckpoint);
    if (!prior || !["succeeded", "failed", "cancelled", "timed_out"].includes(prior.status)
      || prior.nativeSessionId !== input.identity.normalizedSessionId || snapshot.activeTurnId !== null
      || !Array.isArray(snapshot.pendingRuntimeRequests) || snapshot.pendingRuntimeRequests.length) return false;
    const active = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.nativeSessionId, input.identity.normalizedSessionId!),
      inArray(heartbeatRuns.status, ["running"]), ne(heartbeatRuns.id, input.currentRunId)));
    if (active.length) return false;
    // The admitted startup reservation is not an in-flight provider turn.
    // It is the only running row excluded above, and only while the standing
    // all-run provider-work proof says it has not dispatched anything yet.
    if (!await provesNoNativeRunProviderWork(db, { companyId: binding.companyId, runId: input.currentRunId })) return false;
    const [owner] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, binding.runId),
      eq(nativeRunFinalizations.companyId, binding.companyId)));
    if (!owner || owner.leaseOwner || owner.recoveryState || owner.phase !== "committed" || !owner.resultId
      || owner.controllerBootId === current.bootId) return false;
    const checkpoint = await loadNativeRunnerCheckpoint(db, binding);
    if (!checkpoint) return false;
    const header = record(JSON.parse(checkpoint.records.get("header") ?? "null"));
    const savedState = record(header.state), savedIdentity = record(savedState.identity);
    if (Object.entries(input.identity).some(([key, value]) => savedIdentity[key] !== value) || savedState.commandDeliveryCounts == null) return false;
    const savedCounts = record(savedState.commandDeliveryCounts);
    if (hasLegacyCommands) {
      if (!boot || boot.fencedAt || boot.stoppedAt) return false;
      let allGone = true;
      for (const row of boots) {
        if (row.bootId === current.bootId || row.stoppedAt || row.fencedAt) continue;
        // B1 visits only provably ownerless boots. An owned boot must use
        // record-driven reconciliation with its actual owned-write timestamp;
        // renewedAt alone cannot bound that boot's last sign of life.
        // Fence only in the preflight, before any settlement SHARE lock. A
        // transaction recheck refuses a newly arrived unclosed boot instead of
        // upgrading SHARE locks in two competing settlements.
        if (!fenceOwnerless || row.epoch >= boot.epoch) { allGone = false; continue; }
        const proof = await proveOwnerlessController(db as Db, row.bootId, row.renewedAt);
        if (proof !== "stopped" && proof !== "fenced") allGone = false;
      }
      if (!allGone) return false;
    }
    for (const command of commands) {
      if (Number(savedCounts[String(command.commandId)] ?? 0) !== 0
        || JSON.stringify(command) !== checkpoint.records.get(`command:${command.controllerSeq}`)) return false;
      if (command.issuer !== undefined) {
        const issuer = record(command.issuer);
        if (typeof issuer.bootId !== "string" || !Number.isSafeInteger(issuer.generation) || Number(issuer.generation) < 1
          || issuer.bootId === current.bootId) return false;
        const proof = await proveOwnerGone({ kind: "local", scope: "native_lifecycle_command", generation: Number(issuer.generation),
          bootId: issuer.bootId, host: null, pid: null, processStartedAt: null, processSpace: null,
          processSpaceUnrecorded: true, requireRecordedProcessSpace: true }, {
          ...currentProcessProbe(), readOnly: true,
          controllerInstance: (bootId, touchedAt) => proveControllerInstance(db as Db, bootId, touchedAt, { readOnly: true }),
        });
        if (proof.verdict !== "gone") return false;
      } else {
        // Temporary M1 compatibility only. Delete this branch at M2.
        const issuedAt = typeof command.issuedAt === "string" ? Date.parse(command.issuedAt) : NaN;
        if (!boot || !Number.isFinite(issuedAt) || issuedAt >= boot.startedAt.getTime() - NATIVE_LEGACY_LIFECYCLE_SKEW_MS) return false;
      }
    }
    return true;
  };
  if (!await prove(input.db, true)) return null;
  return { commands, commit: async () => {
    const path = join(input.root, "control-plane", "control-plane-state.json");
    const abandonedAt = new Date().toISOString();
    try {
      await input.db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await lockSourceRecoveryCoordinators(tx, binding.companyId, [binding.runId, input.currentRunId]);
        if (hasLegacyCommands) await tx.execute(sql`lock table controller_instances in share mode`);
        if (readFileSync(path, "utf8") !== input.bytes || !await prove(tx as unknown as Db)) {
          throw new Error("native_lifecycle_settlement_proof_changed");
        }
        await abandonNativeRunnerCheckpointCommands(tx as Transaction, binding, commands, abandonedAt, current.bootId);
      });
    } catch (error) {
      for (let cause: unknown = error; cause && typeof cause === "object"; cause = record(cause).cause) {
        if (record(cause).code === "55P03") throw new Error("native_lifecycle_settlement_lock_timeout", { cause: error });
      }
      throw error;
    }
    const ids = new Set(commands.map(command => command.commandId));
    const settled = { ...control, commands: allCommands.map(command => ids.has(command.commandId)
      ? { ...command, status: "rejected", result: { status: "rejected", code: "controller_command_abandoned" },
        abandonment: { disposition: "ABANDONED", abandonedAt, settledByBootId: current.bootId } }
      : command) };
    const bytes = JSON.stringify(settled), temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    return bytes;
  } };
}
