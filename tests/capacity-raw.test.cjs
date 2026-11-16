// M-1.5b (Q1/Q2): KIS's orderable answer at each preparation is kept, numeric fields only, with the orders open then;
// no request is added and recording never stops an order.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {BrokerCapacity,LIMITS}=require('../electron/broker-raw.cjs');const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {OverseasClient}=require('../electron/kis-overseas.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const reply=body=>new Response(JSON.stringify(body),{headers:{tr_cont:''}});

test('the store keeps numeric fields only, the order and the open orders, and the balances\' retention',()=>{
  let now=Date.parse('2026-11-09T10:00:00Z');const c=new BrokerCapacity(new DatabaseSync(':memory:'),()=>now);
  assert.equal(c.record({account:'',market:'KR',capacity:{}}),false);assert.equal(c.record({account:'a',market:'JP',capacity:{}}),false);assert.equal(c.record({account:'a',market:'KR'}),false);
  assert.equal(c.record({account:'a',market:'KR',order:{symbol:'005930',side:'Buy',quantity:2,limitPrice:100},capacity:{tr:'TTTC8908R',at:5,fields:{nrcvb_buy_amt:'1000',ord_psbl_cash:'900',prdt_name:'text',account:'12345678-01x'}},
    open:{app:[{id:'o1',symbol:'000660',side:'Buy',quantity:3,filled:1,status:'Accepted',price:100,brokerOrderId:'42'}],kis:[{orderId:'900',symbol:'035420',side:'Sell',quantity:5,remaining:2,price:7}]}}),true);
  const [r]=c.list('a','KR');assert.deepEqual(r.capacity,{tr:'TTTC8908R',at:5,fields:{nrcvb_buy_amt:1000,ord_psbl_cash:900}},'text fields left out');
  assert.deepEqual(r.order,{symbol:'005930',side:'Buy',quantity:2,limitPrice:100});assert.equal(r.open.app[0].brokerOrderId,'42');assert.equal(r.open.kis[0].remaining,2);
  now+=(LIMITS.days+1)*86400000;c.record({account:'a',market:'KR',capacity:{tr:'balance',fields:{ord_psbl_qty:3}}});assert.equal(c.list('a','KR').length,1,'older than 30 days: deleted');
});
function korea(){const c=new KisReadOnlyClient(credentials,async url=>{if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}});
  if(url.includes('inquire-psbl-order'))return reply({rt_cd:'0',output:{nrcvb_buy_amt:'100000',nrcvb_buy_qty:'100',ord_psbl_cash:'120000',max_buy_amt:'130000',psbl_qty_calc_unpr:'100'}});throw new Error('Unexpected '+url);},async()=>{});
  c.checkSession=async()=>({open:true});c.getBalance=async()=>({accountKey:'f',reportedTotal:10000,holdings:[{symbol:'005930',quantity:7,availableQuantity:5}]});c.getActivity=async()=>({orders:[]});return c;}
