const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
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
    const automation=new Automation(db,paper,{request:async(_op,{context})=>{supplied=context;return {provider:'openai',decision:{action:'Buy',symbol,quantity:1,explanation:'Joint review.'}};}},()=>{});automation.live=make('KR',krOpen,'005930',70000);automation.usLive=make('US',usOpen,'NASD:AAPL',200.001);automation.refreshUS=async()=>{};automation.fx=()=>({usdKRW:1400,source:'fixture'});automation.providerStatus.aiConnected=true;automation.configure({scope:'both',provider:'openai',shareKisWithAI:true,autoSubmit:true});await automation.review();assert.equal(supplied.currency,'MULTI');assert.equal(supplied.cash.USD,500);assert.equal(supplied.cash.KRW,500);assert.equal(supplied.equity,1401000);assert.equal(supplied.markets.length,2);assert.deepEqual(submitted,expected?[expected]:[]);assert.equal(proposed[0].market,symbol==='005930'?'KR':'US');if(symbol!=='005930')assert.equal(proposed[0].limitPrice,200.01);db.close();
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
  const sale=estimateCosts({...args,settings});assert.equal(sale.taxableGainKRW,792944);assert.equal(sale.capitalGainsTaxKRW,152448);assert.equal(sale.gainAfterEstimatedTax,382.32);
  const sheltered=estimateCosts({...args,settings:{...settings,annualRealizedKRW:0}});assert.equal(sheltered.capitalGainsTaxKRW,0);
  assert.equal(estimateCosts({...args,price:100,settings:{...settings,annualRealizedKRW:3000000}}).capitalGainsTaxKRW,-110000);
  assert.equal(estimateCosts({...args,settings:{...settings,taxYear:2020}}).capitalGainsTaxKRW,null);
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
test('annual baseline adds cumulative app fills once and re-saving anchors already-realized gains',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');const costs=new TradingCosts(db);const settings={...DEFAULT_COSTS,annualRealizedKRW:2000000};costs.save(settings);
  const order={id:'sale',market:'US',side:'Sell',day:String(settings.taxYear)+'-10-15',resultCosts:{taxableGainKRW:100000}};
  const save=()=>db.prepare('INSERT INTO live_intents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(order.id,'fake',JSON.stringify(order));save();assert.equal(costs.get().annualRealizedKRW,2100000);assert.equal(costs.get().annualRealizedKRW,2100000);
  order.resultCosts.taxableGainKRW=200000;save();assert.equal(costs.get().annualRealizedKRW,2200000);costs.save(costs.get());assert.equal(costs.get().annualRealizedKRW,2200000);
  order.resultCosts.taxableGainKRW=250000;save();assert.equal(costs.get().annualRealizedKRW,2250000);db.close();
});
function fixture(){const calls=[];const raw=new KisReadOnlyClient({environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'},async(url,options)=>{calls.push({url,options});const params=new URL(url).searchParams;let body={rt_cd:'0'};
  if(url.endsWith('/oauth2/tokenP'))body={access_token:'fixture-token',expires_in:3600};
  else if(url.includes('inquire-balance'))body.output1=params.get('OVRS_EXCG_CD')==='NASD'?[{ovrs_pdno:'AAPL',ovrs_excg_cd:'NASD',tr_crcy_cd:'USD',ovrs_cblc_qty:'10',ord_psbl_qty:'10',pchs_avg_pric:'150',now_pric2:'200',ovrs_stck_evlu_amt:'2000'}]:[];
  else if(url.includes('inquire-present-balance'))body.output2=[{crcy_cd:'USD',frcr_dncl_amt_2:'1000',account:'private'}];
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
  assert.equal((await client.place(buy)).brokerOrderId,'42');await client.place({...buy,side:'Sell'});const posts=calls.filter(row=>row.options.method==='POST'&&row.url.endsWith('/order'));assert.equal(posts.length,2);assert.equal(posts[0].options.headers.tr_id,'VTTT1002U');assert.equal(posts[1].options.headers.tr_id,'VTTT1006U');assert.equal(JSON.parse(posts[0].options.body).OVRS_ORD_UNPR,'200.01');assert.equal(JSON.parse(posts[0].options.body).OVRS_EXCG_CD,'NASD');assert.ok(calls.every(row=>!row.url.includes('domestic-stock')));
});
test('U.S. intents stay separate from domestic account, preserve approval and price cents, recompute partial sale costs',async()=>{
  const db=new DatabaseSync(':memory:');const balance={accountKey:'fixture:US',environment:'mock',reportedTotal:3000,cash:1000,holdings:[{symbol:'NASD:AAPL',quantity:10,cost:150,price:200}]};let posts=0;
  const broker={request:async(operation)=>{if(operation==='prepare-order')return {balance,ticket:'ticket'};if(operation==='place-order'){posts++;return {brokerOrderId:'42'};}if(operation==='orders')return {orders:[{orderId:'42',filled:1,fillPrice:201.12,status:'Partially filled'}]};throw new Error(operation);}};
  const engine=new LiveEngine(db,broker,()=>({snapshot:balance}),{market:'US'});engine.costs=new TradingCosts(db);
  engine.configure({symbols:['NASD:AAPL']},'ENABLE MOCK');const order=engine.propose({symbol:'NASD:AAPL',side:'Sell',quantity:2,limitPrice:200.01});assert.equal(order.currency,'USD');assert.equal(order.costEstimate.gross,400.02);
  await assert.rejects(engine.submit(order.id,''),/APPROVAL_REQUIRED/);await engine.submit(order.id,'PLACE MOCK ORDER');await engine.submit(order.id,'PLACE MOCK ORDER');assert.equal(posts,1);await engine.reconcile();const filled=engine.orders()[0];assert.equal(filled.filled,1);assert.equal(filled.resultCosts.gross,201.12);assert.equal(filled.resultCosts.commission,.5);
  const domestic=new LiveEngine(db,broker,()=>({snapshot:{...balance,accountKey:'fixture'}}));assert.equal(domestic.orders().length,0);assert.equal(domestic.getState().enabled,false);assert.throws(()=>domestic.configure({symbols:['NASD:AAPL']},'ENABLE MOCK'),/INVALID_LIMITS/);db.close();
});
