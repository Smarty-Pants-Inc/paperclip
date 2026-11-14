import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import {
  derivePluginDatabaseNamespace,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";
import manifest, { TOOL } from "../../../packages/plugins/plugin-screen-capture/manifest.mjs";
import plugin from "../../../packages/plugins/plugin-screen-capture/worker.mjs";
import { DISCLOSURE, REFUSAL } from "../../../packages/plugins/plugin-screen-capture/capture.mjs";
import {
  NAMESPACE, CLAIM, READ_FACTS, READ_CLAIM, START_LOG, UPDATE_LOG, FINISH_CLAIM,
} from "../../../packages/plugins/plugin-screen-capture/sql.mjs";

// Permanent CI contract coverage. Real PostgreSQL race/deletion receipts live in
// the package's focused suite; this file needs no shared DB or running instance.
const parsedManifest = pluginManifestV1Schema.parse(manifest);
const context = {
  companyId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  runId: "00000000-0000-4000-8000-000000000003",
};

function harness(config: Record<string, unknown> = {}) {
  const result = createTestHarness({ manifest: parsedManifest, config });
  Object.defineProperty(result.ctx.db, "namespace", { value: NAMESPACE });
  return result;
}

describe("screen capture plugin host contract", () => {
  it("passes the real manifest validator with only the documented capabilities", () => {
    expect(parsedManifest.id).toBe("smarty.screen-capture");
    expect(parsedManifest.tools).toEqual([TOOL]);
    expect(parsedManifest.capabilities).toEqual([
      "agent.tools.register", "database.namespace.migrate",
      "database.namespace.read", "database.namespace.write",
    ]);
    expect(TOOL.parametersSchema.additionalProperties).toBe(false);
    expect(Object.keys(TOOL.parametersSchema.properties)).toEqual(["windowApp"]);
    expect(manifest.instanceConfigSchema.required).toEqual([
      "companyId", "principalUserId", "primaryAgentId",
    ]);
    expect(TOOL.description).toContain(DISCLOSURE);
    expect(DISCLOSURE).toBe("A capture is stored in this chat's history AND sent to our Langfuse tracing (EU); don't ask while client data is on screen.");
  });

  it("uses the host-derived namespace, not an invented database alias", () => {
    expect(derivePluginDatabaseNamespace(manifest.id, manifest.database.namespaceSlug)).toBe(NAMESPACE);
  });

  it("admits the actual migration through the documented view whitelist path", async () => {
    const ddl = await readFile(new URL(
      "../../../packages/plugins/plugin-screen-capture/migrations/001_screen_capture.sql", import.meta.url,
    ), "utf8");
    // This migration contains no quoted semicolons or procedural SQL.
    const statements = ddl.split(";").map(statement => statement.trim()).filter(Boolean);
    expect(statements).toHaveLength(5);
    for (const statement of statements) {
      expect(() => validatePluginMigrationStatement(statement, NAMESPACE,
        manifest.database.coreReadTables)).not.toThrow();
    }
    const view = statements.find(statement => statement.includes("CREATE VIEW"))!;
    expect(() => validatePluginMigrationStatement(view, NAMESPACE, [])).toThrow(/not whitelisted/);
    expect(() => validatePluginMigrationStatement(
      view.replace("public.heartbeat_runs", "public.user_company_preferences"),
      NAMESPACE, manifest.database.coreReadTables,
    )).toThrow(/not whitelisted/);
  });

  it("admits every exact runtime statement without allowing public writes", () => {
    for (const statement of [READ_FACTS, READ_CLAIM]) {
      expect(() => validatePluginRuntimeQuery(statement, NAMESPACE,
        manifest.database.coreReadTables)).not.toThrow();
    }
    for (const statement of [CLAIM, START_LOG, UPDATE_LOG, FINISH_CLAIM]) {
      expect(() => validatePluginRuntimeExecute(statement, NAMESPACE)).not.toThrow();
    }
    expect(CLAIM).toContain("AND f.company_id = $1::uuid");
    expect(() => validatePluginRuntimeExecute(CLAIM.replace(
      `${NAMESPACE}.capture_claims`, "public.issue_comments"), NAMESPACE)).toThrow();
    expect(() => validatePluginRuntimeQuery(CLAIM, NAMESPACE)).toThrow();
    expect(() => validatePluginRuntimeExecute(`${CLAIM}; ${CLAIM}`, NAMESPACE)).toThrow(/one statement/);
  });

  it("registers the real worker through the SDK and fails closed without board config", async () => {
    const h = harness();
    const execute = vi.spyOn(h.ctx.db, "execute").mockResolvedValue({ rowCount: 1 });
    const query = vi.spyOn(h.ctx.db, "query");
    await plugin.definition.setup(h.ctx);
    const reply = await h.executeTool(TOOL.name, {}, context);
    expect(reply).toEqual({ content: REFUSAL });
    expect(query).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toBe(START_LOG);
    expect(execute.mock.calls[0][1]?.slice(1)).toEqual([
      context.companyId, context.runId, context.agentId,
    ]);
    expect(execute.mock.calls[1][0]).toBe(UPDATE_LOG);
    expect(execute.mock.calls[1][1]).toContain("not_configured");
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok", message: "Screen capture policy ready; recorder is stub-only.",
    });
  });

  it("logs a non-primary SDK tool caller's refusal without claiming the message", async () => {
    const h = harness({ companyId: context.companyId,
      primaryAgentId: "00000000-0000-4000-8000-000000000004",
      principalUserId: "test-principal-structured-id" });
    const execute = vi.spyOn(h.ctx.db, "execute").mockResolvedValue({ rowCount: 1 });
    vi.spyOn(h.ctx.db, "query").mockResolvedValue([{ reason: "not_primary" }]);
    await plugin.definition.setup(h.ctx);
    expect(await h.executeTool(TOOL.name, {}, context)).toEqual({ content: REFUSAL });
    expect(execute.mock.calls.some(([statement]) => statement === CLAIM)).toBe(false);
    expect(execute.mock.calls.at(-1)?.[1]?.slice(7, 9)).toEqual(["refused", "not_primary"]);
    expect(execute.mock.calls.at(-1)?.[1]?.slice(-3)).toEqual([
      context.companyId, context.runId, context.agentId,
    ]);
  });

  it("does not turn forged tool arguments into SDK identity or a claim", async () => {
    const h = harness({ companyId: context.companyId, primaryAgentId: context.agentId,
      principalUserId: "test-principal-structured-id" });
    const execute = vi.spyOn(h.ctx.db, "execute").mockResolvedValue({ rowCount: 1 });
    const query = vi.spyOn(h.ctx.db, "query").mockResolvedValue([{ reason: "eligible" }]);
    await plugin.definition.setup(h.ctx);
    expect(await h.executeTool(TOOL.name, { runId: "forged", userId: "Paul" }, context))
      .toEqual({ content: REFUSAL });
    expect(query).toHaveBeenCalledWith(READ_FACTS, [
      context.companyId, context.runId, context.agentId,
      "test-principal-structured-id", context.agentId, context.companyId,
    ]);
    expect(execute.mock.calls.some(([statement]) => statement === CLAIM)).toBe(false);
    expect(execute.mock.calls.at(-1)?.[1]).toContain("invalid_arguments");
  });
});
