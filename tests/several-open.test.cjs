// M-1.1 pins (artifacts/reviews/2026-11-16-multi-order, matrix row 1, condition A): with severalOpen off (the default,
// and the only state the app can be in), the one-open-order rule is exactly today's, in all three places that hold it:
// the engine's send (RECONCILIATION_REQUIRED), and the Korean and U.S. broker preparations (OPEN_BROKER_ORDERS, any
// open order at KIS, the user's own included). These tests do not change in later steps.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {OverseasClient}=require('../electron/kis-overseas.cjs');

function world(options){const db=new DatabaseSync(':memory:');const s={accountKey:'acct',environment:'live',reportedTotal:10000000,cash:10000000,settledCash:10000000,holdings:[{symbol:'000660',quantity:10,availableQuantity:10,cost:100000}]};const calls=[];
  const us={accountKey:'acct:US',environment:'live',reportedTotal:0,cash:0,holdings:[],unsettled:{buyKRW:0,sellKRW:0,krwFundedKRW:0}};
  const broker={request:async(op,payload)=>{calls.push([op,payload]);if(op==='prepare-order')return {ticket:'t',balance:{...s,timestamp:new Date().toISOString()}};if(op==='place-order')return {brokerOrderId:String(calls.length)};throw new Error('unexpected '+op);}};
  const kr=new LiveEngine(db,broker,()=>({status:'connected',snapshot:s}),options);kr.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
  const ledger=new FundingLedger(db,{fresh:async m=>m==='US'?{...us,timestamp:new Date().toISOString(),fx:{usdKRW:1300,timestamp:Date.now()},brokerBuyingPower:null}:{...s,timestamp:new Date().toISOString()},fx:()=>({usdKRW:1300,timestamp:Date.now()}),regime:'separate'});ledger.init();kr.funding=ledger;
  kr.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
  const send=async(symbol,side='Buy',quantity=1,price=1000)=>{const o=kr.propose({symbol,side,quantity,limitPrice:price});try{return (await kr.submit(o.id,'PLACE LIVE ORDER')).status;}catch(e){return e.message;}};
  return {db,kr,calls,send,places:()=>calls.filter(c=>c[0]==='place-order').length};}
const OPEN=['Submitting','Uncertain','Accepted','Partially filled','Cancellation uncertain'];

test('pin: the switch is off by default and only a constructor option turns it on',()=>{
  const db=new DatabaseSync(':memory:');const conn=()=>({snapshot:{accountKey:'a'}});
  assert.equal(new LiveEngine(db,{},conn).severalOpen,false);assert.equal(new LiveEngine(db,{},conn,{market:'US'}).severalOpen,false);
  for(const v of ['true',1,{},'on'])assert.equal(new LiveEngine(db,{},conn,{severalOpen:v}).severalOpen,false,`only the boolean true: ${JSON.stringify(v)}`);
  assert.equal(new LiveEngine(db,{},conn,{severalOpen:true}).severalOpen,true);
});
for(const options of [undefined,{severalOpen:false}])test(`pin (${options?'severalOpen:false':'default'}): any open app order refuses every new order, of any stock or side, before anything is prepared`,async()=>{
  for(const status of OPEN){const w=world(options);assert.equal(await w.send('005930'),'Accepted');const first=w.kr.orders()[0];w.kr.writeOrder({...first,status});
    const before=w.calls.length;
    for(const [symbol,side] of [['005930','Buy'],['000660','Buy'],['000660','Sell']])assert.equal(await w.send(symbol,side),'RECONCILIATION_REQUIRED',`${status}: ${side} ${symbol}`);
    assert.equal(w.calls.length,before,`${status}: no preparation or order request`);assert.equal(w.places(),1);}
  // Closed orders do not block.
  for(const status of ['Filled','Canceled','Rejected']){const w=world(options);await w.send('005930');w.kr.writeOrder({...w.kr.orders()[0],status});assert.equal(await w.send('000660'),'Accepted',status);}
});
test('pin: an unclear or submitting order of any account in the database blocks the send (the U.S. account\'s included)',async()=>{
  for(const status of ['Uncertain','Submitting']){const w=world();w.db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run('us1','acct:US',JSON.stringify({id:'us1',accountKey:'acct:US',symbol:'NASD:AAPL',side:'Buy',quantity:1,status}));
    assert.equal(await w.send('005930'),'RECONCILIATION_REQUIRED',status);assert.equal(w.places(),0);}
});
test('pin: an unclear reply turns the market\'s trading off',async()=>{
  const w=world();w.kr.broker.request=async(op)=>{if(op==='prepare-order')return {ticket:'t',balance:{accountKey:'acct',environment:'live',reportedTotal:10000000,cash:10000000,settledCash:10000000,holdings:[],timestamp:new Date().toISOString()}};throw new Error('ORDER_UNCERTAIN');};
  assert.equal(await w.send('005930'),'Uncertain');assert.equal(w.kr.enabled,false);
});
test('pin: the preparation request carries exactly the command (and the sessions when set), nothing about the switch',async()=>{
  const w=world();await w.send('005930');const [,payload]=w.calls.find(c=>c[0]==='prepare-order');assert.deepEqual(Object.keys(payload),['command']);assert.deepEqual(Object.keys(payload.command).sort(),['limitPrice','quantity','side','symbol']);
  const v=world();v.kr.sessionOptions=()=>({krNxt:false});await v.send('005930');assert.deepEqual(Object.keys(v.calls.find(c=>c[0]==='prepare-order')[1]),['sessions','command']);
});

