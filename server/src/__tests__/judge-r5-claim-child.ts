// Fresh process takes the real durable finalizer claim, then stops before work.
// The injected throw occurs AFTER the production transaction commits.
import {createDb,closeRegisteredClients,nativeRunFinalizations} from '@paperclipai/db';
import {eq} from 'drizzle-orm';
import {finalizeNativeRun} from '../services/native-runtime/native-run-finalizer.js';
const url=process.env.JUDGE_DATABASE_URL!,runId=process.env.JUDGE_RUN_ID!;
const db=createDb(url);let stopped=false;
const interrupted=new Proxy(db,{get(target,key){
  if(key==='transaction')return async(...args:unknown[])=>{
    const result=await (target.transaction as Function).apply(target,args);
    const [row]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,runId));
    if(row?.phase==='arbitrating'){
      stopped=true;console.log('JUDGE_CLAIM_CHILD '+JSON.stringify({phase:row.phase,leaseOwner:row.leaseOwner,leaseExpiresAt:row.leaseExpiresAt,leaseHolder:row.leaseHolder}));
      throw new Error('JUDGE_STOP_AFTER_COMMITTED_CLAIM');
    }
    return result;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});
try{
  await finalizeNativeRun({db:interrupted,runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
  throw new Error('claim interruption did not happen');
}catch(error){if(!stopped || !(error instanceof Error) || error.message!=='JUDGE_STOP_AFTER_COMMITTED_CLAIM')throw error;}
finally{await closeRegisteredClients(url);}
