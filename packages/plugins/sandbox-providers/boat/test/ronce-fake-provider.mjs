// Test-only input-sensitive adapter around the existing Rust fake Codex server.
// The token is NOT passed as an argument/environment/file: only turn/start input
// can supply it. Append-only receipts span both old and replacement processes.
import { spawn } from 'node:child_process';
import { appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [binary, log, ...args] = process.argv.slice(2);
const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] });
function record(row) {
  appendFileSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, ...row }) + '\n', { mode: 0o600 });
  const fd = openSync(log, 'r'); fsyncSync(fd); closeSync(fd);
}
record({ event: 'provider-start', upstreamPid: child.pid });
const pending = new Map(), turns = new Map();
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'turn/start') {
    const input = message.params?.input ?? [];
    const text = input.filter(x => x.type === 'text').map(x => x.text).join('\n');
    pending.set(message.id, text.match(/code word is ([a-f0-9-]+)/)?.[1] ?? null);
    record({ event: 'turn-input', requestId: message.id, input, upstreamPid: child.pid });
  }
  child.stdin.write(line + '\n');
}).on('close', () => child.stdin.end());
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (pending.has(message.id) && message.result?.turn?.id) {
    turns.set(message.result.turn.id, pending.get(message.id));
    pending.delete(message.id);
  }
  if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
    const token = turns.get(message.params.turnId);
    message.params.item.text = token ? `Your code word is ${token}.` : 'No code word was supplied in this turn.';
    record({ event: 'answer', turnId: message.params.turnId, text: message.params.item.text });
  }
  process.stdout.write(JSON.stringify(message) + '\n');
});
child.on('exit', (code, signal) => { record({ event: 'provider-exit', code, signal }); process.exitCode = code ?? 1; });
child.on('error', error => { console.error(error); process.exitCode = 1; });
