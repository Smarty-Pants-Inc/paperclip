import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { closed, decodeJson, fail, MAX_FRAME_BYTES, SupervisorError, validId, validString, validateHostFrame } from './protocol.mjs';
export { MAX_FRAME_BYTES };
export const IDENTITY_KEYS = ['runnerInstanceId', 'environmentLeaseId', 'runId', 'normalizedSessionId', 'turnId', 'itemId'];
export const sha = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
export const identityValid = (value) => closed(value, IDENTITY_KEYS) && IDENTITY_KEYS.every(k => validString(value[k]));
export const sameIdentity = (a, b) => identityValid(a) && identityValid(b) && IDENTITY_KEYS.every(k => a[k] === b[k]);
export const safeSequence = (value) => Number.isSafeInteger(value) && value >= 0;
const clean = (value) => validString(value) && !value.includes('\0');
const path = (value) => clean(value) && isAbsolute(value);
export function refusal(id, error) {
  return { id: validId(id) ? id : null, status: 'refused', error: { code: error instanceof SupervisorError ? error.code : 'INTERNAL_ERROR' } };
}
export function option(args, key) {
  const matches = args.flatMap((value, index) => value === key ? [index] : []);
  if (matches.length > 1 || args.some(value => value.startsWith(key + '='))) fail('INVALID_LAUNCH');
  if (!matches.length) return undefined;
  const value = args[matches[0] + 1];
  if (!clean(value) || !value.length || value.startsWith('--')) fail('INVALID_LAUNCH');
  return value;
}
export function parseFrame(raw) {
  if (!(typeof raw === 'string' || Buffer.isBuffer(raw))) fail('INVALID_FRAME');
  if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) fail('FRAME_TOO_LARGE');
  const bytes = Buffer.from(raw);
  if (bytes.length < 2 || bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1) fail('INVALID_FRAME');
  const frame = decodeJson(bytes.subarray(0, -1), 'INVALID_FRAME');
  if (!frame || !validId(frame.id)) fail('INVALID_FRAME');
  return frame;
}
export function validateFrame(frame, runnerId) {
  if (!validId(runnerId)) fail('INVALID_RUNNER_ID');
  let expected;
  switch (frame.op) {
    case 'qualify':
      if (!closed(frame, ['op', 'id', 'runnerBinary', 'runnerDigest']) || !path(frame.runnerBinary)
        || !/^sha256:[0-9a-f]{64}$/.test(frame.runnerDigest)) fail('INVALID_FRAME');
      expected = `qualify_${sha(JSON.stringify({ runnerBinary: frame.runnerBinary, runnerDigest: frame.runnerDigest }))}`;
      break;
    case 'launch': {
      if (!closed(frame, ['op', 'id', 'command', 'args', 'cwd', 'environment', 'identityPath', 'identityNonce', 'diagnosticsDirectory'])
        || !path(frame.command) || !path(frame.cwd) || !path(frame.identityPath) || !path(frame.diagnosticsDirectory)
        || !validId(frame.identityNonce) || !Array.isArray(frame.args) || !frame.args.every(clean)
        || frame.args.includes('--') || !frame.environment || typeof frame.environment !== 'object' || Array.isArray(frame.environment)
        || !Object.entries(frame.environment).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && clean(value)
          && (key === 'PAPERCLIP_RUNNER_BOOTSTRAP_TICKET' ? !/^\p{White_Space}*$/u.test(value)
            : !/(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|BOOTSTRAP_TICKET)/i.test(key)))) fail('INVALID_LAUNCH');
      if (option(frame.args, '--runner-id') !== runnerId) fail('RUNNER_MISMATCH');
      const fd = option(frame.args, '--host-control-fd');
      if (fd !== undefined && fd !== '4') fail('INVALID_LAUNCH');
      const state = option(frame.args, '--state-dir');
      const diagnostics = option(frame.args, '--diagnostics-directory');
      if ((state !== undefined && !path(state)) || (diagnostics !== undefined && !path(diagnostics))) fail('INVALID_LAUNCH');
      for (const flag of ['--environment-lease-id', '--run-id', '--session-id', '--turn-id', '--item-id']) option(frame.args, flag);
      expected = `launch_${sha(`${runnerId}:${frame.identityNonce}`)}`;
      break;
    }
    case 'observe':
      if (!closed(frame, ['op', 'id', 'identity']) || !identityValid(frame.identity)) fail('INVALID_FRAME');
      expected = `observe_${sha(canonical(frame.identity))}`;
      break;
    case 'park':
    case 'claim':
    case 'retire': {
      validateHostFrame(frame);
      if (frame.identity && !identityValid(frame.identity)) fail('INVALID_FRAME');
      for (const key of ['lastControllerCommandSeq', 'ackedSourceSeq']) if (key in frame && !safeSequence(frame[key])) fail('INVALID_FRAME');
      if (frame.op === 'park') expected = `park_${sha(canonical(frame.identity))}`;
      if (frame.op === 'claim') expected = `claim_${sha(frame.bootstrapTicket)}`;
      if (frame.op === 'retire') {
        const cut = ['claimId', 'identity', 'lastControllerCommandSeq', 'ackedSourceSeq'];
        if (cut.some(k => k in frame) && (!cut.every(k => k in frame) || !validId(frame.claimId) || !identityValid(frame.identity))) fail('INVALID_FRAME');
        expected = `retire_${sha(`${frame.parkId}:${frame.claimId ?? 'parked'}`)}`;
      }
      break;
    }
    default: fail('INVALID_FRAME');
  }
  if (frame.identity && frame.identity.runnerInstanceId !== runnerId) fail('RUNNER_MISMATCH');
  if (frame.id !== expected) fail('INVALID_ID');
}
