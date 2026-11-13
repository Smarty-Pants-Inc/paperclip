import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../middleware/logger.js', () => ({ logger: { info: vi.fn() } }));
// A successful read may legally return fewer bytes than requested. Use real
// descriptors and kernel reads; only reduce the requested size at the boundary.
vi.mock('node:fs/promises', async original => {
 const actual = await original<typeof import('node:fs/promises')>();
 return {...actual, open: async (...args: Parameters<typeof actual.open>) => {
   const file = await actual.open(...args); const read = file.read.bind(file);
   file.read = ((buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length,16), position)) as typeof file.read;
   return file;
 }};
});
import { removeNativeHarnessBackup } from './native-harness-backup-cleanup.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
it.each([
 ['renamed.data','{"type":"session","version":3,"id":"short-read"}\n{"type":"message"}\n'],
 ['bom.data','\uFEFF{"type":"session","version":3,"id":"bom"}\n{"type":"message"}\n'],
 ['manifest.json',JSON.stringify({padding:'x'.repeat(6000),providerKind:'pi_rpc'})],
])('short successful reads must not delete Pi evidence: %s', async (name,bytes) => {
 const base=await mkdtemp(join(tmpdir(),'rfl-short-read-')); roots.push(base);
 const scope='c'.repeat(64), source=join(base,scope,'failover-backups','previous');
 await mkdir(source,{recursive:true}); await writeFile(join(source,name),bytes);
 await removeNativeHarnessBackup(source);
 const evidence=join(base,'conversation-evidence',scope);
 const leaves=await readdir(evidence).catch(()=>[]);
 const retained = leaves.length === 1 && await readFile(join(evidence,leaves[0],name),'utf8').catch(()=>null) === bytes;
 expect(retained).toBe(true);
});
