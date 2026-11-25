// Phone control P5 (artifacts/reviews/2026-11-25-phone-control): lost order replies from the phone. /orders lists the
// orders in status Uncertain; /link and /nottaken show the order and what KIS showed, then the button and the PIN run
// the desktop's linkUncertain and markNotTaken on it. A real Automation and real LiveEngines (Korea and U.S., mock), a
// stand-in KIS that records every request; made-up ids and values; no network.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const {randomUUID}=require('node:crypto');
const C=require('../electron/phone-commands.cjs');const {PhoneService}=require('../electron/phone-service.cjs');const {PhoneCore,SENTENCES:S}=require('../electron/phone-core.cjs');
const allow={application:'100000000000000004',server:'100000000000000002',channel:'100000000000000003',user:'100000000000000001'};
const PIN='482913';const NOID='No order has that id. /orders lists the orders with a lost KIS reply.';const GONE='That order is not waiting on a lost KIS reply any more. Nothing was changed.';
const CHANGED_SHOWN='This order changed since it was shown. Send the command again.';
const WARNING='Only if you checked in KIS that it has no such order. The app then counts it as not sent and may send it again.';

// The app with both markets: every KIS request each engine makes is recorded; 'orders' answers with kis.rows.
function app(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const kis={rows:[],calls:[]};
  const broker=market=>({request:async(op)=>{kis.calls.push([market,op]);if(op==='orders')return {orders:kis.rows.filter(r=>r.market===market)};throw new Error('NOT_EXPECTED_'+op);}});
  const snap={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[]};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.live=new LiveEngine(db,broker('KR'),()=>({status:'connected',snapshot:snap}));a.usLive=new LiveEngine(db,broker('US'),()=>({status:'connected',snapshot:{...snap,accountKey:'acct-us'}}),{market:'US'});
  for(const e of [a.live,a.usLive])e.configure({symbols:[],maxOrderKRW:e.market==='US'?300:500000,lossLimit:{mode:'percent',value:3}},'ENABLE MOCK');
  let watch=0;a.refreshWatchRecord=()=>{watch++;};
  const lost=(market,over={})=>{const e=market==='US'?a.usLive:a.live;const o={id:randomUUID(),accountKey:e.identity(),day:e.day(),symbol:market==='US'?'NASD:NVDA':'990001',name:'Fixture',side:'Buy',quantity:10,limitPrice:market==='US'?123.5:12000,
    status:'Uncertain',createdAt:Date.parse('2026-11-26T01:31:00Z'),kisCandidates:[],...over};e.save(o);return o;};
  return {a,db,kis,lost,watch:()=>watch};}
// The real core and service, a stand-in worker driven through its listener; each interaction 7 s after the last, so
// the core's 10 a minute is never reached.
function rig(x){const db=new DatabaseSync(':memory:');let now=1795600000000;const sent=[],lines=[],alerts=[];let handlers={};
  const svc=new PhoneService({makeCore:al=>new PhoneCore(db,{allow:al,clock:()=>now}),spawn:()=>({postMessage:m=>sent.push(m),on:(e,fn)=>{handlers[e]=fn;},kill(){}}),clock:()=>now,
    log:(t,b)=>lines.push([t,b]),notify:(t,c)=>alerts.push([t,c]),executor:C.createExecutor({automation:x.a})});svc.start('p','s');
  let seq=0n;const idAt=ms=>String(((BigInt(ms)-1420070400000n)<<22n)|(seq++));const base=()=>({id:idAt(now),applicationId:allow.application,serverId:allow.server,channelId:allow.channel,userId:allow.user});
  const tick=()=>new Promise(r=>setImmediate(r));let refN=0;const ref=()=>(refN++).toString(16).padStart(24,'0');
  const emit=async d=>{now+=7000;d={...d,id:idAt(now)};handlers.message({type:'interaction',ref:ref(),interaction:d});for(let i=0;i<6;i++)await tick();return sent.at(-1);};
  const ready=async()=>{handlers.message({type:'state',state:'keys-ok',allow});await tick();svc.core.setPin(PIN);};
  const opts=o=>Object.entries(o).map(([name,value])=>({name,value}));
  const r={svc,sent,lines,alerts,ready,emit,slash:(command,o={})=>emit({...base(),type:2,command,options:opts(o)}),confirm:nonce=>emit({...base(),type:3,customId:'start-confirm:'+nonce}),pin:(nonce,pin=PIN)=>emit({...base(),type:5,customId:'pin:'+nonce,pin})};
  // The whole path: the command, its summary, the button, the PIN form, the PIN.
  r.through=async(command,o)=>{const s=await r.slash(command,o);if(s.kind!=='summary')return {summary:s,done:s};const m=await r.confirm(s.nonce);assert.equal(m.kind,'modal');return {summary:s,done:await r.pin(s.nonce)};};
  return r;}

