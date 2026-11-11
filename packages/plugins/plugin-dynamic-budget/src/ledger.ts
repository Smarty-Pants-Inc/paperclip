export interface BudgetCategory { id: string; label: string }
export interface BudgetPolicy {
  payer: string; monthlyEnvelopeUsd: string; categories: BudgetCategory[];
  nativeInferenceCategory?: string;
}
export type Kind = 'commitment' | 'accrual' | 'actual' | 'reservation' | 'uncertainty';
export interface Charge {
  id: string; category: string; coverageKey: string; from: string; until: string;
  usd: string; kind: Kind; source: string; observedAt: string; revision: number; unresolved?: boolean;
}
export interface ImportDocument { schema: 1; companyId: string; records: Charge[]; notes: string[]; policy?: BudgetPolicy }
const SCALE = 1_000_000_000n;
// Nine USD decimal places preserve the host's seven fractional cent digits.
export function money(value: string): bigint {
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,9})?$/.test(value)) throw new Error('USD must be a nonnegative exact decimal string');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(9, '0'));
}
export function dollars(value: bigint): string {
  const sign = value < 0n ? '-' : ''; const n = value < 0n ? -value : value;
  return `${sign}${n / SCALE}.${(n % SCALE).toString().padStart(9, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}
function text(x: unknown, name: string, max = 500): asserts x is string {
  if (typeof x !== 'string' || !x.trim() || x.length > max || /[\u0000-\u001f]/.test(x)) throw new Error(`Invalid ${name}`);
}
export function timestamp(x: unknown): number {
  if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x) || !Number.isFinite(Date.parse(x))) throw new Error('Invalid UTC timestamp');
  const millis = Date.parse(x);
  if (new Date(millis).toISOString().slice(0,19) !== x.slice(0,19)) throw new Error('Invalid UTC calendar date');
  return millis;
}
export function parseImport(raw: unknown, companyId: string, now: number): ImportDocument {
  if (raw === undefined || raw === '') return { schema: 1, companyId, records: [], notes: [] };
  if (typeof raw !== 'string' || raw.length > 1_000_000) throw new Error('Import must be a bounded JSON string');
  const d = JSON.parse(raw);
  if (!d || typeof d !== 'object' || d.schema !== 1 || d.companyId !== companyId || !Array.isArray(d.records) || d.records.length > 5000 || !Array.isArray(d.notes) || d.notes.length > 100) throw new Error('Invalid import schema or company');
  const categories = new Set<string>();
  if (d.policy !== undefined) {
    const policy = d.policy;
    if (!policy || typeof policy !== 'object' || Object.keys(policy).some(k=>!['payer','monthlyEnvelopeUsd','categories','nativeInferenceCategory'].includes(k))) throw new Error('Invalid policy; category caps are not supported');
    text(policy.payer, 'payer');
    if (typeof policy.monthlyEnvelopeUsd !== 'string') throw new Error('Invalid monthly envelope');
    money(policy.monthlyEnvelopeUsd);
    if (!Array.isArray(policy.categories) || !policy.categories.length || policy.categories.length>50) throw new Error('Invalid categories');
    for (const category of policy.categories) {
      if (!category || Object.keys(category).some(k=>!['id','label'].includes(k)) || typeof category.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(category.id) || categories.has(category.id)) throw new Error('Invalid or duplicate category');
      text(category.label,'category label',100); categories.add(category.id);
    }
    if (policy.nativeInferenceCategory!==undefined && !categories.has(policy.nativeInferenceCategory)) throw new Error('Native inference category must be configured');
  }
  const ids = new Set<string>();
  for (const r of d.records) {
    if (!r || typeof r !== 'object') throw new Error('Invalid charge record');
    for (const k of ['id', 'coverageKey', 'source']) text(r[k], k);
    if (!categories.has(r.category) || !['commitment','accrual','actual','reservation','uncertainty'].includes(r.kind)) throw new Error('Invalid charge category or kind');
    if (typeof r.usd !== 'string') throw new Error('USD must be a string');
    money(r.usd);
    if (!Number.isSafeInteger(r.revision) || r.revision < 1 || (r.unresolved !== undefined && typeof r.unresolved !== 'boolean')) throw new Error('Invalid revision or liability flag');
    if (timestamp(r.from) >= timestamp(r.until) || timestamp(r.observedAt) > now + 60_000) throw new Error('Invalid coverage or future observation');
    if (new Date(timestamp(r.until)-1).toISOString().slice(0,7)!==r.from.slice(0,7)) throw new Error('Split cross-month charges into explicit monthly allocations');
    if (ids.has(r.id)) throw new Error('Duplicate record ID'); ids.add(r.id);
  }
  for (const n of d.notes) text(n,'note',2000);
  reconcile(d.records);
  for (const aggregate of d.records.filter((r: Charge)=>r.coverageKey.startsWith('aggregate-inference:'))) {
    if (d.records.some((r: Charge)=>r.category===aggregate.category && r.coverageKey!==aggregate.coverageKey && timestamp(r.from)<timestamp(aggregate.until) && timestamp(aggregate.from)<timestamp(r.until))) throw new Error('Allocate the inference aggregate before adding separate charges');
  }
  return d;
}
export function reconcile(records: Charge[]): Charge[] {
  const groups = new Map<string, Charge[]>(); const ids = new Set<string>();
  for (const r of records) {
    if (ids.has(r.id)) throw new Error('Duplicate record ID across sources'); ids.add(r.id);
    const key = `${r.category}:${r.coverageKey}`; const group=groups.get(key)??[]; group.push(r); groups.set(key,group);
  }
  const result: Charge[]=[]; const rank={commitment:0,accrual:1,actual:2,reservation:0,uncertainty:0};
  for (const group of groups.values()) {
    const byInterval=new Map<string,Charge[]>();
    for (const r of group) {
      const key=`${timestamp(r.from)}:${timestamp(r.until)}`; const rows=byInterval.get(key)??[]; rows.push(r); byInterval.set(key,rows);
    }
    const intervals=[...byInterval.values()].sort((a,b)=>timestamp(a[0]!.from)-timestamp(b[0]!.from));
    for(let i=1;i<intervals.length;i++) if(timestamp(intervals[i]![0]!.from)<timestamp(intervals[i-1]![0]!.until)) throw new Error('Partial overlapping coverage requires reconciliation before import');
    for(const rows of intervals) {
      rows.sort((a,b)=>rank[b.kind]-rank[a.kind]||b.revision-a.revision);
      const first=rows[0]!;
      if(rows[1] && rank[rows[1].kind]===rank[first.kind] && rows[1].revision===first.revision) throw new Error('Ambiguous charge revisions');
      result.push(first);
    }
  }
  return result;
}
export function periodBounds(now: number, offset=0) {
  const d=new Date(now);
  return {from:Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset,1),until:Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset+1,1)};
}
export function summarize(records: Charge[], now: number, policy?: BudgetPolicy) {
  const reconciled=reconcile(records);
  const select=(offset:number)=>{const {from,until}=periodBounds(now,offset);return reconciled.filter(r=>(timestamp(r.from)<until && timestamp(r.until)>from)||(r.unresolved && timestamp(r.until)<=from));};
  const current=select(0),previous=select(-1);
  const total=(rows:Charge[])=>rows.length?dollars(rows.reduce((s,r)=>s+money(r.usd),0n)):null;
  return (policy?.categories??[]).map(({id:category,label})=>{
    const rows=current.filter(r=>r.category===category),prior=previous.filter(r=>r.category===category);
    return {category,label,coveredUsd:total(rows),liabilitiesUsd:rows.length?dollars(rows.filter(r=>r.kind!=='actual').reduce((s,r)=>s+money(r.usd),0n)):null,
      previousCoveredUsd:total(prior),coverage:rows.length?'partial' as const:'unknown' as const,previousCoverage:prior.length?'partial' as const:'unknown' as const,records:rows,previousRecords:prior};
  });
}
