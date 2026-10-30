const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Waits,reasonOf,outcomes}=require('../electron/waits.cjs');const RG=require('../electron/review-gate.cjs');
const t0=Date.parse('2026-10-29T05:00:00Z'),h=n=>t0+n*3600000,iso=t=>new Date(t).toISOString();
const verdict=(symbol,condition,extra={})=>({symbol,verdict:'waiting',reason:'r',condition:{kind:'event',unresolved:'Q3 operating profit',evidence:'The results release',recheck:'After the release',...condition},dataGap:null,...extra});
const setup=()=>{let now=t0;const db=new DatabaseSync(':memory:');const w=new Waits(db,()=>now);return {w,db,at:t=>{now=t;}};};
// What a review's research showed: a section confirmed absent (or a temporary failure, or read).
// recheckMs: how long its sources keep the answer (a week here, so the wait's own timing is what these tests see).
const gone=(symbol,section,reason='NO_EARNINGS_RELEASE',sources='dart',recheckMs=7*86400000)=>({symbol,section,reason,sources,confirmed:require('../electron/waits.cjs').CONFIRMED.has(reason),recheckMs});
const readOk=(symbol,section)=>({symbol,section,read:true});
const plan={scoutPlan:{asOf:'2026-10-29T00:11:42Z',targets:[{symbol:'000270',role:'hold'},{symbol:'064350',role:'candidate'},{symbol:'NASD:GOOGL',role:'trim'}]}};

