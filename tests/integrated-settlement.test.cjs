const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {settlement,fundingStep,FundingTracker}=require('../electron/integrated-settlement.cjs');const {combinePortfolio}=require('../electron/portfolio-view.cjs');const {combinedContext}=require('../electron/combined-context.cjs');
// 2026-10-24 01:4x KST: 3 Samsung E&A in Korea; 1 Alphabet and 1 Nvidia bought through integrated margin, not yet settled.
const kr={timestamp:'t',cash:1500001,settledCash:1319081,holdings:[{symbol:'028050',name:'E&A',quantity:3,cost:60300,price:59100}]};
const us={timestamp:'t',cash:0,unsettled:{buyKRW:714383,sellKRW:0},holdings:[{symbol:'NASD:GOOGL',name:'A',quantity:1,cost:323.64,price:323.08},{symbol:'NASD:NVDA',name:'N',quantity:1,cost:212.73,price:212.04}]};
const fx={usdKRW:1324.6};
test('KRW committed to unsettled U.S. buys is not counted twice (2026-10-24 regression)',()=>{
  const p=combinePortfolio(kr,us,fx);assert.equal(p.committedKRW,714383);assert.equal(p.cash.KRW,1319081-714383);
  assert.ok(Math.abs(p.totals.equityKRW-1490818)<2,`equity ${p.totals.equityKRW} ≈ ₩1.49m, not ₩2.2m`);
  const before=combinePortfolio(kr,{...us,unsettled:undefined},fx);assert.ok(before.totals.equityKRW>2200000,'without the KIS figure it double counts');
  assert.equal(settlement({...us,cash:50}).unsettledKRW,714383,'USD cash on hand: the full amount is still subtracted (uncertainty is reported separately)');assert.equal(settlement({...us,unsettled:{buyKRW:714383,sellKRW:800000}}).unsettledKRW,0);
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
// Review of 1.5.34: a $900 Alphabet-sized purchase (₩1,192,140 at ₩1,324.6) funded by KRW, by USD, or by both.
const BUY=1192140,RATE=1324.6,t0=Date.parse('2026-10-26T14:00:00Z');
test('review fix: only funding known to be KRW is a confirmed obligation; the rest stays uncertain until settlement',()=>{
  const step=(prevUSD,nowUSD,gap=60000)=>fundingStep({at:t0,usCash:prevUSD,unsettledKRW:0,krwFundedKRW:0},{at:t0+gap,usCash:nowUSD,unsettledKRW:BUY},RATE).krwFundedKRW;
  assert.equal(step(0,0),BUY,'KRW-funded: no USD was held just before the purchase');
  assert.equal(step(1000,100),0,'USD-funded: $100 left does not bound how much USD paid; all of it is uncertain');
  assert.equal(step(100,0),Math.floor(BUY-100*RATE*1.02),'mixed: only the amount beyond the USD held before is known KRW');
  assert.equal(step(0,0,20*60000),0,'no fresh reading before the purchase: unknown');assert.equal(step(0,50),0,'USD arrived in between: unknown');
  assert.equal(fundingStep(null,{at:t0,usCash:0,unsettledKRW:BUY},RATE).krwFundedKRW,0,'first seen with a purchase outstanding: unknown');
  // Partial settlement keeps the uncertain part until it is gone; settlement in full clears it.
  const known=step(100,0);const partial=fundingStep({at:t0,usCash:0,unsettledKRW:BUY,krwFundedKRW:known},{at:t0+60000,usCash:0,unsettledKRW:600000},RATE);
  assert.equal(600000-partial.krwFundedKRW,BUY-known,'the uncertain part remains');assert.equal(fundingStep(partial,{at:t0+120000,usCash:0,unsettledKRW:0},RATE).krwFundedKRW,0);
  const us={cash:0,unsettled:{buyKRW:BUY,sellKRW:0,krwFundedKRW:known}};assert.deepEqual(settlement(us),{unsettledKRW:BUY,confirmedKRW:known,uncertainKRW:BUY-known});
  const p=combinePortfolio(kr,{...us,holdings:[]},fx);assert.equal(p.cash.KRW,1319081-BUY,'valuation subtracts all of it (conservative)');assert.equal(p.settlementUncertainKRW,BUY-known);
});
test('review fix: no deposit, withdrawal or transfer is inferred from an uncertain settlement adjustment',()=>{
  const {FlowDetector}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
  const run=(prevUSD,nowUSD,settledKRWAfter)=>{let now=t0;const db=new DatabaseSync(':memory:');const tracker=new FundingTracker(db,()=>now);const d=new FlowDetector(db,new PerformanceHistory(db,()=>now),()=>now);const flows=[];
    const order={market:'US',side:'Buy',status:'Filled',filled:1,fillPrice:900,resultCosts:{netCash:-900},createdAt:t0+30000};
    const observe=(krSettled,usCash,unsettled,orders=[])=>{const bal=tracker.annotate({accountKey:'a:US',cash:usCash,unsettled:{buyKRW:unsettled,sellKRW:0}},RATE);const f=settlement(bal);
      const found=d.observe('a',{krCash:krSettled-f.confirmedKRW,usCash,fx:RATE,orders,provisionalKRW:f.uncertainKRW});flows.push(found.map(x=>[x.market,x.amount,x.transfer??false]));};
    observe(2000000,prevUSD,0);now+=60000;observe(2000000,nowUSD,BUY,[order]);now+=60000;observe(2000000,nowUSD,BUY,[order]);
    now+=60000;observe(2500000,nowUSD,BUY,[order]);now+=86400000;observe(settledKRWAfter,nowUSD,0,[order]);now+=60000;observe(settledKRWAfter,nowUSD,0,[order]);return flows;};
  const usd=run(1000,100,2500000);assert.deepEqual(usd[1],[],'USD-funded: the old calculation invented a ₩1,192,140 withdrawal here');
  assert.deepEqual(usd[3],[],'held first');assert.deepEqual(usd[4],[['KR',500000,false]],'a real deposit during a stable uncertain window is still detected');assert.deepEqual(usd[5],[],'settlement is not a flow');
  const krw=run(0,0,2500000-BUY);assert.deepEqual(krw[1],[['KR',-BUY,true],['US',900,true]],'KRW-funded: a known transfer between markets');assert.deepEqual(krw.slice(3),[[],[['KR',500000,false]],[]],'the deposit after its hold; settlement is not a withdrawal');
  const mixed=run(100,0,2500000-(BUY-Math.ceil(100*RATE))),flat=mixed.flat();assert.deepEqual(mixed[1],[],'mixed: nothing inferred at the purchase');assert.deepEqual(mixed[4],[['KR',500000,false]]);assert.deepEqual(mixed[5],[],'nor at settlement');assert.ok(flat.length===1);
});
test('review fix: settlement uncertainty reaches the equity reliability check through the full assembly path',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const assemble=async(prevUSD,nowUSD)=>{let now=Date.now();const db=new DatabaseSync(':memory:');const tracker=new FundingTracker(db,()=>now);
    const krSnap={accountKey:'acct',environment:'live',reportedTotal:2000000,cash:2000000,settledCash:2000000,holdings:[]};
    const usBal={accountKey:'acct:US',environment:'live',reportedTotal:900+nowUSD,cash:nowUSD,holdings:[{symbol:'NASD:GOOGL',name:'Alphabet',quantity:1,cost:900,price:900}],unsettled:{buyKRW:BUY,sellKRW:0}};
    tracker.annotate({...usBal,cash:prevUSD,unsettled:{buyKRW:0,sellKRW:0}},RATE);now+=60000;
    const usValue={balance:usBal,quotes:[{symbol:'NASD:GOOGL',price:900,retrievedAt:now}],marketSession:{open:true,status:'open'}};
    const live=new LiveEngine(db,{request:async()=>({balance:krSnap,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot:krSnap}));
    const usLive=new LiveEngine(db,{request:async()=>usValue},()=>({status:'connected',snapshot:usBal}),{market:'US'});usLive.annotateBalance=b=>tracker.annotate(b,RATE);
    const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{request:async()=>{throw new Error('no AI call');}},()=>{});
    a.live=live;a.usLive=usLive;a.refreshUS=async()=>usValue;a.fx=()=>({usdKRW:RATE,source:'fixture'});a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[];
    a.configure({scope:'both',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low'});
    const {context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'Dry run',setStage:()=>{}});db.close();return context;};
  const usd=await assemble(1000,100);assert.equal(usd.equityReliability.reliable,false);assert.deepEqual(usd.equityUncertainty,{understatedUpToKRW:BUY,reasons:['funding of ₩1,192,140 of unsettled U.S. buys is not yet known (KRW or USD)']});
  assert.deepEqual(usd.equityReliability.reasons,usd.equityUncertainty.reasons);assert.match(usd.markets.find(m=>m.market==='KR').cashNote,/equity may be understated by up to that amount/);
  const krw=await assemble(0,0);assert.equal(krw.equityReliability.reliable,true,'known KRW funding: reliable');assert.equal(krw.equityUncertainty,undefined);assert.equal(krw.cash.KRW,2000000-BUY);
});
test('review fix: when a USD-funded buy of unknown funding settles before a KRW-funded one, no deposit is invented',()=>{
  const {FlowDetector}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');let now=t0;
  const db=new DatabaseSync(':memory:');const tracker=new FundingTracker(db,()=>now);const d=new FlowDetector(db,new PerformanceHistory(db,()=>now),()=>now);const found=[];
  const observe=(krSettled,usCash,unsettled)=>{const bal=tracker.annotate({accountKey:'a:US',cash:usCash,unsettled:{buyKRW:unsettled,sellKRW:0}},RATE);const f=settlement(bal);
    found.push(...d.observe('a',{krCash:krSettled-f.confirmedKRW,usCash,fx:RATE,provisionalKRW:f.uncertainKRW,unsettledKRW:f.unsettledKRW}));now+=60000;};
  observe(3000000,740,0);observe(3000000,0,980000);// B: paid from the USD held, funding unknown
  observe(3000000,0,2380000);// A: no USD left, known KRW-funded
  observe(3000000,0,1400000);// B settles first; Korean cash does not move
  observe(1600000,0,0);observe(1600000,0,0);// A settles in KRW
  assert.deepEqual(found.filter(f=>f.detected),[],'the old rule recorded a ₩980,000 deposit at the third reading');
});
// Oct 28: after a restart the Korean value was recorded before the U.S. balance (and the ₩81,855 committed to the
// Pentair buy) had loaded, so the day's Korean value rose by that amount and Korean returns showed +12%.
test('the day value is not recorded while the U.S. balance that Korean equity depends on is still loading',()=>{
  const {PerformanceHistory}=require('../electron/performance.cjs');let now=Date.parse('2026-10-28T09:00:00Z');const p=new PerformanceHistory(new DatabaseSync(':memory:'),()=>now);
  p.record('a',{totals:{KRW:714609,USD:607.07,equityKRW:1517500},cash:{KRW:415376,USD:0},fx:{usdKRW:1322.6}});now+=60000;
  assert.equal(p.record('a',{totals:{KRW:797731,USD:null,equityKRW:null},cash:{KRW:497231,USD:null},fx:null},{awaitingUS:true}),null,'nothing recorded while waiting');
  assert.equal(p.history('a').at(-1).KRW.equity,714609,'the earlier value of the day stays');
  p.record('a',{totals:{KRW:714700,USD:607.1,equityKRW:1517700},cash:{KRW:415376,USD:0},fx:{usdKRW:1322.6}},{awaitingUS:false});assert.equal(p.history('a').at(-1).KRW.equity,714700);
});
// Review of Oct 27-28: the agent received a Korean -10.33% day and a U.S. +12.04% day that came from an unrecorded
// transfer between markets. Returns now say whether they measure market performance, separately from equity.
test('returns are marked unreliable while unconfirmed flows, unexplained cash changes or unknown funding are inside them',()=>{
  const {returnReliability}=require('../electron/performance.cjs');
  assert.deepEqual(returnReliability({}),{reliable:true});
  const r=returnReliability({unconfirmed:[{day:'2026-10-28',amount:-81855,currency:'KRW'}],checking:[{amount:61.71,currency:'USD',since:'2026-10-27T18:45:30.000Z'}],uncertainKRW:712078});
  assert.equal(r.reliable,false);assert.deepEqual(r.reasons,['a detected withdrawal of ₩81,855 on 2026-10-28 is not confirmed; returns treat it as one','a cash change of +$61.71 since 2026-10-27 18:45 UTC is not yet explained; returns count it as gain or loss','funding of ₩712,078 of unsettled U.S. buys is not yet known, so Korean value may be understated']);
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','main.cjs'),'utf8');assert.match(src,/returnReliability:reliability/,'given to reviews with the performance summary');assert.match(src,/returnReliability is separate from equityReliability/);
});
// P2/P3: the startup skip applies in every scope (Korean equity always depends on the U.S. balance), and an old U.S.
// error is forgotten when the connection resets.
test('the startup skip does not depend on scope, and a reconnect forgets an old U.S. error',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','main.cjs'),'utf8');
  assert.match(src,/awaitingUS:!usSnapshot&&!usLive\.refreshError\}/);assert.doesNotMatch(src,/awaitingUS:\['both','us'\]/);
  assert.deepEqual(src.match(/;usSnapshot=null;(?!if\(usLive\)usLive\.refreshError=null)/g)??[],[],'every reset of the U.S. snapshot clears its error');
  assert.equal((src.match(/usSnapshot=null;if\(usLive\)usLive\.refreshError=null;/g)??[]).length,3);
});
