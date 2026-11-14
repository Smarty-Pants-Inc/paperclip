// Independent R7 process; only the disposable test database is used.
import { sql, eq } from 'drizzle-orm';
import { createDb, environmentLeases, controllerInstances } from '@paperclipai/db';
import { currentControllerBootId, currentControllerProcessStamp, currentProcessSpaceHash } from '../controller-process-identity.js';
import { registerControllerInstanceLeaseWork, tickControllerInstanceLease } from '../controller-instance-lease.js';
import { withEnvironmentLeaseController } from '../environment-lease-controller.js';
import type { createDeliveryWorkCoordinator } from '../delivery-work-coordinator.js';
const db=createDb(process.env.RFL_TEST_DB!);const lost:string[]=[];let wakes=0;
const coordinator={register:()=>({ready:Promise.resolve(),wake:()=>{wakes++},stop:async()=>{}})} as unknown as ReturnType<typeof createDeliveryWorkCoordinator>;
const work=registerControllerInstanceLeaseWork(db,coordinator,{onLost:r=>lost.push(r)});
const deadline=setTimeout(()=>process.exit(97),45000);
let release:(()=>void)|undefined,transaction:Promise<void>|undefined;
let companyId='',leaseId='';
process.on('message',async(m:{action:string;companyId?:string;leaseId?:string})=>{
 try{
  if(m.action==='hold'){
   const gate=new Promise<void>(r=>{release=r});
   transaction=db.transaction(async tx=>{
    await tx.execute(sql`set local statement_timeout='5s'`);
    await tx.select().from(controllerInstances).where(eq(controllerInstances.bootId,currentControllerBootId())).for('share');
    const [session]=await tx.execute(sql`select pg_backend_pid() as pid, current_setting('transaction_isolation') as isolation`);
    process.send?.({kind:'held',backendPid:session!.pid,isolation:session!.isolation});await gate;
    await tx.insert(environmentLeases).values({id:leaseId,companyId,heartbeatRunId:null,status:'active',leasePolicy:'ephemeral',
      provider:'fake',providerLeaseId:`judge://${leaseId}`,updatedAt:sql`clock_timestamp()`,metadata:withEnvironmentLeaseController(null)});
   });
  }else if(m.action==='own'){
   companyId=m.companyId!;leaseId=m.leaseId!;release!();await transaction;
   const [owned]=await db.select({updatedAt:environmentLeases.updatedAt}).from(environmentLeases).where(eq(environmentLeases.id,leaseId));
   process.send?.({kind:'owned',updatedAt:owned!.updatedAt.toISOString(),wakes,lost});
  }else if(m.action==='renew'){
   currentControllerProcessStamp();await tickControllerInstanceLease();process.send?.({kind:'renewed',wakes,lost});
  }else if(m.action==='quit'){
   release?.();await transaction?.catch(()=>{});clearTimeout(deadline);await work.stop();await db.$client.end({timeout:1});process.exit(0);
  }
 }catch(e){process.send?.({kind:'error',message:e instanceof Error?e.message:String(e)})}
});
process.send?.({kind:'ready',bootId:currentControllerBootId(),pid:process.pid,processSpace:currentProcessSpaceHash()});
