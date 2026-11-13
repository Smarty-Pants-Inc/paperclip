/**
 * Policy for every remote command, including pre-run probes and root commands.
 * Remote paths cannot be verified on the controller: disable Node's optional
 * compile cache even when a caller supplies a cache path or an empty flag.
 * A process-local owner (Pi) may subsequently select its verified private cache.
 */
export function remoteCommandEnvironment(environment: Record<string, string> = {}): Record<string, string> {
  return { ...environment, NODE_DISABLE_COMPILE_CACHE: "1" };
}

/** Duplex commands have argv but no env field. Use env without a shell so the
 * same policy reaches the initial process and descendants without re-quoting. */
export function remoteCommandArgv(command: readonly string[]): string[] {
  // Never turn a rejected empty command into `env`, which prints the env.
  if (!command.length || !command[0]) throw new Error("Remote duplex command must not be empty.");
  return ["env", ...Object.entries(remoteCommandEnvironment()).map(([key, value]) => `${key}=${value}`), ...command];
}