test('Korea: a buy returns the psbl-order answer and a sale the holding\'s orderable quantity; no request is added',async()=>{
  const b=await korea().prepareOrder({symbol:'005930',side:'Buy',quantity:2,limitPrice:100});assert.equal(b.capacityRaw.tr,'TTTC8908R');assert.deepEqual(b.capacityRaw.fields,{nrcvb_buy_amt:100000,nrcvb_buy_qty:100,ord_psbl_cash:120000,max_buy_amt:130000,psbl_qty_calc_unpr:100});
  const s=await korea().prepareOrder({symbol:'005930',side:'Sell',quantity:2,limitPrice:100});assert.deepEqual(s.capacityRaw,{tr:'balance',fields:{ord_psbl_qty:5,hldg_qty:7},at:s.capacityRaw.at});
});
test('U.S.: a buy returns the psamount answer',async()=>{
  const raw=new KisReadOnlyClient(credentials,async url=>{const params=new URL(url).searchParams;let body={rt_cd:'0'};
    if(url.endsWith('/oauth2/tokenP'))body={access_token:'t',expires_in:3600};else if(url.includes('inquire-balance'))body.output1=params.get('OVRS_EXCG_CD')==='NASD'?[{ovrs_pdno:'AAPL',ovrs_excg_cd:'NASD',tr_crcy_cd:'USD',ovrs_cblc_qty:'10',ord_psbl_qty:'10',pchs_avg_pric:'150',now_pric2:'200',ovrs_stck_evlu_amt:'2000'}]:[];
    else if(url.includes('inquire-present-balance'))body.output2=[{crcy_cd:'USD',frcr_dncl_amt_2:'1000'}];else if(url.includes('/price?'))body.output={last:'200'};else if(url.includes('inquire-psamount'))body.output={ord_psbl_qty:'5',ord_psbl_frcr_amt:'1000.50',echm_af_ord_psbl_qty:'99999'};
    else if(url.includes('inquire-ccnl'))body.output=[];else throw new Error('Unexpected '+url);return new Response(JSON.stringify(body));},async()=>{});
  const r=await new OverseasClient(raw,()=>new Date('2026-10-15T15:00:00Z')).prepare({symbol:'NASD:AAPL',side:'Buy',quantity:2,limitPrice:200.01});
  assert.equal(r.capacityRaw.tr,'TTTS3007R');assert.deepEqual(r.capacityRaw.fields,{ord_psbl_qty:5,ord_psbl_frcr_amt:1000.5,echm_af_ord_psbl_qty:99999});
});
test('the engine records it with the orders open then; a failing record never stops the order',async()=>{
  const db=new DatabaseSync(':memory:');const conn=()=>({status:'connected',snapshot:{accountKey:'acct',environment:'mock',reportedTotal:1e7,cash:1e7,settledCash:1e7,holdings:[]}});
  const capacityRaw={tr:'TTTC8908R',at:1,fields:{nrcvb_buy_amt:900000}};
  const e=new LiveEngine(db,{request:async op=>op==='prepare-order'?{ticket:'t',balance:{...conn().snapshot,timestamp:new Date().toISOString()},capacityRaw}:{brokerOrderId:'5'}},conn,{severalOpen:true});e.costs={get:()=>({}),context:()=>null};e.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
  const store=new BrokerCapacity(db);e.recordCapacity=x=>store.record(x);
  await e.submit(e.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000}).id,'PLACE MOCK ORDER');await e.submit(e.propose({symbol:'035420',side:'Buy',quantity:2,limitPrice:1000}).id,'PLACE MOCK ORDER');
  const rows=store.list('acct','KR');assert.equal(rows.length,2);assert.deepEqual(rows[0].order,{symbol:'035420',side:'Buy',quantity:2,limitPrice:1000});assert.deepEqual(rows[0].capacity.fields,{nrcvb_buy_amt:900000});
  assert.deepEqual(rows[0].open.app.map(o=>[o.symbol,o.status,o.brokerOrderId]),[['005930','Accepted','5']],'the order open at that moment');assert.deepEqual(rows[1].open.app,[]);
  e.recordCapacity=()=>{throw new Error('disk full');};assert.equal((await e.submit(e.propose({symbol:'000660',side:'Buy',quantity:1,limitPrice:1000}).id,'PLACE MOCK ORDER')).status,'Accepted');
});
test('M-1.5c: the dropped order-history rows are kept in the capacity record (count and codes), and only when there are some',()=>{
  const c=new BrokerCapacity(new DatabaseSync(':memory:'));const base={account:'A:US',market:'US',order:{symbol:'NASD:X',side:'Buy',quantity:1,limitPrice:10},capacity:{tr:'TTTS3007R',fields:{a:1}},open:{app:[],kis:[]}};
  assert.equal(c.record({...base,historyDropped:{count:2,codes:['TSE','XHKG']}}),true);assert.deepEqual(c.list('A:US','US')[0].historyDropped,{count:2,codes:['TSE','XHKG']});
  c.record(base);assert.equal(Object.hasOwn(c.list('A:US','US')[0],'historyDropped'),false);
});
