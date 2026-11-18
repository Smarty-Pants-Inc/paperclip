import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { DurablePrpControlPlane, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { executePaperclipNativeSession } from "../../services/native-runtime/native-session-executor.js";
import { nativeRunnerCheckpointWriter } from "../../services/native-runtime/native-runner-checkpoint.js";
import { PaperclipControlPlanePort } from "../../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun } from "../../services/native-runtime/native-run-finalizer.js";

const peerTurns = new Map<string, { identity: { companyId: string; agentId: string; issueId: string; runId: string; sessionId: string };
  runnerInstanceId: string; result: Record<string, unknown>; snapshot: PersistedNativeSession; prompts: unknown[] }>();

/** Controlled provider boundary, not a production/provider claim. Admission,
 * awaited start intent, event/result persistence, checkpoint fencing, and native
 * finalization all use their real owners against the caller's embedded PG. */
export async function answerWithNativePeer(input: {
  db: Db;
  execution: Parameters<typeof executePaperclipNativeSession>[0]["execution"];
  runnerInstanceId: string;
  text: string;
  getFreshSessionHandoff: () => Promise<string | null>;
}) {
  const { db, execution, runnerInstanceId, text } = input;
  const { companyId, agentId, issueId, runId } = execution.binding;
  const normalizedSessionId = execution.session.normalizedSessionId;
  if (!normalizedSessionId) throw new Error("controlled_peer_requires_selected_conversation");
  const identity = { companyId, agentId, issueId, runId, sessionId: normalizedSessionId };
  const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
  const contract = execution.completionContract.contract as { revision: string; criteria: Array<{ id: string }> };
  const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: text,
    completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
      criteria: contract.criteria.map(criterion => ({ criterionId: criterion.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
    evidence: [], verification: [], artifacts: [], attentionRequests: [] };
  const snapshot = { backendKind: "mock", sessionId: normalizedSessionId, identity, providerSessionId: "controlled-answer-thread",
    driverKind: execution.session.driverKind, cursor: "3", activeTurnId: null, pendingRuntimeRequests: [], terminalTurns: [], lineage: [], semanticResult: result } as PersistedNativeSession;
  const prompts: unknown[] = [];
  peerTurns.set(runId, { identity, runnerInstanceId, result, snapshot, prompts });
  let activeRunId = runId, history = "";
  const active = () => {
    const turn = peerTurns.get(activeRunId);
    if (!turn) throw new Error("controlled_peer_turn_missing");
    return turn;
  };
  const session = { identity: () => active().identity, capabilities: async () => capabilities,
    attachRun: async (next: { identity: typeof identity }) => {
      const previous = active().identity;
      if (next.identity.companyId !== previous.companyId || next.identity.agentId !== previous.agentId
        || next.identity.issueId !== previous.issueId || next.identity.sessionId !== previous.sessionId
        || !peerTurns.has(next.identity.runId)) throw new Error("controlled_peer_attachment_mismatch");
      activeRunId = next.identity.runId;
    },
    startTurn: async (turn: unknown) => {
      active().prompts.push({ history, turn });
      history += `\n${JSON.stringify(turn)}`;
      return { turnId: `turn-${activeRunId}` };
    },
    async *events() {
      const current = active();
      for (const [index, eventType] of ["item.completed", "run.result.proposed", "turn.completed"].entries()) yield {
        schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceSeq: index + 1, sourceEventId: `${activeRunId}:${index}`,
        sourceInstanceId: current.runnerInstanceId, sourceKind: "runner", runId: activeRunId, normalizedSessionId, turnId: `turn-${activeRunId}`,
        eventType, priority: 0, emittedAt: new Date().toISOString(),
        payload: index === 0 ? { kind: "agentMessage", channel: "final", text: current.result.summary } : index === 1 ? current.result : {} };
    },
    result: async () => active().result,
    snapshot: async () => ({ ...active().snapshot, controlledPeerHistory: history }), close: async () => {} };
  const backend = { descriptor: async () => ({ kind: "mock", name: "controlled answer peer", version: "1", capabilities,
    runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }),
    openSession: async () => session, recoverSession: async (saved: PersistedNativeSession & { controlledPeerHistory?: string }) => {
      history = saved.controlledPeerHistory ?? "";
      return { recovered: true, session };
    } };
  const answered = await executePaperclipNativeSession({ ...input, backend: backend as never, useRunnerd: true });
  // The controlled peer has no Rust controller. Persist its real durable core
  // through the checkpoint writer and port, rather than forging recovery JSON
  // or leaving the completed turn artificially 'running' for the next turn.
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
  if (!run || !coordinator?.controllerBootId || !run.runnerProfileJson?.sessionCheckpoint) throw new Error("controlled_peer_did_not_checkpoint");
  const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: coordinator.controllerBootId,
    generation: coordinator.controllerGeneration, leaseOwner: coordinator.leaseOwner ?? "released-controller" };
  const root = await mkdtemp(join(tmpdir(), "native-answer-peer-"));
  const core = new DurablePrpControlPlane({ stateDirectory: root,
    identity: { runId, normalizedSessionId, runnerInstanceId, environmentLeaseId: String(run.runnerProfileJson.environmentLeaseId),
      turnId: String(run.runnerProfileJson.turnId), itemId: String(run.runnerProfileJson.itemId) },
    expectedRunnerVersion: "controlled-peer", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
  try {
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
    await core.flushCheckpoint();
    const port = new PaperclipControlPlanePort(db, { companyId, agentId, issueId, runId, sessionId: normalizedSessionId,
      sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: "controlled-peer-port",
      completionContractId: execution.completionContract.id, completionContractSha256: execution.completionContract.sha256 },
    { nativeRecovery: { owner, compatibility: { configDigest: `sha256:${"a".repeat(64)}`, processConfigDigest: null } } });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerInstanceId });
    await port.checkpointSession(run.runnerProfileJson.sessionCheckpoint as unknown as PersistedNativeSession);
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
  } finally {
    await core.stop();
    await rm(root, { recursive: true, force: true });
  }
  const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return { answered, settled, prompts };
}
