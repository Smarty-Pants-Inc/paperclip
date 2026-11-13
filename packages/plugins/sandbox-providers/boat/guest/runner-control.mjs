#!/usr/bin/env node
// Fixed non-secret carrier command. The sole argument is the private socket path.
// Supply one JSON request plus LF on stdin, then EOF. No ticket in argv or env.
import net from 'node:net';
import { isAbsolute } from 'node:path';
import { closed, decodeJson, encodeJson, fail, MAX_REQUEST_BYTES, SupervisorError } from './protocol.mjs';

let socket;
let input = Buffer.alloc(0);
let output = Buffer.alloc(0);
let finished = false;
const timer = setTimeout(() => finish(null, 'CLIENT_TIMEOUT'), 40_000);
function finish(response, code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  socket?.destroy();
  process.stdin.destroy();
  if (code) {
    process.stdout.write(encodeJson({ ok: false, error: { code } }) + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(encodeJson(response) + '\n');
    if (!response.ok) process.exitCode = 1;
  }
}
process.stdout.on('error', () => { clearTimeout(timer); socket?.destroy(); process.stdin.destroy(); process.exitCode = 1; });
if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) finish(null, 'INVALID_ARGUMENTS');
else {
  process.stdin.on('error', () => finish(null, 'INVALID_REQUEST'));
  process.stdin.on('data', (bytes) => {
    if (input.length + bytes.length > MAX_REQUEST_BYTES) { finish(null, 'INVALID_REQUEST'); return; }
    input = Buffer.concat([input, bytes]);
  });
  process.stdin.on('end', () => {
    if (finished) return;
    try {
      if (input.indexOf(10) !== input.length - 1 || !input.length) fail('INVALID_REQUEST');
      decodeJson(input);
      socket = net.createConnection(process.argv[2]);
      socket.on('error', () => finish(null, 'CARRIER_FAILED'));
      socket.on('end', () => { if (!finished) finish(null, 'CARRIER_FAILED'); });
      socket.on('connect', () => { socket.write(input); input = Buffer.alloc(0); });
      socket.on('data', (bytes) => {
        try {
          if (output.length + bytes.length > 4096) fail('CARRIER_FAILED');
          output = Buffer.concat([output, bytes]);
          const end = output.indexOf(10);
          if (end === -1) return;
          if (end !== output.length - 1) fail('CARRIER_FAILED');
          const response = decodeJson(output, 'CARRIER_FAILED');
          if (!(response.ok === true && closed(response, ['ok', 'result']))
            && !(response.ok === false && closed(response, ['ok', 'error']) && closed(response.error, ['code'])
              && /^[A-Z_]+$/.test(response.error.code))) fail('CARRIER_FAILED');
          finish(response);
        } catch { finish(null, 'CARRIER_FAILED'); }
      });
    } catch (error) { finish(null, error instanceof SupervisorError ? error.code : 'CARRIER_FAILED'); }
  });
}
