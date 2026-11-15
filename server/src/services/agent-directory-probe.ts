import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import type { DirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";

/** Only for a live unchanged-turn observation. Never a save or stop receipt. */
export function agentDirectoryBaselineDigest(snapshot: DirectorySnapshot): string {
  if (snapshot.exclude.length || snapshot.ignoredPaths) throw new Error("Incomplete agent directory baseline");
  const entries = [...snapshot.entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

// This self-contained function also runs inside the original remote target.
// Keep all dependencies explicit so remote observation never reads a local mirror.
export function probeAgentDirectory(
  root: string,
  modules = { fs, path, createHash, platform: process.platform },
  allowEmptyRuntimeScratch = false,
): { digest: string; identity: string } {
  const { fs, path, createHash } = modules;
  const deadline = Date.now() + 5_000;
  const checkTime = () => { if (Date.now() > deadline) throw new Error("Agent directory probe deadline"); };
  const stamp = (s: fs.BigIntStats) => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
  const identity = (s: fs.BigIntStats) => [s.dev, s.ino, s.birthtimeNs].join(":");
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root.includes("\0")) throw new Error("Invalid agent directory root");
  // Resolve only the observing host's fixed Darwin aliases. The exact full
  // counterpart excludes nested/user symlinks; canonical ancestors remain strict.
  const requestedRoot = root;
  if (modules.platform === "darwin" && /^\/(tmp|var|etc)\//.test(root)) {
    const resolved = fs.realpathSync(root);
    if (resolved !== `/private${root}`) throw new Error("Unsafe agent directory alias");
    root = resolved;
  }
  const ancestors = new Map<string, string>();
  let ancestor = path.parse(root).root;
  for (const segment of root.slice(ancestor.length).split(path.sep)) {
    ancestor = path.join(ancestor, segment);
    const s = fs.lstatSync(ancestor, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe agent directory ancestor");
    ancestors.set(ancestor, identity(s));
  }
  const metadata = new Map<string, string>();
  const entries: Array<[string, { kind: "dir" } | { kind: "file"; mode: number; hash: string }]> = [];
  let total = 0;
  function walk(relative: string, verify: boolean) {
    checkTime();
    const absolute = path.join(root, relative);
    const before = fs.lstatSync(absolute, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Unsafe agent directory");
    const names = fs.readdirSync(absolute).sort();
    if (verify) {
      if (metadata.get(relative) !== stamp(before)) throw new Error("Agent directory changed during probe");
    } else metadata.set(relative, stamp(before));
    for (const name of names) {
      checkTime();
      const next = relative ? `${relative}/${name}` : name;
      // Runtime-context staging can leave this empty reserved directory after
      // preparation's observation. It is not agent work. Accept only the exact
      // empty shape, never arbitrary exclusions or runtime/session contents.
      if (allowEmptyRuntimeScratch && next === ".paperclip-runtime") {
        const scratch = path.join(root, next), s = fs.lstatSync(scratch, { bigint: true });
        if (!s.isDirectory() || s.isSymbolicLink() || fs.readdirSync(scratch).length) throw new Error("Unexpected refresh runtime scratch");
        continue;
      }
      if (next.length > 512 || name === "." || name === ".." || name.includes("\\") || name.includes("\0")
        || name === ".paperclip-runtime" || next === "promptTemplate.legacy.md") throw new Error("Unsafe agent file path");
      const filename = path.join(root, next);
      const s = fs.lstatSync(filename, { bigint: true });
      if (s.isDirectory()) {
        if (!verify) entries.push([next, { kind: "dir" }]);
        walk(next, verify);
      } else {
        if (!s.isFile() || s.nlink !== 1n || s.size > 256n * 1024n * 1024n) throw new Error("Unsafe or oversized agent file");
        if (verify) {
          if (metadata.get(next) !== stamp(s)) throw new Error("Agent file changed during probe");
        } else {
          total += Number(s.size);
          if (total > 2 * 1024 * 1024 * 1024) throw new Error("Agent directory probe byte limit");
          const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s)) throw new Error("Agent file replaced during open");
            const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
            let size = 0;
            for (;;) {
              checkTime();
              const count = fs.readSync(fd, buffer, 0, buffer.length, null);
              if (!count) break;
              size += count;
              if (size > Number(s.size)) throw new Error("Agent file grew during probe");
              hash.update(buffer.subarray(0, count));
            }
            if (size !== Number(s.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s)
              || stamp(fs.lstatSync(filename, { bigint: true })) !== stamp(s)) throw new Error("Agent file changed during read");
            metadata.set(next, stamp(s));
            entries.push([next, { kind: "file", mode: Number(s.mode), hash: hash.digest("hex") }]);
          } finally { fs.closeSync(fd); }
        }
      }
      if (entries.length > 100_000) throw new Error("Agent directory probe entry limit");
    }
    if (stamp(fs.lstatSync(absolute, { bigint: true })) !== stamp(before)
      || JSON.stringify(fs.readdirSync(absolute).sort()) !== JSON.stringify(names)) throw new Error("Agent directory membership changed");
  }
  const initial = fs.lstatSync(root, { bigint: true });
  walk("", false);
  walk("", true);
  if (stamp(fs.lstatSync(root, { bigint: true })) !== stamp(initial)) throw new Error("Agent directory root changed");
  for (const [ancestor, expected] of ancestors) {
    const current = fs.lstatSync(ancestor, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || identity(current) !== expected) throw new Error("Agent directory ancestor changed");
  }
  if (requestedRoot !== root && fs.realpathSync(requestedRoot) !== root) throw new Error("Agent directory alias changed");
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), identity: identity(initial) };
}

