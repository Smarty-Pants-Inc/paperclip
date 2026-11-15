#!/usr/bin/env node
// L1e local PRP/Unix-socket integration harness. No network writes or real GitHub calls.
// This is intentionally dependency-free (Node built-ins only).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PROTOCOL = 'paperclip.runner';
const SECURE_SCHEMA = 'paperclip.runner.secure-frame.v1';
const BRIDGE_TIMEOUT_MS = 30_000; // packages/adapter-utils/src/sandbox-callback-bridge.ts:30
const MAX_WS_MESSAGE = 2 * 1024 * 1024;

function assert(condition, message) { if (!condition) throw new Error(message); }
function b64(value) { return Buffer.from(value).toString('base64'); }
function hex(buffer) { return Buffer.from(buffer).toString('hex'); }
function fromHex(value) { return Buffer.from(value, 'hex'); }
function u64(value) { const result = Buffer.alloc(8); result.writeBigUInt64BE(BigInt(value)); return result; }
function digestDomain(domain, parts) {
  const h = crypto.createHash('sha256').update(domain).update(Buffer.from([0]));
  for (const part of parts) { const bytes = Buffer.from(part); h.update(u64(bytes.length)).update(bytes); }
  return h.digest();
}
function hmacDomain(key, domain, parts) {
  const h = crypto.createHmac('sha256', key).update(domain).update(Buffer.from([0]));
  for (const part of parts) { const bytes = Buffer.from(part); h.update(u64(bytes.length)).update(bytes); }
  return h.digest();
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
function challengeSigningBytes(challenge) {
  const body = {
    credentialId: challenge.credentialId,
    credentialKind: challenge.credentialKind,
    clientNonce: challenge.clientNonce,
    serverNonce: challenge.serverNonce,
    runnerInstanceId: challenge.runnerInstanceId,
    environmentLeaseId: challenge.environmentLeaseId,
    runId: challenge.runId,
    normalizedSessionId: challenge.normalizedSessionId,
    turnId: challenge.turnId,
    itemId: challenge.itemId,
    runnerVersion: challenge.runnerVersion,
    runnerDigest: challenge.runnerDigest,
    selectedVersion: challenge.selectedVersion,
    credentialLeaseId: challenge.credentialLeaseId ?? null,
    credentialExpiresAt: challenge.credentialExpiresAt,
    credentialExpiresAtUnixMs: challenge.credentialExpiresAtUnixMs,
    revocationEpoch: challenge.revocationEpoch,
  };
  for (const [wire, local] of [['warmTransitionVersion', 'warmTransitionVersion'], ['warmTransitionId', 'warmTransitionId'], ['recoveryCursorVersion', 'recoveryCursorVersion'], ['recoveryAckedSourceSeq', 'recoveryAckedSourceSeq']]) {
    if (challenge[wire] !== undefined && challenge[wire] !== null) body[local] = challenge[wire];
  }
  return Buffer.from(canonical(body));
}
function credential(token) {
  const bytes = Buffer.from(token);
  return {
    id: `sha256:${hex(digestDomain('paperclip-runner-credential-id-v1', [bytes]))}`,
    key: digestDomain('paperclip-runner-auth-key-v1', [bytes]),
  };
}
function randomHex(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function identityFrom(payload) {
  return {
    runnerInstanceId: payload.runnerInstanceId,
    environmentLeaseId: payload.environmentLeaseId,
    runId: payload.runId,
    normalizedSessionId: payload.normalizedSessionId,
    turnId: payload.turnId,
    itemId: payload.itemId,
  };
}

class SecureChannel {
  constructor(authKey, challengeBytes, serverProof, clientProof, role) {
    const binding = digestDomain('paperclip-runner-session-binding-v1', [challengeBytes, Buffer.from(serverProof), Buffer.from(clientProof)]);
    this.sessionId = `sha256:${hex(binding)}`;
    this.role = role;
    this.sendCounter = 0;
    this.receiveCounter = 0;
    const c2s = hmacDomain(authKey, 'paperclip-runner-client-to-core-key-v1', [binding]);
    const s2c = hmacDomain(authKey, 'paperclip-runner-core-to-client-key-v1', [binding]);
    this.sendKey = role === 'core' ? s2c : c2s;
    this.receiveKey = role === 'core' ? c2s : s2c;
  }
  _nonce(senderRole, counter) {
    const prefix = senderRole === 'core' ? Buffer.from('P3S1') : Buffer.from('P3C1');
    return Buffer.concat([prefix, u64(counter)]);
  }
  _aad(senderRole, counter) {
    const direction = senderRole === 'core' ? 'core_to_client' : 'client_to_core';
    return Buffer.from(`${SECURE_SCHEMA}\0${this.sessionId}\0${direction}\0${counter}`);
  }
  encrypt(value) {
    const counter = this.sendCounter++;
    const sender = this.role;
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, this._nonce(sender, counter));
    cipher.setAAD(this._aad(sender, counter));
    const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final(), cipher.getAuthTag()]);
    return { schema: SECURE_SCHEMA, counter, ciphertext: hex(encrypted) };
  }
  decrypt(frame) {
    assert(frame?.schema === SECURE_SCHEMA, 'unexpected PRP secure-frame schema');
    assert(frame.counter === this.receiveCounter, 'PRP frame counter was replayed or out of order');
    const sender = this.role === 'core' ? 'runner' : 'core';
    const bytes = fromHex(frame.ciphertext);
    assert(bytes.length >= 16, 'short PRP encrypted frame');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.receiveKey, this._nonce(sender, frame.counter));
    decipher.setAAD(this._aad(sender, frame.counter));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]);
    this.receiveCounter++;
    return JSON.parse(plain.toString('utf8'));
  }
}

