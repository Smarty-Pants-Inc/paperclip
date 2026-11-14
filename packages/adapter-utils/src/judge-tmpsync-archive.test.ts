// Place in packages/adapter-utils/src/. Independent real-GNU-tar preservation and negative-space probes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTarballFromDirectory } from './sandbox-managed-runtime.js';
const exec=promisify(callback);
let root:string;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'judge-archive-'));});
afterEach(async()=>{vi.restoreAllMocks(); await fs.chmod(path.join(root,'source','omitted'),0o700).catch(()=>{}); await fs.rm(root,{recursive:true,force:true});});
async function seed(name:string,bytes='user content\n') {const target=path.join(root,'source',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
async function members(archive:string) { return (await exec('tar',['-tf',archive])).stdout.trim().split('\n'); }
async function bytes(archive:string,name:string) { return (await exec('tar',['-xOf',archive,name])).stdout; }

describe('prior F2 independent reproductions',()=>{
  it('root archive does not drop releases/workspace.tar',async()=>{
    await seed('releases/workspace.tar','real release artifact'); await seed('kept.txt');
    const archive=path.join(root,'source','workspace.tar'); await fs.writeFile(archive,'previous output');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive});
    console.log('ARCHIVE_MEMBERS root',await members(archive));
    expect(await members(archive)).toContain('releases/workspace.tar');
    expect(await members(archive)).not.toContain('workspace.tar');
    expect(await bytes(archive,'releases/workspace.tar')).toBe('real release artifact');
  });
  it('own direct staging does not drop fixtures/paperclip-sandbox-sync-example',async()=>{
    await seed('fixtures/paperclip-sandbox-sync-example/real.txt','fixture bytes');
    await seed('paperclip-sandbox-sync-example/scratch.txt','owned bytes');
    const archive=path.join(root,'source','paperclip-sandbox-sync-example','workspace.tar');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive});
    console.log('ARCHIVE_MEMBERS staging',await members(archive));
    expect(await bytes(archive,'fixtures/paperclip-sandbox-sync-example/real.txt')).toBe('fixture bytes');
    expect((await members(archive)).some(x=>x.startsWith('paperclip-sandbox-sync-example/'))).toBe(false);
  });
});

describe('F2 nested preservation matrix',()=>{
  it.each(['build','.git','node_modules','build/cache/staging-[one]*'])('excludes exact owned %s while keeping nested siblings',async owned=>{
    const archive=path.join(root,'source',owned,'workspace.tar');
    await seed(`${owned}/internal.txt`,'owned scratch');
    for(const p of ['src/.git-notes','pkg/node_modules-readme','pkg/build/real.txt',`fixtures/${owned}/real.txt`]) await seed(p,`KEEP:${p}\n`);
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive});
    const list=await members(archive);
    expect(list.some(x=>x.startsWith(`${owned}/`))).toBe(false);
    for(const p of ['src/.git-notes','pkg/node_modules-readme','pkg/build/real.txt',`fixtures/${owned}/real.txt`]) expect(await bytes(archive,p)).toBe(`KEEP:${p}\n`);
  });
  it('retains caller root directory exclusions without erasing same-looking file names or nested build',async()=>{
    for(const p of ['.git/config','node_modules/lib/index.js','src/.git-notes','pkg/node_modules-readme','pkg/build/real.txt','build/staging/internal.txt'])await seed(p);
    const archive=path.join(root,'source/build/staging/workspace.tar');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive,exclude:['.git','node_modules']});
    const list=await members(archive);
    expect(list.some(x=>x.startsWith('.git/')||x.startsWith('node_modules/')||x.startsWith('build/staging/'))).toBe(false);
    for(const p of ['src/.git-notes','pkg/node_modules-readme','pkg/build/real.txt'])expect(await bytes(archive,p)).toBe('user content\n');
  });
});

describe('explicit-list exclusion boundary',()=>{
  // v3: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20495
  it.skip('does not inspect a caller-excluded unreadable directory',async()=>{
    await seed('omitted/private.txt'); await fs.chmod(path.join(root,'source/omitted'),0);
    await seed('kept.txt'); await fs.mkdir(path.join(root,'source/build/staging'),{recursive:true});
    const archive=path.join(root,'source/build/staging/workspace.tar');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive,exclude:['omitted']});
    expect(await bytes(archive,'kept.txt')).toBe('user content\n');
    expect((await members(archive)).some(x=>x.startsWith('omitted/'))).toBe(false);
  });
  // v3: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20495
  it.skip('does not follow a dangling link inside a caller-excluded directory',async()=>{
    await seed('kept.txt'); await fs.mkdir(path.join(root,'source/omitted'));
    await fs.symlink(path.join(root,'missing'),path.join(root,'source/omitted/dangling'));
    await fs.mkdir(path.join(root,'source/build/staging'),{recursive:true});
    const archive=path.join(root,'source/build/staging/workspace.tar');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive,exclude:['omitted'],followSymlinks:true});
    expect(await bytes(archive,'kept.txt')).toBe('user content\n');
  });
});
