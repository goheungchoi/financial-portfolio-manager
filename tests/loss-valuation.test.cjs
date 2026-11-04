// The daily loss and new-exposure checks on the account valuation (audit 2026-11-04, Stage 2, the user's rules): the
// loss switches with its baseline at a trading-day boundary, on one valuation version; deposits, withdrawals and
// funding uncertainty are not losses; an ambiguous breach is reported and restricts new exposure without claiming a
// loss; new-exposure checks use the corrected value at once.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const {LiveEngine}=require('../electron/live-engine.cjs');
const VERSION=require('../electron/valuation.cjs').VERSION;
function engine({market='KR',total=1000000}={}){const snapshot={accountKey:'acct'+(market==='US'?':US':''),environment:'live',reportedTotal:total,cash:total,holdings:[]};
  const e=new LiveEngine(new DatabaseSync(':memory:'),{request:async()=>{}},()=>({status:'connected',snapshot}),{market});let day='2026-11-04';e.day=()=>day;e.setDay=d=>{day=d;};
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30000}},'ENABLE LIVE');return {e,snapshot};}
test('a day that started on the KIS total stays on it; the valuation takes over at the next trading-day boundary',()=>{
  const {e,snapshot}=engine();let v={low:900000,high:960000,version:VERSION};e.netEquityOf=()=>v;
  e.observeBalance({...snapshot,reportedTotal:990000});let loss=e.getState().loss;assert.equal(loss.version,'broker-total');assert.equal(loss.loss,10000,'KIS total all day');assert.equal(e.policy().valuation,undefined);
  e.setDay('2026-11-05');e.observeBalance({...snapshot,reportedTotal:990000});const p=e.policy();assert.equal(p.valuation,VERSION);assert.equal(p.baseline,900000);assert.equal(p.baselineHigh,960000);assert.ok(Number.isFinite(p.baselineAt));
  v={low:880000,high:940000,version:VERSION};loss=e.getState().loss;assert.equal(loss.version,VERSION);assert.equal(loss.loss,20000,'baseline and value on the same valuation');assert.equal(loss.breached,false);
  // The valuation unavailable later the same day: never mixed with the KIS total; the doubt is reported.
  e.netEquityOf=()=>null;loss=e.getState().loss;assert.equal(loss.breached,false);assert.match(loss.reasons[0],/not available now/);
});
test('a breach under every scenario is a breach; under some only it is ambiguous and claims no loss',()=>{
  const {e,snapshot}=engine();e.setDay('2026-11-05');let v={low:1000000,high:1000000,version:VERSION};e.netEquityOf=()=>v;e.observeBalance(snapshot);
  v={low:960000,high:960000,version:VERSION};let loss=e.getState().loss;assert.equal(loss.breached,true);assert.equal(loss.ambiguous,false);
  // Exact at the start; now an estimate whose high bound is above the limit: ambiguous.
  v={low:960000,high:990000,version:VERSION};loss=e.getState().loss;assert.equal(loss.breached,false);assert.equal(loss.ambiguous,true);assert.match(loss.reasons[0],/breached only with low bounds/);
  assert.deepEqual(loss.scenarios.map(s=>s.breached),[true,false]);
});
test('deposits and withdrawals are not losses: confirmed ones adjust the baseline, unresolved ones are a scenario',()=>{
  const {e,snapshot}=engine();e.setDay('2026-11-05');let v={low:1000000,high:1000000,version:VERSION};e.netEquityOf=()=>v;e.observeBalance(snapshot);
  let flows={confirmed:500000,unresolved:0};e.flowsSince=()=>flows;v={low:1480000,high:1480000,version:VERSION};let loss=e.getState().loss;assert.equal(loss.loss,20000,'the deposit is not gain');assert.equal(loss.breached,false);
  // A detected withdrawal awaiting you: value fell with it; the loss is only a scenario.
  flows={confirmed:0,unresolved:-50000};v={low:950000,high:950000,version:VERSION};loss=e.getState().loss;assert.equal(loss.breached,false);assert.equal(loss.ambiguous,true,'breached unless the withdrawal is real');
  assert.match(loss.reasons[0],/breached only with low bounds and high bounds/);
  flows={confirmed:-50000,unresolved:0};loss=e.getState().loss;assert.equal(loss.loss,0,'a confirmed withdrawal is not a loss');
  // Funding uncertainty resolving toward the high bound moves the value up: never a loss.
  flows={confirmed:0,unresolved:0};v={low:1000000,high:1000000,version:VERSION};assert.equal(e.getState().loss.loss,0);
});
test('the U.S. day is the New York date (the overnight session belongs to it), and its flows are those since its baseline',()=>{
  const {e,snapshot}=engine({market:'US',total:500});const seen=[];e.flowsSince=p=>{seen.push(p.baselineAt);return {confirmed:0,unresolved:0};};e.setDay('2026-11-04');e.netEquityOf=()=>({low:500,high:500,version:VERSION});
  e.observeBalance(snapshot);e.setDay('2026-11-05');e.observeBalance(snapshot);const at=e.policy().baselineAt;e.getState();assert.equal(seen.at(-1),at,'flows since the baseline was taken, not the Seoul day');
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/live-engine.cjs'),'utf8'),/this\.market==='US'\?require\('\.\/kis-overseas\.cjs'\)\.localDate:seoulDate/);
});
test('new exposure is measured against the corrected value at once, never above the KIS total',()=>{
  const {e,snapshot}=engine({total:1000000});assert.equal(e.exposureBase(snapshot),1000000,'no valuation: KIS total');
  e.netEquityOf=()=>({low:870000,high:1000000,version:VERSION,loss:{low:1000000,high:1000000}});assert.equal(e.exposureBase(snapshot),870000,'KRW committed to U.S. buys deducted');
  e.netEquityOf=()=>({low:1100000,high:1100000,version:VERSION});assert.equal(e.exposureBase(snapshot),1000000);
  e.netEquityOf=()=>({low:870000,high:1000000,version:VERSION,loss:{low:1000000,high:1000000}});assert.deepEqual(e.lossValue(snapshot),{low:1000000,high:1000000,version:VERSION},'the loss leaves out money moving between the markets');
});
