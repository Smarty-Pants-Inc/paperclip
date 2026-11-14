import { createDb, closeRegisteredClients, nativeRunFinalizations, heartbeatRuns } from '@paperclipai/db';
import { eq } from 'drizzle-orm';
import { finalizeNativeRun } from '../services/native-runtime/native-run-finalizer.js';
import { nativeReviewResponseWork } from '../services/native-runtime/native-review-response-work.js';
import { authorizeNativeChatReviewPresentation } from '../services/native-runtime/native-chat-review-presentation.js';
import { publishPending } from './judge-r4-transport.js';
const url = process.env.JUDGE_DATABASE_URL!;
const db = createDb(url);
const data = JSON.parse(process.env.JUDGE_INPUT!);
try {
  if (data.finalize) await finalizeNativeRun({db,runId:data.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
  const work=nativeReviewResponseWork(db);
  for (const entry of await work.load({companyId:data.companyId,runId:data.runId})) await work.check(entry);
  const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,data.runId));
  const [coordinator]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,data.runId));
  const allowed=await authorizeNativeChatReviewPresentation(db,{companyId:data.companyId,issueId:data.issueId,runId:data.runId,resultJson:run.resultJson!});
  const sent = await publishPending(db,data.publicationId,true);
  console.log('JUDGE_CHILD_RESULT '+JSON.stringify({allowed,decisionId:coordinator.decisionId,phase:coordinator.phase,...sent}));
} finally { await closeRegisteredClients(url); }
