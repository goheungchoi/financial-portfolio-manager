// M-3 (planner's condition on m3-plan.md): the mock broker (tests/helpers/mock-kis.cjs) answers each operation in the
// shape the real clients give for KIS's HTTP bodies, so a test against the mock proves something about the app. Each
// operation is run through the real Korean (kis-client.cjs) and U.S. (kis-overseas.cjs) clients on fixture bodies, as the
// worker composes it (kis-worker.cjs), and the result's shape (keys, and the type of every value, through arrays and
// objects) is compared with the mock's answer to the same request. Values differ; shapes may not. A key present on one
// side only, or a value of another type, fails. Open maps (KIS's raw numeric fields) are compared as objects only; a null
// matches any type (an optional KIS field left blank).
const test=require('node:test');const assert=require('node:assert/strict');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {OverseasClient}=require('../electron/kis-overseas.cjs');
const {MockKis,seoulDay,nyDay}=require('./helpers/mock-kis.cjs');
const OPEN_MAPS=new Set(['raw','raw.usd','raw.summary','balance.raw','balance.raw.usd','balance.raw.summary','capacityRaw.fields']);
const shape=(v,path='')=>v===null||v===undefined?'null':Array.isArray(v)?{array:v.length?shape(v[0],path+'[]'):'empty'}:typeof v==='object'?(OPEN_MAPS.has(path)?'map':Object.fromEntries(Object.keys(v).sort().map(k=>[k,shape(v[k],path?path+'.'+k:k)]))):typeof v;
// The differences between two shapes, as paths; empty when they agree.
function diff(a,b,path='$'){if(a==='null'||b==='null')return [];if(typeof a==='string'||typeof b==='string')return a===b?[]:[`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
  if(a.array!==undefined||b.array!==undefined){if(a.array===undefined||b.array===undefined)return [`${path}: array on one side only`];return a.array==='empty'||b.array==='empty'?[]:diff(a.array,b.array,path+'[]');}
  const keys=new Set([...Object.keys(a),...Object.keys(b)]);const out=[];for(const k of keys){if(!(k in a))out.push(`${path}.${k}: only in the mock`);else if(!(k in b))out.push(`${path}.${k}: only in the real client`);else out.push(...diff(a[k],b[k],path+'.'+k));}return out;}
const same=(label,real,mock)=>assert.deepEqual(diff(shape(real),shape(mock)),[],label);
const reply=(body,cont='')=>new Response(JSON.stringify({rt_cd:'0',...body}),{headers:{tr_cont:cont}});
const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const today=seoulDay(Date.now()),ymd=today.replaceAll('-','');
// ---- Korea: fixture bodies for one held stock (005930), one open buy of another (000660), and the order replies.
const krRows=[{ord_dt:ymd,ord_tmd:'100000',odno:'0000000101',orgn_odno:'',pdno:'000660',prdt_name:'SK hynix',sll_buy_dvsn_cd:'02',ord_qty:'5',tot_ccld_qty:'2',rmn_qty:'3',rjct_qty:'0',tot_ccld_amt:'400000',avg_prvs:'200000',ord_unpr:'200000',cncl_yn:'N',ord_gno_brno:''},
  {ord_dt:ymd,ord_tmd:'100500',odno:'0000000102',orgn_odno:'0000000101',pdno:'000660',prdt_name:'SK hynix',sll_buy_dvsn_cd:'02',ord_qty:'3',tot_ccld_qty:'0',rmn_qty:'3',rjct_qty:'0',tot_ccld_amt:'0',avg_prvs:'0',ord_unpr:'201000',cncl_yn:'N',ord_gno_brno:''}];
function korea(){const c=new KisReadOnlyClient(credentials,async(url,options)=>{
    if(url.endsWith('/oauth2/tokenP'))return new Response(JSON.stringify({access_token:'t',expires_in:3600}));
    if(url.includes('inquire-price'))return reply({output:{stck_prpr:'70000',aspr_unit:'100',temp_stop_yn:'N',stck_sdpr:'69000',prdy_ctrt:'1.45',acml_vol:'1000'}});
    if(url.includes('inquire-balance'))return reply({output1:[{pdno:'005930',prdt_name:'Samsung',hldg_qty:'10',pchs_avg_pric:'60000',prpr:'70000',evlu_amt:'700000',evlu_pfls_amt:'100000',ord_psbl_qty:'10',trad_dvsn_name:'현금'}],output2:[{dnca_tot_amt:'1000000',prvs_rcdl_excc_amt:'1000000',tot_evlu_amt:'1700000'}]});
    if(url.includes('inquire-psbl-order'))return reply({output:{nrcvb_buy_amt:'1000000',nrcvb_buy_qty:'14'}});
    if(url.includes('inquire-daily-ccld'))return reply({output1:url.includes('ODNO=0000000101')||url.includes('ODNO=101')?krRows.slice(0,1):krRows,output2:[{prsm_tlex_smtl:'60'}]});
    if(url.includes('order-cash')||url.includes('order-rvsecncl'))return reply({output:{ODNO:'0000000103',KRX_FWDG_ORD_ORGNO:'06010'}});
    throw new Error('Unexpected '+url);},async()=>{});
  c.checkSession=async()=>({open:true});return c;}
// The mock in the same state: the held stock, the open buy of another (partly filled, then revised).
function krMock(){const m=new MockKis({kr:{cash:1000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:60000,price:70000}]},prices:{'005930':70000,'000660':200000}});
  const r=m.userOrder('KR',{symbol:'000660',side:'Buy',quantity:5,orderPrice:200000});m.fill('KR',r.orderId,2);m.revise('KR',{command:{originalOrderId:r.orderId,price:201000}});return m;}
test('Korea: live-context, prepare-order (switch on and off), place-order, revise-order, orders and charges have the real shapes',async()=>{
  const c=korea(),m=krMock(),k=m.broker('KR');const cmd={symbol:'005930',side:'Buy',quantity:2,limitPrice:70000};
  // live-context as the worker composes it: the balance, a quote per symbol, the session (open, no extended session).
  same('live-context',{balance:await c.getBalance(),quotes:[await c.getQuote('005930')],marketSession:{open:true,status:'open'}},await k.request('live-context',{symbols:['005930']}));
  // prepare-order: the client's check plus the worker's ticket and session.
  for(const severalOpen of [true,false]){const real=severalOpen?await c.prepareOrder(cmd,null,{severalOpen}):await korea().prepareOrder(cmd,null,{severalOpen}).catch(e=>e);
    if(real instanceof Error){assert.equal(real.message,'OPEN_BROKER_ORDERS');await assert.rejects(k.request('prepare-order',{command:cmd}),/OPEN_BROKER_ORDERS/,'off: both refuse an open order');continue;}
    same('prepare-order (on)',{...real,ticket:'x',session:null},await k.request('prepare-order',{command:cmd,severalOpen}));}
  {const real=await korea().prepareOrder({...cmd,side:'Sell'},null,{severalOpen:true});same('prepare-order (a sale)',{...real,ticket:'x',session:null},await k.request('prepare-order',{command:{...cmd,side:'Sell'},severalOpen:true}));}
  const p=await k.request('prepare-order',{command:cmd,severalOpen:true});
  same('place-order',await c.placeOrder(cmd),await k.request('place-order',{ticket:p.ticket}));
  same('revise-order (price)',await c.reviseOrder({originalOrderId:'0000000103',organization:'06010',price:70100}),await k.request('revise-order',{command:{originalOrderId:'0000000103',organization:'06010',symbol:'005930',side:'Buy',quantity:2,price:70100,cancel:false}}));
  same('orders',await c.getActivity('orders',today,today),await k.request('orders',{startDate:today,endDate:today}));
  same('charges',await c.getOrderCharges(today,'0000000101'),await k.request('charges',{day:today,orderId:'101'}));
});
// ---- U.S.: one held stock (NASD:AAPL), one open sell of another (NASD:MSFT).
const ccnl=(odno,pdno,qty,filled,buy=true,orgn='')=>({odno,orgn_odno:orgn,ovrs_excg_cd:'NASD',pdno,sll_buy_dvsn_cd:buy?'02':'01',ft_ord_qty:String(qty),ft_ccld_qty:String(filled),nccs_qty:String(qty-filled),ft_ord_unpr3:'150.5',ft_ccld_unpr3:'150.5',rvse_cncl_dvsn:'00',rjct_rson:''});
const NOW=new Date('2026-10-15T15:00:00Z');
function overseas(){const raw=new KisReadOnlyClient(credentials,async url=>{const params=new URL(url).searchParams;let body={rt_cd:'0'};
    if(url.endsWith('/oauth2/tokenP'))return new Response(JSON.stringify({access_token:'t',expires_in:3600}));
    if(url.includes('inquire-balance'))body.output1=params.get('OVRS_EXCG_CD')==='NASD'?[{ovrs_pdno:'AAPL',ovrs_item_name:'Apple',ovrs_excg_cd:'NASD',tr_crcy_cd:'USD',ovrs_cblc_qty:'10',ord_psbl_qty:'10',pchs_avg_pric:'150',now_pric2:'200',ovrs_stck_evlu_amt:'2000'}]:[];
    else if(url.includes('inquire-present-balance')){body.output1=[];body.output2=[{crcy_cd:'USD',frcr_dncl_amt_2:'1000',frst_bltn_exrt:'1340'}];body.output3={ustl_buy_amt_smtl:'0',ustl_sll_amt_smtl:'0'};}
    else if(url.includes('/price?'))body.output={last:'200'};
    else if(url.includes('inquire-psamount'))body.output={ord_psbl_frcr_amt:'1000',ord_psbl_qty:'5',exrt:'1340'};
    else if(url.includes('inquire-ccnl'))body.output=[ccnl('77','MSFT',3,1,false)];
    else if(url.includes('order-rvsecncl')||url.includes('/trading/order'))body.output={ODNO:'0000000501'};
    else throw new Error('Unexpected '+url);return new Response(JSON.stringify(body));},async()=>{});
  return new OverseasClient(raw,()=>NOW);}
function usMock(){const m=new MockKis({clock:()=>NOW.getTime(),us:{cash:1000,fx:1340,unsettled:{buyKRW:0,sellKRW:0},holdings:[{symbol:'NASD:AAPL',name:'Apple',quantity:10,cost:150,price:200}]},prices:{'NASD:AAPL':200,'NASD:MSFT':150.5}});
  m.accounts.US.holdings.push({symbol:'NASD:MSFT',name:'Microsoft',quantity:3,cost:150,price:150.5});const r=m.userOrder('US',{symbol:'NASD:MSFT',side:'Sell',quantity:3,orderPrice:150.5});m.fill('US',r.orderId,1);m.accounts.US.holdings=m.accounts.US.holdings.filter(h=>h.symbol==='NASD:AAPL');return m;}
test('U.S.: context, prepare-order, place-order, revise-order and orders have the real shapes (the U.S. operation names, as main.cjs maps them)',async()=>{
  const c=overseas(),m=usMock(),k=m.broker('US');const buy={symbol:'NASD:AAPL',side:'Buy',quantity:2,limitPrice:200.01};
  same('us-context',await c.context(['NASD:AAPL']),await k.request('live-context',{symbols:['NASD:AAPL']}));
  same('us-prepare-order (a buy)',{...await c.prepare(buy,null,{severalOpen:true}),ticket:'x',session:null},await k.request('prepare-order',{command:buy,severalOpen:true}));
  same('us-prepare-order (a sale)',{...await overseas().prepare({...buy,side:'Sell'},null,{severalOpen:true}),ticket:'x',session:null},await k.request('prepare-order',{command:{...buy,side:'Sell'},severalOpen:true}));
  const p=await k.request('prepare-order',{command:buy,severalOpen:true});
  same('us-place-order',await c.place(buy),await k.request('place-order',{ticket:p.ticket}));
  same('us-revise-order',await c.revise({symbol:'NASD:AAPL',originalOrderId:'0000000501',quantity:2,price:200.02}),await k.request('revise-order',{command:{symbol:'NASD:AAPL',originalOrderId:m.book.US.at(-1).orderId,quantity:2,price:200.02}}));
  same('us-orders',await c.orders(nyDay(NOW.getTime())),await k.request('orders',{startDate:nyDay(NOW.getTime()),endDate:nyDay(NOW.getTime())}));
});
test('the comparison fails on a drifted shape (a key renamed, a type changed): it is not vacuous',()=>{
  assert.notDeepEqual(diff(shape({a:1,b:{c:'x'}}),shape({a:1,b:{d:'x'}})),[]);assert.notDeepEqual(diff(shape({a:1}),shape({a:'1'})),[]);assert.notDeepEqual(diff(shape({a:[{x:1}]}),shape({a:[{x:1,y:2}]})),[]);
  assert.deepEqual(diff(shape({a:null}),shape({a:5})),[],'a blank optional field matches');
});