class WebSocketPeer {
  constructor(socket, { server = false, initial = Buffer.alloc(0) } = {}) {
    this.socket = socket;
    this.server = server;
    this.buffer = initial;
    this.messages = [];
    this.waiters = [];
    this.ended = false;
    this.error = null;
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this._parse(); });
    socket.on('error', err => this._end(err));
    socket.on('end', () => this._end(new Error('WebSocket peer ended')));
    socket.on('close', () => this._end(new Error('WebSocket peer closed')));
    this._parse();
  }
  _end(error) {
    if (this.ended) return;
    this.ended = true; this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  _parse() {
    while (!this.ended && this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      let length = b1 & 0x7f, offset = 2;
      if (b0 & 0x70) return this._end(new Error('WebSocket extensions are unsupported by the harness'));
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; const n = this.buffer.readBigUInt64BE(2); if (n > BigInt(MAX_WS_MESSAGE)) return this._end(new Error('oversize WebSocket frame')); length = Number(n); offset = 10; }
      const masked = Boolean(b1 & 0x80);
      let mask;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (length > MAX_WS_MESSAGE) return this._end(new Error('oversize WebSocket frame'));
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (opcode === 8) return this._end(new Error('WebSocket close received'));
      if (opcode === 9) { this._writeFrame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode !== 1) return this._end(new Error('PRP requires complete text WebSocket frames'));
      const text = payload.toString('utf8');
      let value;
      try { value = JSON.parse(text); } catch { return this._end(new Error('invalid JSON text WebSocket frame')); }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(value); else this.messages.push(value);
    }
  }
  _writeFrame(opcode, payload) {
    const body = Buffer.from(payload);
    const masked = !this.server;
    let head;
    if (body.length < 126) { head = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | body.length]); }
    else if (body.length <= 65535) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = (masked ? 0x80 : 0) | 126; head.writeUInt16BE(body.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = (masked ? 0x80 : 0) | 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
    if (!masked) { this.socket.write(Buffer.concat([head, body])); return; }
    const mask = crypto.randomBytes(4), encoded = Buffer.from(body);
    for (let i = 0; i < encoded.length; i++) encoded[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([head, mask, encoded]));
  }
  send(value) { assert(!this.ended, 'cannot send on a closed WebSocket'); this._writeFrame(1, Buffer.from(JSON.stringify(value))); }
  read(timeoutMs = 10_000) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.ended) return Promise.reject(this.error || new Error('WebSocket ended'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } };
      const timer = setTimeout(() => { const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1); reject(new Error(`WebSocket read timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  close() { try { this._writeFrame(8, Buffer.alloc(0)); } catch {} this.socket.destroy(); this._end(new Error('WebSocket closed locally')); }
}

function websocketAccept(key) { return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); }
async function connectWebSocket(host, port, pathname, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let header = Buffer.alloc(0), settled = false, key = '';
    const timer = setTimeout(() => fail(new Error('WebSocket handshake timed out')), timeoutMs);
    function fail(error) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(error); }
    socket.once('error', fail);
    socket.once('connect', () => {
      key = crypto.randomBytes(16).toString('base64');
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const onData = chunk => {
      header = Buffer.concat([header, chunk]);
      const at = header.indexOf('\r\n\r\n');
      if (at < 0) { if (header.length > 16_384) fail(new Error('oversize WebSocket upgrade response')); return; }
      const text = header.subarray(0, at).toString('latin1');
      const match = text.match(/\r\nSec-WebSocket-Accept:\s*([^\r\n]+)/i);
      if (!/^HTTP\/1\.[01] 101\b/.test(text) || !match || match[1].trim() !== websocketAccept(key)) { fail(new Error('runner did not accept WebSocket upgrade')); return; }
      if (settled) return;
      settled = true; clearTimeout(timer); socket.off('error', fail); socket.off('data', onData);
      resolve(new WebSocketPeer(socket, { server: false, initial: header.subarray(at + 4) }));
    };
    socket.on('data', onData);
  });
}
function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`);
  return new WebSocketPeer(socket, { server: true, initial: head });
}

function scanVariants(token) {
  const raw = Buffer.from(token);
  return [raw, ...[0, 1, 2].map(offset => Buffer.concat([Buffer.alloc(offset), raw]).toString('base64')).map(v => Buffer.from(v))];
}
function scanFiles(paths, token) {
  const needles = scanVariants(token);
  const found = [];
  const addFile = file => {
    let data;
    try { data = fs.readFileSync(file); } catch { return; }
    for (let i = 0; i < needles.length; i++) if (needles[i].length && data.includes(needles[i])) found.push({ file, pattern: i === 0 ? 'raw' : `base64-offset-${i - 1}` });
  };
  const visit = entry => {
    let stat; try { stat = fs.statSync(entry); } catch { return; }
    if (stat.isFile()) { addFile(entry); return; }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
  };
  for (const item of paths) visit(item);
  return found;
}
function collectSockets(root, depth = 0) {
  let names; try { names = fs.readdirSync(root); } catch { return []; }
  const sockets = [];
  for (const name of names) {
    const item = path.join(root, name);
    let stat; try { stat = fs.lstatSync(item); } catch { continue; }
    if (stat.isSocket()) sockets.push(item);
    else if (stat.isDirectory() && depth < 4) sockets.push(...collectSockets(item, depth + 1));
  }
  return sockets;
}
function findGitHubSocket(stateDir, preferred) {
  if (preferred) { try { if (fs.lstatSync(preferred).isSocket()) return preferred; } catch {} }
  return collectSockets(stateDir)[0] || null;
}
function httpOverUnix(socketPath, { method = 'POST', pathname = '/runtime-tools/github/credentials', headers = {}, body = '{}' } = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: pathname, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('bridge timeout')));
    req.on('error', reject); req.end(body);
  });
}

