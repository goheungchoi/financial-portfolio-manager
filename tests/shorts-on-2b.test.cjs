// Shorts on, stage 2b (handoff item 3): the checks a first real short can meet, tried on the mock KIS (tests/helpers/
// mock-kis.cjs, a live mock with short lots, the lending list and the uptick floor) through the real engine and
// automation: the cap at the moment of sending, the uptick floor at send and at a revision, a cover before the balance
// shows the short, the cover stop from arming to fill, the loan-end cover, and KIS's refusals, each with words and none
// leaving an order unclear. Made-up codes (99xxxx), prices, quantities and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {MockKis}=require('./helpers/mock-kis.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');const {Exposure}=require('../electron/exposure.cjs');
const {reasonText}=require('../electron/activity-today.cjs');
const S='990010';
// A live Korean account on the mock: cash 4,000,000 (KIS's total), the valuation's low bound `value` (10,000,000 unless
// given), short selling on with its 20% cap, automatic.
function setup({value=10000000,price=10000,shorts=[],auto=true,policy={}}={}){
  const m=new MockKis({environment:'live',kr:{cash:4000000,holdings:[],shorts},prices:{[S]:price}});const db=new DatabaseSync(':memory:');
  const l=new LiveEngine(db,m.broker('KR'),()=>({status:'connected',snapshot:m.balance('KR')}),{severalOpen:true});
  l.exposure=new Exposure(db);l.netEquityOf=()=>value==null?null:{low:value,high:value};l.instrumentOf=()=>({market:'KOSPI',type:'stock'});l.shortSession=()=>'regular';l.closedKrDays=()=>[];l.extraSymbols=async()=>[S];// the watched stock's quotes, as main.cjs adds them
  l.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');l.enableAuto('ENABLE AUTO LIVE');
  l.exposure.savePolicy('acct',{short:{enabled:true,auto,maxGrossPctOfEquity:20,stopLossPct:15,...policy}});
  return {m,l,db};}
const short=(l,quantity,limitPrice)=>l.propose({symbol:S,side:'Sell',quantity,limitPrice,credit:{kind:'short',market:'KOSPI'}});
const send=async(l,id)=>{try{return await l.submit(id,'PLACE LIVE ORDER');}catch(error){return {error:error.message,order:l.orders().find(o=>o.id===id)};}};
test('the cap at the send: measured on the account value, not KIS\'s reported total (the reviewer\'s 4,000,000 against 10,000,000)',async()=>{
  const {m,l}=setup();assert.equal(m.balance('KR').reportedTotal,4000000);
  const p=short(l,150,10010);const o=await send(l,p.id);assert.equal(o.status,'Accepted','15% of 10,000,000: sent');assert.equal(m.book.KR.length,1);
});
test('the cap at the send counts a filled short the balance does not show yet, and the account value read then',async()=>{
  let value=10000000;const {m,l}=setup();l.netEquityOf=()=>({low:value,high:value});m.shortLag=true;
  const b=short(l,50,10010);// 5%: proposed first
  const a=short(l,149,10010);// 14.9%: just under 20% with b
  const sent=await send(l,a.id);assert.equal(sent.status,'Accepted');m.fill('KR',sent.brokerOrderId);await l.reconcile();
  assert.equal(l.orders().find(o=>o.id===a.id).filled,149,'filled at KIS');assert.equal(m.balance('KR').shorts.length,0,'not yet in the balance');
  value=9500000;// 20% is now 1,900,000: a's 1,491,490 still waiting in the lag + b's 500,500 is over it
  const r=await send(l,b.id);assert.equal(r.error,'SHORT_LIMIT');assert.equal(m.book.KR.length,1,'nothing more was placed');
  assert.match(reasonText('SHORT_LIMIT'),/short-selling limit/);assert.notEqual(r.order?.status,'Uncertain');
  // The balance catches up: the lag is no longer counted twice (the lot holds it).
  m.showShorts();assert.equal(m.balance('KR').shorts[0].quantity,149);
});
test('the uptick floor at the send: the price rose after the proposal, so the short is refused before anything is placed',async()=>{
  const {m,l}=setup();const p=short(l,10,10010);m.price(S,10010);// the last trade rose a tick: the floor is now 10,020
  const r=await send(l,p.id);assert.equal(r.error??r.reason,'SHORT_BELOW_UPTICK');assert.equal(m.book.KR.length,0);assert.notEqual((r.order??r).status,'Uncertain');
  assert.match(reasonText('SHORT_BELOW_UPTICK'),/uptick rule/);
});
// The automation over the engine and the mock, as main.cjs attaches it.
function automation(m,l,db){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const logs=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:70000,name:'A'}],()=>[]),{request:async()=>({})},(...x)=>logs.push(x));a.live=l;a.usLive=null;a.logs=logs;
  a.marketQuotes=()=>Object.entries(m.prices).map(([symbol,price])=>({symbol,price,timestamp:Date.now(),retrievedAt:Date.now()}));a.krShortSession=()=>'regular';a.sessionOpen=()=>true;a.syncHistories=async()=>{};
  a.orderBook=async s=>({status:'available',retrievedAt:Date.now(),data:{bid:m.prices[s],ask:m.prices[s]+10,quoteAt:Date.now()}});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});return a;}
