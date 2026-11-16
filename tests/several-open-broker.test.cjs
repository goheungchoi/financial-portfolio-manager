// M-1.3 (artifacts/reviews/2026-11-16-multi-order; G2/G3, the user's D3 "Count them, block same stock"): with severalOpen
// on, the Korean and U.S. preparations refuse only an open KIS order of the same stock and return the other open orders;
// the engine tells the app's (by their order numbers) from yours. The switch-off behaviour is pinned in
// tests/several-open.test.cjs.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {openGuard}=require('../electron/broker-open-orders.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {OverseasClient}=require('../electron/kis-overseas.cjs');
const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const reply=body=>new Response(JSON.stringify(body),{headers:{tr_cont:''}});
function korea(orders){const c=new KisReadOnlyClient(credentials,async url=>{if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}});if(url.includes('inquire-psbl-order'))return reply({rt_cd:'0',output:{nrcvb_buy_amt:'100000',nrcvb_buy_qty:'100'}});throw new Error('Unexpected '+url);},async()=>{});
  c.checkSession=async()=>({open:true});c.getBalance=async()=>({accountKey:'f',reportedTotal:10000,holdings:[{symbol:'005930',availableQuantity:5}]});c.getActivity=async()=>({orders});return c;}
const kr=(orderId,symbol,side,remaining,status='Pending',orderPrice=100)=>({orderId,symbol,side,remaining,status,orderPrice});
const cmd={symbol:'005930',side:'Buy',quantity:2,limitPrice:100};

test('the guard: off refuses any open order and returns nothing; on refuses only the same stock and lists the others; only the boolean true turns it on',()=>{
  const fail=()=>new Error('OPEN_BROKER_ORDERS');const rows=[kr('1','000660','Buy',3),kr('2','035420','Sell',1,'Partially filled'),kr('3','051910','Buy',0,'Filled'),kr('4','005380','Buy',5,'Rejected')];
  assert.throws(()=>openGuard(rows,cmd,{fail}),/OPEN_BROKER_ORDERS/);assert.deepEqual(openGuard([rows[2],rows[3]],cmd,{fail}),{},'off: nothing open, nothing returned');
  for(const v of ['true',1,{}])assert.throws(()=>openGuard(rows,cmd,{severalOpen:v,fail}),/OPEN_BROKER_ORDERS/,JSON.stringify(v));
  assert.deepEqual(openGuard(rows,cmd,{severalOpen:true,fail}).openOrders,[{orderId:'1',symbol:'000660',side:'Buy',quantity:null,remaining:3,price:100},{orderId:'2',symbol:'035420',side:'Sell',quantity:null,remaining:1,price:100}],'open ones only, closed and rejected left out');
  assert.throws(()=>openGuard([...rows,kr('5','005930','Sell',2)],cmd,{severalOpen:true,fail}),/OPEN_BROKER_ORDERS/,'the same stock, the other side');
  assert.deepEqual(openGuard([kr('6','005930','Buy',0,'Filled')],cmd,{severalOpen:true,fail}).openOrders,[],'the same stock, closed: no refusal');
});
test('F1: one U.S. stock under any exchange code is the same stock; Korean codes are compared as they are',()=>{
  const fail=()=>new Error('OPEN_BROKER_ORDERS');const xyz={symbol:'NASD:XYZ',side:'Buy',quantity:1,limitPrice:10};
  for(const listed of ['NYSE:XYZ','AMEX:XYZ','BAQ:XYZ','BAY:XYZ','NASD:XYZ'])assert.throws(()=>openGuard([kr('1',listed,'Sell',1)],xyz,{severalOpen:true,fail}),/OPEN_BROKER_ORDERS/,listed);
  assert.deepEqual(openGuard([kr('1','NYSE:XYZW','Buy',1),kr('2','NASD:XY','Buy',1)],xyz,{severalOpen:true,fail}).openOrders.length,2,'other tickers are other stocks');
  assert.throws(()=>openGuard([kr('1','005930','Buy',1)],cmd,{severalOpen:true,fail}),/OPEN_BROKER_ORDERS/);assert.equal(openGuard([kr('1','005935','Buy',1)],cmd,{severalOpen:true,fail}).openOrders.length,1);
  const {sameStock}=require('../electron/broker-open-orders.cjs');assert.equal(sameStock('005930','X:005930'),false,'a Korean code never matches a U.S. symbol');
});
test('F1: an order of unknown state blocks its U.S. stock under any exchange code (openBlock)',async()=>{
  const db=new DatabaseSync(':memory:');const conn=()=>({status:'connected',snapshot:{accountKey:'acct:US',environment:'mock',reportedTotal:1e5,cash:1e5,holdings:[]}});
  const e=new LiveEngine(db,{request:async()=>{throw new Error('unexpected');}},conn,{market:'US',severalOpen:true});
  for(const symbol of ['NYSE:XYZ','BAQ:XYZ'])db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(symbol,'acct:US',JSON.stringify({id:symbol,accountKey:'acct:US',symbol,side:'Buy',quantity:1,status:'Uncertain'}));
  assert.match(e.openBlock({id:'n',symbol:'NASD:XYZ'}),/has an order whose state is not confirmed \(Uncertain\)/);assert.equal(e.openBlock({id:'n',symbol:'NASD:XYZW'}),null);
});
test('Korea: with the switch on, another stock\'s open order passes and is returned; the same stock\'s refuses; off returns no list',async()=>{
  const r=await korea([kr('0000123','000660','Buy',3)]).prepareOrder(cmd,null,{severalOpen:true});assert.equal(r.availableQuantity,100);assert.deepEqual(r.openOrders,[{orderId:'0000123',symbol:'000660',side:'Buy',quantity:null,remaining:3,price:100}]);
  await assert.rejects(korea([kr('9','005930','Buy',1,'Partially filled')]).prepareOrder(cmd,null,{severalOpen:true}),/OPEN_BROKER_ORDERS/);
  await assert.rejects(korea([kr('9','005930','Buy',1)]).prepareOrder({...cmd,side:'Sell',quantity:1},null,{severalOpen:true}),/OPEN_BROKER_ORDERS/,'a sale of the stock too');
  const off=await korea([]).prepareOrder(cmd);assert.equal('openOrders' in off,false,'off: the result is as before');
});
function overseas(rows){const raw=new KisReadOnlyClient(credentials,async url=>{const params=new URL(url).searchParams;let body={rt_cd:'0'};
  if(url.endsWith('/oauth2/tokenP'))body={access_token:'t',expires_in:3600};else if(url.includes('inquire-balance'))body.output1=params.get('OVRS_EXCG_CD')==='NASD'?[{ovrs_pdno:'AAPL',ovrs_excg_cd:'NASD',tr_crcy_cd:'USD',ovrs_cblc_qty:'10',ord_psbl_qty:'10',pchs_avg_pric:'150',now_pric2:'200',ovrs_stck_evlu_amt:'2000'}]:[];
  else if(url.includes('inquire-present-balance'))body.output2=[{crcy_cd:'USD',frcr_dncl_amt_2:'1000'}];else if(url.includes('/price?'))body.output={last:'200'};else if(url.includes('inquire-psamount'))body.output={ord_psbl_qty:'5',ord_psbl_frcr_amt:'1000'};
  else if(url.includes('inquire-ccnl'))body.output=rows;else throw new Error('Unexpected '+url);return new Response(JSON.stringify(body));},async()=>{});
  return new OverseasClient(raw,()=>new Date('2026-10-15T15:00:00Z'));}
