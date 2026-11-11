import { describe,it,expect } from 'vitest';
import { money,dollars,parseImport,reconcile,summarize,timestamp,type Charge,type BudgetPolicy } from './ledger.js';
const companyId='11111111-1111-4111-8111-111111111111',now=Date.parse('2026-11-11T12:00:00Z');
export const policy:BudgetPolicy={payer:'Synthetic payer',monthlyEnvelopeUsd:'100.00',categories:[{id:'inference',label:'Inference'},{id:'servers',label:'Servers'},{id:'sandboxes',label:'Sandboxes'},{id:'ci',label:'CI'},{id:'labs',label:'Labs'},{id:'storage',label:'Storage'}],nativeInferenceCategory:'inference'};
const charge=(patch:Partial<Charge>={}):Charge=>({id:'one',category:'servers',coverageKey:'invoice-nov',from:'2026-11-01T00:00:00Z',until:'2026-12-01T00:00:00Z',usd:'10.00',kind:'commitment',source:'synthetic invoice',observedAt:'2026-11-10T00:00:00Z',revision:1,...patch});
const doc=(patch:Record<string,unknown>={})=>JSON.stringify({schema:1,companyId,policy,records:[charge()],notes:[],...patch});
describe('exact money and operator policy',()=>{
  it('preserves subcent USD and negative derived values',()=>{expect(dollars(money('0.000000001'))).toBe('0.000000001');expect(dollars(money('100')-money('101'))).toBe('-1.00');});
  it.each(['-1','NaN','1e3','1,000','01.0','0.0000000001','','Infinity'])('rejects ambiguous money %s',v=>expect(()=>money(v)).toThrow());
  it('has no built-in payer, envelope or categories',()=>{expect(parseImport(undefined,companyId,now).policy).toBeUndefined();expect(summarize([],now)).toEqual([]);});
  it('accepts a single envelope and configurable labels',()=>{expect(parseImport(doc(),companyId,now).policy).toEqual(policy);const custom={payer:'Other',monthlyEnvelopeUsd:'75.13',categories:[{id:'compute',label:'Compute'}]};expect(parseImport(doc({policy:custom,records:[]}),companyId,now).policy).toEqual(custom);});
  it('rejects old category caps and category-level limits',()=>{expect(()=>parseImport(doc({policy:{...policy,caps:{servers:'10'}}}),companyId,now)).toThrow('caps');expect(()=>parseImport(doc({policy:{...policy,categories:[{id:'servers',label:'Servers',capUsd:'10'}]}}),companyId,now)).toThrow('category');});
  it('rejects missing, duplicate or invalid categories and an unmapped native category',()=>{for(const p of [{...policy,categories:[]},{...policy,categories:[{id:'servers',label:'S'},{id:'servers',label:'T'}]},{...policy,nativeInferenceCategory:'missing'}])expect(()=>parseImport(doc({policy:p}),companyId,now)).toThrow();});
  it('keeps missing category evidence unknown',()=>{expect(summarize([],now,policy).every(c=>c.coveredUsd===null&&c.previousCoveredUsd===null)).toBe(true);});
});
describe('imports and reconciliation',()=>{
  it('accepts company-bound exact source data',()=>expect(parseImport(doc(),companyId,now).records).toHaveLength(1));
  it('rejects other companies, unconfigured categories, duplicates and future observations',()=>{
    expect(()=>parseImport(doc({companyId:'other'}),companyId,now)).toThrow();
    for(const patch of [{category:'__proto__'},{observedAt:'2026-11-12T00:00:00Z'},{revision:0},{from:'2026-11-31T00:00:00Z'}])expect(()=>parseImport(doc({records:[charge(patch)]}),companyId,now)).toThrow();
    expect(()=>parseImport(doc({records:[charge(),charge()]}),companyId,now)).toThrow('Duplicate');
  });
  it('rejects impossible calendar dates',()=>expect(()=>timestamp('2026-02-30T00:00:00Z')).toThrow());
  it('requires explicit monthly allocation',()=>expect(()=>parseImport(doc({records:[charge({until:'2027-01-01T00:00:00Z'})]}),companyId,now)).toThrow('monthly'));
  it('replaces commitments and estimates with the latest actual, never adds them',()=>{const rows=[charge(),charge({id:'estimate',kind:'accrual',usd:'11'}),charge({id:'paid',kind:'actual',usd:'9'}),charge({id:'corrected',kind:'actual',revision:2,usd:'8'})];expect(reconcile(rows).map(r=>r.usd)).toEqual(['8']);});
  it('rejects ambiguous revisions and partial overlap',()=>{expect(()=>reconcile([charge(),charge({id:'other'})])).toThrow('Ambiguous');expect(()=>reconcile([charge(),charge({id:'partial',from:'2026-11-02T00:00:00Z'})])).toThrow('overlapping');});
  it('reconciles equivalent UTC timestamps with different fractional serialization',()=>{const rows=reconcile([charge(),charge({id:'paid',kind:'actual',from:'2026-11-01T00:00:00.000Z',until:'2026-12-01T00:00:00.000Z',usd:'7'})]);expect(rows).toHaveLength(1);expect(rows[0]?.usd).toBe('7');});
  it('allows disjoint daily buckets with the same coverage key',()=>expect(reconcile([charge({until:'2026-11-02T00:00:00Z'}),charge({id:'next',from:'2026-11-02T00:00:00Z',until:'2026-11-03T00:00:00Z'})])).toHaveLength(2));
  it('rejects an unallocated inference aggregate beside separate charges',()=>{const records=[charge({category:'inference',coverageKey:'aggregate-inference:2026-11'}),charge({id:'provider',category:'inference',coverageKey:'separate-charge'})];expect(()=>parseImport(doc({records}),companyId,now)).toThrow('Allocate');});
  it('shows current versus previous coverage without category caps',()=>{const rows=[charge({usd:'6'}),charge({id:'prior',coverageKey:'oct',from:'2026-10-01T00:00:00Z',until:'2026-11-01T00:00:00Z',usd:'4'})];const summary=summarize(rows,now,policy).find(c=>c.category==='servers')!;expect(summary.coveredUsd).toBe('6.00');expect(summary.previousCoveredUsd).toBe('4.00');expect(summary).not.toHaveProperty('cap');expect(summary).not.toHaveProperty('remainingCoveredUsd');});
  it('carries unresolved older liabilities but not settled older spend',()=>{const rows=[charge({id:'old',coverageKey:'old',from:'2026-09-01T00:00:00Z',until:'2026-10-01T00:00:00Z',unresolved:true,usd:'3'}),charge({id:'paid',coverageKey:'paid',kind:'actual',from:'2026-09-01T00:00:00Z',until:'2026-10-01T00:00:00Z',usd:'20'})];expect(summarize(rows,now,policy).find(c=>c.category==='servers')?.coveredUsd).toBe('3.00');});
  it('keeps the non-actual subset inside covered amounts',()=>{const s=summarize([charge({usd:'4'}),charge({id:'paid',coverageKey:'other',kind:'actual',usd:'6'})],now,policy).find(c=>c.category==='servers')!;expect(s.coveredUsd).toBe('10.00');expect(s.liabilitiesUsd).toBe('4.00');});
});
