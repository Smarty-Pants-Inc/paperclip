import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export interface DirectoryRefreshGuard {
  /** dev:ino:birthtimeNs observed on the destination's actual host. */
  identity: string;
  /** Complete live-tree digest, not a controller mirror or canonical digest. */
  digest: string;
}

// This is an optimization, not an admission requirement. Bound the single RPC
// body; larger trees take the normal retire/collect/prepare path instead.
const MAX_REFRESH_BYTES = 8 * 1024 * 1024;
export async function directoryRefreshPayload(root: string): Promise<string> {
  const entries: Array<{ name: string; mode?: number; data?: string }> = [];
  let total = 0;
  async function walk(relative: string) {
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
      const next = relative ? `${relative}/${name}` : name;
      if (name.includes("\\") || name === ".paperclip-runtime" || next.length > 512) throw new Error("Unsafe refresh source");
      const filename = path.join(root, next), stat = await fs.lstat(filename);
      if (stat.isDirectory()) { entries.push({ name: next }); await walk(next); }
      else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_REFRESH_BYTES) throw new Error("Unsafe or oversized refresh source");
        total += stat.size;
        if (total > MAX_REFRESH_BYTES) throw new Error("Refresh exceeds bounded transfer size");
        const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await file.stat();
          if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("Refresh source changed");
          entries.push({ name: next, mode: stat.mode, data: (await file.readFile()).toString("base64") });
        } finally { await file.close(); }
      }
      if (entries.length > 100_000) throw new Error("Refresh entry limit");
    }
  }
  await walk("");
  const payload = JSON.stringify(entries);
  if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error("Refresh RPC limit");
  return payload;
}

/** Runs on the destination host. Linux descriptor-relative paths pin every
 * ancestor and every write; an ancestor renamed/replaced between checks cannot
 * redirect an operation into another tree. Unsupported hosts fail closed.
 * There is no uploaded archive, helper file, native provider write or tar
 * extraction outside this guard. Do not replace these paths with root/name. */
