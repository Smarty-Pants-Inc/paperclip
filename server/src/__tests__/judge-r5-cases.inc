
  // Independent R5 boundary checks; keep reasons: durable authority/trust boundary,
  // plus recorded R4 lost-response incidents. No provider/credential/network I/O.
  async function withClaim(f: Awaited<ReturnType<typeof materialized>>, action: () => Promise<void>) {
    let release!:()=>void, entered!:()=>void;
    const released=new Promise<void>(r=>{release=r});
    const claimed=new Promise<void>(r=>{entered=r});
    let armed=true;
    const pausedDb=new Proxy(db,{get(target,key){
      if(key==='transaction') return async (...args:unknown[])=>{
        const result=await (target.transaction as Function).apply(target,args);
        if(armed && (await row(f.runId)).phase==='arbitrating'){armed=false;entered();await released;}
        return result;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const finishing=finalizeNativeRun({db:pausedDb,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([claimed,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new Error('claim barrier not reached')),15000)})]);
      await action();
    } finally {if(timer)clearTimeout(timer);release();await finishing;}
  }

  it.each(['active','expired','no-owner','no-holder','wrong-holder-token','old-boot'] as const)
  ('JUDGE R5 lease boundary: %s',async kind=>{
    const f=await materialized();await failure(f);await copybackSuccess(f);
    await withClaim(f,async()=>{
      const claim=await row(f.runId);
      expect(claim.phase).toBe('arbitrating');
      expect(claim.leaseOwner).toMatch(/^native-finalizer:/);
      expect(claim.leaseHolder?.token).toBe(claim.leaseOwner);
      const changed:Partial<typeof claim>={};
      if(kind==='expired') changed.leaseExpiresAt=new Date(0);
      if(kind==='no-owner') changed.leaseOwner=null;
      if(kind==='no-holder') changed.leaseHolder=null;
      if(kind==='wrong-holder-token') changed.leaseHolder={...claim.leaseHolder,token:`native-finalizer:${randomUUID()}`};
      if(kind==='old-boot') changed.leaseHolder={...claim.leaseHolder,bootId:randomUUID()};
      if(kind!=='active')await db.update(nativeRunFinalizations).set(changed).where(eq(nativeRunFinalizations.runId,f.runId));
      try {
        const allowed=await auth(f);
        const transport=await publishPending(db,f.publication.id,true);
        console.log('JUDGE_R5_LEASE',JSON.stringify({kind,allowed,transport,publicationState:(await publicationRow(f.publication.id)).state,leaseTokenMatches:kind!=='wrong-holder-token',holderChanged:kind==='old-boot'}));
        expect.soft(allowed).toBe(kind==='active');
        expect.soft(transport.errors).toEqual([]);
        expect.soft(transport.sends).toHaveLength(kind==='active'?1:0);
      }finally{
        await db.update(nativeRunFinalizations).set({leaseOwner:claim.leaseOwner,leaseExpiresAt:claim.leaseExpiresAt,leaseHolder:claim.leaseHolder}).where(eq(nativeRunFinalizations.runId,f.runId));
      }
    });
  },120000);

  async function sequenceFixture(failures:number) {
    const f=await seedRecoverableReviewResponse();const original=await row(f.runId);
    if(failures>0)await failure(f);
    const work=nativeReviewResponseWork(db);
    const [entry]=await work.load({companyId:f.companyId,runId:f.runId});
    expect(entry).toBeDefined();await Promise.all([work.check(entry),work.check(entry)]);
    const comments=await commentsFor(f.runId);expect(comments).toHaveLength(1);
    const pubs=await db.select().from(chatPublications).where(eq(chatPublications.commentId,comments[0].id));expect(pubs).toHaveLength(1);
    if(failures>1)await failure(f);
    return {...f,original,comment:comments[0],publication:pubs[0]};
  }
  const orders=[{failures:0,when:'before'},{failures:0,when:'after'},
    {failures:1,when:'before'},{failures:1,when:'during'},{failures:1,when:'after'},
    {failures:2,when:'before'},{failures:2,when:'during'},{failures:2,when:'after'}];
  it.each(orders)('JUDGE R5 exactly once: $failures failures transport $when',async({failures,when})=>{
    const f=await sequenceFixture(failures);let sends=0;
    const send=async()=>{const r=await publishPending(db,f.publication.id,true);expect(r.errors).toEqual([]);sends+=r.sends.length;};
    if(when==='before')await send();
    await copybackSuccess(f);
    if(when==='during')await withClaim(f,send);
    else await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    await send();await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});await send();
    const final=await row(f.runId),pub=await publicationRow(f.publication.id);
    const links=await db.select().from(chatMessageLinks).where(eq(chatMessageLinks.publicationId,f.publication.id));
    console.log('JUDGE_R5_ORDER',JSON.stringify({failures,when,sends,originalDecisionId:f.original.decisionId,decisionId:final.decisionId,state:pub.state,links:links.length}));
    expect.soft(sends).toBe(1);expect.soft(final.decisionId).toBe(f.original.decisionId);expect.soft(pub.state).toBe('published');
    expect.soft(links).toHaveLength(1);expect.soft(await commentsFor(f.runId)).toHaveLength(1);
  },120000);

  it.each([0,1,2])('JUDGE R5 fresh-process success after %i failures',async failures=>{
    const f=await sequenceFixture(failures);await copybackSuccess(f);
    const first=restart(f,true),second=restart(f,true);
    expect.soft(first.errors).toEqual([]);expect.soft(first.sends).toHaveLength(1);expect.soft(first.decisionId).toBe(f.original.decisionId);
    expect.soft(second.errors).toEqual([]);expect.soft(second.sends).toHaveLength(0);expect.soft(second.decisionId).toBe(f.original.decisionId);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');expect.soft(await commentsFor(f.runId)).toHaveLength(1);
  },120000);

  it.each(['run','decision','result','assessment','company','issue','other-failure','exhausted','gate-closed'] as const)
  ('JUDGE R5 retryable authority cannot be borrowed: %s',async kind=>{
    const f=await materialized();await failure(f);
    const run=await runRow(f.runId);const result=structuredClone(run.resultJson!);
    const marker=result.externalChatReviewPresentation as Record<string,unknown>;
    if(['run','decision','result','assessment'].includes(kind))marker[`${kind}Id`]=randomUUID();
    if(kind==='other-failure')result.failureCode='native_provider_failed';
    if(kind==='exhausted')result.failureCode='native_workspace_sync_out_retry_exhausted';
    if(kind==='gate-closed')await db.update(issueThreadInteractions).set({status:'accepted'}).where(eq(issueThreadInteractions.id,f.gate.id));
    const allowed=await authorizeNativeChatReviewPresentation(db,{companyId:kind==='company'?randomUUID():f.companyId,issueId:kind==='issue'?randomUUID():f.issueId,runId:f.runId,resultJson:result});
    console.log('JUDGE_R5_AUTHORITY',JSON.stringify({kind,allowed}));expect(allowed).toBe(false);
  },120000);
