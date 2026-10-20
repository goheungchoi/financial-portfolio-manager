const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const R=require('../electron/replay.cjs');
const days=(n,start='2026-10-01')=>Array.from({length:n},(_,i)=>new Date(Date.parse(start+'T00:00:00Z')+i*86400000).toISOString().slice(0,10));
test('the variant only appends instructions or removes chosen sections',()=>{
  const ctx={userGuidelines:'Grow.',marketNarrative:{x:1},similarEpisodes:[1],marketRegime:{},positionSizing:{},universe:[]};
  const v=R.applyVariant(ctx,{instructions:'No chips in risk-off.',withoutNarrative:true});assert.match(v.userGuidelines,/Grow\.\n\nReplay variant instructions: No chips in risk-off\./);assert.equal(v.marketNarrative,undefined);assert.equal(v.similarEpisodes,undefined);assert.ok(v.marketRegime);
  assert.ok(ctx.marketNarrative,'the saved context is not modified');assert.equal(R.applyVariant(ctx,{withoutRegime:true}).positionSizing,undefined);
});
test('outcomes are signed excess returns over five trading days; Hold scores zero',()=>{
  const d=days(10);const closes=d.map((date,i)=>({date,close:100+i*2})),bench=d.map((date,i)=>({date,close:1000+i*10}));
  assert.equal(R.outcome({action:'Buy',symbol:'A'},'2026-10-01',closes,bench).excessPct,5);assert.equal(R.outcome({action:'Sell',symbol:'A'},'2026-10-01',closes,bench).excessPct,-5);
  assert.equal(R.outcome({action:'Hold'},'2026-10-01',[],[]).excessPct,0);assert.equal(R.outcome({action:'Buy',symbol:'A'},'2026-10-08',closes,bench).excessPct,null,'not enough days yet');
});
test('candidates prefer saved contexts and fall back to parseable logged ones',()=>{
  const store=new R.ReplayStore(new DatabaseSync(':memory:'));store.saveContext('r1',{universe:[{symbol:'A'}]});
  const t=Date.parse('2026-10-15T01:00:00Z');const reviews=[{id:'r1',timestamp:t,provider:'openai'},{id:'r2',timestamp:t,provider:'openai'},{id:'r3',timestamp:t,provider:'local'},{id:'r4',timestamp:t,provider:'openai'}];
  const events=[{runId:'r2',title:'Supplied context',body:JSON.stringify({universe:[]})},{runId:'r4',title:'Supplied context',body:'{truncated'}];
  const c=R.candidates({reviews,store,events,from:'2026-10-10',to:'2026-10-20',limit:5});assert.deepEqual(c.map(x=>[x.review.id,x.approximate]),[['r1',false],['r2',true]]);
  assert.equal(R.candidates({reviews,store,events,from:'2026-10-16',limit:5}).length,0);
});
test('a replay runs baseline and variant per review, meters both calls and saves the run',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot}));const calls=[];
  const hold={action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'};
  const provider={request:async(op,payload)=>{calls.push(payload);const variant=/Replay variant/.test(payload.context.userGuidelines??'');return {decision:variant?{action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'Buy.'}:hold,usage:{inputTokens:10,outputTokens:2},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  const d=days(30,'2026-09-25');a.series={closes:()=>d.map((date,i)=>({date,close:100+i})),ensure:async()=>{}};a.indexCloses=()=>({KOSPI:d.map((date)=>({date,close:1000}))});
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',guidelines:'Grow.'});
  await a.review();const reviewId=a.getState().reviews[0].id;assert.ok(a.replays.context(reviewId),'the review saved the context it sent');
  await assert.rejects(a.replay({}),/REPLAY_NO_CHANGE/);
  const before=calls.length;const run=await a.replay({instructions:'Buy Samsung on any dip.',limit:3});
  assert.equal(calls.length-before,2,'baseline and variant');assert.equal(calls.at(-1).options.research,false,'no tools in a replay');
  assert.equal(run.rows.length,1);assert.equal(run.rows[0].baseline.decision.action,'Hold');assert.equal(run.rows[0].variant.decision.action,'Buy');assert.equal(run.rows[0].changed,true);
  assert.equal(run.summary.changed,1);assert.equal(a.replays.runs()[0].id,run.id);
  const usage=db.prepare('SELECT calls FROM ai_usage').get();assert.equal(usage.calls,3,'one review call and two replay calls are metered');
});
test('a model change runs the variant on another model and records tokens for each side',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot}));const calls=[];
  const provider={request:async(op,payload)=>{calls.push(payload);return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold on '+payload.options.openaiModel,planVerdicts:[{symbol:'005930',verdict:'waiting',reason:'r'}]},usage:{inputTokens:payload.options.openaiModel==='gpt-6-luna'?100:200,outputTokens:5},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',guidelines:'Grow.'});await a.review();
  await assert.rejects(a.replay({model:{openaiModel:'gpt-6-sol',reasoningEffort:'medium'}}),/REPLAY_NO_CHANGE/,'the same model is no change');
  await assert.rejects(a.replay({model:{openaiModel:'gpt-6-astra',reasoningEffort:'none'}}),/INVALID_MODEL_SETTINGS/);
  const before=calls.length;const run=await a.replay({model:{openaiModel:'gpt-6-luna',reasoningEffort:'none'},limit:3});
  const [base,variant]=calls.slice(before).map(c=>c.options);assert.deepEqual([base.openaiModel,base.reasoningEffort],['gpt-6-sol','medium']);assert.deepEqual([variant.openaiModel,variant.reasoningEffort],['gpt-6-luna','none']);
  assert.equal(calls.at(-1).context.userGuidelines,'Grow.','a model change leaves the context untouched');
  const row=run.rows[0];assert.equal(row.variant.usage.model,'gpt-6-luna');assert.equal(row.variant.usage.inputTokens,100);assert.equal(row.baseline.usage.inputTokens,200);assert.equal(row.variant.verdicts[0].verdict,'waiting');assert.match(row.variant.explanation,/gpt-6-luna/);
  assert.deepEqual(run.variant.model,{openaiModel:'gpt-6-luna',reasoningEffort:'none'});
});
