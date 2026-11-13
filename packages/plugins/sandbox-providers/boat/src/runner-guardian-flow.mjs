// Keep: trust-boundary and data-safety tests. Real Unix sockets/processes;
// fake native peer is explicit. Boat + real runnerd qualification remains separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, mkdir, lstat, readdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { source, sha, canonical, qualify, launch, observe, park, claim, retire, wire } from './test-fixtures/s9-frames.mjs';
import { createGuardian, GUARDIAN_SOCKET_PATH } from '../guest/guardian.mjs';
const guest = new URL('../guest/', import.meta.url);

async function fixture(t, mode = '') {
  // Short socket paths are mandatory even when the task TMPDIR is long.
  const root = await mkdtemp(join(tmpdir(), 'ga-'));
  const binary = join(root, 'runnerd');
  const fake = await readFile(new URL('./test-fixtures/s9-runnerd.mjs', import.meta.url), 'utf8');
  await writeFile(binary, `#!${process.execPath}\n${fake}`, { mode: 0o700 });
  const guardian = await createGuardian({ stateDir: join(root, 'g'), requestTimeoutMs: 180, exitTimeoutMs: 300 });
  t.after(() => guardian.close());
  const q = qualify(binary, `sha256:${sha(await readFile(binary))}`);
  const l = launch(binary, root, { FAKE_MODE: mode });
  const rpc = (f, runner = 'runner') => guardian.exchange(runner, wire(f));
  const start = async () => {
    assert.equal((await rpc(q)).status, 'qualified');
    assert.deepEqual(await rpc(l), { id: l.id, status: 'launched' });
    // File readiness is an active startup obligation, not an idle poller.
    for (let i = 0; i < 100; i++) {
      try { await readFile(join(root, 'state/runner-state.json')); break; } catch { await delay(5); }
    }
  };
  return { root, binary, guardian, q, l, rpc, start };
}
function code(reply, expected) { assert.equal(reply.status, 'refused'); assert.equal(reply.error.code, expected); }
async function socketRpc(path, runnerId, raw, lost = false) {
  const socket = net.createConnection(path); socket.on('error', () => {});
  await once(socket, 'connect');
  const result = new Promise((resolve, reject) => {
    let input = '';
    socket.on('data', (b) => { input += b; });
    socket.on('end', () => { try { resolve(JSON.parse(input)); } catch (error) { reject(error); } });
    socket.on('error', reject);
  });
  socket.write(JSON.stringify({ runnerId, request: raw }) + '\n');
  if (lost) { void result.catch(() => {}); socket.destroy(); return; }
  return result;
}

