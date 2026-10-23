const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {committedKRW}=require('../electron/integrated-settlement.cjs');const {combinePortfolio}=require('../electron/portfolio-view.cjs');const {combinedContext}=require('../electron/combined-context.cjs');
// An example account: 3 shares of a Korean stock; two U.S. stocks bought through integrated margin, not yet settled.
const kr={timestamp:'t',cash:1505000,settledCash:1342560,holdings:[{symbol:'990020',name:'H',quantity:3,cost:58700,price:57400}]};
const us={timestamp:'t',cash:0,unsettled:{buyKRW:728915,sellKRW:0},holdings:[{symbol:'NASD:NWTH',name:'A',quantity:1,cost:331.27,price:318.46},{symbol:'NASD:CNTS',name:'N',quantity:1,cost:204.58,price:209.73}]};
const fx={usdKRW:1318.4};
test('KRW committed to unsettled U.S. buys is not counted twice (regression)',()=>{
  const p=combinePortfolio(kr,us,fx);assert.equal(p.committedKRW,728915);assert.equal(p.cash.KRW,1342560-728915);
  assert.ok(Math.abs(p.totals.equityKRW-1482211)<2,`equity ${p.totals.equityKRW} ≈ ₩1,482,211, not ₩2.2m`);
  const before=combinePortfolio(kr,{...us,unsettled:undefined},fx);assert.ok(before.totals.equityKRW>2200000,'without the KIS figure it double counts');
  assert.equal(committedKRW({...us,cash:50}),0,'USD cash on hand: not applied');assert.equal(committedKRW({...us,unsettled:{buyKRW:728915,sellKRW:800000}}),0);
});
test('reviews see Korean cash and equity net of the committed KRW, with a note',()=>{
  const korea={market:'KR',currency:'KRW',equity:1523470,cash:1342560,universe:[],positions:{},quotes:[],orders:[],risk:{},marketSession:{open:false}};
  const usc={market:'US',currency:'USD',equity:528.18,cash:0,unsettledKRW:728915,universe:[],positions:{},quotes:[],orders:[],risk:{},marketSession:{open:true}};
  const c=combinedContext(korea,usc,fx);assert.equal(c.cash.KRW,613645);const k=c.markets.find(m=>m.market==='KR');assert.equal(k.unsettledUSBuysKRW,728915);assert.match(k.cashNote,/awaiting settlement/);
  assert.ok(Math.abs(c.equity-(1523470-728915+528.18*1318.4))<1,'about ₩1.49m');
});
test('a U.S. buy funded in KRW is not a deposit, and settlement is not a withdrawal',()=>{
  const {FlowDetector}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');let now=Date.parse('2026-10-16T15:00:00Z');
  const db=new DatabaseSync(':memory:');const d=new FlowDetector(db,new PerformanceHistory(db,()=>now),()=>now);const net=(settled,buy)=>settled-buy;
  d.observe('a',{krCash:net(1342560,0),usCash:0,fx:1318.4});now+=3600000;
  const usBuy1={market:'US',side:'Buy',status:'Filled',filled:1,fillPrice:331.27,resultCosts:{netCash:-332.08},createdAt:now-60000};
  const buy=d.observe('a',{krCash:net(1342560,431000),usCash:0,fx:1318.4,orders:[usBuy1]});assert.deepEqual(buy.map(f=>[f.market,f.amount,f.transfer]),[['KR',-431000,true],['US',332.08,true]],'the buy moves money between markets; nothing to confirm');
  now+=86400000*2;assert.deepEqual(d.observe('a',{krCash:net(1342560-431000,0),usCash:0,fx:1318.4,orders:[usBuy1]}),[],'settlement: KIS moves the KRW out of cash');
  const old=new DatabaseSync(':memory:');old.exec('CREATE TABLE flow_watch(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');old.prepare('INSERT INTO flow_watch VALUES(?,?)').run('a',JSON.stringify({at:now-1000,krCash:1342560,usCash:0}));
  const d2=new FlowDetector(old,new PerformanceHistory(old,()=>now),()=>now);assert.deepEqual(d2.observe('a',{krCash:613645,usCash:0,fx:1318.4}),[],'an old-basis reading restarts instead of reporting a ₩714k withdrawal');
});
test('transfers keep the returns of each market right and do not count in the combined account',()=>{
  const {PerformanceHistory}=require('../electron/performance.cjs');let now=Date.parse('2026-10-16T06:00:00Z');const p=new PerformanceHistory(new DatabaseSync(':memory:'),()=>now);
  const rec=(KRW,USD)=>p.record('a',{totals:{KRW,USD,equityKRW:KRW+USD*1318.4},cash:{KRW:0,USD:0},fx:{usdKRW:1318.4}});
  rec(1521370,0);now+=86400000;p.addFlow('a',{day:'2026-10-17',market:'KR',amount:-728915,transfer:true});p.addFlow('a',{day:'2026-10-17',market:'US',amount:533.84,transfer:true});
  rec(1521370-728915,528.19);const all=k=>p.summary('a',k).periods.find(x=>x.label==='All');
  assert.ok(Math.abs(all('KRW').twr)<1e-9,'Korea did not lose the KRW it sent');assert.ok(Math.abs(all('COMBINED').twr-((1521370-728915+528.19*1318.4)/1521370-1))<1e-9,'combined: only the real −2.1% change');
});
