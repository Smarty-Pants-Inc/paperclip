// Keep: R-ONCE data-safety boundary; real archived-run evidence is the fixture.
// Negative controls mutate that observed evidence, not production assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roncePass, ronceChecks } from './ronce-verdict.mjs';
const observed = JSON.parse(readFileSync(new URL('./evidence/ronce-e8c7dd34.json', import.meta.url)));
test('the real-runner pending-message restart satisfies every R-ONCE check', () => {
  assert.equal(roncePass(observed), true, JSON.stringify(ronceChecks(observed)));
});
const mutations = {
  'lost provider input': r => { r.once.providerReceipts = r.once.providerReceipts.filter(x => x.event !== 'turn-input'); },
  'duplicated provider turn': r => { r.once.providerReceipts.push(r.once.providerReceipts.find(x => x.event === 'turn-input')); },
  'old generation also received the message': r => { const row = r.once.providerReceipts.find(x => x.event === 'turn-input'); row.pid = r.once.providerReceipts.find(x => x.event === 'provider-start').pid; },
  'different turn input with the right answer': r => { r.once.providerReceipts.find(x => x.event === 'turn-input').input[0].text = 'another message'; },
  'lost provider answer': r => { r.once.providerReceipts = r.once.providerReceipts.filter(x => x.event !== 'answer'); },
  'duplicated provider answer': r => { r.once.providerReceipts.push(r.once.providerReceipts.find(x => x.event === 'answer')); },
  'answer lacks the unique fact': r => { r.once.providerReceipts.find(x => x.event === 'answer').text = 'An authenticated answer.'; },
  'provider answer never delivered': r => { r.events = r.events.filter(x => x.method !== 'item/completed'); },
  'answer delivered twice': r => { r.events.push(r.events.find(x => x.method === 'item/completed' && x.params?.item?.type === 'agentMessage')); },
  'message already answered before archive': r => { r.pendingAtArchive.answerCount = 1; },
  'message not durable before archive': r => { r.pendingAtArchive.commands = []; },
  'message not pending at archive': r => { r.pendingAtArchive.commands[0].status = 'completed'; },
  'unconfirmed exit does not authorize restart': r => { for (const x of r.calls) if (x.event === 'handle-resolved') x.exitConfirmed = false; },
  'no actual exit-45 observation': r => { r.exit45 = 0; },
  'duplicate durable command': r => { r.finalRunState.controllerCommands.push(r.finalRunState.controllerCommands[0]); },
  'different command supplied the answer': r => { r.finalRunState.controllerCommands[0].commandId = 'another-command'; },
  'final turn still active': r => { r.finalRunState.providerState.activeTurnId = 'still-active'; },
  'final turn failed': r => { r.finalRunState.thread.turns[0].status = 'failed'; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, () => {
  const changed = structuredClone(observed); mutate(changed); assert.equal(roncePass(changed), false);
});
test('R-ONCE is not misreported as successful request admission', () => {
  assert.equal(observed.requestAdmission.verdict, 'FAIL');
  assert.equal(observed.requestAdmission.error, 'runnerd exited while waiting for turn.start');
  assert.equal(observed.finalRunState.turnResult, null);
});
