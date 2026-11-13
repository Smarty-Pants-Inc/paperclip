// S9 Core fixture source: 60bf63fbed380f97da46b6242ec159ab58cbf2ae,
// server/src/services/native-runtime/sandbox-runner-retention.test.ts and
// sandbox-runner-release-resume.integration.test.ts. Only installed paths,
// nonce and binary digest are substituted for this real-process guest test.
import { createHash } from 'node:crypto';
export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const canonical = (x) => JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
export const source = { runnerInstanceId: 'runner', environmentLeaseId: 'durable-lease-A', runId: 'run-A', normalizedSessionId: 'session', turnId: 'turn', itemId: 'item' };
export const park = { op: 'park', id: `park_${sha(canonical(source))}`, identity: source, lastControllerCommandSeq: 4, ackedSourceSeq: 8 };
export const observe = { op: 'observe', id: `observe_${sha(canonical(source))}`, identity: source };
export const claim = (ticket = 'SECRET-fresh-ticket') => ({ op: 'claim', id: `claim_${sha(ticket)}`, parkId: park.id, bootstrapTicket: ticket });
export const retire = (claimed) => ({ op: 'retire', id: `retire_${sha(`${park.id}:${claimed?.id ?? 'parked'}`)}`, parkId: park.id,
  ...(claimed ? { claimId: claimed.id, identity: source, lastControllerCommandSeq: 4, ackedSourceSeq: 8 } : {}) });
export const qualify = (runnerBinary, runnerDigest) => ({ op: 'qualify', id: `qualify_${sha(JSON.stringify({ runnerBinary, runnerDigest }))}`, runnerBinary, runnerDigest });
export const launch = (command, root, environment = {}) => ({ op: 'launch', id: `launch_${sha('runner:process-A')}`, command,
  args: ['--runner-id', 'runner', '--state-dir', `${root}/state`, '--environment-lease-id', 'durable-lease-A', '--run-id', 'run-A', '--session-id', 'session', '--turn-id', 'turn', '--item-id', 'item'],
  cwd: root, environment: { PRIVATE: 'secret-launch-environment', ...environment }, identityPath: `${root}/identity`, identityNonce: 'process-A', diagnosticsDirectory: `${root}/diagnostics` });
export const wire = (frame) => JSON.stringify(frame) + '\n';
