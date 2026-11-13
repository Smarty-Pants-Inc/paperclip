import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, heartbeatRunEvents, issues, principalPermissionGrants } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type OrderingPin = {
  previousRunId: string;
  events: string[];
  reserveGate: ReturnType<typeof Promise.withResolvers<void>>;
  prepareGate: ReturnType<typeof Promise.withResolvers<void>>;
  finishGate: ReturnType<typeof Promise.withResolvers<void>>;
  prepared: boolean;
  adoptedRoot?: string;
  executorRoot?: string;
  overlaps: string[];
  pendingPreparation?: Promise<unknown>;
};
const ordering = vi.hoisted(() => new Map<string, OrderingPin>());
const ORDERING_EXECUTOR_REACHED = "ordering pin reached executor without starting a provider";

// Keep the assembled heartbeat coordinator, runtime selection and managed-copy
// implementation. Only the retained Runner reservation and provider boundary
// are doubles: this test must not launch an actual provider.
vi.mock("../services/heartbeat/instruction-working-copy.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/instruction-working-copy.js")>();
  return { ...actual, createHeartbeatInstructionWorkingCopy: (input: Parameters<typeof actual.createHeartbeatInstructionWorkingCopy>[0]) => {
    const pin = ordering.get(input.agent.companyId);
    const controller = actual.createHeartbeatInstructionWorkingCopy(pin ? { ...input, session: { ...input.session,
      taskSessionForRun: { ...input.session.taskSessionForRun, lastRunId: pin.previousRunId } as NonNullable<typeof input.session.taskSessionForRun>,
    } } : input);
    if (pin) {
      const prepare = controller.prepare;
      controller.prepare = (...args) => {
        const pending = pin.pendingPreparation = prepare(...args);
        // Own the delayed work even under a missing-await regression, so a
        // failed pin cannot leave materialization running past teardown.
        void pending.catch(() => undefined);
        return pending;
      };
    }
    return controller;
  } };
});
vi.mock("../services/native-runtime/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/index.js")>();
  return { ...actual,
    reserveWarmNativeInstructionDirectory: async (input: Parameters<typeof actual.reserveWarmNativeInstructionDirectory>[0]) => {
      const pin = ordering.get(input.companyId);
      if (!pin) return actual.reserveWarmNativeInstructionDirectory(input);
      pin.events.push("reserve.started");
      await pin.reserveGate.promise;
      if (!await input.canReuse()) throw new Error("Ordering fixture directory is not reusable");
      pin.events.push("reserve.completed");
      return { reuseRunId: input.previousRunId, adopt: (root: string) => {
        pin.adoptedRoot = root;
        pin.events.push("adopt.completed");
      }, release: async () => {} };
    },
    executePaperclipNativeSession: async (input: Parameters<typeof actual.executePaperclipNativeSession>[0]) => {
      const pin = ordering.get(input.execution.binding.companyId);
      if (!pin) return actual.executePaperclipNativeSession(input);
      pin.events.push("executor.started");
      pin.executorRoot = input.instructionWorkingCopy?.root;
      if (!pin.prepared) pin.overlaps.push("executor");
      throw new Error(ORDERING_EXECUTOR_REACHED);
    },
  };
});
vi.mock("../services/heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/runtime-selection.js")>();
  return { ...actual, prepareAndSelectHeartbeatRuntime: async (...args: Parameters<typeof actual.prepareAndSelectHeartbeatRuntime>) => {
    const [db, input, preparation] = args;
    return actual.prepareAndSelectHeartbeatRuntime(db, input, { ...preparation, measure: (phase, work) => {
      const pin = ordering.get(input.agent.companyId);
      if (pin && phase === "runtime_selection") {
        pin.events.push("selection.started");
        if (!pin.prepared) pin.overlaps.push("selection");
      }
      return preparation.measure(phase, work);
    } });
  } };
});
vi.mock("../services/heartbeat/runtime-execution.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/runtime-execution.js")>();
  return { ...actual, executeHeartbeatRuntime: async (...args: Parameters<typeof actual.executeHeartbeatRuntime>) => {
    const pin = ordering.get(args[1].agent.companyId);
    if (pin) {
      pin.events.push("runtime.started");
      if (!pin.prepared) pin.overlaps.push("runtime");
    }
    return actual.executeHeartbeatRuntime(...args);
  } };
});

