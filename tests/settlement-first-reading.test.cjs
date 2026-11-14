// C1b (settlement clean-up, c1/design.md; review K4): the age rule runs at the U.S. tracker's first reading too. A fill
// already 3 U.S. business days past its trade date is opened and closed by age in that reading, so the first reading's
// value never subtracts buys settled long ago (W3: the 2026-11-09 open and low of -$165.02). The funding ledger sees an
// ordinary age close (one release per order), and no notice is raised.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,value}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const {PerformanceHistory}=require('../electron/performance.cjs');const {performanceCorrections}=require('../electron/performance-corrections.cjs');
const MIN=60000,ny=(d,h=12)=>Date.parse(`${d}T${String(h).padStart(2,'0')}:00:00-05:00`);
// The five live fills of 10-23 to 10-30, as the app listed them on 11-09 (net amounts, fill times).
const fill=(id,side,usd,day)=>({id,accountKey:'acct:US',symbol:'NYSE:'+id,side,quantity:1,filled:1,fillPrice:usd,limitPrice:usd,status:'Filled',resultCosts:{netCash:side==='Buy'?-usd:usd},createdAt:ny(day,10),filledObservedAt:ny(day,10)});
const LIVE=[fill('GOOGL','Buy',324.44,'2026-10-23'),fill('NVDA','Buy',213.26,'2026-10-23'),fill('PNR','Buy',61.71,'2026-10-27'),fill('GOOGLs','Sell',279.85,'2026-10-29'),fill('RDDT','Buy',97.66,'2026-10-30')];
// The app's wiring (main.cjs): a closed U.S. order releases its funding commitment's filled part.
function world(start=Date.parse('2026-11-09T08:27:41+09:00')){let t=start;const clock=()=>t;const db=new DatabaseSync(':memory:');
  const L=new FundingLedger(db,{clock});L.init();for(const o of LIVE.filter(o=>o.side==='Buy'))L.track(o);
  const f=new InFlight(db,clock);const settled=[];f.onSettled=(account,{orderId,why})=>{settled.push([orderId,why]);if(L.row(String(orderId))?.market==='US')L.releaseSettled({orderId,why});};
  const us=()=>({timestamp:new Date(t).toISOString(),cash:182.19,pendingSaleProceeds:0,holdings:[{symbol:'NASD:NVDA',quantity:1,price:186.64},{symbol:'NYSE:PNR',quantity:1,price:68.12},{symbol:'NYSE:RDDT',quantity:1,price:95.1}]});
  return {db,L,f,settled,us,see:(orders=LIVE)=>{const r=f.observe('acct',{us:us(),orders,fx:1357.9});t+=MIN;return r;},now:()=>t,later:ms=>{t+=ms;}};}

test('the live first reading: the five old fills open and close by age at once; the value is cash plus holdings',()=>{
  const w=world();const r=w.see();
  assert.equal(r.open.length,0);assert.equal(r.buysUSD,0);assert.equal(r.sellsUSD,0);assert.equal(r.notes.filter(n=>/settled by age/.test(n)).length,5);
  assert.ok(r.notes[0].startsWith('tracking of U.S. fills awaiting settlement starts'));assert.ok(!r.notes.some(n=>/stay in flight/.test(n)),'none stays in flight');
  const ev=w.f.evidence.events('acct');assert.deepEqual(ev.map(e=>e.kind),[...Array(5).fill('piece-opened'),...Array(5).fill('piece-closed')]);
  assert.ok(ev.every(e=>e.at===ev[0].at),'one reading');assert.ok(ev.filter(e=>e.kind==='piece-closed').every(e=>e.why==='age'));
  const v=value({us:w.us(),fx:{usdKRW:1357.9},inFlight:w.f.current('acct'),now:w.now()}).markets.US;
  assert.equal(Math.round(v.equity.low*100)/100,532.05,'the value of 11-09, not -165.02');assert.equal(v.equity.low,v.equity.high);assert.ok(!v.reasons.some(x=>/pre-tracking|in flight/.test(x)));
});

test('K4: the funding ledger sees ordinary age closes: one release per buy, none for the sale, none again later; no notice',()=>{
  const w=world();const before=w.L.commitments('acct').usd;assert.ok(before>0);const r=w.see();
  assert.deepEqual(w.settled.map(s=>s[0]).sort(),['GOOGL','GOOGLs','NVDA','PNR','RDDT'],'onSettled once per order');assert.ok(w.settled.every(s=>s[1]==='age'));
  const rows=w.db.prepare('SELECT orderId,reason FROM funding_releases ORDER BY orderId').all();assert.deepEqual(rows.map(x=>[x.orderId,x.reason]),[['GOOGL','settled by age'],['NVDA','settled by age'],['PNR','settled by age'],['RDDT','settled by age']]);
  assert.equal(w.L.commitments('acct').usd,0,'no filled buy holds funds any more');
  assert.equal(r.newlyOverdue,undefined,'no overdue notice from the first reading');
  w.see();w.later(3*86400000);w.see();assert.equal(w.db.prepare('SELECT COUNT(*) n FROM funding_releases').get().n,4,'later readings release nothing again');assert.equal(w.settled.length,5);
  assert.equal(w.f.evidence.events('acct').filter(e=>e.kind==='piece-closed').length,5,'nothing closes twice');
});

test('a fill inside the window stays open at the first reading and closes by age later; mixed lists split',()=>{
  const w=world();const young=fill('NEW','Buy',50,'2026-11-06');const r=w.see([...LIVE,young]);
  assert.equal(r.open.length,1);assert.equal(r.open[0].id,'NEW');assert.equal(r.buysUSD,50);assert.ok(r.notes.some(n=>/1 fill\(s\) from before tracking stay in flight/.test(n)));
  w.later(4*86400000);const later=w.see([...LIVE,young]);assert.equal(later.open.length,0);assert.equal(later.notes.filter(n=>/settled by age/.test(n)).length,1);
});

test('a day recorded from that first reading has no correction, no open base and no estimate tag',()=>{
  const w=world();const perf=new PerformanceHistory(w.db,w.now);const sc=performanceCorrections(w.db,{inFlight:w.f});perf.corrections=(a,rows)=>sc.byDay(a,rows);perf.settlement=a=>w.f.snapshot(a);
  const rec=(usd,krw=3687951)=>perf.record('acct',{totals:{USD:usd,KRW:krw,equityKRW:krw+usd*1357.9},fx:{usdKRW:1357.9}});
  // 11-04: before tracking.
  const t0=w.now();w.later(-5*86400000);rec(560.03,705451);w.later(5*86400000);void t0;
  w.see();const v=value({us:w.us(),fx:{usdKRW:1357.9},inFlight:w.f.current('acct'),now:w.now()}).markets.US.equity.low;rec(v);
  const day=perf.series('acct','USD').at(-1);assert.equal(Math.round(day.value*100)/100,532.05);assert.equal(day.correction,undefined);assert.equal(day.pendingObligation,undefined);assert.ok(!(day.settlement??[]).length,JSON.stringify(day.settlement));
  const map=sc.byDay('acct',perf.history('acct'));assert.ok(![...map.values()].some(d=>d.items.length||d.openUSD||d.pending),JSON.stringify([...map]));
  const row=perf.history('acct').at(-1);assert.equal(row.USD.low,row.USD.equity,'the band has no bootstrap low');
});
