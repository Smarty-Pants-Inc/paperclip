import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { createCaptureHandler, REFUSAL, STUB_REPLY } from '../capture.mjs';
import { NAMESPACE, CLAIM, READ_FACTS } from '../sql.mjs';
import { postgres } from './postgres.mjs';

const pg = postgres();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C = id(1), A = id(2), R = id(3), I = id(4), M = id(5), H = id(6), R2 = id(7), C2 = id(8), I2 = id(9);
const policy = { companyId: C, principalUserId: 'test-principal', primaryAgentId: A };
const context = { companyId: C, agentId: A, runId: R, projectId: '' };
const errors = [];
let uses = 0;
const db = { ...pg, namespace: NAMESPACE };
const deps = {
  db, config: { async get() { return policy; } }, logger: { error(...args) { errors.push(args); } },
  recorder: { async use() { uses++; return { outcome: 'not_captured', reason: 'stub_recorder' }; } },
};
const handler = () => createCaptureHandler(deps);
const rows = table => pg.query(`SELECT * FROM ${NAMESPACE}.${table} ORDER BY ${table === 'capture_log' ? 'attempted_at, id' : 'wake_comment_id'}`);

before(async () => {
  await pg.raw(`CREATE TABLE public.agents (id uuid PRIMARY KEY, company_id uuid);
    CREATE TABLE public.issues (id uuid PRIMARY KEY, company_id uuid, conversation_user_id text, conversation_agent_id uuid);
    CREATE TABLE public.heartbeat_runs (id uuid PRIMARY KEY, company_id uuid, agent_id uuid,
      issue_id uuid, responsible_user_id text, invocation_source text, status text, context_snapshot jsonb);
    CREATE TABLE public.issue_comments (id uuid PRIMARY KEY, company_id uuid, issue_id uuid,
      author_user_id text, author_agent_id uuid, author_type text, created_at timestamptz,
      deleted_at timestamptz, presentation jsonb, body text);
    CREATE SCHEMA ${NAMESPACE};`);
  let ddl = await readFile(new URL('../migrations/001_screen_capture.sql', import.meta.url), 'utf8');
  if (process.env.SCREEN_CAPTURE_TEST_MUTANT === 'double') ddl = ddl.replace('wake_comment_id uuid PRIMARY KEY', 'wake_comment_id uuid NOT NULL');
  await pg.raw(ddl);
});

beforeEach(async () => {
  errors.length = 0; uses = 0;
  await pg.raw(`TRUNCATE ${NAMESPACE}.capture_claims, ${NAMESPACE}.capture_log,
    public.issue_comments, public.heartbeat_runs, public.issues, public.agents;
    INSERT INTO public.agents VALUES ('${A}', '${C}'), ('${H}', '${C}');
    INSERT INTO public.issues VALUES ('${I}', '${C}', 'test-principal', '${A}'), ('${I2}', '${C}', 'test-principal', '${A}');
    INSERT INTO public.heartbeat_runs VALUES ('${R}', '${C}', '${A}', '${I}', 'test-principal',
      'automation', 'running', '{"wakeCommentId":"${M}","wakeReason":"issue_commented","source":"issue.comment"}');
    INSERT INTO public.issue_comments VALUES ('${M}', '${C}', '${I}', 'test-principal', NULL,
      'user', '2026-01-01T00:00:00Z', NULL, NULL, 'PRIVATE_BODY_MUST_NOT_BE_EXPOSED');`);
});

async function expectRefusal(reason, call = () => handler()({}, context)) {
  assert.deepEqual(await call(), { content: REFUSAL });
  assert.equal(uses, 0);
  const log = await rows('capture_log');
  assert.equal(log.length, 1);
  assert.equal(log[0].outcome, 'refused');
  assert.equal(log[0].reason, reason);
  assert.equal(log[0].frame_sha256, null);
  assert.equal((await rows('capture_claims')).length, 0);
  return log[0];
}

async function later({ person = false, system = false, deleted = false } = {}) {
  await pg.raw(`INSERT INTO public.issue_comments VALUES ('${id(20)}', '${C}', '${I}',
    ${person ? "'test-principal'" : 'NULL'}, ${person ? 'NULL' : `'${A}'`},
    '${system ? 'system' : person ? 'user' : 'agent'}', '2026-01-01T00:00:01Z',
    ${deleted ? "'2026-01-01T00:00:02Z'" : 'NULL'}, ${system ? "'{\"kind\":\"system_notice\"}'" : 'NULL'}, 'not returned');`);
}

