/**
 * Pause-only, process-local certificate: the server's own record that the
 * exact in-process executor of a run no longer holds turn authority.
 *
 * It is set when the native Stop path has revoked that executor's turn:
 * right after the session's synchronous `cancel` returns (its contract makes
 * cancel the authority transition; cleanup is passive), or once its
 * `interrupt` returned or did not return within the short revocation bound.
 * It is bound to the turn owner the cancelling owner captured (one executor
 * epoch plus its attempt generation) and dropped when that run opens a new
 * provider session, so a later attempt or generation never inherits it, and an
 * older owner's late revoke never certifies a newer one.
 *
 * It is NEVER a process-stop receipt, an idle checkpoint, an exported
 * workspace or a lease cleanup. Only a person's Pause readiness reads it (with
 * the run already cancelled in the DB); Terminate/cleanup keep full proof.
 */
export type TurnAuthorityRevocation = {
  runId: string;
  epoch: number;
  /** The attempt generation (executor / provider session) whose turn was revoked. */
  generation: number;
  via: "session_cancel" | "interrupt" | "revocation_bound";
  revokedAt: Date;
};

/**
 * The exact turn owner a cancelling owner captured when it began its cancel:
 * the executor epoch plus the attempt generation, which advances on every new
 * executor, reset and new provider session of the run. A revoke carries this
 * captured owner, never a fresh read of the run's current one.
 */
export type TurnAuthorityOwner = { runId: string; epoch: number; generation: number };

let nextEpoch = 0;
let nextGeneration = 0;
const executorEpochs = new Map<string, number>();
const attemptGenerations = new Map<string, number>();
const revocations = new Map<string, TurnAuthorityRevocation>();
/** Runs whose CURRENT executor epoch is being cancelled by a person's Pause (agent_paused). */
const pauseCancellations = new Map<string, number>();

/** The heartbeat executor took ownership of this run: a fresh epoch and generation, no certificate. */
export function beginTurnAuthorityEpoch(runId: string): number {
  const epoch = ++nextEpoch;
  executorEpochs.set(runId, epoch);
  attemptGenerations.set(runId, ++nextGeneration);
  revocations.delete(runId);
  pauseCancellations.delete(runId);
  return epoch;
}

/** The executor that owned `epoch` left; a newer owner's record is untouched. */
export function endTurnAuthorityEpoch(runId: string, epoch: number) {
  if (executorEpochs.get(runId) !== epoch) return;
  executorEpochs.delete(runId);
  attemptGenerations.delete(runId);
  revocations.delete(runId);
  pauseCancellations.delete(runId);
}

/** The run's current turn owner (epoch + attempt generation), or null when no executor owns it here. */
export function captureTurnAuthority(runId: string): TurnAuthorityOwner | null {
  const epoch = executorEpochs.get(runId);
  const generation = attemptGenerations.get(runId);
  return epoch === undefined || generation === undefined ? null : { runId, epoch, generation };
}

/**
 * A new provider session/attempt of the run: the attempt generation advances,
 * so any earlier certificate, and any revoke an earlier attempt's cancelling
 * owner still has in flight, is void. Returns the new attempt's owner.
 */
export function resetTurnAuthority(runId: string): TurnAuthorityOwner | null {
  revocations.delete(runId);
  if (executorEpochs.has(runId)) attemptGenerations.set(runId, ++nextGeneration);
  return captureTurnAuthority(runId);
}

/**
 * The cancelling owner revoked ITS captured turn. A revoke from an older
 * executor epoch or attempt generation (a late continuation after a
 * replacement executor, a reset or a new provider session) is ignored; a
 * revoke without a captured owner certifies nothing.
 */
export function revokeTurnAuthority(runId: string, via: TurnAuthorityRevocation["via"], owner?: TurnAuthorityOwner | null) {
  if (!owner || owner.runId !== runId) return;
  if (executorEpochs.get(runId) !== owner.epoch || attemptGenerations.get(runId) !== owner.generation) return;
  const existing = revocations.get(runId);
  if (existing && existing.epoch === owner.epoch && existing.generation === owner.generation) return;
  revocations.set(runId, { runId, epoch: owner.epoch, generation: owner.generation, via, revokedAt: new Date() });
}

/**
 * The certificate of the run's CURRENT executor epoch AND attempt generation,
 * or null. Every consumer (both Pause readiness gates, the queue holds, the
 * fresh-session seam) reads through this, so it checks the generation.
 */
export function turnAuthorityRevocation(runId: string): TurnAuthorityRevocation | null {
  const record = revocations.get(runId);
  return record && executorEpochs.get(runId) === record.epoch && attemptGenerations.get(runId) === record.generation
    ? record : null;
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