async function clientRpc(path, raw, runnerId = 'runner') {
  const entry = new URL('guardian-client.mjs', guest).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { guardianClient } from ${JSON.stringify(entry)}; process.exitCode = await guardianClient({runnerId:process.argv[2], socketPath:process.argv[1], timeoutMs:2000});`, path, runnerId], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.stdin.end(raw); const [exit] = await once(child, 'exit');
  assert.equal(stderr, ''); assert.ok([0, 1].includes(exit));
  assert.equal(stdout.split('\n').length, 2); assert.ok(Buffer.byteLength(stdout) <= 16384);
  return JSON.parse(stdout);
}

test('Core frames: qualify → launch → observe → park → claim → retire through short-lived clients', async (t) => {
  const f = await fixture(t), rpc = frame => clientRpc(f.guardian.socketPath, wire(frame));
  assert.equal((await rpc(f.q)).status, 'qualified'); assert.equal((await rpc(f.l)).status, 'launched');
  assert.deepEqual(await rpc(observe), { id: observe.id, status: 'observed', identity: source, lastControllerCommandSeq: 4, ackedSourceSeq: 8 });
  assert.deepEqual(await rpc(park), { id: park.id, status: 'parked' });
  assert.deepEqual(await rpc(claim()), { id: claim().id, status: 'claimed' });
  assert.deepEqual(await rpc(retire(claim())), { id: retire(claim()).id, status: 'retired', executionStopped: true, descendantsStopped: true, sessionStateAvailable: true });
  assert.deepEqual(await rpc(retire(claim())), { id: retire(claim()).id, status: 'retired', executionStopped: true, descendantsStopped: true, sessionStateAvailable: true });
});
test('actual daemon marker has exactly five LF lines, atomic private mode and birth', async (t) => {
  const f = await fixture(t); await f.start();
  const text = await readFile(f.l.identityPath, 'utf8'), lines = text.split('\n');
  assert.equal(lines.length, 6); assert.equal(lines[5], '');
  assert.equal(lines[0], 'process-A'); assert.equal(lines[3], 'runner');
  assert.equal(new Date(lines[2]).toISOString(), lines[2]);
  const pid = Number(lines[1]); assert.ok(pid > 1 && pid !== process.pid);
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  assert.equal(lines[4], `linux:${(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`);
  assert.equal((await lstat(f.l.identityPath)).mode & 0o777, 0o600);
  const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8'); assert.ok(cmd.includes(f.binary));
  assert.ok(cmd.includes('--host-control-fd\x004\x00'));
  assert.equal((await lstat(f.l.diagnosticsDirectory)).mode & 0o777, 0o700);
  assert.ok(!(await readdir(f.root)).some(x => x.includes('.tmp-')));
});
test('exact launch replay never duplicates; id reuse conflicts; second nonce held until retirement', async (t) => {
  const f = await fixture(t); await f.start(); const marker = await readFile(f.l.identityPath, 'utf8');
  assert.equal((await f.rpc(f.l)).status, 'launched'); assert.equal(await readFile(f.l.identityPath, 'utf8'), marker);
  code(await f.rpc({ ...f.l, cwd: '/' }), 'ID_CONFLICT');
  const next = { ...f.l, id: `launch_${sha('runner:process-B')}`, identityNonce: 'process-B' };
  code(await f.rpc(next), 'ALREADY_RUNNING');
  await f.rpc(park); assert.equal((await f.rpc(retire())).status, 'retired');
  // A refused id is still bound to its original bytes; use a fresh nonce.
  const cold = { ...f.l, id: `launch_${sha('runner:process-C')}`, identityNonce: 'process-C' };
  assert.equal((await f.rpc(cold)).status, 'launched'); assert.notEqual(await readFile(f.l.identityPath, 'utf8'), marker);
});
test('lost client replies retain launch/claim receipts and leave fd4 alive', async (t) => {
  const f = await fixture(t, 'delay-claim'); await f.start();
  await socketRpc(f.guardian.socketPath, 'runner', wire(f.l), true);
  assert.equal((await socketRpc(f.guardian.socketPath, 'runner', wire(f.l))).status, 'launched');
  await f.rpc(park);
  await socketRpc(f.guardian.socketPath, 'runner', wire(claim()), true);
  const replay = await socketRpc(f.guardian.socketPath, 'runner', wire(claim()));
  assert.deepEqual(replay, { id: claim().id, status: 'claimed' });
  assert.equal((await f.rpc(retire(claim()))).status, 'retired');
});
test('lost native claim ACK retries same bytes; changed id/ticket cannot cross uncertainty', async (t) => {
  const f = await fixture(t, 'drop-first-claim'); await f.start(); await f.rpc(park);
  code(await f.rpc(claim()), 'REPLY_TIMEOUT');
  code(await f.rpc(claim('different-ticket')), 'UNCERTAIN');
  assert.equal((await f.rpc(claim())).status, 'claimed');
});
test('byte identity includes key order and whitespace, not just parsed values', async (t) => {
  const f = await fixture(t); await f.start(); await f.rpc(park);
  code(await f.guardian.exchange('runner', JSON.stringify(park) + ' \n'), 'ID_CONFLICT');
  code(await f.rpc({ ...claim(), parkId: 'park_wrong' }), 'PARK_NOT_OWNED');
});
test('qualify verifies actual installed digest and private host-control build metadata', async (t) => {
  const f = await fixture(t);
  code(await f.rpc(qualify(f.binary, `sha256:${'0'.repeat(64)}`)), 'ARTIFACT_MISMATCH');
  assert.equal((await f.rpc(f.q)).status, 'qualified');
  await writeFile(f.binary, '#!/bin/sh\necho \'{"privateHostControlVersion":0}\'\n', { mode: 0o700 });
  code(await f.rpc(f.l), 'ARTIFACT_MISMATCH');
  const changed = qualify(f.binary, `sha256:${sha(await readFile(f.binary))}`);
  code(await f.rpc(changed), 'UNSUPPORTED_PRIVATE_CONTROL');
});
test('only launch bootstrap env is admitted; ticket never appears in responses/files/guardian env', async (t) => {
  const f = await fixture(t); const ticket = 'cold-bootstrap-canary-private';
  f.l.environment.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET = ticket; f.l.environment.EXPECTED_BOOTSTRAP_SHA256 = sha(ticket);
  await f.start();
  assert.ok(!(await readFile(`/proc/${process.pid}/environ`, 'utf8')).includes(ticket));
  for (const path of [f.l.identityPath, join(f.root, 'state/runner-state.json')]) assert.ok(!(await readFile(path, 'utf8')).includes(ticket));
  const reply = await f.rpc(f.l); assert.ok(!JSON.stringify(reply).includes(ticket));
  code(await f.rpc({ ...f.l, id: `launch_${sha('runner:secret')}`, identityNonce: 'secret', environment: { API_KEY: ticket } }), 'INVALID_LAUNCH');
});
test('observe rejects all six identity mismatches, unsafe cuts, unsettled state and symlinks', async (t) => {
  const f = await fixture(t); await f.start();
  for (const key of Object.keys(source)) {
    const identity = { ...source, [key]: 'wrong' };
    const request = { op: 'observe', id: `observe_${sha(canonical(identity))}`, identity };
    const result = await f.rpc(request); assert.equal(result.status, 'refused', key);
  }
  const path = join(f.root, 'state/runner-state.json'), saved = await readFile(path, 'utf8');
  await writeFile(path, JSON.stringify({ ...JSON.parse(saved), ackedSourceSeq: 9007199254740992 }));
  code(await f.rpc(observe), 'UNSAFE_STATE');
  await writeFile(path, JSON.stringify({ ...JSON.parse(saved), nextSourceSeq: 10 }));
  code(await f.rpc(observe), 'UNSAFE_STATE');
  await unlink(path); await symlink(join(f.root, 'elsewhere'), path);
  code(await f.rpc(observe), 'UNSAFE_STATE');
});
for (const mode of ['retire-stays-live', 'deny-proof', 'retire-no-state']) test(`retire proof withheld: ${mode}`, async (t) => {
  const f = await fixture(t, mode); await f.start(); await f.rpc(park);
  const reply = await f.rpc(retire()); code(reply, 'RETIREMENT_UNCERTAIN');
  for (const key of ['executionStopped', 'descendantsStopped', 'sessionStateAvailable']) assert.ok(!(key in reply));
  assert.notEqual((await f.rpc(claim())).status, 'absent');
});
test('claim absence requires exact native retirement, exit, lineage and same source/cut state', async (t) => {
  const f = await fixture(t); await f.start(); await f.rpc(park); await f.rpc(retire());
  assert.deepEqual(await f.rpc(claim()), { id: claim().id, status: 'absent', identity: source, lastControllerCommandSeq: 4, ackedSourceSeq: 8, executionStopped: true, descendantsStopped: true, sessionStateAvailable: true });
});
test('unknown runner, stale park, arbitrary ids and incomplete claimed retire are held', async (t) => {
  const f = await fixture(t); await f.start();
  code(await f.rpc(observe, 'other'), 'RUNNER_MISMATCH');
  code(await f.rpc(claim()), 'PARK_NOT_OWNED');
  code(await f.rpc({ ...park, id: 'arbitrary' }), 'INVALID_ID');
  await f.rpc(park);
  code(await f.rpc({ ...retire(claim()), identity: undefined }), 'INVALID_FRAME');
});
test('16 KiB including LF; duplicates, extra lines, invalid UTF8, and missing LF refused', async (t) => {
  const f = await fixture(t);
  code(await f.guardian.exchange('runner', ' '.repeat(16384) + '\n'), 'FRAME_TOO_LARGE');
  code(await f.guardian.exchange('runner', wire(f.q) + '\n'), 'INVALID_FRAME');
  code(await f.guardian.exchange('runner', wire(f.q).trim()), 'INVALID_FRAME');
  code(await f.guardian.exchange('runner', Buffer.from([0xff, 10])), 'INVALID_FRAME');
  code(await f.guardian.exchange('runner', '{"id":"x","id":"y","op":"observe"}\n'), 'INVALID_FRAME');
  const raw = wire(f.q); const exact = raw.slice(0, -1) + ' '.repeat(16384 - Buffer.byteLength(raw)) + '\n';
  assert.equal(Buffer.byteLength(exact), 16384); assert.equal((await f.guardian.exchange('runner', exact)).status, 'qualified');
});
test('client command validates runner ID before contacting the fixed resident endpoint', async () => {
  assert.equal(GUARDIAN_SOCKET_PATH, '/run/paperclip-runner-guardian/control.sock');
  const child = spawn(process.execPath, [new URL('paperclip-runner-guardian', guest).pathname, 'client', '--protocol', '1', '--runner-id', 'other'], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.stdin.end(wire(observe)); const [exit] = await once(child, 'exit');
  assert.equal(exit, 1); assert.equal(stderr, ''); const reply = JSON.parse(stdout); assert.equal(reply.id, observe.id); code(reply, 'RUNNER_MISMATCH');
});
test('native bytes stay unchanged; existing fd4 and credential-file args stay intact', async (t) => {
  const f = await fixture(t);
  const raw = JSON.stringify({ identity: source, ackedSourceSeq: 8, op: 'park', id: park.id, lastControllerCommandSeq: 4 }) + '\n';
  f.l.environment.EXPECTED_PARK_SHA256 = sha(raw.slice(0, -1));
  f.l.environment.EXPECTED_CLAIM_SHA256 = sha(wire(claim()).slice(0, -1));
  f.l.environment.EXPECTED_RETIRE_SHA256 = sha(wire(retire(claim())).slice(0, -1));
  f.l.args.unshift('--host-control-fd', '4');
  f.l.args.push('--credential-file', join(f.root, 'credential.json'), '--bootstrap-file', join(f.root, 'bootstrap.json'));
  await f.start();
  const pid = Number((await readFile(f.l.identityPath, 'utf8')).split('\n')[1]);
  const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  assert.equal(argv.filter(x => x === '--host-control-fd').length, 1);
  assert.deepEqual(argv.slice(argv.indexOf('--host-control-fd'), -1), f.l.args);
  assert.equal((await f.guardian.exchange('runner', raw)).status, 'parked');
  assert.equal((await f.rpc(claim())).status, 'claimed');
  assert.equal((await f.rpc(retire(claim()))).status, 'retired');
});
test('abrupt daemon loss is held; never absence or permission for a replacement', async (t) => {
  const f = await fixture(t); await f.start(); await f.rpc(park);
  const pid = Number((await readFile(f.l.identityPath, 'utf8')).split('\n')[1]);
  process.kill(pid, 'SIGKILL'); await delay(30);
  const reply = await f.rpc(claim()); assert.equal(reply.status, 'refused');
  code(await f.rpc({ ...f.l, id: `launch_${sha('runner:after-crash')}`, identityNonce: 'after-crash' }), 'ALREADY_RUNNING');
});
test('absent-proof refusals: missing writer, wrong birth, wrong state source, wrong cut', async (t) => {
  for (const kind of ['missing-writer', 'wrong-birth', 'wrong-source', 'wrong-cut']) {
    const f = await fixture(t); await f.start(); await f.rpc(park);
    const pid = Number((await readFile(f.l.identityPath, 'utf8')).split('\n')[1]);
    const writerPath = join(f.root, `state/process-lineage/writer-${pid}.json`);
    if (kind === 'missing-writer') await unlink(writerPath);
    if (kind === 'wrong-birth') {
      const writer = JSON.parse(await readFile(writerPath, 'utf8')); writer.writer.started++;
      await writeFile(writerPath, JSON.stringify(writer));
    }
    assert.equal((await f.rpc(retire())).status, kind.startsWith('wrong-') && kind !== 'wrong-birth' ? 'retired' : 'refused');
    if (kind === 'wrong-source' || kind === 'wrong-cut') {
      const path = join(f.root, 'state/runner-state.json'), saved = JSON.parse(await readFile(path, 'utf8'));
      if (kind === 'wrong-source') saved.environmentLeaseId = 'other-allocation'; else saved.lastControllerCommandSeq++;
      await writeFile(path, JSON.stringify(saved));
    }
    assert.equal((await f.rpc(claim())).status, 'refused', kind);
  }
});
test('unsafe marker and directories refuse launch before child creation', async (t) => {
  for (const kind of ['marker-symlink', 'diagnostics-symlink', 'diagnostics-permissions', 'writable-ancestor']) {
    const f = await fixture(t); await f.rpc(f.q);
    if (kind === 'marker-symlink') await symlink(join(f.root, 'target'), f.l.identityPath);
    if (kind === 'diagnostics-symlink') await symlink(f.root, f.l.diagnosticsDirectory);
    if (kind === 'diagnostics-permissions') { await mkdir(f.l.diagnosticsDirectory, { mode: 0o755 }); await chmod(f.l.diagnosticsDirectory, 0o755); }
    if (kind === 'writable-ancestor') {
      const parent = join(f.root, 'unsafe'); await mkdir(parent); await chmod(parent, 0o777);
      f.l.diagnosticsDirectory = join(parent, 'diagnostics');
    }
    assert.equal((await f.rpc(f.l)).status, 'refused', kind);
  }
});
test('observe checks actual stored source, current marker, warm transitions and pending commands', async (t) => {
  for (const kind of ['stored-source', 'marker', 'transition', 'pending']) {
    const f = await fixture(t); await f.start();
    const path = join(f.root, 'state/runner-state.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'stored-source') saved.environmentLeaseId = 'other';
    if (kind === 'transition') saved.warmTransition = { phase: 'activating' };
    if (kind === 'pending') saved.processedCommands = { command: { status: 'pending' } };
    if (kind === 'marker') await writeFile(f.l.identityPath, 'forged\n'); else await writeFile(path, JSON.stringify(saved));
    assert.equal((await f.rpc(observe)).status, 'refused', kind);
  }
});
test('client bounds input and rejects extra frames before admission', async (t) => {
  const f = await fixture(t);
  code(await clientRpc(f.guardian.socketPath, wire(f.q) + wire(f.q)), 'INVALID_FRAME');
  code(await clientRpc(f.guardian.socketPath, 'x'.repeat(16385)), 'FRAME_TOO_LARGE');
  code(await clientRpc(f.guardian.socketPath, wire(f.q).trim()), 'INVALID_FRAME');
  code(await clientRpc(f.guardian.socketPath, Buffer.from([0xff, 10])), 'INVALID_FRAME');
  const raw = wire(f.q), exact = raw.slice(0, -1) + ' '.repeat(16384 - Buffer.byteLength(raw)) + '\n';
  assert.equal((await clientRpc(f.guardian.socketPath, exact)).status, 'qualified');
});
test('client rejects oversized, extra-line, malformed and wrong-id resident replies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gr-')), path = join(root, 's');
  let response;
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.once('data', () => socket.end(response)); });
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const reply of ['x'.repeat(16385), '{}\n{}\n', '{\n', JSON.stringify({ id: 'wrong', status: 'observed' }) + '\n']) {
    response = reply; code(await clientRpc(path, wire(observe)), 'INVALID_REPLY');
  }
});
test('native conflicts and wrong-id replies are not synthesized into park or absence', async (t) => {
  for (const mode of ['native-conflict', 'wrong-id']) {
    const f = await fixture(t, mode); await f.start();
    assert.equal((await f.rpc(park)).status, mode === 'native-conflict' ? 'conflict' : 'refused');
    assert.notEqual((await f.rpc(claim())).status, 'absent');
  }
});

test('CLI launch mismatch and identity-less claim cannot cross the bound Runner', async (t) => {
  const f = await fixture(t); await f.start(); await f.rpc(park);
  code(await clientRpc(f.guardian.socketPath, wire(f.l), 'other'), 'RUNNER_MISMATCH');
  const reply = await clientRpc(f.guardian.socketPath, wire(claim()), 'other');
  assert.equal(reply.id, claim().id); code(reply, 'RUNNER_MISMATCH');
  assert.equal((await f.rpc(claim())).status, 'claimed');
});
test('concurrent launch retries share one owner and duplicate identity flags fail before spawn', async (t) => {
  const f = await fixture(t); await f.rpc(f.q);
  const invalid = { ...f.l, args: [...f.l.args, '--environment-lease-id', 'other'] };
  code(await f.rpc(invalid), 'INVALID_LAUNCH');
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.rpc(f.l)));
  assert.deepEqual(replies, Array(8).fill({ id: f.l.id, status: 'launched' }));
  await f.start(); assert.equal((await f.rpc(park)).status, 'parked');
});

test('client function real stdin/stdout boundary forwards one request and exits without daemon death', async (t) => {
  const f = await fixture(t); await f.start();
  const entry = new URL('guardian-client.mjs', guest).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { guardianClient } from ${JSON.stringify(entry)}; process.exitCode = await guardianClient({runnerId:'runner', socketPath:process.argv[1]});`, f.guardian.socketPath], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.stdin.end(wire(observe)); const [exit] = await once(child, 'exit');
  assert.equal(exit, 0); assert.equal(stderr, ''); assert.equal(JSON.parse(stdout).status, 'observed');
  assert.equal((await f.rpc(park)).status, 'parked');
});
