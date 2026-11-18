// The launch writer atomically renames runner-process.identity. Watch its
// directory BEFORE the initial read so publication on either side of subscribe
// is observed. One deadline/final read is a safety net, not recurring polling.
export const REMOTE_RUNNER_IDENTITY_READY_SCRIPT = `
const fs = require("node:fs"), path = require("node:path");
const [file, nonce, runnerId, timeout, requireFingerprint] = process.argv.slice(2);
let watcher, timer, done = false;
function finish(value) {
  if (done) return;
  done = true; clearTimeout(timer); watcher?.close();
  if (value) process.stdout.write(value);
  else process.exitCode = 3;
}
function read() {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let value;
    try { const held = fs.fstatSync(fd); if (!held.isFile() || held.size > 4096) return; value = fs.readFileSync(fd, "utf8"); }
    finally { fs.closeSync(fd); }
    const [actualNonce, pid, startedAt, actualRunner, fingerprint, ...extra] = value.trim().split("\\n");
    if (actualNonce !== nonce || actualRunner !== runnerId || extra.length ||
        !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0 || !startedAt || Number.isNaN(Date.parse(startedAt)) ||
        (fingerprint !== undefined && !/^linux:[0-9a-f-]+:[0-9]+$/.test(fingerprint)) ||
        (requireFingerprint === "true" && !fingerprint)) return;
    return value;
  } catch { return; }
}
timer = setTimeout(() => finish(read()), Math.max(1, Math.min(20000, Number(timeout) || 20000)));
try {
  watcher = fs.watch(path.dirname(file), () => { const value = read(); if (value) finish(value); });
  watcher.once("error", () => {
    watcher.close(); watcher = undefined;
    const value = read(); if (value) finish(value);
  });
} catch { /* An unavailable watcher leaves the bounded final read authoritative. */ }
const value = read(); if (value) finish(value);
`;
