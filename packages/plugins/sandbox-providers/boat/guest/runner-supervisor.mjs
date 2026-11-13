#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostChannel } from './host-channel.mjs';
import { closed, decodeJson, encodeJson, fail, MAX_REQUEST_BYTES, SupervisorError, validId, validString, validateHostFrame } from './protocol.mjs';

const errorResponse = (error) => ({ ok: false, error: { code: error instanceof SupervisorError ? error.code : 'INTERNAL_ERROR' } });
const cleanString = (value) => validString(value) && !value.includes('\0');

function validateLaunch(request, preserveHostControlArgs = false) {
  if (!closed(request, ['binary', 'argv', 'env', 'cwd'], ['bootstrapTicket']) || !cleanString(request.binary)
    || (Object.hasOwn(request, 'bootstrapTicket') && (!cleanString(request.bootstrapTicket)
      || /^\p{White_Space}*$/u.test(request.bootstrapTicket)))
    || !isAbsolute(request.binary) || !cleanString(request.cwd) || !isAbsolute(request.cwd)
    || !Array.isArray(request.argv) || !request.argv.every(cleanString)
    || request.argv.some((arg, index) => arg === '--' || (/^--host-control-fd(?:=|$)/.test(arg)
      && (!preserveHostControlArgs || arg !== '--host-control-fd' || request.argv[index + 1] !== '4')))
    || request.argv.filter((arg) => arg === '--host-control-fd').length > 1
    || !request.env || typeof request.env !== 'object' || Array.isArray(request.env)
    || !Object.entries(request.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && !/(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|BOOTSTRAP_TICKET)/i.test(key) && cleanString(value))) fail('INVALID_LAUNCH');
  try {
    if (Buffer.byteLength(encodeJson(request)) > MAX_REQUEST_BYTES) fail('INVALID_LAUNCH');
    return decodeJson(encodeJson(request), 'INVALID_LAUNCH'); // snapshot before the first await
  } catch { fail('INVALID_LAUNCH'); }
}

function birth(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces and ')'; field 22 is index 19 after comm.
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = tail[19];
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!/^\d+$/.test(startTime) || !bootId) fail('IDENTITY_UNAVAILABLE');
    return { pid, startTime, bootId, zombie: tail[0] === 'Z' };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    fail('IDENTITY_UNAVAILABLE');
  }
}

function boundedEvent(target, event, timeout, code) {
  return new Promise((resolveEvent, reject) => {
    const done = (error, value) => {
      clearTimeout(timer);
      target.off(event, success);
      target.off('error', failure);
      if (error) reject(error); else resolveEvent(value);
    };
    const success = (...args) => done(null, args);
    const failure = () => done(new SupervisorError(code));
    const timer = setTimeout(failure, timeout);
    target.once(event, success);
    target.once('error', failure);
  });
}

async function connectedPair(stateDir, timeout) {
  const dir = await mkdtemp(join(stateDir, 'fd4-'));
  const path = join(dir, 's');
  const server = net.createServer({ pauseOnConnect: true });
  let parent;
  let child;
  const cleanup = async () => {
    child?.destroy();
    server.close();
    await rm(dir, { recursive: true, force: true });
  };
  // Keep all errors handled even if the other side wins the connect race.
  server.on('error', () => {});
  try {
    const listening = boundedEvent(server, 'listening', timeout, 'LAUNCH_FAILED');
    server.listen(path);
    await listening;
    const accepted = boundedEvent(server, 'connection', timeout, 'LAUNCH_FAILED');
    parent = net.createConnection(path);
    parent.on('error', () => {});
    const connected = boundedEvent(parent, 'connect', timeout, 'LAUNCH_FAILED');
    const [result] = await Promise.all([accepted, connected]);
    [child] = result;
    return { parent, child, cleanup };
  } catch {
    parent?.destroy();
    await cleanup();
    fail('LAUNCH_FAILED');
  }
}

