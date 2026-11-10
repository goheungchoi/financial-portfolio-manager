// Stage 2b.6 gate: the composition harness (design v1 §10, v3 §9: "each asserts that Home, history, review context,
// sizing and free funds, and risk agree") and T39 restated under the Stage 1 funding rules (v3.3 §2).
// The harness builds the five consumers from one database state the way electron/main.cjs does:
// - Home: combinePortfolio(korea, us, fx, metadata, {inFlight}) (main portfolioState);
// - history: PerformanceHistory.record(account, portfolioState) (main recordValue);
// - review context: the combined valuation's low bound as the equity, its width as the understatement
//   (automation.valuation → context.equity, equityUncertainty.understatedUpToKRW);
// - sizing: each engine's exposureBase(balance) and the funding ledger's capacity (free funds);
// - risk: each engine's lossValue and daily-loss check (netEquityOf = valuation.marketValue, as main sets it).
// Each step of stage 2b (bootstrap, reconciliation with a named or unknown route, partial, reversal, timing, the baseline)
// is applied and all five are compared.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {InFlight,marketValue}=require('../electron/valuation.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const {Reconciliation}=require('../electron/settlement-reconciliation.cjs');const {SettlementBaseline}=require('../electron/settlement-baseline.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const {FlowDetector}=require('../electron/flow-detector.cjs');const {SettlementPanel}=require('../electron/settlement-panel.cjs');const {combinePortfolio}=require('../electron/portfolio-view.cjs');
const MIN=60000,HOUR=3600000,RATE=1300,RHO=1326;
const order=(id,usd,extra={})=>({id,symbol:'NASD:T'+id,side:'Buy',status:'Filled',quantity:1,filled:1,fillPrice:usd,limitPrice:usd,costEstimate:{netCash:-usd},resultCosts:{netCash:-usd},environment:'live',accountKey:'a:US',market:'US',day:'2026-11-05',createdAt:Date.parse('2026-11-01T15:00:00Z'),...extra});
const sale=(id,usd)=>order(id,usd,{side:'Sell',costEstimate:undefined,resultCosts:{netCash:usd}});
function world({file=':memory:',start=Date.now()-6*HOUR}={}){const db=new DatabaseSync(file);let t=start;const clock=()=>t;let day='2026-11-05';
  const kr={cash:1000000,settledCash:1000000,holdings:[{symbol:'000270',quantity:2,price:100000}]},us={cash:500,holdings:[{symbol:'NASD:X',quantity:1,price:1000}]};
  const fx=()=>({usdKRW:RATE,source:'test',timestamp:new Date(t).toISOString()});
  const K=()=>({accountKey:'a',environment:'live',...kr,reportedTotal:kr.settledCash+kr.holdings.reduce((n,h)=>n+h.quantity*h.price,0),timestamp:new Date(t).toISOString()});
  const U=()=>({accountKey:'a:US',environment:'live',cash:us.cash,pendingSaleProceeds:0,holdings:us.holdings,...(us.unsettled?{unsettled:us.unsettled}:{}),reportedTotal:us.cash+us.holdings.reduce((n,h)=>n+h.quantity*h.price,0),fx:fx(),timestamp:new Date(t).toISOString()});
  // Free funds: the ledger's own inputs (fresh balances, KIS's reported unsettled U.S. total, the rate), read from the
  // fixture balances through the hooks main.cjs gives it (stage 2b.6 review: reportedKRW was fixed at zero).
  const f=new InFlight(db,clock,{settleDays:null}/* age rule off until S3/S4 removes these tests */),funding=new FundingLedger(db,{clock,fresh:async m=>m==='KR'?K():U(),fx}),perf=new PerformanceHistory(db,clock),fd=new FlowDetector(db,perf,clock),sb=new SettlementBaseline(db,{inFlight:f,clock});
  // main.cjs marketValue: the Korean value nets the U.S. side's funding, so each engine reads both balances.
  const mv=market=>()=>marketValue(market,{korea:K(),us:U(),fx:fx(),inFlight:f.current('a'),now:t});
  const engine=(market,snap)=>{const e=new LiveEngine(db,{request:async()=>({balance:snap(),quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot:snap()}),{market});e.day=()=>day;e.netEquityOf=mv(market);
    e.flowsSince=policy=>fd.flowsSince('a',market,policy?.baselineAt);e.flowsToday=()=>perf.flowsOn('a',require('../electron/kis-activity.cjs').seoulDate(t),market);
    // A restart keeps the stored policy (the day's baseline); only a new profile is configured.
    if(!e.policy())e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'amount',value:market==='US'?30:100000}},'ENABLE LIVE');return e;};
  const eK=engine('KR',K),eU=engine('US',U);eU.baselineTaken=p=>sb.take('a',p.day,p.baselineAt);eU.settlementAdjustments=p=>sb.adjustments('a',p);
  const rec=new Reconciliation(db,{inFlight:f,funding,performance:perf,clock,who:{user:'t',session:'s'},loss:()=>({KR:eK.currentLoss(),US:eU.currentLoss()})});
  const panel=new SettlementPanel({inFlight:f,reconciliation:rec,flowDetector:fd,clock});
  const home=()=>combinePortfolio(K(),U(),fx(),{},{inFlight:f.current('a'),now:t});
  const {Automation}=require('../electron/automation.cjs'),{PaperEngine}=require('../electron/paper-engine.cjs');
  const automation=new Automation(db,new PaperEngine(db,[{symbol:'000270',price:100000,name:'Fixture'}],()=>[]),{request:async()=>{throw new Error('NO_PROVIDER_IN_TESTS');}},()=>{});
  automation.configure({scope:'both'});automation.live=eK;automation.usLive=eU;automation.refreshUS=async()=>null;automation.fx=fx;automation.valuation=()=>home().valuation;
  automation.evidence={get:async()=>({})};automation.series={closes:()=>null,ensure:async()=>{}};automation.marketQuotes=()=>[];
  let seq=0,orders=[];
  const w={db,f,funding,perf,rec,fd,sb,panel,eK,eU,kr,us,K,U,clock,later:ms=>{t+=ms;},setOrders:os=>{orders=os;},
    open:(...os)=>{orders=os;f.observe('a',{us:U(),orders:[],fx:RATE});t+=MIN;for(const o of os)if(o.side==='Buy')funding.track(o);f.observe('a',{us:U(),orders:os,fx:RATE});t+=MIN;},
    pid:id=>f.current('a').open.find(p=>p.id===id)?.pid,
    baseline:()=>{day='2026-11-04';eU.observeBalance(U());eK.observeBalance(K());day='2026-11-05';eU.observeBalance(U());eK.observeBalance(K());t=Math.max(t,Date.now())+HOUR;},
    reconcile:(id,extra={})=>{const q={requestId:'r'+(++seq),account:'a',pieceId:w.pid(id),cents:Math.round(f.current('a').open.find(p=>p.id===id).usd*100),explanation:'settled',route:'USD',kisReference:'KIS',note:'checked',...extra};const p=rec.preview(q);const r=rec.confirm({...q,stateVersion:p.stateVersion,binding:p.binding});return {preview:p,record:r};},
    reverse:rid=>{const q={requestId:'v'+(++seq),account:'a',reconciliationId:rid,note:'wrong'};const p=rec.previewReversal(q);return rec.reverse({...q,stateVersion:p.stateVersion,binding:p.binding});},
    inputs:market=>funding.inputs(market,null,{account:'a',environment:'live'}),
    capacity:async market=>funding.capacity({account:'a',market,inputs:await w.inputs(market)}),automation,
    // The five consumers from the current state.
    compose:async()=>{const h=home();const history=perf.record('a',h);
      // The review context the automation assembles for a combined review (engines' contexts, then the valuation).
      const {context:review}=await automation.assembleReviewContext({watchScope:automation.watchScope(),trigger:'User request'});
      return {home:h,history,review,sizing:{KR:eK.exposureBase(K()),US:eU.exposureBase(U()),capacity:{KR:await w.capacity('KR'),US:await w.capacity('US')}},inputs:{KR:await w.inputs('KR'),US:await w.inputs('US')},net:{KR:eK.netEquityOf(K()),US:eU.netEquityOf(U())},
        risk:{KR:eK.lossValue(K()),US:eU.lossValue(U()),check:{KR:eK.currentLoss(),US:eU.currentLoss()}},tracker:f.current('a'),panel:panel.view('a',{orders,environment:'live'})};}};
  return w;}