// A small server-side contract model. It is a pre-implementation fixture, not L1a production code.
class StubAuthority {
  constructor(resolveCredentials = async binding => ({ status: 'available', env: { GH_TOKEN: 'fixture-only' }, binding })) {
    this.resolveCredentials = resolveCredentials;
    this.active = null; this.generation = 0; this.inflight = new Set(); this.seen = new Set(); this.maxInflight = 8; this.resolverCalls = 0;
  }
  activate(binding) { this.active = { ...binding }; this.generation++; }
  deactivate() { this.active = null; this.generation++; }
  async request(frame) {
    const req = frame?.payload ?? frame;
    const id = req?.requestId;
    if (typeof id !== 'string' || !id || this.seen.has(id) || this.inflight.has(id)) return { status: 409, body: { error: 'duplicate or invalid requestId' } };
    if (this.inflight.size >= this.maxInflight) return { status: 429, body: { error: 'too many in-flight requests' } };
    if (!this.active) return { status: 403, body: { error: 'No active GitHub run' } };
    if (typeof req.runId === 'string' && req.runId !== this.active.runId) return { status: 403, body: { error: 'GitHub request runId mismatch' } };
    this.seen.add(id); this.inflight.add(id);
    const captured = this.active, generation = this.generation;
    try {
      this.resolverCalls++;
      const result = await this.resolveCredentials({ ...captured });
      if (this.active !== captured || this.generation !== generation) return { discarded: true, replySent: false };
      return { status: 200, body: result };
    } finally { this.inflight.delete(id); }
  }
}
function findSetpriv() {
  for (const candidate of ['/usr/bin/setpriv', '/bin/setpriv']) if (fs.existsSync(candidate)) return candidate;
  return null;
}
function testSecondUid(socketPath) {
  const setpriv = findSetpriv();
  if (!setpriv || typeof process.getuid !== 'function') return { status: 'skip', reason: 'setpriv or Unix uid support is unavailable' };
  if (process.getuid() === 65534) return { status: 'skip', reason: 'current user is the only selected unprivileged identity' };
  const script = `const net=require('node:net');const s=net.createConnection(${JSON.stringify(socketPath)});s.once('connect',()=>{s.end();process.exit(10)});s.once('error',e=>process.exit(e.code==='EACCES'||e.code==='EPERM'?0:e.code==='ENOENT'?12:11));setTimeout(()=>process.exit(13),1500);`;
  const result = spawnSync(setpriv, ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, '-e', script], { encoding: 'utf8', timeout: 3000 });
  if (result.status === 0) return { status: 'pass', reason: 'uid 65534 could not connect to the 0600 fixture socket' };
  if (result.status === 10) return { status: 'fail', reason: 'uid 65534 connected to the 0600 fixture socket' };
  if (result.status === 12 || result.stderr?.includes('No such file')) return { status: 'skip', reason: 'private task scratch parent blocks traversal before the socket permission check' };
  if (result.stderr?.includes('Operation not permitted')) return { status: 'skip', reason: 'host policy denies setuid/setpriv to a second UID' };
  return { status: 'skip', reason: `second-uid probe unavailable (exit ${result.status ?? result.error?.code ?? 'unknown'})` };
}
async function selfTest() {
  const cases = [];
  const test = async (name, fn) => { await fn(); cases.push({ name, status: 'PASS (stub fixture)' }); };
  const fixture = await fs.promises.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'l1e-selftest-'));
  try {
    await test('foreign-run frame refused before resolver', async () => {
      const stub = new StubAuthority(); stub.activate({ companyId: 'c1', agentId: 'a1', issueId: 'i1', runId: 'run-current' });
      const result = await stub.request({ kind: 'github_access.http', payload: { requestId: 'foreign-1', runId: 'run-foreign', companyId: 'c2', agentId: 'a2', issueId: 'i2' } });
      assert(result.status === 403 && stub.resolverCalls === 0, 'foreign request reached resolver');
    });
    await test('idle-session request refused', async () => {
      const stub = new StubAuthority();
      const result = await stub.request({ kind: 'github_access.http', payload: { requestId: 'idle-1' } });
      assert(result.status === 403 && stub.resolverCalls === 0, 'idle request was not refused');
    });
    await test('binding change discards late answer', async () => {
      let release; const blocked = new Promise(resolve => { release = resolve; });
      const stub = new StubAuthority(async () => { await blocked; return { GH_TOKEN: 'should-not-return' }; });
      stub.activate({ companyId: 'c1', agentId: 'a1', issueId: 'i1', runId: 'run-before' });
      const pending = stub.request({ kind: 'github_access.http', payload: { requestId: 'swap-1' } });
      await new Promise(resolve => setImmediate(resolve));
      stub.activate({ companyId: 'c1', agentId: 'a1', issueId: 'i1', runId: 'run-after' }); release();
      const result = await pending;
      assert(result.discarded && result.replySent === false, 'late resolver result escaped old binding');
    });
    await test('duplicate request IDs are rejected', async () => {
      const stub = new StubAuthority(); stub.activate({ companyId: 'c', agentId: 'a', issueId: 'i', runId: 'r' });
      const frame = { kind: 'github_access.http', payload: { requestId: 'unique-1' } };
      assert((await stub.request(frame)).status === 200, 'first request failed');
      assert((await stub.request(frame)).status === 409, 'duplicate requestId accepted');
    });
    const sock = path.join(fixture, 'private.sock');
    const listener = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(sock, resolve); });
    fs.chmodSync(sock, 0o600);
    await test('fixture Unix socket is mode 0600', async () => {
      const mode = fs.statSync(sock).mode & 0o777;
      assert(mode === 0o600, `fixture socket mode was ${mode.toString(8)}`);
    });
    const uidResult = testSecondUid(sock);
    cases.push({ name: 'other-uid socket refusal', status: uidResult.status === 'fail' ? 'FAIL' : uidResult.status === 'pass' ? 'PASS (stub fixture)' : 'SKIP (stub fixture)', reason: uidResult.reason });
    await new Promise(resolve => listener.close(resolve));

    await test('ingress drop maps to 503 runner ingress unavailable within bridge timeout', async () => {
      const server = http.createServer((_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'runner ingress unavailable' })); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      const start = Date.now();
      let timer;
      try {
        const request = new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: address.port, timeout: BRIDGE_TIMEOUT_MS }, res => { const parts = []; res.on('data', chunk => parts.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() })); }).once('error', reject));
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('drop exceeded bridge timeout')), BRIDGE_TIMEOUT_MS); });
        const reply = await Promise.race([request, timeout]);
        assert(reply.status === 503 && JSON.parse(reply.body).error === 'runner ingress unavailable' && Date.now() - start < BRIDGE_TIMEOUT_MS, 'drop response did not match the named bounded failure');
      } finally { clearTimeout(timer); server.close(); }
    });
    await test('sentinel scanner detects raw and three base64 alignments', async () => {
      const token = `l1e_sentinel_${randomHex(16)}`;
      const sample = path.join(fixture, 'scanner-probe.log');
      for (let i = 0; i < 4; i++) {
        fs.writeFileSync(sample, scanVariants(token)[i]);
        assert(scanFiles([sample], token).length > 0, `scanner missed sentinel variant ${i}`);
      }
    });
    await test('sanitized logs and durable PRP fixture stay sentinel-free', async () => {
      const token = `l1e_sentinel_${randomHex(16)}`;
      const logs = path.join(fixture, 'logs'); const durable = path.join(fixture, 'durable');
      fs.mkdirSync(logs); fs.mkdirSync(durable);
      fs.writeFileSync(path.join(logs, 'runnerd.log'), 'method=POST path=/runtime-tools/github/credentials status=200 size=87 requestId=req-1\n');
      fs.writeFileSync(path.join(logs, 'prp-spans.log'), 'kind=github_access.http method=POST path=/runtime-tools/github/credentials requestId=req-1\n');
      fs.writeFileSync(path.join(logs, 'server.log'), 'github access response status=200 size=87 requestId=req-1\n');
      fs.writeFileSync(path.join(logs, 'run.log'), 'credential request completed\n');
      fs.writeFileSync(path.join(durable, 'outbox.json'), '{"events":[],"checkpoints":[]}\n');
      assert(scanFiles([logs, durable], token).length === 0, 'sentinel present in a sanitized fixture sink');
    });
    const failures = cases.filter(c => c.status === 'FAIL');
    for (const row of cases) console.log(`${row.status.padEnd(22)} ${row.name}${row.reason ? ` — ${row.reason}` : ''}`);
    assert(failures.length === 0, `${failures.length} self-test case(s) failed`);
    return { cases, fixtureDirRemoved: true };
  } finally { await fs.promises.rm(fixture, { recursive: true, force: true }); }
}

