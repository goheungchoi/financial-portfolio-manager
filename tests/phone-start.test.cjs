// Phone control P4 (artifacts/reviews/2026-11-25-phone-control): Start from the phone in two steps. The summary holds the
// desktop's launch token; the button and the PIN lead to auto-launch.cjs start(automation, token), the desktop Start's own
// function, with its refusals in its own words. Made-up ids and values; paper practice; no network.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const C=require('../electron/phone-commands.cjs');const L=require('../electron/auto-launch.cjs');
const {PhoneService}=require('../electron/phone-service.cjs');const {PhoneCore}=require('../electron/phone-core.cjs');
const allow={application:'100000000000000004',server:'100000000000000002',channel:'100000000000000003',user:'100000000000000001'};
const PIN='482913';

function paperAutomation(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});a.configure({provider:'local'});return a;}
// The real core and service, a stand-in worker; everything the service posts is kept, and the listener is driven as the
// worker would drive it.
function rig(a=paperAutomation(),{launch=L}={}){const db=new DatabaseSync(':memory:');let now=1795600000000;const sent=[],lines=[],alerts=[];let handlers={};
  const svc=new PhoneService({makeCore:al=>new PhoneCore(db,{allow:al,clock:()=>now}),spawn:()=>({postMessage:m=>sent.push(m),on:(e,fn)=>{handlers[e]=fn;},kill(){}}),clock:()=>now,
    log:(t,b)=>lines.push([t,b]),notify:(t,c)=>alerts.push([t,c]),executor:C.createExecutor({automation:a,launch})});svc.start('p','s');
  let seq=0n;const idAt=ms=>String(((BigInt(ms)-1420070400000n)<<22n)|(seq++));
  const base=()=>({id:idAt(now),applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user});
  const tick=()=>new Promise(r=>setImmediate(r));let refN=0;const ref=()=>(refN++).toString(16).padStart(24,'0');
  const emit=async x=>{handlers.message({type:'interaction',ref:ref(),interaction:x});for(let i=0;i<4;i++)await tick();return sent.at(-1);};
  const ready=async()=>{handlers.message({type:'state',state:'keys-ok',allow});await tick();svc.core.setPin(PIN);};
  return {a,svc,sent,lines,alerts,emit,ready,
    slash:(command,options=[])=>emit({...base(),type:2,command,options}),
    confirm:nonce=>emit({...base(),type:3,customId:'start-confirm:'+nonce}),
    pin:(nonce,pin=PIN)=>emit({...base(),type:5,customId:'pin:'+nonce,pin})};}

test('the whole path through the listener: /start, the summary, the button, the PIN form, started; one alert',async()=>{
  const r=rig();await r.ready();
  const s=await r.slash('start');assert.equal(s.kind,'summary');assert.match(s.text,/^Start auto trading\?\nAccount: PAPER · Paper\.\nTrading model: Local rules\.\nOrders: paper practice; nothing is sent to KIS\./);assert.ok(s.text.endsWith(C.START_CONFIRM));
  const m=await r.confirm(s.nonce);assert.deepEqual({kind:m.kind,nonce:m.nonce},{kind:'modal',nonce:s.nonce},'the button opens the PIN form');
  assert.equal(r.a.config.enabled,false,'nothing started before the PIN');
  const done=await r.pin(s.nonce);assert.match(done.text,/^Auto trading started\./,'start()\'s own sentence');
  assert.equal(r.a.config.enabled,true);assert.equal(L.launchState(r.a).running,true);
  assert.deepEqual(r.alerts,[['Auto trading started from the phone.','start']]);
  assert.deepEqual(r.lines.map(l=>l[1]).slice(-3,-1),['Showed what Start would start.','Asked for the PIN.']);
});

test('the token is taken at the summary and passed unchanged to start(automation, token)',async()=>{
  const a=paperAutomation();const got=[];const launch={...L,start:async(x,token)=>{got.push([x,token]);return 'Auto trading started. A review is due and starts shortly.';}};
  const r=rig(a,{launch});await r.ready();const want=L.launchState(a).token;const s=await r.slash('start');await r.confirm(s.nonce);await r.pin(s.nonce);
  assert.equal(got.length,1);assert.equal(got[0][0],a,'the app\'s Automation');assert.equal(got[0][1],want,'the summary\'s token');
});

