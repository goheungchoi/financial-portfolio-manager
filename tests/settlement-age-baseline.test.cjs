// Settlement simplification S1b, review finding 1: the U.S. daily-loss baseline follows a settlement by age (rule B9 in
// electron/settlement-baseline.cjs). A close after the day's baseline raises the low value with no market move, so the
// baseline moves by the same amount (a buy up, a sale down), cumulative per piece: the close alone is zero P/L and a
// real loss that day is measured in full.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value,VERSION}=require('../electron/valuation.cjs');const {SettlementBaseline}=require('../electron/settlement-baseline.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
// The engine stamps its baseline with Date.now: a fixed Seoul midday on D (as in settlement-baseline.test.cjs).
{const realNow=Date.now,startReal=realNow(),FIXED=Date.parse('2026-11-05T03:00:00Z');Date.now=()=>FIXED+(realNow()-startReal);}
const MIN=60000,HOUR=3600000,D='2026-11-05';
// Filled Thu 10-29 New York: settled by age from Tue 11-03, so the tracker closes it at its first reading after the bootstrap.
const OLD=Date.parse('2026-10-29T15:00:00Z');
const order=(id,extra={})=>({id,symbol:'NASD:TEST',side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,limitPrice:100,costEstimate:{netCash:-100},resultCosts:{netCash:-100},environment:'live',accountKey:'a:US',market:'US',day:'2026-10-29',createdAt:OLD,filledObservedAt:OLD,...extra});
function world({limit=30}={}){const db=new DatabaseSync(':memory:');let t=Date.now()-6*HOUR;const clock=()=>t;
  const f=new InFlight(db,clock),sb=new SettlementBaseline(db,{inFlight:f,clock});let day=D;const us={cash:500,holdings:[]};
  const snap=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:us.holdings,reportedTotal:us.cash,timestamp:new Date(t).toISOString()});
  const e=new LiveEngine(db,{request:async()=>{}},()=>({status:'connected',snapshot:snap()}),{market:'US'});e.day=()=>day;
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:limit}},'ENABLE LIVE');
  e.netEquityOf=s=>({...value({us:s,inFlight:f.current('a'),fx:{usdKRW:1300},now:t}).markets.US.equity,version:VERSION});
  e.baselineTaken=p=>sb.take('a',p.day,p.baselineAt);e.settlementAdjustments=p=>sb.adjustments('a',p);e.flowsSince=()=>({confirmed:0,unresolved:0});
  return {db,f,sb,e,us,see:(orders=[])=>{const r=f.observe('a',{us:snap(),orders,fx:1300});t+=MIN;return r;},
    baseline:d=>{day='2026-11-03';e.observeBalance(snap());day=d;e.observeBalance(snap());t=Math.max(t,Date.now())+HOUR;return e.policy();},
    loss:()=>e.lossOf(e.policy(),snap()),adj:()=>sb.adjustments('a',e.policy())};}

test('B9: a buy settled by age after the baseline moves it up by the same amount; the close alone is zero P/L',()=>{
  const w=world(),A=order('A');assert.equal(w.see([A]).open.length,1,'bootstrap: open, not closed');
  const p=w.baseline(D);assert.equal(p.baseline,400,'$500 cash less the $100 in flight');assert.equal(w.loss().loss,0);
  const r=w.see([A]);assert.equal(r.open.length,0,'settled by age');
  const a=w.adj();assert.equal(a.certain.low,100);assert.deepEqual(a.items.filter(i=>i.kind==='settled by age').map(i=>[i.orderId,i.side,i.usd,i.timing]),[['A','Buy',100,'before']]);
  const l=w.loss();assert.equal(l.loss,0,'the value rose with the baseline');assert.equal(l.breached,false);
  // Later readings change nothing (the piece is closed once; cumulative per piece).
  w.see([A]);w.see([A]);assert.equal(w.adj().certain.low,100);assert.equal(w.loss().loss,0);
});
test('B9: a real $35 loss on the day of a $100 age close is measured in full and breaches a $30 limit',()=>{
  const w=world({limit:30}),A=order('A');w.see([A]);w.baseline(D);w.see([A]);
  w.us.holdings=[{symbol:'X',quantity:1,price:-35}];const l=w.loss();assert.equal(l.loss,35);assert.equal(l.breached,true);
  // Without B9 the close would hide it: the value is $100 higher than the unadjusted baseline.
  assert.equal(value({us:{cash:500,pendingSaleProceeds:0,holdings:w.us.holdings},inFlight:w.f.current('a'),fx:{usdKRW:1300},now:Date.now()}).markets.US.equity.low-400,65);
});
test('B9: a sale settled by age moves the high bound down; a close before the baseline moves nothing; no snapshot is unknown timing',()=>{
  const w=world(),S=order('S',{side:'Sell',costEstimate:{netCash:50},resultCosts:{netCash:50},fillPrice:50,limitPrice:50});w.see([S]);w.baseline(D);w.see([S]);
  const a=w.adj();assert.equal(a.certain.high,-50);assert.equal(a.certain.low,0);assert.deepEqual(a.items.filter(i=>i.kind==='settled by age').map(i=>[i.side,i.usd]),[['Sell',50]]);assert.equal(w.loss().loss,0);
  // Closed before the day's baseline: the baseline already has the value without it.
  const b=world(),B=order('B');b.see([B]);b.see([B]);b.baseline(D);assert.equal(b.adj().certain.low,0);assert.equal(b.adj().items.length,0);assert.equal(b.loss().loss,0);
  // No snapshot for the day (B8): the close is of unknown timing, a scenario, never applied as certain.
  const c=world(),C=order('C');c.see([C]);c.see([C]);const closedAt=c.f.evidence.events('a').find(e=>e.kind==='piece-closed').at;const u=c.sb.adjustments('a',{day:D,baselineAt:closedAt-1});assert.equal(u.snapshot,false);assert.equal(u.certain.low,0);assert.equal(u.withUnknown.low,100);
});
test('B9 is capped at the piece\'s basis at the baseline, so a close can never move it by more than was counted',()=>{
  const w=world(),A=order('A');w.see([A]);w.baseline(D);
  // A forged close event of $250 for a $100 piece (amounts above the piece's basis cannot come from the tracker).
  const pid=Object.keys(w.sb.get('a',D).pieces)[0];w.f.evidence.event('a','piece-closed',{pieceId:pid,orderId:'A',side:'Buy',why:'age',usd:250});w.f.evidence.event('a','piece-closed',{pieceId:pid,orderId:'A',side:'Buy',why:'age',usd:250});
  assert.equal(w.adj().certain.low,100);
});
