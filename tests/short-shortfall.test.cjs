// The shortfall of open shorts held back from the app's own buys (the user's answer, 2026-11-24: "Yes hold it back").
// Made-up codes, prices and figures.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const R=require('../electron/short-rules.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const LOSING={symbol:'990010',quantity:10,price:1200,proceeds:10000,loanDate:'2026-09-03'};
const WINNING={symbol:'990020',quantity:5,price:800,proceeds:5000,loanDate:'2026-09-03'};
test('the rule: max(0, quantity x price - proceeds) per open short, summed; unknown with no price or proceeds; nothing with no short',()=>{
  assert.deepEqual(R.shortfall({shorts:[LOSING,WINNING]}),{open:2,known:true,amount:2000,rows:[{symbol:'990010',loanDate:'2026-09-03',amount:2000}],missing:[]},'a winning short does not offset a losing one');
  assert.deepEqual(R.shortfall({shorts:[]}),{open:0,known:true,amount:0,rows:[],missing:[]});assert.equal(R.shortfall({}).open,0);assert.equal(R.shortfall(null).open,0);
  assert.equal(R.shortfall({shorts:[{...LOSING,quantity:0}]}).open,0,'a closed lot\'s zero row');
  for(const bad of [{price:null},{price:0},{proceeds:null},{proceeds:undefined},{proceeds:NaN},{proceeds:-1}])assert.deepEqual(R.shortfall({shorts:[{...LOSING,...bad},WINNING]}),{open:2,known:false,amount:0,rows:[],missing:['990010']},JSON.stringify(bad));
});
function ledger(kr){const l=new FundingLedger(new DatabaseSync(':memory:'),{fresh:async m=>m==='KR'?kr:null});l.verifiedRegime='separate';return l;}
const bal=(shorts,cash=5000)=>({accountKey:'acct',environment:'live',timestamp:new Date().toISOString(),cash,settledCash:cash,holdings:[],...(shorts?{shorts}:{})});
const order=(id,extra={})=>({id,accountKey:'acct',symbol:'990030',side:'Buy',quantity:1,limitPrice:3500,status:'Ready',market:'KR',...extra});
test('the funding check: held back from Korean cash for the app\'s buys; your ticket is not held; unreadable: the buy waits; no short: as before',async()=>{
  // 5,000 cash, 2,000 held back: a 3,500 buy does not fit, 3,000 does.
  let kr=bal([LOSING,WINNING]);let l=ledger(kr);
  await assert.rejects(l.admit({order:order('A'),market:'KR',cost:3500,balance:kr,environment:'live'}),e=>e.message==='INSUFFICIENT_CAPACITY'&&/after 2000 held back for losing shorts/.test(e.detail));
  const ok=await l.admit({order:order('B'),market:'KR',cost:3000,balance:kr,environment:'live'});assert.equal(ok.have,3000);assert.equal(ok.shortfallHeld,2000);
  // Your ticket: the whole cash.
  l=ledger(kr);const t=await l.admit({order:order('T',{madeBy:'ticket'}),market:'KR',cost:3500,balance:kr,environment:'live',holdShortfall:false});assert.equal(t.have,5000);assert.equal('shortfallHeld' in t,false);
  // Unreadable while a short is open: the buy waits with words; your ticket is not held.
  kr=bal([{...LOSING,price:null}]);l=ledger(kr);
  await assert.rejects(l.admit({order:order('U'),market:'KR',cost:1,balance:kr,environment:'live'}),e=>e.message==='SHORT_SHORTFALL_UNKNOWN'&&e.detail===R.SHORTFALL_UNKNOWN_WORDS);
  assert.equal((await l.admit({order:order('V',{madeBy:'ticket'}),market:'KR',cost:1,balance:kr,environment:'live',holdShortfall:false})).have,5000);
  // No short open, or only winning shorts: exactly as before (the pin).
  for(const shorts of [undefined,[],[WINNING],[{...LOSING,quantity:0}]]){kr=bal(shorts);l=ledger(kr);const c=await l.admit({order:order('N'),market:'KR',cost:5000,balance:kr,environment:'live'});assert.equal(c.have,5000,JSON.stringify(shorts));assert.equal(c.detail,'needs 5000 against 5000 (separate regime)');assert.equal('shortfallHeld' in c,false);}
  // A price-raising revision of the app's buy: held too; of your ticket: not.
  kr=bal([LOSING]);l=ledger(kr);l.write({...FundingLedger.commitment({...order('R'),status:'Submitting'}),state:'reserved'});
  await assert.rejects(l.admitRevision({order:order('R'),market:'KR',price:3600,balance:kr,environment:'live'}),/INSUFFICIENT_CAPACITY/);
  l=ledger(kr);l.write({...FundingLedger.commitment({...order('R2',{madeBy:'ticket'}),status:'Submitting'}),state:'reserved'});assert.ok((await l.admitRevision({order:order('R2',{madeBy:'ticket'}),market:'KR',price:3600,balance:kr,environment:'live'})).delta>0);
});
test('the U.S.: a buy funded from Korean cash is held back the same; with separate funds it is not',async()=>{
  const kr=bal([LOSING],5000);const l=ledger(kr);l.verifiedRegime='integrated-unknown';
  const room=l.capacityFrom({account:'acct',market:'US',kr,us:{cash:0},rate:1000});const plain=ledger(bal([],5000));plain.verifiedRegime='integrated-unknown';
  assert.ok(room<plain.capacityFrom({account:'acct',market:'US',kr:bal([],5000),us:{cash:0},rate:1000}),'less room for a U.S. buy');
  assert.equal(l.capacityFrom({account:'acct',market:'US',kr:bal([{...LOSING,proceeds:null}]),us:{cash:0},rate:1000}),null,'unknown: no room given');
  l.verifiedRegime='separate';assert.equal(l.capacityFrom({account:'acct',market:'US',kr,us:{cash:7},rate:1000}),7,'separate: U.S. cash only');
  assert.equal(l.capacityFrom({account:'acct',market:'KR',kr,rate:1000}),3000,'Korea: the reviews read the room after the holdback');
});
test('the engine passes the holdback for its own buys and not for your ticket; covers and margin buys never reach the check',()=>{
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','live-engine.cjs'),'utf8');
  assert.match(src,/if\(this\.funding&&order\.side==='Buy'&&!\['margin-buy','cover'\]\.includes\(order\.credit\?\.kind\)\)\{await this\.funding\.admit\(\{order,market:this\.market,cost:FundingLedger\.perShare\(order\)\*order\.quantity,balance:prepared\.balance,environment,holdShortfall:order\.madeBy!=='ticket',/);
  assert.equal(require('../electron/order-outcomes.cjs').classOf('SHORT_SHORTFALL_UNKNOWN'),'order');
});
test('review 1: a conditional buy waiting on an unreadable shortfall re-checks at most every 5 minutes, with no read, pricing, proposal or line between; one line per episode; per account and market',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const store=new Map();const events=[];let priced=0,proposed=0,sends=0,reads=0;
  const live={market:'KR',enabled:true,autoEnabled:true,identity:()=>'acct',getState:()=>({}),riskBalance:{shorts:[{...LOSING,price:null}]},orders:()=>[...store.values()],
    context:async()=>{reads++;return {market:'KR',equity:1e7,cash:5e6,positions:{},quotes:[{symbol:'990030',price:1000,timestamp:Date.now()}],marketSession:{open:true}};},
    propose:c=>{proposed++;const o={id:'P'+(store.size+1),status:'Ready',...c};store.set(o.id,o);return o;},annotate:(id,p)=>store.set(id,{...store.get(id),...p}),autoSubmit:async()=>{sends++;const e=new Error('SHORT_SHORTFALL_UNKNOWN');e.detail=R.SHORTFALL_UNKNOWN_WORDS;throw e;}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990030',name:'F',price:1000}],()=>[]),{request:async()=>({})},(id,k,title,body)=>events.push({title,body}));a.live=live;a.usLive=null;
  a.configure({scope:'kis',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});a.orderBook=async()=>{priced++;return {status:'available',retrievedAt:Date.now(),data:{bid:999,ask:1000}};};a.emergencyState=()=>({active:false});a.marketQuotes=()=>[{symbol:'990030',price:1000,timestamp:Date.now()}];
  const r=a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990030',side:'Buy',quantity:1,limitPrice:null,conditions:[{expr:'price("990030")',op:'>=',value:999}],combine:'all',purpose:'entry',expiresInHours:2,reason:'fixture'},{config:a.config,universe:['990030']});
  const row=()=>a.desk.rows('conditional_orders',a.watchScope()).find(x=>x.id===r.id);await a.fireConditional(row());
  assert.equal(row().waiting,R.SHORTFALL_UNKNOWN_WORDS);assert.ok(row().nextCheckAt>=Date.now()+299000,'5 minutes');assert.deepEqual([reads,proposed,sends],[1,1,1]);
  for(let i=0;i<3;i++)await a.fireConditional(row());assert.deepEqual([reads,proposed,sends,priced],[1,1,1,1],'checks within the 5 minutes: no read, pricing, proposal or send');
  assert.equal(events.filter(e=>e.title==='Conditional order · waiting').length,1,'one line');assert.equal(events.filter(e=>e.title==='Order priced').length,1,'only the first attempt priced it');
  a.shortfallWait.KR.at=Date.now()-301000;await a.fireConditional(row());assert.deepEqual([proposed,sends],[2,2],'after 5 minutes: one attempt');assert.equal(events.filter(e=>e.title==='Order priced').length,1,'no priced line while waiting');assert.equal(events.filter(e=>e.title==='Conditional order · waiting').length,1);
  a.shortfallWait.KR={account:'other',at:Date.now()};live.autoSubmit=async id=>{sends++;const o={...store.get(id),status:'Accepted'};store.set(id,o);return o;};await a.fireConditional(row());assert.equal(row().status,'submitted','another account\'s wait does not hold this one');
  assert.equal(require('../electron/activity-today.cjs').NOT_SENT.SHORT_SHORTFALL_UNKNOWN,'a short is open and what buying it back costs beyond its proceeds could not be read, so buys wait');
});
test('review 2: unknown holds only what a known shortfall would: Korean cash and U.S. buys drawing on it; a U.S. buy from separate USD is not refused',async()=>{
  const kr=bal([{...LOSING,price:null}],5000);const us={accountKey:'acct:US',environment:'live',timestamp:new Date().toISOString(),cash:100,settledCash:100,holdings:[],fx:{usdKRW:1000,timestamp:Date.now()}};
  const l=new FundingLedger(new DatabaseSync(':memory:'),{fresh:async m=>m==='KR'?kr:us});l.verifiedRegime='separate';
  assert.equal(l.capacityFrom({account:'acct',market:'US',kr,us,rate:1000}),100,'separate: the room is given');
  const c=await l.admit({order:{...order('US1'),market:'US',symbol:'AAPL',limitPrice:50},market:'US',cost:50,balance:us,environment:'live',other:kr});assert.equal(c.have,100,'separate USD: not held');assert.equal('shortfallHeld' in c,false);
  await assert.rejects(l.admit({order:order('K1'),market:'KR',cost:1,balance:kr,environment:'live'}),/SHORT_SHORTFALL_UNKNOWN/,'Korea: still waits');
  l.verifiedRegime='integrated-unknown';await assert.rejects(l.admit({order:{...order('US2'),market:'US',symbol:'AAPL',limitPrice:1},market:'US',cost:1,balance:us,environment:'live',other:kr,rate:1000}),/SHORT_SHORTFALL_UNKNOWN/,'paid from Korean cash: waits');
  // A known shortfall with separate funds leaves a U.S. buy exactly as before.
  const known=bal([LOSING],5000);const l2=new FundingLedger(new DatabaseSync(':memory:'),{fresh:async m=>m==='KR'?known:us});l2.verifiedRegime='separate';
  const c2=await l2.admit({order:{...order('US3'),market:'US',symbol:'AAPL',limitPrice:50},market:'US',cost:50,balance:us,environment:'live',other:known});assert.equal(c2.detail,'needs 50 against 100 (separate regime)');
});
test('Home: how much is held back and why; unreadable: buys wait; nothing with no short or nothing losing; the orderable-cash line keeps its own orders',async()=>{
  const {shortfallLine,shortCashWaitLine}=await import('../src/unwatched-orders.mjs');const at=f=>({desk:{shortfall:f}});
  assert.deepEqual(shortfallLine(at(R.shortfall({shorts:[LOSING,WINNING]}))),{block:null,info:"₩2,000 of your cash is held back from the app's buys: your short of 990010 costs more to buy back than its sale brought in."});
  assert.equal(shortfallLine(at(R.shortfall({shorts:[LOSING,{...LOSING,symbol:'990040'}]}))).info,"₩4,000 of your cash is held back from the app's buys: your shorts of 990010, 990040 cost more to buy back than their sales brought in.");
  assert.deepEqual(shortfallLine(at(R.shortfall({shorts:[{...LOSING,price:null}]}))),{block:'Buys wait: a short is open and what buying it back costs beyond its proceeds could not be read (990010).',info:null});
  for(const f of [R.shortfall({shorts:[]}),R.shortfall({shorts:[WINNING]}),null,undefined])assert.deepEqual(shortfallLine(at(f)),{block:null,info:null});
  assert.equal(shortCashWaitLine({desk:{orders:[{waiting:R.SHORTFALL_UNKNOWN_WORDS}]}}),null,'not counted as the orderable-cash wait');
  assert.match(shortCashWaitLine({desk:{orders:[{waiting:"a short is open and KIS's orderable cash could not be read"}]}}),/1 order/);
});
