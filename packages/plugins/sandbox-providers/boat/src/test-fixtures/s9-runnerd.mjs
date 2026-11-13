// Fake native peer. Real process, real fd4, real atomic durable files.
// Never records tickets or frame bodies. This is not a runnerd qualification.
import { readFileSync, writeFileSync, renameSync, mkdirSync, fstatSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
const args = process.argv.slice(2);
const arg = (key) => args[args.indexOf(key) + 1];
if (args[0] === '--build-metadata') {
  console.log(JSON.stringify({ schema: 'paperclip-runner/runnerd-build-metadata/v1', binaryName: 'paperclip-runnerd', privateHostControlVersion: 1 }));
  process.exit(0);
}
if (args[0] === 'reap-lineage') {
  const stateDir = arg('--state-dir');
  const verified = !existsSync(`${stateDir}/deny-proof`);
  console.log(JSON.stringify({ schema: 'paperclip.runner.process-lineage-reap.v1', verified, reason: verified ? null : 'fixture_uncertainty', journals: 0, signalled: 0, remaining: [] }));
  process.exit(verified ? 0 : 1);
}
if (arg('--host-control-fd') !== '4' || !fstatSync(4).isSocket()) process.exit(71);
const mode = process.env.FAKE_MODE;
const stateDir = arg('--state-dir');
const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
mkdirSync(`${stateDir}/process-lineage`, { mode: 0o700, recursive: true });
writeFileSync(`${stateDir}/process-lineage/writer-${process.pid}.json`, JSON.stringify({ schema: 'paperclip.runner.process-lineage-writer.v1', writer: { pid: process.pid, started: Number(start) } }), { mode: 0o600 });
const state = { schema: 'paperclip.runner.durable.state.v1', runnerInstanceId: arg('--runner-id'), environmentLeaseId: arg('--environment-lease-id'), runId: arg('--run-id'), normalizedSessionId: arg('--session-id'), turnId: arg('--turn-id'), itemId: arg('--item-id'), lastControllerCommandSeq: 4, ackedSourceSeq: 8, nextSourceSeq: 9, lifecycle: 'running', outbox: [], processedCommands: {} };
function save() {
  writeFileSync(`${stateDir}/runner-state.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${stateDir}/runner-state.tmp`, `${stateDir}/runner-state.json`);
}
save();
if (mode === 'deny-proof') writeFileSync(`${stateDir}/deny-proof`, '', { mode: 0o600 });
let coldTicket = process.env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
if (process.env.EXPECTED_BOOTSTRAP_SHA256 && createHash('sha256').update(coldTicket ?? '').digest('hex') !== process.env.EXPECTED_BOOTSTRAP_SHA256) process.exit(72);
delete process.env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET;
coldTicket = undefined;
const socket = new net.Socket({ fd: 4, readable: true, writable: true });
const receipts = new Map();
let input = '', parked;
socket.on('data', (bytes) => {
  input += bytes.toString();
  while (input.includes('\n')) {
    const index = input.indexOf('\n'), raw = input.slice(0, index); input = input.slice(index + 1);
    const frame = JSON.parse(raw), digest = createHash('sha256').update(raw).digest('hex');
    const prior = receipts.get(frame.id);
    let status = prior ? prior.digest === digest ? prior.status : 'conflict' : frame.op === 'park' ? 'parked' : frame.parkId !== parked ? 'conflict' : frame.op === 'claim' ? 'claimed' : 'retired';
    if (mode === 'native-conflict') status = 'conflict';
    const expectedWire = process.env[`EXPECTED_${frame.op.toUpperCase()}_SHA256`];
    if (expectedWire && digest !== expectedWire) status = 'conflict';
    if (frame.op === 'park' && status === 'parked') parked = frame.id;
    if (!prior) {
      receipts.set(frame.id, { digest, status });
      if (process.env.FAKE_PROOF_FILE) {
        let effects={};try{effects=JSON.parse(readFileSync(process.env.FAKE_PROOF_FILE,'utf8'));}catch{}
        effects[frame.id]=(effects[frame.id]??0)+1;
        writeFileSync(process.env.FAKE_PROOF_FILE,JSON.stringify(effects),{mode:0o600});
      }
    }
    if (mode === 'drop-first-claim' && frame.op === 'claim' && !prior) continue;
    if (mode === 'silent') continue;
    if (mode === 'wire-check' && raw !== JSON.stringify(frame)) process.exit(73);
    if (status === 'retired') { state.lifecycle = 'suspended'; save(); }
    const response = JSON.stringify({ id: mode === 'wrong-id' ? 'wrong' : frame.id, status }) + '\n';
    const reply = () => socket.write(response, () => {
      if (status === 'retired' && mode !== 'retire-stays-live') {
        if (mode === 'retire-no-state') unlinkSync(`${stateDir}/runner-state.json`);
        process.exit(0);
      }
    });
    if (mode === 'delay-claim' && frame.op === 'claim') setTimeout(reply, Number(process.env.FAKE_DELAY_MS ?? 100)); else reply();
  }
});
socket.on('end', () => process.exit(0));
socket.on('error', () => process.exit(74));