const ccnl=(odno,pdno,qty,filled,buy=true)=>({odno,orgn_odno:'',ovrs_excg_cd:'NASD',pdno,sll_buy_dvsn_cd:buy?'02':'01',ft_ord_qty:String(qty),ft_ccld_qty:String(filled),nccs_qty:String(qty-filled),ft_ord_unpr3:'150.5',ft_ccld_unpr3:'150.5',rvse_cncl_dvsn:'00',rjct_rson:''});
test('U.S.: with the switch on, another stock\'s open order passes and is returned; the same stock\'s refuses; off returns no list',async()=>{
  const buy={symbol:'NASD:AAPL',side:'Buy',quantity:2,limitPrice:200.01};
  const r=await overseas([ccnl('77','MSFT',3,1,false)]).prepare(buy,null,{severalOpen:true});assert.deepEqual(r.openOrders,[{orderId:'77',symbol:'NASD:MSFT',side:'Sell',quantity:3,remaining:2,price:150.5}]);
  await assert.rejects(overseas([ccnl('78','AAPL',3,0)]).prepare(buy,null,{severalOpen:true}),/OPEN_BROKER_ORDERS/);
  assert.equal('openOrders' in await overseas([]).prepare(buy),false);
});
test('the engine asks for the list only with the switch on, and tells the app\'s orders (any number in their chains, either market) from yours',async()=>{
  const db=new DatabaseSync(':memory:');const calls=[];const conn=()=>({status:'connected',snapshot:{accountKey:'acct',environment:'mock',reportedTotal:1e7,cash:1e7,settledCash:1e7,holdings:[]}});
  const e=new LiveEngine(db,{request:async(op,p)=>{calls.push([op,p]);if(op==='prepare-order')return {ticket:'t',balance:{...conn().snapshot,timestamp:new Date().toISOString()}};return {brokerOrderId:'5'};}},conn,{severalOpen:true});e.costs={get:()=>({}),context:()=>null};
  e.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');await e.submit(e.propose({symbol:'005930',side:'Buy',quantity:1,limitPrice:1000}).id,'PLACE MOCK ORDER');
  assert.deepEqual(calls.find(c=>c[0]==='prepare-order')[1].severalOpen,true);
  const put=(id,account,o)=>db.prepare('INSERT INTO live_intents VALUES(?,?,?)').run(id,account,JSON.stringify({id,accountKey:account,...o}));
  put('a','acct',{brokerOrderId:'0000123',brokerOrderIds:['0000123','0000124'],currentBrokerOrderId:'0000124'});put('u','acct:US',{brokerOrderId:'31'});
  const listed=['123','0000124','5','31','999','0000777'].map(orderId=>({orderId,symbol:'000660',side:'Buy',remaining:1,price:100}));
  assert.deepEqual(e.othersOpen({openOrders:listed}).map(o=>o.orderId),['999','0000777'],'yours: numbers in no app chain (leading zeros ignored)');
  assert.deepEqual(e.othersOpen({}),[],'no list: none');
  put('bad','acct','{');db.prepare("UPDATE live_intents SET payload='{' WHERE id='bad'").run();assert.equal(e.othersOpen({openOrders:listed}).length,6,'records unreadable: every open order counted as yours (fails closed)');
});
