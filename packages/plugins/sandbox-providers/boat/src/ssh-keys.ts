import { GUARDIAN_COMMAND as CONTRACT_COMMAND, guardianCommand as CONTRACT_BUILDER, GUARDIAN_ENTRY, GUARDIAN_SOCKET } from "./guardian-contract.js";
// Local binding also makes the public-only editor source independent of module
// import rewriting in the worker loader.
export const GUARDIAN_COMMAND = CONTRACT_COMMAND;
const guardianCommand = CONTRACT_BUILDER;
export const KEY_MARKER = "paperclip-boat-carrier:";
export const MAX_WORKER_KEYS = 32;
export type KeyRegistration = { workerId: string; publicKey: string; expiresAt: number; runnerId: string };
export function forcedKeyLine(key: KeyRegistration): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(key.workerId) || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(key.publicKey)
      || !Number.isSafeInteger(key.expiresAt)) throw new Error("BOAT_SSH_INVALID_KEY");
  return `restrict,command="${guardianCommand(key.runnerId).join(" ")}" ${key.publicKey} ${KEY_MARKER}${key.workerId}:${key.expiresAt}`;
}
/** Preserve every unmarked foreign key. Remove only our exact worker's lines or
 * expired well-formed carrier markers. Re-add our key even if the API append
 * raced another worker's atomic rewrite: that worker rewrites under this lock too. */
export function mergeAuthorizedKeys(text: string, key: KeyRegistration, retire: boolean, now: number): string {
  const line = forcedKeyLine(key), blob = key.publicKey.split(" ")[1];
  const kept = text.split("\n").filter(value => {
    if (!value) return false;
    const marker = /(?:^| )paperclip-boat-carrier:([A-Za-z0-9-]{1,64}):(\d+)$/.exec(value);
    if (marker) return marker[1] !== key.workerId && Number(marker[2]) > now;
    // The API-created line carries OUR exact fresh public key. Only this blob
    // is rewritten; unmarked old keys are never treated as abandoned workers.
    return retire || !(value.split(/\s+/).includes(blob));
  });
  if (!retire && kept.filter(value => / paperclip-boat-carrier:[A-Za-z0-9-]{1,64}:\d+$/.test(value)).length >= MAX_WORKER_KEYS) {
    throw new Error("BOAT_SSH_KEY_LIMIT");
  }
  if (!retire) kept.push(line);
  return kept.length ? kept.join("\n") + "\n" : "";
}

// The public-only helper is uploaded via files API. A kernel flock serializes
// worker merges, including retirement. An atomic rename keeps sshd readers safe.
// No private key, ticket, request body, or guardian reply goes through Boat exec.
export function keyEditorSource(key: KeyRegistration, retire: boolean): string {
  forcedKeyLine(key);
  return `import fs from 'node:fs';\nimport path from 'node:path';\n` +
    `const GUARDIAN_COMMAND=${JSON.stringify(GUARDIAN_COMMAND)},KEY_MARKER=${JSON.stringify(KEY_MARKER)},MAX_WORKER_KEYS=${MAX_WORKER_KEYS};\n` +
    `${guardianCommand.toString()}\n${forcedKeyLine.toString()}\n${mergeAuthorizedKeys.toString()}\n` +
    `const key=${JSON.stringify(key)},dir=process.argv[2],target=path.join(dir,'authorized_keys');\n` +
    `const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw Error('BOAT_SSH_KEY_DIRECTORY');\n` +
    `let text='';try{const s=fs.lstatSync(target);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.size>1048576)throw Error('BOAT_SSH_KEY_FILE');text=fs.readFileSync(target,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}\n` +
    `let output,limited=false;try{output=mergeAuthorizedKeys(text,key,${retire},Date.now())}catch(e){if(e.message!=='BOAT_SSH_KEY_LIMIT')throw e;output=mergeAuthorizedKeys(text,key,true,Date.now());limited=true}\n` +
    `const tmp=path.join(dir,'.paperclip-key-'+key.workerId);try{const s=fs.lstatSync(tmp);if(!s.isFile()||s.uid!==process.getuid())throw Error('BOAT_SSH_KEY_TEMP');fs.unlinkSync(tmp)}catch(e){if(e.code!=='ENOENT')throw e}\n` +
    `try{fs.writeFileSync(tmp,output,{mode:0o600,flag:'wx'});fs.renameSync(tmp,target)}finally{try{fs.unlinkSync(tmp)}catch(e){if(e.code!=='ENOENT')throw e}}\n` +
    `if(limited)process.exitCode=73;\n`;
}
export const IMAGE_PREFLIGHT = `test -x /usr/bin/node && test -x /usr/bin/flock && test -x ${GUARDIAN_ENTRY} && test -S ${GUARDIAN_SOCKET} && (pgrep -x sshd >/dev/null)`;
export type KeyApi = { request(path: string, init?: RequestInit): Promise<any>; run(command: string, timeout: number, signal?: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> };
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
export async function editGuestKey(api: KeyApi, sandbox: string, key: KeyRegistration, retire: boolean, signal?: AbortSignal): Promise<void> {
  const helper = `/tmp/paperclip-boat-key-${key.workerId}-${retire ? "retire" : "add"}.mjs`;
  const files = `/sandboxes/${encodeURIComponent(sandbox)}/files`;
  try {
    signal?.throwIfAborted();
    await api.request(files, { method: "PUT", signal, body: JSON.stringify({ path: helper, content: keyEditorSource(key, retire), encoding: "utf8" }) });
    signal?.throwIfAborted();
    const result = await api.run(`umask 077 && test ! -L "$HOME/.ssh" && mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && /usr/bin/flock -w 10 "$HOME/.ssh/.paperclip-boat-keys.lock" /usr/bin/node ${quote(helper)} "$HOME/.ssh"`, signal ? 5000 : 15_000, signal);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(retire ? "BOAT_SSH_RETIRE_FAILED" : "BOAT_SSH_KEY_INSTALL_FAILED");
  } finally {
    if (!signal?.aborted) await api.request(`${files}?path=${encodeURIComponent(helper)}`, { method: "DELETE", signal }).catch(() => {});
  }
}
