import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { githubCredentialsFixture } from "./helpers/github-credentials-fixture.js";
import { createNativeGitHubAccess } from "../services/native-runtime/native-github-access.js";
import express from "express";
import request from "supertest";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from "./helpers/full-database-response-capture.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  connectionGrantDelegations,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  runIdentityContexts,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  initializeRunIdentity,
  captureRunIdentity,
} from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import {
  createGitRemoteAuthProvider,
  filterResolvedGitHubConnectionsForRun,
  resolveManagedGitHubIdentitySelection,
} from "../services/git-credentials.js";

const vault = vi.hoisted(() => ({
  installations: new Map<string, { account: { login: string }; repository_selection: "all" | "selected" }>(),
  resolveUserSecretValue: vi.fn(
    async (_company: string, input: { responsibleUserId: string }) => ({
      value: `test-token-${input.responsibleUserId}`,
    }),
  ),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));
vi.mock("../services/github-app-credentials.js", async (original) => ({
  ...await original<typeof import("../services/github-app-credentials.js")>(),
  resolveGitHubAppCredential: vi.fn(async (_db, connection) => ({ token: `app-token-${connection.id}`, expiresAt: Date.now() + 3_600_000 })),
  resolveGitHubAppInstallation: vi.fn(async (_db, connection) => vault.installations.get(connection.id)!),
}));
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_GITHUB_CREDENTIAL_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "operation-time GitHub credential resolution",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined,
      db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      vi.stubEnv(
        "PAPERCLIP_AGENT_JWT_SECRET",
        "test-github-broker-signing-secret",
      );
      if (!external) database = await startEmbeddedPostgresTestDatabase(
        "paperclip-github-operation-",
      );
      db = createDb(external ?? database!.connectionString);
    }, 30_000);
    afterAll(async () => {
      await db?.$client.end({ timeout: 1 });
      await database?.cleanup();
      vi.unstubAllEnvs();
    }, 60_000);
    const { seed, grant, switchTo } = githubCredentialsFixture(() => db);
    async function sharedApp(input: Awaited<ReturnType<typeof seed>>, repositories: string, createdAt = new Date("2026-01-01")) {
      const selected = await grant(input, "App", true);
      vault.installations.set(selected.connectionId, { account: { login: repositories.trim().split("/")[0] }, repository_selection: "all" });
      await db.update(toolConnections).set({ credentialPolicy: "shared", createdAt,
        config: { sourceTemplateKey: "github", connectionMethodKey: "app-installation", methodConfig: { repositories } },
      }).where(eq(toolConnections.id, selected.connectionId));
      await db.update(connectionGrants).set({ kind: "organization", subjectAgentId: null, providerTenant: {},
        credentialSecretRefs: [{ secretId: selected.secretId, configPath: "credentials.privateKey", versionSelector: "latest" }],
      }).where(eq(connectionGrants.id, selected.id));
      await db.update(toolConnectionInstalls).set({ targetType: "company", targetId: input.companyId })
        .where(eq(toolConnectionInstalls.connectionId, selected.connectionId));
      return selected;
    }
    it("selects the oldest connection for two company-wide shared Apps without a repository hint", async () => {
      const input = await seed();
      await sharedApp(input, "second-org/app", new Date("2026-02-01"));
      const oldest = await sharedApp(input, "example-org/app");
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, responsibleUserId: "A" }))
        .toMatchObject({ configured: true, grant: { id: oldest.id } });
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "available", grantId: oldest.id });
    });
    it("routes consecutive managed checkouts to each shared App's repository list", async () => {
      const input = await seed();
      const a = await sharedApp(input, " Example-Org/app,example-org/tools\nExample-Org/Other ");
      const b = await sharedApp(input, "second-org/app", new Date("2026-02-01"));
      for (const context of [input, { agentId: input.agentId, heartbeatRunId: input.runId, responsibleUserId: "A" }]) {
        const auth = createGitRemoteAuthProvider(db, input.companyId, context);
        expect((await auth("https://github.com/Example-Org/App.git"))?.env.GH_TOKEN).toBe(`app-token-${a.connectionId}`);
        expect((await auth("git@github.com:second-org/app.git"))?.env.GH_TOKEN).toBe(`app-token-${b.connectionId}`);
        expect((await auth("ssh://git@github.com/Example-Org/Other.git"))?.env.GH_TOKEN).toBe(`app-token-${a.connectionId}`);
      }
    });
    it("never selects another company's shared App for the same repository owner", async () => {
      const input = await seed(), other = await seed();
      const own = await sharedApp(input, "example-org/app");
      const foreign = await sharedApp(other, "second-org/app");
      expect(await resolveGitHubOperationCredentials(db, { ...input, repository: "example-org/new" }))
        .toMatchObject({ status: "available", grantId: own.id });
      const denied = await resolveGitHubOperationCredentials(db, { ...input, repository: "second-org/app" });
      expect(denied).toMatchObject({ status: "unavailable", env: {} });
      expect(denied.grantId).not.toBe(foreign.id);
      expect(await resolveGitHubOperationCredentials(db, { ...other, repository: "second-org/app" }))
        .toMatchObject({ status: "available", grantId: foreign.id });
    });
    it("fails closed naming a repository outside both shared App lists", async () => {
      const input = await seed();
      await sharedApp(input, "example-org/app");
      await sharedApp(input, "second-org/app");
      const selection = await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, repository: "elsewhere/missing" });
      expect(selection.grant).toBeUndefined();
      expect(selection.error).toBe("No managed GitHub identity is available for this run for repository elsewhere/missing");
      await expect(createGitRemoteAuthProvider(db, input.companyId, { agentId: input.agentId })("https://github.com/elsewhere/missing.git"))
        .rejects.toThrow("for repository elsewhere/missing");
    });
    it("routes runtime credential requests by repository and Git credential host/path", async () => {
      const input = await seed();
      const a = await sharedApp(input, "example-org/app");
      const b = await sharedApp(input, "second-org/app");
      const app = express();
      app.use(express.json(), runtimeConnectionIntentRoutes(db), errorHandler);
      const token = createRuntimeToolsToken({ ...input, responsibleUserId: "A", scope: "github_credentials" })!.token;
      for (const [body, selected] of [
        [{ repository: "Example-Org/App" }, a],
        [{ repository: "second-org" }, b],
        [{ protocol: "https", host: "github.com", path: "second-org/app.git" }, b],
      ] as const) {
        const response = await request(app).post("/runtime-tools/github/credentials").set("Authorization", `Bearer ${token}`).send(body);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: "available", grantId: selected.id, env: { GH_TOKEN: `app-token-${selected.connectionId}` } });
      }
      const missing = await request(app).post("/runtime-tools/github/credentials").set("Authorization", `Bearer ${token}`).send({ repository: "other/missing" });
      expect(missing.body).toMatchObject({ status: "unavailable", env: {}, reason: expect.stringContaining("for repository other/missing") });
    });
    it.each([false, true])("routes real gh and git launchers through the native broker to each shared App (sandbox bridge: %s)", async remote => {
      const input = await seed();
      const a = await sharedApp(input, "example-org/app");
      const b = await sharedApp(input, "second-org/app", new Date("2026-02-01"));
      const directory = await mkdtemp(join(tmpdir(), "github-app-launcher-"));
      const printToken = `#!${process.execPath}\nprocess.stdout.write(process.env.GH_TOKEN || '');\n`;
      await promisify(execFile)("git", ["init", "-q", directory]);
      await promisify(execFile)("git", ["-C", directory, "remote", "add", "origin", "https://github.com/example-org/app.git"]);
      await writeFile(join(directory, "gh"), printToken, { mode: 0o700 });
      await writeFile(join(directory, "git"), `#!${process.execPath}
if (process.argv.includes('credential') || process.argv.includes('get-url')) {
  const result = require('node:child_process').spawnSync('/usr/bin/git', process.argv.slice(2), { env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
process.stdout.write(process.env.GH_TOKEN || '');
`, { mode: 0o700 });
      const target = remote ? { kind: "remote" as const, transport: "sandbox" as const, providerKey: "test", remoteCwd: directory,
        runner: { execute: async (command: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string }) => {
          const startedAt = new Date().toISOString();
          const child = promisify(execFile)(command.command, command.args ?? [], {
            cwd: command.cwd ?? directory, env: { ...process.env, ...command.env }, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
          });
          child.child.stdin?.on("error", () => undefined);
          child.child.stdin?.end(command.stdin ?? "");
          return { ...await child, startedAt, exitCode: 0, signal: null, timedOut: false, pid: null };
        } }, streamRunLogs: false } : null;
      const broker = await createNativeGitHubAccess({
        scope: input, target, cwd: directory, env: { PATH: `${directory}:${process.env.PATH}` },
        resolveCredentials: binding => resolveGitHubOperationCredentials(db, binding),
      });
      const release = broker.activate(input);
      try {
        for (const [program, args, selected] of [
          ["gh", ["repo", "view", "second-org/x", "--json", "name"], b],
          ["gh", ["pr", "list", "-R", "example-org/y"], a],
          ["gh", ["api", "repos/second-org/app/pulls"], b],
          ["gh", ["api", "repos/{owner}/{repo}/pulls"], b],
          ["gh", ["pr", "view", "https://github.com/second-org/app/pull/42"], b],
          ["gh", ["api", "https://api.github.com/repos/second-org/app/pulls"], b],
          ["gh", ["api", "https://api.github.com:443/repos/second-org/app"], b],
          ["gh", ["api", "orgs/second-org/repos"], b],
          ["gh", ["api", "users/second-org/repos"], b],
          ["gh", ["repo", "clone", "--", "second-org/app"], b],
          ["gh", ["pr", "list", "--repo=example-org/app"], a],
          ["git", ["clone", "git@github.com:second-org/app.git"], b],
          ["git", ["clone", "https://github.com:443/second-org/app.git"], b],
        ] as const) {
          const { stdout } = await promisify(execFile)(program, [...args], { cwd: directory, env: { ...process.env, ...broker.env,
            GH_REPO: args[0] === "repo" ? "example-org/app" : "second-org/app" } });
          expect(stdout, `${program} ${args.join(" ")}`).toBe(`app-token-${selected.connectionId}`);
        }
        const unmatched = await promisify(execFile)("gh", ["repo", "view", "unmatched-org/x", "--json", "name"], {
          cwd: directory, env: { ...process.env, ...broker.env },
        });
        expect(unmatched.stdout).toBe("");
        expect(unmatched.stderr).toContain("for repository unmatched-org/x");
        await expect(promisify(execFile)("gh", ["api", "https://api.github.com:443/graphql", "-f", 'query={repository(owner:"second-org",name:"app"){name}}'], {
          cwd: directory, env: { ...process.env, ...broker.env },
        })).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("repository_target_required") });
        // Real Git, the native broker, company-scoped selection and the server helper.
        for (const [requestedPath, selected] of [["example-org/app.git", a], ["second-org/new.git", b]] as const) {
          const result = await new Promise<{ error: Error | null; stdout: string }>(resolve => {
            const child = execFile("git", ["credential", "fill"], { cwd: directory, env: { ...process.env, ...broker.env }, timeout: 5000 }, (error, stdout) => resolve({ error, stdout }));
            child.stdin!.end(`protocol=https\nhost=github.com\npath=${requestedPath}\n\n`);
          });
          expect(result.error).toBeNull();
          expect(result.stdout).toContain(`password=app-token-${selected.connectionId}`);
        }
      } finally { release(); await broker.stop(); await rm(directory, { recursive: true, force: true }); }
    }, 30_000);
    it("breaks equal App connection ages by connection id but retains duplicate-grant ambiguity", async () => {
      const input = await seed();
      const a = await sharedApp(input, "example-org/app");
      const b = await sharedApp(input, "second-org/app");
      const expected = a.connectionId.localeCompare(b.connectionId) < 0 ? a : b;
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId }))
        .toMatchObject({ grant: { id: expected.id } });
      const [original] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, a.id));
      await db.insert(connectionGrants).values({ ...original, id: randomUUID() });
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId }))
        .toMatchObject({ error: "More than one managed GitHub identity matches this run" });
    });
    it.each(["personal", "dedicated", "delegated", "shared"])("ignores disabled or inactive %s connections before selection", async kind => {
      const input = await seed();
      const disabled = kind === "shared" ? await sharedApp(input, "disabled-org/app") : await grant(input, "A", kind === "dedicated");
      const working = await sharedApp(input, "example-org/app", new Date("2026-02-01"));
      if (kind === "delegated") await db.insert(connectionGrantDelegations).values({
        companyId: input.companyId, agentId: input.agentId, grantId: disabled.id, createdByUserId: "A",
      });
      for (const state of [{ enabled: false, status: "active" }, { enabled: true, status: "draft" }] as const) {
        await db.update(toolConnections).set(state).where(eq(toolConnections.id, disabled.connectionId));
        const context = { agentId: input.agentId, responsibleUserId: kind === "delegated" ? null : "A" };
        expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, context)).toMatchObject({ grant: { id: working.id } });
        if (kind !== "delegated") expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "available", grantId: working.id });
      }
    });
    it.each(["app", "no-app", "no-dedicated"] as const)("keeps a disabled dedicated identity off personal credentials (%s)", async mode => {
      const input = await seed();
      const personal = await grant(input, "A");
      const dedicated = mode !== "no-dedicated" ? await grant(input, "robot", true) : null;
      const app = mode !== "no-app" ? await sharedApp(input, "example-org/app") : null;
      for (const state of [{ enabled: false, status: "active" }, { enabled: true, status: "draft" }] as const) {
        if (dedicated) await db.update(toolConnections).set(state).where(eq(toolConnections.id, dedicated.connectionId));
        const selection = await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, responsibleUserId: "A" });
        const credentials = await resolveGitHubOperationCredentials(db, input);
        const auth = createGitRemoteAuthProvider(db, input.companyId, { agentId: input.agentId, responsibleUserId: "A" });
        if (mode === "no-app") {
          expect(selection).toMatchObject({ configured: true, error: "No managed GitHub identity is available for this run" });
          expect(selection.grant).toBeUndefined();
          expect(credentials).toMatchObject({ status: "unavailable", env: {} });
          await expect(auth("https://github.com/example-org/app.git")).rejects.toThrow("No managed GitHub identity");
        } else {
          const selected = dedicated ? app! : personal;
          const token = dedicated ? `app-token-${app!.connectionId}` : "test-token-A";
          expect(selection).toMatchObject({ grant: { id: selected.id } });
          expect(credentials).toMatchObject({ status: "available", grantId: selected.id, env: { GH_TOKEN: token } });
          expect((await auth("https://github.com/example-org/app.git"))?.env.GH_TOKEN).toBe(token);
        }
      }
    });
    it("does not fall through to legacy tokens when every installed connection is disabled", async () => {
      const input = await seed();
      const personal = await grant(input, "A");
      await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, personal.connectionId));
      const auth = createGitRemoteAuthProvider(db, input.companyId, { agentId: input.agentId, responsibleUserId: "A" }, {
        env: { GH_TOKEN: "legacy-must-not-be-used" },
        secrets: { getByName: async () => null, resolveSecretValue: vault.resolveSecretValue },
      });
      await expect(auth("https://github.com/example-org/app.git")).rejects.toThrow(/managed GitHub/i);
    });
    it("routes a new repository by installation account, preferring saved matches within that owner", async () => {
      const input = await seed();
      await sharedApp(input, "example-org/app");
      const b = await sharedApp(input, "second-org/app", new Date("2026-02-01"));
      const sameOwner = await sharedApp(input, "second-org/tools", new Date("2026-03-01"));
      for (const [repository, expected] of [["second-org/new-repo", b], ["second-org/tools", sameOwner]] as const) {
        expect(await resolveGitHubOperationCredentials(db, { ...input, repository })).toMatchObject({ status: "available", grantId: expected.id });
      }
      expect((await createGitRemoteAuthProvider(db, input.companyId, { agentId: input.agentId })("https://github.com:443/second-org/new-repo.git"))?.env.GH_TOKEN)
        .toBe(`app-token-${b.connectionId}`);
    });
    it("uses the installation account as owner authority and keeps selected installations repo-scoped", async () => {
      const input = await seed();
      const selected = await sharedApp(input, "example-org/saved");
      vault.installations.set(selected.connectionId, { account: { login: "actual-org" }, repository_selection: "all" });
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, repository: "actual-org/new" }))
        .toMatchObject({ grant: { id: selected.id } });
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, repository: "example-org/saved" }))
        .toMatchObject({ error: expect.stringContaining("example-org/saved") });
      vault.installations.set(selected.connectionId, { account: { login: "example-org" }, repository_selection: "selected" });
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, repository: "example-org/saved" }))
        .toMatchObject({ grant: { id: selected.id } });
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, repository: "example-org/new" }))
        .toMatchObject({ error: expect.stringContaining("example-org/new") });
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, repository: "example-org" }))
        .toMatchObject({ grant: { id: selected.id } });
    });
    it("preserves single App selection and personal priority over shared Apps", async () => {
      const input = await seed();
      const app = await sharedApp(input, "example-org/app");
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId }))
        .toMatchObject({ grant: { id: app.id } });
      const personal = await grant(input, "A");
      await sharedApp(input, "second-org/app");
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, responsibleUserId: "A", repository: "second-org/app" }))
        .toMatchObject({ identitySource: "personal", grant: { id: personal.id } });
    });
    it.each(["config", "transportConfig"] as const)("reads only current GitHub identity connections via %s", async location => {
      const input = await seed(), selected = await grant(input, "A");
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, selected.connectionId));
      await db.update(toolConnections).set({ config: {}, transportConfig: {}, [location]: { sourceTemplateKey: "github" } })
        .where(eq(toolConnections.id, selected.connectionId));
      const payload = "unrelated-connection-config🙂".repeat(10_000);
      const irrelevant = [null, true, 42, ["github"], { name: "github" }, "GitHub", " github ", "other"].map(sourceTemplateKey => {
        const id = randomUUID();
        return { id, companyId: input.companyId, applicationId: connection.applicationId, name: id, uid: id,
          transport: "mcp_remote" as const, config: { sourceTemplateKey, payload }, transportConfig: { sourceTemplateKey } };
      });
      await db.insert(toolConnections).values(irrelevant);
      const observed = createDb(external ?? database!.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
      const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
      installDatabaseResponseCapture(observed, { toolConnections }, capture);
      try {
        expect(await resolveManagedGitHubIdentitySelection(observed, input.companyId, { agentId: input.agentId, responsibleUserId: "A" }))
          .toMatchObject({ configured: true, grant: { id: selected.id } });
        capture.flush();
        const reads = events.filter(event => event.table === "tool_connections" && event.operation === "select");
        expect(reads).toHaveLength(1);
        expect(reads[0].rows).toBe(1);
        expect(reads[0].responseValueBytes).toBeLessThan(8192);
        await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, selected.connectionId));
        expect((await resolveManagedGitHubIdentitySelection(observed, input.companyId, { agentId: input.agentId, responsibleUserId: "A" })).grant)
          .toBeUndefined();
        await db.update(toolConnections).set({ [location]: { sourceTemplateKey: "other" } }).where(eq(toolConnections.id, selected.connectionId));
        expect(await resolveManagedGitHubIdentitySelection(observed, input.companyId, { agentId: input.agentId, responsibleUserId: "A" }))
          .toEqual({ configured: false });
        expect(await resolveManagedGitHubIdentitySelection(observed, randomUUID(), { agentId: input.agentId, responsibleUserId: "A" }))
          .toEqual({ configured: false });
        const saved = await db.select().from(toolConnections).where(eq(toolConnections.companyId, input.companyId));
        for (const row of irrelevant) expect(saved.find(candidate => candidate.id === row.id)?.config).toEqual(row.config);
      } finally { capture.flush(); await observed.$client.end(); }
    });

    it("resolves current GitHub credentials without transferring execution snapshots", async () => {
      const input = await seed(), selected = await grant(input, "A");
      const payload = "github-credential-saved-input🙂".repeat(25_000);
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: input.issueId, prompt: payload },
        runnerProfileJson: { nativeExecutionInput: { savedInput: payload }, savedInput: payload },
        resultJson: { stdout: payload }, stdoutExcerpt: payload, stderrExcerpt: payload,
      }).where(eq(heartbeatRuns.id, input.runId));
      const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
      const observed = createDb(external ?? database!.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
      const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
      installDatabaseResponseCapture(observed, { heartbeatRuns }, capture);
      try {
        expect(await resolveGitHubOperationCredentials(observed, input)).toMatchObject({
          status: "available", login: "A", grantId: selected.id,
        });
        capture.flush();
        const reads = events.filter(event => event.table === "heartbeat_runs" && event.operation === "select");
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(8192);
        expect(JSON.stringify(events)).not.toContain("github-credential-saved-input");
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)))[0]).toEqual(before);
        const full = await captureRunIdentity(observed, input);
        expect(full.run.runnerProfileJson).toEqual(before.runnerProfileJson);
        expect(full.run.resultJson).toEqual(before.resultJson);
        expect(full.run.contextSnapshot).toEqual(before.contextSnapshot);
        await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, selected.id));
        expect(await resolveGitHubOperationCredentials(observed, input)).toMatchObject({ status: "unavailable" });
      } finally { capture.flush(); await observed.$client.end(); }
    });

    it("resolves A → B → A without retaining tokens, and records only redacted diagnostics", async () => {
      const input = await seed();
      await grant(input, "A");
      await grant(input, "B");
      for (const user of ["A", "B", "A"]) {
        await switchTo(input, user);
        const result = await resolveGitHubOperationCredentials(db, input);
        expect(result).toMatchObject({
          status: "available",
          login: user,
          source: "personal",
        });
        expect(result.env.GH_TOKEN).toBe(`test-token-${user}`);
        expect(result.env.GIT_AUTHOR_EMAIL).toBe(
          `${user}+${user}@users.noreply.github.com`,
        );
      }
      const history = await db
        .select()
        .from(runIdentityContexts)
        .where(eq(runIdentityContexts.runId, input.runId));
      expect(JSON.stringify(history)).not.toContain("test-token-");
    });
    it("writes the GitHub summary only when it changes", async () => {
      const input = await seed();
      const selected = await grant(input, "A");
      const update = vi.spyOn(db, "update");
      const summaryWrites = () => update.mock.calls.filter(([table]) => table === runIdentityContexts).length;
      const stored = async () => (await db.select().from(runIdentityContexts)
        .where(eq(runIdentityContexts.runId, input.runId)))[0].github;
      try {
        expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "available", grantId: selected.id });
        expect(summaryWrites()).toBe(1);
        expect(await stored()).toMatchObject({ status: "available", login: "A", grantId: selected.id });
        for (let call = 0; call < 3; call++) {
          expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "available", grantId: selected.id });
        }
        expect(summaryWrites()).toBe(1);
        await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, selected.id));
        for (let call = 0; call < 2; call++) {
          expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "unavailable" });
        }
        expect(summaryWrites()).toBe(2);
        expect(await stored()).toMatchObject({ status: "unavailable" });
        await db.update(issues).set({ executionPolicy: { authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET,
          trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: input.companyId, rootIssueId: input.issueId,
            issueIds: [input.issueId], allowedAgentIds: [input.agentId], allowedToolClasses: ["git.read", "github.pr.read"] } } } })
          .where(eq(issues.id, input.issueId));
        for (let call = 0; call < 2; call++) {
          expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
            status: "unavailable", reason: expect.stringContaining("low-trust"),
          });
        }
        expect(summaryWrites()).toBe(3);
        expect(await stored()).toMatchObject({ status: "unavailable", reason: expect.stringContaining("low-trust") });
      } finally {
        update.mockRestore();
      }
    });
    it("returns no credential for unconnected users, removed membership, or ambiguous personal accounts", async () => {
      const input = await seed();
      await grant(input, "A");
      await switchTo(input, "B");
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
      await switchTo(input, "A");
      await db
        .update(companyMemberships)
        .set({ status: "inactive" })
        .where(eq(companyMemberships.companyId, input.companyId));
      expect((await resolveGitHubOperationCredentials(db, input)).status).toBe(
        "unavailable",
      );
      await db
        .update(companyMemberships)
        .set({ status: "active" })
        .where(eq(companyMemberships.companyId, input.companyId));
      const differentAccount = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({
          providerTenant: {
            github: {
              userId: "other-github-id",
              login: "A",
              installationCount: 1,
              repositoryCount: 1,
              repositorySelection: "selected",
              installationIds: ["1"],
              installationOwnerLogins: ["A"],
            },
          },
        })
        .where(eq(connectionGrants.id, differentAccount.id));
      expect(
        (await resolveGitHubOperationCredentials(db, input)).reason,
      ).toMatch(/More than one/);
      await expect(
        resolveGitHubOperationCredentials(db, {
          ...input,
          companyId: randomUUID(),
        }),
      ).rejects.toThrow();
    });
    it.each([true, false])(
      "prefers the healthy duplicate regardless of grant age (%s)",
      async (healthyNewer) => {
        const input = await seed();
        const healthy = await grant(input, "A");
        const broken = await grant(input, "A");
        await db
          .update(toolConnections)
          .set({ healthStatus: "ok" })
          .where(eq(toolConnections.id, healthy.connectionId));
        await db
          .update(toolConnections)
          .set({
            healthStatus: "error",
            healthMessage: "GitHub access changed during refresh. Try again.",
          })
          .where(eq(toolConnections.id, broken.connectionId));
        await db
          .update(connectionGrants)
          .set({
            createdAt: new Date(healthyNewer ? "2026-02-01" : "2026-01-01"),
          })
          .where(eq(connectionGrants.id, healthy.id));
        await db
          .update(connectionGrants)
          .set({
            createdAt: new Date(healthyNewer ? "2026-01-01" : "2026-02-01"),
          })
          .where(eq(connectionGrants.id, broken.id));
        expect(
          await resolveGitHubOperationCredentials(db, input),
        ).toMatchObject({
          status: "available",
          connectionId: healthy.connectionId,
          grantId: healthy.id,
          authenticationMode: "managed",
        });
      },
    );

    it("retries credential acquisition once using another grant for the same account", async () => {
      const input = await seed();
      const older = await grant(input, "A");
      const newer = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-01-01") })
        .where(eq(connectionGrants.id, older.id));
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-02-01") })
        .where(eq(connectionGrants.id, newer.id));
      vault.resolveUserSecretValue.mockRejectedValueOnce(
        new Error("secret provider failed"),
      );
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        grantId: older.id,
      });
    });

    it("uses one stable grant when the same person connects the same GitHub account twice", async () => {
      const input = await seed();
      const first = await grant(input, "A");
      const second = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2027-01-01"),
        })
        .where(eq(connectionGrants.id, first.id));
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-02-01") })
        .where(eq(connectionGrants.id, second.id));
      const context = { ...input, responsibleUserId: "A" };
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(second.id);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        login: "A",
        source: "personal",
      });
      const connections = [first, second].map((row) => ({
        id: row.connectionId,
        config: { sourceTemplateKey: "github" },
      }));
      expect(
        await filterResolvedGitHubConnectionsForRun({
          db,
          ...context,
          connections,
        }),
      ).toEqual([connections[1]]);
      // A newer webhook on the old connection must not change the selected policy.
      await db
        .update(connectionGrants)
        .set({ updatedAt: new Date("2028-01-01") })
        .where(eq(connectionGrants.id, first.id));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(second.id);
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, second.id));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(first.id);
      await db
        .update(toolConnections)
        .set({ enabled: false })
        .where(eq(toolConnections.id, first.connectionId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
    });
    it("does not conflate missing GitHub account IDs or another agent's connection audience", async () => {
      const input = await seed();
      const first = await grant(input, "A");
      const duplicate = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({ providerTenant: null })
        .where(eq(connectionGrants.id, duplicate.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
      await db
        .update(toolConnectionInstalls)
        .set({ targetId: randomUUID() })
        .where(eq(toolConnectionInstalls.connectionId, duplicate.connectionId));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(db, input.companyId, {
            ...input,
            responsibleUserId: "A",
          })
        ).grant?.id,
      ).toBe(first.id);
      await switchTo(input, "B");
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
    });
    it.each([
      "missing-ref",
      "disabled-secret",
      "missing-secret",
      "wrong-owner",
      "disabled-definition",
      "no-repositories",
    ])(
      "ignores an incomplete newer duplicate when the same account has an eligible grant (%s)",
      async (problem) => {
        const input = await seed();
        const first = await grant(input, "A");
        const second = await grant(input, "A");
        await db
          .update(connectionGrants)
          .set({ createdAt: new Date("2026-01-01") })
          .where(eq(connectionGrants.id, first.id));
        await db
          .update(connectionGrants)
          .set({ createdAt: new Date("2026-02-01") })
          .where(eq(connectionGrants.id, second.id));
        if (problem === "missing-ref")
          await db
            .update(connectionGrants)
            .set({ credentialSecretRefs: [] })
            .where(eq(connectionGrants.id, second.id));
        if (problem === "disabled-secret")
          await db
            .update(companySecrets)
            .set({ status: "disabled" })
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "disabled-definition")
          await db
            .update(userSecretDefinitions)
            .set({ status: "disabled" })
            .where(eq(userSecretDefinitions.id, second.definitionId));
        if (problem === "missing-secret")
          await db
            .delete(companySecrets)
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "wrong-owner")
          await db
            .update(companySecrets)
            .set({ ownerUserId: "B" })
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "no-repositories")
          await db
            .update(connectionGrants)
            .set({
              providerTenant: {
                github: {
                  userId: "A",
                  login: "A",
                  installationCount: 0,
                  repositoryCount: 0,
                  repositorySelection: "none",
                  installationIds: [],
                  installationOwnerLogins: [],
                },
              },
            })
            .where(eq(connectionGrants.id, second.id));
        expect(
          (
            await resolveManagedGitHubIdentitySelection(db, input.companyId, {
              ...input,
              responsibleUserId: "A",
            })
          ).grant?.id,
        ).toBe(first.id);
        expect(
          await resolveGitHubOperationCredentials(db, input),
        ).toMatchObject({ status: "available", login: "A" });
        const connections = [first, second].map((row) => ({
          id: row.connectionId,
          config: { sourceTemplateKey: "github" },
        }));
        expect(
          await filterResolvedGitHubConnectionsForRun({
            db,
            ...input,
            responsibleUserId: "A",
            connections,
          }),
        ).toEqual([connections[0]]);
      },
    );
    it("retains dedicated override semantics when the dedicated account has duplicate grants", async () => {
      const input = await seed();
      await grant(input, "A");
      const first = await grant(input, "robot", true);
      const second = await grant(input, "robot", true);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, first.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, second.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        source: "dedicated",
        env: {},
      });
    });
    it("honors dedicated overrides and revoked grants, and never falls back to a person when disabled", async () => {
      const input = await seed();
      await grant(input, "A");
      const dedicated = await grant(input, "robot", true);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, dedicated.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        source: "dedicated",
        env: {},
      });
      await db
        .update(connectionGrants)
        .set({ status: "active" })
        .where(eq(connectionGrants.id, dedicated.id));
      await db
        .update(toolConnections)
        .set({ enabled: false })
        .where(eq(toolConnections.id, dedicated.connectionId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
    });
    it("does not resolve the company default person's GitHub", async () => {
      const input = await seed();
      await grant(input, "A");
      await db
        .update(runIdentityContexts)
        .set({ cause: "company_default" })
        .where(eq(runIdentityContexts.runId, input.runId));
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
    });
    it.each([false, true])(
      "withholds sponsor and dedicated credentials from every low-trust policy source (dedicated=%s)",
      async (dedicated) => {
        for (const source of [
          "issue",
          "run",
          "agent",
          "project",
          "quarantined",
          "invalid",
          "missing_issue",
        ] as const) {
          const input = await seed();
          await grant(input, "A");
          if (dedicated) await grant(input, "robot", true);
          // Sponsor attribution is deliberately retained: it must not become a
          // credential grant just because the shared agent was dispatched for them.
          await db
            .update(issues)
            .set({
              originKind: "chat_channel",
              responsibleUserId: "A",
              createdByUserId: "A",
            })
            .where(eq(issues.id, input.issueId));
          const policy = {
            authorizationPolicy: {
              trustPreset: LOW_TRUST_REVIEW_PRESET,
              trustBoundary: {
                mode: LOW_TRUST_REVIEW_PRESET,
                companyId: input.companyId,
                rootIssueId: input.issueId,
                issueIds: [input.issueId],
                allowedAgentIds: [input.agentId],
                allowedToolClasses: ["git.read", "github.pr.read"],
              },
            },
          };
          if (source === "issue")
            await db
              .update(issues)
              .set({ executionPolicy: policy })
              .where(eq(issues.id, input.issueId));
          if (source === "run")
            await db
              .update(heartbeatRuns)
              .set({
                contextSnapshot: {
                  issueId: input.issueId,
                  executionPolicy: policy,
                },
              })
              .where(eq(heartbeatRuns.id, input.runId));
          if (source === "agent")
            await db
              .update(agents)
              .set({ permissions: policy })
              .where(eq(agents.id, input.agentId));
          if (source === "project") {
            const projectId = randomUUID();
            await db.insert(projects).values({
              id: projectId,
              companyId: input.companyId,
              name: "Restricted",
              executionWorkspacePolicy: policy,
            });
            await db
              .update(issues)
              .set({ projectId })
              .where(eq(issues.id, input.issueId));
          }
          if (source === "quarantined")
            await db
              .update(issues)
              .set({
                sourceTrust: {
                  preset: LOW_TRUST_REVIEW_PRESET,
                  disposition: "quarantined",
                  sourceIssueId: input.issueId,
                },
              })
              .where(eq(issues.id, input.issueId));
          if (source === "invalid")
            await db
              .update(heartbeatRuns)
              .set({
                contextSnapshot: {
                  issueId: input.issueId,
                  executionPolicy: {
                    authorizationPolicy: { trustPreset: "unknown" },
                  },
                },
              })
              .where(eq(heartbeatRuns.id, input.runId));
          if (source === "missing_issue")
            await db
              .update(heartbeatRuns)
              .set({ contextSnapshot: { issueId: randomUUID() } })
              .where(eq(heartbeatRuns.id, input.runId));
          vault.resolveSecretValue.mockClear();
          vault.resolveUserSecretValue.mockClear();
          expect(
            await resolveGitHubOperationCredentials(db, input),
            source,
          ).toMatchObject({
            status: "unavailable",
            env: {},
            reason: expect.stringContaining("low-trust"),
          });
          expect(vault.resolveSecretValue, source).not.toHaveBeenCalled();
          expect(vault.resolveUserSecretValue, source).not.toHaveBeenCalled();
          const [history] = await db
            .select()
            .from(runIdentityContexts)
            .where(eq(runIdentityContexts.runId, input.runId));
          expect(history.github, source).toMatchObject({
            status: "unavailable",
          });
          expect(JSON.stringify(history), source).not.toContain("test-token-");
        }
      },
    );
    it("rechecks a taskless run's current project policy before exporting credentials", async () => {
      const input = await seed();
      await grant(input, "A");
      const projectId = randomUUID();
      await db.insert(projects).values({
        id: projectId,
        companyId: input.companyId,
        name: "Taskless project",
      });
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { projectId } })
        .where(eq(heartbeatRuns.id, input.runId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        login: "A",
      });
      await db
        .update(projects)
        .set({
          executionWorkspacePolicy: {
            authorizationPolicy: {
              trustPreset: LOW_TRUST_REVIEW_PRESET,
              trustBoundary: {
                mode: LOW_TRUST_REVIEW_PRESET,
                companyId: input.companyId,
                projectIds: [projectId],
                allowedAgentIds: [input.agentId],
              },
            },
          },
        })
        .where(eq(projects.id, projectId));
      vault.resolveSecretValue.mockClear();
      vault.resolveUserSecretValue.mockClear();
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
      expect(vault.resolveSecretValue).not.toHaveBeenCalled();
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });

    it("fails closed for missing or malformed bound task/project references", async () => {
      const input = await seed();
      await grant(input, "A");
      for (const contextSnapshot of [
        { projectId: randomUUID() },
        { projectId: "" },
        { projectId: false },
        { issueId: "" },
        { issueId: false },
      ]) {
        await db
          .update(heartbeatRuns)
          .set({ contextSnapshot })
          .where(eq(heartbeatRuns.id, input.runId));
        vault.resolveUserSecretValue.mockClear();
        if (Object.hasOwn(contextSnapshot, "issueId")) {
          await expect(
            resolveGitHubOperationCredentials(db, input),
          ).rejects.toMatchObject({
            status: 403,
            message: "Run task identity is invalid",
          });
        } else {
          expect(
            await resolveGitHubOperationCredentials(db, input),
          ).toMatchObject({ status: "unavailable", env: {} });
        }
        expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
      }
    });

    it("reuses a session broker across runs while rechecking live-run identity and revocation", async () => {
      const input = await seed();
      await grant(input, "A");
      await grant(input, "B");
      const broker = await createNativeGitHubAccess({
        scope: input, target: null, cwd: process.cwd(), env: { PATH: process.env.PATH },
        resolveCredentials: (binding) => resolveGitHubOperationCredentials(db, binding),
      });
      const post = () => fetch(`${broker.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/credentials`, {
        method: "POST", headers: { authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}` },
      });
      try {
        const releaseA = broker.activate(input);
        const a = await post();
        expect(a.status).toBe(200);
        expect((await a.json()).login).toBe("A");
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));
        // Even a delayed controller release cannot authorize a finished DB run.
        expect((await post()).status).toBe(403);
        releaseA();
        const next = { ...input, runId: randomUUID() };
        await db.insert(heartbeatRuns).values({ id: next.runId, companyId: next.companyId, agentId: next.agentId, status: "running", contextSnapshot: { issueId: input.issueId } });
        await initializeRunIdentity(db, { companyId: input.companyId, runId: next.runId, responsibleUserId: "B", cause: "instruction" });
        broker.activate(next);
        const b = await post();
        expect(b.status).toBe(200);
        expect((await b.json()).login).toBe("B");
        await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.companyId, input.companyId));
        const revoked = await post();
        expect((await revoked.json()).env).toEqual({});
      } finally { await broker.stop(); }
    });

    it("requires a run-scoped runtime capability and never accepts browser authentication or supplied identities", async () => {
      const input = await seed();
      await grant(input, "A");
      const app = express();
      app.use(express.json());
      app.use(runtimeConnectionIntentRoutes(db));
      app.use(errorHandler);
      const tokenInput = {
        ...input,
        responsibleUserId: "A",
        scope: "github_credentials" as const,
      };
      const token = createRuntimeToolsToken(tokenInput)!.token;
      const post = () => request(app).post("/runtime-tools/github/credentials");
      const a = await post()
        .set("Authorization", `Bearer ${token}`)
        .send({ responsibleUserId: "B" });
      expect(
        (
          await post()
            .set("Authorization", `Bearer ${token}`)
            .set("Sec-Fetch-Mode", "cors")
        ).status,
      ).toBe(200);
      expect(a.status).toBe(200);
      expect(a.body.login).toBe("A");
      expect(a.headers["cache-control"]).toBe("no-store");
      for (const [header, value] of [
        ["Origin", "http://127.0.0.1"],
        ["Cookie", "session=test"],
        ["Sec-Fetch-Site", "same-origin"],
      ]) {
        expect(
          (
            await post()
              .set("Authorization", `Bearer ${token}`)
              .set(header!, value!)
          ).status,
        ).toBe(403);
      }
      const wrongScope = createRuntimeToolsToken({
        ...tokenInput,
        scope: "connection_intents",
      })!.token;
      expect(
        (await post().set("Authorization", `Bearer ${wrongScope}`)).status,
      ).toBe(401);
      const wrongAgent = createRuntimeToolsToken({
        ...tokenInput,
        agentId: randomUUID(),
      })!.token;
      expect(
        (await post().set("Authorization", `Bearer ${wrongAgent}`)).status,
      ).toBe(403);
      // The runner bridge replaces Authorization, but forwards the separate run capability.
      expect(
        (
          await post()
            .set("Authorization", "Bearer bridge-host-token")
            .set("x-paperclip-github-capability", token)
        ).status,
      ).toBe(200);
      await switchTo(input, "B");
      const b = await post().set("Authorization", `Bearer ${token}`);
      expect(b.status).toBe(200);
      expect(b.body.env).toEqual({});
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, input.runId));
      expect(
        (await post().set("Authorization", `Bearer ${token}`)).status,
      ).toBe(403);
    });
  },
);
