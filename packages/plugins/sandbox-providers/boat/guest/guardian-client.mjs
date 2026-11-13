import net from 'node:net';
import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GUARDIAN_SOCKET_PATH } from './guardian.mjs';
import { decodeJson, fail, SupervisorError } from './protocol.mjs';
import { MAX_FRAME_BYTES, parseFrame, refusal, validateFrame } from './guardian-protocol.mjs';

export async function guardianClient({ runnerId, socketPath = GUARDIAN_SOCKET_PATH, input = process.stdin, output = process.stdout, timeoutMs = 14000 } = {}) {
  let frame, socket, sent = false, bytes = Buffer.alloc(0), replyBytes = Buffer.alloc(0);
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  let done = false;
  function settle(reply) {
    if (done) return;
    done = true; clearTimeout(timer);
    input.off('data', onData); input.off('end', onEnd); input.off('error', onError); input.pause();
    socket?.destroy(); bytes.fill(0); replyBytes.fill(0);
    const wire = JSON.stringify(reply) + '\n';
    // A disconnected stdout belongs only to this client, never to fd4.
    output.once('error', () => finish(1));
    output.write(wire, error => finish(error || reply.status === 'refused' ? 1 : 0));
  }
  function error(code) { settle(refusal(frame?.id, new SupervisorError(code))); }
  const timer = setTimeout(() => error('CLIENT_TIMEOUT'), timeoutMs);
  async function send(raw) {
    try {
      frame = parseFrame(raw);
      validateFrame(frame, runnerId);
      const directory = await lstat(dirname(socketPath)), stat = await lstat(socketPath);
      if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700
        || await realpath(dirname(socketPath)) !== dirname(socketPath) || !stat.isSocket() || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o600) fail('UNSAFE_ENDPOINT');
      if (done) return;
      socket = net.createConnection(socketPath);
      socket.on('error', () => error('CARRIER_FAILED'));
      socket.on('connect', () => {
        socket.write(JSON.stringify({ runnerId, request: raw.toString('utf8') }) + '\n');
        raw.fill(0);
        // These objects are never retained in an entry, error or journal.
        if (frame.op === 'launch') frame.environment = {};
        if (frame.op === 'claim') delete frame.bootstrapTicket;
      });
      socket.on('data', chunk => {
        if (replyBytes.length + chunk.length > MAX_FRAME_BYTES) { error('INVALID_REPLY'); return; }
        replyBytes = Buffer.concat([replyBytes, chunk]);
      });
      socket.on('end', () => {
        try {
          if (replyBytes.at(-1) !== 10 || replyBytes.indexOf(10) !== replyBytes.length - 1) fail('INVALID_REPLY');
          const reply = decodeJson(replyBytes.subarray(0, -1), 'INVALID_REPLY');
          if (!reply || reply.id !== frame.id || !['qualified', 'launched', 'observed', 'parked', 'claimed', 'retired', 'absent', 'conflict', 'refused'].includes(reply.status)) fail('INVALID_REPLY');
          settle(reply);
        } catch { error('INVALID_REPLY'); }
      });
      socket.on('close', () => { if (!done) error('CARRIER_FAILED'); });
    } catch (caught) { settle(refusal(frame?.id, caught instanceof SupervisorError ? caught : new SupervisorError('CARRIER_FAILED'))); }
  }
  function onData(chunk) {
    if (sent) { error('INVALID_FRAME'); return; }
    if (bytes.length + chunk.length > MAX_FRAME_BYTES) { error('FRAME_TOO_LARGE'); return; }
    bytes = Buffer.concat([bytes, chunk]);
    const index = bytes.indexOf(10);
    if (index < 0) return;
    sent = true;
    if (index !== bytes.length - 1) { error('INVALID_FRAME'); return; }
    const raw = bytes; bytes = Buffer.alloc(0);
    void send(raw);
  }
  function onEnd() { if (!sent) error('INVALID_FRAME'); }
  function onError() { error('CARRIER_FAILED'); }
  input.on('data', onData); input.once('end', onEnd); input.once('error', onError);
  return result;
}