// tsx/esbuild keepNames injects this lexical helper into nested functions.
// Include its exact name-property behavior in each plain-Node child program;
// function.toString() alone does not carry the controller module's bindings.
const childNameHelper = `const __name=(target,value)=>Object.defineProperty(target,"name",{value,configurable:true});`;

export const agentDirectoryProbeProgram = `${childNameHelper} const probe=${probeAgentDirectory.toString()}; process.stdout.write(JSON.stringify(probe(process.argv[1], {fs:require('node:fs'),path:require('node:path'),createHash:require('node:crypto').createHash,platform:process.platform}, process.argv[2] === 'refresh')))`;

/** Retire only the two empty directories created by initial sandbox transfer.
 * Run before provider admission; this is never an exclusion from live probing. */
export function retireAgentDirectoryTransferScratch(root: string, modules = { fs, path, platform: process.platform }): void {
  const { fs, path } = modules;
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root.includes("\0")) throw new Error("Invalid agent directory root");
  const requestedRoot = root;
  if (modules.platform === "darwin" && /^\/(tmp|var|etc)\//.test(root)) {
    const resolved = fs.realpathSync(root);
    if (resolved !== `/private${root}`) throw new Error("Unsafe agent directory alias");
    root = resolved;
  }
  const identities = new Map<string, string>();
  const identify = (directory: string) => {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe transfer scratch directory");
    return [stat.dev, stat.ino, stat.birthtimeNs].join(":");
  };
  let ancestor = path.parse(root).root;
  for (const segment of root.slice(ancestor.length).split(path.sep)) {
    ancestor = path.join(ancestor, segment); identities.set(ancestor, identify(ancestor));
  }
  const parent = path.join(root, ".paperclip-runtime"), scratch = path.join(parent, "agent-files");
  identities.set(parent, identify(parent)); identities.set(scratch, identify(scratch));
  const verify = () => {
    for (const [directory, expected] of identities) if (identify(directory) !== expected) throw new Error("Transfer scratch identity changed");
    if (requestedRoot !== root && fs.realpathSync(requestedRoot) !== root) throw new Error("Agent directory alias changed");
  };
  const entries = fs.readdirSync(parent);
  if (entries.length !== 1 || entries[0] !== "agent-files" || fs.readdirSync(scratch).length) throw new Error("Unexpected transfer scratch contents");
  verify();
  // rmdir atomically refuses nonempty directories. Never recursively delete or
  // follow a link; any change stops preparation before the provider can start.
  fs.rmdirSync(scratch); identities.delete(scratch);
  verify();
  if (fs.readdirSync(parent).length) throw new Error("Transfer scratch changed during retirement");
  fs.rmdirSync(parent); identities.delete(parent);
  verify();
}

export const agentDirectoryTransferCleanupProgram = `${childNameHelper} const retire=${retireAgentDirectoryTransferScratch.toString()}; retire(process.argv[1], {fs:require('node:fs'),path:require('node:path'),platform:process.platform})`;

