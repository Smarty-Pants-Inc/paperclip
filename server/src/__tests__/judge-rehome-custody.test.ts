import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, applyPendingMigrations, companies, createDb, executionWorkspaceRestorePoints, executionWorkspaces, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "../services/managed-repository-checkout.js";
import { isolatedRemoteSourcePath, materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { expireReconstructableGitWorkspace } from "../services/git-workspace-expiration.js";
import { captureRestorePoint, currentRestorePointSnapshot } from "../services/git-restore-point.js";
import { rehomeIsolatedRepositoryWorkspace, sweepOrphanedIsolatedRepositorySources } from "../services/isolated-repository-rehome.js";
import { addNestedRepositoryWorktree, nestedRepositoryBaseCandidates, nestedWorktreeBranchPrefix, readLinkedNestedCheckout } from "../services/nested-repository-worktrees.js";
import { getStorageService } from "../storage/index.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);
const DAY_MS = 24 * 60 * 60 * 1000;

import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISOLATED_REHOME_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("isolated repository source re-home", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else database = await startEmbeddedPostgresTestDatabase("isolated-repository-rehome-");
    db = createDb(external ?? database!.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-rehome-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "41".repeat(32));
  });
  afterEach(async () => {
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await fs.rm(path.join(root, "home", "instances", "default", "isolated-repository-sources"), { recursive: true, force: true });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database?.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  async function fixture(options: { sharedBase?: boolean; issueStatus?: "in_progress" | "done" } = {}) {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
    const location = path.join(root, companyId), author = path.join(location, "author"), remote = path.join(location, "remote.git");
    await fs.mkdir(author, { recursive: true });
    git(author, "init", "--initial-branch=main");
    await fs.writeFile(path.join(author, "marker.txt"), "commit A\n");
    await fs.writeFile(path.join(author, "remove-me.txt"), "tracked\n");
    await fs.writeFile(path.join(author, ".gitignore"), "node_modules/\n.env\n.claude/settings.local.json\n*.tsbuildinfo\n");
    git(author, "add", "."); git(author, "commit", "-m", "A");
    git(location, "clone", "--bare", author, remote);
    const done = options.issueStatus === "done";
    await db.insert(companies).values({ id: companyId, name: "Re-home fixture", issuePrefix: `RH${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture project" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Open task", status: done ? "done" : "in_progress",
      ...(done ? { completedAt: new Date(Date.now() - 4 * DAY_MS) } : {}) });
    const repoUrl = pathToFileURL(remote).href;
    const sharedPath = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: "remote" });
    if (options.sharedBase !== false) await materializeManagedProjectWorkspace(sharedPath, { repoUrl });
    const clone = await materializeIsolatedRemoteWorkspaceSource({ companyId, issueId, repoUrl, resolveGitAuth: async () => null });
    const realized = await realizeExecutionWorkspace({ base: { baseCwd: clone, source: "task_session", projectId: null, workspaceId: null, repoUrl, repoRef: "origin/main" },
      issue: { id: issueId, identifier: "RH-1", title: "Fixture" }, agent: { id: null, name: "Fixture", companyId },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "fixture-task", baseRef: "origin/main" } }, skipHostProvision: true });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree",
      name: "Fixture", status: "active", providerType: "local_fs", cwd: realized.cwd, providerRef: realized.cwd, repoUrl, baseRef: "origin/main",
      branchName: realized.branchName, metadata: { createdByRuntime: realized.branchCreatedByRuntime, gitBranchOwnershipVersion: 1, baseRefSha: realized.baseRefSha,
        isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId, issueId, repoUrl } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    const row = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    const target = path.join(await fs.realpath(root), path.relative(root, sharedPath), ".paperclip", "worktrees", "fixture-task");
    return { companyId, issueId, workspaceId, projectId, cwd: realized.cwd, clone, sharedPath, target, repoUrl, remote, author, row };
  }

  async function makeWork(cwd: string) {
    await fs.writeFile(path.join(cwd, "marker.txt"), "commit B (unpushed)\n");
    git(cwd, "commit", "-am", "B unpushed");
    const unpushed = git(cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(cwd, "marker.txt"), "staged edit\n");
    git(cwd, "add", "marker.txt");
    await fs.writeFile(path.join(cwd, "marker.txt"), "unstaged edit\n");
    await fs.rm(path.join(cwd, "remove-me.txt"));
    await fs.mkdir(path.join(cwd, "notes"));
    await fs.writeFile(path.join(cwd, "notes", "todo.md"), "untracked work\n");
    await fs.chmod(path.join(cwd, "notes", "todo.md"), 0o600);
    await fs.writeFile(path.join(cwd, "build.tsbuildinfo"), "ignored output\n");
    await fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await fs.writeFile(path.join(cwd, ".env"), "LOCAL_SETTING=1\n");
    await fs.mkdir(path.join(cwd, ".claude"));
    await fs.writeFile(path.join(cwd, ".claude", "settings.local.json"), "{\"local\":true}\n");
    return unpushed;
  }

  async function addLinkedNested(f: Awaited<ReturnType<typeof fixture>>) {
    const location = path.dirname(f.remote), author = path.join(location, "docs-author"), remote = path.join(location, "docs.git");
    await fs.mkdir(author, { recursive: true });
    git(author, "init", "--initial-branch=main");
    await fs.writeFile(path.join(author, "guide.md"), "guide\n"); git(author, "add", "."); git(author, "commit", "-m", "docs");
    git(location, "clone", "--bare", author, remote);
    const repoUrl = pathToFileURL(remote).href;
    const base = (await materializeManagedProjectWorkspace(nestedRepositoryBaseCandidates({ companyId: f.companyId, projectId: f.projectId, repoUrl })[0]!, { repoUrl })).cwd;
    await ensureManagedRepositoriesIgnored(f.cwd);
    const checkout = path.join(f.cwd, ".paperclip-repositories", "docs-linked");
    await fs.mkdir(path.dirname(checkout), { recursive: true });
    const { branchName } = await addNestedRepositoryWorktree({ base, cwd: checkout, repoUrl, repoRef: null });
    await fs.writeFile(path.join(checkout, "guide.md"), "edited in the nested worktree\n");
    return { base, checkout, branchName, realBase: await fs.realpath(base) };
  }

  const worktreePaths = (base: string) => git(base, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));

  const gitView = (cwd: string) => ({ branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), head: git(cwd, "rev-parse", "HEAD"),
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"), reflog: git(cwd, "reflog", "show", "--format=%H", "HEAD") });

  async function expectUntouched(f: Awaited<ReturnType<typeof fixture>>, before: Awaited<ReturnType<typeof currentRestorePointSnapshot>>, cwd = f.cwd) {
    const current = await f.row();
    expect(current.cwd).toBe(f.cwd);
    expect(current.metadata?.isolatedRemoteSource).toBeDefined();
    expect(current.metadata?.isolatedRepositoryRehome).toBeUndefined();
    expect(await currentRestorePointSnapshot(cwd)).toEqual(before);
    expect(await exists(f.target)).toBe(false);
    if (await exists(f.sharedPath)) expect(() => git(f.sharedPath, "rev-parse", "--verify", "-q", "refs/heads/fixture-task")).toThrow();
  }

  it('JUDGE actual rehome: no next transfer step after outer loss; durable recovery record, workspace and run events survive',async()=>{
    const f=await fixture();await makeWork(f.cwd);const before=await currentRestorePointSnapshot(f.cwd);
    const agentId=randomUUID(),runId=randomUUID();
    await db.insert(agents).values({id:agentId,companyId:f.companyId,name:'RFL custody',role:'engineer',adapterType:'process'});
    // @ts-expect-error -- the judge passes executionWorkspaceId, which heartbeat_runs does not have; drizzle drops it at runtime (type-only annotation, judge text unchanged)
    await db.insert(heartbeatRuns).values({id:runId,companyId:f.companyId,agentId,issueId:f.issueId,executionWorkspaceId:f.workspaceId,status:'succeeded',finishedAt:new Date()});
    const {heartbeatRunEvents}=await import('@paperclipai/db');
    await db.insert(heartbeatRunEvents).values({companyId:f.companyId,runId,agentId,seq:1,eventType:'judge.custody',payload:{text:'retain this event across lock loss'}});
    const [databaseName]=await db.execute(sql`select current_database() as name`);
    await db.execute(sql.raw(`alter database "${databaseName.name}" set idle_in_transaction_session_timeout = '3s'`));
    let entered!:()=>void,release!:()=>void;const inside=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    const rename=fs.rename.bind(fs);let held=false,afterLoss=false;const lateRenames:string[]=[];
    const spy=vi.spyOn(fs,'rename').mockImplementation(async(...args:Parameters<typeof fs.rename>)=>{
      const from=String(args[0]),to=String(args[1]);if(afterLoss && from.startsWith(f.cwd+'/') && to.startsWith(f.target+'/'))lateRenames.push(path.relative(f.cwd,from));
      const value=await rename(...args);if(!held && from===path.join(f.cwd,'node_modules') && to===path.join(f.target,'node_modules')){held=true;entered();await gate;}return value;
    });
    const op=rehomeIsolatedRepositoryWorkspace(db,await f.row()).then(value=>({value}),error=>({error:String(error)}));
    try{
      await Promise.race([inside,op.then(x=>{throw Error('early '+JSON.stringify(x))})]);
      const key=`isolated_repository_source:${f.companyId}:${f.issueId}`;
      const [owner]=await db.execute(sql`select pid from pg_locks where locktype='advisory' and granted and classid::bigint=((hashtextextended(${key},0)>>32)&4294967295) and objid::bigint=(hashtextextended(${key},0)&4294967295)`);
      expect(owner).toBeTruthy();await db.execute(sql`select pg_terminate_backend(${owner.pid})`);
      expect(await db.transaction(async tx=>(await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`))[0].acquired)).toBe(true);
      await new Promise(r=>setTimeout(r,2500));afterLoss=true;release();await op;
      const lifecycle=`execution_workspace_lifecycle:${f.workspaceId}`;
      await vi.waitFor(async()=>expect(await db.transaction(async tx=>(await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${lifecycle},0)) as acquired`))[0].acquired)).toBe(true),{timeout:10000});
      spy.mockRestore();const rowAfterLoss=await f.row();
      const pending=rowAfterLoss.metadata?.isolatedRepositoryRehomePending;
      const events=await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,runId));
      const partial={lateRenames,workspaceRetained:rowAfterLoss.id===f.workspaceId,oldCwdStillRecorded:rowAfterLoss.cwd===f.cwd,pending,runEventsRetained:events.length};
      const recovered=await rehomeIsolatedRepositoryWorkspace(db,await f.row());
      const afterRecovery=await currentRestorePointSnapshot(f.target);
      const proof={...partial,recovered,recoverySnapshotEqual:JSON.stringify(afterRecovery)===JSON.stringify(before),pendingAfterRecovery:(await f.row()).metadata?.isolatedRepositoryRehomePending??null,eventsAfterRecovery:(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,runId))).length};
      console.log('RFL_ACTUAL_REHOME_CUSTODY',JSON.stringify(proof));await fs.writeFile(path.join(process.env.TASK_OUT!,'actual-rehome-custody.json'),JSON.stringify(proof,null,2));
      expect(proof.workspaceRetained).toBe(true);expect(proof.oldCwdStillRecorded).toBe(true);expect(proof.pending).toBeTruthy();expect(proof.runEventsRetained).toBe(1);expect(proof.eventsAfterRecovery).toBe(1);
      expect(proof.recovered.rehomed).toBe(true);expect(afterRecovery).toEqual(before);expect(proof.pendingAfterRecovery).toBe(null);
      expect(proof.lateRenames).toEqual([]);
    }finally{release();await op;spy.mockRestore();}
  },90000);
});
