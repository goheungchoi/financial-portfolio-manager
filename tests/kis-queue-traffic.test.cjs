// 2026-11-19 overnight failures, B (artifacts/reviews/2026-11-19-overnight-failures): KIS requests failed overnight and
// the 1.5.66 queue was suspected. It is driven here with that night's kinds of traffic and fails, loses or sticks no
// request by itself. B(1): every failed request leaves a record (operation, code, KIS code, waited and ran, whether it
// was refused before sending). Fake worker: no broker.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {KisService}=require('../electron/kis-service.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function svc(){const s=new KisService();const starts=[];s.send=async(op,p)=>{starts.push(op);await sleep(p?.ms??10);if(p?.fail)throw Object.assign(new Error(p.fail),p.brokerCode?{brokerCode:p.brokerCode}:{});return {op};};s.starts=starts;const failures=[];s.onFailure=r=>failures.push(r);s.seen=failures;return s;}
const settle=p=>p.then(()=>'ok',e=>'FAIL '+e.message);

test('a slow read, an order holding the queue and a quote poll arriving meanwhile: all answered, in order, nothing left',async()=>{
  const s=svc();const r=await Promise.all([settle(s.request('orders',{ms:120})),settle(s.hold(async()=>{await s.request('prepare-order',{ms:20});return s.request('place-order',{ms:20});},{label:'Buy 2 X'})),
    (async()=>{await sleep(5);return settle(s.request('quotes',{ms:5}));})()]);
  assert.deepEqual(r,['ok','ok','ok']);assert.deepEqual(s.starts,['orders','prepare-order','place-order','quotes'],'the poll waits for the order');
  assert.equal(s.queued,0);assert.equal(s.line.length,0);assert.equal(s.seen.length,0);});

test('a hold released by its limit while the order\'s request is out: the waiting poll runs, the order\'s next request waits in line',async()=>{
  const s=svc();let limit=null;s.onHoldLimit=x=>{limit=x;};
  const order=settle(s.hold(async()=>{await s.request('prepare-order',{ms:80});return s.request('place-order',{ms:5});},{label:'Buy',limitMs:30}));
  await sleep(2);const poll=settle(s.request('quotes',{ms:5}));
  assert.deepEqual(await Promise.all([order,poll]),['ok','ok']);assert.ok(limit,'the limit is said');assert.deepEqual(s.starts,['prepare-order','quotes','place-order']);
  assert.equal(s.queued,0);assert.equal(s.line.length,0);});

test('a holder that throws, a refusal in line, two holds: no request behind them fails or sticks',async()=>{
  const s=svc();const r=await Promise.all([settle(s.hold(async()=>{await s.request('prepare-order',{ms:5});throw new Error('FUNDING_OVERCOMMITTED');})),settle(s.request('quotes',{ms:5})),settle(s.request('balance',{ms:5}))]);
  assert.deepEqual(r,['FAIL FUNDING_OVERCOMMITTED','ok','ok']);
  const t=svc();assert.deepEqual(await Promise.all([settle(t.request('live-context',{fail:'BROKER_REJECTED'})),settle(t.request('quotes'))]),['FAIL BROKER_REJECTED','ok'],'a refusal fails only itself');
  const u=svc();assert.deepEqual(await Promise.all([settle(u.hold(async()=>u.request('place-order'),{label:'A'})),settle(u.request('quotes')),settle(u.hold(async()=>u.request('place-order'),{label:'B'}))]),['ok','ok','ok']);
  assert.deepEqual(u.starts,['place-order','quotes','place-order']);for(const x of [s,t,u]){assert.equal(x.queued,0);assert.equal(x.line.length,0);}});

