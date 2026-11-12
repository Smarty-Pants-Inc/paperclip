import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  buildPaperclipRuntimeMcpServers as legacyBuildRuntimeMcpServers,
  buildPaperclipWakePayload as legacyBuildWakePayload,
  ConfigurationIncompleteFailure as LegacyConfigurationIncompleteFailure,
  resolveExecutionRunAdapterConfig as legacyResolveAdapterConfig,
} from "../heartbeat.js";
import {
  buildPaperclipRuntimeMcpServers,
  buildPaperclipWakePayload,
  buildPiLangfuseParentEnvironment,
  applyPiLangfuseExclusion,
  ConfigurationIncompleteFailure,
  createHeartbeatRunPreparation,
  resolveExecutionRunAdapterConfig,
  readHeartbeatWakeComments,
} from "./run-preparation.js";

// Existing integration suites exercise the real database and dispatch path.
// These results isolate the factory binding and preparation query order.
function databaseWithResults(...results: unknown[][]) {
  const scopes: unknown[][] = [];
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const query = {
      from: () => query,
      leftJoin: () => query,
      where: (condition: SQL) => {
        scopes.push(new PgDialect().sqlToQuery(condition).params);
        return query;
      },
      orderBy: () => query,
      limit: () => query,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  });
  return { db: { select } as unknown as Db, select, scopes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const emptyRoutineContext = { routineId: null, env: null, responsibleUserId: null };

describe("Pi Langfuse parent environment", () => {
  const runId = "00000000-0000-4000-8000-000000000001";
  const issueId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const pi = { kind: "acpx", agent: "pi" };
  const parents = {
    LANGFUSE_USER_ID: agentId,
    LANGFUSE_PI_PARENT_TRACE_ID: "840666d160dfd7848af5f5e86661e0d6",
    LANGFUSE_PI_PARENT_SPAN_ID: "53485794c95451df",
    LANGFUSE_PI_PARENT_SESSION_ID: issueId,
  };

  // Trust boundary: these exact bytes join the server envelope and Pi spans.
  it("derives the fixed server-plugin contract vector without setting depth", () => {
    const source = { LANGFUSE_TRACING_ENABLED: "true" };
    expect(buildPiLangfuseParentEnvironment(source, pi, runId, agentId, issueId)).toEqual({ ...source, ...parents });
    expect(source).toEqual({ LANGFUSE_TRACING_ENABLED: "true" });
  });

  it.each([null, undefined])("uses the heartbeat run for a run without an issue (%s)", issue => {
    expect(buildPiLangfuseParentEnvironment({ LANGFUSE_TRACING_ENABLED: "true" }, pi, runId, agentId, issue)).toEqual({ LANGFUSE_TRACING_ENABLED: "true", ...parents, LANGFUSE_PI_PARENT_SESSION_ID: runId });
  });

  it.each(Object.keys(parents))("preserves an operator-set %s independently, including an empty value", name => {
    for (const value of ["operator-value", ""]) {
      expect(buildPiLangfuseParentEnvironment({ LANGFUSE_TRACING_ENABLED: "true", [name]: value }, pi, runId, agentId, issueId)).toEqual({ LANGFUSE_TRACING_ENABLED: "true", ...parents, [name]: value });
    }
  });

  // Data safety: the exclusion decision must precede both default generation
  // and controller projection, even when an operator supplied keys or parents.
  it.each([undefined, "false", " false", "FALSE ", "0", "no", "off", "", "garbage", "FALSE", "FaLsE"])("excludes Langfuse before Pi starts (%j)", enabled => {
    const source = {
      CUSTOM: "retained", OPENAI_API_KEY: "model-key",
      LANGFUSE_TRACING_ENABLED: enabled,
      LANGFUSE_PUBLIC_KEY: "synthetic-public", LANGFUSE_SECRET_KEY: "synthetic-secret",
      LANGFUSE_BASE_URL: "https://cloud.langfuse.com", LANGFUSE_FLUSH_AT: "1",
      LANGFUSE_TRACING_ENVIRONMENT: "test", LANGFUSE_UNRELATED: "must-not-leak",
      LANGFUSE_PI_PARENT_DEPTH: "4", PI_LANGFUSE_MAX_CHARS: "200000", ...parents,
      PAPERCLIP_PI_EXTENSIONS: JSON.stringify([
        "/opt/smarty-pi/extensions/langfuse/node_modules/@langfuse/pi-observability-plugin/src/index.ts",
        "/opt/pi/other/index.ts",
      ]),
    };
    const original = { ...source };
    expect(buildPiLangfuseParentEnvironment(source, pi, runId, agentId, issueId)).toEqual({
      CUSTOM: "retained", OPENAI_API_KEY: "model-key", LANGFUSE_TRACING_ENABLED: "false",
      PAPERCLIP_PI_EXTENSIONS: '["/opt/pi/other/index.ts"]',
    });
    expect(source).toEqual(original);
  });

  it("strips every Langfuse-named path segment for an excluded agent", () => {
    const retained = ["/opt/pi-packages/tool-cap", "/opt/pi-packages/pi-subagents"];
    const source = {
      LANGFUSE_TRACING_ENABLED: "false",
      PAPERCLIP_PI_EXTENSIONS: JSON.stringify([
        "/opt/pi-packages/langfuse-pi",
        "/opt/smarty-pi/extensions/langfuse/node_modules/@langfuse/pi-observability-plugin",
        "/opt/X/LangFuse-Plugin",
        "/opt/pi-packages/custom-pi-observability-extension",
        ...retained,
      ]),
    };
    expect(applyPiLangfuseExclusion(source, pi)).toEqual({
      LANGFUSE_TRACING_ENABLED: "false",
      PAPERCLIP_PI_EXTENSIONS: JSON.stringify(retained),
    });
  });

  it("keeps the exclusion empty when no keys or extensions were configured", () => {
    expect(buildPiLangfuseParentEnvironment({ LANGFUSE_TRACING_ENABLED: "false" }, pi, runId, agentId, issueId))
      .toEqual({ LANGFUSE_TRACING_ENABLED: "false" });
  });

  it.each(["true", " TRUE ", "1"])("keeps tracing enabled only when explicitly on (%j)", enabled => {
    const source = {
      ...(enabled === undefined ? {} : { LANGFUSE_TRACING_ENABLED: enabled }),
      LANGFUSE_PUBLIC_KEY: "synthetic-public", LANGFUSE_SECRET_KEY: "synthetic-secret",
      LANGFUSE_FLUSH_AT: "1", PI_LANGFUSE_MAX_CHARS: "200000",
      PAPERCLIP_PI_EXTENSIONS: '["/opt/pi/langfuse/index.ts","/opt/pi/other/index.ts"]',
    };
    expect(buildPiLangfuseParentEnvironment(source, pi, runId, agentId, issueId)).toEqual({ ...source, ...parents });
    expect(applyPiLangfuseExclusion(source, pi)).toBe(source);
  });

  // Late provider merges must not override the original configured decision.
  it.each([undefined, "false", " false", "FALSE ", "0", "no", "off", "", "garbage"])("fences later provider values using the configured flag (%j)", enabled => {
    const merged = {
      LANGFUSE_TRACING_ENABLED: "true", LANGFUSE_PUBLIC_KEY: "late-public",
      LANGFUSE_SECRET_KEY: "late-secret", LANGFUSE_NEW_SETTING: "late-setting",
      PI_LANGFUSE_MAX_CHARS: "200000", ...parents,
      PAPERCLIP_PI_EXTENSIONS: '["/opt/pi/langfuse/index.ts","/opt/pi/other/index.ts"]',
      CUSTOM: "retained",
    };
    expect(applyPiLangfuseExclusion(merged, pi, { LANGFUSE_TRACING_ENABLED: enabled })).toEqual({
      CUSTOM: "retained", LANGFUSE_TRACING_ENABLED: "false",
      PAPERCLIP_PI_EXTENSIONS: '["/opt/pi/other/index.ts"]',
    });
    expect(merged.LANGFUSE_SECRET_KEY).toBe("late-secret");
  });

  it.each(["not-json", "{}", '[1]'])("fails closed on malformed excluded extension configuration (%s)", raw => {
    expect(() => buildPiLangfuseParentEnvironment({ LANGFUSE_TRACING_ENABLED: "false", PAPERCLIP_PI_EXTENSIONS: raw }, pi, runId, agentId, issueId))
      .toThrow("Pi extensions");
  });

  it.each([{ kind: "codex" }, { kind: "acpx", agent: "claude" }])("does not change another provider's environment (%j)", provider => {
    const source = { CUSTOM: "retained", LANGFUSE_TRACING_ENABLED: "false", LANGFUSE_SECRET_KEY: "other-provider" };
    expect(buildPiLangfuseParentEnvironment(source, provider, runId, agentId, issueId)).toBe(source);
  });
});

describe("heartbeat run preparation module", () => {
  it("preserves the legacy error class and public preparation functions", () => {
    expect(LegacyConfigurationIncompleteFailure).toBe(ConfigurationIncompleteFailure);
    expect(legacyResolveAdapterConfig).toBe(resolveExecutionRunAdapterConfig);
    expect(legacyBuildWakePayload).toBe(buildPaperclipWakePayload);
    expect(legacyBuildRuntimeMcpServers).toBe(buildPaperclipRuntimeMcpServers);
    const failure = new ConfigurationIncompleteFailure("missing credentials", { reason: "test" });
    expect(failure).toBeInstanceOf(LegacyConfigurationIncompleteFailure);
    expect(failure.code).toBe("configuration_incomplete");
  });

  it("binds each context loader to its database and company scope", async () => {
    const first = databaseWithResults([{ id: "issue-one", title: "First company" }]);
    const second = databaseWithResults([{ id: "issue-two", title: "Second company" }]);
    const firstPreparation = createHeartbeatRunPreparation(first.db);
    const secondPreparation = createHeartbeatRunPreparation(second.db);
    expect(first.select).not.toHaveBeenCalled();
    expect(second.select).not.toHaveBeenCalled();
    const [firstIssue, secondIssue] = await Promise.all([
      firstPreparation.getIssueExecutionContext("company-one", "issue-one"),
      secondPreparation.getIssueExecutionContext("company-two", "issue-two"),
    ]);
    expect(firstIssue).toMatchObject({ id: "issue-one", title: "First company" });
    expect(secondIssue).toMatchObject({ id: "issue-two", title: "Second company" });
    expect(first.scopes[0]).toEqual(expect.arrayContaining(["company-one", "issue-one"]));
    expect(second.scopes[0]).toEqual(expect.arrayContaining(["company-two", "issue-two"]));
    expect(first.select).toHaveBeenCalledTimes(1);
    expect(second.select).toHaveBeenCalledTimes(1);
  });

  it("keeps the pinned routine environment and original run identity", async () => {
    const database = databaseWithResults(
      [{ routineRevisionId: "revision-one", responsibleUserId: "run-owner" }],
      [{ snapshot: { version: 1, routine: { env: { PINNED_FLAG: "original" }, responsibleUserId: "snapshot-owner" } }, responsibleUserId: "revision-owner" }],
    );
    const result = await createHeartbeatRunPreparation(database.db).getRoutineEnvForExecutionIssue(
      "company-one",
      { originKind: "routine_execution", originId: "routine-one", originRunId: "routine-run-one" },
    );
    expect(result).toEqual({ routineId: "routine-one", env: { PINNED_FLAG: "original" }, responsibleUserId: "run-owner" });
    expect(database.scopes[0]).toEqual(expect.arrayContaining(["company-one", "routine-one", "routine-run-one"]));
    expect(database.scopes[1]).toEqual(expect.arrayContaining(["company-one", "routine-one", "revision-one"]));
    expect(database.select).toHaveBeenCalledTimes(2);
  });

  it("uses the latest wake comment's author even when query rows arrive out of order", async () => {
    const database = databaseWithResults([
      { id: "comment-two", authorUserId: "latest-author" },
      { id: "comment-one", authorUserId: "older-author" },
    ]);
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["comment-one", "comment-two"],
      responsibleUserId: "previous-owner",
      executionIdentityCause: "company_default",
    };
    const owner = await createHeartbeatRunPreparation(database.db).resolveResponsibleUserIdForRunSeed({
      companyId: "company-one", contextSnapshot,
      issueContext: { id: "issue-one", responsibleUserId: "issue-owner", parentId: null },
      routineEnvContext: emptyRoutineContext,
    });
    expect(owner).toBe("latest-author");
    expect(contextSnapshot).not.toHaveProperty("executionIdentityCause");
    expect(database.scopes[0]).toEqual(expect.arrayContaining(["company-one", "issue-one"]));
    expect(database.select).toHaveBeenCalledTimes(1);
  });

  it("resolves a system wake through the same company's active owner", async () => {
    const database = databaseWithResults([{ defaultResponsibleUserId: null }], [{ userId: "company-owner" }]);
    const contextSnapshot: Record<string, unknown> = {};
    const owner = await createHeartbeatRunPreparation(database.db).resolveResponsibleUserIdForRunSeed({
      companyId: "company-one", contextSnapshot, issueContext: null,
      routineEnvContext: emptyRoutineContext, requestedByActorType: "system",
    });
    expect(owner).toBe("company-owner");
    expect(contextSnapshot.executionIdentityCause).toBe("company_default");
    expect(database.scopes[0]).toContain("company-one");
    expect(database.scopes[1]).toEqual(expect.arrayContaining(["company-one", "user", "active", "owner"]));
    expect(database.select).toHaveBeenCalledTimes(2);
  });

  it("scopes one selected-comment snapshot for both wake consumers", async () => {
    const database = databaseWithResults([{ id: "comment-one", body: "selected wake" }]);
    expect(await readHeartbeatWakeComments(database.db, "company-one", "issue-one", ["comment-one"]))
      .toEqual([{ id: "comment-one", body: "selected wake" }]);
    expect(database.scopes[0]).toEqual(expect.arrayContaining(["company-one", "issue-one", "comment-one"]));
    expect(await readHeartbeatWakeComments(database.db, "company-one", "issue-one", [])).toEqual([]);
    expect(database.select).toHaveBeenCalledOnce();
  });

  it("settles independent binding checks before surfacing a failure or resolving values", async () => {
    const projectCheck = deferred<[]>();
    const firstFailure = new Error("agent binding check failed");
    const secretsSvc = {
      resolveAdapterConfigForRuntime: vi.fn(), resolveEnvBindings: vi.fn(),
      collectMissingRuntimeBindings: vi.fn(async (_company, _env, context) => {
        if (context.consumerType === "agent") throw firstFailure;
        return context.consumerType === "project" ? projectCheck.promise : [];
      }),
      collectMissingAdapterConfigRuntimeBindings: vi.fn(async () => []),
    };
    let settled = false;
    const opening = resolveExecutionRunAdapterConfig({
      companyId: "company-one", agentId: "agent-one", projectId: "project-one",
      environmentId: "environment-one", environmentEnv: { SHARED: "environment" },
      executionRunConfig: { env: { SHARED: "agent" } }, projectEnv: { SHARED: "project" }, secretsSvc,
    });
    void opening.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(secretsSvc.collectMissingRuntimeBindings).toHaveBeenCalledTimes(3));
    expect(secretsSvc.collectMissingAdapterConfigRuntimeBindings).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(secretsSvc.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(secretsSvc.resolveEnvBindings).not.toHaveBeenCalled();
    projectCheck.resolve([]);
    await expect(opening).rejects.toBe(firstFailure);
  });

  it("keeps missing scoped credentials as a pre-dispatch failure", async () => {
    const secretsSvc = {
      resolveAdapterConfigForRuntime: vi.fn(),
      resolveEnvBindings: vi.fn(),
      collectMissingRuntimeBindings: vi.fn(),
      collectMissingAdapterConfigRuntimeBindings: vi.fn(),
    };
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-one", executionRunConfig: { env: {} }, projectEnv: null,
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN"], consumerScopes: ["agent", "project"],
        reason: "github_credentials_missing", remediation: "Configure GitHub access.",
      },
      secretsSvc,
    })).rejects.toBeInstanceOf(LegacyConfigurationIncompleteFailure);
    expect(secretsSvc.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(secretsSvc.resolveEnvBindings).not.toHaveBeenCalled();
  });
});
