// Keep reason: recorded preparation failure family in legacyprep BRIEF (29 native-agent runs).
// Real wake queue, heartbeat executor, resolver, instruction filesystem and PostgreSQL.
// Only fault: stop immediately AFTER the real instruction preparation, before selection commits.
// This is an intentionally RED regression; no provider process, credentials, or image is needed.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  agentInstructionWorkingCopies, agentWakeupRequests, agents, authUsers, companies,
  companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issues,
  issueThreadInteractions, principalPermissionGrants,
} from "@paperclipai/db";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { resolveHeartbeatNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const probe = vi.hoisted(() => ({
  armed: false,
  observations: [] as Array<{ runId: string; rowMode: string; rowReason: string | null;
    rowResolvedAt: Date | null; resolverKind: string; copyState: string | null }>,
}));

vi.mock("../services/heartbeat/instruction-working-copy.js", async original => {
  const actual = await original<typeof import("../services/heartbeat/instruction-working-copy.js")>();
  return { ...actual, createHeartbeatInstructionWorkingCopy: (...args: Parameters<typeof actual.createHeartbeatInstructionWorkingCopy>) => {
    const copy = actual.createHeartbeatInstructionWorkingCopy(...args);
    const realPrepare = copy.prepare.bind(copy);
    copy.prepare = async input => {
      const result = await realPrepare(input);
      if (probe.armed) {
        probe.armed = false;
        const { db, agent, readRun } = args[0];
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, readRun().id));
        const [receipt] = await db.select().from(agentInstructionWorkingCopies)
          .where(eq(agentInstructionWorkingCopies.runId, readRun().id));
        if (!row) throw new Error("legacyprep_probe_run_missing");
        probe.observations.push({ runId: row.id, rowMode: row.runtimeMode, rowReason: row.runtimeModeReason,
          rowResolvedAt: row.runtimeModeResolvedAt, resolverKind: input.nativeRuntimeResolution.kind,
          copyState: receipt?.state ?? null });
        // A terminal intentional fault prevents provider dispatch and automatic retries.
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
        throw new Error("legacyprep_probe_stop_after_real_instruction_preparation");
      }
      return result;
    };
    return copy;
  } };
});

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
let heartbeat: ReturnType<typeof heartbeatService> | undefined;
beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "legacyprep-red-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", `legacyprep-${randomUUID()}`);
  vi.stubEnv("PAPERCLIP_CONFIG", path.join(home, "config.json"));
  temporary = await startEmbeddedPostgresTestDatabase("legacyprep-red-");
  db = createDb(temporary.connectionString, { maxConnections: 4 });
}, 120_000);
afterEach(async () => { probe.armed = false; await heartbeat?.drainActiveRunExecutions(); });
afterAll(async () => {
  try { await heartbeat?.drainActiveRunExecutions(); await db?.$client.end(); }
  finally { await temporary?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); }
});

