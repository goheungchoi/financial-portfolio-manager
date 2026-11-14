// C1d-1 (settlement clean-up, W6; review K6): a KIS U.S. reading taken while KIS moves a KRW-funded U.S. settlement
// (U.S. cash below 0 before the KRW exchange) is held: the last consistent reading is used for the value, the day's
// record and band, the graph and the flow detector. Replay D: the 2026-10-27 sequence rebuilt from the backup's log.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {usDebit,UsBalanceHold,BOUND_MS}=require('../electron/settlement-check.cjs');const {combinePortfolio}=require('../electron/portfolio-view.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');
const MIN=60000,K=s=>Date.parse(s+'+09:00'),fx={usdKRW:1322.6};
const HOLD=[{symbol:'NASD:GOOGL',quantity:1,price:316.8},{symbol:'NASD:NVDA',quantity:1,price:216}];
const us=(t,cash,buyKRW)=>({accountKey:'a:US',timestamp:new Date(t).toISOString(),cash,fx:{...fx,timestamp:new Date(t).toISOString()},holdings:HOLD,unsettled:{buyKRW,sellKRW:0}});
const kr=(t,cash)=>({accountKey:'a',timestamp:new Date(t).toISOString(),cash,settledCash:cash,holdings:[{symbol:'000270',quantity:1,price:106000},{symbol:'028050',quantity:3,price:59500}]});
// 10-27 about 08:24: before, the buys' KRW awaiting settlement (the Korean deposit still holds it); the debit reading
// (U.S. cash -537.70, nothing awaiting settlement, the deposit unchanged); the exchange (U.S. cash 0, the deposit -715,840).
const D=[{at:K('2026-10-27T08:20:00'),us:[0,715840],kr:1213071},{at:K('2026-10-27T08:24:52'),us:[-537.7,0],kr:1213071},{at:K('2026-10-27T08:25:37'),us:[0,0],kr:497231},{at:K('2026-10-27T09:00:00'),us:[0,0],kr:497231}];
function replay({hold}){const db=new DatabaseSync(':memory:');let t=D[0].at;const clock=()=>t;const perf=new PerformanceHistory(db,clock),fd=new FlowDetector(db,perf,clock);
  const h=hold?new UsBalanceHold({clock}):null;const out=[];
  for(const r of D){t=r.at;const raw=us(t,...r.us),korea=kr(t,r.kr);const a=h?h.accept(raw):{balance:raw,held:false,provisional:false};const used=a.balance;
    const st=combinePortfolio(korea,used,used.fx,{},{now:t});if(!a.provisional)perf.record('a',st);
    // As main feeds the detector: Korean cash less the KRW known to be KRW-funded (all of it here), U.S. cash from the reading used.
    const flows=fd.observe('a',{krCash:korea.settledCash-(used.unsettled.buyKRW||0),usCash:a.provisional?null:used.cash,fx:1322.6,orders:[]});
    out.push({held:a.held,US:st.totals.USD,KR:st.totals.KRW,flows});}
  t=D.at(-1).at+3*3600000;for(let i=0;i<2;i++){const raw=us(t,0,0),korea=kr(t,497231);const a=h?h.accept(raw):{balance:raw};fd.observe('a',{krCash:497231,usCash:a.balance.cash,fx:1322.6,orders:[]});t+=3*3600000;}
  return {out,row:perf.history('a')[0],flows:perf.flows('a')};}

test('usDebit: negative U.S. cash while the amount awaiting settlement falls; a real overdraft or a rising amount is not it',()=>{
  assert.deepEqual(usDebit({cash:-537.7,unsettled:{buyKRW:0}},{unsettled:{buyKRW:715840}}),{cashUSD:-537.7,unsettledBeforeKRW:715840,unsettledNowKRW:0});
  assert.equal(usDebit({cash:-10,unsettled:{buyKRW:0}},{unsettled:{buyKRW:0}}),null,'nothing awaited settlement before');
  assert.equal(usDebit({cash:-10,unsettled:{buyKRW:900}},{unsettled:{buyKRW:800}}),null,'the amount rose: not a settlement');
  assert.equal(usDebit({cash:0,unsettled:{buyKRW:0}},{unsettled:{buyKRW:715840}}),null,'cash not negative');
  assert.equal(usDebit({cash:-1,unsettled:{buyKRW:0}},null),null,'no earlier reading');
});

