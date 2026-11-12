import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { verifyRemoteProviderPack, type PackProvider, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";

/** Same publisher-sealed installation boundary as runnerd's providerPacks
 * inventory. This fallback also works with an older snapshot daemon that does
 * not report inventory. Never execute a binary from an unadmitted pack here.
 * The image publisher verifies the complete pack before sealing it; runtime
 * admission reads only its protected manifest, not gigabytes of provider files.
 */
export async function verifySnapshotProviderPack<T extends ProviderPackIdentity>(input: {
  runner: CommandManagedRuntimeRunner;
  cwd: string;
  packRoot: string;
  manifest: T;
  provider: PackProvider;
}): Promise<T> {
  const probe = String.raw`
set -eu
root=$1
case "$root" in /*) ;; *) exit 1 ;; esac
# Reject aliases, writable ancestors (including ACL grants), and non-root owners.
[ "$(cd "$root" && pwd -P)" = "$root" ] || exit 1
protected() {
  [ ! -L "$1" ] && [ ! -w "$1" ] || return 1
  [ "$(stat -c %u -- "$1")" = 0 ] || return 1
  mode=$(stat -c %a -- "$1") || return 1
  [ "$((0$mode & 022))" = 0 ]
}
parent=$root
while :; do
  [ -d "$parent" ] && protected "$parent" || exit 1
  [ "$parent" != / ] || break
  parent=$(dirname -- "$parent")
done
# A sealed top directory is insufficient: a writable child would permit
# changing provider bytes without replacing the manifest. Check metadata, not
# file contents; the publisher already verified the complete digest at build.
bad=$(find "$root" ! -type l \( ! -uid 0 -o -perm /022 -o -writable \) -print -quit) || exit 1
[ -z "$bad" ] || exit 1
# Root-owned links may only resolve within this already protected tree.
bad=$(find "$root" -type l ! -uid 0 -print -quit) || exit 1
[ -z "$bad" ] || exit 1
find "$root" -type l -exec sh -c '
  root=$1; shift
  for link do
    target=$(readlink -f -- "$link") || exit 1
    case "$target" in "$root"/*) ;; *) exit 1 ;; esac
    [ -e "$target" ] || exit 1
  done
' paperclip-snapshot-links "$root" {} + || exit 1
file=$root/provider-pack.json
[ -f "$file" ] && protected "$file" || exit 1
[ "$(wc -c < "$file")" -le 65536 ] || exit 1
base64 < "$file"
`;
  const result = await input.runner.execute({ command: "sh", args: ["-c", probe, "paperclip-snapshot-pack", input.packRoot],
    cwd: input.cwd, bypassSession: true, timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.timedOut || result.signal) {
    throw new Error("runner_remote_provider_artifact_incompatible: snapshot installation is not protected");
  }
  let manifest: unknown;
  try {
    if (result.stdout.length > 100_000) throw new Error("manifest too large");
    manifest = JSON.parse(Buffer.from(result.stdout.trim(), "base64").toString("utf8"));
  } catch {
    throw new Error("runner_remote_provider_artifact_incompatible: snapshot manifest is unreadable");
  }
  // Reuse the existing digest, schema, target and artifact-path contract. Native
  // Pi never substitutes compatibility or a matching version for exact identity.
  return verifyRemoteProviderPack({ ...input, requireExactIdentity: true,
    installation: { root: input.packRoot, immutable: true, manifest } });
}
