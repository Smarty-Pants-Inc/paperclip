import { definePlugin, runWorker, type PluginContext } from '@paperclipai/plugin-sdk';
import { dollars, money, parseImport, summarize, periodBounds, type Charge } from './ledger.js';
export const SDK_COMMIT='fcf4e39b41df0b871c1391566f911b39b8af1b71';
interface NativeCost { period_from:string; billing_type:string; cost_status:string; cents:string; count:string }
export async function readBudget(ctx:PluginContext, companyId:unknown) {
  if(typeof companyId!=='string'||!/^[0-9a-f-]{36}$/i.test(companyId)) throw new Error('A company scope is required');
  const now=Date.now(); const current=periodBounds(now),previous=periodBounds(now,-1);
  const iso=(ms:number)=>new Date(ms).toISOString();
  const config=await ctx.config.get(companyId);
  const imported=parseImport(config.importJson,companyId,now);
  const records:Charge[]=[...imported.records],notes=[...imported.notes];
  let nativeRows:NativeCost[]|null=null,runCount:string|null=null;
  const nativeEvidence:{period:string;usd:string|null;eventCount:string;unknownGroupCount:number}[]=[];
  if(imported.policy) {
  try {
    const rows=await ctx.db.query<NativeCost>(
      "SELECT (date_trunc('month', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS period_from, billing_type, cost_status, SUM(cost_cents)::text AS cents, COUNT(*)::text AS count FROM public.cost_events WHERE company_id = $1 AND occurred_at >= $2 AND occurred_at < $3 GROUP BY (date_trunc('month', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), billing_type, cost_status LIMIT 501",
      [companyId,iso(previous.from),iso(current.until)]);
    if(rows.length>500) throw new Error('Cost grouping limit');
    for(const period of [previous,current]) {
      const from=iso(period.from),until=iso(period.until),month=from.slice(0,7);
      const groups=rows.filter(r=>new Date(r.period_from).getTime()===period.from);
      const cash=groups.filter(r=>['metered_api','subscription_overage'].includes(r.billing_type)&&['reported','estimated'].includes(r.cost_status));
      const aggregate=imported.records.some(r=>r.category===imported.policy?.nativeInferenceCategory && r.coverageKey===`aggregate-inference:${month}`);
      const amount=cash.reduce((s,r)=>s+money(r.cents)/100n,0n);
      nativeEvidence.push({period:month,usd:cash.length?dollars(amount):null,eventCount:groups.reduce((s,r)=>s+BigInt(r.count),0n).toString(),unknownGroupCount:groups.length-cash.length});
      if(aggregate) notes.push(`Native marginal evidence for ${month} is NOT added to the aggregate inference commitment: inclusion versus additional spend is unknown until bill reconciliation.`);
      else if(imported.policy?.nativeInferenceCategory) for(const r of cash) {
        const key=`paperclip:${r.billing_type}:${r.cost_status}:${month}`;
        records.push({id:key,coverageKey:key,category:imported.policy.nativeInferenceCategory,kind:'accrual',from,until,usd:dollars(money(r.cents)/100n),source:`Company-scoped native cost events; ${r.billing_type}/${r.cost_status}; ${r.count} events. Stored observation read at ${iso(now)}, not invoice-reconciled.`,observedAt:iso(now),revision:1});
      }
    }
    nativeRows=rows;
    notes.push('Native costs are grouped by period and billing class, never by provider. Subscription-included list-price equivalents, unknown/unpriced charges and credits are not inferred as cash. No fee allocation is invented.');
  } catch {
    nativeRows=null; nativeEvidence.length=0;
    // Never leave a partially processed native read in the combined ledger.
    records.length=0; records.push(...imported.records);
    notes.push('Native monetary evidence unknown: the read-only query failed, returned invalid values, or exceeded its grouping limit.');
  }
  try {
    const runs=await ctx.db.query<{count:string}>('SELECT COUNT(*)::text AS count FROM public.heartbeat_runs WHERE company_id = $1 AND created_at >= $2 AND created_at < $3',[companyId,iso(current.from),iso(current.until)]);
    runCount=runs[0]?.count??null;
  } catch {notes.push('Run coverage unknown: read-only run count failed.');}
  } else notes.push('Not configured for this company. No source data was read; an operator must supply this company’s envelope and categories.');
  const categories=summarize(records,now,imported.policy);
  const coveredTotal=(field:'coveredUsd'|'previousCoveredUsd')=>{
    const known=categories.map(c=>c[field]).filter(v=>v!==null);
    return known.length?dollars(known.reduce((s,v)=>s+money(v),0n)):null;
  };
  return {schema:1,companyId,generatedAt:iso(now),sdkCommit:SDK_COMMIT,mode:'read-only',configured:!!imported.policy,payer:imported.policy?.payer??'Unknown payer',
    month:iso(current.from).slice(0,7),previousMonth:iso(previous.from).slice(0,7),monthlyEnvelopeUsd:imported.policy?.monthlyEnvelopeUsd??null,
    coveredTotalUsd:coveredTotal('coveredUsd'),previousCoveredTotalUsd:coveredTotal('previousCoveredUsd'),categories,nativeAvailable:nativeRows!==null,nativeEvidence,runCount,notes,
    forecast:'Unknown: evidence is partial. Covered amounts include commitments and estimates; they are not paid-spend totals or a safe-to-spend balance. Category comparisons cover only the supplied records, not equal complete periods.',
    quota:'Unknown: no verified account-window feed is installed in this read-only phase.',
    controls:'Not enabled: no holds, releases, fill, reservations writer or principal classification. Waiting order, bypass starts and principal exhaustion are not measured.',
    sandboxes:'Actual sandbox spend unknown until a validated usage export is imported. Run intervals alone omit idle/shared resource lifetime. Published rates are not charges.',
  };
}
export type BudgetView=Awaited<ReturnType<typeof readBudget>>;
const plugin=definePlugin({
  async setup(ctx){ctx.data.register('budget',({companyId})=>readBudget(ctx,companyId));},
  async onHealth(){return {status:'ok',message:'Budget read-only worker; no dispatch or routing effects',details:{sdkCommit:SDK_COMMIT}};},
  async onValidateConfig(config){
    try {
      if(config.importJson){const d=JSON.parse(String(config.importJson));if(typeof d?.companyId!=='string'||!/^[0-9a-f-]{36}$/i.test(d.companyId))throw new Error('Company required');const validated=parseImport(config.importJson,d.companyId,Date.now());summarize(validated.records,Date.now(),validated.policy);}
      return {ok:true};
    } catch {return {ok:false,errors:['Invalid budget import: verify company, envelope/categories, exact USD values, coverage, revisions and timestamps.']};}
  },
});
export default plugin;
runWorker(plugin,import.meta.url);
