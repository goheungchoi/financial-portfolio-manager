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
