// Place in server/src/services/heartbeat/. Independent judge: real resolver + filesystem + tar/command transport.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { agents, Db, projectWorkspaces } from '@paperclipai/db';
import { createHeartbeatWorkspaceResolver, resolveAdditionalProjectWorkspace, type ResolveAdditionalProjectWorkspaceDeps } from './workspaces.js';
import { isUnsafeSessionWorkspaceCwd } from '../session-workspace-cwd.js';
import { prepareCommandManagedRuntime, type CommandManagedRuntimeRunner } from '@paperclipai/adapter-utils/command-managed-runtime';
import type { RunProcessResult } from '@paperclipai/adapter-utils/server-utils';

vi.mock('../issues.js', async original => ({ ...await original<typeof import('../issues.js')>(), issueService: () => ({ findMentionedProjectIds: async () => ['referenced'] }) }));
vi.mock('../projects.js', async original => ({ ...await original<typeof import('../projects.js')>(), projectService: () => ({ listByIds: async () => [{ id: 'referenced', companyId: 'company' }] }) }));
vi.mock('../authorization.js', async original => ({ ...await original<typeof import('../authorization.js')>(), authorizationService: () => ({ decide: async () => ({ allowed: true, action: 'project:read', reason: 'allow_company_agent', explanation: 'fixture authorized' }) }) }));

const execFile = promisify(execFileCallback);
let root: string, runtime: string, safe: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-root-'));
  runtime = path.join(root, 'runtime'); safe = path.join(root, 'safe');
  await fs.mkdir(path.join(runtime, 'child'), { recursive: true }); await fs.mkdir(safe);
  await fs.writeFile(path.join(runtime, 'other-run-data.txt'), 'synthetic unrelated run data\n');
  await fs.writeFile(path.join(safe, 'task.txt'), 'authorized project\n');
  vi.spyOn(os, 'tmpdir').mockReturnValue(runtime);
  vi.stubEnv('PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC', 'true');
  vi.stubEnv('PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE', 'true');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, {recursive:true,force:true}); });

function factory(cwd: string) {
  const rows = [{ id:'workspace-ref', projectId:'referenced', companyId:'company', cwd, repoUrl:null, repoRef:null, sourceType:'local_path' }];
  const db = { select: () => { const q = { from: () => q, where: () => q, orderBy: async () => rows, then: (done: (r: unknown[]) => unknown) => Promise.resolve(rows).then(done) }; return q; } } as unknown as Db;
  return createHeartbeatWorkspaceResolver(db).resolveWorkspaceForRun(
    { id:'agent', companyId:'company', adapterType:'pi_local' } as typeof agents.$inferSelect,
    { issueId:'issue' }, null,
    { executionEnvironmentDriver:'sandbox', anchorWorkspace: {
      cwd:safe, projectId:'anchor', workspaceId:'anchor-workspace', source:'project_primary', repoUrl:null, repoRef:null,
      warnings:[], workspaceHints:[], baseCwdFallback:false, materializationFailures:[],
    } },
  );
}
function inlineRunner(): CommandManagedRuntimeRunner {
  return { execute: input => new Promise<RunProcessResult>(resolve => {
    const startedAt = new Date().toISOString();
    const child = spawn(input.command, input.args ?? [], { cwd:input.cwd, env:{...process.env,...input.env} });
    let stdout='',stderr='';
    child.stdout.on('data', b => { stdout+=b; }); child.stderr.on('data', b => { stderr+=b; });
    child.on('error', () => resolve({ exitCode:127, signal:null, timedOut:false, stdout,stderr,pid:null,startedAt }));
    child.on('close', code => resolve({ exitCode:code ?? 0, signal:null, timedOut:false, stdout,stderr,pid:child.pid ?? null,startedAt }));
    if (input.stdin != null) child.stdin.write(input.stdin); child.stdin.end();
  }) };
}
async function stagedBytes(cwd: string) {
  const prepared = await prepareCommandManagedRuntime({
    runner:inlineRunner(), spec:{remoteCwd:path.join(root,'remote-workspace'),timeoutMs:30000},
    adapterKey:'judge', workspaceLocalDir:safe, syncWorkspace:false,
    additionalSources:[{localPath:cwd,projectId:'referenced',ignoreResolution:{kind:'other'}}],
  });
  try {
    const target = prepared.additionalSourceDirs.referenced;
    const leaked = target ? await fs.readFile(path.join(target,'other-run-data.txt'),'utf8').catch(() => null) : null;
    console.log('STAGED_RESULT', JSON.stringify({ admitted:cwd, target, leaked, failures:prepared.additionalSourceFailures }));
    return leaked;
  } finally { await prepared.cleanupWorkspaceSnapshot(); }
}