// All five agree on one state.
function agree(x,label){const V=x.home.valuation,US=V.markets.US.equity,KR=V.markets.KR.equity,C=V.combined,m=s=>`${label}: ${s}`;
  assert.equal(x.home.totals.USD,US.low,m('Home U.S. total is the U.S. low bound'));assert.equal(x.home.totals.KRW,KR.low,m('Home Korean total'));assert.equal(x.home.totals.equityKRW,C.low,m('Home combined'));
  assert.equal(x.history.USD.equity,US.low,m('history U.S.'));assert.equal(x.history.KRW.equity,KR.low,m('history Korea'));assert.equal(x.history.equityKRW,C.low,m('history combined'));
  assert.deepEqual([x.history.valuation.low,x.history.valuation.high,x.history.valuation.exact],[C.low,C.high,C.exact],m('history bounds'));
  assert.equal(x.review.environment,'kis-combined',m('a combined review'));assert.equal(x.review.equity,Math.round(C.low),m('review equity'));
  assert.equal(x.review.equityUncertainty?.understatedUpToKRW??0,C.exact?0:Math.round(C.high-C.low),m('review understatement'));
  // Free funds read KIS's reported unsettled U.S. total from the same balance the valuation read.
  assert.equal(x.inputs.KR.reportedKRW,Math.max(0,Number(x.inputs.KR.us?.unsettled?.buyKRW)||0),m('reported KRW from the balance'));assert.equal(x.inputs.KR.us.timestamp,x.home.timestamps.US,m('the same U.S. balance'));
  assert.deepEqual([x.net.US.low,x.net.US.high],[US.low,US.high],m('sizing/risk U.S. value'));assert.deepEqual([x.net.KR.low,x.net.KR.high],[KR.low,KR.high],m('sizing/risk Korean value'));
  assert.equal(x.sizing.US,Math.min(x.home.valuation.markets.US.broker.reportedTotal,US.low),m('U.S. exposure base'));
  const kf=V.markets.KR.components.find(c=>c.name==='usBuyFunding');assert.equal(x.risk.KR.low,KR.low-(kf?.low??0),m('Korean loss value'));assert.equal(x.risk.US.low,US.low,m('U.S. loss value'));
  for(const k of ['KR','US']){assert.ok(x.risk.check[k],m(`${k} loss check present`));assert.equal(x.risk.check[k].version,require('../electron/valuation.cjs').VERSION,m(`${k} loss check on the valuation`));assert.equal(x.risk.check[k].equity,x.risk[k].low,m(`${k} loss check on the same value`));}
  // The panel's summary is the tracker's, which valuation read.
  assert.deepEqual(x.panel.summary.unresolved,x.tracker.unresolved,m('panel unresolved'));assert.deepEqual(x.panel.summary.inFlight,{buysUSD:x.tracker.buysUSD,sellsUSD:x.tracker.sellsUSD},m('panel in flight'));
  const ib=V.markets.US.components.find(c=>c.name==='inFlightBuys');assert.equal(ib?-ib.low:0,x.tracker.buysUSD,m('valuation buys in flight are the tracker figure'));}