test('/orders: each lost order with its short id, market, side, stock, quantity, price and time, and what KIS showed; amounts shown whatever the switch',async()=>{
  const x=app();x.a.config.phoneAmounts=false;const kr=x.lost('KR');const us=x.lost('US',{kisCandidates:[{side:'Buy',quantity:10,symbol:'NASD:NVDA',status:'Rejected',timestamp:Date.parse('2026-11-26T01:32:00Z')}]});x.lost('KR',{status:'Accepted'});
  const t=C.lostOrdersText(x.a);
  assert.ok(t.includes(`${C.shortId(kr.id)} · Korea · Buy 10 990001 (Fixture) at ₩12,000 · sent 10:31 KST`),t);
  assert.ok(t.includes(`${C.shortId(us.id)} · U.S. · Buy 10 NASD:NVDA (Fixture) at $123.50 · sent 20:31 New York`),t);
  assert.ok(t.includes('  KIS showed no order like it.'));assert.ok(t.includes('  KIS shows: Buy 10 NASD:NVDA, rejected, 20:32 New York'));
  assert.equal(t.split('\n').filter(l=>/ · (Korea|U\.S\.) · /.test(l)).length,2,'the Accepted order is not listed');
  assert.match(t,/Then \/link order:<id> number:<KIS order number>, or \/nottaken order:<id> if KIS has no such order\.$/);
  assert.equal(C.lostOrdersText(app().a),'No orders have a lost KIS reply.');
  const r=rig(x);await r.ready();const reply=await r.slash('orders');assert.equal(reply.text,t);assert.deepEqual(r.lines.at(-1),['Phone command · orders','Lost orders listed.'],'Activity holds no order details');
});

test('P5 review 2: a reply that can grow fits, never cut silently: whole orders, "and N more; see the PC.", the closing line',()=>{
  const x=app();const ids=[];for(let i=0;i<40;i++)ids.push(x.lost(i%2?'US':'KR',{kisCandidates:[{side:'Buy',quantity:10,symbol:'990001',status:'Filled',timestamp:1795600000000}]}).id);
  const t=C.lostOrdersText(x.a);assert.ok(t.length<=1900,String(t.length));
  const shown=t.split('\n').filter(l=>/ · (Korea|U\.S\.) · /.test(l)).length;assert.ok(shown>=5&&shown<40,String(shown));
  assert.ok(t.includes(`and ${40-shown} more; see the PC.`),'how many more');assert.match(t,/if KIS has no such order\.$/,'the closing line kept');
  for(const line of t.split('\n').filter(l=>/ · (Korea|U\.S\.) · /.test(l)))assert.ok(ids.some(id=>line.startsWith(C.shortId(id))),'whole lines only');
  // Status with many provider waits, the same rule.
  const waits=Array.from({length:120},(_,i)=>({name:'Provider '+i,nextTry:'11:30'}));
  const s=C.statusText({config:{scope:'kis',conditionalOrders:false},autoTradingRuns:()=>false,live:{orders:()=>[]},desk:{orders:()=>[]},providerWaitState:()=>waits,lastRun:null,nextReviewAt:()=>null});
  assert.ok(s.length<=1900);assert.match(s,/^Auto trading: stopped/);assert.match(s,/and \d+ more; see the PC\.$/);
});