const cleanup = vi.hoisted(() => ({ failures: new Set<string>(), revocations: new Set<string>(), attempts: new Map<string, number>() }));
vi.mock("../services/agent-instruction-working-copies.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/agent-instruction-working-copies.js")>();
  return { ...actual, agentInstructionWorkingCopyService: (...args: Parameters<typeof actual.agentInstructionWorkingCopyService>) => {
    const copies = actual.agentInstructionWorkingCopyService(...args);
    return { ...copies, prepare: async (input: Parameters<typeof copies.prepare>[0]) => {
      if (cleanup.revocations.has(input.companyId)) {
        await args[0].update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, input.companyId));
      }
      const pin = ordering.get(input.companyId);
      if (!pin) return copies.prepare(input);
      pin.events.push("prepare.started");
      await pin.prepareGate.promise;
      const copy = await copies.prepare(input);
      pin.events.push("prepare.materialized");
      // The real copy has already moved its owner marker and synchronously
      // called reservation.adopt. Hold final bookkeeping in flight as well.
      await pin.finishGate.promise;
      pin.prepared = true;
      pin.events.push("prepare.completed");
      return copy;
    }, release: async (companyId: string, runId: string) => {
      cleanup.attempts.set(runId, (cleanup.attempts.get(runId) ?? 0) + 1);
      if (cleanup.failures.has(companyId)) throw new Error("Fixture cleanup unavailable");
      return copies.release(companyId, runId);
    } };
  } };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping heartbeat instruction copies tests: ${support.reason}`);

describePostgres("heartbeat instruction working-copy lifecycle", () => {
  const adapterType = "instruction_working_copy_test";
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "\uFEFF# Original\r\n☃\n", edited = "\uFEFF# Saved\r\nKeep across runs. ☃\n";
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const captured = new Map<string, { instructionPath: string | null; before: string | null; context: Record<string, unknown> }>();
  const failures = new Set<string>();

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-instruction-copies-")));
    process.env.PAPERCLIP_HOME = home;
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-instruction-copies-db-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false, supportsInstructionsBundle: true,
      execute: async input => {
        const instructionPath = typeof input.config.instructionsFilePath === "string" ? input.config.instructionsFilePath : null;
        captured.set(input.runId, { instructionPath, before: instructionPath ? await fs.readFile(instructionPath, "utf8") : null, context: structuredClone(input.context) });
        if (instructionPath) await fs.writeFile(instructionPath, edited);
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        await input.onProviderStopped?.();
        if (failures.has(input.agent.id)) throw new Error("Invalid fixture adapter configuration");
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (home) {
      const makeRemovable = async (directory: string): Promise<void> => {
        await fs.chmod(directory, 0o700);
        for (const child of await fs.readdir(directory, { withFileTypes: true })) if (child.isDirectory()) await makeRemovable(path.join(directory, child.name));
      };
      await makeRemovable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction lifecycle fixture", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "operator" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    const root = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Editor", adapterConfig: {} });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
    const cwd = await fs.mkdtemp(path.join(home, "workspace-"));
    await db.insert(agents).values({ id: agentId, companyId, name: "Editor", adapterType, status: "idle", adapterConfig: { cwd, instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, membershipRole: "member" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Save agent instructions", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, root, userId, cwd };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>) {
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run!.id));
    return { finished: finished!, events, input: captured.get(run!.id)! };
  }

  it("dispatches a private copy, saves exact bytes on provider stop, and restores them on the next run", async () => {
    const f = await seed();
    const first = await execute(f);
    expect(first.finished.status, first.finished.error ?? undefined).toBe("succeeded");
    expect(first.input.before).toBe(initial);
    expect(first.input.instructionPath).not.toBe(path.join(f.root, entryFile));
    expect(first.input.context.paperclipTaskMarkdown).toContain("Your persistent agent directory is");
    expect(first.finished.resultJson?.instructionSave).toMatchObject({ state: "saved", contract: "agent_files", entryFile });
    expect(first.events.some(event => event.eventType === "instruction_save" && event.payload?.state === "saved")).toBe(true);
    expect(await fs.readFile(path.join(f.root, entryFile), "utf8")).toBe(edited);
    await expect(fs.stat(first.input.instructionPath!)).rejects.toMatchObject({ code: "ENOENT" });
    const second = await execute(f);
    expect(second.finished.status, second.finished.error ?? undefined).toBe("succeeded");
    expect(second.input.before).toBe(edited);
    expect(second.finished.resultJson?.instructionSave).toMatchObject({ state: "unchanged" });
  });

  it("awaits managed-copy reservation, preparation and adoption before runtime/executor entry", async () => {
    // Keep reason: saved-agent-file data safety. The idle-owner check may regard
    // this run's own instruction reservation as eligible only because the
    // heartbeat awaits prepareInstructions all the way through its return.
    const f = await seed();
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: {
      ...agent!.adapterConfig, provider: "codex", model: "gpt-6.1-sol", lifecycleMode: "warm", idleTimeoutMs: 900_000,
    } }).where(eq(agents.id, f.agentId));
    const [prior] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, status: "succeeded", responsibleUserId: f.userId, finishedAt: new Date() }).returning();
    const copies = agentInstructionWorkingCopyService(db);
    const previousCopy = await copies.prepare({ companyId: f.companyId, agentId: f.agentId, runId: prior!.id, cwd: f.cwd, warm: true });
    expect(previousCopy).not.toBeNull();
    expect((await copies.checkpointWarm({ companyId: f.companyId, runId: prior!.id }))?.state).toBe("warm_saved");
    const pin: OrderingPin = { previousRunId: prior!.id, events: [], prepared: false, overlaps: [],
      reserveGate: Promise.withResolvers<void>(), prepareGate: Promise.withResolvers<void>(), finishGate: Promise.withResolvers<void>() };
    ordering.set(f.companyId, pin);
    let runId: string | undefined;
    try {
      const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      expect(run).not.toBeNull();
      runId = run!.id;
      const reached = (event: string) => vi.waitFor(() => expect(pin.events).toContain(event), { timeout: 10_000 });
      const noExecution = () => {
        expect(pin.events).not.toContain("selection.started");
        expect(pin.events).not.toContain("runtime.started");
        expect(pin.events).not.toContain("executor.started");
      };
      await reached("reserve.started");
      noExecution();
      pin.reserveGate.resolve();
      await reached("prepare.started");
      noExecution();
      pin.prepareGate.resolve();
      await reached("prepare.materialized");
      expect(pin.adoptedRoot).toBe(previousCopy!.executionRoot);
      expect(pin.prepared).toBe(false);
      noExecution();
      // Adoption alone does not mean the async prepare has finished.
      pin.finishGate.resolve();
      await heartbeat.drainActiveRunExecutions();
      expect(pin.events).toEqual(["reserve.started", "reserve.completed", "prepare.started", "adopt.completed",
        "prepare.materialized", "prepare.completed", "selection.started", "runtime.started", "executor.started"]);
      expect(pin.overlaps).toEqual([]);
      expect(pin.executorRoot).toBe(previousCopy!.executionRoot);
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(finished).toMatchObject({ runtimeMode: "native", status: "failed", error: expect.stringContaining(ORDERING_EXECUTOR_REACHED) });
      expect((await copies.get(f.companyId, prior!.id))?.state).toBe("superseded");
    } finally {
      pin.reserveGate.resolve(); pin.prepareGate.resolve(); pin.finishGate.resolve();
      await pin.pendingPreparation?.catch(() => undefined);
      await heartbeat.drainActiveRunExecutions();
      ordering.delete(f.companyId);
    }
  }, 45_000);

  it("continues without a copy or save claim when access is revoked after dispatch admission", async () => {
    const f = await seed();
    cleanup.revocations.add(f.companyId);
    const { finished, input, events } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    expect(input.instructionPath).toBeNull();
    expect(input.context.paperclipTaskMarkdown).toContain("No editable agent instruction working copy is registered");
    expect(finished.resultJson?.instructionSave).toBeUndefined();
    expect(events.some(event => event.eventType === "instruction_save" && event.payload?.state === "unavailable")).toBe(true);
    expect(await fs.readFile(path.join(f.root, entryFile), "utf8")).toBe(initial);
  });

  it("keeps the successful save and result when cleanup fails, without repeating that failure in outer teardown", async () => {
    const f = await seed();
    cleanup.failures.add(f.companyId);
    const { finished, events } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    expect(finished.resultJson?.instructionSave).toMatchObject({ state: "saved" });
    expect(await fs.readFile(path.join(f.root, entryFile), "utf8")).toBe(edited);
    expect(cleanup.attempts.get(finished.id)).toBe(1);
    expect(events.filter(event => event.eventType === "instruction_cleanup")).toEqual([expect.objectContaining({ level: "warn", payload: { state: "deferred" } })]);
  });

  it("preserves stopped-provider edits and releases the copy even if adapter dispatch then fails", async () => {
    const f = await seed();
    failures.add(f.agentId);
    const { finished, input, events } = await execute(f);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("Invalid fixture adapter configuration");
    expect(events.some(event => event.eventType === "instruction_save" && event.payload?.state === "saved")).toBe(true);
    expect(await fs.readFile(path.join(f.root, entryFile), "utf8")).toBe(edited);
    await expect(fs.stat(input.instructionPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
