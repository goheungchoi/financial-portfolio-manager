// The Home Result tile's figures (src/home-result.mjs): read from the performance summary and the rows, never
// recomputed; every unknown is null with a reason, never a zero.
import test from 'node:test';import assert from 'node:assert/strict';
import {homeResult,resultSummary} from '../src/home-result.mjs';

const point=(day,value,extra={})=>({day,value,flow:0,dailyReturn:0.01,pnl:1000,...extra});
const summary=(over={},periodOver={})=>({kind:'COMBINED',benchmark:'KOSPI',start:'2026-10-19',end:'2026-11-11',
  points:[point('2026-10-19',1000000,{pnl:null,dailyReturn:null}),point('2026-11-10',1010000),point('2026-11-11',1020000,{pnl:10000,dailyReturn:0.0099})],
  periods:[{label:'1W',start:'2026-11-04',end:'2026-11-11',gain:5000,twr:0.005,benchmark:0.01},{label:'All',start:'2026-10-19',end:'2026-11-11',gain:20000,twr:0.02,benchmark:0.03,flows:0,...periodOver}],...over});
const kr=(symbol,quantity,cost,price)=>({symbol,market:'KR',currency:'KRW',quantity,cost,price,valueKRW:quantity*price,costKRW:quantity*cost});
const us=(symbol,quantity,cost,price,fx=1400)=>({symbol,market:'US',currency:'USD',quantity,cost,price,valueKRW:fx==null?null:quantity*price*fx,costKRW:fx==null?null:quantity*cost*fx});

// What HomeTrend shows for "All" (src/Home.tsx: sel = the "All" period; change = sel.gain, ret = sel.twr, vs = sel.benchmark).
const homeTrendAll=s=>{const sel=s.periods.find(p=>p.label==='All');return {change:sel.gain??null,ret:sel.twr??null,range:sel.twrRange??null,vs:sel.benchmark??null,since:s.points[0].day};};

