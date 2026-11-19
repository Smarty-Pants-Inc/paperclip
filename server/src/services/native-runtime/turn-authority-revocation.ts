/**
 * Pause-only, process-local certificate: the server's own record that the
 * exact in-process executor of a run no longer holds turn authority.
 *
 * It is set when the native Stop path has revoked that executor's turn:
 * right after the session's synchronous `cancel` returns (its contract makes
 * cancel the authority transition; cleanup is passive), or once its
 * `interrupt` returned or did not return within the short revocation bound.
 * It is bound to one executor epoch (one heartbeat execution of the run) and
 * dropped when that run opens a new provider session, so a later attempt or
 * generation never inherits it.
 *
 * It is NEVER a process-stop receipt, an idle checkpoint, an exported
 * workspace or a lease cleanup. Only a person's Pause readiness reads it (with
 * the run already cancelled in the DB); Terminate/cleanup keep full proof.
 */
export type TurnAuthorityRevocation = {
  runId: string;
  epoch: number;
  via: "session_cancel" | "interrupt" | "revocation_bound";
  revokedAt: Date;
};

let nextEpoch = 0;
const executorEpochs = new Map<string, number>();
const revocations = new Map<string, TurnAuthorityRevocation>();
/** Runs whose CURRENT executor epoch is being cancelled by a person's Pause (agent_paused). */
const pauseCancellations = new Map<string, number>();

/** The heartbeat executor took ownership of this run: a fresh epoch, no certificate. */
export function beginTurnAuthorityEpoch(runId: string): number {
  const epoch = ++nextEpoch;
  executorEpochs.set(runId, epoch);
  revocations.delete(runId);
  pauseCancellations.delete(runId);
  return epoch;
}

/** The executor that owned `epoch` left; a newer owner's record is untouched. */
export function endTurnAuthorityEpoch(runId: string, epoch: number) {
  if (executorEpochs.get(runId) !== epoch) return;
  executorEpochs.delete(runId);
  revocations.delete(runId);
  pauseCancellations.delete(runId);
}

/** A new provider session/attempt of the run: any earlier certificate is void. */
export function resetTurnAuthority(runId: string) {
  revocations.delete(runId);
}

export function revokeTurnAuthority(runId: string, via: TurnAuthorityRevocation["via"]) {
  const epoch = executorEpochs.get(runId);
  if (epoch === undefined || revocations.has(runId)) return;
  revocations.set(runId, { runId, epoch, via, revokedAt: new Date() });
}

/** The certificate of the run's CURRENT executor epoch, or null. */
export function turnAuthorityRevocation(runId: string): TurnAuthorityRevocation | null {
  const record = revocations.get(runId);
  return record && executorEpochs.get(runId) === record.epoch ? record : null;
}

/** The Pause cancel (errorCode agent_paused) of the run's CURRENT executor epoch began. */
export function notePauseCancellation(runId: string) {
  const epoch = executorEpochs.get(runId);
  if (epoch !== undefined) pauseCancellations.set(runId, epoch);
}

/**
 * The run's turn was revoked by a person's Pause and its own executor (its
 * teardown) is still running here: the certificate of the current epoch, and
 * that epoch's cancel was the Pause. A person's Stop never notes a Pause, so
 * it never answers true for a Stop.
 */
export function pauseRevokedTurn(runId: string): boolean {
  const record = turnAuthorityRevocation(runId);
  return record !== null && pauseCancellations.get(runId) === record.epoch;
}
