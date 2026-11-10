// Hotfix 2026-11-10 23:32 KST (artifacts/reviews/2026-11-10-complexity-crash): every automatic review failed with
// REVIEW_FAILED at complexity.cjs:51. The last completed review's stored context, used as the routing baseline, had its
// news shortened to {reference, incomplete, items, focusRows}, and .map threw. The assessment now reads every list in
// both shapes, and an assessment error can no longer fail a review.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const C=require('../electron/complexity.cjs');
const now=Date.parse('2026-11-10T14:30:00Z'),today=new Date(now+9*3600000).toISOString().slice(0,10);
// A shortened section as review-context.cjs writes it: items is a count, focusRows the rows kept.
const short=rowsKept=>({reference:'Shortened to fit the request; the full section: get_context_detail section x.',incomplete:true,items:rowsKept.length+7,focusRows:rowsKept,otherSymbols:['000660']});
const news=[{title:'Samsung guidance cut',importance:'high'},{title:'Market wrap',importance:'low'}];
const base={environment:'kis-mock',market:'KR',currency:'KRW',equity:10000000,executionEnabled:true,marketSession:{open:true},positions:{'005930':{quantity:10}},
  quotes:[{symbol:'005930',price:70000,changePct:3.2}],universe:[{symbol:'005930'},{symbol:'000660'}],
  eventCalendar:[{date:today,kind:'earnings',symbol:'005930',title:'Earnings'},{date:today,kind:'macro',title:'FOMC decision'}],
  scoutPlan:{targets:[{symbol:'000660',role:'add',targetWeightPct:40}]},positionSizing:{rows:[{symbol:'000660',maxShares:5,maxWeightPct:10}]},
  marketRegime:{regime:'risk-off',components:[{name:'KOSPI advancers %',value:15},{name:'VIX 5-day change %',value:25}]},macro:{indicators:[{name:'USD/KRW',value:1380}]},news};
const baseline={...base,quotes:[{symbol:'005930',price:66000}],marketRegime:{regime:'neutral',components:[{name:'KOSPI advancers %',value:50}]},news:[{title:'Market wrap',importance:'low'}]};
const prev={decision:{planVerdicts:[{symbol:'000660',verdict:'passed'}],plan:{confidence:'low'},complexity:{score:40}},routing:{model:'gpt-6-sol'}};