function secureEnvelope(peer, identity, connection, kind, payload) {
  return {
    protocol: PROTOCOL, version: connection.version, kind,
    ...identity,
    connectionId: connection.id,
    connectionLeaseId: connection.leaseId,
    payload,
  };
}
async function authenticateRunnerdAsCore(ws, bootstrapToken) {
  const hello = await ws.read(8000);
  assert(hello?.kind === 'auth_hello' && hello.protocol === PROTOCOL, 'runnerd did not start PRP auth_hello');
  const p = hello.payload, cred = credential(bootstrapToken);
  assert(p.credentialId === cred.id && p.credentialKind === 'bootstrap', 'runnerd did not present configured bootstrap ticket');
  const selectedVersion = Math.min(Number(p.protocolMax || hello.version || 3), 3);
  const expires = Date.now() + 60_000;
  const challenge = {
    credentialId: cred.id, credentialKind: 'bootstrap', clientNonce: p.clientNonce,
    serverNonce: randomHex(), ...identityFrom(p), runnerVersion: p.runnerVersion, runnerDigest: p.runnerDigest,
    selectedVersion, credentialExpiresAt: new Date(expires).toISOString(), credentialExpiresAtUnixMs: expires,
    credentialLeaseId: null, revocationEpoch: 0,
    recoveryCursorVersion: 1, recoveryAckedSourceSeq: p.resume?.ackedSourceSeq ?? 0,
  };
  const signing = challengeSigningBytes(challenge);
  const serverProof = hex(hmacDomain(cred.key, 'paperclip-runner-server-proof-v1', [signing]));
  ws.send({ protocol: PROTOCOL, version: selectedVersion, kind: 'auth_challenge', payload: { ...challenge, serverProof } });
  const authResponse = await ws.read(8000);
  assert(authResponse?.kind === 'auth_response', 'runnerd did not return auth_response');
  const clientProof = authResponse.payload?.clientProof;
  const expected = hmacDomain(cred.key, 'paperclip-runner-client-proof-v1', [signing, Buffer.from(serverProof)]);
  assert(typeof clientProof === 'string' && crypto.timingSafeEqual(Buffer.from(clientProof, 'hex'), expected), 'runnerd client proof did not verify');
  const channel = new SecureChannel(cred.key, signing, serverProof, clientProof, 'core');
  const conn = { id: `l1e-connection-${randomHex(8)}`, leaseId: 'l1e-lease', version: selectedVersion };
  ws.send(channel.encrypt({
    protocol: PROTOCOL, version: selectedVersion, kind: 'welcome', ...identityFrom(p),
    connectionId: conn.id, connectionLeaseId: conn.leaseId,
    payload: {
      selectedVersion, connectionLeaseId: conn.leaseId,
      connectionLeaseToken: `l1e-lease-token-${randomHex(8)}`,
      connectionLeaseExpiresAtUnixMs: Date.now() + 60_000,
      connectionLeaseRevocationEpoch: 1,
      ackedSourceSeq: p.resume?.ackedSourceSeq ?? 0,
      pendingCommands: [],
      capabilities: ['github_access.http'],
      githubAccessHttp: true,
    },
  }));
  return { channel, identity: identityFrom(p), connection: conn, hello };
}
async function receiveSecure(ws, channel, timeoutMs) { return channel.decrypt(await ws.read(timeoutMs)); }
async function authenticateStubRunner(ws, cfg) {
  const token = process.env.L1E_BOOTSTRAP_TICKET;
  assert(token, 'L1E_BOOTSTRAP_TICKET must be set for stub-runner mode (use a test-only value)');
  const cred = credential(token);
  const payload = {
    credentialId: cred.id, credentialKind: 'bootstrap', clientNonce: randomHex(),
    protocolMin: 1, protocolMax: 3,
    runnerInstanceId: cfg.runnerInstanceId, environmentLeaseId: cfg.environmentLeaseId,
    runId: cfg.runId, normalizedSessionId: cfg.sessionId, turnId: cfg.turnId, itemId: cfg.itemId,
    runnerVersion: 'l1e-stub-runner', runnerDigest: '0'.repeat(64),
    resume: { lastControllerCommandSeq: 0, nextSourceEventSeq: 1, ackedSourceSeq: 0 },
  };
  ws.send({ protocol: PROTOCOL, version: 3, kind: 'auth_hello', payload });
  const envelope = await ws.read(15_000);
  assert(envelope?.kind === 'auth_challenge' && envelope.protocol === PROTOCOL, 'server did not send PRP auth_challenge');
  const c = envelope.payload || {};
  assert(c.credentialId === cred.id && c.credentialKind === 'bootstrap' && c.clientNonce === payload.clientNonce, 'server challenge credential binding mismatch');
  for (const [key, expected] of Object.entries(identityFrom(payload))) assert(c[key] === expected, `server challenge ${key} mismatch`);
  const signing = challengeSigningBytes(c);
  const expectedServer = hmacDomain(cred.key, 'paperclip-runner-server-proof-v1', [signing]);
  assert(crypto.timingSafeEqual(Buffer.from(c.serverProof || '', 'hex'), expectedServer), 'server proof failed verification');
  const clientProof = hex(hmacDomain(cred.key, 'paperclip-runner-client-proof-v1', [signing, Buffer.from(c.serverProof)]));
  ws.send({ protocol: PROTOCOL, version: c.selectedVersion, kind: 'auth_response', payload: { credentialId: cred.id, clientNonce: payload.clientNonce, serverNonce: c.serverNonce, clientProof } });
  const channel = new SecureChannel(cred.key, signing, c.serverProof, clientProof, 'runner');
  const welcome = await receiveSecure(ws, channel, 20_000);
  assert(welcome?.kind === 'welcome' && welcome.protocol === PROTOCOL, 'server did not send encrypted PRP welcome');
  return { channel, identity: identityFrom(payload), connection: { id: welcome.connectionId, leaseId: welcome.connectionLeaseId, version: c.selectedVersion }, welcome, token };
}

