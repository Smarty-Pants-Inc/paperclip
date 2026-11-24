/** Model a sandbox's /proc PID visibility on a shared, unprivileged test host.
 * Only directory enumeration is confined: stat/environ reads, process groups,
 * signals and exit observations all use the real kernel processes. The shared
 * host has non-dumpable sshd processes owned by our UID; production correctly
 * fails closed on unreadable environments instead of claiming an exit proof.
 */
export function sandboxPiProcessVisibility(script: string, pids: (number | undefined)[]): string {
  return `const visible = new Set(${JSON.stringify(pids.filter(pid => pid !== undefined).map(String))});
const procFs = require('fs'), readDir = procFs.readdirSync;
procFs.readdirSync = function(path, ...args) {
  const entries = readDir.call(this, path, ...args);
  return path === '/proc' ? entries.filter(n => visible.has(n) || n === String(process.pid)) : entries;
};\n${script}`;
}
