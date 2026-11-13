import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import manifest from "./manifest.js";
import { assertBoatActivityAdmission } from "./lease-gates.js";
import { quote, type BoatIO } from "./runner-support.js";
import { GUARDIAN_ENTRY, GUARDIAN_SOCKET } from "./guardian-contract.js";

export const GUARDIAN_FILES = ["host-channel.mjs", "protocol.mjs", "runner-control.mjs", "runner-supervisor.mjs",
  "guardian.mjs", "guardian-client.mjs", "guardian-protocol.mjs", "paperclip-runner-guardian"] as const;
export const GUARDIAN_DIRECTORY = `/usr/local/libexec/paperclip-guardian-${manifest.version}`;
export const GUARDIAN_UPLOAD_DIRECTORY = `/home/user/.paperclip-host/stage-${manifest.version}`;
export const GUARDIAN_RUNNER_DIRECTORY = "/home/user/.paperclip-host/runner";
export const GUARDIAN_UNIT = "paperclip-guardian.service";
const UNIT_PATH = `/home/user/.config/systemd/user/${GUARDIAN_UNIT}`;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TIMEOUT = 30_000;
type Hashes = Record<(typeof GUARDIAN_FILES)[number], string>;
export type GuardianStatus = { state: "empty" } | {
  state: "running" | "exited"; pid: number; startTime: string; bootId: string; generation: string;
  code: number | null; signal: string | null;
};
export type GuardianPreflight = {
  schema: "paperclip/boat-guardian-preflight/v1"; usable: true; pluginVersion: string;
  guestDirectory: string; runnerDirectory: string; socketPath: string; nodeVersion: string;
  hashes: Hashes; bootId: string; unit: typeof GUARDIAN_UNIT; active: true; status: GuardianStatus;
  machine: "new" | "same" | "unknown"; coldStartRequired: boolean;
};
const FAILURES = ["CONFIG_INVALID", "ASSETS_UNAVAILABLE", "PROBE_FAILED", "NODE_UNSUPPORTED",
  "PREPARE_FAILED", "UPLOAD_FAILED", "HASH_MISMATCH", "SEAL_FAILED", "SERVICE_FAILED",
  "PREFLIGHT_FAILED", "STATUS_INVALID"] as const;