test('B(1): a failed request leaves a record with its code, KIS\'s code, wait and run; refused before sending says so; nothing else',async()=>{
  const s=svc();await settle(s.request('orders',{ms:40}));const p=settle(s.request('live-context',{ms:10,fail:'BROKER_REJECTED',brokerCode:'EGW00123'}));
  await p;const [r]=s.seen;assert.equal(r.operation,'live-context');assert.equal(r.code,'BROKER_REJECTED');assert.equal(r.brokerCode,'EGW00123');
  assert.equal(r.notSent,false);assert.ok(r.ranMs>=5);assert.ok(Number.isFinite(r.waitedMs));assert.deepEqual(Object.keys(r).sort(),['at','brokerCode','code','notSent','operation','ranMs','waitedMs']);
  s.cooldownUntil=Date.now()+60000;await settle(s.request('quotes'));const c=s.seen.at(-1);assert.equal(c.code,'RATE_LIMITED');assert.equal(c.cooldown,true);assert.equal(c.notSent,true);assert.equal(c.ranMs,null);
  s.cooldownUntil=0;const q=s.request('balance',{ms:30});s.disconnect();await settle(q);assert.ok(s.seen.length>=2);
  for(let i=0;i<210;i++)s.noteFailure('quotes',new Error('REQUEST_TIMEOUT'),{enqueuedAt:Date.now(),startedAt:Date.now(),generation:s.generation});assert.equal(s.failures.length,200,'the last 200');
  s.noteFailure('quotes',new Error('a message with text'),{enqueuedAt:Date.now(),startedAt:null,generation:s.generation});assert.equal(s.failures.at(-1).code,'UNKNOWN','free text is never kept');});

test('B(1) and B(3) wiring: main stores the records; the Market feed names the request and says "Reconnecting" only for the stream',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(main,/CREATE TABLE IF NOT EXISTS kis_failures/);assert.match(main,/kisService\.onFailure=record=>/);
  assert.ok(main.includes("...failedRequest('quotes',error)")&&main.includes("...failedRequest('balance',error)"));
  assert.ok(main.includes("if(kisState.status==='error'&&kisState.errorRequest==='quotes')kisState={...kisState,status:'connected',error:null,errorRequest:null,errorAt:null,brokerCode:null};"),'a good poll clears the poll\'s error');
  const {buildKisMarket}=require('../electron/kis-market.cjs');const snap={environment:'live',timestamp:'x',cash:0,reportedTotal:0,holdings:[]};
  assert.deepEqual(buildKisMarket({status:'error',error:'BROKER_REJECTED',errorRequest:'quotes',errorAt:5,brokerCode:'EGW00123',snapshot:snap},new Map()).failure,{code:'BROKER_REJECTED',request:'quotes',at:5,brokerCode:'EGW00123'});
  assert.equal(buildKisMarket({status:'connected',snapshot:snap},new Map()).failure,undefined);
  const shell=fs.readFileSync(path.join(__dirname,'../src/Shell.tsx'),'utf8');
  assert.ok(shell.includes("if(market.stream?.status==='reconnecting')return 'Reconnecting';"));assert.ok(shell.includes("if(market.status==='error')return 'Request failed';"));
  assert.ok(shell.includes("if(market.status==='stale'||stale)return market.marketsOpen===false?'Closed':'Stale';"));assert.doesNotMatch(shell,/'Live'\):'Reconnecting'/);});

// The planner, 2026-11-19: whether integrated margin is on could not be read from the records. The stored U.S. reading
// keeps KIS's two buying-power figures and the flag; a change in them alone is stored as a new reading.
test('the stored U.S. reading keeps KIS\'s buying-power figures and the integrated-margin flag',()=>{
  const {DatabaseSync}=require('node:sqlite');const {BrokerBalances}=require('../electron/broker-raw.cjs');const db=new DatabaseSync(':memory:');const b=new BrokerBalances(db);
  const snap=bp=>({timestamp:'t',raw:{output2:[{a:1}]},brokerBuyingPower:bp});
  assert.equal(b.record('acct:US','US',snap({foreignUSD:500,integratedUSD:2500,rate:1400})),true);
  const row=()=>JSON.parse(db.prepare('SELECT payload FROM broker_balances ORDER BY id DESC LIMIT 1').get().payload);
  assert.deepEqual(row().buyingPower,{foreignUSD:500,integratedUSD:2500,integratedMargin:true});
  assert.equal(b.record('acct:US','US',snap({foreignUSD:500,integratedUSD:2500,rate:1400})),false,'unchanged: not stored again');
  assert.equal(b.record('acct:US','US',snap({foreignUSD:500,integratedUSD:500,rate:1400})),true,'the flag changed: stored');assert.equal(row().buyingPower.integratedMargin,false);
  assert.equal(b.record('acct','KR',{timestamp:'t',raw:{x:1}}),true);assert.equal(row().buyingPower,undefined,'Korea: none');});

