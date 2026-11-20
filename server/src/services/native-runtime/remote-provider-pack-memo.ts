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
  // A new controller lease row can name the same still-running allocation.
  // Keep requiring current lease authority above, but cache immutable bytes by
  // box identity; the per-use probe below still fences boot/root/manifest and
  // live Runner birth changes. The expected identity also binds the pack digest.
  return JSON.stringify([target.environmentId, target.providerKey ?? null,
    target.sandboxLeaseAcquisition.providerLeaseId]);
}

// One remote RPC, one stat invocation for the resolved root + manifest, and
// a re-read of the small manifest (not the pack tree). Hashing its exact bytes
// binds this probe to the manifest that passed the full canonical comparison.
// Include the existing launch marker and check its Linux process generation:
// the same allocation and runner instance ID can survive a Runner relaunch.
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
# Unknown/pre-launch generation never grants a memo receipt.
test -n "$2"
{
  IFS= read -r nonce
  IFS= read -r pid
  IFS= read -r started
  IFS= read -r runner
  IFS= read -r birth
  if IFS= read -r extra || test -n "\${extra:-}"; then exit 1; fi
} < "$2"
case "$pid" in ''|0|*[!0-9]*) exit 1 ;; esac
stat=$(/bin/cat "/proc/$pid/stat")
fields=\${stat##*) }
set -f
set -- $fields
case "$1" in Z|X|x) exit 1 ;; esac
shift 19
ticks=$1
boot=$(/bin/cat /proc/sys/kernel/random/boot_id)
test "$birth" = "linux:$boot:$ticks"
printf '%s\\n' "$nonce" "$pid" "$started" "$runner" "$birth"
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

async function probePack(runner: CommandManagedRuntimeRunner, cwd: string, packRoot: string, runnerIdentityPath?: string): Promise<Probe | null> {
  if (!runnerIdentityPath) return null;
  try {
    const result = await runner.execute({ command: "/bin/sh", args: ["-c", fingerprintScript, "sh", packRoot, runnerIdentityPath],
      cwd, bypassSession: true, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut || result.signal) return null;
    const lines = result.stdout.trimEnd().split("\n");
    if (lines.length !== 11 || !lines[0].startsWith("/") || !/^[a-zA-Z0-9-]{1,128}$/.test(lines[1])
      || !/^\d+$/.test(lines[2]) || Number(lines[2]) === 0
      || !protectedStat(lines[3], 0o040000) || !protectedStat(lines[4], 0o100000)
      || !/^[a-f0-9]{64}$/.test(lines[5]) || !lines[6] || !/^[1-9]\d*$/.test(lines[7])
      || !Number.isFinite(Date.parse(lines[8])) || !lines[9]
      || !/^linux:[0-9a-f-]+:[0-9]+$/.test(lines[10])
      || !lines[10].startsWith(`linux:${lines[1]}:`)) return null;
    return { root: lines[0], fingerprint: result.stdout };
  } catch { return null; } // A failed optimization must fall back to the full verifier.
}

export async function verifyWithRemoteProviderPackMemo<T>(input: {
  runner: CommandManagedRuntimeRunner;
  cwd: string;
  packRoot: string;
  scope?: string;
  runnerIdentityPath?: string;
  expectedIdentity: string;
  onMemoHit?: (startedAtMs: number, endedAtMs: number) => Promise<void>;
}, verify: (resolvedRoot: string) => Promise<T>): Promise<T> {
  if (!input.scope) return verify(input.packRoot);
  const startedAtMs = Date.now();
  const probe = await probePack(input.runner, input.cwd, input.packRoot, input.runnerIdentityPath);
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
    const after = await probePack(input.runner, input.cwd, input.packRoot, input.runnerIdentityPath);
    if (after?.fingerprint === probe.fingerprint) {
      verifiedPacks.set(key, { scope: input.scope, fingerprint: probe.fingerprint, value: structuredClone(verified) });
      if (verifiedPacks.size > MAX_VERIFIED_PACKS) verifiedPacks.delete(verifiedPacks.keys().next().value!);
    }
  }
  return verified;
}