describe('independent root boundary', () => {
  it.each(['direct','dotdot','symlink','chain','relative','relative-symlink','ancestor'])(
    'prior F1 default resolver rejects %s and preserves safe anchor', async kind => {
      const alias=path.join(root,'alias'); let cwd=runtime;
      if (kind==='dotdot') cwd=path.join(runtime,'child')+'/..';
      if (kind==='ancestor') cwd=root;
      if (kind==='symlink' || kind==='chain' || kind==='relative-symlink') { await fs.symlink(runtime,alias); cwd=alias; }
      if (kind==='chain') { await fs.symlink(alias,path.join(root,'link2')); await fs.symlink(path.join(root,'link2'),path.join(root,'link3')); cwd=path.join(root,'link3'); }
      if (kind==='relative' || kind==='relative-symlink') cwd=path.relative(process.cwd(),cwd);
      const result=await factory(cwd);
      expect(result.cwd).toBe(safe);
      expect(result.additionalWorkspaces).toEqual([]);
      expect(result.referencedProjectFailures).toEqual([{projectId:'referenced',reason:'resolution'}]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('runtime temporary staging');
    },
  );
  it.each(['child','sibling','safe-alias'])('preserves authorized %s', async kind => {
    let cwd=kind==='child' ? path.join(runtime,'child') : safe;
    if(kind==='safe-alias') { cwd=path.join(root,'safe-alias'); await fs.symlink(safe,cwd); }
    await fs.writeFile(path.join(cwd,'known.txt'),'known');
    const result=await factory(cwd);
    expect(result.additionalWorkspaces).toEqual([expect.objectContaining({cwd:await fs.realpath(cwd),projectId:'referenced'})]);
    expect(result.referencedProjectFailures).toEqual([]);
  });
  it.each([false,true])('rejects symlink/.. by physical traversal, relative=%s', async relative => {
    const link=path.join(safe,'toward-runtime-child'); await fs.symlink(path.join(runtime,'child'),link);
    // Give both roots matching entry names, so the helper's lexical enumeration
    // cannot mask the physical-root bug with a missing-entry tar error.
    await fs.writeFile(path.join(safe,'other-run-data.txt'),'authorized file with same basename\n');
    await fs.writeFile(path.join(runtime,'task.txt'),'unrelated runtime task\n');
    await fs.symlink('child',path.join(runtime,'toward-runtime-child'));
    let cwd=link+'/..'; if(relative) cwd=path.relative(process.cwd(),link)+'/..';
    console.log('PATH_IDENTITY',JSON.stringify({cwd,lexical:path.resolve(cwd),jsRealpath:realpathSync(cwd),nativeRealpath:realpathSync.native(cwd),actual:await fs.realpath(cwd)}));
    const result=await factory(cwd);
    // Exercise the actual returned source, not only the predicate or a mock call count.
    let leaked: string|null=null;
    if(result.additionalWorkspaces.length) leaked=await stagedBytes(result.additionalWorkspaces[0]!.cwd);
    expect({sources:result.additionalWorkspaces,leaked}).toEqual({sources:[],leaked:null});
  });
  it('does not sync a safe reference retargeted to the runtime root after admission', async () => {
    const alias=path.join(root,'mutable-reference'); await fs.symlink(safe,alias);
    const result=await factory(alias);
    expect(result.additionalWorkspaces).toHaveLength(1);
    await fs.unlink(alias); await fs.symlink(runtime,alias);
    expect(await fs.realpath(alias)).toBe(runtime);
    expect(await stagedBytes(result.additionalWorkspaces[0]!.cwd)).toBeNull();
  });
  it('keeps explicit /tmp fail-closed', () => expect(isUnsafeSessionWorkspaceCwd('/tmp')).toBe(true));
});
