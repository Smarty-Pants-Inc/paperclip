import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseImport,summarize} from './ledger.js';
const dirs:string[]=[],companyId='11111111-1111-4111-8111-111111111111';
const day=new Date().toISOString().slice(0,10),early=day+'T00:00:00Z',later=day+'T00:00:01Z';
const row=(at:string,usd:string,errors='0')=>`${at} meter=v2 day=${day} usd=${usd} read_errors=${errors}`;
function run(lines:string[]){
  const dir=mkdtempSync(join(tmpdir(),'budget-import-test-'));dirs.push(dir);
  const seed=join(dir,'seed.json'),meter=join(dir,'meter.log'),output=join(dir,'output.json');
  writeFileSync(seed,JSON.stringify({schema:1,companyId,policy:{payer:'Synthetic',monthlyEnvelopeUsd:'100',categories:[{id:'ci',label:'CI'}]},records:[],notes:[]}));
  writeFileSync(meter,lines.join('\n'));
  const proc=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/build-import.mjs',import.meta.url)),companyId,seed,meter,output],{encoding:'utf8',timeout:15000});
  return {proc,output,read:()=>parseImport(readFileSync(output,'utf8'),companyId,Date.now())};
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe('actual operator import CLI',{timeout:20000},()=>{
  it.each(['1.1234567890','0.0000000001','1.20oops','5e2','1.','01.2','-1'])('rejects the complete malformed/unsupported USD token %s',usd=>{const r=run([row(early,usd)]);expect(r.proc.status).not.toBe(0);expect(r.proc.stderr).toContain('Invalid exact USD token');expect(existsSync(r.output)).toBe(false);});
  it('rejects duplicate amount fields instead of picking a prefix/first value',()=>{const r=run([row(early,'1')+' usd=2']);expect(r.proc.status).not.toBe(0);expect(existsSync(r.output)).toBe(false);});
  it('preserves all nine fractional digits without rounding',()=>{const r=run([row(early,'1.123456789')]);expect(r.proc.status).toBe(0);expect(r.read().records[0]?.usd).toBe('1.123456789');});
  it('keeps the last valid amount and its real observation age after an errored zero',()=>{
    const r=run([row(early,'5.00'),row(later,'0.00','1')]);expect(r.proc.status).toBe(0);
    const d=r.read(),c=summarize(d.records,Date.now(),d.policy)[0]!;
    expect(c.coveredUsd).toBe('5.00');expect(c.records[0]?.observedAt).toBe(early);
    expect(d.notes.join(' ')).toContain('collection failed');expect(d.notes.join(' ')).toContain('coverage after it is unknown');
  });
  it('makes an error-only day unknown, never an actual zero',()=>{const r=run([row(later,'0.00','1')]);expect(r.proc.status).toBe(0);const d=r.read();expect(d.records).toEqual([]);expect(summarize(d.records,Date.now(),d.policy)[0]?.coveredUsd).toBeNull();expect(d.notes.join(' ')).toContain('day cost is unknown');});
  it('does not invent zero errors when the collection status is missing or malformed',()=>{for(const errors of ['bad','-1']){const r=run([row(later,'0.00',errors)]);expect(r.proc.status).toBe(0);expect(r.read().records).toEqual([]);expect(r.read().notes.join(' ')).toContain('read_errors=unknown');}});
  it('can recover from an older failure without discarding a later valid snapshot',()=>{const r=run([row(early,'0.00','1'),row(later,'7.00')]);expect(r.proc.status).toBe(0);expect(r.read().records[0]?.usd).toBe('7.00');expect(r.read().notes.join(' ')).not.toContain('collection failed');});
});