export const guardedDirectoryRefreshProgram = String.raw`
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const root=process.argv[1], expected=JSON.parse(process.argv[2]);
if(process.platform!=='linux') throw Error('Descriptor-relative refresh unavailable');
const forbidden=p=>/(^|\/)paperclip-runner\/sessions(\/|$)/.test(p)||(/(^|\/)pi\//.test(p)&&p.endsWith('.jsonl'));
if(!path.isAbsolute(root)||path.resolve(root)!==root||root.includes('\0')||forbidden(root)) throw Error('Unsafe refresh destination');
const identify=s=>[s.dev,s.ino,s.birthtimeNs].join(':');
const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const dirFlags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW;
const pinned=[], pinnedFiles=[];
let mutated=false;
const changed=()=>{throw Object.assign(Error('Live refresh bytes changed'),{code:'LIVE_CHANGED'});};
const pin=(name,parent)=>{
  const fd=fs.openSync(name,dirFlags), s=fs.fstatSync(fd,{bigint:true});
  if(!s.isDirectory()) throw Error('Unsafe refresh ancestor');
  pinned.push({fd,name,identity:identify(s),parent}); return fd;
};
let fd=pin('/');
for(const segment of root.split('/').filter(Boolean)) fd=pin('/proc/self/fd/'+fd+'/'+segment,fd);
const rootFd=fd, rootAncestors=pinned.slice();
const at=(fd,name)=>'/proc/self/fd/'+fd+'/'+name;
const verify=()=>{
  for(const p of pinned){
    const s=fs.lstatSync(p.name,{bigint:true});
    if(p.name==='/' ? !s.isDirectory() : (!s.isDirectory()||s.isSymbolicLink())) throw Error('Refresh ancestor redirected');
    if(identify(s)!==p.identity||identify(fs.fstatSync(p.fd,{bigint:true}))!==p.identity) throw Error('Refresh identity changed');
  }
  if(identify(fs.fstatSync(rootFd,{bigint:true}))!==expected.identity) throw Error('Refresh root replaced');
};
try {
  verify();
  const body=fs.readFileSync(0);
  if(body.length>16*1024*1024) throw Error('Refresh RPC limit');
  const entries=JSON.parse(body.toString('utf8'));
  if(!Array.isArray(entries)||entries.length>100000) throw Error('Refresh entry limit');
  const desired=new Map(); let bytes=0;
  for(const e of entries){
    if(typeof e.name!=='string'||!e.name||e.name.length>512||e.name.split('/').some(n=>!n||n==='.'||n==='..'||n==='.paperclip-runtime'||n.includes('\\')||n.includes('\0'))||forbidden(root+'/'+e.name)||desired.has(e.name)) throw Error('Unsafe refresh entry');
    if(e.data!==undefined){
      if(typeof e.data!=='string'||!Number.isInteger(e.mode)) throw Error('Invalid refresh file');
      bytes+=Buffer.byteLength(e.data,'base64'); if(bytes>8*1024*1024) throw Error('Refresh byte limit');
    }
    desired.set(e.name,e);
  }
  // Preflight the complete existing tree before any write, including files
  // absent from the new canonical tree. Reject links instead of following them.
  const observed=[]; const files=new Map(); const directories=new Map([['',rootFd]]);
  const walk=(parent,relative)=>{
    for(const name of fs.readdirSync('/proc/self/fd/'+parent).sort()){
      verify(); const next=relative?relative+'/'+name:name, filename=at(parent,name);
      const s=fs.lstatSync(filename,{bigint:true});
      if(next==='.paperclip-runtime'){
        if(!s.isDirectory()||s.isSymbolicLink()) throw Error('Unsafe refresh runtime scratch');
        const scratch=pin(filename,parent);
        if(fs.readdirSync('/proc/self/fd/'+scratch).length) throw Error('Unexpected refresh runtime scratch');
        continue;
      }
      if(s.isDirectory()){
        const child=pin(filename,parent); directories.set(next,child); observed.push([next,{kind:'dir'}]); walk(child,next);
      }else{
        if(!s.isFile()||s.nlink!==1n||forbidden(root+'/'+next)) throw Error('Unsafe live refresh file');
        const file=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        pinnedFiles.push(file);
        {
          if(stamp(fs.fstatSync(file,{bigint:true}))!==stamp(s)) throw Error('Live refresh file replaced');
          const hash=crypto.createHash('sha256'), buffer=Buffer.alloc(65536); let size=0;
          for(;;){const n=fs.readSync(file,buffer,0,buffer.length,null);if(!n)break;size+=n;if(size>Number(s.size))throw Error('Live refresh file grew');hash.update(buffer.subarray(0,n));}
          if(size!==Number(s.size)||stamp(fs.fstatSync(file,{bigint:true}))!==stamp(s)||stamp(fs.lstatSync(filename,{bigint:true}))!==stamp(s)) throw Error('Live refresh file changed');
          const digest=hash.digest('hex');
          files.set(next,{fd:file,stamp:stamp(s),hash:digest,size:Number(s.size)});
          observed.push([next,{kind:'file',mode:Number(s.mode),hash:digest}]);
        }
      }
    }
  };
  walk(rootFd,''); verify();
  observed.sort(([a],[b])=>a<b?-1:a>b?1:0);
  if(crypto.createHash('sha256').update(JSON.stringify(observed)).digest('hex')!==expected.digest) changed();
  const parentOf=name=>directories.get(path.posix.dirname(name)==='.'?'':path.posix.dirname(name));
  // Compare the *open* current inode with the identity captured at hash time.
  // Re-hash immediately before each replace/unlink, not just at RPC preflight.
  const checkFile=name=>{
    const old=files.get(name), filename=at(parentOf(name),path.posix.basename(name));
    if(!old){try{fs.lstatSync(filename);changed();}catch(e){if(e.code!=='ENOENT')throw e;}return;}
    const file=old.fd;
    try{
      if(stamp(fs.fstatSync(file,{bigint:true}))!==old.stamp) changed();
      const hash=crypto.createHash('sha256'), buffer=Buffer.alloc(65536); let offset=0;
      for(;;){const n=fs.readSync(file,buffer,0,buffer.length,offset);if(!n)break;offset+=n;if(offset>old.size)changed();hash.update(buffer.subarray(0,n));}
      if(hash.digest('hex')!==old.hash||stamp(fs.fstatSync(file,{bigint:true}))!==old.stamp||stamp(fs.lstatSync(filename,{bigint:true}))!==old.stamp) changed();
    }catch(error){if(error.code==='ENOENT'||error.code==='ELOOP')changed();throw error;}
  };
  const unpin=fd=>{const i=pinned.findIndex(p=>p.fd===fd);if(i>=0){fs.closeSync(fd);pinned.splice(i,1);}};
  // A freshly mkdir'd private directory in the same parent gives rename an
  // empty, exclusive destination on the same filesystem (no replace window).
  const makePrivateDir=parent=>{
    for(let attempt=0;attempt<8;attempt++){
      const name='.paperclip-retire-'+crypto.randomUUID(), filename=at(parent,name);
      try{fs.mkdirSync(filename,{mode:0o700});return {name,fd:pin(filename,parent)};}
      catch(error){if(error.code!=='EEXIST')throw error;}
    }
    throw Error('Unable to allocate private retirement name');
  };
  const makeRetainedDir=(parent,name)=>{
    const filename=at(parent,name);
    try{fs.mkdirSync(filename,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    return pin(filename,parent);
  };
  // Retention sits beside the root's parent, never beneath a later refresh
  // destination or cleanup root. The parent chain is pinned above.
  const retainMoved=(source,stat)=>{
    const outer=rootAncestors[Math.max(0,rootAncestors.length-3)].fd;
    const retained=makeRetainedDir(outer,'.paperclip-retained');
    const runName=path.basename(path.dirname(root)).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,128)||'unknown';
    const runFd=makeRetainedDir(retained,runName), timestamp=Date.now()+'-'+crypto.randomUUID();
    const timeFd=makeRetainedDir(runFd,timestamp), filename=path.basename(root)+'-'+crypto.randomUUID();
    const destination=at(timeFd,filename), identity=String(stat.dev)+':'+String(stat.ino);
    fs.renameSync(source,destination);
    process.stderr.write('PAPERCLIP_RETAINED path='+path.join(path.dirname(path.dirname(root)),'.paperclip-retained',runName,timestamp,filename)+' identity='+identity+' size='+String(stat.size)+'\n');
  };
  const retireFile=name=>{
    const previous=files.get(name);
    if(previous)checkFile(name);else verify();
    const parent=parentOf(name), source=at(parent,path.posix.basename(name));
    const privateDir=makePrivateDir(parent), filename=at(privateDir.fd,'entry');
    try{
      verify();
      try{fs.renameSync(source,filename);}catch(error){if(error.code==='ENOENT')changed();throw error;}
      mutated=true;
      const moved=fs.lstatSync(filename,{bigint:true}), pinnedStat=previous&&fs.fstatSync(previous.fd,{bigint:true});
      if(previous&&pinnedStat.dev===moved.dev&&pinnedStat.ino===moved.ino){
        verify();fs.unlinkSync(filename);files.delete(name);
      }else{
        retainMoved(filename,moved);files.delete(name);changed();
      }
    }finally{try{fs.rmdirSync(at(parent,privateDir.name));}catch(error){if(error.code!=='ENOENT')throw error;}unpin(privateDir.fd);}
  };
  // Validate every checkpointed file before the first destination mutation, so
  // an already-dirty later file cannot be discovered only after earlier writes.
  for(const name of files.keys())checkFile(name);
  // Remove only obsolete/type-changing entries, deepest first, using pinned
  // parents. unlink/rmdir never follows a destination link.
  for(const [name,old] of [...observed].sort(([a],[b])=>b.split('/').length-a.split('/').length)){
    const e=desired.get(name), keep=e&&(e.data===undefined)===(old.kind==='dir');
    if(keep)continue; verify(); const filename=at(parentOf(name),path.posix.basename(name));
    if(old.kind==='dir'){
      const removed=directories.get(name); const i=pinned.findIndex(p=>p.fd===removed);
      try{fs.rmdirSync(filename);}catch(error){if(error.code==='ENOTEMPTY'||error.code==='EEXIST'||error.code==='ENOENT')changed();throw error;}
      mutated=true;if(i>=0){fs.closeSync(removed);pinned.splice(i,1);} directories.delete(name);
    }else retireFile(name);
  }
  for(const e of [...entries].sort((a,b)=>a.name.split('/').length-b.name.split('/').length)){
    verify(); const parent=parentOf(e.name); if(parent===undefined) throw Error('Missing refresh parent');
    const destination=at(parent,path.posix.basename(e.name));
    if(e.data===undefined){
      if(!directories.has(e.name)){
        try{fs.mkdirSync(destination,{mode:0o700});}catch(error){if(error.code==='EEXIST')changed();throw error;}
        mutated=true;const child=pin(destination,parent);directories.set(e.name,child);
      }
    }else{
      const temporary=at(parent,'.refresh-'+crypto.randomUUID());
      const file=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      try{
        verify(); const s=fs.fstatSync(file,{bigint:true}); if(!s.isFile()||s.nlink!==1n) throw Error('Unsafe refresh output');
        fs.writeFileSync(file,Buffer.from(e.data,'base64')); fs.fchmodSync(file,e.mode&0o777); fs.fsyncSync(file);
        verify(); checkFile(e.name);
        if(files.has(e.name))retireFile(e.name);
        // Atomically install without replacement, then move the source name into
        // a fresh private slot; the destination stays linked if this is interrupted.
        const privateDir=makePrivateDir(parent), filename=at(privateDir.fd,'entry');
        try{
          verify();
          try{fs.linkSync(temporary,destination);}catch(error){if(error.code==='EEXIST')changed();throw error;}
          mutated=true;
          fs.renameSync(temporary,filename);
          verify();fs.unlinkSync(filename);
        }finally{
          try{fs.closeSync(file);}catch(error){if(error.code!=='EBADF')throw error;}
          try{fs.unlinkSync(filename);}catch(error){if(error.code!=='ENOENT')throw error;}
          try{fs.rmdirSync(at(parent,privateDir.name));}catch(error){if(error.code!=='ENOENT')throw error;}
          unpin(privateDir.fd);
          try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
        }
      }finally{try{fs.closeSync(file);}catch(error){if(error.code!=='EBADF')throw error;}try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
    }
  }
  verify();
} catch(error) {
  // Only this explicit no-destination-write proof permits normal collection.
  // Any I/O failure, crash, or failure after a mutation remains INCOMPLETE.
  if(error.code==='LIVE_CHANGED'){
    process.stderr.write(mutated?'AGENT_FILES_REFRESH_CHANGED\n':'AGENT_FILES_REFRESH_UNMODIFIED\n');
    process.exitCode=mutated?76:75;
  }else throw error;
} finally { for(const file of pinnedFiles)fs.closeSync(file);for(const p of pinned.reverse())fs.closeSync(p.fd); }
`;