test('a setting changed between the summary and the PIN: the desktop\'s sentence, not started, no alert',async()=>{
  const r=rig();await r.ready();const s=await r.slash('start');await r.confirm(s.nonce);r.a.configure({intervalMinutes:15});
  const done=await r.pin(s.nonce);assert.equal(done.text,'Settings or account changed. Check the updated account label and try again.');
  assert.equal(r.a.config.enabled,false);assert.deepEqual(r.alerts,[]);
});

test('start()\'s refusals reach the phone in its own words: a review running, the loss-limit guardrail, no model chosen',async()=>{
  for(const [setup,want] of [
    [a=>{a.busy=true;},'A review is already running. Wait for it to finish.'],
    [a=>{a.config.lossAction='stop';a.emergencyState=()=>({active:true});},'The daily loss limit is reached and the guardrail keeps auto trading stopped today. Change Loss-limit response in Engine settings to restart.'],
    [a=>{a.config.provider='external';},'Choose an AI model in Engine settings to start automatic reviews.']]){
    const a=paperAutomation();setup(a);const r=rig(a);await r.ready();const s=await r.slash('start');await r.confirm(s.nonce);const done=await r.pin(s.nonce);
    assert.equal(done.text,want);assert.equal(a.config.enabled,false);assert.deepEqual(r.alerts,[]);}
  // No key, no consent, the budget, no funded balance, an order in process: start() throws each with its sentence; the
  // executor answers any refusal with that sentence (error.text, else error.message), the way runtime:start does.
  const thrower=text=>({...L,start:async()=>{throw new Error(text);}});
  for(const text of ['Import your Anthropic key in Connections first.','Allow sharing KIS data with Anthropic in Connections first.','Daily API budget reached. Update your budget or wait for the next day.','KR: no funded balance available. Choose a funded market in Engine settings.','An order is being processed. Try again after it completes.']){
    const pa=paperAutomation();const ex=C.createExecutor({automation:pa,launch:thrower(text)});assert.deepEqual(await ex.run({command:'start',held:{token:'t',fingerprint:C.phoneFingerprint(pa)}}),{text,changed:false});}
});

test('Start does what the desktop button\'s handler does besides start(), and nothing more',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  assert.ok(src.includes("ipcMain.handle('runtime:start',async(event,token)=>{authorize(event);try{const message=await require('./auto-launch.cjs').start(automation,token);return {ok:true,message,state:runtimeState()};}"),'the handler: authorize, start(), and the state for the window');
  const ex=require('node:fs').readFileSync(require.resolve('../electron/phone-commands.cjs'),'utf8');assert.ok(ex.includes('try{return {text:String(await launch.start(automation,token)),changed:true};}'));
});

test('the Claude dry run: checked by every settings save that turns trading on, so inside start() (its configure enabled:true)',()=>{
  // automation.cjs configure: claudeTradingRefusal(next,{saving:true}) on any save that does not only turn trading off;
  // start() saves {enabled:true,autoSubmit:true} (auto-launch.cjs), so the desktop and the phone Start both pass it.
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');
  assert.ok(src.includes("const why=this.claudeTradingRefusal(next,{saving:true,switching:toClaude});if(why)throw"));
  assert.ok(src.includes("if(saving&&!this.claudeTradingDryRun())return {code:'CLAUDE_TRADING_DRY_RUN'"));
  assert.ok(src.includes("this.vendorOf(this.agentModel('trading').openaiModel)==='anthropic'){const why=this.claudeTradingRefusal(this.config);"),'review time');
});

