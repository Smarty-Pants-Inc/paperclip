// Read-only extraction. No network, credentials, source edits or runtime effects.
// Seed JSON supplies the company's policy, commitments, scope and provenance.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const [companyId, seedPath, meterPath, output] = process.argv.slice(2);
if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId) || !seedPath || !meterPath || !output) throw new Error('Usage: node scripts/build-import.mjs COMPANY_UUID SEED_JSON METER_READINGS OUTPUT_JSON');
const now = new Date();
const month = now.toISOString().slice(0,7);
const seedText=fs.readFileSync(seedPath,'utf8');
const seed=JSON.parse(seedText);
if(seed?.schema!==1 || seed.companyId!==companyId || !Array.isArray(seed.records) || !Array.isArray(seed.notes)) throw new Error('Invalid company-scoped seed document');
const hash = value => createHash('sha256').update(value).digest('hex');
const latestByDay=new Map();
for(const line of fs.readFileSync(meterPath,'utf8').split('\n')) {
  if(!/\bmeter=v2\b/.test(line)) continue;
  const at=line.match(/^(\S+)/)?.[1];
  const day=line.match(/\bday=(\d{4}-\d\d-\d\d)\b/)?.[1];
  const usd=line.match(/\busd=(\d+(?:\.\d{1,9})?)\b/)?.[1];
  const errors=line.match(/\bread_errors=(\d+)\b/)?.[1];
  if(!at || !day || !usd || !errors || !day.startsWith(month) || !Number.isFinite(Date.parse(at)) || Date.parse(at)>now.getTime()) continue;
  const prior=latestByDay.get(day);
  if(!prior || Date.parse(prior.at)<Date.parse(at)) latestByDay.set(day,{at,day,usd,errors,line});
}
const records=[...seed.records];
for(const {at,day,usd,errors,line} of latestByDay.values()) {
  const key=`ci-meter-v2:${day}`;
  if(records.some(r=>r.id===key)) throw new Error('Seed already contains a generated CI meter record');
  records.push({id:key,category:'ci',coverageKey:`ci-meter:${day}`,from:day+'T00:00:00Z',until:new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString(),usd,kind:'actual',source:`Operator-supplied CI meter v2 (factor 1.0), UTC day-to-date through ${at}; read_errors=${errors}. Scope comes from the seed notes. Not an invoice. Source-row sha256=${hash(line)}`,observedAt:at,revision:1});
}
const doc={...seed,records,notes:[...seed.notes,
  `Import generated ${now.toISOString()}; seed sha256=${hash(seedText)}.`,
  'CI meter v2 values are measured USD at the recorded runner rate, not a monthly invoice. Each day is a partial-coverage bucket through its observation time. Historical v1 readings are excluded. No missing day is zero.',
  `CI v2 days imported: ${latestByDay.size}. Refreshing the page does not rerun this operator import.`,
]};
fs.writeFileSync(output,JSON.stringify(doc,null,2)+'\n');
console.log(JSON.stringify({companyId,month,recordCount:records.length,ciDays:latestByDay.size,output}));