it("names an instruction-preparation failure without claiming a native or direct runtime choice", async () => {
  const companyId = randomUUID(), userId = randomUUID(), ownerId = randomUUID(), responderId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Preparation regression operator",
    email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companies).values({ id: companyId, name: "Preparation regression", issuePrefix: `LP${companyId.slice(0, 6)}`,
    defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
  const workspace = path.join(home, "workspace");
  await mkdir(workspace);
  const [owner, responder] = await db.insert(agents).values([ownerId, responderId].map(id => ({ id, companyId,
    name: id === ownerId ? "Task owner" : "Native responder", status: "idle", adapterType: "paperclip_runner",
    adapterConfig: { provider: "codex", model: "gpt-5.6-luna", homeMode: "preconfigured", cwd: workspace },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0 } }, permissions: {} }))).returning();
  if (!owner || !responder) throw new Error("Missing native agent fixture");
  const canonical = resolveManagedInstructionsRoot(responder);
  await mkdir(canonical, { recursive: true });
  await writeFile(path.join(canonical, "AGENTS.md"), "Resolve only the confirmation addressed to you.\n");
  const [configured] = await db.update(agents).set({ adapterConfig: { ...responder.adapterConfig,
    instructionsBundleMode: "managed", instructionsRootPath: canonical, instructionsEntryFile: "AGENTS.md" } })
    .where(eq(agents.id, responderId)).returning();
  if (!configured) throw new Error("Missing configured native agent");
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
    ...[ownerId, responderId].map(principalId => ({ companyId, principalType: "agent", principalId, membershipRole: "member", status: "active" })),
  ]);
  await db.insert(principalPermissionGrants).values(PERMISSION_KEYS.map(permissionKey => ({ companyId,
    principalType: "user", principalId: userId, permissionKey })));
  await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
  const [issue] = await db.insert(issues).values({ companyId, title: "Task with a pending addressed confirmation",
    status: "in_progress", workMode: "standard", assigneeAgentId: ownerId, responsibleUserId: userId }).returning();
  if (!issue) throw new Error("Missing task fixture");
  const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
    kind: "request_confirmation", status: "pending", addresseeAgentId: responderId, createdByUserId: userId,
    continuationPolicy: "none", requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator",
    resolverPolicyProvenance: "explicit", payload: { version: 1, prompt: "Confirm the bounded plan?" } }).returning();
  if (!card) throw new Error("Missing pending interaction fixture");
  const eligible = resolveHeartbeatNativeRuntimeMode({ persisted: { runtimeMode: "legacy", runtimeModeReason: null, runtimeModeResolvedAt: null },
    enabled: true, runtimeConfig: configured.runtimeConfig, adapterConfig: configured.adapterConfig,
    agent: { ...configured, status: "active" }, issue, target: null, workspaceId: null });
  expect(eligible).toMatchObject({ kind: "native", reason: "eligible_opt_in" });
  const beforeNativeSelection = vi.fn(async () => {});
  heartbeat = heartbeatService(db, { beforeNativeRuntimeSelection: beforeNativeSelection });
  probe.observations = [];
  probe.armed = true;
  const context = { issueId: issue.id, taskId: issue.id, interactionId: card.id, interactionKind: card.kind,
    sourceCommentId: null, sourceRunId: null, source: "issue.interaction.created", wakeReason: "interaction_pending" };
  const run = await heartbeat.wakeup(responderId, { source: "automation", triggerDetail: "system", reason: "interaction_pending",
    idempotencyKey: `interaction-pending:${card.id}`, requestedByActorType: "user", requestedByActorId: userId,
    payload: { issueId: issue.id, interactionId: card.id, interactionKind: card.kind,
      sourceCommentId: null, sourceRunId: null, mutation: "interaction" }, contextSnapshot: context });
  expect(run, "Real queue must admit the bound pending-card wake").not.toBeNull();
  await heartbeat.drainActiveRunExecutions();
  if (!run) throw new Error("Missing real queued run");
  const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
  const [receipt] = await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, run.id));
  const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.runId, run.id),
    eq(agentWakeupRequests.reason, "interaction_pending")));
  console.log("LEGACYPREP_EVIDENCE", JSON.stringify({ eligible, observations: probe.observations,
    run: { id: saved?.id, status: saved?.status, runtimeMode: saved?.runtimeMode, reason: saved?.runtimeModeReason,
      resolvedAt: saved?.runtimeModeResolvedAt, errorCode: saved?.errorCode, error: saved?.error },
    wakeCount: wakes.length, copy: receipt && { state: receipt.state, errorCode: receipt.errorCode },
    instructionEvents: events.filter(event => event.eventType === "instruction_save").map(event => ({ message: event.message, payload: event.payload })),
    beforeNativeSelectionCalls: beforeNativeSelection.mock.calls.length }));
  expect(wakes).toHaveLength(1);
  expect(probe.observations, "Must reach REAL instruction preparation after the native resolver, not an earlier fixture error")
    .toEqual([expect.objectContaining({ runId: run.id, resolverKind: "native", copyState: "prepared" })]);
  expect(saved?.error).toContain("legacyprep_probe_stop_after_real_instruction_preparation");
  expect(beforeNativeSelection).not.toHaveBeenCalled();
  expect(events).toContainEqual(expect.objectContaining({ eventType: "instruction_save",
    payload: expect.objectContaining({ code: "INSTRUCTION_COLLECTION_UNAVAILABLE" }) }));
  // D11d's agreed remedy does not select native before filesystem preparation.
  // Preserve the original reachability proof, but demand a named setup outcome
  // and an explanation that this terminal legacy placeholder was NOT a choice.
  expect(saved).toMatchObject({ status: "failed", errorCode: "instruction_preparation_failed",
    runtimeMode: "legacy", runtimeModeResolvedAt: null,
    runtimeModeReason: "not_selected_run_ended_before_selection:instruction_prep" });
}, 120_000);