const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const reply=body=>new Response(JSON.stringify(body),{headers:{tr_cont:''}});
function korea(orders){const c=new KisReadOnlyClient(credentials,async url=>{if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}});if(url.includes('inquire-psbl-order'))return reply({rt_cd:'0',output:{nrcvb_buy_amt:'100000',nrcvb_buy_qty:'100'}});throw new Error('Unexpected '+url);},async()=>{});
  c.checkSession=async()=>({open:true});c.getBalance=async()=>({accountKey:'f',reportedTotal:10000,holdings:[{symbol:'005930',availableQuantity:5}]});c.getActivity=async()=>({orders});return c;}
test('pin: the Korean preparation refuses while KIS lists any open order, of any stock and whoever placed it',async()=>{
  const cmd={symbol:'005930',side:'Buy',quantity:2,limitPrice:100};
  for(const o of [{symbol:'000660',remaining:3,status:'Pending'},{symbol:'005930',remaining:1,status:'Partially filled'},{symbol:'035420',remaining:10,status:'Pending'}])await assert.rejects(korea([o]).prepareOrder(cmd),/OPEN_BROKER_ORDERS/,JSON.stringify(o));
  for(const o of [{symbol:'000660',remaining:0,status:'Filled'},{symbol:'000660',remaining:0,status:'Canceled'},{symbol:'000660',remaining:3,status:'Rejected'}])assert.equal((await korea([o]).prepareOrder(cmd)).availableQuantity,100,JSON.stringify(o));
  await assert.rejects(korea([{symbol:'000660',remaining:3,status:'Pending'}]).prepareOrder({...cmd,side:'Sell',quantity:1}),/OPEN_BROKER_ORDERS/,'a sale too');
});
function overseas(rows){const raw=new KisReadOnlyClient(credentials,async url=>{const params=new URL(url).searchParams;let body={rt_cd:'0'};
  if(url.endsWith('/oauth2/tokenP'))body={access_token:'t',expires_in:3600};else if(url.includes('inquire-balance'))body.output1=params.get('OVRS_EXCG_CD')==='NASD'?[{ovrs_pdno:'AAPL',ovrs_excg_cd:'NASD',tr_crcy_cd:'USD',ovrs_cblc_qty:'10',ord_psbl_qty:'10',pchs_avg_pric:'150',now_pric2:'200',ovrs_stck_evlu_amt:'2000'}]:[];
  else if(url.includes('inquire-present-balance'))body.output2=[{crcy_cd:'USD',frcr_dncl_amt_2:'1000'}];else if(url.includes('/price?'))body.output={last:'200'};else if(url.includes('inquire-psamount'))body.output={ord_psbl_qty:'5',ord_psbl_frcr_amt:'1000'};
  else if(url.includes('inquire-ccnl'))body.output=rows;else throw new Error('Unexpected '+url);return new Response(JSON.stringify(body));},async()=>{});
  return new OverseasClient(raw,()=>new Date('2026-10-15T15:00:00Z'));}
const ccnl=(pdno,qty,filled,extra={})=>({odno:'7',orgn_odno:'',ovrs_excg_cd:'NASD',pdno,sll_buy_dvsn_cd:'02',ft_ord_qty:String(qty),ft_ccld_qty:String(filled),nccs_qty:String(qty-filled),ft_ord_unpr3:'100',ft_ccld_unpr3:'100',rvse_cncl_dvsn:'00',rjct_rson:'',...extra});
test('pin: the U.S. preparation refuses while KIS lists any open U.S. order, of any stock',async()=>{
  const buy={symbol:'NASD:AAPL',side:'Buy',quantity:2,limitPrice:200.01};
  await assert.rejects(overseas([ccnl('MSFT',3,0)]).prepare(buy),/OPEN_BROKER_ORDERS/,'another stock, pending');
  await assert.rejects(overseas([ccnl('AAPL',3,1)]).prepare(buy),/OPEN_BROKER_ORDERS/,'partly filled');
  assert.ok(await overseas([ccnl('MSFT',3,3)]).prepare(buy),'a filled order does not');assert.ok(await overseas([]).prepare(buy));
});