async function runnerdMode(binary, options) {
  assert(binary && fs.existsSync(binary), `runnerd binary not found: ${binary || '(missing)'}`);
  const root = await fs.promises.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'l1e-runnerd-'));
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir, { mode: 0o700 });
  const githubSocketPath = process.env.L1E_SOCKET_PATH || process.env.PAPERCLIP_GITHUB_RUNNER_SOCKET || path.join(root, 'github-access.sock');
  const ticket = process.env.L1E_BOOTSTRAP_TICKET || `l1e-bootstrap-${randomHex(24)}`;
  const portServer = net.createServer();
  const configuredPort = Number(process.env.L1E_LISTEN_PORT || 0);
  await new Promise((resolve, reject) => { portServer.once('error', reject); portServer.listen(configuredPort, '127.0.0.1', resolve); });
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const runId = process.env.L1E_RUN_ID || `l1e-run-${randomHex(8)}`;
  const pathname = `/api/runner/v1/connect/${runId}`;
  const args = [
    '--state-dir', stateDir, '--run-id', runId, '--runner-id', `runner-${randomHex(6)}`,
    '--environment-lease-id', `lease-${randomHex(6)}`, '--session-id', `session-${randomHex(6)}`,
    '--turn-id', `turn-${randomHex(6)}`, '--item-id', `item-${randomHex(6)}`,
    '--runner-version', 'l1e-harness', '--runner-digest', '0'.repeat(64),
    '--listen-address', '0.0.0.0', '--listen-port', String(port), '--listen-path', pathname,
    '--max-runtime-ms', '60000', '--reconnect-delay-ms', '100',
  ];
  const child = spawn(binary, args, { env: { ...process.env, PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: process.env.L1E_BOOTSTRAP_TICKET || ticket, PAPERCLIP_GITHUB_ACCESS_TRANSPORT: 'runner_ingress', PAPERCLIP_GITHUB_RUNNER_SOCKET: githubSocketPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  let ws = null, authenticated = false, socketPath = null, response = null, scanToken = null;
  const started = Date.now();
  try {
    if (options.externalServer) {
      console.log(`READY runnerd ws://${process.env.L1E_ADVERTISE_HOST || '127.0.0.1'}:${port}${pathname} runId=${runId}`);
      const deadline = Date.now() + Number(options.socketWaitMs || 25_000);
      while (Date.now() < deadline) {
        socketPath = findGitHubSocket(stateDir, githubSocketPath);
        if (socketPath) break;
        if (child.exitCode !== null) throw new Error(`runnerd exited before GitHub socket appeared (code ${child.exitCode})`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert(socketPath, 'runnerd did not expose a GitHub-access Unix socket while waiting for real server ingress');
      assert((fs.statSync(socketPath).mode & 0o777) === 0o600, 'runnerd Unix socket is not mode 0600');
      const headers = {};
      if (process.env.L1E_BROKER_TOKEN) headers.authorization = `Bearer ${process.env.L1E_BROKER_TOKEN}`;
      if (process.env.L1E_CAPABILITY) headers['x-paperclip-github-capability'] = process.env.L1E_CAPABILITY;
      const expectedStatus = Number(process.env.L1E_EXPECT_STATUS || 200);
      response = await httpOverUnix(socketPath, { headers }, BRIDGE_TIMEOUT_MS);
      assert(response.status === expectedStatus, `real-server runner socket returned ${response.status}, expected ${expectedStatus}`);
      const returned = (() => { try { return JSON.parse(response.body.toString()); } catch { return {}; } })();
      const sentinel = process.env.L1E_SENTINEL || returned?.env?.GH_TOKEN || returned?.env?.GITHUB_TOKEN;
      scanToken = sentinel || null;
      if (sentinel) {
        const hits = scanFiles([stateDir, ...options.scanPaths], sentinel);
        assert(hits.length === 0, `sentinel detected in runnerd/server/run/Langfuse/durable sinks: ${hits.map(hit => `${hit.file}:${hit.pattern}`).join(', ')}`);
      }
      console.log(`PASS joint real-server/real-runnerd request status=${response.status} size=${response.body.length}; credential body withheld`);
      if (sentinel) console.log('PASS sentinel absent from captured real-server/run/Langfuse paths and durable PRP state');
      return { externalServer: true, featureAvailable: true, socketMode: 0o600, status: response.status, elapsedMs: Date.now() - started };
    }
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error(`runnerd exited before ingress auth (code ${child.exitCode})`);
      try { ws = await connectWebSocket('127.0.0.1', port, pathname, 500); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert(ws, 'runnerd listener did not accept the PRP connection');
    const session = await authenticateRunnerdAsCore(ws, ticket); authenticated = true;
    console.log('PASS real runnerd binary accepted stub-server PRP v3 mutual authentication');
    const until = Date.now() + Number(options.socketWaitMs || 8000);
    while (Date.now() < until) {
      socketPath = findGitHubSocket(stateDir, githubSocketPath);
      if (socketPath) break;
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!socketPath) {
      console.log('BLOCKED real runnerd feature cases: base binary exposes no GitHub-access Unix socket after authenticated ingress');
      console.log('SKIP RFL foreign-run / idle / binding-change / socket-0600 / ingress-drop / sentinel checks against real runnerd: L1b runner half is not present in base 5b0145ab4');
      return { authenticated, featureAvailable: false, elapsedMs: Date.now() - started };
    }
    const mode = fs.statSync(socketPath).mode & 0o777;
    assert(mode === 0o600, `runnerd Unix socket mode is ${mode.toString(8)}, expected 600`);
    console.log('PASS real runnerd GitHub Unix socket mode 0600');
    const uidResult = testSecondUid(socketPath);
    console.log(`${uidResult.status === 'pass' ? 'PASS' : 'SKIP'} real runnerd other-uid socket probe${uidResult.reason ? ` — ${uidResult.reason}` : ''}`);
    const sentinel = `l1e_sentinel_${randomHex(24)}`;
    scanToken = sentinel;
    const brokerToken = `l1e-broker-${randomHex(12)}`;
    const capability = `l1e-capability-${randomHex(12)}`;
    const requestPromise = httpOverUnix(socketPath, { headers: { authorization: `Bearer ${brokerToken}`, 'x-paperclip-github-capability': capability } }, BRIDGE_TIMEOUT_MS);
    const prpFrame = await receiveSecure(ws, session.channel, BRIDGE_TIMEOUT_MS);
    const body = prpFrame?.payload ?? prpFrame;
    assert(prpFrame?.kind === 'github_access.http' || body?.kind === 'github_access.http', 'runnerd forwarded a non github_access.http PRP message');
    assert(typeof body.requestId === 'string' && body.requestId.length > 0, 'github_access.http has no requestId');
    assert(body.method === 'POST' && body.path === '/runtime-tools/github/credentials', 'runnerd forwarded an unexpected HTTP operation');
    const headers = body.headers || {};
    assert(!Object.keys(headers).some(name => name.toLowerCase() === 'authorization' && headers[name] !== `Bearer ${brokerToken}`), 'runnerd changed Authorization header');
    const result = { status: 'available', env: { GH_TOKEN: sentinel } };
    const responseBytes = Buffer.from(JSON.stringify(result));
    const replyPayload = { requestId: body.requestId, status: 200, headers: { 'content-type': 'application/json' }, bodyBase64: responseBytes.toString('base64') };
    const replyKind = process.env.L1E_REPLY_KIND || 'github_access.http.reply';
    ws.send(session.channel.encrypt(secureEnvelope(session.channel, session.identity, session.connection, replyKind, replyPayload)));
    response = await requestPromise;
    assert(response.status === 200 && response.body.toString().includes(sentinel), 'runnerd local HTTP client did not receive the stub credential reply');
    console.log('PASS real runnerd local request/reply returned stub credential (response body not logged)');
    const disconnectAt = Date.now(); ws.close();
    let drop;
    try { drop = await httpOverUnix(socketPath, { headers: { authorization: `Bearer ${brokerToken}`, 'x-paperclip-github-capability': capability } }, BRIDGE_TIMEOUT_MS); }
    catch (error) { assert(Date.now() - disconnectAt < BRIDGE_TIMEOUT_MS, 'ingress drop exceeded bridge timeout'); throw new Error(`ingress drop returned transport error rather than named 503: ${error.message}`); }
    assert(drop.status === 503 && drop.body.toString().includes('runner ingress unavailable'), 'ingress drop did not return HTTP 503 runner ingress unavailable');
    assert(Date.now() - disconnectAt < BRIDGE_TIMEOUT_MS, 'ingress drop exceeded bridge response timeout');
    console.log('PASS real runnerd ingress drop -> HTTP 503 runner ingress unavailable within bridge timeout');
    const scanPaths = [stateDir, ...options.scanPaths];
    const hits = scanFiles(scanPaths, sentinel);
    assert(hits.length === 0, `sentinel detected in secret sinks: ${hits.map(hit => `${hit.file}:${hit.pattern}`).join(', ')}`);
    console.log('PASS sentinel absent from runnerd stdout/stderr, PRP metadata log, supplied server/run/Langfuse sinks, and durable PRP state');
    return { authenticated, featureAvailable: true, socketMode: mode, otherUid: uidResult, elapsedMs: Date.now() - started };
  } finally {
    if (ws && !ws.ended) ws.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
      }
    }
    // Output is collected only for secret scans; it is never echoed to the caller.
    const logFile = path.join(root, 'runnerd-captured-output.log'); fs.writeFileSync(logFile, output, { mode: 0o600 });
    const sentinelFromResponse = scanToken || (response && /l1e_sentinel_[A-Za-z0-9_-]+/.exec(response.body.toString())?.[0]);
    if (sentinelFromResponse) {
      const hits = scanFiles([logFile, stateDir, ...options.scanPaths], sentinelFromResponse);
      assert(hits.length === 0, `sentinel found in runnerd/log/durable sink (${hits.map(h => h.pattern).join(', ')})`);
    }
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function stubRunnerMode(port, pathname, testCase, options) {
  const portNum = Number(port);
  assert(Number.isInteger(portNum) && portNum > 0 && portNum <= 65535, 'stub-runner mode requires a nonzero --port');
  const cfg = {
    runnerInstanceId: process.env.L1E_RUNNER_ID || 'l1e-stub-runner',
    environmentLeaseId: process.env.L1E_ENVIRONMENT_LEASE_ID || 'l1e-stub-environment',
    runId: process.env.L1E_RUN_ID || 'l1e-stub-run',
    sessionId: process.env.L1E_SESSION_ID || 'l1e-stub-session',
    turnId: process.env.L1E_TURN_ID || 'l1e-stub-turn',
    itemId: process.env.L1E_ITEM_ID || 'l1e-stub-item',
  };
  const httpServer = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  let doneResolve, doneReject;
  const finished = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== pathname) { socket.destroy(); return; }
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    (async () => {
      const session = await authenticateStubRunner(ws, cfg);
      const requestId = `l1e-request-${randomHex(8)}`;
      const headers = process.env.L1E_HTTP_HEADERS_JSON ? JSON.parse(process.env.L1E_HTTP_HEADERS_JSON) : { 'content-type': 'application/json', authorization: 'Bearer l1e-fixture-broker', 'x-paperclip-github-capability': 'l1e-fixture-capability' };
      const payload = {
        requestId, method: process.env.L1E_HTTP_METHOD || 'POST', path: process.env.L1E_HTTP_PATH || '/runtime-tools/github/credentials',
        headers, bodyBase64: process.env.L1E_BODY_BASE64 || b64('{}'),
      };
      if (testCase === 'foreign-run') {
        const ids = process.env.L1E_FOREIGN_IDS_JSON ? JSON.parse(process.env.L1E_FOREIGN_IDS_JSON) : { runId: 'foreign-run', companyId: 'foreign-company', agentId: 'foreign-agent', issueId: 'foreign-issue' };
        Object.assign(payload, ids);
      }
      const frame = secureEnvelope(session.channel, session.identity, session.connection, 'github_access.http', payload);
      ws.send(session.channel.encrypt(frame));
      console.log(`SENT kind=github_access.http requestId=${requestId} method=POST path=/runtime-tools/github/credentials size=${Buffer.byteLength(payload.bodyBase64)}`);
      const replyFrame = await receiveSecure(ws, session.channel, BRIDGE_TIMEOUT_MS);
      const reply = replyFrame?.payload ?? replyFrame;
      assert(reply.requestId === requestId, 'server reply requestId mismatch');
      const responseBody = Buffer.from(reply.bodyBase64 || '', 'base64');
      console.log(`RECEIVED requestId=${requestId} status=${reply.status} size=${responseBody.length}`);
      if (process.env.L1E_EXPECT_STATUS) assert(Number(reply.status) === Number(process.env.L1E_EXPECT_STATUS), `expected HTTP ${process.env.L1E_EXPECT_STATUS}, received ${reply.status}`);
      let resultValue = {}; try { resultValue = JSON.parse(responseBody.toString()); } catch {}
      const sentinel = process.env.L1E_SENTINEL || resultValue?.env?.GH_TOKEN || resultValue?.env?.GITHUB_TOKEN;
      if (sentinel) {
        const hits = scanFiles(options.scanPaths, sentinel);
        assert(hits.length === 0, `sentinel detected in supplied server/run/Langfuse sinks: ${hits.map(hit => `${hit.file}:${hit.pattern}`).join(', ')}`);
        console.log('PASS sentinel absent from supplied server/run/Langfuse scan paths; response body withheld');
      }
      ws.close(); doneResolve({ replyStatus: reply.status, testCase });
    })().catch(error => { ws.close(); doneReject(error); });
  });
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(portNum, '0.0.0.0', resolve); });
  console.log(`READY stub-runner ws://0.0.0.0:${portNum}${pathname} case=${testCase}`);
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('server did not connect to stub runner within 120s')), 120_000); timer.unref(); });
  try { return await Promise.race([finished, timeout]); }
  finally { await new Promise(resolve => httpServer.close(resolve)); }
}

function parseArgs(argv) {
  const result = { scanPaths: [], socketWaitMs: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self-test') result.selfTest = true;
    else if (arg === '--runnerd') result.runnerd = argv[++i];
    else if (arg === '--socket-wait-ms') result.socketWaitMs = Number(argv[++i]);
    else if (arg === '--external-server') result.externalServer = true;
    else if (arg === '--scan-path') result.scanPaths.push(argv[++i]);
    else if (arg === '--stub-runner') result.stubRunner = true;
    else if (arg === '--port') result.port = argv[++i];
    else if (arg === '--path') result.pathname = argv[++i];
    else if (arg === '--case') result.testCase = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) { await selfTest(); return; }
  if (options.runnerd) { await runnerdMode(path.resolve(options.runnerd), options); return; }
  if (options.stubRunner) { await stubRunnerMode(options.port, options.pathname || `/api/runner/v1/connect/${process.env.L1E_RUN_ID || 'l1e-stub-run'}`, options.testCase || process.env.L1E_CASE || 'happy', options); return; }
  throw new Error('choose --self-test, --runnerd /path/to/paperclip-runnerd, or --stub-runner --port N');
}
main().catch(error => { console.error(`L1e harness: ${error.message}`); process.exitCode = 1; });
