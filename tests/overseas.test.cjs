const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const {OverseasClient,instrument,usSession}=require('../electron/kis-overseas.cjs');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const {TradingCosts,DEFAULT_COSTS,estimateCosts,validateCosts}=require('../electron/trading-costs.cjs');
const {combinePortfolio,PortfolioView}=require('../electron/portfolio-view.cjs');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
test('combined valuations use FX once, preserve native currencies and persist honest sector/region assignments',()=>{
  const kr={cash:1000,timestamp:'2026-10-15',holdings:[{symbol:'005930',name:'Samsung',quantity:2,price:100,cost:90}]},us={cash:10,timestamp:'2026-10-15',holdings:[{symbol:'NASD:AAPL',name:'Apple',quantity:3,price:200,cost:150}]};
  const unknown=combinePortfolio(kr,us,null);assert.equal(unknown.totals.equityKRW,null);assert.equal(unknown.totals.KRW,1200);assert.equal(unknown.totals.USD,610);assert.equal(unknown.rows[1].valueKRW,null);
  const db=new DatabaseSync(':memory:'),view=new PortfolioView(db);view.save('NASD:AAPL',{sector:'Technology',region:'Global technology'});const combined=combinePortfolio(kr,us,{usdKRW:1400},new PortfolioView(db).metadata());assert.equal(combined.totals.equityKRW,855200);assert.equal(combined.rows[1].nativeValue,600);assert.equal(combined.rows[1].sector,'Technology');assert.equal(combined.rows[0].sector,'Unclassified');assert.equal(combinePortfolio(kr,null,{usdKRW:1400}).totals.equityKRW,null);db.close();
});
test('both-market AI reviews route native prices and only automatically submit into the selected open market',async()=>{
  for(const [symbol,krOpen,usOpen,expected] of [['NASD:AAPL',false,true,'US'],['005930',true,false,'KR'],['005930',false,true,null],['NASD:AAPL',true,false,null]]){
    const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],()=>[]);let supplied;const submitted=[],proposed=[];
    const make=(market,open,symbol,price)=>({market,enabled:true,getState:()=>({loss:null}),context:async()=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity:1000,cash:500,positions:{},universe:[{symbol,price}],quotes:[{symbol,price,stale:!open}],orders:[],risk:{baseline:1000,lossLimit:{mode:'off',value:0}},marketSession:{open,status:open?'open':'closed'}}),propose:command=>{proposed.push({market,...command});return {id:'proposal',status:'Ready'};},autoSubmit:async()=>{submitted.push(market);return {id:'executed'};}});
    const automation=new Automation(db,paper,{request:async(_op,{context})=>{supplied=context;return {provider:'openai',decision:{action:'Buy',symbol,quantity:1,explanation:'Joint review.'}};}},()=>{});automation.live=make('KR',krOpen,'005930',70000);automation.usLive=make('US',usOpen,'NASD:AAPL',200.001);automation.refreshUS=async()=>{};automation.fx=()=>({usdKRW:1400,source:'fixture'});automation.providerStatus.aiConnected=true;automation.configure({scope:'both',provider:'openai',shareKisWithAI:true,autoSubmit:true});await automation.review();assert.equal(supplied.currency,'MULTI');assert.equal(supplied.cash.USD,500);assert.equal(supplied.cash.KRW,500);assert.equal(supplied.equity,1401000);assert.equal(supplied.markets.length,2);assert.deepEqual(submitted,expected?[expected]:[]);assert.equal(proposed[0]?.market??null,expected?(symbol==='005930'?'KR':'US'):null,'a closed market makes no proposal (it is kept as a pending decision)');if(expected==='US')assert.equal(proposed[0].limitPrice,200.01);db.close();
  }
});
test('overseas empty and object payloads normalize, quote failures retain balances, diagnostics exclude private text',async()=>{
  const {publicUSCode,stage}=require('../electron/us-errors.cjs');const original=fixture();const client=original.client,request=client.client.overseasRequest.bind(client.client);
  client.client.overseasRequest=async(...args)=>{const result=await request(...args);if(args[0].includes('/price'))throw new Error('AUTH_FAILED');if(args[0].includes('inquire-balance')){result.body.output1=Array.isArray(result.body.output1)?result.body.output1[0]??{}:result.body.output1;}if(args[0].includes('inquire-present-balance'))result.body.output2=result.body.output2[0];return result;};
  const context=await client.context(['NASD:AAPL']);assert.equal(context.balance.reportedTotal,3000);assert.equal(context.quotes.length,0);assert.equal(context.warnings[0].code,'US_QUOTES_AUTH_FAILED');assert.equal(publicUSCode('US_CASH_AUTH_FAILED'),'US_CASH_AUTH_FAILED');assert.equal(publicUSCode('my-private-key'),'US_REQUEST_FAILED');await assert.rejects(stage('CASH',async()=>{const error=new Error('BROKER_REJECTED');error.brokerCode='APBK1234';throw error;}),error=>error.message==='US_CASH_BROKER_REJECTED'&&error.brokerCode==='APBK1234');
});
test('tax estimates apply annual deduction once, include historical KRW basis and never invent missing tax inputs',()=>{
  const args={market:'US',side:'Sell',symbol:'NASD:AAPL',quantity:10,price:200,costPerShare:150};
  const missing=estimateCosts(args);assert.equal(missing.capitalGainsTaxKRW,null);assert.equal(missing.gross,2000);assert.equal(missing.commission,5);assert.equal(missing.transactionTax,.04);assert.equal(missing.netCash,1994.96);assert.equal(missing.gainAfterFees,491.21);
  const settings={...DEFAULT_COSTS,usdKRW:1400,annualRealizedKRW:2400000,taxBasisKRW:{'NASD:AAPL':200000}};
  const sale=estimateCosts({...args,settings});assert.equal(sale.taxableGainKRW,792944);assert.equal(sale.capitalGainsTaxKRW,152430,'national ₩138,580 + local ₩13,850, amounts below 10 won dropped');assert.equal(sale.gainAfterEstimatedTax,382.33);assert.equal(sale.incomeTax.status,'estimated');
  const sheltered=estimateCosts({...args,settings:{...settings,annualRealizedKRW:0}});assert.equal(sheltered.capitalGainsTaxKRW,0);
  assert.equal(estimateCosts({...args,price:100,settings:{...settings,annualRealizedKRW:3000000}}).capitalGainsTaxKRW,-110000);
  assert.equal(estimateCosts({...args,settings:{...settings,taxYear:2020}}).capitalGainsTaxKRW,null);assert.deepEqual(missing.incomeTax.missingInputs,['KRW acquisition basis','USD/KRW exchange rate','gains realized this year']);assert.equal(missing.incomeTax.status,'incomplete');
  assert.equal(estimateCosts({market:'KR',side:'Sell',quantity:10,price:10000,costPerShare:9000}).netCash,99785);
  assert.throws(()=>validateCosts({usCommissionPct:-1}),/INVALID_COST/);assert.throws(()=>validateCosts({usdKRW:0}),/INVALID_COST/);
  const db=new DatabaseSync(':memory:'),costs=new TradingCosts(db);costs.save(settings);assert.equal(new TradingCosts(db).get().usdKRW,1400);db.close();
});
test('U.S. calendar uses Eastern DST, holidays, early closes and a ten-minute closing buffer',()=>{
  assert.equal(usSession(new Date('2026-10-15T13:29:00Z')).open,false);assert.equal(usSession(new Date('2026-10-15T13:30:00Z')).open,true);
  assert.equal(usSession(new Date('2026-10-15T19:50:00Z')).open,false);assert.equal(usSession(new Date('2026-12-01T14:30:00Z')).open,true);
  for(const date of ['2026-07-03T16:00:00Z','2026-11-26T17:00:00Z','2026-04-03T16:00:00Z','2026-05-25T16:00:00Z','2026-06-19T16:00:00Z','2026-12-25T17:00:00Z'])assert.equal(usSession(new Date(date)).open,false,date);
  assert.equal(usSession(new Date('2026-11-27T17:49:00Z')).open,true);assert.equal(usSession(new Date('2026-11-27T17:50:00Z')).open,false);
  assert.deepEqual(instrument('NYSE:BRK.B'),{exchange:'NYSE',ticker:'BRK.B'});assert.throws(()=>instrument('AAPL'),/INVALID_ORDER/);
});
test('annual gains are the outside-app baseline plus app sales from the KRW ledger, and saving never double-counts',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');const costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'acct',environment:'live'});const year=DEFAULT_COSTS.taxYear;costs.save({...DEFAULT_COSTS,annualRealizedKRW:2000000});
  const put=order=>db.prepare('INSERT INTO live_intents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(order.id,'acct:US',JSON.stringify({accountKey:'acct:US',environment:'live',...order}));
  put({id:'buy',market:'US',side:'Buy',symbol:'NASD:TEST',filled:10,fillPrice:100,day:`${year}-03-02`,createdAt:1,resultCosts:{commission:0,transactionTax:0}});
  put({id:'sale',market:'US',side:'Sell',symbol:'NASD:TEST',filled:10,fillPrice:110,day:`${year}-10-15`,createdAt:2,resultCosts:{commission:0,transactionTax:0}});
  costs.saveRates([{date:`${year}-03-03`,value:1300},{date:`${year}-10-16`,value:1400}],'test');
  assert.equal(costs.get().annualRealizedKRW,2000000+(1540000-1300000),'proceeds 10 x 110 x 1,400 minus cost 10 x 100 x 1,300');
  costs.save(costs.saved());assert.equal(costs.saved().annualRealizedKRW,2000000,'the saved value stays the outside-app figure');assert.equal(costs.get().annualRealizedKRW,2240000);
  db.close();
});
function fixture(present=null){const calls=[];const raw=new KisReadOnlyClient({environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'},async(url,options)=>{calls.push({url,options});const params=new URL(url).searchParams;let body={rt_cd:'0'};
  if(url.endsWith('/oauth2/tokenP'))body={access_token:'fixture-token',expires_in:3600};
  else if(url.includes('inquire-balance'))body.output1=params.get('OVRS_EXCG_CD')==='NASD'?[{ovrs_pdno:'AAPL',ovrs_excg_cd:'NASD',tr_crcy_cd:'USD',ovrs_cblc_qty:'10',ord_psbl_qty:'10',pchs_avg_pric:'150',now_pric2:'200',ovrs_stck_evlu_amt:'2000'}]:[];
  else if(url.includes('inquire-present-balance'))Object.assign(body,present??{output2:[{crcy_cd:'USD',frcr_dncl_amt_2:'1000',account:'private'}]});
  else if(url.includes('/price?'))body.output={last:'200',private:'excluded'};
  else if(url.includes('inquire-psamount'))body.output={ord_psbl_qty:'5',ord_psbl_frcr_amt:'1000',echm_af_ord_psbl_qty:'99999'};
  else if(url.includes('inquire-ccnl'))body.output=[];
  else if(url.endsWith('/order'))body.output={ODNO:'42'};
  else throw new Error('Unexpected request');return new Response(JSON.stringify(body));},async()=>{});
  return {client:new OverseasClient(raw,()=>new Date('2026-10-15T15:00:00Z')),calls};
}
test('U.S. adapter normalizes USD only, uses overseas IDs and limits buys to existing foreign cash',async()=>{
  const {client,calls}=fixture();const context=await client.context(['NASD:AAPL']);assert.equal(context.balance.currency,'USD');assert.equal(context.balance.reportedTotal,3000);assert.equal(context.balance.holdings[0].symbol,'NASD:AAPL');assert.equal(context.quotes[0].price,200);assert.ok(!JSON.stringify(context).includes('fixture-secret'));assert.ok(!JSON.stringify(context).includes('private'));
  const buy={symbol:'NASD:AAPL',side:'Buy',quantity:2,limitPrice:200.01};await client.prepare(buy);await assert.rejects(client.prepare({...buy,quantity:5}),/INSUFFICIENT_CAPACITY/);await assert.rejects(client.prepare({...buy,limitPrice:200.001}),/INVALID_ORDER/);await assert.rejects(client.prepare({...buy,side:'Sell',quantity:11}),/INSUFFICIENT_CAPACITY/);
  assert.equal((await client.place(buy)).brokerOrderId,'42');await client.place({...buy,side:'Sell'});const posts=calls.filter(row=>row.options.method==='POST'&&row.url.endsWith('/order'));assert.equal(posts.length,2);assert.equal(posts[0].options.headers.tr_id,'VTTT1002U');assert.equal(posts[1].options.headers.tr_id,'VTTT1001U');assert.equal(JSON.parse(posts[0].options.body).OVRS_ORD_UNPR,'200.01');assert.equal(JSON.parse(posts[0].options.body).OVRS_EXCG_CD,'NASD');assert.ok(calls.every(row=>!row.url.includes('domestic-stock')));
});
test('U.S. intents stay separate from domestic account, preserve approval and price cents, recompute partial sale costs',async()=>{
  const db=new DatabaseSync(':memory:');const balance={accountKey:'fixture:US',environment:'mock',reportedTotal:3000,cash:1000,holdings:[{symbol:'NASD:AAPL',quantity:10,cost:150,price:200}]};let posts=0;
  const broker={request:async(operation)=>{if(operation==='prepare-order')return {balance,ticket:'ticket'};if(operation==='place-order'){posts++;return {brokerOrderId:'42'};}if(operation==='orders')return {orders:[{orderId:'42',filled:1,fillPrice:201.12,status:'Partially filled'}]};throw new Error(operation);}};
  const engine=new LiveEngine(db,broker,()=>({snapshot:balance}),{market:'US'});engine.costs=new TradingCosts(db);
  engine.configure({symbols:['NASD:AAPL']},'ENABLE MOCK');const order=engine.propose({symbol:'NASD:AAPL',side:'Sell',quantity:2,limitPrice:200.01});assert.equal(order.currency,'USD');assert.equal(order.costEstimate.gross,400.02);
  await assert.rejects(engine.submit(order.id,''),/APPROVAL_REQUIRED/);await engine.submit(order.id,'PLACE MOCK ORDER');await engine.submit(order.id,'PLACE MOCK ORDER');assert.equal(posts,1);await engine.reconcile();const filled=engine.orders()[0];assert.equal(filled.filled,1);assert.equal(filled.resultCosts.gross,201.12);assert.equal(filled.resultCosts.commission,.5);
  const domestic=new LiveEngine(db,broker,()=>({snapshot:{...balance,accountKey:'fixture'}}));assert.equal(domestic.orders().length,0);assert.equal(domestic.getState().enabled,false);assert.throws(()=>domestic.configure({symbols:['NASD:AAPL']},'ENABLE MOCK'),/INVALID_LIMITS/);db.close();
});
test('U.S. order history for Activity: KST order time, USD amounts, Korean-date range, every channel',async()=>{
  // Shape and values of the 2026-10-25 read-only TTTS3035R response (account fields omitted).
  const googl={ord_dt:'20261023',ord_gno_brno:'01790',odno:'0030955423',sll_buy_dvsn_cd:'02',rvse_cncl_dvsn:'00',pdno:'GOOGL',prdt_name:'알파벳 A',ft_ord_qty:'1',ft_ord_unpr3:'323.74000000',ft_ccld_qty:'1',ft_ccld_unpr3:'323.64000000',ft_ccld_amt3:'323.64000',nccs_qty:'0',ord_tmd:'000734',ovrs_excg_cd:'NASD',dmst_ord_dt:'20261024',thco_ord_tmd:'000734',mdia_dvsn_name:'OpenAPI'};
  const old={...googl,odno:'0030000001',dmst_ord_dt:'20261001',ord_dt:'20260930'};const canceled={...googl,odno:'0030966999',pdno:'NVDA',rvse_cncl_dvsn:'02',ft_ccld_qty:'0',ft_ccld_amt3:'0',ft_ccld_unpr3:'0',nccs_qty:'0',mdia_dvsn_name:'MTS'};
  let params;const client=new OverseasClient({overseasIdentity:()=>({environment:'live'}),overseasRequest:async(path,tr,p)=>{params={tr,...p};return {body:{output:[googl,old,canceled]},continuation:'D'};}});
  const rows=await client.orderHistory('2026-10-02','2026-10-25');assert.equal(params.tr,'TTTS3035R');assert.equal(params.ORD_STRT_DT,'20261001','a day early: U.S. dates trail Korean ones');
  assert.equal(rows.length,2,'the Oct 1 (KST) order is outside the range');const g=rows.find(r=>r.symbol==='NASD:GOOGL');
  assert.equal(new Date(g.timestamp).toISOString(),'2026-10-23T15:07:34.000Z','00:07:34 KST on Oct 24');assert.equal(g.executionAmount,323.64);assert.equal(g.averagePrice,323.64);assert.equal(g.currency,'USD');assert.equal(g.status,'Filled');assert.equal(g.channel,'OpenAPI');
  const c=rows.find(r=>r.symbol==='NASD:NVDA');assert.equal(c.status,'Canceled');assert.equal(c.executionAmount,0);assert.equal(c.channel,'MTS');
  await assert.rejects(client.orderHistory('2026-10-25','2026-10-02'),/INVALID_DATE_RANGE/);
});
// 2026-10-27: after the Oct 23 U.S. buys settled the account held no USD, KIS returned no cash row, the rate was lost and
// Home valued the account without its U.S. holdings (₩791,131 instead of about ₩1.5m).
test('the USD/KRW rate falls back to the holdings base rate when KIS returns no USD cash row',async()=>{
  const rate=async present=>(await fixture(present).client.balance()).fx;
  assert.deepEqual(await rate({output1:[{pdno:'GOOGL',bass_exrt:'1322.60000000'}],output2:[]}).then(f=>[f.usdKRW,f.source]),[1322.6,'KIS base rate (holdings)']);
  assert.deepEqual(await rate({output1:[{pdno:'GOOGL',bass_exrt:'1322.6'}],output2:[{crcy_cd:'USD',frcr_dncl_amt_2:'0',frst_bltn_exrt:'1331.3'}]}).then(f=>[f.usdKRW,f.source]),[1331.3,'KIS first published rate'],'the cash row rate when present');
  assert.equal(await rate({output1:[],output2:[]}),null,'unknown without either');
});
test('a review’s order is priced from the order book, not the quote; with no book for a minute nothing is placed and a review is asked for',async()=>{
  const run=async book=>{const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],()=>[]);const proposed=[];
    const make=(market,open,symbol,price)=>({market,enabled:true,getState:()=>({loss:null}),context:async()=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity:1000,cash:500,positions:{},universe:[{symbol,price}],quotes:[{symbol,price,stale:!open}],orders:[],risk:{baseline:1000,lossLimit:{mode:'off',value:0}},marketSession:{open,status:open?'open':'closed'}}),propose:command=>{proposed.push({market,...command});return {id:'P1',status:'Ready'};},autoSubmit:async()=>({id:'O1'}),autoEnabled:true,identity:()=>'acct'+market});
    const automation=new Automation(db,paper,{request:async()=>({provider:'openai',decision:{action:'Buy',symbol:'NASD:AAPL',quantity:1,explanation:'Joint review.'}})},()=>{});automation.live=make('KR',false,'005930',70000);automation.usLive=make('US',true,'NASD:AAPL',200.001);automation.refreshUS=async()=>{};automation.fx=()=>({usdKRW:1400,source:'fixture'});automation.providerStatus.aiConnected=true;
    automation.orderBook=book;automation.configure({scope:'both',provider:'openai',shareKisWithAI:true,autoSubmit:true});const review=await automation.review();db.close();return {proposed,review,automation};};
  const priced=await run(async()=>({status:'available',retrievedAt:Date.now(),data:{bid:199.4,ask:199.5}}));assert.equal(priced.proposed[0].limitPrice,199.5,'the best ask, not the $200.001 quote');
  const none=await run(async()=>({status:'unavailable',reason:'NO_TWO_SIDED_BOOK'}));assert.deepEqual(none.proposed,[],'nothing placed');assert.match(none.review.executionNote,/No usable order book/);assert.equal(none.automation.reviewRequested.trigger,'Order not placed');
});
test('a decision for a closed market places nothing: it is kept as a pending decision, without looking for a book',async()=>{
  // Otherwise each closed-market Sell would wait a minute for a book, ask for a review, decide Sell again, and repeat.
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],()=>[]);const proposed=[];let reads=0;
  const make=(market,open,symbol,price)=>({market,enabled:true,getState:()=>({loss:null}),context:async()=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity:1000,cash:500,positions:{'NASD:AAPL':{quantity:1}},universe:[{symbol,price}],quotes:[{symbol,price,stale:!open}],orders:[],risk:{baseline:1000,lossLimit:{mode:'off',value:0}},marketSession:{open,status:open?'open':'closed'}}),propose:command=>{proposed.push(command);return {id:'P1',status:'Ready'};},autoSubmit:async()=>({id:'O1'}),autoEnabled:true,identity:()=>'acct'+market});
  const automation=new Automation(db,paper,{request:async()=>({provider:'openai',decision:{action:'Sell',symbol:'NASD:AAPL',quantity:1,explanation:'Exit.'}})},()=>{});automation.live=make('KR',true,'005930',70000);automation.usLive=make('US',false,'NASD:AAPL',200);automation.refreshUS=async()=>{};automation.fx=()=>({usdKRW:1400,source:'fixture'});automation.providerStatus.aiConnected=true;
  automation.orderBook=async()=>{reads++;return {status:'unavailable'};};automation.configure({scope:'both',provider:'openai',shareKisWithAI:true,autoSubmit:true,skipUnchanged:false});
  const first=await automation.review();assert.deepEqual(proposed,[]);assert.equal(reads,0,'no book read for a closed market');assert.match(first.executionNote,/market is closed/);assert.equal(automation.reviewRequested,undefined);
  assert.equal(automation.pending.active(automation.watchScope())[0].symbol,'NASD:AAPL');const again=await automation.review();assert.match(again.executionNote,/pending since/);assert.equal(automation.pending.active(automation.watchScope())[0].reviews,2);db.close();
});
test('unsettled U.S. sale proceeds count in the total until they settle, never as spendable cash and never twice',async()=>{
  // 2026-10-30 live: after the GOOGL sale KIS reported frcr_sll_amt_smtl 279.01 with a deposit of 0, and its own total
  // asset figure included it; the app's total dropped by that amount until settlement.
  const read=async row=>(await fixture({output2:[{crcy_cd:'USD',frcr_dncl_amt_2:'1000',...row}]}).client.balance());
  const none=await read({});assert.equal(none.reportedTotal,3000,'no field: as before');assert.equal(none.pendingSaleProceeds,undefined);
  const sold=await read({frcr_sll_amt_smtl:'279.010000'});assert.equal(sold.reportedTotal,3279.01);assert.equal(sold.pendingSaleProceeds,279.01);assert.equal(sold.cash,1000,'cash stays what can be spent');
  const settled=await read({frcr_dncl_amt_2:'1279.01',frcr_sll_amt_smtl:'0.000000'});assert.equal(settled.reportedTotal,3279.01,'settled: in the deposit, counted once');assert.equal(settled.pendingSaleProceeds,undefined);
  assert.equal((await read({frcr_sll_amt_smtl:''})).reportedTotal,3000,'blank: none');
  assert.equal((await read({frcr_sll_amt_smtl:'279.01',frcr_buy_amt_smtl:'150.000000'})).reportedTotal,3279.01,'an unsettled buy alongside does not change how the sale counts');
  await assert.rejects(read({frcr_sll_amt_smtl:'abc'}),/INVALID_RESPONSE|BALANCE/,'a value that is not a number is refused, not guessed');
});
test('the review sees pending sale proceeds as part of U.S. equity, not as cash',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const balance={accountKey:'acct:US',environment:'mock',reportedTotal:558.48,cash:0,pendingSaleProceeds:279.01,holdings:[{symbol:'NASD:NVDA',name:'NVDA',quantity:1,cost:212.73,price:213.66,marketValue:213.66}]};
  const e=new LiveEngine(db,{request:async op=>op==='live-context'?{balance,quotes:[],marketSession:{open:true,status:'open'}}:{}},()=>({status:'connected',snapshot:balance}),{market:'US'});
  const ctx=await e.context();assert.equal(ctx.equity,558.48);assert.equal(ctx.cash,0,'not spendable yet');assert.equal(ctx.pendingSaleProceeds,279.01);
  const {pendingSaleProceeds,...none}=balance;const n=new LiveEngine(db,{request:async op=>op==='live-context'?{balance:{...none,reportedTotal:279.47},quotes:[],marketSession:{open:true}}:{}},()=>({status:'connected',snapshot:none}),{market:'US'});assert.equal((await n.context()).pendingSaleProceeds,undefined);
});
test('the combined total (Home, history) counts unsettled U.S. sale proceeds; cash does not',()=>{
  // 2026-10-30: 1.5.44 counted the receivable in the U.S. account total, but the combined view summed cash and holdings
  // itself and still showed KRW 1,084,344 instead of about 1,457,185.
  const {combinePortfolio}=require('../electron/portfolio-view.cjs');const kr={cash:414148,settledCash:414148,holdings:[{symbol:'028050',quantity:3,price:98800,cost:60300}]};
  const holdings=[{symbol:'NASD:NVDA',quantity:1,price:213.66,cost:212.73},{symbol:'NYSE:PNR',quantity:1,price:65.84,cost:61.56}];
  const pending=combinePortfolio(kr,{cash:0,pendingSaleProceeds:279.01,holdings},{usdKRW:1336.3});
  assert.equal(Math.round(pending.totals.USD*100)/100,558.51);assert.equal(pending.cash.USD,0,'not cash');assert.deepEqual(pending.pendingSettlement,{USD:279.01});
  assert.equal(Math.round(pending.totals.equityKRW),Math.round(414148+296400+558.51*1336.3));
  const settled=combinePortfolio(kr,{cash:279.01,holdings},{usdKRW:1336.3});assert.equal(Math.round(settled.totals.USD*100)/100,558.51,'settled: the same total, now as cash');assert.equal(settled.pendingSettlement,undefined);
});
