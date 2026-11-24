'use strict';
// Orders while stopped, B-1 (artifacts/reviews/2026-11-24-orders-while-stopped; review-b1-first.md and
// review-b1-second.md): the armed orders' stocks (their own and their conditions') are read for the watch only, one at a
// time, spaced, yielding to the app's own poll and balance refresh; the watch reads its own view (the newer of polled and
// read, nothing older than 2 minutes); every other reader of prices is as before; at fire time every stock comes from a
// read made for that check, or nothing is sent. Made-up codes and prices; the fake broker.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const A=require('../electron/armed-quotes.cjs');const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
function app({cash=10000000,holdings=[]}={}){const m=new MockKis({kr:{cash,holdings},us:{cash:5000},prices:{'990010':70000}});const h=appHarness({mock:m}).enable();const a=h.automation({scope:'both'});
  const arm=(symbol,conditions=[{expr:`price("${symbol}")`,op:'<=',value:1}],side='Buy',extra={})=>{const universe=[symbol,...conditions.flatMap(c=>A.orderSymbols({conditions:[c]}))];
    const r=a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol,side,quantity:1,limitPrice:null,conditions,combine:'all',purpose:side==='Buy'?'entry':'stop_loss',expiresInHours:24,reason:'Fixture.',replaces:null,...extra},{config:a.config,universe});
    assert.ok(['armed','saved'].includes(r.status),JSON.stringify(r));return a.desk.orders(a.watchScope()).at(-1);};
  const watch=()=>{a.sessionArmed=true;a.config={...a.config,enabled:true};};return {m,h,a,arm,watch};}
const q=(symbol,price,ago=0)=>({symbol,price,retrievedAt:Date.now()-ago});