test('the summary: the account label, the model, how orders go out, each market\'s limits, armed orders; amounts follow the switch',()=>{
  const policy={maxOrderKRW:500000,maxDailyTurnoverKRW:2000000,maxCompanyPct:20,lossLimit:{mode:'percent',value:3}},usPolicy={maxOrderKRW:300,lossLimit:{mode:'amount',value:50}};
  const make=amounts=>({config:{scope:'both',provider:'openai',openaiModel:'claude-opus-5-5',conditionalOrders:true,phoneAmounts:amounts,enabled:false,autoSubmit:false},
    live:{getState:()=>({environment:'live',policy}),identity:()=>'x',policy:()=>policy,exposure:{policy:()=>({short:{enabled:false}})}},usLive:{getState:()=>({policy:usPolicy}),policy:()=>usPolicy},
    paper:{account:()=>({paused:true})},desk:{orders:()=>[{symbol:'990001'},{symbol:'990002'}]},watchScope:()=>'s'});
  const on=C.startSummary(make(true)).text;
  assert.equal(on,['Start auto trading?','Account: LIVE · Korea + U.S.','Trading model: Claude Opus 5.5.','Orders: buys and sales are sent to KIS automatically.','Short selling: off.',
    'Conditional orders: when the conditions are met a hit armed order becomes a proposal that waits for approval.',
    'Korea limits: maximum order ₩500,000, daily turnover ₩2,000,000, per company 20%, daily loss 3%.','U.S.: buys and sales are sent automatically, each counted against your won cash; limits: maximum order $300, daily turnover not set, per company not set, daily loss $50.',
    '2 armed orders become watched.',C.START_CONFIRM].join('\n'));
  const off=C.startSummary(make(false)).text;assert.match(off,/Korea limits: maximum order set, daily turnover set, per company 20%, daily loss 3%\./);assert.match(off,/U\.S\.: buys and sales are sent automatically, each counted against your won cash; limits: maximum order set, daily turnover not set, per company not set, daily loss set\./);
  assert.doesNotMatch(off,/₩|\$/,'no amounts with the switch off');
});

test('already running: said, and nothing held; a summary that cannot be read: said',async()=>{
  const r=rig();await r.ready();const s=await r.slash('start');await r.confirm(s.nonce);await r.pin(s.nonce);assert.equal(r.a.config.enabled,true);
  const again=await r.slash('start');assert.deepEqual({kind:again.kind,text:again.text},{kind:'message',text:'Auto trading is already running.'});assert.equal(r.svc.core.pending.size,0,'the nonce taken back');
  const ex=C.createExecutor({automation:{config:null}});assert.deepEqual(await ex.summary({command:'start'}),{ok:false,text:'What Start would start could not be read. Try again from the PC.'});
});

test('at most once: the same PIN form twice, two Starts confirmed at once, a review running, a worker restart in between',async()=>{
  {const r=rig();await r.ready();const s=await r.slash('start');await r.confirm(s.nonce);let calls=0;const real=L.start;
    r.svc.executor=C.createExecutor({automation:r.a,launch:{...L,start:(...x)=>{calls++;return real(...x);}}});
    await Promise.all([r.pin(s.nonce),r.pin(s.nonce)]);assert.equal(calls,1,'the second form finds nothing held');assert.equal(r.alerts.length,1);}
  {const r=rig();await r.ready();const s1=await r.slash('start');const s2=await r.slash('start');await r.confirm(s1.nonce);await r.confirm(s2.nonce);
    await Promise.all([r.pin(s1.nonce),r.pin(s2.nonce)]);const replies=r.sent.filter(m=>m.kind==='message').map(m=>m.text);
    assert.equal(replies.filter(t=>/^Auto trading started\./.test(t)).length,1,'one start');assert.ok(replies.includes('Settings or account changed. Check the updated account label and try again.'),'the other refused by the token');assert.equal(r.alerts.length,1);}
  {const r=rig();await r.ready();const s=await r.slash('start');await r.confirm(s.nonce);r.a.busy=true;const done=await r.pin(s.nonce);assert.equal(done.text,'A review is already running. Wait for it to finish.');assert.equal(r.a.config.enabled,false);}
  {const r=rig();await r.ready();const s=await r.slash('start');await r.confirm(s.nonce);r.svc.launch();const before=r.sent.filter(m=>m.op==='reply').length;
    await r.pin(s.nonce);assert.equal(r.sent.filter(m=>m.op==='reply').length,before,'the new launch has no core yet: ignored');assert.equal(r.a.config.enabled,false);
    await r.ready();const after=await r.pin(s.nonce);assert.equal(after.kind,'message');assert.doesNotMatch(after.text,/^Auto trading started/,'the new core holds nothing: expired');assert.equal(r.a.config.enabled,false);}
});

