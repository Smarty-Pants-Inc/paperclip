
  const row = async (runId: string) => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0];
  const runRow = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId)))[0];
  const commentsFor = (runId: string) => db.select().from(issueComments).where(eq(issueComments.createdByRunId,runId));
  async function failure(f: Awaited<ReturnType<typeof seedRecoverableReviewResponse>>, permanent=false) {
    return recordNativeFinalizationFailure({db,runId:f.runId,error:new Error(permanent?'native_workspace_sync_out_unrecoverable':'native_workspace_sync_out_failed'),failureScope:'workspace',projectRunStatus:true,permanent});
  }
  async function materialized() {
    const f = await seedRecoverableReviewResponse();
    const original = await row(f.runId);
    await failure(f);
    const work=nativeReviewResponseWork(db);
    const [entry]=await work.load({companyId:f.companyId,runId:f.runId});
    expect(entry).toBeDefined();
    await Promise.all([work.check(entry),work.check(entry)]);
    const comments=await commentsFor(f.runId);
    expect(comments).toHaveLength(1);
    const pubs=await db.select().from(chatPublications).where(eq(chatPublications.commentId,comments[0].id));
    expect(pubs).toHaveLength(1);
    return {...f,original,comment:comments[0],publication:pubs[0]};
  }
  async function copybackSuccess(f: Awaited<ReturnType<typeof materialized>>) {
    await db.insert(workspaceOperations).values({companyId:f.companyId,issueId:f.issueId,heartbeatRunId:f.runId,phase:'workspace_finalize',status:'succeeded'});
  }
  const publicationRow=async (id:string)=>(await db.select().from(chatPublications).where(eq(chatPublications.id,id)))[0];
  async function auth(f: Awaited<ReturnType<typeof materialized>>) {
    return authorizeNativeChatReviewPresentation(db,{companyId:f.companyId,issueId:f.issueId,runId:f.runId,resultJson:(await runRow(f.runId)).resultJson!});
  }
  function restart(f: Awaited<ReturnType<typeof materialized>>, finalize=false) {
    const p=spawnSync(process.execPath,['--import',path.join(process.cwd(),'server/node_modules/tsx/dist/loader.mjs'),path.join(process.cwd(),'server/src/__tests__/judge-r4-child.ts')], {
      cwd:process.cwd(),env:{...process.env,JUDGE_DATABASE_URL:externalTestDatabaseUrl ?? temporary!.connectionString,
        JUDGE_INPUT:JSON.stringify({companyId:f.companyId,issueId:f.issueId,runId:f.runId,publicationId:f.publication.id,finalize})},
      encoding:'utf8',timeout:60000,
    });
    expect(p.status, p.stderr).toBe(0);
    const line=p.stdout.split('\n').find(l=>l.startsWith('JUDGE_CHILD_RESULT '));
    expect(line,p.stdout).toBeDefined();
    const result=JSON.parse(line!.slice('JUDGE_CHILD_RESULT '.length));
    console.log('JUDGE_RESTART',JSON.stringify(result));
    return result;
  }

  it('JUDGE R4: actual transport sends once during second failure and preserves original decision after success',async()=>{
    const f=await materialized();
    await failure(f);
    expect.soft(await auth(f)).toBe(true);
    const result=await publishPending(db,f.publication.id,true);
    const sentRow=await publicationRow(f.publication.id);
    console.log('JUDGE_SECOND_FAILURE_TRANSPORT',JSON.stringify({result,state:sentRow.state,decisionId:(await row(f.runId)).decisionId,originalDecisionId:f.original.decisionId}));
    expect.soft(result.errors).toEqual([]);
    expect.soft(result.sends).toHaveLength(1);
    expect.soft(sentRow.state).toBe('published');
    await copybackSuccess(f);
    await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    expect.soft((await row(f.runId)).decisionId).toBe(f.original.decisionId);
    expect.soft(await auth(f)).toBe(true);
    const restarted=restart(f);
    expect.soft(restarted.sends).toHaveLength(0);
    expect.soft(restarted.errors).toEqual([]);
    expect.soft(restarted.decisionId).toBe(f.original.decisionId);
    expect.soft(await commentsFor(f.runId)).toHaveLength(1);
    const links=await db.select().from(chatMessageLinks).where(eq(chatMessageLinks.publicationId,f.publication.id));
    expect.soft(links).toHaveLength(1);
  },120000);

  it('JUDGE R4: restart between second failure and success publishes original queued reply once',async()=>{
    const f=await materialized(); await failure(f); await copybackSuccess(f);
    const first=restart(f,true);
    expect.soft(first.errors).toEqual([]); expect.soft(first.sends).toHaveLength(1);
    expect.soft(first.allowed).toBe(true); expect.soft(first.decisionId).toBe(f.original.decisionId);
    const second=restart(f,true);
    expect.soft(second.sends).toHaveLength(0); expect.soft(second.errors).toEqual([]);
    expect.soft(second.decisionId).toBe(f.original.decisionId);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');
    expect.soft(await commentsFor(f.runId)).toHaveLength(1);
    const publications=await db.select().from(chatPublications).where(eq(chatPublications.commentId,f.comment.id));
    expect.soft(publications).toHaveLength(1);
  },120000);

  it('JUDGE R4: first retry succeeds after response materialization without changing saved reply identity',async()=>{
    const f=await materialized();
    await copybackSuccess(f);
    const before=await runRow(f.runId);
    await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    const after=await row(f.runId);
    const transport=await publishPending(db,f.publication.id);
    console.log('JUDGE_FIRST_RETRY_SUCCESS',JSON.stringify({beforePhase:before.resultJson?.finalizationPhase,originalDecisionId:f.original.decisionId,decisionId:after.decisionId,transport,publicationState:(await publicationRow(f.publication.id)).state}));
    expect.soft(after.decisionId).toBe(f.original.decisionId);
    expect.soft(await auth(f)).toBe(true);
    expect.soft(transport.errors).toEqual([]);
    expect.soft(transport.sends).toHaveLength(1);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');
  },120000);

  it('JUDGE R4: transport racing the committed retry claim must not cancel the saved reply',async()=>{
    const f=await materialized(); await failure(f); await copybackSuccess(f);
    let release!:()=>void; let entered!:()=>void;
    const released=new Promise<void>(r=>{release=r;});
    const claimed=new Promise<void>(r=>{entered=r;});
    let armed=true;
    const pausedDb=new Proxy(db,{get(target,key){
      if(key==='transaction') return async (...args: unknown[])=>{
        const result=await (target.transaction as Function).apply(target,args);
        if(armed && (await row(f.runId)).phase==='arbitrating') {armed=false;entered();await released;}
        return result;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const finishing=finalizeNativeRun({db:pausedDb,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    let transport:Awaited<ReturnType<typeof publishPending>>|undefined;
    let during:string|undefined;
    try {
      await claimed;
      expect((await row(f.runId)).phase).toBe('arbitrating');
      transport=await publishPending(db,f.publication.id);
      during=(await publicationRow(f.publication.id)).state;
    } finally {release();await finishing;}
    const after=await publishPending(db,f.publication.id);
    console.log('JUDGE_SUCCESS_CLAIM_RACE',JSON.stringify({transport,during,after,finalState:(await publicationRow(f.publication.id)).state,originalDecisionId:f.original.decisionId,decisionId:(await row(f.runId)).decisionId,authorizedAfter:await auth(f)}));
    expect.soft(during).not.toBe('cancelled');
    expect.soft((await row(f.runId)).decisionId).toBe(f.original.decisionId);
    expect.soft((transport?.sends.length??0)+after.sends.length).toBe(1);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');
  },120000);

  it.each(['exhausted','permanent'] as const)('JUDGE R4: %s copyback failure blocks saved-answer transport and stages a truthful note',async kind=>{
    const f=await materialized();
    if(kind==='exhausted'){await failure(f);await failure(f);}else await failure(f,true);
    const final=await row(f.runId);
    expect.soft(final.phase).toBe('terminal_failure');
    expect.soft(await auth(f)).toBe(false);
    const transport=await publishPending(db,f.publication.id);
    expect.soft(transport.errors).toEqual([]); expect.soft(transport.sends).toHaveLength(0);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('cancelled');
    const notes=await db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issueId),eq(issueComments.authorType,'system')));
    console.log('JUDGE_TERMINAL_FAILURE',JSON.stringify({kind,phase:final.phase,code:final.failureCode,runStatus:(await runRow(f.runId)).status,notes:notes.map(n=>({body:n.body,runId:n.createdByRunId}))}));
    if(kind==='exhausted') {
      const notice=notes.find(n=>n.body.includes('Workspace copy-back was lost'));
      expect.soft(notice).toBeDefined();
      expect.soft(notice?.body).toContain('is being stopped');
      expect.soft(notice?.body).toContain('3 failed attempts');
      if(notice) {
        const pubs=await db.select().from(chatPublications).where(eq(chatPublications.commentId,notice.id));
        console.log('JUDGE_FAILURE_NOTE_PUBLICATIONS',JSON.stringify(pubs.map(p=>({id:p.id,state:p.state}))));
        // A truthful saved comment must not itself become unsendable solely due to the originating run failure.
        for(const pub of pubs) {
          const delivered=await publishPending(db,pub.id);
          console.log('JUDGE_FAILURE_NOTE_TRANSPORT',JSON.stringify({delivered,state:(await publicationRow(pub.id)).state}));
          expect.soft(delivered.errors).toEqual([]);
          expect.soft(delivered.sends).toHaveLength(1);
          expect.soft((await publicationRow(pub.id)).state).toBe('published');
        }
      }
    } else {
      expect.soft((await runRow(f.runId)).error).toMatch(/workspace|export|copy.?back/i);
    }
    const {enqueueChatRunLifecycleMilestones}=await import('../services/chat-run-publications.js');
    await enqueueChatRunLifecycleMilestones(db,{scope:{companyId:f.companyId,issueId:f.issueId}});
    const milestone=await db.select().from(chatPublications).where(eq(chatPublications.idempotencyKey,`run:${f.runId}:failed:${f.endpointId}`));
    expect.soft(milestone).toHaveLength(1);
    if(milestone[0]) {
      const delivered=await publishPending(db,milestone[0].id);
      console.log('JUDGE_TERMINAL_PERSON_NOTICE',JSON.stringify({kind,delivered,state:(await publicationRow(milestone[0].id)).state}));
      expect.soft(delivered.errors).toEqual([]);
      expect.soft(delivered.sends).toHaveLength(1);
      expect.soft(delivered.sends[0]).toMatch(/stopped before completing/);
      expect.soft(delivered.sends[0]).not.toMatch(/files (?:are|were) saved/);
      expect.soft((await publicationRow(milestone[0].id)).state).toBe('published');
    }
  },120000);