test('qualified newest unanswered request claims once, stores witness, and explicitly returns no image in stub', async () => {
  assert.deepEqual(await handler()({ windowApp: 'com.apple.Notes' }, context), { content: STUB_REPLY });
  assert.equal(uses, 1);
  const [claim] = await rows('capture_claims');
  assert.equal(claim.wake_comment_id, M);
  assert.equal(claim.run_id, R);
  assert.equal(claim.author_user_id, 'test-principal');
  assert.equal(claim.conversation_id, I);
  assert.equal(claim.checked_newest_unanswered, true);
  assert.equal(claim.in_flight, false);
  assert.equal(claim.outcome, 'not_captured');
  assert.equal(new Date(claim.expires_at) - new Date(claim.read_at), 120_000);
  const [log] = await rows('capture_log');
  assert.equal(log.outcome, 'not_captured');
  assert.equal(log.invocation_source, 'automation');
  assert.equal(log.wake_reason, 'issue_commented');
  assert.equal(log.wake_source, 'issue.comment');
  assert.equal(log.author_user_id, 'test-principal');
  assert.equal(log.frame_sha256, null);
});

test('RED stale retry: carried wakeCommentId already answered must be refused', async () => {
  await later();
  await expectRefusal('not_newest_unanswered');
});

test('RED newest person message supersedes wakeCommentId', async () => {
  await later({ person: true });
  await expectRefusal('not_newest_unanswered');
});

test('system notes are not answers, and deleted later comments are ignored', async () => {
  await later({ system: true });
  assert.deepEqual(await handler()({}, context), { content: STUB_REPLY });
});

test('ops structured author refused and correctly attributed, even with principal responsible user', async () => {
  await pg.raw(`UPDATE public.issue_comments SET author_user_id='test-ops' WHERE id='${M}'`);
  const log = await expectRefusal('not_paul');
  assert.equal(log.author_user_id, 'test-ops');
  assert.equal(log.responsible_user_id, 'test-principal');
});

test('agent-authored comment cannot impersonate principal', async () => {
  await pg.raw(`UPDATE public.issue_comments SET author_agent_id='${A}', author_type='agent' WHERE id='${M}'`);
  await expectRefusal('not_paul');
});

test('wake comment on another issue refused', async () => {
  await pg.raw(`UPDATE public.issue_comments SET issue_id='${I2}' WHERE id='${M}'`);
  await expectRefusal('not_this_conversation');
});

test('hire does not inherit primary permission', async () => {
  await pg.raw(`UPDATE public.heartbeat_runs SET agent_id='${H}' WHERE id='${R}'`);
  await expectRefusal('not_primary', () => handler()({}, { ...context, agentId: H }));
});

test('task, not personal conversation, refused', async () => {
  await pg.raw(`UPDATE public.issues SET conversation_user_id=NULL, conversation_agent_id=NULL WHERE id='${I}'`);
  await expectRefusal('not_this_conversation');
});

for (const source of ['timer', 'automation', 'on_demand']) {
  test(`scheduled/self run with no person witness refused (${source})`, async () => {
    await pg.raw(`UPDATE public.heartbeat_runs SET context_snapshot='{}', invocation_source='${source}' WHERE id='${R}'`);
    await expectRefusal('no_person_message');
  });
}

test('invocation labels logged but NOT used as gate when person witness is still unanswered', async () => {
  await pg.raw(`UPDATE public.heartbeat_runs SET invocation_source='timer' WHERE id='${R}'`);
  assert.deepEqual(await handler()({}, context), { content: STUB_REPLY });
  assert.equal((await rows('capture_log'))[0].invocation_source, 'timer');
});

test('deleted wake comment refused without burning message', async () => {
  await pg.raw(`UPDATE public.issue_comments SET deleted_at=CURRENT_TIMESTAMP WHERE id='${M}'`);
  await expectRefusal('deleted');
});

test('hard-deleted wake comment refused', async () => {
  await pg.raw(`DELETE FROM public.issue_comments WHERE id='${M}'`);
  await expectRefusal('missing_message');
});

test('cross-company context cannot see facts or claim a foreign message', async () => {
  const log = await expectRefusal('cross_company', () => handler()({}, { ...context, companyId: C2 }));
  assert.equal(log.company_id, C2);
  assert.equal(log.wake_comment_id, null);
  assert.equal(log.author_user_id, null);
});