test('Start\'s PIN refusals are the core\'s: no PIN set, or the PIN locked, said before any summary; a wrong PIN does not start',async()=>{
  const S=require('../electron/phone-core.cjs').SENTENCES;
  {const r=rig();await r.ready();r.svc.core.writePin({});const s=await r.slash('start');assert.equal(s.text,S.noPin);assert.equal(r.svc.core.pending.size,0);}
  {const r=rig();await r.ready();const st=r.svc.core.pinState();r.svc.core.writePin({...st,wrong:5,locked:true});const s=await r.slash('start');assert.equal(s.text,S.locked);}
  {const r=rig();await r.ready();const s=await r.slash('start');await r.confirm(s.nonce);const done=await r.pin(s.nonce,'000000');assert.equal(done.text,S.wrongPin);assert.equal(r.svc.core.pinState().wrong,1);assert.equal(r.a.config.enabled,false);assert.deepEqual(r.alerts,[]);}
});

// Review of P4: four changes.
// A stand-in Automation on Korea + U.S. whose saved policies and exposure policy the test can change.
function fakeBoth(over={}){const st={policy:{maxOrderKRW:500000,maxDailyLossKRW:100000,lossLimit:{mode:'off',value:0}},usPolicy:{maxOrderKRW:300},exposure:{short:{enabled:true,auto:true,maxGrossPctOfEquity:15}},...over};
  const a={config:{scope:'both',provider:'openai',openaiModel:'gpt-6-sol',conditionalOrders:true,conditionalAutoSubmit:true,phoneAmounts:true,enabled:false,autoSubmit:false},
    live:{getState:()=>({environment:'mock'}),identity:()=>'acct',policy:()=>st.policy,exposure:{policy:()=>st.exposure}},usLive:{getState:()=>({}),identity:()=>'us',policy:()=>st.usPolicy,exposure:{policy:()=>({leveragedEtps:{enabled:false}})}},
    paper:{account:()=>({paused:true})},desk:{orders:()=>[]},watchScope:()=>'s',ordersFor:()=>3,agentModel:()=>({openaiModel:'gpt-6-sol'})};return {a,st};}

test('review 1: the summary says what Start newly allows: short selling, orders per review, conditional orders, the U.S. sending',()=>{
  const {a,st}=fakeBoth();const t=C.startSummary(a).text;
  assert.ok(t.includes('Up to 3 orders per review.'));
  assert.ok(t.includes('Short selling: on, automatic: a short the AI decides is sent by itself; short positions up to 15% of net assets.'));
  assert.ok(t.includes('Conditional orders: a hit armed order is submitted automatically when the conditions are met and every check passes.'));
  assert.ok(t.includes('U.S.: buys and sales are sent automatically, each counted against your won cash; limits: maximum order $300,'));
  st.exposure={short:{enabled:true,auto:false,maxGrossPctOfEquity:15}};assert.ok(C.startSummary(a).text.includes('Short selling: on, propose only: each short the AI decides waits for your approval; short positions up to 15% of net assets.'));
  st.exposure={short:{enabled:false}};a.ordersFor=()=>1;a.config.conditionalOrders=false;const off=C.startSummary(a).text;
  assert.ok(off.includes('Short selling: off.'),'short selling always says on or off');assert.ok(!off.includes('orders per review')&&!off.includes('Conditional orders'),'what is off has no line');
  a.config.scope='us';assert.ok(!C.startSummary(a).text.includes('Short selling'),'no Korea in scope: no short line');
});