test('the words before and after "KIS never took it" are the renderer\'s (src/not-taken.mjs), copy for copy',async()=>{
  const R=await import('../src/not-taken.mjs');
  const orders=[{},{kisCandidates:[]},{kisCandidates:['x']},{kisCandidates:[{side:'Sell',quantity:3,symbol:'990001',status:'Filled',timestamp:1795600000000},{orderId:'77'}]}];
  for(const o of orders)for(const m of ['KR','US'])for(const out of ['running','halted','watched','unknown'])assert.deepEqual(C.notTakenEvidence(o,m,out),R.notTakenEvidence(o,m,out));
  for(const d of [null,{rearmed:[]},{rearmed:[{purpose:'stop_loss',symbol:'990001'},{purpose:'entry',symbol:'990002'}],halted:true,market:'KR'},{rearmed:[{purpose:'stop_loss',symbol:'X'}],watched:true,market:'US'}])
    assert.equal(C.notTakenDone(d),R.notTakenDone(d));
  const src=require('node:fs').readFileSync(require.resolve('../src/LiveTrading.tsx'),'utf8');assert.ok(src.includes(WARNING),'the desktop dialog\'s warning');
});

test('P5 review 1: /nottaken shows the order, what KIS showed and the outlook before its button; then the PIN; markNotTaken with the desktop phrase',async()=>{
  const x=app();const o=x.lost('KR',{kisCandidates:[{side:'Buy',quantity:10,symbol:'990001',status:'Filled',timestamp:Date.parse('2026-11-26T01:32:00Z')}]});const r=rig(x);await r.ready();
  const real=x.a.live.getState.bind(x.a.live);x.a.live.getState=()=>({...real(),enabled:false,notTakenOutlook:'halted'});// the unclear reply stopped Korean trading
  const s=await r.slash('nottaken',{order:C.shortId(o.id)});assert.equal(s.kind,'summary');
  assert.equal(s.text,['Count this order as not sent?',`${C.shortId(o.id)} · Korea · Buy 10 990001 (Fixture) at ₩12,000 · sent 10:31 KST`,'KIS shows: Buy 10 990001, filled, 10:32',
    'Korean auto trading is stopped: a stop armed again sends nothing until you press Start.',WARNING,C.START_CONFIRM].join('\n'),'the order, what KIS showed, the outlook, the desktop warning');
  assert.equal(x.a.live.orders().find(z=>z.id===o.id).status,'Uncertain','nothing before the button and the PIN');
  assert.equal((await r.pin(s.nonce)).text,S.expired,'a PIN form before the button does nothing');assert.equal(r.svc.core.pinState().wrong,0);
  const {done}=await r.through('nottaken',{order:C.shortId(o.id)});assert.equal(done.text,'Counted as not sent.');
  const after=x.a.live.orders().find(z=>z.id===o.id);assert.deepEqual([after.status,after.reason,after.notSentCause],['Rejected','ORDER_NOT_SENT','user-confirmed-not-taken']);
  assert.deepEqual(r.alerts,[['A lost order was counted as not sent from the phone.','nottaken']]);assert.equal(x.watch(),1,'Korea: liveAction refreshes the watch record');
  assert.deepEqual(x.kis.calls,[],'nothing sent to or read from KIS');
  const again=await r.slash('nottaken',{order:C.shortId(o.id)});assert.deepEqual({kind:again.kind,text:again.text},{kind:'message',text:GONE},'no longer lost: said at once');assert.equal(r.alerts.length,1);
  // The U.S. twin: automation.markNotTaken('US'), and no watch-record refresh (us:not-taken does none).
  const u=x.lost('US');await r.through('nottaken',{order:u.id.toUpperCase()});assert.equal(x.a.usLive.orders().find(z=>z.id===u.id).status,'Rejected');assert.equal(x.watch(),1);
});

test('P5 review 1: what was shown is read again at the run: new evidence, a changed outlook or another status refuses',async()=>{
  for(const change of [(x,o)=>x.a.live.save({...x.a.live.orders().find(z=>z.id===o.id),kisCandidates:[{side:'Buy',quantity:10,symbol:'990001',status:'Filled',timestamp:1795600000000}]}),
    x=>{x.a.live.getState=()=>({enabled:false,notTakenOutlook:'halted'});}]){
    const x=app();const o=x.lost('KR');x.a.live.getState=()=>({enabled:true});const r=rig(x);await r.ready();
    const s=await r.slash('nottaken',{order:C.shortId(o.id)});await r.confirm(s.nonce);change(x,o);
    assert.equal((await r.pin(s.nonce)).text,CHANGED_SHOWN);assert.equal(x.a.live.orders().find(z=>z.id===o.id).status,'Uncertain');assert.deepEqual(r.alerts,[]);}
  const x=app();const o=x.lost('KR');const r=rig(x);await r.ready();const s=await r.slash('nottaken',{order:C.shortId(o.id)});await r.confirm(s.nonce);
  x.a.live.save({...x.a.live.orders().find(z=>z.id===o.id),status:'Accepted'});assert.equal((await r.pin(s.nonce)).text,GONE,'no longer lost by the PIN');assert.deepEqual(r.alerts,[]);
});