test('Replay D: without the hold the 10-27 record takes a U.S. low of -4.90 and a Korean high of 1,497,571; with it, neither',()=>{
  const off=replay({hold:false}),on=replay({hold:true});
  assert.equal(Math.round(off.row.USD.low*100)/100,-4.9,'today: the debit reading sets the U.S. low');assert.equal(off.row.KRW.high,1497571,'today: the same reading sets the Korean high');
  assert.equal(on.out[1].held,true);assert.equal(on.row.USD.low,Math.min(...on.out.map(x=>x.US)));assert.ok(on.row.USD.low>=532.8-0.001,`U.S. low ${on.row.USD.low}`);
  assert.equal(on.row.KRW.high,781731,'Korean high: the consistent readings only');assert.equal(on.out[2].held,false,'the exchange reading ends the hold');
  for(const [k,v] of [['U.S. value',on.row.USD.equity],['Korean value',on.row.KRW.equity]])assert.ok(Number.isFinite(v),k);
  assert.equal(Math.round(on.row.equityKRW),Math.round(off.row.equityKRW),'the day\'s last value is the same either way');
});

test('K6: the held reading never feeds the flow detector; without the hold the debit and exchange are held as changes',()=>{
  const off=replay({hold:false}),on=replay({hold:true});
  assert.deepEqual(on.flows,[],'no flow of any kind with the hold');assert.ok(on.out.every(x=>!x.flows.length));
  // Today the debit reading starts a U.S. change and the exchange a Korean one in another reading: the detector holds them.
    assert.ok(off.flows.length>0||off.out.some(x=>x.flows.length),`today the detector records something: ${JSON.stringify(off.flows.map(f=>[f.market,f.amount,f.detected??false,f.transfer??false]))}`);
});

test('the hold ends at the first reading with cash at or above 0; after 3 hours the reading is used provisionally',()=>{
  let t=K('2026-10-27T08:20:00');const h=new UsBalanceHold({clock:()=>t});const first=us(t,0,715840);assert.equal(h.accept(first).held,false);
  t+=MIN;const a=h.accept(us(t,-537.7,0));assert.equal(a.held,true);assert.equal(a.balance,first);
  t+=MIN;assert.equal(h.accept(us(t,-537.7,0)).held,true,'still negative: still held (the amount awaiting settlement is already 0)');
  t+=BOUND_MS;const p=h.accept(us(t,-537.7,0));assert.equal(p.held,false);assert.equal(p.provisional,true);
  t+=MIN;const back=us(t,0,0);const e=h.accept(back);assert.equal(e.held,false);assert.equal(e.provisional,false);assert.equal(e.balance,back);
  const none=new UsBalanceHold({clock:()=>t});assert.equal(none.accept(us(t,-537.7,0)).provisional,false,'no earlier reading: no settlement state can be told, used as is');
});

test('the wiring: stored as evidence, the funding check and the order path read the new reading; tracker, loss check, record and graph do not',()=>{
  const m=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.ok(m.includes('{const h=useUs(value.balance);usSnapshot=h.snapshot;usHeldReading=h.heldReading??null;}'),'every U.S. reading goes through the hold');
  assert.ok(m.includes('if(!usHeldReading&&!usSnapshot.settlementProvisional)usLive.observeBalance(value.balance);'),'the loss check takes no baseline or peak from it');
  assert.ok(m.includes("if(us)brokerBalances.record(s.accountKey,'US',usHeldReading??us);"),'the KIS reading itself is kept');
  assert.ok(m.includes("const u=usHeldReading??usSnapshot;return kisState.snapshot&&u?.accountKey===kisState.snapshot.accountKey+':US'?u:null;"),'the funding check reads the new reading, as before');
  assert.ok(m.includes("&&!usSnapshot.settlementProvisional?(f=>usSnapshot.cash"),'the flow detector reads no provisional U.S. reading');
  assert.ok(m.includes('||usSnapshot?.settlementProvisional)return;'),'no record from a provisional reading');assert.ok(m.includes('&&!usHeldReading&&!usSnapshot?.settlementProvisional&&v!=null)intraday.record('),'no graph point');
  assert.equal((m.match(/usSnapshot=null;if\(usLive\)usLive\.refreshError=null;usHeldReading=null;/g)??[]).length,3,'every reset clears the held reading');
});
