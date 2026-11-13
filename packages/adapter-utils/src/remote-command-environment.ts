/** Select a cache owned by the remote calling uid without creating a provider env
 * object. A caller-owned cache (including Pi's verified private cache) wins.
 * Original arguments pass through "$@" without interpolation or re-quoting. */
export function remoteCommandArgv(command: readonly string[]): string[] {
  if (!command.length || !command[0]) throw new Error("Remote duplex command must not be empty.");
  return ["sh", "-c", 'if [ -z "${NODE_COMPILE_CACHE:-}" ]; then d="${XDG_CACHE_HOME:-${HOME:-/nonexistent}/.cache}/node-compile-cache"; if mkdir -p "$d" 2>/dev/null && [ -w "$d" ] && [ -O "$d" ]; then NODE_COMPILE_CACHE="$d"; export NODE_COMPILE_CACHE; unset NODE_DISABLE_COMPILE_CACHE; else NODE_DISABLE_COMPILE_CACHE=1; export NODE_DISABLE_COMPILE_CACHE; fi; fi; exec "$@"', "paperclip-node-cache", ...command];
}