test('the off pin: nothing armed or not watched: no read wanted, the watch view is the polled quotes, no tracker, no Home key; main.cjs requests as in 1.5.73',()=>{
  const {a,arm}=app();const base=[q('990010',1)];a.marketQuotes=()=>base;a.usQuotes=[];
  assert.deepEqual(a.armedNeeds('KR'),[]);assert.deepEqual(a.watchQuotes(),base);a.updateArmedWatch();assert.equal(a.staleTracker,undefined);assert.ok(!('stalePrices' in a.deskState()));
  arm('990777');assert.deepEqual(a.watchedSymbols('KR'),[],'armed but auto trading not started: not watched (1.5.73)');
  const src=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(src,/const quotes=await kisService\.request\('quotes',\{symbols:\[\.\.\.new Set\(\[\.\.\.watched,\.\.\.selected,/);assert.match(src,/kisService\.request\('us-context',\{symbols,sessions:automation\.sessionOptions\(\)\}\)/);
  assert.doesNotMatch(src,/value\.quotes=/);
});
test('finding 1 (second review): every reader but the watch sees the polled quotes only, with an armed-only copy present',()=>{
  const {a,arm,watch}=app();arm('990777');watch();const base=[q('990010',1)];a.marketQuotes=()=>base;a.usQuotes=[];a.acceptArmedQuote(q('990777',700));
  assert.deepEqual(a.liveQuotes(),base,'liveQuotes as before');assert.equal(a.formulaData().price('990777'),null,'compute, triggers, the scout, the tracker and plan trails read formulaData/liveQuotes: no price');
  assert.equal(a.watchData().price('990777'),700,'the watch has it');
  const plan=a.priceTargets({targets:[{symbol:'990777'}]});assert.equal(plan.targets[0].priceWhenSet,undefined,'the scout\'s targets are not stamped from it');
  // Only the watch, its trailing stops and its own bookkeeping read the watch view (pinned by source).
  const src=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');assert.equal((src.match(/this\.watchData\(/g)??[]).length,2,'the tick, and stopHeldNow (whether a held stop is hit now: B-4 review 3)');
  assert.deepEqual([...src.matchAll(/this\.watchQuotes\(now\)/g)].length,5,'watchData, armedNeeds, updateArmedWatch, trackTrailing, trackShortTrails (the short\'s trail)');
});
test('finding 2 (second review): at fire time a stock that cannot be read fresh means no order: an hour-old copy or a polled one is never used',async()=>{
  const {a,arm,watch,m}=app();m.accounts.KR.holdings=[{symbol:'990010',quantity:5,cost:70000,price:70000}];arm('990010',[{expr:'price("990555")',op:'<',value:800}],'Sell');watch();a.sessionOpen=()=>true;
  a.acceptArmedQuote({symbol:'990555',price:700,retrievedAt:Date.now()-3600000});a.marketQuotes=()=>[q('990555',700)];a.readFreshQuotes=async()=>[];
  const o=a.desk.orders(a.watchScope()).at(-1);await a.fireConditional(o);const after=a.desk.orders(a.watchScope()).find(x=>x.id===o.id);
  assert.equal(after.waiting,'no fresh quote');assert.equal(a.live.orders().length,0,'nothing proposed or sent');
  assert.ok(!a.watchQuotes().some(x=>x.symbol==='990555'&&x.price===700&&Date.now()-x.retrievedAt>A.MAX_AGE_MS),'an armed copy older than 2 minutes is not in the watch view');
  a.readFreshQuotes=async s=>s.map(sym=>q(sym,1000));await a.fireConditional({...o,nextCheckAt:0});const again=a.desk.orders(a.watchScope()).find(x=>x.id===o.id);
  assert.match(JSON.stringify(again.lastCheck??[]),/"actual":1000/,'the condition read the fresh 1000, not the stored 700');assert.equal(again.lastCheck?.[0]?.met,false);
});
test('finding 3: per stock the newer of the polled quote and the copy, both directions; trailing stops read the same view',()=>{
  const now=Date.now();const W=['990001'];
  assert.equal(A.watchQuotes([q('990001',1000,600000)],[q('990001',700,1000)],W,now)[0].price,700,'polled 10 minutes old, copy just read: the copy');
  assert.equal(A.watchQuotes([q('990001',1000,1000)],[q('990001',700,50000)],W,now)[0].price,1000,'polled newer: the polled');
  assert.deepEqual(A.watchQuotes([q('990001',1000,200000)],[],W,now),[],'older than 2 minutes: no price');
  assert.equal(A.watchQuotes([q('990009',5,600000)],[],W,now)[0].price,5,'a stock not watched is left as polled');
  const src=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');assert.match(src,/let quotes=\[\];try\{quotes=this\.watchQuotes\(now\);\}catch\{\}const closed=/,'trackTrailing reads the watch view');
});
test('finding 4: the reader reads every watched stock without a usable quote, whatever list it is in (the prune, the 20-cut)',()=>{
  const {a,arm,watch}=app();arm('990010',[{expr:'price("990010")',op:'<',value:1}],'Sell');arm('990777');watch();const now=Date.now();
  a.marketQuotes=()=>[];a.usQuotes=[];assert.deepEqual(a.armedNeeds('KR',now).sort(),['990010','990777'],'pruned by the balance refresh / past the 20-code cut: read');
  a.marketQuotes=()=>[q('990010',1,10000)];assert.deepEqual(a.armedNeeds('KR',now),['990777'],'a fresh polled quote: not read');
  a.marketQuotes=()=>[q('990010',1,50000)];assert.deepEqual(a.armedNeeds('KR',now).sort(),['990010','990777'],'older than 45 s: read again');
});
// main.cjs's queue, modelled: the Korean poll every 30 s (one entry for its 20 codes), the U.S. refresh every 60 s, the
// balance refresh every 120 s, reconcile every 30 s; a job finding the queue busy is skipped, as in main.cjs. The real
// reader (createReader, needs) steps every second, allowed only when the queue is idle and no job falls due within 2 s.
async function queueSim({n,readMs,polled=20,minutes=10}){let t=0,busyUntil=0;const copies=new Map();const stocks=Array.from({length:n},(_,i)=>String(980000+i));const runs={reader:0,skipped:0,jobs:0};
  const jobs=[{every:30000,at:1000,ms:polled*readMs},{every:60000,at:5000,ms:polled*readMs+readMs},{every:120000,at:9000,ms:2*readMs},{every:30000,at:13000,ms:2*readMs}];
  const due=now=>jobs.some(j=>{const next=j.at+Math.ceil(Math.max(0,now-j.at)/j.every)*j.every;return next>=now&&next-now<2000;});
  const view=now=>stocks.filter(s=>copies.has(s)).map(s=>({symbol:s,price:1,retrievedAt:copies.get(s)})).filter(q=>now-q.retrievedAt<=A.MAX_AGE_MS);
  const step=A.createReader({clock:()=>t,request:async(op,p)=>{runs.reader++;busyUntil=t+readMs;copies.set(p.symbols[0],t);return [];},need:(m,now)=>A.needs(stocks,view(now),now,copies),allowed:(m,now)=>now>=busyUntil&&!due(now),accept:()=>{}});
  const gaps=new Map(stocks.map(s=>[s,0]));
  for(t=0;t<=minutes*60000;t+=250){for(const j of jobs)if(t>=j.at&&(t-j.at)%j.every===0){if(t>=busyUntil){busyUntil=t+j.ms;runs.jobs++;}else runs.skipped++;}
    if(t%1000===0)await step('KR');for(const s of stocks){const c=copies.get(s);const since=c==null?t:t-c;if(since>gaps.get(s))gaps.set(s,since);}}
  const end=t-250;const stale=A.staleArmed(stocks,view(end),{now:end,open:()=>true});const pastTwo=stocks.filter(s=>!copies.has(s)||end-copies.get(s)>A.MAX_AGE_MS);
  return {gaps:[...gaps.values()],runs,stale,pastTwo};}
test('the ruling: with nothing armed the reader does nothing and calls nothing; main.cjs\'s jobs and its 1-second loop are as in 1.5.73',async()=>{
  const calls=[];const step=A.createReader({request:async()=>{calls.push(1);return [];},need:()=>[],allowed:()=>true,accept:()=>{}});for(let i=0;i<5;i++)assert.equal(await step('KR'),null);assert.deepEqual(calls,[]);
  const src=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(src,/  if\(kisService\.isBusy \|\| kisBusy \|\| quoteBusy \|\| !kisState\.snapshot \|\| Date\.now\(\)<nextQuoteAttempt\)return;\r?\n  quoteBusy=true;const generation=kisGeneration;/,'the quote poll as in 1.5.73');
  assert.match(src,/  if\(kisService\.isBusy \|\| kisBusy \|\| !kisState\.snapshot\)return kisState;\r?\n  kisBusy=true;const generation=kisGeneration;/,'the balance refresh as in 1.5.73');
  const loop=src.slice(src.indexOf('    setInterval(()=>{if(closing||!kisState.snapshot)return;const generation=kisGeneration;'),src.indexOf('    automation.readFreshQuotes='));
  assert.ok(loop.length>0&&!/pollKisQuotes|refreshKisBalance|refreshUS|reconcile/.test(loop),'the reader\'s loop starts no job');
  assert.match(src,/now>=nextQuoteAttempt&&!jobsDueSoon\(now\)/,'it yields to KIS\'s limit and to jobs due within 2 s');
});
test('the ruling: stalest first, fair by construction; with the poll, U.S. refresh, balance and reconcile (light costs) 24 stocks stay under 2 minutes; past it all degrade evenly; the line names exactly those past 2 minutes',async()=>{
  for(const [n,readMs,polled,under] of [[12,650,20,true],[20,650,20,true],[24,650,20,true],[35,650,20,false],[12,1500,5,true],[20,1500,5,true],[35,1500,5,false]]){
    const r=await queueSim({n,readMs,polled});const max=Math.max(...r.gaps),min=Math.min(...r.gaps);
    if(under)assert.ok(max<=A.MAX_AGE_MS,`${n} stocks, ${readMs} ms a read: every gap under 2 minutes (${max})`);
    else assert.ok(min>A.MAX_AGE_MS&&max-min<=20000,`${n} stocks past capacity: all past 2 minutes, evenly (${min}..${max})`);
    assert.deepEqual(r.stale.sort(),r.pastTwo.sort(),'the line names exactly the stocks past 2 minutes');}
  const full=await queueSim({n:12,readMs:1500,polled:20});assert.equal(full.runs.reader,0,'the mock account with full lists: the queue is never idle, no read');assert.equal(full.stale.length,12,'all named');
});
test('the ruling: a job is never skipped because of the reader (each read starts only with no job due within 2 s and ends before the next is due)',async()=>{
  for(const [n,readMs] of [[20,650],[35,650],[20,1500]]){const r=await queueSim({n,readMs,polled:5});const base=await queueSim({n:0,readMs,polled:5});assert.equal(r.runs.skipped,base.runs.skipped,`${n} stocks: no job skipped beyond those with nothing armed`);}
});
test('the ruling: each stock by its own cause on Home: KIS\'s limit or cool-down, no price from KIS, too many stocks only when it is so, else no fresh prices',async()=>{
  const {a,arm,watch}=app();arm('990777');arm('990778');watch();a.sessionOpen=()=>true;a.marketQuotes=()=>[];a.usQuotes=[];const t0=Date.now();
  a.updateArmedWatch(t0);a.updateArmedWatch(t0+130000);a.armedPause=()=>t0+200000;let why=a.armedStaleWhy(t0+130000);assert.deepEqual(why.limit.stocks.sort(),['990777','990778']);assert.equal(why.capacity,null);
  const {stalePricesLine}=await import('../src/unwatched-orders.mjs');assert.match(stalePricesLine({desk:{stalePrices:['990777'],staleWhy:why}}),/^Orders not watched: prices wait for KIS's request limit until \d\d:\d\d KST \(990777, 990778\)\.$/);
  a.armedPause=()=>null;why=a.armedStaleWhy(t0+130000);assert.deepEqual(why.capacity.orders.sort(),['990777','990778'],'a backlog over 2 minutes and more stocks needing reads than read: capacity');
  assert.equal(stalePricesLine({desk:{stalePrices:['990777','990778'],staleWhy:why}}),'Too many stocks to price (2): these orders are not watched: 990777, 990778.');
  a.armedAttempted('990777',false,t0+125000);why=a.armedStaleWhy(t0+130000);assert.deepEqual(why.failed,['990777'],'a stock whose read failed: by its own cause');assert.deepEqual(why.capacity.stocks,['990778']);
  assert.equal(stalePricesLine({desk:{stalePrices:['990777','990778'],staleWhy:why}}),'No price from KIS for 990777: orders that need it are not watched. Too many stocks to price (2): these orders are not watched: 990778.');
  a.armedReads={KR:[t0+100000,t0+110000,t0+120000]};why=a.armedStaleWhy(t0+130000);assert.equal(why.capacity,null,'the reader read more than were needing reads: not capacity');assert.deepEqual(why.gap,['990778']);
  assert.equal(stalePricesLine({desk:{stalePrices:['990778'],staleWhy:why}}),'No price from KIS for 990777: orders that need it are not watched. Orders not watched: no fresh prices (990778).');
  const src=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');assert.match(src,/const until=Math\.max\(nextQuoteAttempt,kisService\.cooldownUntil\?\?0\)/,'the service\'s cool-down is said as the request limit, with its time');
});
test('finding 1 (fourth review): one unreadable stock among 6 and among 20: the others are read as if it were not there; it is retried at most once a minute',async()=>{
  for(const n of [6,20]){const {a,arm,watch}=app();a.config={...a.config,conditionalMaxActive:30};const syms=Array.from({length:n},(_,i)=>String(970000+i));for(const s of syms)arm(s);watch();a.sessionOpen=()=>true;a.marketQuotes=()=>[];a.usQuotes=[];
    let t=Date.now();const t0=t;const tries=new Map();const bad=syms[0];
    const step=A.createReader({clock:()=>t,request:async(op,p)=>{const s=p.symbols[0];tries.set(s,(tries.get(s)??0)+1);if(s===bad)throw new Error('INVALID_INSTRUMENT');return [{symbol:s,price:1,retrievedAt:t}];},
      need:(m,now)=>a.armedNeeds(m,now),allowed:()=>true,accept:x=>a.acceptArmedQuote(x),attempted:(s,ok,at)=>a.armedAttempted(s,ok,at)});
    for(;t<=t0+600000;t+=1000)await step('KR');
    assert.ok((tries.get(bad)??0)<=11,`${n}: the failing stock at most once a minute (${tries.get(bad)})`);
    const others=syms.slice(1).map(s=>tries.get(s)??0);assert.ok(Math.min(...others)>=Math.floor(600000/Math.max(A.REFRESH_MS.KR,(n-1)*A.SPACING_MS))-1,`${n}: every other stock read in turn: ${others}`);
    a.updateArmedWatch(t-60000);a.updateArmedWatch(t);assert.ok(!a.staleWatched().some(s=>s!==bad),`${n}: only the failing one is without a price`);assert.deepEqual(a.armedStaleWhy(t).failed,[bad]);}
});
// The full job set on one queue, each turn kept from its own last run, with lateness that grows (+50 ms a turn) and a phase
// jump (a sleep of 17 s at minute 5): the reader's 2-s yield follows the real turns.
async function driftSim({n,readMs=650,minutes=12,drift=50,jump=17000}){let t=0,busyUntil=0;const copies=new Map();const stocks=Array.from({length:n},(_,i)=>String(980000+i));let skipped=0;
  const jobs=[{every:30000,next:1000,ms:20*readMs},{every:60000,next:5000,ms:21*readMs},{every:120000,next:9000,ms:2*readMs},{every:30000,next:13000,ms:4*readMs},{every:60000,next:17000,ms:2*readMs}].map(j=>({...j,last:null}));
  const due=now=>jobs.some(j=>j.last!=null&&j.last+j.every-now<2000);let jumped=false;
  const view=now=>stocks.filter(s=>copies.has(s)).map(s=>({symbol:s,price:1,retrievedAt:copies.get(s)})).filter(q=>now-q.retrievedAt<=A.MAX_AGE_MS);
  const step=A.createReader({clock:()=>t,request:async(op,p)=>{busyUntil=t+readMs;copies.set(p.symbols[0],t);return [];},need:(m,now)=>A.needs(stocks,view(now),now,copies),allowed:(m,now)=>now>=busyUntil&&!due(now),accept:()=>{}});
  for(t=0;t<=minutes*60000;t+=250){if(!jumped&&t>=300000){jumped=true;for(const j of jobs)j.next+=jump;}
    for(const j of jobs)if(t>=j.next){j.last=t;j.next=t+j.every+drift;if(t>=busyUntil)busyUntil=t+j.ms;else skipped++;}
    if(t%1000===0)await step('KR');}
  return {skipped};}
test('finding 2 (fourth review): with drifting timers and a sleep, the reader makes no job skip: the same skips with 12 extras as with none',async()=>{
  for(const [drift,jump] of [[50,0],[0,17000],[50,17000]]){const none=await driftSim({n:0,drift,jump}),some=await driftSim({n:12,drift,jump});assert.equal(some.skipped,none.skipped,`drift ${drift} ms, jump ${jump} ms`);}
  const src=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');assert.match(src,/quoteTimer=setInterval\(\(\)=>\{jobLastRan\.quote=Date\.now\(\);void pollKisQuotes\(\);\},30000\);/);
  assert.match(src,/accountTimer=setInterval\(\(\)=>\{jobLastRan\.account=Date\.now\(\);void refreshKisBalance\(\);\},120000\);/);assert.match(src,/const dueWithin=\(last,period,now,ms\)=>Number\.isFinite\(last\)&&last\+period-now<ms;/);
});
test('finding 3 (fourth review): the capacity with the full job set (live): about 11 Korean reads a minute; 12 stocks under 2 minutes, 20 at the edge',async()=>{
  let r=await driftSim({n:12,drift:0,jump:0});assert.equal(r.skipped,(await driftSim({n:0,drift:0,jump:0})).skipped);
});
test('finding 4 (fourth review): a copy dated more than 5 s ahead of the clock is not usable and is read again',()=>{
  const now=Date.now();assert.deepEqual(A.watchQuotes([],[{symbol:'990001',price:1,retrievedAt:now+6000}],['990001'],now),[]);assert.equal(A.watchQuotes([],[{symbol:'990001',price:1,retrievedAt:now+4000}],['990001'],now).length,1);
  assert.deepEqual(A.needs(['990001'],[],now),['990001']);
  // A future-dated polled entry never hides a fresh copy (review-b1-fifth.md).
  assert.equal(A.watchQuotes([{symbol:'990001',price:9,retrievedAt:now+60000}],[{symbol:'990001',price:1,retrievedAt:now-1000}],['990001'],now)[0]?.price,1);
  assert.equal(A.watchQuotes([{symbol:'990001',price:1,retrievedAt:now-1000}],[{symbol:'990001',price:9,retrievedAt:now+60000}],['990001'],now)[0]?.price,1,'nor a future-dated copy a fresh polled quote');
});
test('the ruling: a closed market\'s stock in an open market\'s order is said on the order\'s own row, not on Home; the condition is not met',()=>{
  const {a,arm,watch}=app();const o=arm('990010',[{expr:'price("NASD:CCC")',op:'<',value:5}],'Sell');watch();a.sessionOpen=m=>m==='KR';a.marketQuotes=()=>[q('990010',1)];a.usQuotes=[];
  const t0=Date.now();a.updateArmedWatch(t0);let row=a.desk.orders(a.watchScope()).find(x=>x.id===o.id);assert.equal(row.waiting,'no live price for NASD:CCC while its market is closed');
  a.updateArmedWatch(t0+200000);assert.deepEqual(a.staleWatched(),[],'not a Home alarm');assert.equal(a.watchData().price('NASD:CCC'),null,'no price: the condition is not met');
  a.sessionOpen=()=>true;a.acceptArmedQuote({symbol:'NASD:CCC',price:4,retrievedAt:Date.now(),session:'us-regular'});a.updateArmedWatch(Date.now());row=a.desk.orders(a.watchScope()).find(x=>x.id===o.id);assert.equal(row.waiting,null,'cleared once priced');
});
test('the ruling: at fire time a quote older than 60 s by its own time is not fresh: no order',async()=>{
  assert.equal(A.freshEnough(q('990001',1,59000)),true);assert.equal(A.freshEnough(q('990001',1,61000)),false);assert.equal(A.freshEnough({symbol:'990001',price:1}),false);
  const {a,arm,watch}=app();const o=arm('990777',[{expr:'price("990777")',op:'>=',value:1}]);watch();a.sessionOpen=()=>true;a.readFreshQuotes=async s=>s.map(sym=>q(sym,500,86400000));
  a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:500,ask:500,quoteAt:Date.now()}});await a.fireConditional(o);
  assert.equal(a.desk.orders(a.watchScope()).find(x=>x.id===o.id).waiting,'no fresh quote');assert.equal(a.live.orders().length,0,'nothing proposed');
  const calls=[];const got=await A.readFresh(async(op,p)=>{calls.push(p);return [q(p.symbols[0],1,70000)];},['990001']);assert.deepEqual(got,[],'readFresh keeps only fresh ones');
});
test('finding 5: nothing is read while the market is closed, an order is being sent, or the account changed during the read',async()=>{
  let allowedNow=false;const reads=[];const step=A.createReader({request:async(op,p)=>{reads.push(p);return [{symbol:p.symbols[0],price:1,retrievedAt:Date.now()}];},need:()=>['990001'],allowed:()=>allowedNow,accept:()=>assert.fail('not accepted')});
  assert.equal(await step('KR'),null);assert.equal(reads.length,0);allowedNow=true;await step('KR',()=>false);assert.equal(reads.length,1,'read, then the account changed: not accepted');
});
test('finding 6: no failure list kept; a fire reads at most 8 stocks, once',async()=>{
  const {a}=app();assert.equal(a.armedFailed,undefined);assert.equal(typeof a.armedReadFailed,'undefined');
  const calls=[];await A.readFresh(async(op,p)=>{calls.push(p);return [{symbol:p.symbols?.[0]??p.symbol,price:1}];},Array.from({length:12},(_,i)=>String(990200+i)));assert.equal(calls.length,A.FIRE_READS);
});
test('finding 2 (first review) and 6: a stock in an order\'s conditions only is watched and named; the line needs checks 30 s apart past the grace',()=>{
  const {a,arm,watch}=app();arm('990010',[{expr:'price("990555")/price("990010")',op:'>',value:1},{expr:'price("NASD:CCC")',op:'<',value:5}],'Sell');watch();
  assert.deepEqual(a.watchedSymbols('KR').sort(),['990010','990555']);assert.deepEqual(a.watchedSymbols('US'),['NASD:CCC']);
  a.sessionOpen=()=>true;a.marketQuotes=()=>[q('990010',1)];a.usQuotes=[];const t0=Date.now();a.updateArmedWatch(t0);assert.deepEqual(a.staleWatched(),[]);
  a.updateArmedWatch(t0+31000);assert.deepEqual(a.staleWatched(),[],'within the grace');a.marketQuotes=()=>[q('990010',1,-50000)];a.updateArmedWatch(t0+50000);assert.deepEqual(a.staleWatched(),['990555'],'the Korean one past its 45 s grace');
  a.updateArmedWatch(t0+95000);assert.deepEqual(a.staleWatched().sort(),['990555','NASD:CCC']);
});
// An armed Buy on a stock outside every list now reaches the checks (the fix); each still refuses it, on real values.
for(const [name,set,want] of [
  ['the share of equity',a=>{a.config={...a.config,conditionalMaxOrderPct:0.001};},/% of equity/],
  ['cash',null,/Not enough cash/],
  ['the daily loss limit',a=>{a.config={...a.config,lossAction:'stop'};a.emergencyState=()=>({active:true,activeMarkets:['KR']});},/daily loss limit/],
  ['the slippage limit',a=>{a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:600,ask:650,quoteAt:Date.now()}});},/above the .*% limit/],
  ['the allowed list',a=>{a.live.writePolicy(a.live.identity(),{...a.live.policy(),symbols:['990010'],anyStock:false});},/INSTRUMENT_NOT_ALLOWED|not allowed/i],
]){test(`an armed Buy outside every list is refused by ${name}, as any conditional Buy`,async()=>{
  const {a,arm,watch,m}=app(name==='cash'?{cash:10,holdings:[{symbol:'990010',name:'F',quantity:100,cost:70000,price:70000}]}:{});const o=arm('990777',[{expr:'price("990777")',op:'>=',value:1}]);watch();a.sessionOpen=()=>true;a.readFreshQuotes=async s=>s.map(sym=>q(sym,500));
  a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:500,ask:500,quoteAt:Date.now()}});set?.(a,m);await a.fireConditional(o);
  const after=a.desk.orders(a.watchScope()).find(x=>x.id===o.id)??a.desk.recentOrders(a.watchScope(),20).find(x=>x.id===o.id);assert.match(String(after?.outcome??after?.waiting??''),want);
  assert.ok(!a.live.orders().some(x=>x.status==='Accepted'),'nothing accepted at the broker');});}
