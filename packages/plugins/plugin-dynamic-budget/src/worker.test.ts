import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestHarness} from '@paperclipai/plugin-sdk/testing';
import manifest from './manifest.js';
import plugin,{type BudgetView} from './worker.js';
const companyId='11111111-1111-4111-8111-111111111111';
const policy={payer:'Synthetic payer',monthlyEnvelopeUsd:'100.00',categories:[{id:'inference',label:'Inference'},{id:'compute',label:'Compute'}],nativeInferenceCategory:'inference'};
const config=(records:unknown[]=[])=>({importJson:JSON.stringify({schema:1,companyId,policy,records,notes:[]})});
const native=(patch:Record<string,unknown>={})=>({period_from:'2026-11-01T00:00:00Z',billing_type:'metered_api',cost_status:'reported',cents:'100',count:'1',...patch});
async function harness(config={}){const h=createTestHarness({manifest,config});await plugin.definition.setup(h.ctx);return h;}
beforeEach(()=>vi.useFakeTimers({now:new Date('2026-11-11T19:00:00Z')}));
afterEach(()=>vi.useRealTimers());
describe('SDK worker read-only flow',()=>{
  it('registers only reads, binds companies and bounds both comparison periods',async()=>{
    const h=await harness(config()),view=await h.getData<BudgetView>('budget',{companyId});
    expect(view).toMatchObject({mode:'read-only',monthlyEnvelopeUsd:'100.00',configured:true,companyId,runCount:null,coveredTotalUsd:null});
    expect(h.dbQueries).toHaveLength(2);
    for(const q of h.dbQueries){expect(q.sql).toMatch(/^SELECT /);expect(q.sql).toContain('company_id = $1');expect(q.sql).not.toMatch(/biller|provider_id/);expect(q.params?.[0]).toBe(companyId);expect(q.params?.[2]).toBe('2026-12-01T00:00:00.000Z');}
    expect(h.dbQueries[0]?.params?.[1]).toBe('2026-10-01T00:00:00.000Z');expect(h.dbQueries[1]?.params?.[1]).toBe('2026-11-01T00:00:00.000Z');
    expect(h.dbExecutes).toEqual([]);expect(h.activity).toEqual([]);
    expect(manifest.capabilities).toEqual(['ui.page.register','ui.sidebar.register','ui.dashboardWidget.register','database.namespace.read','database.namespace.migrate']);
  });
  it('shows an explicit unconfigured state for any unconfigured company, without reading its data',async()=>{for(const id of [companyId,'22222222-2222-4222-8222-222222222222']){const h=await harness(),view=await h.getData<BudgetView>('budget',{companyId:id});expect(view).toMatchObject({configured:false,monthlyEnvelopeUsd:null,categories:[],nativeAvailable:false,runCount:null});expect(view.notes.join(' ')).toContain('Not configured for this company');expect(h.dbQueries).toEqual([]);}});
  it('rejects absent, malformed and mismatched company scope',async()=>{const h=await harness(config());await expect(h.getData('budget',{})).rejects.toThrow('company');await expect(h.getData('budget',{companyId:'sql-injection'})).rejects.toThrow();await expect(h.getData('budget',{companyId:'22222222-2222-4222-8222-222222222222'})).rejects.toThrow('company');});
  it('reports unavailable sources as unknown, not zero',async()=>{const h=await harness(config());vi.spyOn(h.ctx.db,'query').mockRejectedValue(new Error('host unavailable'));const view=await h.getData<BudgetView>('budget',{companyId});expect(view.nativeAvailable).toBe(false);expect(view.nativeEvidence).toEqual([]);expect(view.runCount).toBeNull();expect(view.notes.join(' ')).toContain('query failed');expect(view.categories.every(c=>c.coveredUsd===null)).toBe(true);});
  it('keeps only one supplied envelope and has no category/provider limits',async()=>{const h=await harness(config()),view=await h.getData<BudgetView>('budget',{companyId});expect(view.monthlyEnvelopeUsd).toBe('100.00');expect(view.categories.map(c=>c.label)).toEqual(['Inference','Compute']);expect(JSON.stringify(view)).not.toMatch(/capUsd|remainingCoveredUsd|totalCapUsd|biller/);expect(view).not.toHaveProperty('envelopes');});
  it('preserves subcent cash; excludes list-price, credits, unknown and unpriced values',async()=>{
    const h=await harness(config());vi.spyOn(h.ctx.db,'query').mockImplementation(async sql=>sql.includes('heartbeat_runs')?[{count:'4'}]:[
      native({cents:'0.0000001'}),native({billing_type:'subscription_overage',cost_status:'estimated',cents:'123'}),
      ...['subscription_included','credits','unknown'].map(billing_type=>native({billing_type,cents:'99999'})),native({cost_status:'unpriced',cents:'99999'}),
    ] as never);
    const view=await h.getData<BudgetView>('budget',{companyId});expect(view.categories[0]).toMatchObject({coveredUsd:'1.230000001',liabilitiesUsd:'1.230000001',previousCoveredUsd:null,coverage:'partial'});expect(view.coveredTotalUsd).toBe('1.230000001');expect(view.runCount).toBe('4');expect(view.nativeEvidence.find(r=>r.period==='2026-11')?.unknownGroupCount).toBe(4);
  });
  it('compares prior-period native evidence by the same category, not provider',async()=>{const h=await harness(config());vi.spyOn(h.ctx.db,'query').mockImplementation(async sql=>sql.includes('heartbeat_runs')?[{count:'2'}]:[native({cents:'600'}),native({period_from:'2026-10-01T00:00:00Z',cents:'400'})] as never);const view=await h.getData<BudgetView>('budget',{companyId});expect(view.categories[0]).toMatchObject({coveredUsd:'6.00',previousCoveredUsd:'4.00',previousCoverage:'partial'});expect(view.previousCoveredTotalUsd).toBe('4.00');});
  it('does not add native costs to an aggregate inference commitment',async()=>{
    const h=await harness(config([{id:'fixed',category:'inference',coverageKey:'aggregate-inference:2026-11',from:'2026-11-01T00:00:00Z',until:'2026-12-01T00:00:00Z',usd:'50.00',kind:'commitment',source:'Synthetic policy',observedAt:'2026-11-11T07:38:57Z',revision:1}]));
    vi.spyOn(h.ctx.db,'query').mockImplementation(async sql=>sql.includes('heartbeat_runs')?[{count:'1'}]:[native({cents:'10000'})] as never);
    const view=await h.getData<BudgetView>('budget',{companyId});expect(view.categories[0]?.coveredUsd).toBe('50.00');expect(view.nativeEvidence.find(r=>r.period==='2026-11')?.usd).toBe('100.00');expect(view.notes.join(' ')).toContain('NOT added');
  });
  it('drops all partially processed native rows on invalid cash evidence',async()=>{const h=await harness(config());vi.spyOn(h.ctx.db,'query').mockImplementation(async sql=>sql.includes('heartbeat_runs')?[]:[native({period_from:'2026-10-01T00:00:00Z'}),native({cents:'-1'})] as never);const view=await h.getData<BudgetView>('budget',{companyId});expect(view.nativeAvailable).toBe(false);expect(view.categories.every(c=>c.coveredUsd===null&&c.previousCoveredUsd===null)).toBe(true);});
  it('validates company config and rejects old static caps before activation',async()=>{expect(await plugin.definition.onValidateConfig!({})).toEqual({ok:true});expect((await plugin.definition.onValidateConfig!({importJson:'null'})).ok).toBe(false);expect((await plugin.definition.onValidateConfig!(config())).ok).toBe(true);expect((await plugin.definition.onValidateConfig!({importJson:JSON.stringify({schema:1,companyId,records:[],notes:[],policy:{...policy,caps:{inference:'50'}}})})).ok).toBe(false);});
});
