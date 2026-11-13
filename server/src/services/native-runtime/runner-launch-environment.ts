/** Boat's exec service may add machine credentials after Core projects env.
 * Run only at the runnerd launch boundary, before exec, not in general commands.
 * exec retires the shell (unset alone would leave its original /proc environ).
 * Node is already required by the remote runner contract; emit names, never values.
 */
export const RUNNER_LAUNCH_ENVIRONMENT_SCRIPT =
  'set -eu; paperclip_ascii_names=$(node -e \'for (const name of Object.keys(process.env)) if (name.startsWith("ASCII_")) { if (!/^ASCII_[A-Za-z0-9_]+$/.test(name)) process.exit(1); console.log(name); }\'); for paperclip_ascii_name in $paperclip_ascii_names; do unset "$paperclip_ascii_name"; done; ';
