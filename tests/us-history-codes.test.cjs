// M-1.5c (planner's ruling on the finding in M-1.3): U.S. order-history rows filed under BAQ/NAS, BAY/NYS or BAA/AMS are
// kept under NASD, NYSE or AMEX, so an open order filed so is seen by the open-order guard (with the switch off too: it
// can only refuse more). Any other code is dropped and counted.
const test=require('node:test');const assert=require('node:assert/strict');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {OverseasClient}=require('../electron/kis-overseas.cjs');
const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
function overseas(rows){const raw=new KisReadOnlyClient(credentials,async url=>{const params=new URL(url).searchParams;let body={rt_cd:'0'};
  if(url.endsWith('/oauth2/tokenP'))body={access_token:'t',expires_in:3600};else if(url.includes('inquire-balance'))body.output1=params.get('OVRS_EXCG_CD')==='NASD'?[{ovrs_pdno:'AAPL',ovrs_excg_cd:'NASD',tr_crcy_cd:'USD',ovrs_cblc_qty:'10',ord_psbl_qty:'10',pchs_avg_pric:'150',now_pric2:'200',ovrs_stck_evlu_amt:'2000'}]:[];
  else if(url.includes('inquire-present-balance'))body.output2=[{crcy_cd:'USD',frcr_dncl_amt_2:'1000'}];else if(url.includes('/price?'))body.output={last:'200'};else if(url.includes('inquire-psamount'))body.output={ord_psbl_qty:'5',ord_psbl_frcr_amt:'1000'};
  else if(url.includes('inquire-ccnl'))body.output=rows;else throw new Error('Unexpected '+url);return new Response(JSON.stringify(body));},async()=>{});
  return new OverseasClient(raw,()=>new Date('2026-10-08T15:00:00Z'));}
const ccnl=(code,pdno,qty,filled)=>({odno:'7',orgn_odno:'',ovrs_excg_cd:code,pdno,sll_buy_dvsn_cd:'02',ft_ord_qty:String(qty),ft_ccld_qty:String(filled),nccs_qty:String(qty-filled),ft_ord_unpr3:'100',ft_ccld_unpr3:'100',rvse_cncl_dvsn:'00',rjct_rson:''});
const buy={symbol:'NASD:AAPL',side:'Buy',quantity:2,limitPrice:200.01};
test('each mapped code is kept under its regular exchange, and its open order refuses a preparation (switch off)',async()=>{
  for(const [code,regular] of [['BAQ','NASD'],['NAS','NASD'],['BAY','NYSE'],['NYS','NYSE'],['BAA','AMEX'],['AMS','AMEX'],['NYSE','NYSE']]){
    const c=overseas([ccnl(code,'MSFT',3,0)]);const h=await c.orders();assert.equal(h.orders.length,1,code);assert.equal(h.orders[0].symbol,`${regular}:MSFT`,code);assert.equal(h.dropped,undefined,code);
    await assert.rejects(overseas([ccnl(code,'MSFT',3,0)]).prepare(buy),/OPEN_BROKER_ORDERS/,code+': the guard sees it');}
});
test('any other code is dropped and counted, and does not freeze U.S. trading',async()=>{
  const h=await overseas([ccnl('TSE','7203',3,0),ccnl('HKS','0700',1,0),ccnl('TSE','6758',2,0),ccnl('NASD','MSFT',3,3)]).orders();
  assert.deepEqual(h.orders.map(o=>o.symbol),['NASD:MSFT']);assert.deepEqual(h.dropped,{count:3,codes:['TSE','HKS']});
  const r=await overseas([ccnl('TSE','7203',3,0)]).prepare(buy);assert.deepEqual(r.historyDropped,{count:1,codes:['TSE']},'the preparation passes and carries the count');
  assert.equal('historyDropped' in await overseas([]).prepare(buy),false,'nothing dropped: no key');
  assert.deepEqual((await overseas([ccnl('TSE','1',1,0),ccnl('<b>x','2',1,0),ccnl('','3',1,0),ccnl('ABCDEFG','4',1,0)]).orders()).dropped,{count:4,codes:['TSE','?']},'F1: only a plain code is kept; anything else is "?"');
});
test('F2: the Activity report reads a daytime-coded row under its regular exchange; other codes are refused as before',async()=>{
  const row=(odno,code,pdno)=>({ord_dt:'20261016',ord_gno_brno:'00950',odno,sll_buy_dvsn_cd:'02',rvse_cncl_dvsn:'00',pdno,prdt_name:'X',ft_ord_qty:'1',ft_ord_unpr3:'100',ft_ccld_qty:'1',ft_ccld_unpr3:'100',ft_ccld_amt3:'100',nccs_qty:'0',ord_tmd:'001500',ovrs_excg_cd:code,dmst_ord_dt:'20261017',thco_ord_tmd:'001500',mdia_dvsn_name:'OpenAPI'});
  const client=rows=>new OverseasClient({overseasIdentity:()=>({environment:'live'}),overseasRequest:async()=>({body:{output:rows},continuation:'D'})});
  const read=await client([row('0040123456','BAQ','CTSO'),row('0040123457','NYS','IBM')]).orderHistory('2026-09-25','2026-10-18');
  assert.deepEqual(read.map(r=>r.symbol).sort(),['NASD:CTSO','NYSE:IBM']);
  await assert.rejects(client([row('0040123458','TSE','7203')]).orderHistory('2026-09-25','2026-10-18'),/INVALID_RESPONSE/,'any other code: as before');
});
