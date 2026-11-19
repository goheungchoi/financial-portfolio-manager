// M-3 (artifacts/reviews/2026-11-16-multi-order/m3-plan.md): what main.cjs builds around the two engines, for tests that
// turn several open orders on (severalOpen, a LiveEngine constructor option main.cjs never passes; the guard test keeps
// it out of the app). Both engines on the mock broker (tests/helpers/mock-kis.cjs), with the real shared funding ledger,
// trading costs, product exposure and U.S. buying power, and the readings path main.cjs runs (detectFlows): the
// settlement tracker (with the recorder's same-reading split), the funding recorder, the Korean funding release and the
// flow detector, in READING_ORDER. tests/app-harness.test.cjs checks that order against main.cjs's own source, so a
// change of either is caught.
const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../../electron/live-engine.cjs');const {TradingCosts}=require('../../electron/trading-costs.cjs');const {usBuyingPower}=require('../../electron/buying-power.cjs');
const {FundingLedger}=require('../../electron/funding-ledger.cjs');const {Exposure}=require('../../electron/exposure.cjs');
const {InFlight,reportedOpenIds,splitContext,coveredInFlight}=require('../../electron/valuation.cjs');const {FundingTracker,settlement}=require('../../electron/integrated-settlement.cjs');
const {PerformanceHistory}=require('../../electron/performance.cjs');const {FlowDetector}=require('../../electron/flow-detector.cjs');const {FundingTransfers}=require('../../electron/funding-transfers.cjs');
// main.cjs detectFlows, in its order: the tracker (given the recorder's split, peekNet), the recorder's U.S. reading, its
// Korean reading, the Korean funding release by age, the flow detector.
const READING_ORDER=['inFlight.observe','fundingTransfers.observeUS','fundingTransfers.observeKR','fundingLedger.releaseAgedKR','flowDetector.observe'];
function appHarness({mock,severalOpen=true,db=new DatabaseSync(':memory:'),clock=()=>Date.now()}={}){
  const h={mock,db,severalOpen,state:{kr:null,us:null},flows:[]};
  // The balances the app holds (kisState.snapshot, usSnapshot), the U.S. one annotated as main.cjs does (usLive.annotateBalance).
  const refresh=()=>{h.state.kr=mock.balance('KR');h.state.us=mock.balance('US');h.ft?.annotate(h.state.us,h.rate());return h.state;};
  h.rate=()=>mock.accounts.US.fx;h.refresh=refresh;
  h.perf=new PerformanceHistory(db,clock);h.fd=new FlowDetector(db,h.perf,clock);h.ft=new FundingTracker(db,clock);h.inFlight=new InFlight(db,clock);
  h.rec=new FundingTransfers(db,{performance:h.perf,clock});h.costs=new TradingCosts(db);h.exposure=new Exposure(db);
  // The security master's rows (main.cjs keeps it in the same database): every stock the mock prices is a plain stock, so
  // product rules treat it as the app does a classified stock (an unclassified one needs your approval).
  db.exec('CREATE TABLE IF NOT EXISTS securities(symbol TEXT PRIMARY KEY,name TEXT NOT NULL,englishName TEXT NOT NULL,market TEXT NOT NULL,type TEXT NOT NULL,isin TEXT NOT NULL,industry TEXT)');// security-master.cjs's schema
  for(const s of Object.keys(mock.prices))db.prepare('INSERT OR IGNORE INTO securities(symbol,name,englishName,market,type,isin) VALUES(?,?,?,?,?,?)').run(s,s,s,s.includes(':')?'US':'KR','stock','');
  h.ledger=new FundingLedger(db,{fresh:async m=>{refresh();return m==='KR'?h.state.kr:h.state.us;},fx:()=>({usdKRW:h.rate(),timestamp:clock()}),alert:()=>{}});h.ledger.init();
  // The engines as main.cjs builds them (a restart builds them again on the same database and mock).
  h.build=()=>{const kr=new LiveEngine(db,mock.broker('KR'),()=>({status:'connected',snapshot:h.state.kr}),{severalOpen});
    const us=new LiveEngine(db,mock.broker('US'),()=>({snapshot:h.state.kr&&h.state.us?.accountKey===h.state.kr.accountKey+':US'?h.state.us:null}),{market:'US',severalOpen});
    for(const e of [kr,us]){e.costs=h.costs;e.exposure=h.exposure;e.funding=h.ledger;}
    // The Korean stocks the app watches beyond those held (main.cjs: the watchlist and candidates), so their quotes come.
    kr.extraSymbols=async()=>Object.keys(mock.prices).filter(s=>/^[0-9]{6}$/.test(s));
    us.buyingPower=b=>usBuyingPower({usdCash:b?.cash??0,broker:b?.brokerBuyingPower??null,krwCash:h.state.kr?(Number.isFinite(h.state.kr.settledCash)?h.state.kr.settledCash:h.state.kr.cash):null,usdKRW:b?.fx?.usdKRW??h.rate()});
    us.krReading=()=>h.state.kr;h.kr=kr;h.us=us;return h;};
  refresh();h.build();
  // Trading on in both markets, with automatic orders, and no loss limit unless a test sets one.
  h.enable=(limits={})=>{for(const e of [h.kr,h.us]){e.configure({symbols:[],lossLimit:{mode:'off',value:0},...limits},'ENABLE MOCK');e.enableAuto('ENABLE AUTO MOCK');}return h;};
  h.restart=()=>{refresh();h.build();h.kr.enabled=h.us.enabled=true;h.kr.autoEnabled=h.us.autoEnabled=true;return h;};
  h.engine=market=>market==='US'?h.us:h.kr;
  // An order proposed and sent (your submission, or automatic): its record after the send, or the error's code.
  h.send=async(market,symbol,side,quantity,limitPrice,{automatic=false}={})=>{refresh();const e=h.engine(market);let o;try{o=e.propose({symbol,side,quantity,limitPrice});}catch(error){return {error:error.message};}
    try{return automatic?await e.autoSubmit(o.id):await e.submit(o.id,'PLACE MOCK ORDER');}catch(error){return {error:error.message,order:e.orders().find(r=>r.id===o.id)};}};
  h.reconcile=async market=>{const e=h.engine(market);try{await e.reconcile();return null;}catch(error){return error.message;}};
  h.order=(market,id)=>h.engine(market).orders().find(o=>o.id===id);
  // One reading through main.cjs's path, in READING_ORDER; detected flows are collected.
  const steps={
    'inFlight.observe':s=>{const t=h.inFlight.current('acct');const netting=s.us.settlementProvisional?null:h.rec.peekNet('acct',{us:s.us,orders:h.us.orders(),fx:h.rate(),openOrderIds:new Set(t.open.filter(p=>p.side==='Buy').map(p=>String(p.id))),openBuysUSD:t.buysUSD,reportedOpenIds:reportedOpenIds(t)});
      h.inFlight.observe('acct',{us:s.us,orders:h.us.orders(),fx:h.rate(),netting,krwGroups:h.rec.current('acct').krwRouteGroups});},
    'fundingTransfers.observeUS':s=>{if(s.us.settlementProvisional)return;const t=h.inFlight.current('acct');h.rec.observeUS('acct',{us:s.us,orders:h.us.orders(),fx:h.rate(),openOrderIds:new Set(t.open.filter(p=>p.side==='Buy').map(p=>String(p.id))),openBuysUSD:t.buysUSD,reportedOpenIds:reportedOpenIds(t)});},
    'fundingTransfers.observeKR':s=>{h.rec.observeKR('acct',{korea:s.kr,orders:h.kr.orders()});},
    'fundingLedger.releaseAgedKR':()=>{h.ledger.releaseAgedKR('acct');},
    'flowDetector.observe':s=>{const route=h.rec.current('acct'),f=settlement(s.us),t=h.inFlight.current('acct'),fx=h.rate();
      const c=splitContext(s.us,t,route,fx),kr=(Number.isFinite(s.kr.settledCash)?s.kr.settledCash:s.kr.cash)-(route.krwUnpaidKRW??route.krwKRW);
      for(const flow of h.fd.observe('acct',{usExplained:range=>h.inFlight.explained('acct',range),krCash:kr,provisionalKRW:route.provisionalKRW,provisionalOutsideKRW:Math.max(0,route.provisionalKRW-(c?.reportedInFlightUSD??0)*fx),unsettledKRW:f.unsettledKRW,
        usCash:s.us.cash+(s.us.pendingSaleProceeds??0)-Math.max(0,(t.buysUSD??0)-coveredInFlight(t,route,fx))+(t.sellsUSD??0)-(route.usUSD??0),funding:route.explained,fx,orders:[...h.kr.orders(),...h.us.orders()]}))if(flow.detected)h.flows.push(flow);}};
  // Readings a test makes back to back are at least 2 ms apart from what follows them (a fill counted in the same
  // millisecond as the reading before would read as counted then; the app's readings are seconds apart).
  h.reading=()=>{const s=refresh();for(const name of READING_ORDER)steps[name](s);const t=Date.now();while(Date.now()<t+2){}return h;};
  // M-3.5: the automation over these engines, as main.cjs attaches them (automation.live / usLive), with a stub provider
  // whose decision the test writes (an injected review: no provider call), the order book from the mock's prices, and
  // the U.S. refresh from the mock. h.decide(d) sets the next decision.
  h.automation=(config={})=>{const {Automation}=require('../../electron/automation.cjs');const {PaperEngine}=require('../../electron/paper-engine.cjs');h.logs=[];
    h.decision={action:'Hold',symbol:'',quantity:0,explanation:'Injected review: hold.'};h.decide=d=>{h.decision={explanation:'Injected review.',...d};return h;};
    const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:70000,name:'A'}],()=>[]),{request:async op=>op==='decision'?{provider:'openai',decision:h.decision}:{}},(...x)=>h.logs.push(x));
    a.live=h.kr;a.usLive=h.us;a.refreshUS=async()=>mock.request('US','context',{});a.fx=()=>({usdKRW:h.rate(),source:'mock'});a.providerStatus.aiConnected=true;a.wait=async()=>{};
    a.orderBook=async s=>mock.prices[s]>0?{status:'available',retrievedAt:Date.now(),data:{bid:mock.prices[s],ask:mock.prices[s],quoteAt:Date.now()}}:{status:'unavailable',reason:'NO_TWO_SIDED_BOOK'};
    a.marketQuotes=()=>Object.entries(mock.prices).filter(([s])=>!s.includes(':')).map(([symbol,price])=>({symbol,price,timestamp:Date.now(),retrievedAt:Date.now()}));
    a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true,...config});h.a=a;return a;};
  // A conditional order armed as a review's set_conditional_order stores it (desk.setOrder), and fired.
  h.arm=(args)=>h.a.desk.setOrder(h.a.watchScope(),{action:'add',id:'',limitPrice:null,combine:'all',expiresInHours:24,reason:'Injected.',...args},{config:h.a.config,universe:Object.keys(mock.prices)});
  h.fire=async id=>{const o=h.a.desk.orders(h.a.watchScope()).find(x=>x.id===id)??h.a.desk.orders(h.a.watchScope())[0];await h.a.fireConditional(o);return h.a.desk.recentOrders(h.a.watchScope()).find(x=>x.id===o.id)??h.a.desk.orders(h.a.watchScope()).find(x=>x.id===o.id);};
  return h;}
module.exports={appHarness,READING_ORDER};