type Failure = (typeof FAILURES)[number];
export type GuardianPreflightFailure = { schema: "paperclip/boat-guardian-preflight-error/v1"; code: `BOAT_GUARDIAN_${Failure}`; usable: false };
export class BoatGuardianPreflightError extends Error {
  readonly code: `BOAT_GUARDIAN_${Failure}`;
  readonly data: GuardianPreflightFailure;
  constructor(failure: Failure) {
    const code = `BOAT_GUARDIAN_${failure}` as const;
    super(code); this.name = "BoatGuardianPreflightError"; this.code = code;
    this.data = { schema: "paperclip/boat-guardian-preflight-error/v1", code, usable: false };
  }
}
export function readGuardianPreflightFailure(error: unknown): GuardianPreflightFailure | undefined {
  if (!error || typeof error !== "object") return undefined;
  const failure = FAILURES.find(failure => (error as { message?: unknown }).message === `BOAT_GUARDIAN_${failure}`);
  return failure ? { schema: "paperclip/boat-guardian-preflight-error/v1", code: `BOAT_GUARDIAN_${failure}`, usable: false } : undefined;
}
export function guardianConfigError(config: Record<string, unknown>): string | undefined {
  return config.duplexCarrier === undefined || ["ssh", "off"].includes(String(config.duplexCarrier)) ? undefined : "duplexCarrier must be off or ssh.";
}
function script(phase: string, source: string): string {
  return `/usr/bin/env -i HOME=/home/user PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/node --input-type=module -e ${quote(`/* paperclip-guardian:${phase} */\n${source}`)}`;
}
async function command(io: BoatIO, phase: string, source: string, failure: Failure): Promise<string> {
  try {
    const result = await io.run(script(phase, source), TIMEOUT);
    if (result.timedOut || result.exitCode !== 0) throw new Error();
    return result.stdout;
  } catch { throw new BoatGuardianPreflightError(failure); }
}
const paths = `const guest = ${JSON.stringify(GUARDIAN_DIRECTORY)}, runner = ${JSON.stringify(GUARDIAN_RUNNER_DIRECTORY)}, files = ${JSON.stringify(GUARDIAN_FILES)}, upload = ${JSON.stringify(GUARDIAN_UPLOAD_DIRECTORY)}, entry = ${JSON.stringify(GUARDIAN_ENTRY)}, socket = ${JSON.stringify(GUARDIAN_SOCKET)};`;
const safeDirectories = `
function directory(path, mode) {
  if (!fs.existsSync(path)) fs.mkdirSync(path, { mode });
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(path) !== path || s.uid !== process.getuid()) throw new Error();
  fs.chmodSync(path, mode);
}
`;
const systemctl = `
const clean = { HOME: '/home/user', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
  XDG_RUNTIME_DIR: '/run/user/' + process.getuid(), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + process.getuid() + '/bus' };
const ctl = (...args) => execFileSync('/usr/bin/systemctl', ['--user', ...args], { env: clean, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
`;
// The stable executable is root-owned 0755; the exact versioned guest entry and
// modules are root-owned read-only. SSH command validation stays in guest code.
export const guardianEntryContent = () => `#!/bin/sh\nif [ "\${SSH_ORIGINAL_COMMAND+x}" = x ]; then\n  exec /usr/bin/env -i HOME=/home/user PATH=/usr/bin:/bin LANG=C.UTF-8 SSH_ORIGINAL_COMMAND="$SSH_ORIGINAL_COMMAND" /usr/bin/node ${GUARDIAN_DIRECTORY}/paperclip-runner-guardian "$@"\nfi\nexec /usr/bin/env -i HOME=/home/user PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/node ${GUARDIAN_DIRECTORY}/paperclip-runner-guardian "$@"\n`;
export function guardianUnitContent(managerNames: string[]): string {
  if (managerNames.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new BoatGuardianPreflightError("SERVICE_FAILED");
  const unset = [...new Set([...managerNames, "USER", "LOGNAME", "SHELL", "NODE_OPTIONS", "NODE_PATH"])]
    .filter(name => !["HOME", "PATH", "LANG"].includes(name)).sort();
  return `[Unit]\nDescription=Paperclip resident S9 guardian\n\n[Service]\nType=exec\n` +
    `ExecStart=/usr/bin/node ${GUARDIAN_DIRECTORY}/paperclip-runner-guardian serve ${GUARDIAN_RUNNER_DIRECTORY}\n` +
    `Restart=no\nUMask=0077\nEnvironment=\nEnvironment=HOME=/home/user PATH=/usr/bin:/bin LANG=C.UTF-8\n` +
    `EnvironmentFile=\nPassEnvironment=\nUnsetEnvironment=${unset.join(" ")}\n` +
    `StandardInput=null\nStandardOutput=null\nStandardError=null\nKillMode=control-group\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n`;
}
// /run is volatile even when the versioned distribution survived a cold boot.
// Provision only the private directory; never unlink or reclaim a socket.
const runtimeDirectorySource = `
import fs from 'node:fs';
const uid=Number(process.argv[1]),gid=Number(process.argv[2]),path=${JSON.stringify(GUARDIAN_SOCKET.slice(0, GUARDIAN_SOCKET.lastIndexOf("/")))};
if(process.getuid()!==0||!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<0)throw new Error();
const parent=fs.lstatSync('/run');if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||(parent.mode&0o022))throw new Error();
if(!fs.existsSync(path)){fs.mkdirSync(path,{mode:0o700});fs.chownSync(path,uid,gid);}
const s=fs.lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(path)!==path||s.uid!==uid||s.gid!==gid||(s.mode&0o777)!==0o700)throw new Error();
`;
const installedChecks = `
function trusted(path, mode, kind = 'file') {
 const s = fs.lstatSync(path);
 if (s.isSymbolicLink() || fs.realpathSync(path) !== path || s.uid !== 0 || s.gid !== 0 || (s.mode & 0o777) !== mode ||
     (kind === 'file' ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())) throw new Error();
}
`;
async function probe(io: BoatIO): Promise<{ nodeVersion: string; bootId: string; hashes: Record<string, unknown>; installed: boolean }> {
  const stdout = await command(io, "probe", `
import fs from 'node:fs'; import { createHash } from 'node:crypto';
${paths} ${installedChecks}
const hashes = {}; let installed = true;
try { trusted(guest, 0o555, 'directory'); trusted(entry, 0o755); if (fs.readFileSync(entry, 'utf8') !== ${JSON.stringify(guardianEntryContent())}) installed = false; } catch { installed = false; }
for (const name of files) {
 const file = guest + '/' + name;
 try { trusted(file, 0o444); hashes[name] = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
 catch { hashes[name] = null; }
}
console.log(JSON.stringify({ nodeVersion: process.versions.node, bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), hashes, installed }));
`, "PROBE_FAILED");
  let result;
  try { result = JSON.parse(stdout); } catch { throw new BoatGuardianPreflightError("PROBE_FAILED"); }
  if (typeof result?.nodeVersion !== "string" || typeof result?.bootId !== "string" || !UUID.test(result.bootId) || !result.hashes || typeof result.hashes !== "object") throw new BoatGuardianPreflightError("PROBE_FAILED");
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(result.nodeVersion);
  if (!version || Number(version[1]) < 24 || (Number(version[1]) === 24 && Number(version[2]) < 11)) throw new BoatGuardianPreflightError("NODE_UNSUPPORTED");
  return result;
}
async function uploadAsset(io: BoatIO, id: string, name: string, bytes: Buffer): Promise<void> {
  try {
    const signed = await io.request(`/sandboxes/${encodeURIComponent(id)}/files/upload-url`, {
      method: "POST", body: JSON.stringify({ path: `${GUARDIAN_UPLOAD_DIRECTORY}/${name}` }), signal: AbortSignal.timeout(TIMEOUT),
    });
    const url = new URL(signed.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    assertBoatActivityAdmission();
    const response = await fetch(url.href, { method: "PUT", body: bytes, redirect: "error", signal: AbortSignal.timeout(TIMEOUT) });
    await response.body?.cancel(); if (!response.ok) throw new Error();
  } catch { throw new BoatGuardianPreflightError("UPLOAD_FAILED"); }
}
function parseStatus(stdout: string): GuardianStatus {
  try {
    const reply = JSON.parse(stdout), status = reply?.result;
    if (reply?.ok !== true || !status) throw new Error();
    if (status.state === "empty") return { state: "empty" };
    if (!["running", "exited"].includes(status.state) || !Number.isSafeInteger(status.pid) || status.pid <= 0 ||
      typeof status.startTime !== "string" || !/^\d+$/.test(status.startTime) || typeof status.bootId !== "string" || !UUID.test(status.bootId) ||
      typeof status.generation !== "string" || !UUID.test(status.generation)) throw new Error();
    if (status.code != null && (!Number.isInteger(status.code) || status.code < 0 || status.code > 255)) throw new Error();
    if (status.signal != null && (typeof status.signal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(status.signal))) throw new Error();
    return { state: status.state, pid: status.pid, startTime: status.startTime, bootId: status.bootId, generation: status.generation,
      code: status.code ?? null, signal: status.signal ?? null };
  } catch { throw new BoatGuardianPreflightError("STATUS_INVALID"); }
}
const statusSource = `
const reply = execFileSync('/usr/bin/node', [guest + '/runner-control.mjs', runner + '/process/control.sock'], {
 input: '{"op":"status"}\\n', env: { HOME: '/home/user', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
 encoding: 'utf8', timeout: 10000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'],
}); process.stdout.write(reply);
`;
export function guardianHealthCommand(): string {
  return script("health", `import { execFileSync } from 'node:child_process'; ${paths} ${statusSource}`);
}

/** Acquire/resume only. Root installation is non-secret. No runner launch,
 * restart, socket reclamation or adoption is authorized by this preflight. */
export async function stageGuardian(config: Record<string, unknown>, id: string, io: BoatIO,
  previous?: Record<string, unknown>): Promise<GuardianPreflight | undefined> {
  if (guardianConfigError(config)) throw new BoatGuardianPreflightError("CONFIG_INVALID");
  if (config.duplexCarrier !== "ssh") return undefined;
  let assets: { name: (typeof GUARDIAN_FILES)[number]; bytes: Buffer; hash: string }[];
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(manifest.version)) throw new Error();
    assets = await Promise.all(GUARDIAN_FILES.map(async name => {
      const bytes = await readFile(new URL(`../guest/${name}`, import.meta.url));
      return { name, bytes, hash: createHash("sha256").update(bytes).digest("hex") };
    }));
  } catch { throw new BoatGuardianPreflightError("ASSETS_UNAVAILABLE"); }
  let observed = await probe(io);
  const missing = assets.filter(asset => observed.hashes[asset.name] !== asset.hash);
  const install = missing.length > 0 || !observed.installed;
  await command(io, "prepare", `
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
${paths} ${safeDirectories} ${systemctl}
if (fs.realpathSync('/home/user') !== '/home/user') throw new Error();
directory('/home/user/.paperclip-host', 0o700); directory(runner, 0o700);
execFileSync('/usr/bin/sudo',['-n','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/node','--input-type=module','-e',${JSON.stringify(runtimeDirectorySource)},String(process.getuid()),String(process.getgid())],{timeout:10000,stdio:['ignore','pipe','pipe']});
if (${install}) {
 let state;
 try { state = ctl('is-active', '${GUARDIAN_UNIT}').trim(); }
 catch (error) { if (![3,4].includes(error.status)) throw error; state = String(error.stdout ?? '').trim(); }
 if (!['inactive','failed','unknown'].includes(state)) throw new Error();
 directory(upload, 0o700);
 for (const name of files) { const path = upload + '/' + name; try { const s=fs.lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid()) throw new Error(); fs.unlinkSync(path); } catch(e) { if(e.code !== 'ENOENT') throw e; } }
}
`, "PREPARE_FAILED");
  if (install) {
    // Upload all assets for one hash-verified installation, never patch a live
    // version directory in place. User-controlled staging is never executed.
    for (const asset of assets) await uploadAsset(io, id, asset.name, asset.bytes);
    const hashes = Object.fromEntries(assets.map(asset => [asset.name, asset.hash]));
    await command(io, "seal", `
import { execFileSync } from 'node:child_process';
const source = ${JSON.stringify(`
import fs from 'node:fs'; import { createHash } from 'node:crypto';
${paths} ${installedChecks}
const uid = Number(process.argv[1]), gid = Number(process.argv[2]), hashes = ${JSON.stringify(hashes)};
if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0 || process.getuid() !== 0) throw new Error();
for (const p of ['/usr','/usr/local','/usr/local/libexec','/run']) {
 if (!fs.existsSync(p) && p === '/usr/local/libexec') fs.mkdirSync(p, {mode:0o755});
 const s=fs.lstatSync(p); if(!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(p)!==p || s.uid!==0 || (s.mode & 0o022)) throw new Error();
}
const bytes = {};
for (const name of files) {
 const p = upload + '/' + name, fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
 try { const s=fs.fstatSync(fd); if (!s.isFile() || s.uid !== uid || s.nlink !== 1 || s.size > 1048576) throw new Error(); bytes[name]=fs.readFileSync(fd); }
 finally { fs.closeSync(fd); }
 if(createHash('sha256').update(bytes[name]).digest('hex')!==hashes[name]) throw new Error();
}
if (!fs.existsSync(guest)) fs.mkdirSync(guest,{mode:0o555});
trusted(guest,0o555,'directory');
function installFile(path, bytes, mode) {
 try { const s=fs.lstatSync(path); if(!s.isFile() || s.isSymbolicLink() || s.nlink!==1 || s.uid!==0 || s.gid!==0) throw new Error(); }
 catch(e){if(e.code!=='ENOENT')throw e;}
 const temp=path+'.'+process.pid+'.tmp';
 try { fs.writeFileSync(temp,bytes,{flag:'wx',mode}); fs.chmodSync(temp,mode); fs.renameSync(temp,path); }
 finally { try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;} }
}
for(const name of files) installFile(guest+'/'+name,bytes[name],0o444);
installFile(entry,${JSON.stringify(guardianEntryContent())},0o755);
const socketDir = socket.slice(0,socket.lastIndexOf('/'));
if(!fs.existsSync(socketDir)){fs.mkdirSync(socketDir,{mode:0o700});fs.chownSync(socketDir,uid,gid);}
const s=fs.lstatSync(socketDir);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(socketDir)!==socketDir||s.uid!==uid||(s.mode&0o777)!==0o700)throw new Error();
`)};
execFileSync('/usr/bin/sudo', ['-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/node', '--input-type=module', '-e', source, String(process.getuid()), String(process.getgid())], {timeout:20000,stdio:['ignore','pipe','pipe']});
`, "SEAL_FAILED");
    observed = await probe(io);
  }
  if (!observed.installed || assets.some(asset => observed.hashes[asset.name] !== asset.hash)) throw new BoatGuardianPreflightError("HASH_MISMATCH");
  await command(io, "service", `
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
${safeDirectories} ${systemctl}
const managerNames = ctl('show-environment').split('\\n').filter(Boolean).map(line => line.slice(0,line.indexOf('=')));
if(managerNames.some(name=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))throw new Error();
const unset=managerNames.filter(name=>!['HOME','PATH','LANG'].includes(name));
const content=${JSON.stringify(guardianUnitContent([]))}.replace('UnsetEnvironment=','UnsetEnvironment='+unset.join(' ')+' ');
directory('/home/user/.config',0o700);directory('/home/user/.config/systemd',0o700);directory('/home/user/.config/systemd/user',0o700);
const path=${JSON.stringify(UNIT_PATH)};
try{const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid())throw new Error();}catch(e){if(e.code!=='ENOENT')throw e;}
const temp=path+'.'+process.pid+'.tmp';try{fs.writeFileSync(temp,content,{flag:'wx',mode:0o600});fs.renameSync(temp,path);}finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
// systemctl --user daemon-reload && systemctl --user enable --now paperclip-guardian
ctl('daemon-reload');ctl('enable','--now','paperclip-guardian');
`, "SERVICE_FAILED");
  const stdout = await command(io, "preflight", `
import fs from 'node:fs'; import { execFileSync } from 'node:child_process'; import { setTimeout } from 'node:timers/promises';
${paths} ${systemctl} ${installedChecks}
trusted(guest,0o555,'directory');trusted(entry,0o755);for(const name of files)trusted(guest+'/'+name,0o444);
ctl('is-active','--quiet','${GUARDIAN_UNIT}');
const pid=ctl('show','--property=MainPID','--value','${GUARDIAN_UNIT}').trim();if(!/^[1-9][0-9]*$/.test(pid))throw new Error();
const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').filter(Boolean);
if(JSON.stringify(argv)!==JSON.stringify(['/usr/bin/node',guest+'/paperclip-runner-guardian','serve',runner]))throw new Error();
const allowed={HOME:'/home/user',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',SYSTEMD_EXEC_PID:pid};
for(const entry of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0').filter(Boolean)){
 const at=entry.indexOf('='),name=entry.slice(0,at),value=entry.slice(at+1);
 if(allowed[name]===value||(name==='INVOCATION_ID'&&/^[0-9a-f]{32}$/.test(value))||(name==='JOURNAL_STREAM'&&/^[0-9]+:[0-9]+$/.test(value)))continue;throw new Error();
}
const until=Date.now()+5000;while(!fs.existsSync(socket)&&Date.now()<until)await setTimeout(25);
const s=fs.lstatSync(socket);if(!s.isSocket()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw new Error();
${statusSource}
`, "PREFLIGHT_FAILED");
  const status = parseStatus(stdout);
  if (status.state !== "empty" && status.bootId.toLowerCase() !== observed.bootId.toLowerCase()) throw new BoatGuardianPreflightError("STATUS_INVALID");
  const prior = previous?.boot_id ?? (previous?.guardianPreflight as { bootId?: unknown } | undefined)?.bootId;
  const previousBoot = typeof prior === "string" && UUID.test(prior) ? prior.toLowerCase() : undefined;
  const machine = previousBoot === undefined ? "unknown" : previousBoot === observed.bootId.toLowerCase() ? "same" : "new";
  return { schema: "paperclip/boat-guardian-preflight/v1", usable: true, pluginVersion: manifest.version,
    guestDirectory: GUARDIAN_DIRECTORY, runnerDirectory: GUARDIAN_RUNNER_DIRECTORY, socketPath: GUARDIAN_SOCKET,
    nodeVersion: observed.nodeVersion, hashes: Object.fromEntries(assets.map(asset => [asset.name, asset.hash])) as Hashes,
    bootId: observed.bootId, unit: GUARDIAN_UNIT, active: true, status, machine, coldStartRequired: machine === "new" || status.state === "empty" };
}