test('foreign company comment cannot authorize a same-company run', async () => {
  await pg.raw(`UPDATE public.issue_comments SET company_id='${C2}' WHERE id='${M}'`);
  await expectRefusal('missing_message');
});

test('forged run/message/user arguments never replace host identity', async () => {
  await expectRefusal('invalid_arguments', () => handler()({ runId: id(99), userId: 'Paul', wakeCommentId: id(98) }, context));
});

test('second claim refused already_used and logged; no repeated stub use', async () => {
  const capture = handler();
  assert.deepEqual(await capture({}, context), { content: STUB_REPLY });
  assert.deepEqual(await capture({}, context), { content: REFUSAL });
  const log = await rows('capture_log');
  assert.equal(log.length, 2);
  assert.equal(log.filter(row => row.reason === 'already_used').length, 1);
  assert.equal((await rows('capture_claims')).length, 1);
  assert.equal(uses, 1);
});

test('RED concurrent different-run claims for ONE message: exactly one winner, loser already_used logged', async () => {
  await pg.raw(`INSERT INTO public.heartbeat_runs SELECT '${R2}', company_id, agent_id, issue_id,
    responsible_user_id, invocation_source, status, context_snapshot FROM public.heartbeat_runs WHERE id='${R}'`);
  let waiting = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const racingDb = { ...db, async execute(sql, params) {
    if (sql === CLAIM) { if (++waiting === 2) release(); await barrier; }
    return db.execute(sql, params);
  } };
  const capture = createCaptureHandler({ ...deps, db: racingDb });
  const result = await Promise.all([capture({}, context), capture({}, { ...context, runId: R2 })]);
  assert.equal(result.filter(row => row.content === STUB_REPLY).length, 1);
  assert.equal(result.filter(row => row.content === REFUSAL).length, 1);
  assert.equal((await rows('capture_claims')).length, 1);
  assert.equal((await rows('capture_log')).filter(row => row.reason === 'already_used').length, 1);
  assert.equal(uses, 1);
});

test('delete between successful claim and use refused: reservation retained, in-flight released', async () => {
  const deletingDb = { ...db, async execute(sql, params) {
    const result = await db.execute(sql, params);
    if (sql === CLAIM && result.rowCount === 1) await pg.raw(`UPDATE public.issue_comments SET deleted_at=CURRENT_TIMESTAMP WHERE id='${M}'`);
    return result;
  } };
  assert.deepEqual(await createCaptureHandler({ ...deps, db: deletingDb })({}, context), { content: REFUSAL });
  assert.equal(uses, 0);
  const [claim] = await rows('capture_claims');
  assert.equal(claim.outcome, 'refused_at_use');
  assert.equal(claim.in_flight, false);
  const [log] = await rows('capture_log');
  assert.equal(log.reason, 'deleted');
  assert.equal(log.outcome, 'refused');
});

test('fresh claim SQL rechecks eligibility after initial read; zero rows classified without claim retry', async () => {
  let inserts = 0;
  const changingDb = { ...db, async execute(sql, params) {
    if (sql === CLAIM) { inserts++; await later(); }
    return db.execute(sql, params);
  } };
  await expectRefusal('not_newest_unanswered', () => createCaptureHandler({ ...deps, db: changingDb })({}, context));
  assert.equal(inserts, 1);
});

test('view exposes metadata only, never comment body or whole context/presentation', async () => {
  const [facts] = await db.query(READ_FACTS, [C, R, A, 'test-principal', A, C]);
  assert.equal(facts.author_user_id, 'test-principal');
  assert.equal(JSON.stringify(facts).includes('PRIVATE_BODY'), false);
  assert.equal(Object.hasOwn(facts, 'body'), false);
  assert.equal(Object.hasOwn(facts, 'context_snapshot'), false);
  assert.equal(Object.hasOwn(facts, 'presentation'), false);
});

test('audit write failure prevents claim/use and emits audit-unavailable event, never a false success', async () => {
  const failingDb = { ...db, async execute() { throw new Error('sensitive backend detail'); } };
  assert.deepEqual(await createCaptureHandler({ ...deps, db: failingDb })({}, context), { content: REFUSAL });
  assert.equal(uses, 0);
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(errors).includes('sensitive backend detail'), false);
  assert.equal((await rows('capture_claims')).length, 0);
});
