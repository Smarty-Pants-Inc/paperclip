// Independent RFL checks. Fixtures are local and provider-free; not daily-work acceptance.
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from '@paperclipai/db';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { startEmbeddedPostgresTestDatabase } from '../../__tests__/helpers/embedded-postgres.js';
import { noticeRunnerReuseRefusal } from './runner-reuse-refusal.js';
import { REMOTE_RUNNER_AUTHORITY_ARCHIVE_SCRIPT } from './native-session-executor.js';
import { settleUnansweredPersonMessage } from '../recovery/unanswered-person-message.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function inventory(root: string): Promise<Record<string,string>> {
  const entries: Record<string,string> = {};
  async function visit(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (item.isDirectory()) await visit(file);
      else if (item.isFile()) entries[relative(root, file)] = sha(await readFile(file));
      else throw new Error('unexpected non-file in transcript fixture');
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

describe('RFL independent transcript inventory', () => {
  it.each(['fresh archive', 'replay archive', 'foreign facade'])('leaves every pi/ byte and path unchanged: %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'rfl-transcripts-'));
    try {
      const runner = join(root, 'runner'), pi = join(root, 'pi'), archive = join(root, 'epoch');
      await Promise.all([mkdir(runner), mkdir(join(pi, 'nested'), { recursive: true }), mkdir(archive)]);
      await writeFile(join(pi, 'one.jsonl'), '{"role":"user","text":"earlier work"}\n{"role":"assistant","text":"saved result"}\n');
      await writeFile(join(pi, 'nested', 'two.jsonl'), Buffer.from([0, 1, 10, 13, 127, 128, 254, 255]));
      await writeFile(join(pi, 'session-index.json'), '{"active":"one","previous":"nested/two"}\n');
      const authority = Buffer.from('authority bytes\n\u0000'), facade = Buffer.from('old launch facade\n\u0000');
      await writeFile(join(runner, 'runner-state.json'), authority);
      await writeFile(join(runner, 'codex-provider-state.json'), facade);
      if (mode === 'replay archive') {
        await writeFile(join(archive, 'runner-state.json'), authority);
        await writeFile(join(archive, 'codex-provider-state.json'), facade);
      } else if (mode === 'foreign facade') await writeFile(join(archive, 'codex-provider-state.json'), 'foreign archive');
      const before = await inventory(pi);
      const run = () => spawnSync('sh', ['-c', REMOTE_RUNNER_AUTHORITY_ARCHIVE_SCRIPT, 'rfl-archive',
        join(runner, 'runner-state.json'), archive, join(archive, 'runner-state.json'),
        join(runner, 'codex-provider-state.json'), join(archive, 'codex-provider-state.json')], { encoding: 'utf8' });
      expect(run().status).toBe(mode === 'foreign facade' ? 1 : 0);
      const after = await inventory(pi);
      expect(after).toEqual(before);
      expect(await readFile(join(archive, 'runner-state.json'))).toEqual(authority);
      expect(await readFile(join(mode === 'foreign facade' ? runner : archive, 'codex-provider-state.json'))).toEqual(facade);
      if (mode !== 'foreign facade') expect(run().status).toBe(0);
      expect(await inventory(pi)).toEqual(before);
      console.log('RFL_TRACE_SHA256', JSON.stringify({mode, before, after, authority:sha(authority), facade:sha(facade)}));
    } finally { await rm(root, {recursive: true, force: true}); }
  });
});

describe('RFL independent restart/refusal action', () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase('rfl-refusal-');
    db = createDb(database.connectionString);
  }, 60000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId=randomUUID(), agentId=randomUUID(), issueId=randomUUID(), sessionId=randomUUID(), messageId=randomUUID();
    await db.insert(companies).values({id:companyId, name:'RFL local fixture', issuePrefix:companyId.slice(0,8)});
    await db.insert(agents).values({id:agentId, companyId, name:'RFL local agent', adapterType:'paperclip_runner', status:'active'});
    await db.insert(issues).values({id:issueId, companyId, title:'RFL local idle conversation', status:'todo', assigneeAgentId:agentId});
    await db.insert(issueComments).values({id:messageId, companyId, issueId, authorType:'user', authorUserId:'rfl-person',
      body:'Continue the saved work', createdAt:new Date(Date.now()-180000)});
    const [run]=await db.insert(heartbeatRuns).values({companyId, agentId, status:'failed', runtimeMode:'native',
      nativeIssueId:issueId, nativeSessionId:sessionId, errorCode:'native_runner_launch_profile_mismatch',
      error:'native_session_recovery_failed: Error: PRP command run.attach failed: '+JSON.stringify({commandType:'run.attach',status:'failed',result:{code:'command_execution_failed', message:'Pi run.prepare launch does not match the runner-owned qualified profile'}}),
      finishedAt:new Date(Date.now()-120000), contextSnapshot:{wakeCommentId:messageId}}).returning();
    return {companyId,agentId,issueId,runId:run!.id,normalizedSessionId:sessionId,reason:'runner_launch_profile_mismatch' as const};
  }

  it('a sweep after a crash before the writer names the recovery action, not a futile retry', async () => {
    const input = await seed();
    // Terminal run is durable but the outer catch's note did not commit.
    expect((await settleUnansweredPersonMessage(db,input)).kind).toBe('noticed');
    // A new connection reads only durable state, not writer process memory.
    const restarted = createDb(database.connectionString);
    try { await noticeRunnerReuseRefusal(restarted,input); }
    finally { await restarted.$client.end(); }
    const notices=(await db.select().from(issueComments).where(eq(issueComments.issueId,input.issueId))).filter(c=>c.authorType==='system');
    expect(notices).toHaveLength(1);
    console.log('RFL_RESTART_NOTE', notices[0]!.body);
    expect(notices[0]!.body).toContain('verified conversation save');
    expect(notices[0]!.body).not.toContain('Sending it again is safe');
  });

  it('durably deduplicates simultaneous writers and a new-connection replay', async () => {
    const input=await seed();
    await Promise.all([noticeRunnerReuseRefusal(db,input), noticeRunnerReuseRefusal(db,input)]);
    const restarted=createDb(database.connectionString);
    try { await noticeRunnerReuseRefusal(restarted,input); }
    finally { await restarted.$client.end(); }
    const notices=(await db.select().from(issueComments).where(eq(issueComments.issueId,input.issueId))).filter(c=>c.authorType==='system');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain('verified conversation save');
  });
});
