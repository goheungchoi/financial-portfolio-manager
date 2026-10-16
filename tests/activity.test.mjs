import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {executionSummary,dailyRealized} from '../src/activity.mjs';
const require=createRequire(import.meta.url);
const {validateRange,normalizeOrders,normalizeProfit,seoulDate}=require('../electron/kis-activity.cjs');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');
const now=Date.parse('2026-10-15T01:00:00+09:00');
const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const row={ord_dt:'20261015',ord_tmd:'090100',odno:'0001',orgn_odno:'0000',pdno:'005930',prdt_name:'Fixture company',sll_buy_dvsn_cd:'02',cncl_yn:'N',ord_qty:'10',tot_ccld_qty:'4',rmn_qty:'6',rjct_qty:'0',tot_ccld_amt:'600',avg_prvs:'150',ord_unpr:'150',ctac_tlno:'must-not-escape',inqr_ip_addr:'must-not-escape'};
const reply=(body,continuation='')=>new Response(JSON.stringify(body),{headers:{tr_cont:continuation}});
test('range validation uses Seoul dates and rejects invalid, future, reversed and too-old ranges',()=>{
  assert.deepEqual(validateRange('2026-10-01','2026-10-15',now),{start:'20261001',end:'20261015'});
  assert.equal(seoulDate(now),'2026-10-15');
  for(const [start,end] of [['2026-02-30','2026-10-15'],['2026-10-15','2026-10-16'],['2026-10-15','2026-10-14'],['2026-08-01','2026-10-15']])assert.throws(()=>validateRange(start,end,now),/INVALID_DATE_RANGE/);
});
test('order snapshots distinguish partial fills/cancellations, strip private fields and deduplicate repeated pages',()=>{
  const orders=normalizeOrders([row,row,{...row,odno:'0002',cncl_yn:'Y',rmn_qty:'0'}],'20261001','20261015');
  assert.equal(orders.length,2);assert.equal(orders[0].status,'Partially filled / canceled');
  assert.equal(orders[1].status,'Partially filled');
  assert.equal(orders[1].timestamp,Date.parse('2026-10-15T09:01:00+09:00'));
  assert.ok(!JSON.stringify(orders).includes('must-not-escape'));
  assert.throws(()=>normalizeOrders([row,{...row,tot_ccld_qty:'5'}],'20261001','20261015'),/INCOMPLETE_HISTORY/);
});
test('gross trading cash flow is separate from profit and correction-linked aggregates remain unavailable',()=>{
  const orders=normalizeOrders([row,{...row,odno:'0002',sll_buy_dvsn_cd:'01',tot_ccld_amt:'800'}],'20261001','20261015');
  assert.deepEqual(executionSummary(orders),{orderCount:2,executedOrders:2,ambiguous:false,buy:600,sell:800,grossFlow:200});
  assert.equal(executionSummary([{...orders[0],originalOrderId:'123'}]).grossFlow,null);
});
test('broker profit retains reported totals and missing fees are unavailable, not zero',()=>{
  const data=normalizeProfit([{trad_dt:'20261015',pdno:'005930',prdt_name:'Fixture',rlzt_pfls:'100',fee:'10',tl_tax:'5'}],{tot_rlzt_pfls:'100',tot_fee:'10',tot_pftrt:'2.5'},'20261001','20261015');
  assert.equal(data.summary.realized,100);assert.equal(data.summary.tax,null);
  assert.equal(dailyRealized(data.records)[0].realized,100);
  assert.equal(dailyRealized([...data.records,{...data.records[0],realized:-25}])[0].cumulative,75);
});
test('order query paginates read-only data with mock transaction ID and fails rather than returning partial pages',async()=>{
  let page=0;const calls=[];const day=seoulDate();const compact=day.replaceAll('-','');
  const client=new KisReadOnlyClient(credentials,async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'token',expires_in:1000});
    assert.equal(options.method,'GET');assert.equal(options.headers.tr_id,'VTTC0081R');
    if(page++===0)return reply({rt_cd:'0',output1:[{...row,ord_dt:compact}],ctx_area_fk100:'next',ctx_area_nk100:'key'},'M');
    return reply({rt_cd:'0',output1:[{...row,ord_dt:compact}]});
  },async()=>{});
  const data=await client.getActivity('orders',day,day);
  assert.equal(data.orders.length,1);assert.equal(calls[2].options.headers.tr_cont,'N');
  const failed=new KisReadOnlyClient(credentials,async url=>url.endsWith('/oauth2/tokenP')?reply({access_token:'token',expires_in:1000}):reply({rt_cd:'0',output1:[{...row,ord_dt:compact}],ctx_area_fk100:'',ctx_area_nk100:''},'M'),async()=>{});
  await assert.rejects(failed.getActivity('orders',day,day),/INCOMPLETE_HISTORY/);
});
test('mock profit is explicitly unavailable and live profit uses broker-reported realized results',async()=>{
  const day=seoulDate();const compact=day.replaceAll('-','');
  const mock=new KisReadOnlyClient(credentials,async()=>{throw new Error('must not call');},async()=>{});
  await assert.rejects(mock.getActivity('profit',day,day),/FEATURE_UNAVAILABLE/);
  const live=new KisReadOnlyClient({...credentials,environment:'live'},async(url,options)=>{
    if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'token',expires_in:1000});
    assert.equal(options.method,'GET');assert.equal(options.headers.tr_id,'TTTC8715R');
    return reply({rt_cd:'0',output1:[{trad_dt:compact,pdno:'005930',prdt_name:'Fixture',rlzt_pfls:'-50'}],output2:{tot_rlzt_pfls:'-50',tot_fee:'5',tot_tltx:'2',tot_pftrt:'-1'}});
  },async()=>{});
  const data=await live.getActivity('profit',day,day);
  assert.equal(data.summary.realized,-50);assert.equal(data.summary.fee,5);
});