test('/link: the summary names the KIS number and what is checked; linkUncertain reads KIS\'s orders only; a match links, anything else changes nothing',async()=>{
  const x=app();const o=x.lost('KR');const r=rig(x);await r.ready();
  x.kis.rows=[{market:'KR',orderId:'0000123',symbol:'990001',side:'Buy',quantity:10,orderPrice:12000}];
  const s=await r.slash('link',{order:C.shortId(o.id),number:'0000123'});assert.equal(s.kind,'summary');
  assert.ok(s.text.startsWith('Link this order to KIS order 0000123?\n'+`${C.shortId(o.id)} · Korea · Buy 10 990001 (Fixture) at ₩12,000`));
  assert.ok(s.text.includes(`The app reads KIS's orders of ${o.day} and links only if KIS order 0000123 has the same stock, side, quantity and price.`));
  // P5 review 3: a number KIS does not list and one whose order differs give the same, true sentence.
  const MISMATCH='KIS lists no order with that number that matches this one (the stock, side, quantity or price differ, or the number is not KIS\'s). Nothing was changed.';assert.equal(C.LOST_REFUSALS.BROKER_ORDER_MISMATCH,MISMATCH);
  assert.equal((await r.through('link',{order:C.shortId(o.id),number:'0000999'})).done.text,MISMATCH,'a number KIS does not list');
  x.kis.rows=[{market:'KR',orderId:'0000123',symbol:'990001',side:'Buy',quantity:11,orderPrice:12000}];
  assert.equal((await r.through('link',{order:C.shortId(o.id),number:'0000123'})).done.text,MISMATCH,'another quantity');
  assert.equal(x.a.live.orders().find(z=>z.id===o.id).status,'Uncertain');assert.deepEqual(r.alerts,[]);
  x.kis.rows=[{market:'KR',orderId:'0000123',symbol:'990001',side:'Buy',quantity:10,orderPrice:12000}];x.kis.calls.length=0;
  const {done}=await r.through('link',{order:C.shortId(o.id),number:'0000123'});
  assert.equal(done.text,'Linked to KIS order 0000123. The app follows it from here.');const after=x.a.live.orders().find(z=>z.id===o.id);assert.equal(after.brokerOrderId,'0000123');assert.notEqual(after.status,'Uncertain');
  assert.ok(x.kis.calls.length>=1&&x.kis.calls.every(([m,op])=>m==='KR'&&op==='orders'),'only the order inquiry: '+JSON.stringify(x.kis.calls));
  assert.deepEqual(r.alerts,[['A lost order reply was linked to its KIS order from the phone.','link']]);assert.equal(x.watch(),1);
});

test('the typed id: the 8-character short id or the full id, exactly; a mistyped, partial or ambiguous one is never guessed and asks no PIN',async()=>{
  const x=app();const o=x.lost('KR');const r=rig(x);await r.ready();
  for(const typed of [C.shortId(o.id).slice(0,6),C.shortId(o.id).slice(0,7)+'x',o.id.slice(0,12),'zzzzzzzz']){const m=await r.slash('nottaken',{order:typed});assert.deepEqual({kind:m.kind,text:m.text},{kind:'message',text:NOID},typed);}
  assert.equal(r.svc.core.pinState().wrong,0);assert.equal(r.svc.core.pending.size,0,'nothing held');assert.equal(r.sent.some(s=>s.kind==='modal'||s.kind==='summary'),false);
  const twin=x.lost('KR',{id:C.shortId(o.id)+randomUUID().slice(8)});const m=await r.slash('nottaken',{order:C.shortId(o.id)});
  assert.match(m.text,/^More than one order has that short id\. Type the full id: /);assert.ok(m.text.includes(o.id)&&m.text.includes(twin.id));
  assert.ok(C.lostOrdersText(x.a).includes(`(full id ${o.id})`),'/orders shows the full id when two share the short one');
  const full=await r.slash('nottaken',{order:o.id});assert.equal(full.kind,'summary','the full id is exact');assert.ok(full.text.includes(C.shortId(o.id)));
});