test('the incident: shortened news in the baseline and in the context; no throw, the same score as the equivalent lists',()=>{
  const plain=C.assess(base,{baseline,previousReview:prev,now});assert.ok(plain.groups.news>0,'the fixture has fresh important news');
  const shortened=C.assess({...base,news:short(news)},{baseline:{...baseline,news:short(baseline.news)},previousReview:prev,now});
  assert.deepEqual(shortened,plain);
  // The exact shape from the live record: items a count and no focus rows. Nothing is known, so nothing is fresh.
  const bare={reference:'Shortened to fit the request; the full section: get_context_detail section news.',incomplete:true,items:42};
  assert.doesNotThrow(()=>C.assess({...base,news:bare},{baseline:{...baseline,news:bare},now}));assert.equal(C.assess({...base,news:bare},{baseline:{...baseline,news:bare},now}).groups.news,0);
});
test('every list the assessment reads takes both shapes and ignores anything else',()=>{
  const plain=C.assess(base,{baseline,previousReview:prev,now});
  const variants={
    eventCalendar:c=>({...c,eventCalendar:short(c.eventCalendar)}),
    universe:c=>({...c,universe:short(c.universe)}),
    quotes:c=>({...c,quotes:short(c.quotes)}),
    scoutTargets:c=>({...c,scoutPlan:{...c.scoutPlan,targets:short(c.scoutPlan.targets)}}),
    sizingRows:c=>({...c,positionSizing:{...c.positionSizing,rows:short(c.positionSizing.rows)}}),
    regimeComponents:c=>({...c,marketRegime:{...c.marketRegime,components:short(c.marketRegime.components)}}),
    macroIndicators:c=>({...c,macro:{indicators:short(c.macro.indicators)}}),
  };
  for(const [name,f] of Object.entries(variants)){assert.deepEqual(C.assess(f(base),{baseline:f(baseline),previousReview:prev,now}),plain,name);}
  assert.deepEqual(C.assess(base,{baseline,previousReview:{...prev,decision:{...prev.decision,planVerdicts:short(prev.decision.planVerdicts)}},now}),plain,'previous verdicts');
  // Garbage in any list: no throw.
  for(const junk of [null,undefined,'text',42,{},{focusRows:'x'},[null,7,'s']])for(const key of ['news','eventCalendar','universe','quotes'])
    assert.doesNotThrow(()=>C.assess({...base,[key]:junk,scoutPlan:{targets:junk},positionSizing:{rows:junk},marketRegime:{components:junk},macro:{indicators:junk}},{baseline:{...baseline,[key]:junk},previousReview:{decision:{planVerdicts:junk}},now}),`${key}=${JSON.stringify(junk)}`);
  assert.deepEqual(C.rows([1]),[1]);assert.deepEqual(C.rows({items:3}),[]);assert.deepEqual(C.rows({focusRows:[2]}),[2]);assert.deepEqual(C.rows('x'),[]);
  assert.doesNotThrow(()=>C.triage({action:'Hold',planVerdicts:short([{symbol:'a',verdict:'passed'}])},{action:'Hold',planVerdicts:'x'}));
});
// Automation on the mock live engine, shadow evaluation on (as live), a fixed decision provider.
function harness({previousContext=null}={}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const calls=[];const provider={request:async(op,payload)=>{calls.push(op);if(op!=='decision')throw new Error('PROVIDER_REQUEST_FAILED');return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai',model:'gpt-6-sol'};}};
  const logs=[];const a=new Automation(db,paper,provider,(id,kind,title,body)=>logs.push({title,body}));a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({status:'ok'})};
  a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:false,shadowEvaluation:true,shadowPct:100});
  if(previousContext){db.prepare('INSERT INTO reviews VALUES(?,?)').run('351a1039',JSON.stringify({id:'351a1039',timestamp:Date.now()-60000,provider:'openai',model:'gpt-6-sol',account:a.accountTag?.()??null,decision:{action:'Hold',symbol:'',quantity:0}}));a.replays.context=id=>id==='351a1039'?previousContext:null;}
  return {a,db,calls,logs};
}
test('a review whose baseline has shortened news completes, with an assessment (the live failure, end to end)',async()=>{
  const {a,logs}=harness({previousContext:{...base,news:{reference:'Shortened to fit the request; the full section: get_context_detail section news.',incomplete:true,items:12}}});
  const C2=require('../electron/complexity.cjs');const seen=[];const orig=C2.assess;C2.assess=(...x)=>{const r=orig(...x);seen.push(Boolean(x[1]?.baseline));return r;};
  try{await a.review('Scheduled review');}finally{C2.assess=orig;}
  assert.equal(a.lastError,null,a.lastErrorDetail);assert.ok(seen.includes(true),'assessed against the shortened baseline');assert.ok(!logs.some(l=>l.title==='Routing assessment skipped'));
});
test('an assessment that throws never fails the review: the configured model runs, no shadow pair, one log line without data',async()=>{
  const {a,db,calls,logs}=harness();const C2=require('../electron/complexity.cjs');const orig=C2.assess;C2.assess=()=>{throw new TypeError('secret detail 005930');};
  try{await a.review('Scheduled review');}finally{C2.assess=orig;}
  assert.equal(a.lastError,null,a.lastErrorDetail);assert.equal(calls.filter(c=>c==='decision').length,1,'one decision on the configured model, no shadow call');
  await (a.shadowTask??Promise.resolve());assert.equal(db.prepare('SELECT COUNT(*) n FROM routing_eval').get().n,0,'no shadow pair');
  const line=logs.find(l=>l.title==='Routing assessment skipped');assert.ok(line,'logged');assert.match(line.body,/^TypeError( at [A-Za-z0-9_-]+\.cjs:\d+)?: this review runs on the configured model with no shadow comparison\.$/);assert.ok(!line.body.includes('secret')&&!line.body.includes('005930'),'no data in the line');
  const row=JSON.parse(db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get().payload);assert.equal(row.decision.action,'Hold');assert.ok(!row.routing||row.routing.tier!=='routine');
});
