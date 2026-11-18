import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

// Process-local only: a restart, an unknown allocation, or eviction always
// requires another full verification. No persisted receipt grants a memo hit.
const verifiedPacks = new Map<string, { scope: string; fingerprint: string; value: unknown }>();
const MAX_VERIFIED_PACKS = 256;

type RemoteTargetIdentity = {
  transport: string;
  environmentId?: string | null;
  providerKey?: string | null;
  leaseId?: string | null;
  sandboxLeaseAcquisition?: { providerLeaseId: string } | null;
};

export function remoteProviderPackMemoScope(target: RemoteTargetIdentity): string | undefined {
  if (target.transport !== "sandbox" || !target.environmentId || !target.leaseId
    || !target.sandboxLeaseAcquisition?.providerLeaseId) return undefined;
  return JSON.stringify([target.environmentId, target.providerKey ?? null, target.leaseId,
    target.sandboxLeaseAcquisition.providerLeaseId]);
}

// One remote RPC, one stat invocation for the resolved root + manifest, and
// a re-read of the small manifest (not the pack tree). Hashing its exact bytes
// binds this probe to the manifest that passed the full canonical comparison.
const fingerprintScript = `# paperclip-provider-pack-fingerprint-v1
set -eu
root=$(/usr/bin/realpath -e -- "$1")
test -d "$root"
printf '%s\\n' "$root"
/bin/cat /proc/sys/kernel/random/boot_id
/usr/bin/id -u
/usr/bin/stat -L -c '%d:%i:%Y:%s:%u:%f:%Z:%y:%z' -- "$root" "$root/provider-pack.json"
sum=$(/usr/bin/sha256sum -- "$root/provider-pack.json")
printf '%s\\n' "\${sum%% *}"
`;

// The cheap root stat alone cannot prove that descendants are immutable.
// Audit the entire resolved tree and its ancestors on a cold admission only.
// External symlink targets are deliberately not memoized: their parent chain
// is not covered by the pack's immutability proof.
const immutableScript = `# paperclip-provider-pack-immutable-v1
set -eu
root=$(/usr/bin/realpath -e -- "$1")
parent=$root
while :; do
  ownership=$(/usr/bin/stat -L -c '%u %a' -- "$parent")
  set -- $ownership
  test "$1" = 0 && test "$((0$2 & 022))" = 0
  test "$parent" != / || break
  parent=\${parent%/*}
  parent=\${parent:-/}
done
bad=$(/usr/bin/find -L "$root" \\( ! -uid 0 -o -perm /022 -o \\( ! -type d -a ! -type f \\) \\) -print -quit)
test -z "$bad"
/usr/bin/find "$root" -type l -exec /bin/sh -c '
  root=$1; shift
  for link do
    resolved=$(/usr/bin/realpath -e -- "$link") || exit 1
    case "$resolved" in "$root"|"$root"/*) ;; *) exit 1 ;; esac
  done
' sh "$root" {} +
printf 'immutable\\n'
`;

type Probe = { root: string; fingerprint: string };
function protectedStat(line: string, type: number): boolean {
  const match = /^(\d+):(\d+):(-?\d+):(\d+):(\d+):([a-f0-9]+):(-?\d+)(?::.*)?$/.exec(line);
  if (!match || match[5] !== "0") return false;
  const mode = Number.parseInt(match[6], 16);
  return (mode & 0o170000) === type && (mode & 0o022) === 0;
}

async function probePack(runner: CommandManagedRuntimeRunner, cwd: string, packRoot: string): Promise<Probe | null> {
  try {
    const result = await runner.execute({ command: "/bin/sh", args: ["-c", fingerprintScript, "sh", packRoot],
      cwd, bypassSession: true, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut || result.signal) return null;
    const lines = result.stdout.trimEnd().split("\n");
    if (lines.length !== 6 || !lines[0].startsWith("/") || !/^[a-zA-Z0-9-]{1,128}$/.test(lines[1])
      || !/^\d+$/.test(lines[2]) || Number(lines[2]) === 0
      || !protectedStat(lines[3], 0o040000) || !protectedStat(lines[4], 0o100000)
      || !/^[a-f0-9]{64}$/.test(lines[5])) return null;
    return { root: lines[0], fingerprint: result.stdout };
  } catch { return null; } // A failed optimization must fall back to the full verifier.
}

export async function verifyWithRemoteProviderPackMemo<T>(input: {
  runner: CommandManagedRuntimeRunner;
  cwd: string;
  packRoot: string;
  scope?: string;
  expectedIdentity: string;
  onMemoHit?: (startedAtMs: number, endedAtMs: number) => Promise<void>;
}, verify: (resolvedRoot: string) => Promise<T>): Promise<T> {
  if (!input.scope) return verify(input.packRoot);
  const startedAtMs = Date.now();
  const probe = await probePack(input.runner, input.cwd, input.packRoot);
  if (!probe) {
    // A failed read must not leave an older success eligible for the next turn.
    for (const [key, entry] of verifiedPacks) if (entry.scope === input.scope) verifiedPacks.delete(key);
    return verify(input.packRoot);
  }
  const key = JSON.stringify([input.scope, probe.root, input.expectedIdentity]);
  const previous = verifiedPacks.get(key);
  if (previous?.fingerprint === probe.fingerprint) {
    verifiedPacks.delete(key);
    verifiedPacks.set(key, previous);
    await input.onMemoHit?.(startedAtMs, Date.now());
    return structuredClone(previous.value) as T;
  }
  verifiedPacks.delete(key);
  let immutable = false;
  try {
    const result = await input.runner.execute({ command: "/bin/sh", args: ["-c", immutableScript, "sh", probe.root],
      cwd: input.cwd, bypassSession: true, timeoutMs: 120_000 });
    immutable = result.exitCode === 0 && !result.timedOut && !result.signal && result.stdout === "immutable\n";
  } catch { /* Uncertain or writable packs still get the complete verifier. */ }
  // Verify the captured resolved root, not a caller-writable alias that could
  // be retargeted during verification and poison another root's memo entry.
  const verified = await verify(probe.root); // Never cache an in-flight or failed verification.
  if (immutable) {
    const after = await probePack(input.runner, input.cwd, input.packRoot);
    if (after?.fingerprint === probe.fingerprint) {
      verifiedPacks.set(key, { scope: input.scope, fingerprint: probe.fingerprint, value: structuredClone(verified) });
      if (verifiedPacks.size > MAX_VERIFIED_PACKS) verifiedPacks.delete(verifiedPacks.keys().next().value!);
    }
  }
  return verified;
}
