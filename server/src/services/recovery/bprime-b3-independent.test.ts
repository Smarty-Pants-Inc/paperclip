// Independent B3 checks: read-only seam, person-owned reasons, F2 after the F3 extraction.
// Keep reason: recorded B2 false reset notice + truthful retry advice + data-safety/read-only trust boundary.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { and, eq, gt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, agents, approvals, companies, createDb, heartbeatRuns, issueApprovals, issueComments, issueRecoveryActions, issueThreadInteractions, issues, nativeRunFinalizations, type Db } from '@paperclipai/db';
import { isCurrentNotice } from '@paperclipai/shared';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from '../../__tests__/helpers/embedded-postgres.js';
import { settleUnansweredPersonMessage, settleUnansweredPersonMessages } from './unanswered-person-message.js';
import { freshContinuationVerdict, ensureFreshContinuation, FRESH_CONTINUATION_SCHEMA, PERSON_OWNED_FAILURE_CODES } from '../fresh-continuation-fallback.js';
import * as processOwner from '../run-process-owner.js';
const support = await getEmbeddedPostgresTestSupport();
const RETRYING = "Your message wasn't answered yet; Paperclip is retrying automatically.";
describe.skipIf(!support.supported)('B3 independent reset, ownership and read-only seam', () => {
 let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
 const receipt: Record<string, unknown> = {};
 beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('b3-own-'); db = createDb(temp.connectionString); }, 60000);
 afterAll(async () => { try { if (process.env.TASK_OUT) writeFileSync(process.env.TASK_OUT + '/b3-independent-receipt.json', JSON.stringify(receipt, null, 2)); } finally { await db?.$client.end(); await temp?.cleanup(); } });
 async function fixture(status = 'in_progress') {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
  const t = Date.now() - 3600000, at = (ms: number) => new Date(t + ms);
  await db.insert(companies).values({ id: companyId, name: 'B3 judge', issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: 'Coder', status: 'active', adapterType: 'paperclip_runner' });
  await db.insert(issues).values({ id: issueId, companyId, title: 'B3 judge', status, assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: 'active' });
  const message = (await db.insert(issueComments).values({ companyId, issueId, authorType: 'user', authorUserId: userId, body: 'Remember cedar?', createdAt: at(0) }).returning())[0]!;
  const run = async (ms: number, errorCode = 'native_session_interrupted', parent?: string) => (await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId, issueId, runtimeMode: 'native', status: 'failed', errorCode, error: errorCode === 'native_continuation_requires_reconciliation' ? 'native_controller_recovery_missing_evidence:retained_sandbox_binding' : 'runner_harness_state_mismatch: backup_without_reusable_lease', createdAt: at(ms), startedAt: at(ms + 1), finishedAt: at(ms + 2), updatedAt: at(ms + 2), retryOfRunId: parent, contextSnapshot: { issueId, wakeCommentId: message.id } }).returning())[0]!;
  const first = await run(1000);
  const stamp = async (ms: number) => { await db.update(activityLog).set({ createdAt: at(ms) }).where(and(eq(activityLog.companyId, companyId), gt(activityLog.createdAt, at(ms)))); await db.update(issueComments).set({ createdAt: at(ms) }).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, 'system'), gt(issueComments.createdAt, at(ms)))); };
  const sweep = async (ms: number) => { const r = await settleUnansweredPersonMessages(db, { companyId, issueId, now: at(ms) }); await stamp(ms); return r; };
  const settle = async (ms: number) => { const r = await settleUnansweredPersonMessage(db, { companyId, issueId, now: at(ms) }); await stamp(ms); return r; };
  const history = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, 'system')));
  const current = async () => (await history()).filter(n => isCurrentNotice(n.metadata));
  const reset = () => db.insert(issueComments).values({ companyId, issueId, authorType: 'user', authorUserId: userId, body: '/new', createdAt: at(30000) });
  const record = async (ms: number, evidence: Record<string, unknown>, active = false) => (await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: 'active_run_watchdog', cause: 'native_continuation_requires_reconciliation', ownerType: 'system', status: active ? 'active' : 'resolved', fingerprint: randomUUID(), evidence, nextAction: 'Judge fixture', createdAt: at(ms), updatedAt: at(ms) }).returning())[0]!;
  const verdict = (ms = 20000) => freshContinuationVerdict(db, { companyId, runId: first.id, now: at(ms) });
  return { companyId, agentId, issueId, userId, at, message, first, run, sweep, settle, history, current, reset, record, verdict };
 }
 async function save(key: string, f: Awaited<ReturnType<typeof fixture>>, extra: unknown = {}) { receipt[key] = { extra, notes: await f.history() }; }

 it.each([null, -1, 0, 1])('F1 phase timestamp reset offset %s obeys <= boundary despite later row maintenance', async offset => {
  const f = await fixture();
  await db.update(heartbeatRuns).set({ errorCode: 'adapter_failed', nativePhase: 'terminal_failure', nativePhaseUpdatedAt: offset === null ? null : f.at(30000 + offset) }).where(eq(heartbeatRuns.id, f.first.id));
  await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: f.first.id, phase: 'terminal_failure', createdAt: f.at(1000), updatedAt: f.at(40000) });
  await f.reset(); await f.sweep(200000); await save('phase-offset-'+offset, f);
  expect(await f.history()).toHaveLength(offset === 1 ? 0 : 1);
 });

 it.each(['later-descendant', 'later-review', 'later-question', 'later-operator-hold'] as const)('F2 all inputs as-of: %s cannot revive a reset-away message', async later => {
  const f = await fixture();
  await f.sweep(20000); expect(await f.history()).toHaveLength(0);
  await f.reset(); expect((await f.settle(30001)).kind).toBe('none');
  if (later === 'later-descendant') await f.run(50000, 'native_continuation_requires_reconciliation', f.first.id);
  if (later === 'later-review') await db.update(issues).set({ status: 'in_review', updatedAt: f.at(40000) }).where(eq(issues.id, f.issueId));
  if (later === 'later-question') await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: 'ask_user_questions', status: 'pending', payload: { questions: [] }, createdAt: f.at(40000), updatedAt: f.at(40000) } as unknown as typeof issueThreadInteractions.$inferInsert);
  if (later === 'later-operator-hold') await f.record(40000, { runId: f.first.id, explicitUserContinuation: { actorId: f.userId } }, true);
  const after = typeof freshContinuationVerdict === 'function' ? await f.verdict(30000) : 'unavailable before extraction'; await f.sweep(80000); await save(later, f, { verdictAtResetUsingCurrentRows: after });
  expect(await f.history(), 'the message was pending at the reset; later evidence cannot revoke that completed reset').toHaveLength(0);
 });

 it('F2 actual fallback records later on an EXISTING hold; created_at is not the continuation time', async () => {
  const f = await fixture(); const oldHold = await f.record(2000, { runId: f.first.id }, true);
  await f.sweep(20000); expect(await f.history()).toHaveLength(0);
  await f.reset(); expect((await f.settle(30001)).kind).toBe('none');
  const continued = await ensureFreshContinuation(db, { companyId: f.companyId, runId: f.first.id, trigger: 'recovery_refused', delivery: 'caller_owns', now: f.at(40000) });
  expect(continued).toMatchObject({ kind: 'continued', recoveryActionId: oldHold.id });
  const afterHold = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, oldHold.id)))[0]!;
  expect(afterHold.createdAt).toEqual(f.at(2000));
  expect((afterHold.evidence.freshContinuation as Record<string, unknown>).recordedAt).toBe(f.at(40000).toISOString());
  await f.run(50000, 'native_continuation_requires_reconciliation', f.first.id);
  await f.sweep(80000); await save('later-record-on-existing-hold', f, { continued, afterHold });
  expect(await f.history(), 'the real fallback reused a pre-reset row but wrote its continuation after the reset').toHaveLength(0);
 });

 it('F2 chain actions created later do not revoke reset', async () => {
  const f = await fixture(); const root = await f.run(-2000); const parent = await f.run(-1000, 'native_session_interrupted', root.id);
  await db.update(heartbeatRuns).set({ retryOfRunId: parent.id }).where(eq(heartbeatRuns.id, f.first.id));
  await f.sweep(20000); await f.reset(); expect((await f.settle(30001)).kind).toBe('none');
  for (const [i, source] of [root, parent].entries()) await f.record(40000 + i, { runId: source.id, freshContinuation: { sourceRunId: source.id, schema: FRESH_CONTINUATION_SCHEMA, recordedAt: f.at(40000 + i).toISOString() }, continuationDelivery: 'delivered' });
  await f.sweep(80000); await save('later-chain', f); expect(await f.history()).toHaveLength(0);
 });

 it.each(['in_review', 'blocked_by_another_decision', 'stopped_on_request', 'operator_decision_recorded', 'approval_pending', 'question_pending', 'agent_not_available', 'company_paused'] as const)('person_owned %s never says retrying automatically; verdict works READ ONLY', async reason => {
  const f = await fixture(reason === 'in_review' ? 'in_review' : reason === 'blocked_by_another_decision' ? 'blocked' : 'in_progress');
  if (reason === 'stopped_on_request') await db.update(heartbeatRuns).set({ resultJson: { operatorInterrupted: true } }).where(eq(heartbeatRuns.id, f.first.id));
  if (reason === 'operator_decision_recorded') await f.record(2000, { runId: f.first.id, explicitUserContinuation: { actorId: f.userId } }, true);
  if (reason === 'approval_pending') { const a = (await db.insert(approvals).values({ companyId: f.companyId, type: 'approve_ceo_strategy', status: 'pending', payload: {} } as typeof approvals.$inferInsert).returning())[0]!; await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: a.id } as typeof issueApprovals.$inferInsert); }
  if (reason === 'question_pending') await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: 'ask_user_questions', status: 'pending', payload: { questions: [] } } as unknown as typeof issueThreadInteractions.$inferInsert);
  if (reason === 'agent_not_available') await db.update(agents).set({ status: 'paused' }).where(eq(agents.id, f.agentId));
  if (reason === 'company_paused') await db.update(companies).set({ status: 'paused' }).where(eq(companies.id, f.companyId));
  const result = await db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return freshContinuationVerdict(tx as unknown as Db, { companyId: f.companyId, runId: f.first.id, now: f.at(19000) }); });
  expect(result).toEqual({ kind: 'person_owned', reason });
  await f.sweep(20000); await f.sweep(140000); await save('person-'+reason, f, result);
  expect((await f.current()).some(n => n.body === RETRYING)).toBe(false);
 });

 it.each(PERSON_OWNED_FAILURE_CODES)('person-owned failure code %s: READ ONLY and no retry claim', async code => {
  const f = await fixture(); await db.update(heartbeatRuns).set({ errorCode: code }).where(eq(heartbeatRuns.id, f.first.id));
  const result = await db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return freshContinuationVerdict(tx as unknown as Db, { companyId: f.companyId, runId: f.first.id, now: f.at(19000) }); });
  expect(result).toEqual({ kind: 'person_owned', reason: code });
  await f.sweep(20000); await f.sweep(140000); await save('person-code-'+code, f, result);
  expect((await f.current()).some(n => n.body === RETRYING)).toBe(false);
 });

 it('person_owned retry_needed remains read-only and never claims automatic retry', async () => {
  const f = await fixture(); await f.record(1500, { runId: f.first.id }, true);
  const refused = await f.run(2000, 'execution_reconciliation_required', f.first.id);
  await db.update(heartbeatRuns).set({ status: 'cancelled', startedAt: null }).where(eq(heartbeatRuns.id, refused.id));
  const now = 3 * 86_400_000;
  const result = await db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return freshContinuationVerdict(tx as unknown as Db, { companyId: f.companyId, runId: f.first.id, now: f.at(now) }); });
  expect(result).toEqual({ kind: 'person_owned', reason: 'retry_needed' });
  await f.sweep(now); await f.sweep(now+140000); await save('person-retry-needed', f, result);
  expect((await f.current()).some(n => n.body === RETRYING)).toBe(false);
 });

 it('read-only local proof-needed path never probes a process and B treats it as waiting, not safe', async () => {
  const f = await fixture(); const probe = vi.spyOn(processOwner, 'proveRunProcessGone');
  try {
   const result = await db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return freshContinuationVerdict(tx as unknown as Db, { companyId: f.companyId, runId: f.first.id, now: f.at(19000) }); });
   expect(result).toEqual({ kind: 'needs_stop_proof' }); expect(probe).not.toHaveBeenCalled();
   await f.sweep(20000); expect(await f.history()).toHaveLength(0); await f.sweep(140000);
   await save('needs-stop-proof', f, result); expect((await f.current()).map(n => n.body)).toEqual([RETRYING]); expect(probe).not.toHaveBeenCalled();
  } finally { probe.mockRestore(); }
 });

 it('read-only existing continuation does NOT settle late holds', async () => {
  const f = await fixture(); const prior = await f.record(2000, { runId: f.first.id, freshContinuation: { sourceRunId: f.first.id, schema: FRESH_CONTINUATION_SCHEMA }, continuationDelivery: 'delivered' });
  const late = await f.record(3000, { runId: f.first.id }, true);
  const before = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, late.id));
  const result = await db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return freshContinuationVerdict(tx as unknown as Db, { companyId: f.companyId, runId: f.first.id, now: f.at(20000) }); });
  expect(result).toEqual({ kind: 'already_continued', recoveryActionId: prior.id });
  expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, late.id))).toEqual(before); receipt['late-holds-readonly'] = result;
 });

 it.each([false, true])('seed shape blockedTransitionAt present=%s: read-only full eligibility', async present => {
  const f = await fixture('blocked'); if (present) await db.update(issues).set({ blockedTransitionAt: f.first.finishedAt }).where(eq(issues.id, f.issueId));
  const result = await db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return freshContinuationVerdict(tx as unknown as Db, { companyId: f.companyId, runId: f.first.id, now: f.at(19000) }); });
  expect(result).toEqual(present ? { kind: 'needs_stop_proof' } : { kind: 'person_owned', reason: 'blocked_by_another_decision' });
  await f.sweep(20000); await f.sweep(140000); await save('seed-shape-'+present, f, result);
  expect((await f.current()).some(n => n.body === RETRYING)).toBe(present);
 });
});
