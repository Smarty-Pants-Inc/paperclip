import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createSupervisor } from './runner-supervisor.mjs';
import { closed, decodeJson, fail, SupervisorError, validId } from './protocol.mjs';
import { IDENTITY_KEYS, MAX_FRAME_BYTES, option, parseFrame, refusal, safeSequence, sameIdentity, sha, validateFrame } from './guardian-protocol.mjs';

// Distribution/SSH staging imports this constant. No caller-controlled env or
// command argument can select a different resident endpoint in production.
export const GUARDIAN_SOCKET_PATH = '/run/paperclip-runner-guardian/control.sock';
const MAX_LOCAL_BYTES = 8 * MAX_FRAME_BYTES; // escaped JSON envelope, not S9 body
const MAX_RECEIPTS = 4096; // never evict a receipt and accidentally reapply an id

async function protectedAncestors(path, code) {
  let parent = dirname(path), protectedChild = true;
  while (true) {
    const info = await lstat(parent);
    if (!info.isDirectory() || ![0, process.getuid()].includes(info.uid)
      || ((info.mode & 0o022) && !((info.mode & 0o1000) && protectedChild))) fail(code);
    protectedChild = (info.mode & 0o022) === 0;
    if (parent === '/') return;
    parent = dirname(parent);
  }
}
async function privateDirectory(path, create = false) {
  if (!isAbsolute(path) || resolve(path) !== path) fail('UNSAFE_DIRECTORY');
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== path) fail('UNSAFE_DIRECTORY');
  await protectedAncestors(path, 'UNSAFE_DIRECTORY');
}
async function privateFile(path, maximum = 64 * 1024 * 1024) {
  await privateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > maximum) fail('UNSAFE_STATE');
    const bytes = await file.readFile();
    if (bytes.length > maximum) fail('UNSAFE_STATE');
    return { bytes, stat };
  } finally { await file.close(); }
}
async function artifact(path, digest) {
  if (!isAbsolute(path) || await realpath(path) !== path) fail('ARTIFACT_MISMATCH');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || ![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022) !== 0 || !(stat.mode & 0o111)) fail('ARTIFACT_MISMATCH');
    // Sticky shared temporary ancestors cannot replace an owned child. Other
    // writable or foreign-owned ancestors are not a task/service UID boundary.
    await protectedAncestors(path, 'ARTIFACT_MISMATCH');
    const hash = createHash('sha256');
    for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
    if (`sha256:${hash.digest('hex')}` !== digest) fail('ARTIFACT_MISMATCH');
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    fail('ARTIFACT_MISMATCH');
  } finally { await file.close(); }
}
function runJson(binary, args, timeout = 3000) {
  return new Promise((accept, reject) => {
    execFile(binary, args, { env: {}, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: MAX_FRAME_BYTES }, (error, stdout) => {
      if (error) { reject(new SupervisorError('PROOF_UNAVAILABLE')); return; }
      try { accept(decodeJson(stdout, 'PROOF_UNAVAILABLE')); } catch (caught) { reject(caught); }
    });
  });
}
async function writeMarker(path, contents) {
  await privateDirectory(dirname(path));
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail('UNSAFE_MARKER');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export async function createGuardian({ stateDir, socketPath = join(stateDir, 'control.sock'), requestTimeoutMs = 12_000, exitTimeoutMs = 1500, inputTimeoutMs = 5000 } = {}) {
  await privateDirectory(stateDir, true);
  await privateDirectory(dirname(socketPath), true);
  if (Buffer.byteLength(socketPath) >= 108) fail('UNSAFE_DIRECTORY');
  for (const value of [requestTimeoutMs, exitTimeoutMs, inputTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 120000) fail('INVALID_OPTIONS');
  const owner = await createSupervisor({ stateDir: join(stateDir, 'process'), requestTimeoutMs, preserveHostControlArgs: true });
  const receipts = new Map(), qualified = new Map(), parks = new Map();
  const sockets = new Set();
  let boundRunner, current, closing = false, closePromise, queued = 0, tail = Promise.resolve();

  async function state(record, identity, requireLive) {
    try {
      if (!record.stateDir) fail('UNSAFE_STATE');
      const status = await owner.status(record.owner.generation);
      if (requireLive && status.state !== 'running') fail('NOT_RUNNING');
      if ((await privateFile(record.identityPath, 4096)).bytes.toString() !== record.marker) fail('IDENTITY_MISMATCH');
      if (requireLive) {
        const args = (await readFile(`/proc/${record.owner.pid}/cmdline`, 'utf8')).split('\0');
        if (!args.includes(record.command) || option(args, '--runner-id') !== record.runnerId || option(args, '--state-dir') !== record.stateDir) fail('IDENTITY_MISMATCH');
      }
      const file = await privateFile(join(record.stateDir, 'runner-state.json'));
      if (file.stat.mtimeMs < record.startedMs) fail('UNSAFE_STATE');
      const saved = decodeJson(file.bytes, 'UNSAFE_STATE');
      const actual = Object.fromEntries(IDENTITY_KEYS.map(key => [key, saved[key]]));
      if (saved.schema !== 'paperclip.runner.durable.state.v1' || !sameIdentity(actual, identity)
        || saved.runnerInstanceId !== record.runnerId || (record.leaseId && saved.environmentLeaseId !== record.leaseId)
        || !safeSequence(saved.lastControllerCommandSeq) || !safeSequence(saved.ackedSourceSeq)
        || !safeSequence(saved.nextSourceSeq) || saved.ackedSourceSeq !== saved.nextSourceSeq - 1
        || !Array.isArray(saved.outbox) || saved.outbox.length !== 0 || saved.warmTransition != null
        || saved.pendingTerminalDelivery != null || saved.pendingProviderCleanup != null || saved.recoverableFailure != null
        || !saved.processedCommands || typeof saved.processedCommands !== 'object'
        || Object.values(saved.processedCommands).some(command => ['pending', 'indeterminate'].includes(command?.status))) fail('UNSAFE_STATE');
      // Recheck ownership after asynchronous reads; an exited daemon is not an
      // observation of a live source. The native park still checks the exact cut.
      if (requireLive && (await owner.status(record.owner.generation)).state !== 'running') fail('NOT_RUNNING');
      return { identity: actual, lastControllerCommandSeq: saved.lastControllerCommandSeq, ackedSourceSeq: saved.ackedSourceSeq };
    } catch (error) {
      if (error instanceof SupervisorError) throw error;
      fail('UNSAFE_STATE');
    }
  }
  async function retirementProof(record, parked) {
    try {
      if (record !== current || !record.retireAck || !await owner.waitForExit(record.owner.generation, exitTimeoutMs)) fail('RETIREMENT_UNCERTAIN');
      const cut = await state(record, parked.identity, false);
      if (cut.lastControllerCommandSeq !== parked.lastControllerCommandSeq || cut.ackedSourceSeq !== parked.ackedSourceSeq) fail('RETIREMENT_UNCERTAIN');
      const writer = decodeJson((await privateFile(join(record.stateDir, 'process-lineage', `writer-${record.owner.pid}.json`), 4096)).bytes, 'RETIREMENT_UNCERTAIN');
      if (writer.schema !== 'paperclip.runner.process-lineage-writer.v1' || writer.writer?.pid !== record.owner.pid
        || String(writer.writer.started) !== record.owner.startTime) fail('RETIREMENT_UNCERTAIN');
      await artifact(record.command, record.digest);
      const proof = await runJson(record.command, ['reap-lineage', '--state-dir', record.stateDir, '--runner-pid', String(record.owner.pid), '--grace-ms', '100', '--deadline-ms', '1000']);
      if (proof.schema !== 'paperclip.runner.process-lineage-reap.v1' || proof.verified !== true || proof.reason !== null
        || !Array.isArray(proof.remaining) || proof.remaining.length !== 0 || !safeSequence(proof.journals) || !safeSequence(proof.signalled)) fail('RETIREMENT_UNCERTAIN');
      record.retired = true;
      return { ...cut, executionStopped: true, descendantsStopped: true, sessionStateAvailable: true };
    } catch { fail('RETIREMENT_UNCERTAIN'); }
  }
  async function dispatch(runnerId, frame, raw) {
    if (frame.op === 'qualify') {
      await artifact(frame.runnerBinary, frame.runnerDigest);
      let metadata;
      try { metadata = await runJson(frame.runnerBinary, ['--build-metadata']); } catch { fail('UNSUPPORTED_PRIVATE_CONTROL'); }
      if (metadata.schema !== 'paperclip-runner/runnerd-build-metadata/v1' || metadata.binaryName !== 'paperclip-runnerd' || metadata.privateHostControlVersion !== 1) fail('UNSUPPORTED_PRIVATE_CONTROL');
      await artifact(frame.runnerBinary, frame.runnerDigest);
      boundRunner = runnerId;
      qualified.set(frame.runnerBinary, frame.runnerDigest);
      return { id: frame.id, status: 'qualified', guardianVersion: 1, privateHostControlVersion: 1, runnerBinary: frame.runnerBinary, runnerDigest: frame.runnerDigest };
    }
    if (frame.op === 'launch') {
      const digest = qualified.get(frame.command);
      if (!digest) fail('NOT_QUALIFIED');
      await artifact(frame.command, digest);
      if (current && !current.retired) fail('ALREADY_RUNNING');
      await privateDirectory(dirname(frame.identityPath), true);
      await privateDirectory(frame.diagnosticsDirectory, true);
      const daemonDiagnostics = option(frame.args, '--diagnostics-directory');
      if (daemonDiagnostics && daemonDiagnostics !== frame.diagnosticsDirectory) await privateDirectory(daemonDiagnostics, true);
      const daemonState = option(frame.args, '--state-dir');
      if (daemonState) await privateDirectory(daemonState, true);
      try {
        await lstat(frame.identityPath);
        if (!current?.retired || current.identityPath !== frame.identityPath) fail('UNSAFE_MARKER');
        if ((await privateFile(frame.identityPath, 4096)).bytes.toString() !== current.marker) fail('UNSAFE_MARKER');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Recheck after path setup, just before the synchronous spawn snapshot.
      // The trusted distribution must not mutate installed images in place.
      await artifact(frame.command, digest);
      const startedMs = Date.now(), startedAt = new Date(startedMs).toISOString();
      let owned;
      const environment = { ...frame.environment }, bootstrapTicket = environment.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
      delete environment.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
      try {
        const pending = owner.launch({ binary: frame.command, argv: frame.args, cwd: frame.cwd, env: environment,
          ...(bootstrapTicket === undefined ? {} : { bootstrapTicket }) });
        // The old owner snapshots synchronously and clears the spawn ticket.
        delete frame.environment.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
        owned = await pending;
      } finally { frame.environment = {}; }
      const marker = `${frame.identityNonce}\n${owned.pid}\n${startedAt}\n${runnerId}\nlinux:${owned.bootId}:${owned.startTime}\n`;
      current = { runnerId, owner: owned, command: frame.command, digest, stateDir: daemonState, leaseId: option(frame.args, '--environment-lease-id'),
        identityPath: frame.identityPath, marker, startedMs, retired: false, retireAck: false };
      try { await writeMarker(frame.identityPath, marker); }
      catch { await owner.terminate(owned.generation); fail('UNSAFE_MARKER'); }
      return { id: frame.id, status: 'launched' };
    }
    if (!current || current.runnerId !== runnerId) fail('NOT_OWNED');
    if (frame.op === 'observe') return { id: frame.id, status: 'observed', ...await state(current, frame.identity, true) };
    if (frame.op === 'park') {
      // The settled cut is advisory; only the unchanged native request/ACK can
      // authorize park. Do not substitute a newer state cut into the request.
      const cut = await state(current, frame.identity, true);
      if (cut.lastControllerCommandSeq !== frame.lastControllerCommandSeq || cut.ackedSourceSeq !== frame.ackedSourceSeq) fail('STALE_CUT');
      const reply = await owner.hostControl(current.owner.generation, raw, true);
      if (reply.status === 'parked') parks.set(frame.id, { ...cut, record: current, claims: new Set() });
      return reply;
    }
    const parked = parks.get(frame.parkId);
    if (!parked || parked.record !== current) fail('PARK_NOT_OWNED');
    if (frame.op === 'claim') {
      if (current.retireAck) return { id: frame.id, status: 'absent', ...await retirementProof(current, parked) };
      if ((await owner.status(current.owner.generation)).state !== 'running') fail('NOT_RUNNING');
      // Retain every possibly applied claim id, not the ticket. Retirement of
      // an ambiguous claim must name its exact original source and cut.
      parked.claims.add(frame.id);
      const reply = await owner.hostControl(current.owner.generation, raw, true);
      if (reply.status === 'conflict') parked.claims.delete(frame.id);
      return reply;
    }
    if (frame.claimId !== undefined) {
      if (!parked.claims.has(frame.claimId) || !sameIdentity(frame.identity, parked.identity)
        || frame.lastControllerCommandSeq !== parked.lastControllerCommandSeq || frame.ackedSourceSeq !== parked.ackedSourceSeq) fail('SOURCE_CONFLICT');
    } else if (parked.claims.size) fail('SOURCE_CONFLICT');
    if (!current.retireAck) {
      const reply = await owner.hostControl(current.owner.generation, raw, true);
      if (reply.status !== 'retired') return reply;
      current.retireAck = true;
      current.retireId = frame.id;
    }
    if (current.retireId !== frame.id) fail('SOURCE_CONFLICT');
    const proof = await retirementProof(current, parked);
    return { id: frame.id, status: 'retired', executionStopped: proof.executionStopped, descendantsStopped: proof.descendantsStopped, sessionStateAvailable: proof.sessionStateAvailable };
  }

  async function perform(runnerId, raw) {
    let frame, entry;
    try {
      if (closing) fail('CLOSING');
      frame = parseFrame(raw);
      if (!validId(runnerId)) fail('INVALID_RUNNER_ID');
      if (boundRunner !== undefined && boundRunner !== runnerId) fail('RUNNER_MISMATCH');
      const key = `${runnerId}:${frame.id}`, digest = sha(raw);
      entry = receipts.get(key);
      if (entry && entry.digest !== digest) fail('ID_CONFLICT');
      validateFrame(frame, runnerId);
      if (!entry) {
        if (receipts.size >= MAX_RECEIPTS) fail('RECEIPT_LIMIT');
        entry = { digest }; receipts.set(key, entry);
      }
      if (entry.reply) {
        // Qualification remains a live artifact check, even on an exact retry.
        if (frame.op === 'qualify') await artifact(frame.runnerBinary, frame.runnerDigest);
        return entry.reply;
      }
      const reply = await dispatch(runnerId, frame, raw);
      if (Buffer.byteLength(JSON.stringify(reply) + '\n') > MAX_FRAME_BYTES) fail('REPLY_TOO_LARGE');
      entry.reply = reply;
      return reply;
    } catch (error) { return refusal(frame?.id, error); }
    finally {
      if (frame?.op === 'launch') frame.environment = {};
      if (frame?.op === 'claim') delete frame.bootstrapTicket;
    }
  }
  function exchange(runnerId, raw) {
    // Snapshot bytes before queueing; a caller cannot mutate a cut in flight.
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) return Promise.resolve(refusal(null, new SupervisorError('FRAME_TOO_LARGE')));
    if (queued >= 16) return Promise.resolve(refusal(null, new SupervisorError('BUSY')));
    const bytes = Buffer.from(raw);
    queued++;
    const operation = tail.then(() => perform(runnerId, bytes));
    tail = operation.catch(() => {}).finally(() => { queued--; bytes.fill(0); });
    return operation;
  }
  const server = net.createServer(socket => {
    if (closing || sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket); socket.on('error', () => {});
    let input = Buffer.alloc(0), admitted = false;
    const timer = setTimeout(() => socket.destroy(), inputTimeoutMs);
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); input.fill(0); });
    socket.on('data', bytes => {
      if (admitted || input.length + bytes.length > MAX_LOCAL_BYTES) { socket.destroy(); return; }
      input = Buffer.concat([input, bytes]);
      const index = input.indexOf(10);
      if (index < 0) return;
      admitted = true; clearTimeout(timer);
      let envelope;
      try {
        if (index !== input.length - 1) fail('INVALID_FRAME');
        envelope = decodeJson(input.subarray(0, index), 'INVALID_FRAME');
        if (!closed(envelope, ['runnerId', 'request']) || !validId(envelope.runnerId) || typeof envelope.request !== 'string') fail('INVALID_FRAME');
      } catch { socket.destroy(); return; }
      input.fill(0); input = Buffer.alloc(0);
      // No cancellation on close. Only the short-lived reply carrier is lost.
      void exchange(envelope.runnerId, envelope.request).then(reply => {
        if (!socket.destroyed) {
          socket.end(JSON.stringify(reply) + '\n', () => socket.destroy());
          socket.setTimeout(1000, () => socket.destroy());
        }
      });
      envelope.request = '';
    });
  });
  server.on('error', () => {});
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); accept(); }); });
    await chmod(socketPath, 0o600);
  } catch { server.close(); await owner.close(); fail('LISTEN_FAILED'); }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      server.close(); for (const socket of sockets) socket.destroy();
      await tail;
      await owner.close();
      await rm(socketPath, { force: true });
    })();
    return closePromise;
  }
  return { socketPath, exchange, close };
}