test('review 2: the phone fingerprint: the short switch, its automatic setting, the cap, the daily loss in won and a U.S. limit, changed after the summary, refuse',async()=>{
  const changes=[st=>{st.exposure={short:{...st.exposure.short,enabled:false}};},st=>{st.exposure={short:{...st.exposure.short,auto:false}};},st=>{st.exposure={short:{...st.exposure.short,maxGrossPctOfEquity:40}};},st=>{st.policy={...st.policy,maxDailyLossKRW:900000};},st=>{st.usPolicy={maxOrderKRW:3000};}];
  for(const change of changes){const {a,st}=fakeBoth();let calls=0;const ex=C.createExecutor({automation:a,launch:{...L,start:async()=>{calls++;return 'Auto trading started.';}}});
    const s=await ex.summary({command:'start'});assert.equal(s.ok,true);assert.equal(s.held.token,L.launchState(a).token,'the desktop token as it is');change(st);
    assert.equal(L.launchState(a).token,s.held.token,'the desktop token does not see this change');
    assert.deepEqual(await ex.run({command:'start',held:s.held}),{text:C.CHANGED,changed:false});assert.equal(calls,0);}
  const {a}=fakeBoth();let calls=0;const ex=C.createExecutor({automation:a,launch:{...L,start:async()=>{calls++;return 'Auto trading started.';}}});const s=await ex.summary({command:'start'});
  assert.equal((await ex.run({command:'start',held:s.held})).changed,true);assert.equal(calls,1,'unchanged: started');
  const {a:b}=fakeBoth();b.live.exposure.policy=()=>{throw new Error('x');};const ex2=C.createExecutor({automation:b,launch:{...L,start:async()=>{throw new Error('not reached');}}});const s2=await ex2.summary({command:'start'});
  assert.deepEqual(await ex2.run({command:'start',held:s2.held}),{text:C.CHANGED,changed:false},'not readable: nothing starts');
});

test('review 3: what the summary cannot read says "not known", never "not set" or "off"',()=>{
  const {a}=fakeBoth();a.live.policy=()=>{throw new Error('x');};a.live.exposure.policy=()=>{throw new Error('x');};a.ordersFor=()=>{throw new Error('x');};a.desk.orders=()=>{throw new Error('x');};
  const t=C.startSummary(a).text;
  for(const want of ['Korea: limits not known.','Short selling: not known.','Orders per review: not known.','Armed orders: not known.'])assert.ok(t.includes(want),want);
  assert.ok(!t.includes('Korea limits:'),'no Korea figures guessed');assert.ok(!t.includes('Short selling: off'));
  a.usLive=null;assert.ok(C.startSummary(a).text.includes('U.S.: buys and sales are sent automatically, each counted against your won cash; limits not known.'));
});

test('review 4: the confirm button is a gate: a PIN form sent straight after the summary starts nothing, even with the right PIN',async()=>{
  const S=require('../electron/phone-core.cjs').SENTENCES;const r=rig();await r.ready();const s=await r.slash('start');const early=await r.pin(s.nonce);
  assert.equal(early.text,S.expired);assert.equal(r.a.config.enabled,false);assert.equal(r.svc.core.pinState().wrong,0,'no PIN checked');
  const late=await r.confirm(s.nonce);assert.equal(late.text,S.expired,'the held Start is gone');assert.equal(r.a.config.enabled,false);assert.deepEqual(r.alerts,[]);
});