export async function createSupervisor({ stateDir, requestTimeoutMs = 30_000, inputTimeoutMs = 5000,
  launchTimeoutMs = 5000, termTimeoutMs = 5000, killTimeoutMs = 2000, preserveHostControlArgs = false } = {}) {
  if (process.platform !== 'linux') fail('UNSUPPORTED_PLATFORM');
  if (!cleanString(stateDir) || !isAbsolute(stateDir)) fail('UNSAFE_DIRECTORY');
  for (const value of [requestTimeoutMs, inputTimeoutMs, launchTimeoutMs, termTimeoutMs, killTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) fail('INVALID_OPTIONS');
  }
  stateDir = resolve(stateDir);
  try {
    await mkdir(stateDir, { mode: 0o700 });
  } catch (error) { if (error.code !== 'EEXIST') fail('UNSAFE_DIRECTORY'); }
  const stat = await lstat(stateDir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
    || await realpath(stateDir) !== stateDir) fail('UNSAFE_DIRECTORY');
  const socketPath = join(stateDir, 'control.sock');
  // Linux sockaddr_un.sun_path is 108 bytes, including the trailing NUL.
  // Reserve space for the temporary fd4 listener's suffix too.
  if (Buffer.byteLength(join(stateDir, 'fd4-XXXXXX/s')) >= 108) fail('UNSAFE_DIRECTORY');

  let current;
  let launching = false;
  let launchDone = Promise.resolve();
  let closing = false;
  let closePromise;
  const connections = new Set();
  const operations = new Set();
  const server = net.createServer((socket) => {
    if (closing || connections.size >= 32) { socket.destroy(); return; }
    connections.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
    let input = Buffer.alloc(0);
    let admitted = false;
    // Absolute input deadline, never extended by a slow sender.
    const timer = setTimeout(() => {
      admitted = true;
      respond(errorResponse(new SupervisorError('INPUT_TIMEOUT')));
    }, inputTimeoutMs);
    socket.once('close', () => clearTimeout(timer));
    function respond(value) {
      clearTimeout(timer);
      if (!socket.destroyed) {
        socket.end(encodeJson(value) + '\n', () => socket.destroy());
        socket.setTimeout(1000, () => socket.destroy());
      }
    }
    socket.on('data', (bytes) => {
      if (admitted) { socket.destroy(); return; }
      if (input.length + bytes.length > MAX_REQUEST_BYTES) {
        admitted = true; respond(errorResponse(new SupervisorError('INVALID_REQUEST'))); return;
      }
      input = Buffer.concat([input, bytes]);
      const end = input.indexOf(10);
      if (end === -1) return;
      admitted = true;
      clearTimeout(timer);
      let request;
      try {
        if (end !== input.length - 1) fail('INVALID_REQUEST');
        request = decodeJson(input.subarray(0, end));
      } catch (error) { respond(errorResponse(error)); return; }
      input = Buffer.alloc(0);
      // Deliberately not cancelled by socket close: the generation owns fd4,
      // and an admitted transition must settle even when the carrier goes away.
      const operation = dispatch(request).then((result) => respond({ ok: true, result }), (error) => respond(errorResponse(error)));
      operations.add(operation);
      void operation.finally(() => operations.delete(operation));
    });
  });
  server.on('error', () => {});

  function owned(generation) {
    if (!current || generation !== current.owner.generation) fail('NOT_OWNED');
    return current;
  }
  function alive(record) {
    if (record.exited) return false;
    const now = birth(record.owner.pid);
    if (!now) return false;
    if (now.startTime !== record.owner.startTime || now.bootId !== record.owner.bootId) fail('IDENTITY_MISMATCH');
    return !now.zombie;
  }
  function signalOwned(record, signal) {
    // Synchronous birth check + signal in one event-loop turn. Only our unreaped
    // ChildProcess is eligible, so libuv cannot reap/recycle it between the two.
    if (alive(record)) {
      try { record.child.kill(signal); } catch { fail('TERMINATE_FAILED'); }
    }
  }
  async function waitExit(record, timeout) {
    if (record.exited) return true;
    let timer;
    const exited = await Promise.race([record.exit.then(() => true), new Promise((resolveWait) => { timer = setTimeout(() => resolveWait(false), timeout); })]);
    clearTimeout(timer);
    return exited;
  }

  async function launch(request) {
    request = validateLaunch(request, preserveHostControlArgs);
    if (closing) fail('CLOSING');
    if (launching || (current && !current.exited)) fail('ALREADY_RUNNING');
    launching = true;
    let finishedLaunch;
    launchDone = new Promise((resolveLaunch) => { finishedLaunch = resolveLaunch; });
    let pair;
    let record;
    try {
      pair = await connectedPair(stateDir, launchTimeoutMs);
      if (closing) fail('CLOSING');
      const channel = new HostChannel(pair.parent, requestTimeoutMs);
      // Node supports a stream object in stdio; no internal _handle API is used.
      // Cold BootstrapTicket is nonblank under Rust's Unicode White_Space
      // rules. NUL is additionally forbidden by execve; the request byte limit
      // still applies. Do not route it through the generic env admission map.
      const env = { ...request.env };
      if (Object.hasOwn(request, 'bootstrapTicket')) env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET = request.bootstrapTicket;
      let child;
      try {
        child = spawn(request.binary, request.argv.includes('--host-control-fd') ? request.argv : [...request.argv, '--host-control-fd', '4'], {
          cwd: request.cwd, env, shell: false,
          stdio: ['ignore', 'ignore', 'ignore', 'ignore', pair.child],
        });
      } finally {
        // spawn consumes env synchronously. Drop our ticket references before
        // awaiting its receipt; never modify the supervisor's process.env.
        delete env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
        delete request.bootstrapTicket;
      }
      record = { child, channel, exited: false };
      record.exit = new Promise((resolveExit) => child.once('exit', (code, signal) => {
        record.exited = true; record.code = code; record.signal = signal;
        channel.close(); resolveExit();
      }));
      child.on('error', () => {});
      await boundedEvent(child, 'spawn', launchTimeoutMs, 'LAUNCH_FAILED');
      const identity = birth(child.pid);
      if (!identity || identity.zombie) fail('LAUNCH_FAILED');
      const { zombie: _zombie, ...owner } = identity;
      record.owner = { ...owner, generation: randomUUID() };
      current = record;
      return { ...record.owner };
    } catch {
      if (record) {
        record.channel.close();
        // A spawned child still belongs to this ChildProcess even if birth
        // capture failed. Do not leave a failed-launch orphan behind.
        if (record.child.pid && !record.exited) {
          record.child.kill('SIGKILL');
          await waitExit(record, killTimeoutMs);
        }
      }
      pair?.parent.destroy();
      fail('LAUNCH_FAILED');
    } finally {
      delete request.bootstrapTicket; // also clear a failure before spawn
      try { await pair?.cleanup(); } // closes our duplicate child endpoint after spawn
      finally { launching = false; finishedLaunch(); }
    }
  }

  async function hostControl(generation, frame, preserveWire = false) {
    const validated = validateHostFrame(frame);
    // S9 validates the original bounded bytes and forwards them unchanged.
    // The legacy API keeps its normalized representation.
    const wire = preserveWire && (typeof frame === 'string' || Buffer.isBuffer(frame)) ? frame.toString() : validated;
    if (closing) fail('CLOSING');
    const record = owned(generation);
    if (!alive(record)) fail('NOT_RUNNING');
    return record.channel.request(wire);
  }
  function describe(record) {
    return { ...record.owner, state: alive(record) ? 'running' : 'exited', code: record.code ?? null, signal: record.signal ?? null };
  }
  async function status(generation) {
    // Discovery is read-only and permits recovery of a lost launch response.
    if (generation === undefined) return current ? describe(current) : { state: 'empty' };
    return describe(owned(generation));
  }
  async function terminate(generation) {
    const record = owned(generation);
    signalOwned(record, 'SIGTERM');
    if (!await waitExit(record, termTimeoutMs)) {
      signalOwned(record, 'SIGKILL');
      if (!await waitExit(record, killTimeoutMs)) fail('TERMINATE_TIMEOUT');
    }
    record.channel.close();
    return describe(record);
  }
  async function dispatch(request) {
    if (closing) fail('CLOSING');
    if (closed(request, ['op', 'binary', 'argv', 'env', 'cwd'], ['bootstrapTicket']) && request.op === 'launch') {
      const { op: _op, ...launchRequest } = request;
      // launch snapshots synchronously before its first await. Do not retain
      // either decoded carrier copy while its spawn promise is outstanding.
      try { return launch(launchRequest); }
      finally { delete launchRequest.bootstrapTicket; delete request.bootstrapTicket; }
    }
    if (closed(request, ['op', 'generation', 'frame']) && request.op === 'hostControl' && validId(request.generation)) {
      return hostControl(request.generation, request.frame);
    }
    if (closed(request, ['op']) && request.op === 'status') return status();
    if (closed(request, ['op', 'generation']) && validId(request.generation)) {
      if (request.op === 'status') return status(request.generation);
      if (request.op === 'terminate') return terminate(request.generation);
    }
    fail('INVALID_REQUEST');
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      server.close();
      for (const socket of connections) socket.destroy();
      await launchDone;
      current?.channel.close(); // runner observes EOF, even if it is parked
      await Promise.allSettled([...operations]);
      if (current && !current.exited) {
        current.channel.close();
        if (!await waitExit(current, termTimeoutMs)) await terminate(current.owner.generation);
      }
      await rm(socketPath, { force: true });
    })();
    return closePromise;
  }
  try {
    const listening = boundedEvent(server, 'listening', launchTimeoutMs, 'LISTEN_FAILED');
    server.listen(socketPath);
    await listening;
    await chmod(socketPath, 0o600);
  } catch {
    server.close();
    fail('LISTEN_FAILED');
  }
  return { socketPath, launch, hostControl, status, terminate, close,
    waitForExit: (generation, timeout = termTimeoutMs) => waitExit(owned(generation), timeout) };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== 'serve') fail('INVALID_ARGUMENTS');
  const supervisor = await createSupervisor({ stateDir: process.argv[3] });
  // Ready output is non-secret. Per-request bodies and raw errors are never logged.
  process.stdout.write(encodeJson({ version: 1, socketPath: supervisor.socketPath }) + '\n');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await supervisor.close(); } catch { process.exitCode = 1; }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(encodeJson(errorResponse(error)) + '\n'); process.exitCode = 1; });
}
