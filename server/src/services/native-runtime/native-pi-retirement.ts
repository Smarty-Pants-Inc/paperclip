import { createHash } from "node:crypto";

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const fingerprint = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const proofs = new WeakSet<object>();
const fields = ["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId", "turnId", "itemId"] as const;
export type PiRetirementProof = Record<string, unknown> & { runnerSha256: string; providerSha256: string; processExitObserved: true };

/** An identity alone is not a stop receipt. Only this completed stop/ingest sequence issues one. */
export function piRetirementProves(proof: Record<string, unknown> | undefined, identity: unknown, runner?: unknown, provider?: unknown): boolean {
  return !!proof && proofs.has(proof) && fields.every(key => typeof proof[key] === "string" && proof[key] === record(identity)[key]) &&
    (runner === undefined || proof.runnerSha256 === fingerprint(runner)) &&
    (provider === undefined || proof.providerSha256 === fingerprint(provider));
}

/** Reconcile/replay first. Re-read after exit to close the tail-vs-stop race; never discard an unpublished answer. */
export async function retirePiRunnerByFact(input: {
  identity: Record<string, unknown>;
  read: () => Promise<{ runner: Record<string, unknown>; provider: Record<string, unknown> }>;
  settle: (runner: Record<string, unknown>) => Promise<void>;
  stop: (provider: Record<string, unknown>) => Promise<void>;
  checkpointWarm?: () => Promise<void>;
  collectStopped: () => Promise<void>;
  recordProof: (proof: PiRetirementProof) => Promise<void>;
}): Promise<PiRetirementProof> {
  const before = await input.read();
  const matches = (state: Record<string, unknown>) => fields.every(key => typeof input.identity[key] === "string" && input.identity[key] === state[key]);
  if (!matches(before.runner)) throw new Error("native_pi_retirement_identity_mismatch");
  await input.settle(before.runner);
  await input.checkpointWarm?.();
  await input.stop(before.provider);
  const after = await input.read();
  if (!matches(after.runner)) throw new Error("native_pi_retirement_identity_mismatch");
  // Publish the shutdown tail even when provider settlement or file collection fails.
  await input.settle(after.runner);
  if (record(after.provider.config).provider !== "pi_rpc" ||
      Object.keys(record(record(after.provider.toolBridge).pending)).length ||
      [after.provider.pendingEvents, after.provider.queuedEvents].some(v => Array.isArray(v) && v.length)) {
    throw new Error("native_pi_retirement_tail_unsettled");
  }
  await input.collectStopped();
  const proof: PiRetirementProof = { ...input.identity, runnerSha256: fingerprint(after.runner),
    providerSha256: fingerprint(after.provider), processExitObserved: true };
  await input.recordProof(proof);
  proofs.add(proof);
  return proof;
}

/** Pi may restart into a new group after the saved startupAttempt. Discover EVERY group by
 * its exact runtime directory, then observe all group members gone (not just their leaders).
 * Run only AFTER the exact-generation Runner has exited, so it cannot spawn another provider. */
export const STOP_PI_PROCESS_GROUP = String.raw`
const fs = require('fs');
const [directory, raw] = process.argv.slice(1);
const attempt = JSON.parse(raw).startupAttempt;
const groups = new Set();
const scope = attempt && Number.isSafeInteger(attempt.processGroupId) && attempt.processGroupId > 1 ? attempt.processGroupId : null;
function rows() {
  return fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
    try { const s = fs.readFileSync('/proc/'+n+'/stat','utf8').replace(/^.*\) /,'').split(' ');
      return !['Z','X','x'].includes(s[0]) ? [{pid:Number(n), group:Number(s[2])}] : []; }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return []; throw e; }
  });
}
(async () => {
  const ownGroup = rows().find(p=>p.pid===process.pid).group;
  async function environment(p) {
    for (let retry = 0; ; retry++) {
      try { return fs.readFileSync('/proc/'+p.pid+'/environ','utf8').split('\0'); }
      catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ESRCH' || !rows().some(r=>r.pid===p.pid)) return [];
        // Linux may revoke environ access while a process is entering exit. Only
        // observed death permits skipping it; a live unreadable process fails closed.
        if (e.code !== 'EACCES' || retry >= 10) throw e;
        await new Promise(r=>setTimeout(r,20));
      }
    }
  }
  async function discover() {
  for (const p of rows()) {
    try {
      if (fs.statSync('/proc/'+p.pid).uid !== process.getuid()) continue;
      const env = await environment(p);
      if (env.includes('PAPERCLIP_PI_RUNTIME_DIR='+directory)) {
        if (p.group <= 1 || p.group === ownGroup) throw Error('provider_group_identity_unproven');
        groups.add(p.group);
      }
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
  }
  }
  await discover();
  // The stale recorded group is a cross-check, never the scan boundary.
  if (scope !== null && rows().some(p=>p.group===scope) && !groups.has(scope)) throw Error('recorded_provider_group_identity_unproven');
  const members = async () => { await discover(); return rows().filter(p=>groups.has(p.group)); };
  for (const signal of ['SIGTERM','SIGKILL']) {
    if (!(await members()).length) break;
    for (const group of groups) { try { process.kill(-group,signal); } catch(e) { if(e.code!=='ESRCH') throw e; } }
    for (let n=0; n<40 && (await members()).length; n++) await new Promise(r=>setTimeout(r,50));
  }
  if ((await members()).length) throw Error('provider_group_exit_unproven');
  process.stdout.write('pi_process_group_exit_observed\n');
})().catch(e=>{ console.error(e.message); process.exitCode=42; });
`;