test('review 4: on a real Automation set to Claude Opus 5.5 with no counted dry run, the phone Start answers the desktop sentence and starts nothing',async()=>{
  const M=require('../electron/ai-models.cjs');const RI=require('../electron/review-instructions.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const SENTENCE='Trading on Claude Opus 5.5 needs a dry run on this version first: Dashboard → Dry run → Claude Opus 5.5.';
  M.setClaudeTradingForTests(true);try{const db=new DatabaseSync(':memory:');
    const a=new Automation(db,new PaperEngine(db,[{symbol:'990001',price:100,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
    a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true});
    a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};
    a.completedClaudeDryRun=()=>({id:'D',timestamp:Date.now(),model:'claude-opus-5-5',calls:3,costUSD:0.33,account:'KIS mock',appVersion:'1.6.0',instructions:{version:'v',fingerprint:RI.fingerprint()},answerForm:'enforced'});
    a.configure({openaiModel:'claude-opus-5-5',claudeTradingConfirmed:true});assert.equal(a.config.openaiModel,'claude-opus-5-5');
    // The dry run no longer counts (for example after an update changed the review instructions).
    a.completedClaudeDryRun=()=>null;
    const engine={market:'KR',enabled:false,autoEnabled:false,busy:false,getState:()=>({environment:'mock',policy:{}}),identity:()=>'acct',getConnection:()=>({status:'connected',snapshot:{reportedTotal:1000000}}),funded:()=>true,
      policy:()=>({symbols:[],lossLimit:{mode:'off',value:0}}),exposure:{policy:()=>({short:{enabled:false}})},configure(){this.enabled=true;},enableAuto(){this.autoEnabled=true;},stop(){},orders:()=>[]};
    a.live=engine;a.usLive=null;
    const r=rig(a);await r.ready();const s=await r.slash('start');assert.equal(s.kind,'summary');assert.ok(s.text.includes('Trading model: Claude Opus 5.5.'));
    await r.confirm(s.nonce);const done=await r.pin(s.nonce);
    assert.equal(done.text,SENTENCE,'start() refuses from its own save of enabled:true');assert.equal(a.config.enabled,false);assert.equal(engine.autoEnabled,false,'the engine is put back');assert.deepEqual(r.alerts,[]);
  }finally{M.setClaudeTradingForTests(false);}
});

// Second review of P4: the fingerprint holds only what the user set.
function realEngine({market='KR',lossLimit={mode:'percent',value:3}}={}){const {LiveEngine}=require('../electron/live-engine.cjs');const {Exposure}=require('../electron/exposure.cjs');
  const db=new DatabaseSync(':memory:');const snap={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:market==='US'?'NASD:NVDA':'990001',name:'F',quantity:10,cost:200000,price:217000}]};
  const state={snap};const live=new LiveEngine(db,{request:async()=>({balance:state.snap,quotes:[{symbol:market==='US'?'NASD:NVDA':'990001',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot:state.snap}),{market,severalOpen:true});
  live.exposure=new Exposure(db);live.configure({symbols:[],maxOrderKRW:market==='US'?300:500000,maxDailyTurnoverKRW:market==='US'?1000:2000000,maxCompanyPct:20,lossLimit},'ENABLE MOCK');return {live,state,snap};}

test('second review 2: on a real LiveEngine, a new day peak, the day rollover, a quote tick and a finished review leave the fingerprint as it is',async()=>{
  for(const lossLimit of [{mode:'percent',value:3},{mode:'amount',value:200000}]){const {live,state,snap}=realEngine({lossLimit});const a={config:{scope:'kis'},live,lastRun:1};const before=C.phoneFingerprint(a);const raw=JSON.stringify(live.policy());
    live.observeBalance({...snap,reportedTotal:snap.reportedTotal*1.005});assert.notEqual(JSON.stringify(live.policy()),raw,'the running values did move (dayPeakEquity)');assert.equal(C.phoneFingerprint(a),before,'a new day peak');
    live.day=()=>'2099-01-02';live.observeBalance({...snap,reportedTotal:snap.reportedTotal*0.98});assert.equal(live.policy().day,'2099-01-02','the day rolled over');assert.equal(C.phoneFingerprint(a),before,'the rollover');
    state.snap={...snap,reportedTotal:snap.reportedTotal*1.01};try{await live.context();}catch{}assert.equal(C.phoneFingerprint(a),before,'a quote tick and a balance read');
    a.lastRun=Date.now();assert.equal(C.phoneFingerprint(a),before,'a finished review');}
});

test('second review 2: on a real LiveEngine, each user-set field changed refuses; the U.S. too',async()=>{
  const cases=[['symbols',e=>e.live.configure({symbols:['990001'],maxOrderKRW:500000,maxDailyTurnoverKRW:2000000,maxCompanyPct:20,lossLimit:{mode:'percent',value:3}},'ENABLE MOCK')],
    ['maxOrderKRW',e=>e.live.configure({symbols:[],maxOrderKRW:600000,maxDailyTurnoverKRW:2000000,maxCompanyPct:20,lossLimit:{mode:'percent',value:3}},'ENABLE MOCK')],
    ['maxDailyTurnoverKRW',e=>e.live.configure({symbols:[],maxOrderKRW:500000,maxDailyTurnoverKRW:3000000,maxCompanyPct:20,lossLimit:{mode:'percent',value:3}},'ENABLE MOCK')],
    ['maxCompanyPct',e=>e.live.configure({symbols:[],maxOrderKRW:500000,maxDailyTurnoverKRW:2000000,maxCompanyPct:30,lossLimit:{mode:'percent',value:3}},'ENABLE MOCK')],
    ['lossLimit percent',e=>e.live.configure({symbols:[],maxOrderKRW:500000,maxDailyTurnoverKRW:2000000,maxCompanyPct:20,lossLimit:{mode:'percent',value:5}},'ENABLE MOCK')],
    ['lossLimit amount (maxDailyLossKRW)',e=>e.live.configure({symbols:[],maxOrderKRW:500000,maxDailyTurnoverKRW:2000000,maxCompanyPct:20,lossLimit:{mode:'amount',value:300000}},'ENABLE MOCK')],
    ['short switch',e=>e.live.exposure.savePolicy('acct',{short:{enabled:true}})],['short cap',e=>e.live.exposure.savePolicy('acct',{short:{maxGrossPctOfEquity:40}})],
    ['margin',e=>e.live.exposure.savePolicy('acct',{margin:{enabled:true}})],['leveraged products',e=>e.live.exposure.savePolicy('acct',{leveragedEtps:{enabled:true}})]];
  for(const [name,change] of cases){const e=realEngine();const a={config:{scope:'kis'},live:e.live};let calls=0;const ex=C.createExecutor({automation:a,launch:{...L,launchState:L.launchState,start:async()=>{calls++;return 'started';}}});
    const held={token:'t',fingerprint:C.phoneFingerprint(a)};change(e);assert.deepEqual(await ex.run({command:'start',held}),{text:C.CHANGED,changed:false},name);assert.equal(calls,0,name);}
  const us=realEngine({market:'US'});const a={config:{scope:'us'},usLive:us.live};let calls=0;const ex=C.createExecutor({automation:a,launch:{...L,start:async()=>{calls++;return 'started';}}});
  const held={token:'t',fingerprint:C.phoneFingerprint(a)};us.live.configure({symbols:[],maxOrderKRW:400,maxDailyTurnoverKRW:1000,maxCompanyPct:20,lossLimit:{mode:'percent',value:3}},'ENABLE MOCK');
  assert.deepEqual(await ex.run({command:'start',held}),{text:C.CHANGED,changed:false},'a U.S. limit');assert.equal(calls,0);
});

test('second review 3: margin buying and leveraged products are said when on, in the card\'s words; nothing when off',()=>{
  const e=realEngine();const a={config:{scope:'kis'},live:e.live,desk:{orders:()=>[]},watchScope:()=>'s',paper:{account:()=>({paused:true})}};e.live.getState=()=>({environment:'mock'});e.live.identity=()=>'acct';
  const off=C.startSummary(a).text;assert.ok(!off.includes('Margin buying')&&!off.includes('Leveraged & inverse'),'off: no line');
  e.live.exposure.savePolicy('acct',{margin:{enabled:true,auto:true,maxLoanPctOfEquity:25},leveragedEtps:{enabled:true,maxPctOfEquity:10}});const on=C.startSummary(a).text;
  assert.ok(on.includes('Margin buying: on, automatic; loans up to 25% of net assets.'));assert.ok(on.includes('Leveraged & inverse ETFs (Korea): on, propose only; up to 10% of the account.'));
});

test('second review 4: "Up to N orders per review." on a real Automation with several open orders allowed',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});const e=realEngine();a.live=e.live;
  // Only Claude Opus 5.5 has an order ceiling above 1 (ai-models.cjs orderCeiling), so the switch to it goes through its
  // save conditions, with a counted dry run.
  const M=require('../electron/ai-models.cjs');const RI=require('../electron/review-instructions.cjs');M.setClaudeTradingForTests(true);try{
    a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,shareKisWithAnthropic:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium',anthropicUnlimitedCalls:true,anthropicUnlimitedBudget:true});
    a.providerStatus={aiConnected:true,openaiConnected:true,anthropicConnected:true};
    a.completedClaudeDryRun=()=>({id:'D',timestamp:Date.now(),model:'claude-opus-5-5',calls:3,costUSD:0.33,account:'KIS mock',appVersion:'1.6.0',instructions:{version:'v',fingerprint:RI.fingerprint(undefined,{orders:true})},answerForm:'enforced'});
    a.configure({openaiModel:'claude-opus-5-5',claudeTradingConfirmed:true,severalOpenOrders:true,ordersPerReview:3});
    const n=a.ordersFor(a.agentModel('trading'));assert.equal(n,3,'several open orders allowed');assert.ok(C.startSummary(a).text.includes('Up to 3 orders per review.'));
    a.configure({ordersPerReview:1});assert.ok(!C.startSummary(a).text.includes('orders per review'),'one: no line');
  }finally{M.setClaudeTradingForTests(false);}
});