test('the reason comes from the review, else from the condition kind and data-gap cause',()=>{
  assert.equal(reasonOf(verdict('000270',{waitReason:'publication_pending'})),'publication_pending');
  assert.equal(reasonOf(verdict('000270',{kind:'data'},{dataGap:{cause:'not-yet-published'}})),'publication_pending');
  assert.equal(reasonOf(verdict('000270',{kind:'data'},{dataGap:{cause:'not-retrievable'}})),'missing_data');
  assert.equal(reasonOf(verdict('000270',{kind:'market'})),'entry_condition');assert.equal(reasonOf({verdict:'waiting',condition:{kind:'none'}}),null);
});
test('waiting for earnings tomorrow holds the release section that was unavailable, not other sections or symbols, until the release',()=>{
  // 2026-10-29: Kia's earnings were due the next day; reviews researched it again every few minutes.
  const {w,at}=setup();w.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending',earliestCheck:'2026-10-30T15:30+09:00'})]},{reviewId:'R1',context:plan,research:[gone('000270','release'),readOk('000270','valuation')]});
  for(const m of [5,10,15]){at(t0+m*60000);const held=w.guard('s','000270',{sections:['release']});assert.equal(held?.status,'waiting',`${m} minutes later`);assert.equal(held.until,'2026-10-30T06:30:00.000Z');}
  assert.equal(w.guard('s','000270',{sections:['valuation']}),null,'an unrelated section is read');assert.equal(w.guard('s','000270'),null,'a request naming no section cannot be matched: read');
  assert.equal(w.guard('s','064350',{sections:['release']}),null,'another candidate is not held');
  at(Date.parse('2026-10-30T06:31:00Z'));assert.equal(w.guard('s','000270',{sections:['release']}),null,'due: research again');
});
test('early publication, a price move or any change the gate sees about the symbol overrides the wait',()=>{
  const {w}=setup();w.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending',earliestCheck:'2026-10-30T15:30+09:00'})]},{context:plan});
  assert.equal(w.guard('s','000270',{overridden:new Set(['000270'])}),null);
  const base={...RG.decisionState({positions:{'000270':{quantity:1}},quotes:[{symbol:'000270',price:107600}]}),at:t0,seen:[]};
  const g=RG.compare(base,RG.decisionState({positions:{'000270':{quantity:1}},quotes:[{symbol:'000270',price:107600}]}),{now:h(1),config:{maxSkipMinutes:300},events:[{id:'u',kind:'disclosure',receipt:'20261029000500',title:'기아 영업(잠정)실적',symbols:['000270'],importance:'high'}],waits:w.all('s')});
  assert.deepEqual(g.changedSymbols,['000270'],'the early filing is a gate reason, which lifts the hold');
});
test('an unrelated holding’s failed stop reviews while another symbol waits',()=>{
  const {w}=setup();w.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending',earliestCheck:'2026-10-30T15:30+09:00'})]},{context:plan});
  const ctx=unprotected=>({positions:{'000270':{quantity:1},'NASD:GOOGL':{quantity:1}},quotes:[],agentDesk:{conditionalOrders:{unprotected,recent:[]}}});
  const g=RG.compare({...RG.decisionState(ctx([])),at:t0,seen:[]},RG.decisionState(ctx([{symbol:'NASD:GOOGL'}])),{now:h(1),config:{maxSkipMinutes:300},waits:w.all('s')});
  assert.equal(g.needsReview,true);assert.deepEqual(g.changedSymbols,['NASD:GOOGL']);
});
test('rewording a missing-data wait does not restart it; data the tools cannot read stops being re-read',()=>{
  const {w,at}=setup();const gap=(unresolved,earliestCheck='')=>verdict('028050',{kind:'data',waitReason:'missing_data',unresolved,earliestCheck},{dataGap:{cause:'insufficient',metric:'op'}});
  w.record('s',{planVerdicts:[gap('Project-level operating profit','2026-10-29T16:00+09:00')]},{context:plan});const first=w.active('s')[0];
  at(h(1));w.record('s',{planVerdicts:[gap('How much of Q3 operating profit repeats','2026-10-31T09:00+09:00')]},{context:plan});
  const [again]=w.active('s');assert.equal(again.id,first.id,'same symbol and reason: the same wait');assert.equal(again.reviews,2);assert.equal(again.earliestCheckAt,first.earliestCheckAt,'a later time in new words does not push it back');
  assert.equal(again.expiresAt,first.expiresAt);assert.equal(again.createdAt,t0);assert.match(again.question,/repeats/,'the wording is kept up to date');
  assert.equal(w.guard('s','028050',{sections:['financials']}),null,'nothing confirmed unavailable: nothing held');
  const {w:x}=setup();x.record('s',{planVerdicts:[verdict('028050',{kind:'data',waitReason:'missing_data'},{dataGap:{cause:'not-retrievable',otherSource:'DART viewer'}})]},{context:plan,research:[gone('028050','release','NO_RELEASE_EXHIBIT')]});
  const held=x.guard('s','028050',{sections:['release']});assert.equal(held.reason,'missing_data');assert.match(held.note,/decide under the uncertainty/);assert.deepEqual(x.active('s')[0].sources,['DART viewer']);
});
test('expired and invalidated waits are reassessed; acting or passing closes them',()=>{
  const {w,at}=setup();w.record('s',{planVerdicts:[verdict('064350',{waitReason:'entry_condition',kind:'market'})]},{context:plan});const [e]=w.active('s');assert.equal(e.expiresAt,h(48),'two days without a time');
  const base={...RG.decisionState({}),at:h(1),seen:[]};at(h(49));
  assert.equal(RG.compare(base,RG.decisionState({}),{now:h(49),config:{maxSkipMinutes:6000},waits:w.all('s')}).reasons[0].kind,'wait-expired');
  assert.equal(w.active('s').length,0);assert.equal(w.all('s')[0].status,'expired');
  const due={...RG.decisionState({}),at:t0,seen:[]};const {w:d,at:atD}=setup();d.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending',earliestCheck:iso(h(3))})]},{context:plan});
  atD(h(2));assert.equal(RG.compare(due,RG.decisionState({}),{now:h(2),config:{maxSkipMinutes:6000},waits:d.all('s')}).needsReview,false,'not yet due');
  atD(h(3));assert.equal(RG.compare(due,RG.decisionState({}),{now:h(3),config:{maxSkipMinutes:6000},waits:d.all('s')}).reasons[0].kind,'wait-due');
  assert.equal(RG.compare({...due,at:h(3)+1},RG.decisionState({}),{now:h(4),config:{maxSkipMinutes:6000},waits:d.all('s')}).needsReview,false,'once: the next decision saw it');
  const role=r=>({scoutPlan:{asOf:'later',targets:[{symbol:'000270',role:r}]}});d.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending'})]},{context:role('exit')});
  assert.equal(d.all('s').find(x=>x.status==='invalidated')?.symbol,'000270','a new thesis replaces the wait');
  d.record('s',{planVerdicts:[{symbol:'000270',verdict:'passed',reason:'r',condition:{kind:'none'}}]},{context:role('exit')});assert.equal(d.active('s').length,0,'passed: closed');
});
test('a closed market holds research until it opens; restart keeps waits',()=>{
  const {w,db}=setup();w.record('s',{planVerdicts:[verdict('NASD:GOOGL',{waitReason:'market_closed',kind:'market'})]},{context:plan});
  assert.equal(w.guard('s','NASD:GOOGL',{isOpen:m=>m!=='US'})?.until,'when its market opens');assert.equal(w.guard('s','NASD:GOOGL',{isOpen:()=>true}),null);
  const again=new Waits(db,()=>t0);assert.equal(again.active('s').length,1,'kept across a restart');assert.equal(again.active('other').length,0,'not shared between accounts');
  assert.deepEqual(Object.keys(again.context('s')[0]),['symbol','reason','question','resolvesOn','earliestCheck','expires','since','reviews','holdsResearch']);
  assert.equal(again.context('s')[0].holdsResearch,false,'observing: nothing is held');assert.equal(again.context('s',{enforced:true})[0].holdsResearch,true);
});
test('through the scheduler: research on a waiting symbol is answered with the wait when on, read and logged when observing',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({title,body}));
  const reads=[];a.discovery={research:async args=>{reads.push(args.symbol);return {status:'ok'};}};a.sessionOpen=()=>true;
  a.waits.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending',earliestCheck:new Date(Date.now()+86400000).toISOString()})]},{context:plan,research:[{...gone('000270','release'),since:Date.now()}]});
  const run=(opts,symbol='000270')=>a.researchFor({watchScope:'s',trigger:'Scheduled review',emergency:false,gate:{changedSymbols:[]},id:'R',...opts})({symbol,sections:['release']});
  assert.equal((await run({gateMode:'on'})).status,'waiting');assert.deepEqual(reads,[],'held');
  await run({gateMode:'on'},'064350');assert.deepEqual(reads,['064350'],'another symbol is read');
  await run({gateMode:'observe'});assert.equal(reads.at(-1),'000270');assert.ok(events.some(e=>e.title==='Research would wait'));
  await run({gateMode:'on',gate:{changedSymbols:['000270']}});await run({gateMode:'on',trigger:'User request'});await run({gateMode:'on',emergency:true});await run({gateMode:'off'});
  assert.equal(reads.filter(s=>s==='000270').length,5,'overridden, your request, an emergency, gate off');
  await run({gateMode:'on',gate:null});assert.equal(reads.filter(s=>s==='000270').length,6,'no gate result: nothing held');
});
test('a check that came due can be renewed when the document is still not out; one still ahead cannot be pushed back',()=>{
  const {w,at}=setup();const v=t=>verdict('000270',{waitReason:'publication_pending',earliestCheck:new Date(t).toISOString()});
  w.record('s',{planVerdicts:[v(h(3))]},{context:plan,research:[gone('000270','release')]});at(h(1));w.record('s',{planVerdicts:[v(h(10))]},{context:plan});assert.equal(w.active('s')[0].earliestCheckAt,h(3),'ahead: kept');
  at(h(4));w.record('s',{planVerdicts:[v(h(30))]},{context:plan});const [x]=w.active('s');assert.equal(x.earliestCheckAt,h(30),'due: renewed');assert.equal(x.expiresAt,h(54));
  assert.equal(w.guard('s','000270',{sections:['release']})?.status,'waiting','held again until the new time');
  at(h(31));w.record('s',{planVerdicts:[v(h(160))]},{context:plan});assert.equal(w.active('s')[0].expiresAt,t0+7*86400000,'never past a week from its start');
  at(h(161));w.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending',earliestCheck:''})]},{context:plan});assert.equal(w.active('s')[0].earliestCheckAt,h(160),'no new time: the passed one stays');assert.equal(w.guard('s','000270',{sections:['release']}),null,'and nothing is held');
});
// Review of 8ef1be1, P2: after a missing-data wait and then an entry-condition wait, an unrelated valuation request got
// the old missing-data message and no research ran.
test('review repro: an entry-condition verdict supersedes the missing-data wait, and an unrelated valuation request is read',()=>{
  const {w,at}=setup();const missing=verdict('028050',{kind:'data',waitReason:'missing_data',unresolved:'Project margins'},{dataGap:{cause:'not-retrievable',metric:'project margin'}});
  w.record('s',{planVerdicts:[missing]},{reviewId:'R1',context:plan,research:[gone('028050','release','NO_RELEASE_EXHIBIT')]});const first=w.active('s')[0];
  assert.equal(w.guard('s','028050',{sections:['valuation']}),null,'valuation was never unavailable');
  at(h(2));w.record('s',{planVerdicts:[verdict('028050',{kind:'market',waitReason:'entry_condition',unresolved:'Price back under 25,000'})]},{reviewId:'R2',context:plan});
  const all=w.all('s'),now=w.active('s');assert.equal(now.length,1,'one active wait');assert.equal(now[0].reason,'entry_condition');
  assert.equal(all.find(x=>x.id===first.id).status,'superseded');assert.match(all.find(x=>x.id===first.id).closedBy,/superseded by entry_condition in review R2/);
  assert.equal(now[0].createdAt,first.createdAt,'its start is kept');assert.equal(now[0].reviews,2,'its review count continues');assert.deepEqual(now[0].history.map(x=>[x.reason,x.reviews]),[['missing_data',1]]);assert.deepEqual(now[0].supersedes,[first.id]);
  for(const s of [['valuation'],['release'],['valuation','release']])assert.equal(w.guard('s','028050',{sections:s}),null,`entry conditions hold no research: ${s}`);
  // Flipping reasons never extends the week a wait may last.
  at(h(20));w.record('s',{planVerdicts:[missing]},{reviewId:'R3',context:plan});assert.ok(w.active('s')[0].expiresAt<=t0+7*86400000);assert.equal(w.active('s')[0].history.length,2);
});
test('a mixed request reads the available sections and names the skipped ones; other sections and tools are not held',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({title,body}));
  const asked=[];a.discovery={research:async args=>{asked.push(args.sections);return {symbol:args.symbol,provenance:Object.fromEntries(args.sections.map(s=>[s,{from:'kis'}])),...Object.fromEntries(args.sections.map(s=>[s,{ok:true}]))};}};a.sessionOpen=()=>true;
  a.waits.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending',earliestCheck:new Date(Date.now()+86400000).toISOString()})]},{context:plan,research:[gone('000270','release')]});
  const run=args=>a.researchFor({watchScope:'s',trigger:'Scheduled review',emergency:false,gate:{changedSymbols:[]},gateMode:'on',id:'R'})(args);
  const r=await run({symbol:'000270',sections:['valuation','release','analysts']});assert.deepEqual(asked.at(-1),['valuation','analysts'],'available sections read');
  assert.deepEqual(r.skippedSections.map(x=>[x.section,x.unavailable]),[['release','NO_EARNINGS_RELEASE']],'and the skipped one named with why');assert.match(r.skippedNote,/another section, tool or source/);
  assert.ok(events.some(e=>e.title==='Research waits'&&/release \(NO_EARNINGS_RELEASE\).*reading valuation, analysts/.test(e.body)));
  const only=await run({symbol:'000270',sections:['release']});assert.equal(only.status,'waiting');assert.equal(asked.length,1,'only the held section asked: nothing read');
  // The same information from another section (DART filings under events) is another source and is read.
  assert.equal(a.waits.guard('s','000270',{sections:['events']}),null);
});
test('only confirmed absences block; temporary failures and a section read later do not; one missing metric never blocks a section',()=>{
  const {w,at}=setup();const v=verdict('000270',{waitReason:'missing_data',kind:'data'},{dataGap:{cause:'not-retrievable',metric:'segment margin'}});
  w.record('s',{planVerdicts:[v]},{context:plan,research:[gone('000270','release','DART_RATE_LIMITED'),gone('000270','financials','DATA_SOURCE_UNAVAILABLE'),gone('000270','valuation','KIS_NOT_CONNECTED')]});
  assert.deepEqual(w.active('s')[0].blocked,[],'rate limits, outages and a missing connection open no block');for(const s of ['release','financials','valuation'])assert.equal(w.guard('s','000270',{sections:[s]}),null);
  // The agent's missing metric (segment margin) is not a section the tools confirmed absent: financials stay readable.
  at(h(1));w.record('s',{planVerdicts:[v]},{context:plan,research:[readOk('000270','financials'),gone('000270','peers','NO_PEERS')]});
  assert.deepEqual(w.active('s')[0].blocked.map(b=>b.section),['peers']);assert.equal(w.guard('s','000270',{sections:['financials']}),null);
  // Repeating or rewording the same gap keeps the wait, its expiry and the block; a later successful read lifts it.
  const before=w.active('s')[0];at(h(2));w.record('s',{planVerdicts:[{...v,condition:{...v.condition,unresolved:'Margins by segment, reworded'}}]},{context:plan,research:[gone('000270','peers','NO_PEERS')]});
  const again=w.active('s')[0];assert.equal(again.id,before.id);assert.equal(again.expiresAt,before.expiresAt,'original expiry kept');assert.equal(again.blocked.length,1,'the same gap is not listed twice');
  assert.equal(w.guard('s','000270',{sections:['peers']})?.status,'waiting');
  at(h(3));w.record('s',{planVerdicts:[v]},{context:plan,research:[readOk('000270','peers')]});assert.deepEqual(w.active('s')[0].blocked,[],'newly available: no longer held');
  assert.equal(w.guard('s','000270',{sections:['peers']}),null);
});
test('outcomes reads a research reply: unavailable sections with reason and sources, read sections, nothing for a failed reply',()=>{
  const TRACE=Symbol.for('fpm.research-trace');const reply={symbol:'000270',release:{unavailable:'NO_EARNINGS_RELEASE'},valuation:{per:5},provenance:{release:{from:null,cache:'unavailable'},valuation:{from:'kis',cache:'fetched'}}};
  reply[TRACE]={reads:{release:[{origin:'dart',cache:'fetched'}],valuation:[{origin:'kis',cache:'fetched'}]}};
  assert.deepEqual(outcomes({symbol:'000270'},reply),[{symbol:'000270',section:'release',reason:'NO_EARNINGS_RELEASE',sources:'dart',confirmed:true,recheckMs:3600000},{symbol:'000270',section:'valuation',read:true}]);
  assert.deepEqual(outcomes({symbol:'X'},{status:'unavailable',reason:'UNKNOWN_SYMBOL'}),[],'no sections: nothing recorded, nothing held');assert.deepEqual(outcomes({},null),[]);
});
// Edge case: a block cleared only through a later waiting verdict for its symbol, so a section read successfully in a
// review that decided something else stayed held until the wait's check.
test('a block clears as soon as its section is read, whatever the review decides; it allows a re-read once its source can have changed',()=>{
  const {w,at}=setup();const v=verdict('000270',{waitReason:'publication_pending',earliestCheck:'2026-10-31T09:00+09:00'});
  w.record('s',{planVerdicts:[v]},{context:plan,research:[gone('000270','release','NO_EARNINGS_RELEASE','OpenDART',12*3600000),gone('000270','peers','NO_PEERS','KIS',7*86400000)]});
  assert.equal(w.guard('s','000270',{sections:['release']})?.status,'waiting');
  // Another review (its verdict is about another symbol) reads the release: available now, so the block goes at once.
  at(h(1));w.available('s',[{symbol:'000270',section:'release',read:true},{symbol:'064350',section:'peers',read:true}]);
  assert.equal(w.guard('s','000270',{sections:['release']}),null,'cleared by the successful read');assert.equal(w.guard('s','000270',{sections:['peers']})?.status,'waiting','another section stays held');
  assert.ok(w.active('s')[0].lastAvailableAt,'when it became available is kept');
  w.available('s',[{symbol:'000270',section:'release',reason:'NO_EARNINGS_RELEASE',confirmed:true}]);assert.equal(w.active('s')[0].blocked.length,1,'an absence alone changes nothing here');
  // A block ends when its source's answer can have changed (OpenDART keeps it 12 hours), before the wait's own check.
  const {w:x,at:t}=setup();x.record('s',{planVerdicts:[v]},{context:plan,research:[gone('000270','release','NO_EARNINGS_RELEASE','OpenDART',12*3600000)]});
  t(h(11));assert.equal(x.guard('s','000270',{sections:['release']})?.until,iso(h(12)),'held until the source can answer differently');
  t(h(12));assert.equal(x.guard('s','000270',{sections:['release']}),null,'one re-read allowed');
  // Still absent on the re-read: confirmed again, held for another period from now (not listed twice).
  x.record('s',{planVerdicts:[v]},{context:plan,research:[gone('000270','release','NO_EARNINGS_RELEASE','OpenDART',12*3600000)]});
  assert.equal(x.active('s')[0].blocked.length,1);assert.equal(x.guard('s','000270',{sections:['release']})?.until,iso(h(24)));
});
test('through researchFor: a successful read in any review clears the block for the next request',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});a.sessionOpen=()=>true;let published=false;const asked=[];
  a.discovery={research:async args=>{asked.push(args.sections.join(','));return {symbol:args.symbol,provenance:{release:{from:published?'OpenDART':null}},release:published?{revenue:1}:{unavailable:'NO_EARNINGS_RELEASE'}};}};
  a.waits.record('s',{planVerdicts:[verdict('000270',{waitReason:'publication_pending',earliestCheck:new Date(Date.now()+86400000).toISOString()})]},{context:plan,research:[gone('000270','release')]});
  const run=(opts={})=>a.researchFor({watchScope:'s',trigger:'Scheduled review',emergency:false,gate:{changedSymbols:[]},gateMode:'on',id:'R',...opts})({symbol:'000270',sections:['release']});
  assert.equal((await run()).status,'waiting');assert.equal(asked.length,0);
  // A filing lifts the hold for one review (the gate saw a change); the release is out and read.
  published=true;await run({gate:{changedSymbols:['000270']},id:'R2'});assert.equal(asked.length,1);
  const next=await run({id:'R3'});assert.deepEqual(next.release,{revenue:1},'the next review reads it: no longer held');assert.equal(asked.length,2);
});