test('Gate harness, T1-T3, T25a, T30 path: bootstrap, named-route and unknown-route reconciliation, partial and reversal: Home, history, review, sizing and risk agree at every step',async()=>{
  const w=world();w.open(order('A',100),order('B',50),order('C',25),order('D',10),sale('S',80));w.baseline();
  // T1: four pre-tracking buys and one sale, none verified.
  let x=await w.compose();agree(x,'bootstrap');const US=()=>x.home.valuation.markets.US.equity;
  assert.deepEqual([US().low,US().high],[1500-185,1500+80],'the low bound counts the four buys; the sale raises only the high bound');assert.equal(x.home.valuation.combined.exact,false);
  assert.ok(x.home.valuation.combined.reasons.some(r=>/5 pre-tracking U\.S\. fills awaiting verification/.test(r)));
  const k0=x.sizing.capacity.KR,u0=x.sizing.capacity.US;assert.equal(k0,1000000-185*RHO,'floating commitments held at the worst case');assert.ok(Math.abs(u0-(1000000-185*RHO)/RHO)<1e-6,'the sale adds no capacity');
  assert.equal(x.panel.summary.unresolved.buysUSD,185);assert.match(x.panel.home.detail,/\$185\.00 lowers equity and buying capacity/);
  // T2: A reconciled with route USD: the obligation resolves, the commitment falls by $100, capacity rises by that only.
  w.later(MIN);w.reconcile('A');x=await w.compose();agree(x,'named route');assert.deepEqual([US().low,US().high],[1500-85,1580]);
  assert.equal(x.sizing.capacity.KR-k0,100*RHO);assert.ok(Math.abs(x.sizing.capacity.US-u0-100)<1e-6);
  // T3: B reconciled, route unknown: the valuation resolves, the commitment stays for capacity, and the panel says so.
  const k1=x.sizing.capacity.KR;w.later(MIN);w.reconcile('B',{route:'unknown'});x=await w.compose();agree(x,'unknown route');assert.equal(US().low,1500-35);assert.equal(x.sizing.capacity.KR,k1);
  assert.deepEqual(x.panel.funding.map(z=>[z.orderId,z.retainedUSD,z.reason]),[['B',50,'route unknown']]);
  // T25a: C ($25) partly: $10 then a $20 request is refused before any preview; $15 closes it.
  w.later(MIN);const r10=w.reconcile('C',{cents:1000}).record;x=await w.compose();agree(x,'partial');assert.equal(US().low,1500-25);
  assert.throws(()=>w.rec.preview({requestId:'big',account:'a',pieceId:w.pid('C'),cents:2000,explanation:'settled',route:'USD',kisReference:'K',note:'n'}),/AMOUNT_EXCEEDS_REMAINING/);
  // Reversal of the $10: it reopens $10 only; every consumer follows.
  w.later(MIN);w.reverse(r10.id);x=await w.compose();agree(x,'reversal');assert.equal(US().low,1500-35);
  w.later(MIN);w.reconcile('C');w.reconcile('D');w.reconcile('S',{route:undefined});x=await w.compose();agree(x,'all reconciled');
  assert.deepEqual([US().low,US().high],[1500,1500],'all resolved');assert.equal(x.panel.summary.unresolved.buysUSD,0);
  assert.equal(x.home.valuation.markets.US.exact,true);assert.deepEqual(x.panel.funding.map(z=>z.orderId),['B'],'only the unknown route keeps funding');
  // KRW committed to U.S. buys that KIS reports (integrated margin): the Korean value nets it, the Korean loss leaves it
  // out (a transfer between the markets), and every consumer agrees.
  const kBefore=x.sizing.capacity.KR;w.us.unsettled={buyKRW:130000,sellKRW:0,krwFundedKRW:130000};x=await w.compose();agree(x,'reported U.S. funding');
  assert.equal(x.inputs.KR.reportedKRW,130000,'read from the balance');assert.equal(kBefore-x.sizing.capacity.KR,100*RHO,'counted once, as C_US += $100 at rho (T37j)');
  assert.equal(x.home.valuation.markets.KR.equity.low,1200000-130000);assert.equal(x.risk.KR.low,1200000);
});
test('Gate harness, T25b/T44, T28/T46 and the 2b.5 preview: the daily-loss baseline, its scenarios and the preview agree with Home, history and sizing',async()=>{
  const w=world();w.open(order('A',100));w.baseline();let x=await w.compose();agree(x,'baseline');
  assert.equal(x.risk.check.US.loss,0);
  // Paid before the baseline: the value and the baseline move together; the preview's "after" is what every consumer
  // then reads.
  const {preview}=w.reconcile('A',{settledOn:'2026-11-04'});x=await w.compose();agree(x,'reconciled');assert.deepEqual(preview.after.loss.US,Reconciliation.lossSummary(x.risk.check.US));
  assert.equal(x.risk.check.US.loss,0);assert.deepEqual(x.risk.check.US.settlement.adjustment,{low:100,high:0});
  // A recorded $200 withdrawal after the baseline (the flow history the engines read through flowsSince): every consumer
  // sees $200 less, and the loss check counts it as money moved, not as a loss.
  const at=w.eU.policy().baselineAt;w.us.cash-=200;w.perf.addFlow('a',{day:require('../electron/kis-activity.cjs').seoulDate(w.clock()),market:'US',amount:-200,note:'withdrawal',occurredAfter:at+1,occurredBy:w.clock()});
  x=await w.compose();agree(x,'withdrawal');assert.equal(x.risk.check.US.loss,0,'a withdrawal is not a loss');assert.equal(x.risk.check.US.breached,false);
  // A genuine $35 market loss stays visible on every consumer.
  w.us.holdings=[{symbol:'NASD:X',quantity:1,price:965}];x=await w.compose();agree(x,'market loss');assert.equal(x.risk.check.US.loss,35);assert.equal(x.risk.check.US.breached,true);
  // Unknown timing: both scenarios; the two agree with the value every consumer reads.
  const y=world();y.open(order('A',100));y.baseline();y.reconcile('A');const z=await y.compose();agree(z,'unknown timing');assert.ok(z.risk.check.US.scenarios.some(s=>/paid before the baseline/.test(s.name)));
  // T46: with a genuine $40 loss the scenarios disagree: ambiguous, and the automation reads the U.S. market as ambiguous
  // (new buys restricted, a protective sale allowed: agent-desk.test.cjs covers that rule on this state).
  y.us.holdings=[{symbol:'NASD:X',quantity:1,price:960}];const a=await y.compose();agree(a,'ambiguous');assert.equal(a.risk.check.US.breached,false);assert.equal(a.risk.check.US.ambiguous,true);
  const em=require('../electron/automation.cjs').Automation.prototype.emergencyState.call({config:{scope:'both'},live:y.eK,usLive:y.eU});assert.deepEqual([em.active,em.ambiguousMarkets],[false,['US']]);
});
test('Gate harness: settlement timing and a reversal withdrawing it leave every consumer in agreement and no false flow',async()=>{
  const w=world();w.open(order('A',100));w.baseline();const detect=()=>{const v=w.f.current('a');return w.fd.observe('a',{krCash:1000000,usCash:w.us.cash-v.buysUSD+v.sellsUSD,fx:RATE,orders:[],usExplained:r=>w.f.explained('a',r),usReview:v.review});};
  detect();w.later(MIN);const {record}=w.reconcile('A');w.later(MIN);detect();let x=await w.compose();agree(x,'timing open');assert.ok(x.risk.check.US.scenarios.some(z=>/all uncertain money changes/.test(z.name)),'the open timing reaches the loss check through flowsSince');assert.equal(x.panel.summary.timingOpen,1);
  w.later(MIN);w.reverse(record.id);w.later(MIN);detect();x=await w.compose();agree(x,'reversed');assert.equal(x.panel.summary.timingOpen,0);assert.equal(w.perf.flows('a').length,0);
  assert.equal(x.home.valuation.markets.US.equity.low,1400);
});
test('T39 (restated under the Stage 1 funding rules, v3.3 §2): the worked example with an unresolved bootstrap buy, both sequences, and its release by reconciliation',async()=>{
  // U.S. cash $500, Korean settled cash 1,000,000, rate 1,300 (rho 1,326), F = $100 (one unresolved bootstrap buy).
  // Unknown regime: no USD counts toward capacity; every U.S. commitment is KRW at rho.
  const w=world();w.us.cash=500;w.open(order('F',100));const kCap=()=>w.capacity('KR'),uCap=()=>w.capacity('US');const RAW=async m=>w.inputs(m);
  assert.equal(await kCap(),1000000-132600);assert.ok(Math.abs(await uCap()-867400/RHO)<1e-6,'U.S. capacity $654.15');
  const check=async(market,cost)=>w.funding.check({market,cost,commitments:w.funding.commitments('a'),inputs:await RAW(market)}).fits;
  // Sequence A: a U.S. $600 buy fits (795,600 of 867,400); then a Korean 700,000 buy does not (71,800 left).
  assert.equal(await check('US',600),true);w.funding.track(order('G',600,{status:'Accepted',filled:0,fillPrice:null,resultCosts:null}));assert.equal(Math.round(await kCap()),71800);assert.equal(await check('KR',700000),false);
  // Worst case for every route of F and the U.S. buy, at the actual rate: KRW used 130,000 + 780,000 within 1,000,000.
  assert.ok(100*RATE+600*RATE<=1000000);
  // Sequence B: a Korean 800,000 first fits; then a U.S. $600 does not ($50.83 left).
  const v=world();v.open(order('F',100));const vc=async(market,cost)=>v.funding.check({market,cost,commitments:v.funding.commitments('a'),inputs:await v.inputs(market)}).fits;
  assert.equal(await vc('KR',800000),true);v.funding.track({id:'K1',accountKey:'a',environment:'live',market:'KR',symbol:'000270',side:'Buy',status:'Accepted',quantity:8,filled:0,limitPrice:100000});
  const cKR=v.funding.commitments('a').krw;assert.ok(cKR>=800000);assert.ok(Math.abs(await v.capacity('US')-(1000000-cKR-132600)/RHO)<1e-6,'about $50 (less the fee estimate)');assert.ok(await v.capacity('US')<51);assert.equal(await vc('US',600),false);
  // Stage 2b: F reconciled with a named route releases exactly $100 (132,600 of Korean capacity); route unknown none.
  const before=await kCap();w.reconcile('F');assert.equal(await kCap()-before,132600);
  const u=world();u.open(order('F',100));const b2=await u.capacity('KR');u.reconcile('F',{route:'unknown'});assert.equal(await u.capacity('KR'),b2);
});
test('T4 (tracker side): a fill whose dates are in an incomplete history window stays unresolved; its KIS row is not linked and the panel names the gap; a complete read restores the link (A1 off: still supporting only)',()=>{
  const {TradingCosts}=require('../electron/trading-costs.cjs');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');
  let t=Date.parse('2026-11-05T20:00:00Z');const clock=()=>t;const f=new InFlight(db,clock,{settleDays:null}/* age rule off until S3/S4 removes these tests */),costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});
  const panel=new SettlementPanel({inFlight:f,costs,clock});const o={id:'A',symbol:'NASD:TEST',side:'Buy',filled:1,fillPrice:100,resultCosts:{netCash:-100},environment:'live',day:'2026-11-05',createdAt:Date.parse('2026-11-05T15:00:00Z')};
  const us=()=>({timestamp:new Date(t).toISOString(),environment:'live',cash:500});f.observe('a',{us:us(),orders:[],fx:1300});t+=MIN;f.observe('a',{us:us(),orders:[o],fx:1300});t+=MIN;
  const row={tradeDate:'2026-11-05',settlementDate:'2026-11-06',ticker:'TEST',side:'Buy',quantity:1,price:100,grossUSD:100,settlementUSD:100,settlementKRW:130000,feesUSD:0,exchangeRate:1300};const W={start:'2026-11-01',end:'2026-11-06'};
  costs.importHistory('a',[{...W,complete:true,rows:[row]}],t);let p=panel.view('a',{orders:[o]}).pieces[0];assert.equal(p.evidence.k.state,'linked');assert.equal(p.state,'unresolved','A1 off');
  costs.importHistory('a',[{...W,complete:false,reason:'PAGE_LIMIT',rows:[]}],t);p=panel.view('a',{orders:[o]}).pieces[0];
  assert.equal(p.evidence.k.state,'uncertain');assert.match(p.evidence.k.reason,/trade-history gap/);assert.deepEqual(p.evidence.historyGap,{start:'2026-11-01',end:'2026-11-06',reason:'PAGE_LIMIT'});
  assert.ok(p.unknown.some(u=>/could not be read completely/.test(u)));assert.equal(p.state,'unresolved');assert.equal(f.current('a').unresolved.buysUSD,100);
  assert.ok(costs.historyGaps().some(g=>g.start==='2026-11-01'),'the tax report lists the gap');
  costs.importHistory('a',[{...W,complete:true,rows:[row]}],t);p=panel.view('a',{orders:[o]}).pieces[0];assert.equal(p.evidence.k.state,'linked');assert.equal(p.evidence.historyGap,null);
  assert.equal(require('../electron/settlement-evidence.cjs').SettlementEvidence.prototype.kGroups.call({db},'a').length,1,'no duplicated row');
});
test('Gate restart: every stage 2b table and state is reloaded after a restart: tracker, evidence, records, funding, baseline, timing, withdrawals and a stopped check job',async()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gate-'));const file=path.join(dir,'p.sqlite');
  const {TradingCosts}=require('../electron/trading-costs.cjs');
  const w=world({file});w.db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');const list=[order('A',100),order('B',50),order('C',25),sale('S',80)];w.open(...list);w.baseline();
  const detect=()=>{const v=w.f.current('a');return w.fd.observe('a',{krCash:1000000,usCash:w.us.cash-v.buysUSD+v.sellsUSD,fx:RATE,orders:[],usExplained:r=>w.f.explained('a',r),usReview:v.review});};
  detect();w.later(MIN);w.reconcile('A',{settledOn:'2026-11-04'});const b=w.reconcile('B',{route:'unknown'}).record;const c=w.reconcile('C',{cents:1000}).record;w.reconcile('S',{route:undefined});w.later(MIN);detect();
  w.reverse(c.id);w.later(MIN);
  // A check job stopped by a failed read, stored under its own key.
  const costs=new TradingCosts(w.db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});const panel=new SettlementPanel({inFlight:w.f,reconciliation:w.rec,flowDetector:w.fd,costs,clock:w.clock});
  const failed=await panel.checkAgain('a',w.pid('C'),{orders:list,environment:'live',today:'2026-11-06',fetch:async()=>{throw new Error('RATE_LIMITED');}});assert.equal(failed.stopped,'FAILED');
  const state=(x,p,cs)=>({tracker:x.f.current('a'),panel:p.view('a',{orders:list,environment:'live'}),records:x.rec.records('a'),events:x.f.evidence.events('a').length,funding:x.funding.commitments('a'),
    adjustments:x.sb.adjustments('a',x.eU.policy()),timing:x.fd.timing('a'),flows:x.perf.flows('a'),job:cs.jobs.get(SettlementPanel.checkKey('a','C')),gaps:cs.gaps.list('a'),watch:x.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get('a').payload});
  const before=state(w,panel,costs);assert.equal(before.timing.length,1);assert.ok(before.records.length>=5);assert.ok(before.job);
  const t=w.clock();w.db.close();
  // A new process: every module constructed again on the same file, at the same time.
  const r=world({file,start:t});r.setOrders(list);const costs2=new TradingCosts(r.db);costs2.currentAccount=()=>({accountKey:'a',environment:'live'});const panel2=new SettlementPanel({inFlight:r.f,reconciliation:r.rec,flowDetector:r.fd,costs:costs2,clock:r.clock});
  const after=state(r,panel2,costs2);
  for(const k of Object.keys(before))if(k!=='panel'&&k!=='job')assert.deepEqual(after[k],before[k],k);
  assert.deepEqual({...after.job,state:null},{...before.job,state:null},'the job is kept');assert.equal(after.job.state,'paused');
  const strip=v=>JSON.parse(JSON.stringify(v,(key,val)=>key==='check'?undefined:val));assert.deepEqual(strip(after.panel),strip(before.panel),'the panel reads the same');
  // Repeats after the restart are still recognised; a stale timing resolution of the reversed record is still refused.
  assert.throws(()=>r.fd.resolveTiming('a',before.timing[0].id,{reconciliationId:c.id,paidHere:true}),/TIMING_CANDIDATE_REVERSED/);
  const again=r.rec.confirm({requestId:'r2',account:'a',pieceId:b.pieceId,cents:5000,explanation:'settled',route:'unknown',kisReference:'KIS',note:'checked',stateVersion:'x',binding:b.contentHash});assert.equal(again.repeat,true);assert.equal(again.id,b.id);
  // The composition still agrees after the restart.
  agree(await r.compose(),'after restart');r.db.close();fs.rmSync(dir,{recursive:true,force:true});
});