// The planner, 2026-11-19: what the Market feed chip reads, for each stream status and with every market closed.
test('the Market feed chip: Reconnecting and Unavailable for the stream; Request failed; Closed when only the markets are shut; Stale; Live',()=>{
  const ts=require('typescript');const React=require('react');const src=fs.readFileSync(path.join(__dirname,'../src/Shell.tsx'),'utf8');
  const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};new Function('require','module','exports',js)(n=>n.startsWith('.')?new Proxy({},{get:(_,k)=>k==='__esModule'?true:()=>null}):require(n),mod,mod.exports);const {feedLabel,feedTone,failureLine}=mod.exports;
  const m=(status,stream,extra={})=>({status,stream:{status:stream,subscribed:3},quotes:[],...extra});
  assert.equal(feedLabel(m('connected','reconnecting'),false),'Reconnecting');assert.equal(feedLabel(m('connected','unavailable'),false),'Unavailable');
  assert.equal(feedLabel(m('error','streaming'),false),'Request failed');
  for(const s of ['disconnected','idle','connecting','subscribing','streaming']){assert.equal(feedLabel(m('connected',s),false),'Live',s);assert.equal(feedLabel(m('stale',s,{marketsOpen:true}),false),'Stale',s);assert.equal(feedLabel(m('stale',s,{marketsOpen:false}),false),'Closed',s);}
  assert.equal(feedLabel(m('stale','streaming',{marketsOpen:null}),false),'Stale','unknown session: Stale');
  assert.equal(feedTone(m('stale','idle',{marketsOpen:false}),false),'muted');assert.equal(feedTone(m('connected','streaming'),false),'success');assert.equal(feedTone(m('error','streaming'),false),'warning');
  assert.equal(failureLine({status:'error',error:'BROKER_REJECTED',failure:{code:'BROKER_REJECTED',request:'quotes',at:Date.parse('2026-11-11T21:38:00Z'),brokerCode:'EGW00123'}}),'The last quote poll failed: BROKER_REJECTED (KIS EGW00123) at 06:38 KST.');
  assert.ok(src.includes("{feedLabel(market,Boolean(stale))==='Closed'&&<p>Markets closed"),'the tooltip says so');
  assert.match(fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8'),/marketsOpen:marketsOpenNow\(\)/);});

// B(2): a failed request's error names the operation it came from, so a failed review can say which request failed.
test('B(2): the error of a failed request carries its operation; an existing one is not overwritten',async()=>{
  const s=svc();const e=await s.request('live-context',{fail:'REQUEST_TIMEOUT',brokerCode:'EGW00201'}).catch(x=>x);
  assert.equal(e.message,'REQUEST_TIMEOUT');assert.equal(e.kisOperation,'live-context');assert.equal(e.brokerCode,'EGW00201');
  const t=svc();t.send=async()=>{throw Object.assign(new Error('BROKER_REJECTED'),{kisOperation:'inner'});};assert.equal((await t.request('quotes').catch(x=>x)).kisOperation,'inner');
  const u=svc();const held=await u.hold(async()=>u.request('prepare-order',{fail:'BROKER_REJECTED'}).catch(x=>x));assert.equal(held.kisOperation,'prepare-order','inside a hold too');});

// The planner, 2026-11-19: KisService also runs the AI provider and calendar workers. Only the KIS broker worker's
// requests are tagged (kisOperation) and recorded, so an AI error is never shown or stored as a KIS one.
test('the AI provider and calendar services tag nothing and record nothing; the KIS service does',async()=>{
  for(const script of ['provider-worker.cjs','calendar-worker.cjs']){const s=new KisService(script);const seen=[];s.onFailure=r=>seen.push(r);s.send=async()=>{throw new Error('RATE_LIMITED');};
    const e=await s.request('review',{}).catch(x=>x);assert.equal(e.message,'RATE_LIMITED');assert.equal('kisOperation' in e,false,script);assert.equal(seen.length,0,script);assert.equal(s.failures,undefined,script);}
  const k=svc();const e=await k.request('quotes',{fail:'RATE_LIMITED'}).catch(x=>x);assert.equal(e.kisOperation,'quotes');assert.equal(k.seen.length,1);assert.equal(new KisService().isKis,true);});