test('only an order still Uncertain: Accepted, Submitting, Filled and Rejected orders are refused and left as they are; no limit changes',async()=>{
  const x=app();const r=rig(x);await r.ready();const before=JSON.stringify([x.a.live.policy(),x.a.usLive.policy()]);
  for(const status of ['Accepted','Submitting','Filled','Rejected']){const o=x.lost('KR',{status});
    for(const [cmd,o2] of [['link',{order:C.shortId(o.id),number:'1'}],['nottaken',{order:C.shortId(o.id)}]]){const m=await r.slash(cmd,o2);assert.deepEqual({kind:m.kind,text:m.text},{kind:'message',text:GONE},cmd+' '+status);}
    assert.deepEqual(await C.createExecutor({automation:x.a}).run({command:'nottaken',held:{orderId:o.id,market:'KR',shown:'x'}}),{text:GONE,changed:false});assert.equal(x.a.live.orders().find(z=>z.id===o.id).status,status);}
  assert.deepEqual(x.kis.calls,[]);assert.equal(JSON.stringify([x.a.live.policy(),x.a.usLive.policy()]),before,'no limit touched');
});

test('at most once: the same PIN form twice, two /nottaken at once, two /link at once',async()=>{
  {const x=app();const o=x.lost('KR');const r=rig(x);await r.ready();const s=await r.slash('nottaken',{order:C.shortId(o.id)});await r.confirm(s.nonce);
    await Promise.all([r.pin(s.nonce),r.pin(s.nonce)]);assert.equal(r.alerts.length,1);assert.ok(r.sent.some(m=>m.text===S.expired),'the second form finds nothing held');}
  {const x=app();const o=x.lost('KR');const r=rig(x);await r.ready();const s1=await r.slash('nottaken',{order:C.shortId(o.id)});const s2=await r.slash('nottaken',{order:C.shortId(o.id)});
    await r.confirm(s1.nonce);await r.confirm(s2.nonce);await Promise.all([r.pin(s1.nonce),r.pin(s2.nonce)]);assert.equal(r.alerts.length,1);assert.ok(r.sent.some(m=>m.text===GONE),'the other: no longer lost');}
  {const x=app();const o=x.lost('KR');x.kis.rows=[{market:'KR',orderId:'0000123',symbol:'990001',side:'Buy',quantity:10,orderPrice:12000}];const ex=C.createExecutor({automation:x.a});
    const s=await ex.summary({command:'link',options:{order:o.id,number:'0000123'}});
    const outs=await Promise.all([ex.run({command:'link',options:{order:o.id,number:'0000123'},held:s.held}),ex.run({command:'link',options:{order:o.id,number:'0000123'},held:s.held})]);
    assert.equal(outs.filter(v=>v.changed).length,1,'one link');assert.ok(outs.some(v=>v.text==='That order is being handled already. Nothing more was done.'));}
});

test('the desktop handlers these follow: live:link, live:not-taken and their U.S. twins',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  assert.ok(src.includes("ipcMain.handle('live:link',liveAction((id,brokerId,phrase)=>live.linkUncertain(id,brokerId,phrase)));"));
  assert.ok(src.includes("ipcMain.handle('live:not-taken',liveAction((id,phrase)=>automation.markNotTaken('KR',id,phrase)));"));
  assert.ok(src.includes("const liveAction=action=>async(event,...args)=>{authorize(event);try{const data=await action(...args);try{automation.refreshWatchRecord?.();}catch{}return {ok:true,data,state:live.getState()};}"),'Korea: the watch record refreshed after the call');
  assert.ok(src.includes("else if(name==='link')data=await usLive.linkUncertain(...args);else if(name==='not-taken')data=automation.markNotTaken('US',...args);"));
  assert.ok(src.includes("if(['configure','stop','auto','auto-off'].includes(name))try{automation.refreshWatchRecord?.();}catch{}"),'U.S.: no refresh after link or not-taken');
  const r=require('node:fs').readFileSync(require.resolve('../src/LiveTrading.tsx'),'utf8');assert.ok(r.includes("'LINK BROKER ORDER'"));
});
