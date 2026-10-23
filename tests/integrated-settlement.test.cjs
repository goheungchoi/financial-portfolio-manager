const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {committedKRW}=require('../electron/integrated-settlement.cjs');const {combinePortfolio}=require('../electron/portfolio-view.cjs');const {combinedContext}=require('../electron/combined-context.cjs');
// 2026-10-24 01:4x KST: 3 Samsung E&A in Korea; 1 Alphabet and 1 Nvidia bought through integrated margin, not yet settled.
const kr={timestamp:'t',cash:1500001,settledCash:1319081,holdings:[{symbol:'028050',name:'E&A',quantity:3,cost:60300,price:59100}]};
const us={timestamp:'t',cash:0,unsettled:{buyKRW:714383,sellKRW:0},holdings:[{symbol:'NASD:GOOGL',name:'A',quantity:1,cost:323.64,price:323.08},{symbol:'NASD:NVDA',name:'N',quantity:1,cost:212.73,price:212.04}]};
const fx={usdKRW:1324.6};
test('KRW committed to unsettled U.S. buys is not counted twice (2026-10-24 regression)',()=>{
  const p=combinePortfolio(kr,us,fx);assert.equal(p.committedKRW,714383);assert.equal(p.cash.KRW,1319081-714383);
  assert.ok(Math.abs(p.totals.equityKRW-1490818)<2,`equity ${p.totals.equityKRW} ≈ ₩1.49m, not ₩2.2m`);
  const before=combinePortfolio(kr,{...us,unsettled:undefined},fx);assert.ok(before.totals.equityKRW>2200000,'without the KIS figure it double counts');
  assert.equal(committedKRW({...us,cash:50}),714383,'USD cash on hand: still applied (uncertainty is reported separately)');assert.equal(committedKRW({...us,unsettled:{buyKRW:714383,sellKRW:800000}}),0);
});
test('reviews see Korean cash and equity net of the committed KRW, with a note',()=>{
  const korea={market:'KR',currency:'KRW',equity:1498481,cash:1319081,universe:[],positions:{},quotes:[],orders:[],risk:{},marketSession:{open:false}};
  const usc={market:'US',currency:'USD',equity:535.11,cash:0,unsettledKRW:714383,universe:[],positions:{},quotes:[],orders:[],risk:{},marketSession:{open:true}};
  const c=combinedContext(korea,usc,fx);assert.equal(c.cash.KRW,604698);const k=c.markets.find(m=>m.market==='KR');assert.equal(k.unsettledUSBuysKRW,714383);assert.match(k.cashNote,/awaiting settlement/);
  assert.ok(Math.abs(c.equity-(1498481-714383+535.11*1324.6))<1,'about ₩1.49m');
});
test('a U.S. buy funded in KRW is not a deposit, and settlement is not a withdrawal',()=>{
  const {FlowDetector}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');let now=Date.parse('2026-10-23T15:00:00Z');
  const db=new DatabaseSync(':memory:');const d=new FlowDetector(db,new PerformanceHistory(db,()=>now),()=>now);const net=(settled,buy)=>settled-buy;
  d.observe('a',{krCash:net(1319081,0),usCash:0,fx:1324.6});now+=3600000;
  const googl={market:'US',side:'Buy',status:'Filled',filled:1,fillPrice:323.64,resultCosts:{netCash:-324.45},createdAt:now-60000};
  const buy=d.observe('a',{krCash:net(1319081,431000),usCash:0,fx:1324.6,orders:[googl]});assert.deepEqual(buy.map(f=>[f.market,f.amount,f.transfer]),[['KR',-431000,true],['US',324.45,true]],'the buy moves money between markets; nothing to confirm');
  now+=86400000*2;assert.deepEqual(d.observe('a',{krCash:net(1319081-431000,0),usCash:0,fx:1324.6,orders:[googl]}),[],'settlement: KIS moves the KRW out of cash');
  const old=new DatabaseSync(':memory:');old.exec('CREATE TABLE flow_watch(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');old.prepare('INSERT INTO flow_watch VALUES(?,?)').run('a',JSON.stringify({at:now-1000,krCash:1319081,usCash:0}));
  const d2=new FlowDetector(old,new PerformanceHistory(old,()=>now),()=>now);assert.deepEqual(d2.observe('a',{krCash:604698,usCash:0,fx:1324.6}),[],'an old-basis reading restarts instead of reporting a ₩714k withdrawal');
});
test('transfers keep the returns of each market right and do not count in the combined account',()=>{
  const {PerformanceHistory}=require('../electron/performance.cjs');let now=Date.parse('2026-10-23T06:00:00Z');const p=new PerformanceHistory(new DatabaseSync(':memory:'),()=>now);
  const rec=(KRW,USD)=>p.record('a',{totals:{KRW,USD,equityKRW:KRW+USD*1324.6},cash:{KRW:0,USD:0},fx:{usdKRW:1324.6}});
  rec(1496381,0);now+=86400000;p.addFlow('a',{day:'2026-10-24',market:'KR',amount:-714383,transfer:true});p.addFlow('a',{day:'2026-10-24',market:'US',amount:539.32,transfer:true});
  rec(1496381-714383,535.12);const all=k=>p.summary('a',k).periods.find(x=>x.label==='All');
  assert.ok(Math.abs(all('KRW').twr)<1e-9,'Korea did not lose the KRW it sent');assert.ok(Math.abs(all('COMBINED').twr-((1496381-714383+535.12*1324.6)/1496381-1))<1e-9,'combined: only the real −0.4% change');
});
test('review fix: USD cash on hand keeps the KRW correction and reports the uncertain part instead of dropping it',()=>{
  const {settlement}=require('../electron/integrated-settlement.cjs');
  assert.deepEqual(settlement({...us,cash:0.01,fx:{usdKRW:1324.6}}),{committedKRW:714383,uncertainKRW:13},'$0.01 of USD cash no longer zeroes the correction');
  assert.deepEqual(settlement({...us,cash:600,fx:{usdKRW:1324.6}}),{committedKRW:714383,uncertainKRW:714383},'capped at the committed amount');
  const p=combinePortfolio(kr,{...us,cash:100,fx:{usdKRW:1324.6}},fx);assert.equal(p.committedKRW,714383);assert.equal(p.settlementUncertainKRW,132460);
  const korea={market:'KR',currency:'KRW',equity:1498481,cash:1319081,universe:[],positions:{},quotes:[],orders:[],risk:{},marketSession:{open:false}};
  const c=combinedContext(korea,{market:'US',currency:'USD',equity:635.11,cash:100,unsettledKRW:714383,unsettledUncertainKRW:132460,universe:[],positions:{},quotes:[],orders:[],risk:{},marketSession:{open:true}},fx);
  assert.match(c.markets.find(m=>m.market==='KR').cashNote,/USD cash may have paid for up to ₩132,460 of it, so equity may be understated/);
});
