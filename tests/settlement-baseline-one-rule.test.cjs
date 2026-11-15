// S3b (settlement clean-up, s3/design.md section 6; review rulings R1): the U.S. daily-loss baseline keeps one rule. A
// cash-free change of the tracker's basis after the day's baseline moves the baseline with the value by the same amount;
// reconciliations, reversals and unknown timing are gone; no snapshot is unavailable.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value,VERSION}=require('../electron/valuation.cjs');const {SettlementBaseline}=require('../electron/settlement-baseline.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const {ValuationCorrections}=require('../electron/valuation-corrections.cjs');
{const realNow=Date.now,startReal=realNow(),FIXED=Date.parse('2026-11-05T03:00:00Z');Date.now=()=>FIXED+(realNow()-startReal);}
const MIN=60000,HOUR=3600000,D='2026-11-05';
// Filled Mon 11-02 New York (settled by age from 11-05); PRE: filled 10-29, already past the rule at the first reading.
const OLD=Date.parse('2026-11-02T15:00:00Z'),PRE=Date.parse('2026-10-29T15:00:00Z');
const order=(id,extra={})=>({id,symbol:'NASD:TEST',side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:100,limitPrice:100,costEstimate:{netCash:-100},resultCosts:{netCash:-100},environment:'live',accountKey:'a:US',market:'US',day:'2026-10-29',createdAt:OLD,filledObservedAt:OLD,...extra});
function world({limit=30}={}){const db=new DatabaseSync(':memory:');let t=Date.now()-6*HOUR;const clock=()=>t;
  const f=new InFlight(db,clock),sb=new SettlementBaseline(db,{inFlight:f,clock});let day=D;const us={cash:500,holdings:[]};
  const snap=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:us.holdings,reportedTotal:us.cash,timestamp:new Date(t).toISOString()});
  const e=new LiveEngine(db,{request:async()=>{}},()=>({status:'connected',snapshot:snap()}),{market:'US'});e.day=()=>day;
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:limit}},'ENABLE LIVE');
  e.netEquityOf=s=>({...value({us:s,inFlight:f.current('a'),fx:{usdKRW:1300},now:t}).markets.US.equity,version:VERSION});
  e.baselineTaken=p=>sb.take('a',p.day,p.baselineAt);e.settlementAdjustments=p=>sb.adjustments('a',p);e.flowsSince=()=>({confirmed:0,unresolved:0});
  return {db,f,sb,e,us,clock,later:ms=>{t+=ms;},see:(orders=[])=>{const r=f.observe('a',{us:snap(),orders,fx:1300});t+=MIN;return r;},
    baseline:d=>{day='2026-11-03';e.observeBalance(snap());day=d;e.observeBalance(snap());t=Math.max(t,Date.now())+HOUR;return e.policy();},
    loss:()=>e.lossOf(e.policy(),snap()),adj:()=>sb.adjustments('a',e.policy())};}

test('an age close before, at and after the baseline: only after moves it; "at" is decided by the ledger event, not the clock',()=>{
  // Before: closed, then the baseline.
  const b=world(),A=order('A');b.see([A]);b.later(24*HOUR);b.see([A]);b.baseline(D);assert.equal(b.adj().certain.low,0);assert.equal(b.loss().loss,0);
  // After: the baseline, then the close: +100, zero P/L.
  const a=world(),B=order('B');a.see([B]);a.baseline(D);a.later(24*HOUR);a.see([B]);assert.equal(a.adj().certain.low,100);assert.equal(a.loss().loss,0);
  // At the same millisecond: a snapshot taken at t, then the close at the same t, is after it (by ledger id).
  const s=world(),C=order('C');s.see([C]);s.later(24*HOUR);const at=s.clock();s.sb.take('a',D,at);s.see([C]);
  const close=s.f.evidence.events('a').find(e=>e.kind==='piece-closed');assert.equal(close.at,at,'same millisecond');assert.equal(s.sb.adjustments('a',{day:D,baselineAt:at}).certain.low,100);
});

test('a piece a valuation correction supersedes (C1a) still moves the baseline when it closes after it: the live value moves with it',()=>{
  const w=world(),A=order('A');w.see([A]);const pid=w.f.evidence.events('a').find(e=>e.kind==='piece-opened').pieceId;w.baseline(D);
  // A correction version superseding the piece (as a C2 correction version does for the pieces it covers).
  const corr=new ValuationCorrections(w.db);w.db.prepare('INSERT INTO valuation_adjustments VALUES(?,?,?)').run('v1','a',JSON.stringify({id:'v1',account:'a',version:1,adjustments:[],supersedes:{pieceIds:[pid]},approvedBy:'test',note:'',appliedAt:0}));
  assert.ok(corr.superseded('a').has(pid));
  w.later(24*HOUR);w.see([A]);assert.equal(w.adj().certain.low,100,'moved once, by the close');assert.equal(w.loss().loss,0);
  // The baseline never reads the corrections.
  const src=fs.readFileSync(path.join(__dirname,'..','electron','settlement-baseline.cjs'),'utf8');assert.doesNotMatch(src,/valuation_adjustments|superseded|ValuationCorrections/);
});

test('C1b: a pre-tracking fill opened and closed by age in the first reading after the baseline nets to zero, with the value unchanged',()=>{
  const w=world();w.see([]);const p=w.baseline(D);const P=order('P',{createdAt:PRE,filledObservedAt:PRE});const r=w.see([P]);
  assert.equal(r.open.length,0,'closed at the first reading it is seen');const a=w.adj();assert.equal(a.certain.low,0,'-100 opened, +100 closed');
  assert.deepEqual(a.items.map(i=>[i.kind,i.usd]),[['pre-tracking fill opened',100],['settled by age',100]]);assert.equal(w.loss().loss,0);assert.equal(p.baseline,500);
});

test('a young pre-tracking fill opened after the baseline moves it down with the value: no false loss',()=>{
  const w=world(),A=order('A');w.see([A]);w.baseline(D);const Y=order('Y',{ticker:'OTHER',fillPrice:50,limitPrice:50,costEstimate:{netCash:-50},resultCosts:{netCash:-50}});w.see([A,Y]);
  const a=w.adj();assert.equal(a.certain.low,-50);assert.equal(w.loss().loss,0,'the value fell by 50 with the baseline');assert.equal(w.loss().breached,false);
});

test('the loss result has one scenario set: no "paid before the baseline" assumption, and no withUnknown in the adjustments',()=>{
  const w=world(),A=order('A');w.see([A]);w.baseline(D);w.later(24*HOUR);w.see([A]);const a=w.adj();assert.equal('withUnknown' in a,false);
  const l=w.loss();assert.ok(l.settlement?.adjustment);assert.equal('ifPaidBeforeBaseline' in (l.settlement??{}),false);assert.equal('assumption' in (l.settlement??{}),false);
  assert.ok(!(l.scenarios??[]).some(s=>/unknown timing|paid before the baseline/.test(s.name)));
  const src=fs.readFileSync(path.join(__dirname,'..','electron','live-engine.cjs'),'utf8');assert.doesNotMatch(src,/withUnknown|ifPaidBeforeBaseline/);
  const sb=fs.readFileSync(path.join(__dirname,'..','electron','settlement-baseline.cjs'),'utf8');assert.doesNotMatch(sb,/static timing|withUnknown|piece-reopened|kind==='reconciliation'/);
});
