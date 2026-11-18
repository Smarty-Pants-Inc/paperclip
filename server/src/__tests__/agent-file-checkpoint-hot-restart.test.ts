import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, heartbeatRuns, nativeRunFinalizations, principalPermissionGrants } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, PrpEvent } from "@paperclipai/paperclip-runner";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { drainAgentFileCheckpoints } from "../services/agent-directory-working-copies.js";
import * as checkpointFiles from "../services/agent-file-checkpoints.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { resolveHotRestartIntentPath, writeHotRestartIntent } from "../services/hot-restart.js";
import { drainRunExecutionFinalizersForShutdown } from "../shutdown.js";
import { logger } from "../middleware/logger.js";

// Keep: real CONNECTION_ENDED/data-loss failure path. PostgreSQL rows, file
// capture, authorization, save and restart preparation are real. Only the
// provider is controlled; its turn deliberately remains in flight after detach.
describeEmbeddedPostgres("agent-file checkpoint join on successful hot restart", () => {
  const fixture = nativeRestartFixture();

  it("joins only the checkpoint, leaving a DETACHED in-flight native run running for reattach", async () => {
    const f = await fixture.seedRun("AGENT-FILE-DETACHED");
    const { companyId, agentId, paperclipHome } = fixture.current;
    const userId = randomUUID();
    await f.db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await f.db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await f.db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await f.db.update(heartbeatRuns).set({ responsibleUserId: userId, completionContractId: null, completionContractSha256: null }).where(eq(heartbeatRuns.id, f.runId));
    await instanceSettingsService(f.db).updateExperimental({ enableNativeRunner: true });

    let identity: NativeRunIdentity;
    let finishTurn!: () => void;
    const turn = new Promise<void>(resolve => { finishTurn = resolve; });
    const detached = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const cancel = vi.fn(() => ({ cleanup: Promise.resolve() }));
    const turnId = randomUUID();
    let turnStarted!: () => void;
    const started = new Promise<void>(resolve => { turnStarted = resolve; });
    let sourceInstanceId = "";
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => capabilities,
      startTurn: async () => ({ turnId }),
      async *events() {
        yield { schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:1`, sourceSeq: 1, runId: identity.runId, normalizedSessionId: identity.sessionId,
          turnId, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType: "turn.started", payload: {} } satisfies PrpEvent;
        turnStarted();
        await turn;
      },
      result: async () => { throw new Error("detached turn has no terminal result"); },
      snapshot: async () => ({ backendKind: "mock", sessionId: identity.sessionId, identity,
        providerSessionId: "held-native-provider", cursor: null, activeTurnId: turnId, pendingRuntimeRequests: [], lineage: [] }),
      detachControllerForRestart: detached, close, cancel,
    };
    const heartbeat = heartbeatService(f.db, { nativeSessionBackendFactory: () => ({
      descriptor: async () => {
        const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        sourceInstanceId = run.runnerInstanceId!;
        return { kind: "mock", name: "held-native-provider", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    }) });
    const copies = agentInstructionWorkingCopyService(f.db);
    let releaseCheckpoint!: () => void;
    const held = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
    let captured!: () => void;
    const capturing = new Promise<void>(resolve => { captured = resolve; });
    let checkpoint: ReturnType<typeof copies.checkpointWarm> | undefined;
    let joining: Promise<unknown> | undefined;
    let capture: ReturnType<typeof vi.spyOn> | undefined;
    try {
      expect((await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId])).claims).toEqual([expect.objectContaining({ runId: f.runId })]);
      await started;
      // Materialize this checkpoint explicitly after native admission. This
      // keeps the controlled provider out of the directory setup under test.
      const root = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Editor", adapterConfig: {} });
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "AGENTS.md"), "before restart\n");
      await f.db.update(agents).set({ adapterConfig: { provider: "codex", instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" } }).where(eq(agents.id, agentId));
      const copy = (await copies.prepare({ companyId, agentId, runId: f.runId, cwd: paperclipHome, warm: true }))!;
      await fs.writeFile(path.join(copy.localRoot, "AGENTS.md"), "checkpoint survived restart\n");
      const captureFile = checkpointFiles.captureAgentFileCheckpoint;
      capture = vi.spyOn(checkpointFiles, "captureAgentFileCheckpoint").mockImplementation(async input => {
        const result = await captureFile(input);
        captured();
        await held; // outside any store transaction, immediately before apply
        return result;
      });
      checkpoint = copies.checkpointWarm({ companyId, runId: f.runId });
      void checkpoint.catch(() => {});
      await capturing;
      await writeHotRestartIntent({ previousServerPid: process.pid, previousServerVersion: "previous" });
      const preparation = await heartbeat.prepareHotRestartShutdown("SIGTERM");
      expect(preparation).toMatchObject({ mode: "hot_restart", skipDrain: true });
      expect(detached).toHaveBeenCalledOnce();
      let joined = false;
      joining = drainRunExecutionFinalizersForShutdown({ signal: "SIGTERM", drain: drainAgentFileCheckpoints, timeoutMs: 30_000, log: logger }).then(result => { joined = true; return result; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(joined).toBe(false);
      releaseCheckpoint();
      expect((await checkpoint)?.state).toBe("warm_saved");
      expect(await joining).toBe("drained");
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("checkpoint survived restart\n");
      const receipt = await copies.get(companyId, f.runId);
      expect(receipt).toMatchObject({ state: "warm_saved", errorCode: null, processStoppedAt: null, receipt: { checkpointState: "saved" } });
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run).toMatchObject({ status: "running", errorCode: null, finishedAt: null });
      const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(owner).toMatchObject({ phase: "observed", resultId: null });
      expect(close).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      // The native event iterator is STILL held. A full execution join would
      // not resolve here; the next controller owns eventual run completion.
    } finally {
      releaseCheckpoint();
      finishTurn();
      await Promise.allSettled([checkpoint, joining]);
      await heartbeat.drainActiveRunExecutions();
      capture?.mockRestore();
      await fs.rm(resolveHotRestartIntentPath(), { force: true });
    }
  }, 90_000);
});
