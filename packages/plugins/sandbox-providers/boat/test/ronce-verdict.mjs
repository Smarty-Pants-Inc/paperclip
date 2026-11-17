// R-ONCE's bounded data-safety contract, not whole-application acceptance.
// A request-level admission error is reported separately, never hidden as a
// successful turn/start response. The brief forbids a production change when
// one provider turn and one matching answer already hold at the supplied base.
export function ronceChecks(result) {
  const { token, personMessage } = result.once ?? {};
  const receipts = result.once?.providerReceipts ?? [];
  const inputs = receipts.filter(r => r.event === 'turn-input');
  const answers = receipts.filter(r => r.event === 'answer');
  const visible = (result.events ?? []).filter(e => e.method === 'item/completed' && e.params?.item?.type === 'agentMessage');
  const completed = (result.events ?? []).filter(e => e.method === 'turn/completed');
  const pending = result.pendingAtArchive?.commands ?? [];
  const final = result.finalRunState?.controllerCommands ?? [];
  const archive = result.calls?.find(r => r.event === 'archive-start');
  const recovered = result.diagnostics?.find(r => r.message.includes('restored its durable PRP session'));
  return {
    uniqueFact: typeof token === 'string' && token.length >= 32 && personMessage === `The code word is ${token}. Tell me my code word.`,
    pendingBeforeArchive: pending.length === 1 && pending[0].status === 'pending' && pending[0].payload.text === personMessage && result.pendingAtArchive.at <= archive?.at && result.pendingAtArchive.providerTokenTurns === 0 && result.pendingAtArchive.answerCount === 0 && result.pendingAtArchive.oldRunnerStatuses?.length === 1 && result.pendingAtArchive.oldRunnerStatuses.every(r => r.state === 'T'),
    confirmedExitBeforeRestart: result.exit45 === 1 && result.launches === 2 && result.calls?.some(r => r.event === 'handle-resolved' && r.exitConfirmed === true && r.at < recovered?.at),
    oneProviderTurn: inputs.length === 1 && inputs[0].input?.filter(x => x.type === 'text').map(x => x.text).join('\n') === personMessage,
    noOldRunnerTurn: inputs.length === 1 && receipts.filter(r => r.event === 'provider-start').length === 2 && inputs[0].pid === receipts.filter(r => r.event === 'provider-start')[1].pid,
    oneMatchingProviderAnswer: answers.length === 1 && answers[0].text === `Your code word is ${token}.`,
    oneMatchingDeliveredAnswer: visible.length === 1 && visible[0].params.item.text === `Your code word is ${token}.` && visible[0].at >= recovered?.at,
    oneCompletedTurn: completed.length === 1 && completed[0].params?.turn?.status === 'completed' && completed[0].params.turn.id === answers[0]?.turnId,
    sameDurableCommandCompleted: final.length === 1 && final[0].status === 'completed' && final[0].commandId === pending[0]?.commandId && final[0].controllerSeq === pending[0]?.controllerSeq,
    finalStateSettled: result.failure === null && result.finalRunState?.transportFailure === null && result.finalRunState?.runnerLifecycle === 'ready' && result.finalRunState?.runnerActiveTurn === null && result.finalRunState?.providerState?.activeTurnId === null && result.finalRunState?.thread?.turns?.length === 1 && result.finalRunState.thread.turns[0].status === 'completed',
  };
}
export function roncePass(result) { return Object.values(ronceChecks(result)).every(Boolean); }
