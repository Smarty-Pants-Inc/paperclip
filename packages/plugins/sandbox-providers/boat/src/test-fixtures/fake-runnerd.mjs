// A real process, not a mocked spawn. Never persist or print incoming frames.
import { fstatSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { createHash } from 'node:crypto';

if (process.argv.at(-2) !== '--host-control-fd' || process.argv.at(-1) !== '4') process.exit(71);
if (!fstatSync(4).isSocket()) process.exit(72);
// Linux /proc identifies the inherited descriptor as an AF_UNIX connected stream.
const inode = String(fstatSync(4).ino);
const row = readFileSync('/proc/net/unix', 'utf8').split('\n')
  .map((line) => line.trim().split(/\s+/)).find((cols) => cols[6] === inode);
if (!row || row[4] !== '0001' || row[5] !== '03') process.exit(73);
const socket = new net.Socket({ fd: 4, readable: true, writable: true });
const mode = process.env.FAKE_MODE;
// Model durable runnerd's one-time capture, without returning the secret on fd4.
if (mode === 'bootstrap') {
  let ticket = process.env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
  delete process.env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
  if (!ticket || createHash('sha256').update(ticket).digest('hex') !== process.env.EXPECTED_BOOTSTRAP_SHA256) process.exit(75);
  ticket = undefined;
}
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
let input = '';
let parkId;
let receipts = new Map();
let delayed = false;
const applied = {};
socket.setEncoding('utf8');
socket.on('data', (data) => {
  input += data;
  while (input.includes('\n')) {
    const end = input.indexOf('\n');
    const text = input.slice(0, end);
    input = input.slice(end + 1);
    const frame = JSON.parse(text);
    const digest = createHash('sha256').update(text).digest('hex');
    const prior = receipts.get(frame.id);
    let status = prior ? (prior.digest === digest ? prior.status : 'conflict') :
      frame.op === 'park' ? 'parked' : frame.parkId !== parkId ? 'conflict' :
        frame.op === 'claim' ? 'claimed' : 'retired';
    if (!prior && status !== 'conflict') {
      if (status === 'parked') { receipts = new Map(); parkId = frame.id; }
      receipts.set(frame.id, { digest, status });
      applied[frame.id] = (applied[frame.id] ?? 0) + 1;
      // Test-only effect receipt: no request, digest, environment, or ticket.
      if (process.env.FAKE_PROOF_FILE) writeFileSync(process.env.FAKE_PROOF_FILE, JSON.stringify(applied));
    }
    if (mode === 'drop-first-claim' && frame.op === 'claim' && !prior) continue;
    if (mode === 'silent') continue;
    let reply = JSON.stringify({ id: mode === 'wrong-id' ? 'wrong' : frame.id, status }) + '\n';
    if (mode === 'extra-field') reply = JSON.stringify({ id: frame.id, status, extra: 'bad' }) + '\n';
    if (mode === 'oversize-reply') reply = 'x'.repeat(2048);
    if (mode === 'delay-first-claim' && frame.op === 'claim' && !delayed) {
      delayed = true;
      setTimeout(() => socket.write(reply), 200);
    } else socket.write(reply);
  }
});
socket.on('end', () => process.exit(0));
socket.on('error', () => process.exit(74));
