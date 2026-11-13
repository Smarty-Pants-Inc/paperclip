/** S9 allocation-local, trusted distribution contract. No caller-selected paths. */
export const GUARDIAN_ENTRY = "/usr/local/libexec/paperclip-runner-guardian";
export const GUARDIAN_SOCKET = "/run/paperclip-runner-guardian/control.sock";
export const GUARDIAN_COMMAND = [GUARDIAN_ENTRY, "client", "--protocol", "1", "--runner-id"] as const;
export function guardianCommand(runnerId: string): string[] {
  // These IDs are passed through an OpenSSH remote-command string. Do not allow
  // shell syntax, whitespace, quotes or option injection even if a frame ID can.
  if (typeof runnerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runnerId)) throw new Error("BOAT_SSH_INVALID_RUNNER");
  return [...GUARDIAN_COMMAND, runnerId];
}
export function guardianRunner(command: readonly string[]): string {
  if (!Array.isArray(command) || command.length !== GUARDIAN_COMMAND.length + 1 ||
      GUARDIAN_COMMAND.some((arg, i) => arg !== command[i])) throw new Error("Boat duplex command is not the trusted guardian client.");
  const runnerId = command[GUARDIAN_COMMAND.length]; guardianCommand(runnerId); return runnerId;
}
