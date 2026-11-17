// Item 11 (artifacts/reviews/2026-11-17-not-held-price-reviews/design-note.md and the handoff's addition, cleared): the
// setting "Price reviews for stocks you don't hold". 'default' is today, byte for byte; 'levels' lets a stock not held
// start a review only by crossing a level the AI set; 'never' lets nothing about it start a price review, and an agent
// trigger on stocks not held only starts none. Holdings and every other review are unchanged. No AI call.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const NH=require('../electron/not-held.cjs');
// The price trigger harness (as tests/alert-trial.test.cjs): KIS scope, 990050 held, every session open.
function H({positions={'990050':{quantity:3}}}={}){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});a.notify=()=>{};
  a.configure({scope:'kis'});a.watchScope=()=>'s';a.held=positions;a.brokerPositions=()=>a.held;a.sessionOpen=()=>true;return {a,db};}
const brief=t=>!t?null:t.kind==='watchlist'?'watchlist:'+t.alerts.map(x=>x.kind+':'+x.symbol).join(','):t.kind+':'+t.symbol;
const watch=(a,symbol,{price=null,percent=null,direction='above',at})=>assert.equal(a.watches.set('s',{symbol,price,percent,direction,reason:'r'},{universe:[{symbol}],quotes:[{symbol,price:at}]}).status,'saved');
// The same quotes for every case: a move in a stock not held, a holding's move, a level set below then crossed, a level
// set while the price is already beyond it, and a percent watch on a stock not held.
function scenario(mode,notHeld){const {a,db}=H();a.configure({watchlistAlerts:mode,notHeldPriceReviews:notHeld});const now=Date.now();const out=[];
  const run=qs=>out.push(brief(a.priceTrigger('s',qs.map(([symbol,price])=>({symbol,price,timestamp:now})),now)));
  a.lastPrices=new Map([['471350',26240],['990050',60000],['396500',25000],['360750',25000],['091160',10000]]);
  run([['471350',27090]]);run([['990050',58000]]);
  watch(a,'396500',{price:25800,at:25000});run([['396500',25000]]);run([['396500',25900]]);
  watch(a,'360750',{price:25500,at:25600});run([['360750',25600]]);
  watch(a,'091160',{percent:1,at:10000});run([['091160',10150]]);
  const rows=db.prepare('SELECT payload FROM alert_observations ORDER BY id').all().map(r=>JSON.parse(r.payload));
  return {a,out,rows,watches:a.watches.list('s').map(({updatedAt,revision,...w})=>w)};}
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
test('the default is today\'s path: the new rule is never entered, and the results are pinned for Off, Observe and On',()=>{
  const {Automation}=require('../electron/automation.cjs');const original=Automation.prototype.priceTriggerNotHeld;let entered=0;Automation.prototype.priceTriggerNotHeld=function(...x){entered++;return original.apply(this,x);};
  try{const got=Object.fromEntries(['off','observe','on'].map(mode=>{const s=scenario(mode,'default');return [mode,{out:s.out,rows:s.rows.map(({symbols,...r})=>({...r,symbols})),watches:s.watches}];}));
    assert.equal(entered,0,'the default never enters the new rule');
    assert.deepEqual(got.off.out,['percent:471350','percent:990050',null,'price:396500','price:360750','percent:091160'],'Off: one rule for every quoted stock (today)');
    assert.deepEqual(got.on.out,[null,'percent:990050',null,'watchlist:entry-level:396500',null,'watchlist:watchlist-move:091160'],'On: today\'s selective rules (an AI-set percent on a stock not held still starts a review: what the user saw)');
    for(const s of Object.values(got))for(const r of s.rows)assert.ok(!('notHeld' in r),'no new field in a default row');
    assert.equal(sha(got),DEFAULT_PIN,'the default results, rows and watch writes');}
  finally{Automation.prototype.priceTriggerNotHeld=original;}
  const {a}=H();assert.equal(a.config.notHeldPriceReviews,'default');assert.ok(!('notHeld' in a.alertTag()),'the review records\' alert tag is unchanged');
});
const DEFAULT_PIN='035df2e04f004703';// recomputed after the fixture symbols were renamed; with the earlier symbols the current code and the electron folder at 42453c8 (before item 11) gave the same hash
test('each choice × each "Watchlist alerts" mode: holdings as before; a stock not held only by an AI level\'s crossing (levels) or not at all (never)',()=>{
  for(const mode of ['off','observe','on']){
    assert.deepEqual(scenario(mode,'levels').out,[null,'percent:990050',null,'watchlist:entry-level:396500',null,null],`levels, ${mode}: the crossing fires; a move, a level set beyond and a percent watch do not`);
    assert.deepEqual(scenario(mode,'never').out,[null,'percent:990050',null,null,null,null],`never, ${mode}: only the holding`);}
  const {a}=H();a.configure({notHeldPriceReviews:'levels'});assert.deepEqual(a.alertTag().notHeld,'levels');
});
test('under Off a stock not held earlier in the quotes does not hide a holding (detect returns its first match)',()=>{
  for(const notHeld of ['levels','never']){const {a}=H();a.configure({watchlistAlerts:'off',notHeldPriceReviews:notHeld});const now=Date.now();a.lastPrices=new Map([['471350',26240],['990050',60000]]);
    assert.equal(brief(a.priceTrigger('s',[{symbol:'471350',price:30000,timestamp:now},{symbol:'990050',price:58000,timestamp:now}],now)),'percent:990050',notHeld);}
});
test('Observe still logs both rules unfiltered, with the setting on the row',()=>{
  const s=scenario('observe','never');assert.deepEqual(s.rows[0].current.symbols,['471350'],'the current rule would have reviewed the move: logged');assert.equal(s.rows[0].notHeld,'never');
  assert.ok(s.rows.some(r=>(r.proposed?.symbols??[]).includes('396500')),'the selective rules\' crossing: logged');assert.equal(s.out[3],null,'but no review under never');
});
test('the rule follows the holding at each check: a stock bought gets the holding rule, one sold out the not-held rule',()=>{
  const {a}=H();a.configure({notHeldPriceReviews:'never'});const now=Date.now();a.lastPrices=new Map([['471350',26240],['990050',60000]]);const q=(s,p)=>[{symbol:s,price:p,timestamp:now}];
  assert.equal(a.priceTrigger('s',q('471350',27090),now),null);a.held={...a.held,'471350':{quantity:1}};assert.equal(brief(a.priceTrigger('s',q('471350',27090),now)),'percent:471350','bought: held');
  a.held={};assert.equal(a.priceTrigger('s',q('990050',58000),now),null,'sold out: not held');
});
test('paper scope off the default: the paper account\'s positions are the holdings',()=>{
  const {a}=H({positions:{}});a.configure({scope:'paper',notHeldPriceReviews:'never'});const state=a.paper.getState.bind(a.paper);a.paper.getState=()=>({...state(),account:{...state().account,positions:{'005930':{quantity:2}}}});
  const now=Date.now();a.lastPrices=new Map([['005930',100],['000660',100]]);
  assert.equal(brief(a.priceTrigger('s',[{symbol:'005930',price:110,timestamp:now}],now)),'percent:005930');assert.equal(a.priceTrigger('s',[{symbol:'000660',price:110,timestamp:now}],now),null);
});
test('the trial: the setting cannot change while a trial runs, and a trial cannot start off the default',()=>{
  const {a}=H();a.configure({watchlistAlerts:'observe',alertTrial:'on'});assert.throws(()=>a.configure({notHeldPriceReviews:'never'}),/INVALID_SETTINGS/);
  const {a:b}=H();b.configure({watchlistAlerts:'observe',notHeldPriceReviews:'levels'});assert.throws(()=>b.configure({alertTrial:'on'}),/INVALID_SETTINGS/);
  assert.throws(()=>b.configure({notHeldPriceReviews:'sometimes'}),/INVALID_SETTINGS/);
});
test('from never to levels: a crossing that happened while never fires nothing; a fresh crossing does (Off and On)',()=>{
  for(const mode of ['off','on']){const {a}=H();a.configure({watchlistAlerts:mode,notHeldPriceReviews:'never'});const now=Date.now();const q=p=>[{symbol:'396500',price:p,timestamp:now}];
    watch(a,'396500',{price:25800,at:25000});a.priceTrigger('s',q(25000),now);assert.equal(a.priceTrigger('s',q(25900),now),null,'never');
    a.configure({notHeldPriceReviews:'levels'});assert.equal(a.priceTrigger('s',q(25950),now),null,`${mode}: already beyond, no fresh crossing`);
    a.priceTrigger('s',q(25700),now);assert.equal(brief(a.priceTrigger('s',q(25900),now)),'watchlist:entry-level:396500',`${mode}: a fresh crossing`);
    assert.equal(a.watches.list('s').length,1,'the watch was kept');}
});
// The app around a review (as tests/agent-desk.test.cjs): KIS mock, 005930 held, 000660 quoted and not held.
const days=n=>Array.from({length:n},(_,i)=>new Date(Date.parse('2026-06-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));const series=(n,f)=>days(n).map((date,i)=>({date,close:f(i),value:1e9+i}));
function app(notHeld){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const quotes=()=>[{symbol:'005930',price:217000,retrievedAt:Date.now()},{symbol:'000660',price:300000,retrievedAt:Date.now()}];
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:quotes(),marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[],events=[],queue=[];const provider={request:async(op,payload)=>{supplied.push([op,payload]);const next=queue.shift();return next?next(payload):{decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,paper,provider,(id,kind,title,body)=>events.push({id,kind,title,body}));a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  a.series={closes:s=>series(40,i=>(s==='005930'?200000:290000)+i*500),ensure:async()=>{}};a.marketQuotes=()=>quotes().map(q=>({...q,timestamp:q.retrievedAt}));
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',conditionalOrders:true,...(notHeld?{notHeldPriceReviews:notHeld}:{})});
  return {a,supplied,events,queue};}
const call=(name,args,id)=>({name,callId:id,args});
const decisions=s=>s.filter(([op])=>op==='decision').map(([,p])=>p);
test('what the AI is told: the context sentence only off the default, in the planner\'s words',async()=>{
  for(const [notHeld,text] of [[null,undefined],['levels',NH.CONTEXT.levels],['never',NH.CONTEXT.never]]){const {a,supplied}=app(notHeld);await a.review();
    const ctx=decisions(supplied)[0].context;assert.equal(ctx.notHeldPriceReviews,text,String(notHeld));if(!notHeld)assert.ok(!('notHeldPriceReviews' in ctx),'no key at the default');}
  assert.equal(NH.CONTEXT.never,'The user turned off price reviews for stocks not held: no price move, no review watch (level or percent) and no review trigger whose conditions use only stocks not held starts a review. Holdings, scheduled and news reviews, and triggers that use a holding, are unchanged.');
  assert.equal(NH.CONTEXT.levels,'The user limited price reviews for stocks not held to entry levels: a price level you set with set_review_watch on a stock not held starts a review when the price crosses it; a price move or a percent watch on a stock not held does not. Review triggers are unchanged.');
});
// One review that sets watches and triggers; the tool results come back in the next request's conversation.
async function tools(notHeld){const {a,supplied,queue}=app(notHeld);
  queue.push(()=>({toolCalls:[call('set_review_watch',{symbol:'000660',percent:null,price:310000,direction:'above',reason:'entry'},'w1'),call('set_review_watch',{symbol:'000660',percent:2,price:null,direction:'above',reason:'move'},'w2'),
    call('set_review_watch',{symbol:'005930',percent:null,price:230000,direction:'above',reason:'trim'},'w3'),
    call('set_review_trigger',{action:'add',id:'',name:'Breakout',conditions:[{expr:'price("000660")',op:'>=',value:310000}],combine:'all',expiresInHours:4,reason:'r'},'t1')],continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1}}));
  // A round runs at most four tool calls: the fifth in a second round.
  queue.push(()=>({toolCalls:[call('set_review_trigger',{action:'add',id:'',name:'Pair',conditions:[{expr:'price("000660")/price("005930")',op:'>=',value:2}],combine:'all',expiresInHours:4,reason:'r'},'t2')],continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1}}));
  // Each round's results are in the request after it (the fixture's continuation starts afresh each round).
  await a.review();const out=decisions(supplied).slice(1,3).flatMap(p=>p.options.continuation.filter(o=>o.type==='function_call_output').map(o=>JSON.parse(o.output)));return {a,out};}
test('the watch and trigger results: a note only off the default and only where it will not start a review',async()=>{
  const d=(await tools(null)).out;assert.ok(d.every(r=>!('note' in r)),'no note at the default');assert.deepEqual(d.map(r=>r.status),['saved','saved','saved','saved','saved']);
  const n=(await tools('never')).out;
  assert.equal(n[0].note,'Saved, but price reviews for stocks not held are off: this watch starts no review while 000660 is not held.');assert.equal(n[1].note,n[0].note);assert.ok(!('note' in n[2]),'a held stock: no note');
  assert.equal(n[3].note,'Saved, but price reviews for stocks not held are off: this trigger starts no review while none of its stocks is held.');assert.ok(!('note' in n[4]),'a trigger that uses a holding: no note');
  const l=(await tools('levels')).out;assert.ok(!('note' in l[0]),'levels: a level works');assert.equal(l[1].note,'Saved, but for a stock not held only a price level starts a review; this percent does not while 000660 is not held.');
  assert.ok(!('note' in l[3])&&!('note' in l[4]),'levels: triggers unchanged');
});
// A met trigger, through the scheduler (tests/agent-desk.test.cjs "a met trigger starts a review").
async function tick(notHeld,conditions,held=null){const {a,supplied,events}=app(notHeld);a.configure({enabled:true});a.sessionArmed=true;a.lastRun=0;if(held)a.heldNow=()=>new Set(held);
  a.desk.setTrigger(a.watchScope(),{action:'add',id:'',name:'T',conditions,combine:'all',expiresInHours:4,reason:'r'},{universe:['005930','000660']});
  a.schedulerStatus=()=>({label:'Monitoring'});a.marketHours=()=>({open:true,markets:[],preOpen:null,next:null});a.sessionOpen=()=>true;a.tick();await new Promise(r=>setTimeout(r,30));
  return events.some(e=>e.title==='Agent trigger met')&&decisions(supplied).some(p=>p.context.triggerEvidence?.kind==='agent-trigger');}
test('agent triggers under never: one on stocks not held only starts no review; one using a holding fires; one goes live when its stock is held',async()=>{
  const notHeldOnly=[{expr:'price("000660")',op:'>=',value:1}],mixed=[{expr:'price("000660")/price("005930")',op:'>=',value:1}],heldOnly=[{expr:'price("005930")',op:'>=',value:1}];
  assert.equal(await tick(null,notHeldOnly),true,'default: fires as today');assert.equal(await tick('levels',notHeldOnly),true,'levels: triggers unchanged');
  assert.equal(await tick('never',notHeldOnly),false,'never: a trigger on stocks not held only is inert');
  assert.equal(await tick('never',mixed),true,'never: a trigger that uses a holding fires');assert.equal(await tick('never',heldOnly),true);
  assert.equal(await tick('never',notHeldOnly,['005930','000660']),true,'never: live once its stock is held');
  assert.equal(NH.triggerLive('never',[],new Set()),true,'a trigger with no stock is not affected');
});
