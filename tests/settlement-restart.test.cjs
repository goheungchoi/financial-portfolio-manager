// S4b-2 (settlement clean-up, condition E): the stage 2b gate's restart check, moved here without the reconciliation and
// the settlements panel (both removed). Every settlement table and state that remains is reloaded after a restart: the
// tracker, the evidence ledger and its events, the funding commitments, the day's baseline snapshot and its adjustments,
// the flow detector's state and recorded flows, and a trade-history job stopped by a failed read with its gaps.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {InFlight}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {FlowDetector}=require('../electron/flow-detector.cjs');const {SettlementBaseline}=require('../electron/settlement-baseline.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const {TradingCosts}=require('../electron/trading-costs.cjs');
const MIN=60000,HOUR=3600000,RATE=1300;
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-10-29',createdAt:Date.parse('2026-10-25T15:00:00Z'),...extra});
const sale=(id,usd)=>order(id,usd,{side:'Sell',costEstimate:undefined,resultCosts:{netCash:usd}});
function world({file,start}){const db=new DatabaseSync(file);let t=start;const clock=()=>t;let day='2026-10-29';
  db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');
  const us={cash:500,holdings:[{symbol:'NASD:X',quantity:1,price:1000}]},fx=()=>({usdKRW:RATE,source:'test',timestamp:new Date(t).toISOString()});
  const U=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:us.holdings,reportedTotal:us.cash+1000,fx:fx(),timestamp:new Date(t).toISOString()});
  const f=new InFlight(db,clock,{settleDays:null}),funding=new FundingLedger(db,{clock,fresh:async()=>U(),fx}),perf=new PerformanceHistory(db,clock),fd=new FlowDetector(db,perf,clock),sb=new SettlementBaseline(db,{inFlight:f,clock});
  const eU=new LiveEngine(db,{request:async()=>({balance:U(),quotes:[]})},()=>({status:'connected',snapshot:U()}),{market:'US'});eU.day=()=>day;
  eU.baselineTaken=p=>sb.take('a',p.day,p.baselineAt);eU.settlementAdjustments=p=>sb.adjustments('a',p);
  if(!eU.policy())eU.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:30}},'ENABLE LIVE');
  const costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});
  return {db,f,funding,perf,fd,sb,eU,costs,us,U,clock,later:ms=>{t+=ms;},
    open:os=>{f.observe('a',{us:U(),orders:[],fx:RATE});t+=MIN;for(const o of os)if(o.side==='Buy')funding.track(o);f.observe('a',{us:U(),orders:os,fx:RATE});t+=MIN;},
    baseline:()=>{day='2026-10-28';eU.observeBalance(U());day='2026-10-29';eU.observeBalance(U());t+=HOUR;},
    detect:()=>{const v=f.current('a');return fd.observe('a',{krCash:1000000,usCash:us.cash-v.buysUSD+v.sellsUSD,fx:RATE,orders:[],usExplained:r=>f.explained('a',r),usReview:v.review});}};}

test('restart (moved from the stage 2b gate): the tracker, evidence, funding, baseline, detector and a stopped history job are reloaded as they were',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'settlement-restart-'));const file=path.join(dir,'p.sqlite');
  const list=[order('A',100),order('B',50),order('C',25),sale('S',80)];
  const w=world({file,start:Date.parse('2026-10-29T03:00:00Z')});w.open(list);w.baseline();w.detect();w.later(MIN);w.us.cash+=300;w.detect();w.later(MIN);
  // A trade-history job stopped by a failed read, under its own key, as the order checks used.
  const key='a#settlement-check:C',failed=await w.costs.syncHistory('a',async()=>{throw new Error('RATE_LIMITED');},{plan:()=>[{start:'2026-10-28',end:'2026-10-30'}],key,exact:true,pages:100,ms:60000,clock:w.clock});
  assert.equal(failed.stopped,'FAILED');
  const state=x=>({tracker:x.f.current('a'),events:x.f.evidence.events('a'),funding:x.funding.commitments('a'),baseline:x.sb.get('a','2026-10-29'),adjustments:x.sb.adjustments('a',x.eU.policy()),
    flows:x.perf.flows('a'),pending:x.fd.pending('a'),watch:x.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get('a').payload,job:x.costs.jobs.get(key),gaps:x.costs.gaps.list('a')});
  const before=state(w);assert.ok(before.tracker.open.length>=4,'pieces open');assert.ok(before.baseline,'a baseline snapshot');assert.ok(before.pending.length>0,'a change held');assert.ok(before.job);
  assert.equal('recordIds' in before.baseline,false,'S4b-2: no reconciliation record ids in a new snapshot');
  const t=w.clock();w.db.close();
  // A new process: every module constructed again on the same file, at the same time.
  const r=world({file,start:t});const after=state(r);
  for(const k of Object.keys(before))if(k!=='job')assert.deepEqual(after[k],before[k],k);
  assert.deepEqual({...after.job,state:null},{...before.job,state:null},'the job is kept');assert.equal(after.job.state,'paused');
  r.db.close();fs.rmSync(dir,{recursive:true,force:true});
});
