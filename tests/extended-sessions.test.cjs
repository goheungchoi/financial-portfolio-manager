const test=require('node:test');const assert=require('node:assert/strict');
const {tradableNow}=require('../electron/market-sessions.cjs');const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {OverseasClient}=require('../electron/kis-overseas.cjs');
const kst=s=>Date.parse(s+'+09:00');const on={krNxt:true,krxSingle:true,usPre:true,usAfter:true,usDaytime:true};
test('a session is tradable only when switched on, on a live account, and until 5 minutes before it ends',()=>{
  assert.equal(tradableNow('KR',kst('2026-10-20T19:00'),{environment:'live',enabled:on}).id,'nxt-after');
  assert.equal(tradableNow('KR',kst('2026-10-20T19:56'),{environment:'live',enabled:on}),null,'within 5 minutes of 20:00');
  assert.equal(tradableNow('KR',kst('2026-10-20T19:00'),{environment:'live',enabled:{krxSingle:true}}),null,'NXT off');
  assert.equal(tradableNow('KR',kst('2026-10-20T19:00'),{environment:'mock',enabled:on}),null,'mock accounts');
  assert.equal(tradableNow('KR',kst('2026-10-20T16:30'),{environment:'live',enabled:on}).id,'nxt-after','continuous NXT preferred over the auction');
  assert.equal(tradableNow('KR',kst('2026-10-20T16:30'),{environment:'live',enabled:{krxSingle:true}}).route.ordDvsn,'07');
  const pre=tradableNow('US',kst('2026-10-20T19:00'),{environment:'live',enabled:on});assert.equal(pre.id,'us-pre');assert.equal(pre.approval,true);
  assert.equal(tradableNow('US',kst('2026-10-20T12:00'),{environment:'live',enabled:on}).route.endpoint,'daytime');
  assert.equal(tradableNow('KR',kst('2026-10-20T10:00'),{environment:'mock'}).id,'krx-regular','the regular session needs no switch');
});
const reply=body=>new Response(JSON.stringify(body));
test('Korean extended orders go to NXT with NXT prices, or use order type 07 for the KRX auction',async()=>{
  const calls=[];const client=new KisReadOnlyClient({environment:'live',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'},async(url,options)=>{calls.push({url,options});
    if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}});
    if(url.includes('inquire-psbl-order'))return reply({rt_cd:'0',output:{nrcvb_buy_amt:'100000',nrcvb_buy_qty:'100'}});if(url.includes('order-cash'))return reply({rt_cd:'0',output:{ODNO:'42'}});throw new Error('Unexpected '+url);},async()=>{});
  client.checkSession=async()=>({open:true});client.getBalance=async()=>({accountKey:'a',reportedTotal:1e6,holdings:[]});client.getActivity=async()=>({orders:[]});
  const nxt=tradableNow('KR',kst('2026-10-20T19:00'),{environment:'live',enabled:on});const command={symbol:'005930',side:'Buy',quantity:1,limitPrice:100};
  await client.prepareOrder(command,nxt);assert.match(calls.find(c=>c.url.includes('inquire-price')).url,/FID_COND_MRKT_DIV_CODE=NX/);
  const last=()=>JSON.parse(calls.filter(c=>c.url.includes('order-cash')).at(-1).options.body);
  await client.placeOrder(command,nxt);assert.equal(last().EXCG_ID_DVSN_CD,'NXT');assert.equal(last().ORD_DVSN,'00');
  await client.placeOrder(command,tradableNow('KR',kst('2026-10-20T16:30'),{environment:'live',enabled:{krxSingle:true}}));assert.equal(last().EXCG_ID_DVSN_CD,'KRX');assert.equal(last().ORD_DVSN,'07');
  await client.placeOrder(command);assert.equal(last().EXCG_ID_DVSN_CD,'KRX');assert.equal(last().ORD_DVSN,'00','regular orders unchanged');
  await assert.rejects(client.prepareOrder({...command,credit:{kind:'margin-buy',type:'21'}},nxt),/FEATURE_UNAVAILABLE/,'credit orders are regular-session only');
});
test('U.S. daytime orders use the daytime endpoint and daytime prices on live accounts, and are refused on mock',async()=>{
  const make=environment=>{const calls=[];const raw=new KisReadOnlyClient({environment,appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'},async(url,options)=>{calls.push({url,options});
    if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});if(url.includes('/price?'))return reply({rt_cd:'0',output:{last:'200'}});if(url.includes('daytime-order'))return reply({rt_cd:'0',output:{ODNO:'77'}});throw new Error('Unexpected '+url);},async()=>{});
    return {client:new OverseasClient(raw,()=>new Date('2026-10-20T03:00:00Z')),calls};};
  const day=tradableNow('US',kst('2026-10-20T12:00'),{environment:'live',enabled:on});const order={symbol:'NASD:NVDA',side:'Buy',quantity:1,limitPrice:200};
  const live=make('live');const r=await live.client.place(order,day);assert.equal(r.brokerOrderId,'77');const post=live.calls.find(c=>c.url.includes('daytime-order'));assert.equal(post.options.headers.tr_id,'TTTS6036U');assert.equal(JSON.parse(post.options.body).ORD_DVSN,'00');
  await live.client.quote('NASD:NVDA','daytime');assert.match(live.calls.filter(c=>c.url.includes('/price?')).at(-1).url,/EXCD=BAQ/);
  await assert.rejects(make('mock').client.place(order,day),/FEATURE_UNAVAILABLE/);
});
test('the engine holds U.S. pre/after-market orders for approval and caps extended-session size; nothing reaches KIS',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');let places=0;let session={id:'us-pre',regular:false,approval:true};
  const snapshot={accountKey:'acct:US',environment:'live',reportedTotal:100000,cash:100000,holdings:[]};
  const broker={request:async op=>{if(op==='prepare-order')return {balance:snapshot,price:100,ticket:'t',session};if(op==='place-order'){places++;return {brokerOrderId:'1'};}if(op==='live-context')return {balance:snapshot,quotes:[{symbol:'NASD:AAA',price:100}],marketSession:{open:true}};throw new Error(op);}};
  const e=new LiveEngine(db,broker,()=>({status:'connected',snapshot}),{market:'US'});e.extendedMaxOrderPct=()=>5;
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE LIVE');e.enableAuto('ENABLE AUTO LIVE');
  const p=e.propose({symbol:'NASD:AAA',side:'Buy',quantity:10,limitPrice:100});const auto=await e.autoSubmit(p.id);assert.equal(auto.reason,'APPROVAL_REQUIRED');assert.equal(places,0);
  assert.equal(e.orders().find(o=>o.id===p.id).status,'Ready','still waiting for approval');
  session={id:'us-daytime',regular:false};const big=e.propose({symbol:'NASD:AAA',side:'Buy',quantity:60,limitPrice:100});await assert.rejects(e.submit(big.id,'PLACE LIVE ORDER'),/EXTENDED_SIZE_LIMIT/,'6% of equity over a 5% cap');assert.equal(places,0);
});
test('with integrated margin, the extended-session cap counts the KRW that funds U.S. buys',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');let places=0;
  const snapshot={accountKey:'acct:US',environment:'live',reportedTotal:0,cash:0,holdings:[]};
  const broker={request:async op=>{if(op==='prepare-order')return {balance:snapshot,price:10,ticket:'t',session:{id:'us-daytime',regular:false}};if(op==='place-order'){places++;return {brokerOrderId:'1'};}throw new Error(op);}};
  const e=new LiveEngine(db,broker,()=>({status:'connected',snapshot:{...snapshot,reportedTotal:1}}),{market:'US'});e.extendedMaxOrderPct=()=>10;e.buyingPower=()=>({usd:350,fromKRWUSD:350,integratedMargin:true});
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
  const ok=e.propose({symbol:'NASD:AAA',side:'Buy',quantity:3,limitPrice:10});const r=await e.submit(ok.id,'PLACE LIVE ORDER');assert.equal(r.status,'Accepted','$30 within 10% of $350');assert.equal(places,1);
});
test('with integrated margin, the concentration cap and the leveraged-product check use the KRW-funded account value',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const {DatabaseSync}=require('node:sqlite');
  const snapshot={accountKey:'acct:US',environment:'live',reportedTotal:0,cash:0,holdings:[]};
  // A fresh engine per order: an accepted order needs reconciliation before the next one.
  const engine=()=>{const out={places:0,seen:[]};const broker={request:async op=>{if(op==='prepare-order')return {balance:snapshot,price:10,ticket:'t',session:{id:'us-regular',regular:true}};if(op==='place-order'){out.places++;return {brokerOrderId:'1'};}throw new Error(op);}};
    const e=new LiveEngine(new DatabaseSync(':memory:'),broker,()=>({status:'connected',snapshot:{...snapshot,reportedTotal:1}}),{market:'US'});e.buyingPower=()=>({usd:350,fromKRWUSD:350,integratedMargin:true});
    e.exposure={check:args=>{out.seen.push(args.equity);return {product:{kind:'standard'},requiresApproval:false};}};
    e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:20,lossLimit:{mode:'off',value:0}},'ENABLE LIVE');out.e=e;return out;};
  const a=engine();const ok=a.e.propose({symbol:'NASD:AAA',side:'Buy',quantity:6,limitPrice:10});assert.equal((await a.e.submit(ok.id,'PLACE LIVE ORDER')).status,'Accepted','$60 is 17% of $350, within 20%');assert.equal(a.places,1);
  assert.deepEqual(a.seen,[351,350],'the leveraged-product check sees the account value plus $350 when proposing ($1 here) and submitting ($0), not an empty account it would skip');
  const b=engine();const big=b.e.propose({symbol:'NASD:AAA',side:'Buy',quantity:8,limitPrice:10});await assert.rejects(b.e.submit(big.id,'PLACE LIVE ORDER'),/CONCENTRATION_LIMIT/,'$80 is 23% of $350');assert.equal(b.places,0);
});
test('a U.S. account holding nothing counts as funded when integrated margin lends it KRW',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const {DatabaseSync}=require('node:sqlite');const snapshot={accountKey:'acct:US',environment:'live',reportedTotal:0,cash:0,holdings:[]};
  const make=()=>new LiveEngine(new DatabaseSync(':memory:'),{request:async()=>{}},()=>({status:'connected',snapshot}),{market:'US'});const limits={symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'percent',value:2}};
  assert.throws(()=>make().configure(limits,'ENABLE LIVE'),/NO_FUNDED_BALANCE/,'no integrated margin');
  const e=make();e.buyingPower=()=>({usd:350,fromKRWUSD:350,integratedMargin:true});assert.equal(e.funded(snapshot),true);
  const state=e.configure(limits,'ENABLE LIVE');assert.equal(state.policy.maxDailyLossKRW,7,'2% of the $350 funded through KRW, not $1');
});
test('a filled Korean order is reconciled from the live order history and stops blocking new orders',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const {DatabaseSync}=require('node:sqlite');const {normalizeOrders}=require('../electron/kis-activity.cjs');
  const snapshot={accountKey:'acct:KR',environment:'live',reportedTotal:1500001,cash:1500001,holdings:[]};let places=0;
  // The order history row KIS returned on 2026-10-23, with its blank cancel flag.
  const row={ord_dt:'20261023',ord_tmd:'100347',odno:'0007143000',orgn_odno:'',pdno:'028050',prdt_name:'삼성E&A',sll_buy_dvsn_cd:'02',cncl_yn:'',ord_qty:'3',tot_ccld_qty:'3',rmn_qty:'0',rjct_qty:'0',tot_ccld_amt:'180900',avg_prvs:'60300',ord_unpr:'60300',ord_gno_brno:'91253',excg_id_dvsn_cd:'KRX'};
  const broker={request:async(op,args)=>{if(op==='prepare-order')return {balance:snapshot,price:60300,ticket:'t',session:{id:'krx-regular',regular:true}};if(op==='place-order'){places++;return {brokerOrderId:places===1?'0007143000':'0007150000'};}
    if(op==='orders')return {orders:normalizeOrders([row],args.startDate.replaceAll('-',''),args.endDate.replaceAll('-',''))};throw new Error(op);}};
  const e=new LiveEngine(new DatabaseSync(':memory:'),broker,()=>({status:'connected',snapshot}),{market:'KR'});e.day=()=>'2026-10-23';
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
  const buy=e.propose({symbol:'028050',side:'Buy',quantity:3,limitPrice:60300});await e.submit(buy.id,'PLACE LIVE ORDER');
  const stop=e.propose({symbol:'028050',side:'Sell',quantity:3,limitPrice:54000});await assert.rejects(e.submit(stop.id,'PLACE LIVE ORDER'),/RECONCILIATION_REQUIRED/,'blocked until the fill is recorded');
  await e.reconcile();const done=e.orders().find(o=>o.id===buy.id);assert.deepEqual([done.status,done.filled,done.fillPrice],['Filled',3,60300]);
  const again=e.propose({symbol:'028050',side:'Sell',quantity:3,limitPrice:54000});assert.equal((await e.submit(again.id,'PLACE LIVE ORDER')).status,'Accepted','the stop-loss can be placed once the fill is recorded');
});
test('failed order checks are shown to reviews as unconfirmed, raise one alert, and clear on success',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const {DatabaseSync}=require('node:sqlite');const {combinedContext}=require('../electron/combined-context.cjs');
  const snapshot={accountKey:'acct:KR',environment:'live',reportedTotal:1500001,cash:1500001,holdings:[]};let history='broken';
  const broker={request:async op=>{if(op==='prepare-order')return {balance:snapshot,price:60300,ticket:'t',session:{id:'krx-regular',regular:true}};if(op==='place-order')return {brokerOrderId:'0007143000'};
    if(op==='orders'){if(history==='broken')throw new Error('INVALID_RESPONSE');return {orders:[{orderId:'0007143000',filled:3,status:'Filled',averagePrice:60300}]};}
    if(op==='live-context')return {balance:{...snapshot,holdings:[{symbol:'028050',quantity:3,cost:60300}]},quotes:[{symbol:'028050',price:60500}],marketSession:{open:true}};throw new Error(op);}};
  const e=new LiveEngine(new DatabaseSync(':memory:'),broker,()=>({status:'connected',snapshot}),{market:'KR'});
  e.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
  assert.equal(e.orderReconciliation(),null,'nothing open, nothing to confirm');
  const buy=e.propose({symbol:'028050',side:'Buy',quantity:3,limitPrice:60300});await e.submit(buy.id,'PLACE LIVE ORDER');
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const logs=[],alerts=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F',price:50000}],async()=>50000),{request:async()=>({})},(id,role,title,body)=>logs.push(title));a.notify=(id,m)=>alerts.push(id);
  for(let i=0;i<4;i++){await assert.rejects(e.reconcile(),/INVALID_RESPONSE/);a.observeReconcile('KR',e.reconcileHealth);}
  assert.equal(alerts.length,1,'one alert per episode, not one per check');assert.equal(logs.filter(t=>t==='Order status not confirmed').length,1);
  const ctx=await e.context();assert.equal(ctx.orderReconciliation.status,'unconfirmed');assert.equal(ctx.orderReconciliation.failedChecks,4);assert.match(ctx.orderReconciliation.note,/may already be filled/);
  assert.deepEqual(Object.keys(ctx.orders[0]),['symbol','side','quantity','filled','status','orderId','placedAt','lastConfirmedAt']);assert.equal(ctx.orders[0].orderId,'0007143000');
  const us={market:'US',currency:'USD',equity:0,cash:0,universe:[],positions:{},quotes:[],orders:[],risk:{},marketSession:{open:false}};
  assert.deepEqual(combinedContext({...ctx,market:'KR'},us,null).orderReconciliation.map(r=>[r.market,r.status]),[['KR','unconfirmed']]);
  history='fixed';await e.reconcile();a.observeReconcile('KR',e.reconcileHealth);assert.equal(e.reconcileHealth.failures,0);assert.equal(e.orders()[0].status,'Filled');assert.equal(e.orderReconciliation(),null,'filled: nothing open');
  history='broken';const again=e.propose({symbol:'028050',side:'Sell',quantity:3,limitPrice:54000});await e.submit(again.id,'PLACE LIVE ORDER');
  for(let i=0;i<3;i++){await assert.rejects(e.reconcile());a.observeReconcile('KR',e.reconcileHealth);}assert.equal(alerts.length,2,'a new episode alerts again');
});
