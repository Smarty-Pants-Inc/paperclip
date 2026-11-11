// Read-only extraction. No network, credentials, source edits or runtime effects.
// Node >=24.11 strips the ledger's TypeScript; use its exact-money contract.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {money,parseImport,timestamp} from '../src/ledger.ts';
const [companyId,seedPath,meterPath,output]=process.argv.slice(2);
if(!companyId||!/^[0-9a-f-]{36}$/i.test(companyId)||!seedPath||!meterPath||!output)throw new Error('Usage: node scripts/build-import.mjs COMPANY_UUID SEED_JSON METER_READINGS OUTPUT_JSON');
const now=new Date(),month=now.toISOString().slice(0,7);
const seedText=fs.readFileSync(seedPath,'utf8'),seed=JSON.parse(seedText);
parseImport(seedText,companyId,now.getTime());
const hash=value=>createHash('sha256').update(value).digest('hex');
const latestByDay=new Map(),failuresByDay=new Map();
for(const line of fs.readFileSync(meterPath,'utf8').split('\n')){
  const tokens=line.trim().split(/\s+/);
  if(!tokens.includes('meter=v2'))continue;
  // Read the WHOLE token once. Prefix matches and duplicate fields are invalid.
  const field=name=>{const values=tokens.filter(t=>t.startsWith(name+'='));return values.length===1?values[0].slice(name.length+1):undefined;};
  const at=tokens[0],day=field('day'),errors=field('read_errors');
  if(!at||!day||!/^\d{4}-\d\d-\d\d$/.test(day)||!day.startsWith(month))continue;
  let observed;
  try{timestamp(day+'T00:00:00Z');observed=timestamp(at);}catch{continue;}
  if(observed>now.getTime())continue;
  if(!errors||!/^\d{1,12}$/.test(errors)||BigInt(errors)!==0n){
    const prior=failuresByDay.get(day);
    if(!prior||Date.parse(prior.at)<observed)failuresByDay.set(day,{at,errors:errors&&/^\d{1,12}$/.test(errors)?errors:'unknown'});
    continue; // Failed collection is UNKNOWN, never an actual zero.
  }
  const usd=field('usd');
  try{if(usd===undefined)throw new Error('missing');money(usd);}catch{throw new Error(`Invalid exact USD token in CI meter v2 at ${at}; no output written`);}
  const prior=latestByDay.get(day);
  if(!prior||Date.parse(prior.at)<observed)latestByDay.set(day,{at,day,usd,line});
}
const records=[...seed.records],failureNotes=[];
for(const [day,failure] of failuresByDay){
  const valid=latestByDay.get(day);
  if(valid&&Date.parse(valid.at)>Date.parse(failure.at))continue;
  failureNotes.push(`CI meter v2 collection failed for ${day} at ${failure.at}; read_errors=${failure.errors}. ${valid?`Keeping the last valid observation from ${valid.at} with its original age; coverage after it is unknown.`:'No valid observation is available: day cost is unknown; no actual dollar value is imported.'}`);
}
for(const {at,day,usd,line} of latestByDay.values()){
  const key=`ci-meter-v2:${day}`;
  if(records.some(r=>r.id===key))throw new Error('Seed already contains a generated CI meter record');
  records.push({id:key,category:'ci',coverageKey:`ci-meter:${day}`,from:day+'T00:00:00Z',until:new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString(),usd,kind:'actual',source:`Operator-supplied CI meter v2 (factor 1.0), UTC day-to-date through ${at}; read_errors=0. Scope comes from the seed notes. Not an invoice. Source-row sha256=${hash(line)}`,observedAt:at,revision:1});
}
const doc={...seed,records,notes:[...seed.notes,
  `Import generated ${now.toISOString()}; seed sha256=${hash(seedText)}.`,
  'CI meter v2 values are measured USD at the recorded runner rate, not a monthly invoice. Each day is a partial-coverage bucket through its observation time. Historical v1 readings are excluded. No missing day is zero.',
  ...failureNotes,
  `CI v2 days imported: ${latestByDay.size}. Refreshing the page does not rerun this operator import.`,
]};
const serialized=JSON.stringify(doc,null,2)+'\n';
parseImport(serialized,companyId,now.getTime());
fs.writeFileSync(output,serialized);
console.log(JSON.stringify({companyId,month,recordCount:records.length,ciDays:latestByDay.size,failedDays:failureNotes.length,output}));