test('the uptick floor at a revision: the tracker raises an open short to the floor read then, and never revises it below',async()=>{
  const {m,l,db}=setup();const p=short(l,10,10010);const o=await send(l,p.id);assert.equal(o.status,'Accepted');const a=automation(m,l,db);
  m.price(S,10010);await a.trackOrders();const rev=m.book.KR.find(r=>r.kind==='revision');assert.ok(rev,'revised');assert.equal(rev.orderPrice,10020,'raised to the floor above the new last trade');
  m.price(S,9900);await a.trackOrders();const last=m.book.KR.filter(r=>r.kind==='revision').at(-1);
  assert.ok(last.orderPrice>=require('../electron/short-rules.cjs').floorPrice(9900),'never below the floor read then');
});
// Stage 2c: both worlds, KIS's lot at the date sent and the settlement world (the order row D, the lot D+2).
const LDS=require('../electron/short-loan-date.cjs');
for(const world of ['same date','settlement'])test(`a cover before the balance shows the short: no lot, so no cover and no stop yet; once it shows, the cover stop is armed, fires, fills, and is closed with its lot (${world})`,async()=>{
  const {m,l,db}=setup();m.shortLag=true;if(world==='settlement')m.lotDateOf=d=>LDS.businessDaysBefore(d,-2);const p=short(l,10,10010);const o=await send(l,p.id);m.fill('KR',o.brokerOrderId);await l.reconcile();const a=automation(m,l,db);
  const day=l.orders().find(x=>x.id===p.id).lotLoanDate;assert.ok(day,'KIS\'s lot date from its order row');
  assert.throws(()=>l.propose({symbol:S,side:'Buy',quantity:10,limitPrice:10000,credit:{kind:'cover',loanDate:day}}),/NO_SUCH_LOT|INSUFFICIENT_CAPACITY/,'the lot is not in the balance yet');
  a.syncShortStops(a.watchScope());assert.equal(a.desk.orders(a.watchScope()).length,0,'no stop before the lot shows');
  // The app's next balance reading (observeBalance, as each poll does) shows the lot.
  m.showShorts();l.observeBalance(m.balance('KR'));a.appLotsCache=null;a.syncShortStops(a.watchScope());const [stop]=a.desk.orders(a.watchScope());assert.ok(stop,'armed once the lot shows');
  const lotDay=m.balance('KR').shorts[0].loanDate;assert.equal(stop.credit.loanDate,lotDay);assert.equal(l.orders().find(x=>x.id===p.id).lotTie.how,world==='settlement'?'counterpart':'exact');
  if(world==='settlement')assert.equal(lotDay,LDS.businessDaysBefore(day,-2),'the lot two business days after the row');assert.equal(stop.quantity,10);const level=stop.conditions[0].value;assert.ok(level>10010*1.15-1&&level<10010*1.16,'15% above the entry');
  // The price rises through the stop: fired, sent by itself, filled; the lot is gone and the stop is closed.
  m.price(S,level+100);await a.fireConditional(a.desk.orders(a.watchScope())[0]);const cover=l.orders().find(x=>x.credit?.kind==='cover');assert.ok(cover,'the cover was proposed');assert.equal(cover.status,'Accepted',`sent: ${cover.status} ${cover.reason??''}`);
  assert.deepEqual([cover.loanDateSent?.date,cover.loanDateSent?.alternate],[lotDay,false],'the first LOAN_DT is the lot\'s, accepted');
  m.fill('KR',cover.brokerOrderId);await l.reconcile();assert.equal(m.balance('KR').shorts.length,0,'the lot is bought back');l.observeBalance(m.balance('KR'));
  a.appLotsCache=null;a.syncShortStops(a.watchScope());assert.equal(a.desk.orders(a.watchScope()).filter(x=>x.status==='armed').length,0,'no stop left armed');
});
for(const world of ['same date','settlement'])test(`the loan-end cover: a lot of the app in its last business days gets a cover armed to go at once, which is sent and fills (${world})`,async()=>{
  // A lot the app opened 88 calendar days ago (the made-up dates are computed from today), with the 90-day loan.
  const back=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);let k=88;while([0,6].includes(new Date(back(k)+'T00:00:00Z').getUTCDay()))k++;const loanDate=back(k);// a weekday, as KIS's loan dates are
  const {m,l,db}=setup({shorts:[{symbol:S,quantity:5,loanDate,price:10000,entryPrice:9000,proceeds:45000,loanAmount:45000}]});
  const row=world==='settlement'?LDS.businessDaysBefore(loanDate,2):loanDate;// the order row's date
  l.writeOrder({id:'S0',accountKey:'acct',symbol:S,side:'Sell',quantity:5,filled:5,status:'Filled',credit:{kind:'short',type:'22'},lotLoanDate:row,fillPrice:9000,filledObservedAt:1,createdAt:1,expiresAt:1});
  l.observeBalance(m.balance('KR'));const a=automation(m,l,db);a.syncShortStops(a.watchScope());
  const exit=a.desk.orders(a.watchScope()).find(o=>o.purpose==='exit');assert.ok(exit,'the loan-end cover is armed');assert.equal(exit.quantity,5);assert.equal(exit.credit.loanDate,loanDate);
  assert.ok(a.logs.some(x=>x[2]==='Short loan ends: cover armed'));
  await a.fireConditional(exit);const cover=l.orders().find(o=>o.credit?.kind==='cover');assert.equal(cover?.status,'Accepted');assert.equal(cover.loanDateSent?.date,loanDate,'the lot\'s date, first');m.fill('KR',cover.brokerOrderId);await l.reconcile();assert.equal(m.balance('KR').shorts.length,0);
});
test('KIS refusals a first short can meet: each with words, none leaving an order unclear',async()=>{
  const words=[],clear=l=>assert.ok(!l.orders().some(o=>['Uncertain','Submitting','Cancellation uncertain'].includes(o.status)),JSON.stringify(l.orders().map(o=>o.status)));
  // No credit agreement (KIS refuses the account's credit read).
  {const {m,l}=setup();m.fault('prepare-order','no-credit');const p=short(l,10,10010);const r=await send(l,p.id);assert.equal(r.error,'CREDIT_ACCOUNT_REQUIRED');words.push(reasonText('CREDIT_ACCOUNT_REQUIRED'));assert.equal(m.book.KR.length,0);clear(l);}
  // Not lendable now, and a quantity above what KIS lends.
  {const {m,l}=setup();m.lend[S]={open:false,tradable:0};const r=await send(l,short(l,10,10010).id);assert.equal(r.error,'SHORT_NOT_LENDABLE');words.push(reasonText('SHORT_NOT_LENDABLE'));clear(l);}
  {const {m,l}=setup();m.lend[S]={open:true,tradable:5};const r=await send(l,short(l,10,10010).id);assert.equal(r.error,'SHORT_BORROW_SHORT');words.push(reasonText('SHORT_BORROW_SHORT'));clear(l);}
  // The cap cannot be measured (no account value): refused at the proposal.
  {const {l}=setup({value:null});assert.throws(()=>short(l,10,10010),/SHORT_CAP_UNKNOWN/);words.push(reasonText('SHORT_CAP_UNKNOWN'));}
  // KIS refuses the placed order (the credit agreement code): Rejected with its code, no alternate date.
  {const {m,l}=setup();m.fault('place-order',{reject:'APBK1617',message:'made-up words'});const o=await send(l,short(l,10,10010).id);assert.equal(o.status,'Rejected');assert.equal(o.brokerCode,'APBK1617');assert.equal(m.book.KR.length,0);clear(l);}
  for(const w of words)assert.ok(typeof w==='string'&&w.length>10&&!/undefined/.test(w),w);
});
