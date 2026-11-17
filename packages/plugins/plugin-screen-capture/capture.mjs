import { randomUUID } from 'node:crypto';
import {
  NAMESPACE, READ_FACTS, CLAIM, START_LOG, UPDATE_LOG, READ_CLAIM, FINISH_CLAIM,
} from './sql.mjs';

export const REFUSAL = 'Only Paul can ask me to look at his screen, from his own conversation.';
export const DISCLOSURE = "A capture is stored in this chat's history AND sent to our Langfuse tracing (EU); don't ask while client data is on screen.";
export const STUB_REPLY = `No screen was captured and no image was stored. The recorder is a stub. Real-capture policy (not performed here): ${DISCLOSURE}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// Deliberately no GO mint, subprocess, network, filesystem or activation option.
export const stubRecorder = Object.freeze({
  async use() { return { outcome: 'not_captured', reason: 'stub_recorder' }; },
});

export function classify(row) {
  if (!row) return 'facts_unavailable';
  if (row.reason !== 'eligible') return row.reason;
  if (row.already_used) return 'already_used';
  if (row.in_flight) return 'capture_in_flight';
  return 'claim_not_acquired'; // Observed zero rows, but no current conflict witness; never guess/retry.
}

function validConfig(value) {
  return value && UUID.test(value.companyId) && UUID.test(value.primaryAgentId)
    && typeof value.principalUserId === 'string' && value.principalUserId.trim().length > 0;
}

function validArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args)
    && Object.keys(args).every(key => key === 'windowApp')
    && (args.windowApp === undefined || (typeof args.windowApp === 'string'
      && args.windowApp.length <= 255 && BUNDLE_ID.test(args.windowApp)));
}

/** All identity is host context + BOARD-set config. args supplies ONLY optional scope. */
export function createCaptureHandler({ db, config, logger, recorder = stubRecorder, newId = randomUUID }) {
  return async function capture(args, context) {
    const id = newId();
    let started = false;
    let claimed = false;
    let row = null;
    const bound = [id, context.companyId, context.runId, context.agentId];
    const auditFault = () => logger.error('screen.capture audit unavailable; no capture authorized', {
      attemptId: id, companyId: context.companyId, runId: context.runId, agentId: context.agentId,
    });
    const log = async (outcome, reason) => {
      const result = await db.execute(UPDATE_LOG, [
        row?.wake_comment_id ?? null, row?.author_user_id ?? null,
        row?.responsible_user_id ?? null, row?.conversation_id ?? null,
        row?.invocation_source ?? null, row?.wake_reason ?? null, row?.wake_source ?? null,
        outcome, reason, ...bound,
      ]);
      if (result.rowCount !== 1) throw new Error('attempt journal missing');
    };
    const finish = async (outcome, reason) => {
      const result = await db.execute(FINISH_CLAIM, [outcome, reason, ...bound]);
      if (result.rowCount !== 1) throw new Error('claim missing');
      claimed = false;
    };
    const refuse = async reason => {
      if (claimed) await finish('refused_at_use', reason);
      await log('refused', reason);
      return { content: REFUSAL };
    };
    try {
      if (db.namespace !== NAMESPACE) throw new Error('unexpected plugin namespace');
      if ((await db.execute(START_LOG, bound)).rowCount !== 1) throw new Error('attempt not recorded');
      started = true;
      const policy = await config.get(context.companyId);
      if (!validConfig(policy)) return await refuse('not_configured');
      const params = [context.companyId, context.runId, context.agentId,
        policy.principalUserId, policy.primaryAgentId, policy.companyId];
      [row] = await db.query(READ_FACTS, params);
      if (!validArgs(args)) return await refuse('invalid_arguments');
      if (!row || row.reason !== 'eligible') return await refuse(classify(row));

      // The claim repeats ALL view checks, not a pre-read decision cached in JS.
      const result = await db.execute(CLAIM, [...params, id]);
      if (result.rowCount === 0) {
        // Classification ONLY. This can NEVER authorize, retry or issue a token.
        [row] = await db.query(READ_FACTS, params);
        return await refuse(classify(row));
      }
      if (result.rowCount !== 1) throw new Error('unexpected claim count');
      claimed = true;
      const [witness] = await db.query(READ_CLAIM, bound);
      if (!witness) throw new Error('claim witness unavailable');
      await log('claimed', 'eligible');

      // Recheck at use, including deletion after read/claim. Newest-unanswered
      // and ownership are rechecked too. No automatic reissue on any failure.
      [row] = await db.query(READ_FACTS, params);
      if (!row || row.reason !== 'eligible') return await refuse(classify(row));
      if (row.wake_comment_id !== witness.wake_comment_id) return await refuse('message_changed_at_use');
      const expiresAt = new Date(witness.expires_at).getTime();
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return await refuse('claim_expired');
      const recorded = await recorder.use({
        attemptId: id, runId: context.runId, companyId: context.companyId,
        personMessageId: witness.wake_comment_id, windowApp: args.windowApp ?? null,
        seconds: 2, microphone: false,
      });
      if (recorded.outcome !== 'not_captured' || recorded.reason !== 'stub_recorder') {
        throw new Error('only stub recorder is supported by this package');
      }
      await finish('not_captured', 'stub_recorder');
      await log('not_captured', 'stub_recorder');
      return { content: STUB_REPLY };
    } catch {
      // Do not expose backend/credential errors, and do not silently claim audit
      // persistence. No retry. A failed finalization leaves its claim reserved.
      if (claimed) {
        try { await finish('failed', 'consumer_error'); } catch { auditFault(); }
      }
      if (started) {
        try { await log('failed', 'consumer_error'); } catch { auditFault(); }
      } else auditFault();
      return { content: REFUSAL };
    }
  };
}