test('Total, Today and Benchmark are the account value box\'s "All" figures, not recomputed',()=>{
  const s=summary();const r=homeResult({summary:s,rows:[kr('005930',2,60000,61000)],usLoaded:true});const t=homeTrendAll(s);
  assert.equal(r.total.gain,t.change);assert.equal(r.total.twr,t.ret);assert.equal(r.since,t.since);assert.equal(r.total.reason,null);assert.equal(r.total.tag,null);
  assert.deepEqual(r.benchmark,{benchmark:t.vs,you:t.ret});assert.equal(r.benchmarkName,'KOSPI');
  assert.deepEqual([r.today.day,r.today.pnl,r.today.dailyReturn,r.today.reason],['2026-11-11',10000,0.0099,null]);
  assert.deepEqual([r.unrealized.amount,Math.round(r.unrealized.percent*100)/100],[2000,1.67]);
  assert.equal(resultSummary({COMBINED:s,KRW:{points:[]}}),s);assert.equal(resultSummary({COMBINED:{points:[]},KRW:s}),s,'Korea\'s summary when the combined one has no points, as HomeTrend');
  assert.equal(resultSummary(null),null);assert.equal(homeResult({summary:{...s,benchmark:'SPX'}}).benchmarkName,'S&P 500');
});
test('no summary, or fewer than two recorded days: every result is null with the reason, never zero',()=>{
  for(const s of [null,{points:[]},{points:[point('2026-11-11',1000000)],periods:[]}]){const r=homeResult({summary:s});
    assert.deepEqual([r.total.gain,r.total.twr,r.today.pnl,r.benchmark],[null,null,null,null]);assert.equal(r.total.reason,'Starts after values are recorded on two days.');assert.equal(r.today.reason,'Starts after values are recorded on two days.');}
  const noAll=homeResult({summary:summary({periods:[]})});assert.equal(noAll.total.gain,null);assert.equal(noAll.total.reason,'No result for the whole history yet.');
});
test('an unavailable period: the return is null with the first reason and the day count; the gain is shown only when the summary has it',()=>{
  const r=homeResult({summary:summary({},{twr:null,gain:null,unavailable:['2026-11-05: exchange rate missing; corrections unreadable','2026-11-06: exchange rate missing']})});
  assert.deepEqual([r.total.gain,r.total.twr],[null,null]);assert.equal(r.total.reason,'Investment return unavailable: exchange rate missing (2 days affected).');assert.equal(r.benchmark,null,'no benchmark without a return');
  const kept=homeResult({summary:summary({},{twr:null,gain:15000,unavailable:['2026-11-05: settlement not known']})});
  assert.equal(kept.total.gain,15000,'as the account value box: the summary gave a gain');assert.equal(kept.total.twr,null);assert.equal(kept.total.reason,'Investment return unavailable: settlement not known.');
});
test('a ranged return is kept as the range; the benchmark is hidden without a single return',()=>{
  const r=homeResult({summary:summary({},{twr:null,twrRange:{low:-0.01,high:0.004}})});
  assert.equal(r.total.twr,null);assert.deepEqual(r.total.twrRange,{low:-0.01,high:0.004});assert.equal(r.total.reason,null);assert.equal(r.benchmark,null);
  assert.equal(homeResult({summary:summary({},{benchmark:null})}).benchmark,null,'no benchmark data');
});
test('"Not verified" for settlement-affected days; "Provisional" (the account value box\'s word) when an unconfirmed detected deposit is left out',()=>{
  const a=homeResult({summary:summary({},{settlementAffected:{pending:['2026-11-10']}})});assert.equal(a.total.tag.text,'Not verified');assert.match(a.total.tag.why,/awaiting settlement evidence/);
  const u=homeResult({summary:summary({provisional:{unresolved:[{day:'2026-11-09',market:'KR',currency:'KRW',amount:3000000}]}})});assert.equal(u.total.tag.text,'Provisional');assert.match(u.total.tag.why,/Money changes awaiting you are left out/);
  assert.equal(u.total.gain,20000,'the headline figure is the summary\'s, which leaves the deposit out');
});
test('Today: a provisional range, a bounded day, a correction, and an unavailable day',()=>{
  const last=extra=>summary({points:[point('2026-11-10',1010000),point('2026-11-11',1020000,extra)]});
  const ranged=homeResult({summary:last({pnlRange:{low:-500,high:2500}})}).today;assert.deepEqual(ranged.pnlRange,{low:-500,high:2500});assert.equal(ranged.returnRange,null);
  const bounded=homeResult({summary:last({dailyReturn:null,bounded:{returnRange:{low:-0.002,high:0.003}},pnlRange:{low:1,high:2}})}).today;assert.deepEqual(bounded.returnRange,{low:-0.002,high:0.003});assert.equal(bounded.pnlRange,null,'the bounded range is shown, as the box does');
  assert.equal(homeResult({summary:last({correction:-100000})}).today.correction,-100000);assert.equal(homeResult({summary:last({correction:0})}).today.correction,null);
  const gone=homeResult({summary:last({pnl:null,dailyReturn:null,unavailable:['the corrections could not be read; x']})}).today;assert.equal(gone.pnl,null);assert.equal(gone.reason,'the corrections could not be read');
  assert.equal(homeResult({summary:last({pnl:null})}).today.reason,'Not known for the latest day.');
});
test('Korea only: before the U.S. account and a rate are loaded, Unrealized counts Korean holdings and says so',()=>{
  const rows=[kr('005930',2,60000,61000),us('NYSE:RDDT',1,97.42,100.72,null)];
  const k=homeResult({summary:summary(),rows,usLoaded:false,usdLoaded:true});assert.equal(k.scope,'korea');assert.equal(k.unrealized.amount,2000);
  assert.equal(Math.round(k.unrealizedUSD.amount*100)/100,3.3,'the U.S. amount in dollars needs no rate');
  const both=homeResult({summary:summary(),rows:[kr('005930',2,60000,61000),us('NYSE:RDDT',1,97.42,100.72)],usLoaded:true,usdLoaded:true});assert.equal(both.scope,'both');assert.equal(Math.round(both.unrealized.amount),2000+Math.round(3.3*1400));
  const noUS=homeResult({summary:summary(),rows:[kr('005930',2,60000,61000),us('NYSE:RDDT',1,97.42,100.72)],usLoaded:true,usdLoaded:false});assert.equal(noUS.unrealizedUSD,null,'U.S. total not known');
});
test('Unrealized unknown: no account value yet, or a holding without cost; never zero',()=>{
  const a=homeResult({summary:summary(),rows:[kr('005930',2,60000,61000)],equityKnown:false});assert.deepEqual([a.unrealized.amount,a.unrealized.reason],[null,'The account value is not loaded yet.']);
  const b=homeResult({summary:summary(),rows:[kr('005930',2,0,61000)]});assert.deepEqual([b.unrealized.amount,b.unrealized.reason],[null,'A holding has no average cost or price.']);
  const none=homeResult({summary:summary(),rows:[]});assert.equal(none.unrealized.amount,0,'no holdings: zero is the true figure');assert.equal(none.unrealizedUSD,null);
});
test('no realized line: the result has no realized field',()=>{assert.equal('realized' in homeResult({summary:summary()}),false);});
test('periodNote: the account value box\'s note, word for word as HomeTrend had it, in the same order',async()=>{
  const {periodNote}=await import('../src/home-result.mjs');
  assert.deepEqual(periodNote({unavailable:['2026-11-05: exchange rate missing; x','2026-11-06: y','2026-11-07: z','2026-11-08: w']},{provisional:{unresolved:[{}]}}),
    {text:'Investment return unavailable: exchange rate missing (4 days affected).',why:'2026-11-05: exchange rate missing; x · 2026-11-06: y · 2026-11-07: z',missing:true});
  assert.deepEqual(periodNote({settlementAffected:{pending:[]}},{provisional:{unresolved:[{}]}}),{text:'Return estimate: settlement not verified.',why:'Includes days with U.S. buys awaiting settlement evidence, accounting corrections or restatements.',missing:false});
  assert.deepEqual(periodNote({},{provisional:{unresolved:[{}]}}),{text:'Provisional: money changes awaiting you are left out.',why:'Confirm or remove them on the Performance page.',missing:false});
  assert.equal(periodNote({},{}),null);assert.equal(periodNote(undefined,{}),null);
});
test('Today says "Unavailable" only for a recorded reason, as the box does; otherwise "—"',()=>{
  const last=extra=>summary({points:[point('2026-11-10',1010000),point('2026-11-11',1020000,extra)]});
  assert.equal(homeResult({summary:last({pnl:null,unavailable:['x']})}).today.unavailable,true);assert.equal(homeResult({summary:last({pnl:null})}).today.unavailable,false);
});
test('the performance records could not be read: Total and Today say so, not "starts after two days" (release gate 1.5.52, G3)',()=>{
  const f='The performance records could not be read.';
  const r=homeResult({summary:null,rows:[kr('005930',2,60000,61000)],usLoaded:true,failure:f});
  assert.equal(r.total.reason,f);assert.equal(r.today.reason,f);assert.equal(r.total.gain,null);assert.equal(r.unrealized.amount,2000,'Unrealized does not depend on the records');
  assert.equal(homeResult({summary:null}).total.reason,'Starts after values are recorded on two days.','no failure: the usual message');
  assert.equal(homeResult({summary:summary(),failure:f}).total.reason,null,'a summary that loaded wins over an earlier failure');
});
test('an unreadable deposit or withdrawal record: the box note and the Result tile tag say the return is an estimate (review of the 1.5.52 fixes)',async()=>{
  const {periodNote}=await import('../src/home-result.mjs');const s=summary({unreadableFlows:1,provisional:{unresolved:[{}]}},{settlementAffected:{pending:[]}});
  assert.equal(periodNote(s.periods.at(-1),s).text,'Return estimate: a deposit or withdrawal record could not be read.','before settlement and unresolved');
  const r=homeResult({summary:s});assert.deepEqual([r.total.tag.text,r.total.tag.why],['Return estimate','a deposit or withdrawal record could not be read.']);assert.equal(r.total.gain,20000,'the figure is still shown, tagged');
  assert.equal(periodNote({unavailable:['2026-11-05: x']},{unreadableFlows:1}).missing,true,'no return at all still comes first');
});