/** Cleanup is part of refresh custody too: never hand a refused alias back to
 * rm -rf, which follows intermediate symlinks. All removals use pinned parents;
 * a missing root is already clean, and an unsafe root stays cleanup-pending. */
export const agentDirectoryConfinedCleanupProgram = String.raw`
const fs=require('node:fs'),path=require('node:path');
if(process.platform!=='linux')throw Error('Confined cleanup unavailable');
const forbidden=p=>/(^|\/)paperclip-runner\/sessions(\/|$)/.test(p)||(/(^|\/)pi\//.test(p)&&p.endsWith('.jsonl'));
for(const request of JSON.parse(process.argv[1])){
  const root=request.root, expected=request.identity;
  if(!path.isAbsolute(root)||path.resolve(root)!==root||root==='/'||root.includes('\0')||forbidden(root))throw Error('Unsafe cleanup root');
  const pins=[], identity=s=>[s.dev,s.ino,s.birthtimeNs].join(':');
  const at=(fd,name)=>'/proc/self/fd/'+fd+'/'+name;
  const pin=name=>{const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd,{bigint:true});if(!s.isDirectory())throw Error('Unsafe cleanup directory');pins.push({fd,name,identity:identity(s)});return fd;};
  const verify=()=>{for(const p of pins){const s=fs.lstatSync(p.name,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||identity(s)!==p.identity||identity(fs.fstatSync(p.fd,{bigint:true}))!==p.identity)throw Error('Cleanup directory changed');}};
  const forget=fd=>{const i=pins.findIndex(p=>p.fd===fd);fs.closeSync(fd);pins.splice(i,1);};
  try{
    let fd=pin('/'), missing=false;
    for(const segment of root.split('/').filter(Boolean)){
      try{fd=pin(at(fd,segment));}catch(error){if(error.code==='ENOENT'){missing=true;break;}throw error;}
    }
    if(missing)continue;
    if(expected&&identity(fs.fstatSync(fd,{bigint:true}))!==expected)throw Error('Cleanup root replaced');
    let count=0;
    const remove=(directory,relative='')=>{
      for(const name of fs.readdirSync('/proc/self/fd/'+directory)){
        if(++count>100000)throw Error('Cleanup entry limit');
        const next=relative?relative+'/'+name:name;if(forbidden(root+'/'+next))throw Error('Unsafe cleanup session path');
        verify();const filename=at(directory,name),s=fs.lstatSync(filename,{bigint:true});
        if(s.isSymbolicLink())throw Error('Unsafe cleanup link');
        if(s.isDirectory()){
          const child=pin(filename);remove(child,next);verify();fs.rmdirSync(filename);forget(child);
        }else{if(!s.isFile())throw Error('Unsafe cleanup entry');verify();fs.unlinkSync(filename);}
      }
    };
    verify();remove(fd);verify();const rootPin=pins.find(p=>p.fd===fd);fs.rmdirSync(rootPin.name);forget(fd);
  }finally{for(const p of pins.reverse())fs.closeSync(p.fd);}
}
`;

export async function removeLocalAgentDirectoryConfined(root: string) {
  await new Promise<void>((resolve, reject) => {
    childProcess.execFile(process.execPath, ["-e", agentDirectoryConfinedCleanupProgram, JSON.stringify([{ root }])], {
      cwd: "/", env: {}, timeout: 15_000, maxBuffer: 4096, killSignal: "SIGKILL",
    }, error => { if (error) reject(error); else resolve(); });
  });
}

/** Bound child: no shell, inherited credentials, or event-loop hashing. */
export async function observeLocalAgentDirectory(root: string, refresh = false) {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    childProcess.execFile(process.execPath, ["-e", agentDirectoryProbeProgram, root, ...(refresh ? ["refresh"] : [])], {
      cwd: root, env: {}, timeout: 10_000, maxBuffer: 1024, killSignal: "SIGKILL", encoding: "utf8",
    }, (error, stdout, stderr) => { if (error) reject(error); else resolve({ stdout, stderr }); });
  });
  if (result.stdout.length > 1024) throw new Error("Agent directory observation exceeds bound");
  const value = JSON.parse(result.stdout);
  if (!value || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.identity !== "string" || !/^[0-9]+:[0-9]+:[0-9]+$/.test(value.identity)) throw new Error("Invalid agent directory observation");
  return value as { digest: string; identity: string };
}
