// Orders made outside the app (found in live use: a sale made in the KIS app was recorded as a deposit). Made-up symbols,
// order numbers, days and amounts throughout.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {outsideFills,appOrderIds,kindOf,historyThrough,lateWindow,afterLastFill}=require('../electron/outside-fills.cjs');
const {FlowDetector}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
const at=s=>Date.parse(s);
const row=(orderId,extra={})=>({id:`20261005:91000:${orderId}`,orderId,originalOrderId:null,symbol:'123450',name:'Sample',timestamp:at('2026-10-05T09:10:00+09:00'),side:'Sell',quantity:1,filled:1,remaining:0,rejected:0,executionAmount:50000,averagePrice:50000,orderPrice:50000,status:'Filled',market:'KR',day:'2026-10-05',creditName:'현금매도',...extra});
const charge=(day,id,charges,filled=1)=>({[`${day}|${id}`]:{charges,filled}});
test('each kind of order made outside the app moves Korean cash by its own rule; app orders, unnamed rows and unknown kinds are left out',()=>{
  const charges={...charge('2026-10-05','101',110),...charge('2026-10-05','102',10),...charge('2026-10-05','103',120),...charge('2026-10-05','104',12)};
  const rows=[row('101'),row('102',{creditName:'현금매수',side:'Buy'}),row('103',{creditName:'유대신규',loanDate:'2026-10-07'}),
    row('104',{creditName:'유대상환',side:'Buy',loanDate:'2026-10-07',executionAmount:48000,averagePrice:48000}),
    row('105',{creditName:'유통융자상환'}),row('106'),row('107',{originalOrderId:'106'}),row('108',{creditName:'유대매도거부',filled:0,executionAmount:0,averagePrice:0}),row('109',{creditName:undefined})];
  const intents=[{market:'KR',brokerOrderId:'0000106',day:'2026-10-05'}];const out=outsideFills(rows,intents,{charges});
  assert.deepEqual(out.map(f=>[f.outside.orderId,f.outside.kind,f.resultCosts.netCash]),[['101','cash',49890],['102','cash',-50010],['103','short',-120],['104','cover',1988]],
    'a sale +amount−fees, a purchase −amount−fees, a short −fees only, a cover the short\'s proceeds less the buy-back and fees; a margin kind, the app\'s order and its revision, a refused order and a row without KIS\'s name are not listed');
  assert.ok(out.every(f=>f.resultCosts.basis==='broker'));assert.equal(kindOf({creditName:''}),null,'a row recorded before names were kept is not explained');assert.equal(kindOf({creditName:'자기융자신규'}),null);
  assert.deepEqual([...appOrderIds(rows,intents)].sort(),['2026-10-05|106','2026-10-05|107']);
});
test('KIS numbers orders each day: the same number on two days is two orders, for the app\'s identity and for fees',()=>{
  const rows=[row('201',{day:'2026-10-05'}),row('201',{id:'20261006:91000:201',day:'2026-10-06',timestamp:at('2026-10-06T09:10:00+09:00'),executionAmount:25000000,averagePrice:25000000})];
  const out=outsideFills(rows,[{market:'KR',brokerOrderId:'201',day:'2026-10-05'}],{charges:charge('2026-10-05','201',110)});
  assert.deepEqual(out.map(f=>[f.outside.day,Boolean(f.awaitingCharge)]),[['2026-10-06',true]],'the app\'s order of the first day is the app\'s; the large fill of the second day waits for its own figure, not the other day\'s');
  const [f]=outsideFills(rows,[{market:'KR',brokerOrderId:'201',day:'2026-10-05'}],{charges:charge('2026-10-06','201',60000)});assert.equal(f.outside.day,'2026-10-06');assert.equal(f.resultCosts.netCash,24940000);
});
test('a cover needs its short; a short in several fills, partly covered; a large fill waits for KIS\'s figure, is estimated if it cannot be read, and a figure for a smaller fill is not used',()=>{
  assert.deepEqual(outsideFills([row('301',{creditName:'유대상환',side:'Buy',loanDate:'2026-10-07'})],[]),[]);
  const shorts=[row('302',{creditName:'유대신규',loanDate:'2026-10-07'}),row('303',{creditName:'유대신규',loanDate:'2026-10-07',executionAmount:52000,averagePrice:52000})];
  const cover=row('304',{creditName:'유대상환',side:'Buy',loanDate:'2026-10-07',executionAmount:48000,averagePrice:48000});
  const c=outsideFills([...shorts,cover],[],{charges:charge('2026-10-05','304',20)}).find(f=>f.outside.kind==='cover');assert.equal(c.resultCosts.netCash,51000-48000-20,'the average proceeds of the lot');
  const large=row('305',{executionAmount:25000000,averagePrice:25000000});assert.equal(outsideFills([large],[])[0].awaitingCharge,true,'listed as waiting, not counted');
  assert.equal(outsideFills([large],[],{charges:{'2026-10-05|305':{failed:true}}})[0].resultCosts.basis,'estimate-unread');
  const grown=row('306',{filled:2,quantity:2,executionAmount:100000});const [g]=outsideFills([grown],[],{charges:charge('2026-10-05','306',110,1)});assert.equal(g.resultCosts.basis,'estimate','the figure was for 1 share; the fill is now 2');
});
test('the order history keeps KIS\'s kind name and the loan date',()=>{
  const {normalizeOrders}=require('../electron/kis-activity.cjs');
  const base={pdno:'123450',prdt_name:'Sample',odno:'0000401',orgn_odno:'',sll_buy_dvsn_cd:'01',cncl_yn:'',ord_dt:'20261005',ord_tmd:'091000',ord_qty:'1',tot_ccld_qty:'1',rmn_qty:'0',rjct_qty:'0',tot_ccld_amt:'50000',avg_prvs:'50000',ord_unpr:'50000',ord_gno_brno:'91000'};
  const [a]=normalizeOrders([{...base,sll_buy_dvsn_cd_name:'유대신규',loan_dt:'20261007'}],'20261005','20261005');assert.equal(a.creditName,'유대신규');assert.equal(a.loanDate,'2026-10-07');
  const [b]=normalizeOrders([base],'20261005','20261005');assert.equal('creditName' in b,false);assert.equal('loanDate' in b,false);
});
test('the history is complete up to its last read, or after the day\'s last fill until the next session; the evening window',()=>{
  assert.equal(historyThrough({readAt:at('2026-10-05T14:00:00+09:00'),ready:false}),null,'not ready: nothing is complete');
  assert.equal(historyThrough({readAt:at('2026-10-05T15:30:00+09:00'),ready:true,now:at('2026-10-05T17:00:00+09:00')}),at('2026-10-05T15:30:00+09:00'),'after the app\'s session but before 20:00: only the last read');
  assert.equal(historyThrough({readAt:at('2026-10-05T20:01:00+09:00'),ready:true,now:at('2026-10-05T23:00:00+09:00')}),at('2026-10-05T23:00:00+09:00'),'read after 20:00: complete until the next session');
  assert.equal(historyThrough({readAt:at('2026-10-09T20:01:00+09:00'),ready:true,now:at('2026-10-12T09:00:00+09:00')}),at('2026-10-12T08:00:00+09:00'),'a Friday evening read covers the weekend until Monday 08:00');
  assert.equal(lateWindow(at('2026-10-05T16:00:00+09:00')),true);assert.equal(lateWindow(at('2026-10-05T20:30:00+09:00')),false);assert.equal(lateWindow(at('2026-10-10T16:00:00+09:00')),false,'Saturday');
  assert.equal(afterLastFill(at('2026-10-05T19:00:00+09:00')),null);assert.equal(afterLastFill(at('2026-10-05T21:00:00+09:00')),at('2026-10-05T20:00:00+09:00'));
});
function setup(){let now=at('2026-10-05T09:00:00+09:00');const db=new DatabaseSync(':memory:');const perf=new PerformanceHistory(db,()=>now);const d=new FlowDetector(db,perf,()=>now);const notes=[];d.onNote=(t,m)=>notes.push([t,m]);return {d,perf,notes,tick:s=>{now=at(s);}};}
const fill=(orderId,time,net,extra={})=>({id:'kis:'+orderId,market:'KR',side:net>0?'Sell':'Buy',symbol:'123450',filled:2,fillPrice:50000,status:'Filled',createdAt:at(time),resultCosts:{netCash:net,basis:'broker'},outside:{orderId,kind:'cash',name:net>0?'현금매도':'현금매수'},...extra});
const sale=(orderId,time,net=99800)=>fill(orderId,time,net);
const rd=t=>({readAt:{KR:at(t),US:null},ordersThrough:at(t)});
test('a sale made outside the app explains the cash it moves: in the same reading, or when its row comes a reading later',()=>{
  const {d,perf,notes,tick}=setup();d.observe('acct',{krCash:1000000,outside:[],ordersThrough:at('2026-10-05T09:00:00+09:00')});
  tick('2026-10-05T09:12:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1099800,outside:[sale('401','2026-10-05T09:10:00+09:00')],ordersThrough:at('2026-10-05T09:12:00+09:00')}),[]);
  assert.deepEqual(d.pending('acct'),[],'nothing held');assert.ok(notes.some(([t,m])=>t==='Order outside the app'&&/sale of 2 shares of 123450 made outside the app \(KIS order 401\)/.test(m)));
  tick('2026-10-05T09:20:00+09:00');d.observe('acct',{krCash:1199600,outside:[sale('401','2026-10-05T09:10:00+09:00')],ordersThrough:at('2026-10-05T09:19:00+09:00')});assert.equal(d.pending('acct')[0].amount,99800);
  tick('2026-10-05T09:21:00+09:00');d.observe('acct',{krCash:1199600,outside:[sale('401','2026-10-05T09:10:00+09:00'),sale('402','2026-10-05T09:18:00+09:00')],ordersThrough:at('2026-10-05T09:21:00+09:00')});
  assert.deepEqual(d.pending('acct'),[]);assert.deepEqual(perf.flows('acct'),[]);assert.ok(notes.some(([t,m])=>t==='Cash change explained'&&/rose by ₩99,800: your sale/.test(m)));
});
test('a rise is not recorded early before the order history was read after it; a stale history keeps the long hold with its reason',()=>{
  const {d,perf,tick}=setup();d.observe('acct',{krCash:1000000,outside:[],ordersThrough:at('2026-10-05T09:00:00+09:00')});
  tick('2026-10-05T09:10:00+09:00');d.observe('acct',{krCash:1500000,outside:[],ordersThrough:at('2026-10-05T09:01:00+09:00')});
  tick('2026-10-05T09:25:00+09:00');assert.deepEqual(d.observe('acct',{krCash:1500000,outside:[],ordersThrough:at('2026-10-05T09:01:00+09:00')}),[],'not after 10 minutes');
  assert.equal(d.pending('acct')[0].holdReason,"the day's KIS orders were not read");
  tick('2026-10-05T09:26:00+09:00');const [flow]=d.observe('acct',{krCash:1500000,outside:[],...rd('2026-10-05T09:26:00+09:00')});assert.equal(flow?.amount,500000);assert.equal(perf.flows('acct').length,1);
});
const recordAt=(s,amount,start='2026-10-05T09:12:00+09:00',end='2026-10-05T11:15:00+09:00')=>{const {d,tick}=s;d.observe('acct',{krCash:1000000,outside:[]});tick(start);d.observe('acct',{krCash:1000000+amount,outside:[]});tick(end);const [f]=d.observe('acct',{krCash:1000000+amount,outside:[]});return f;};
test('a detected flow an outside order explains later is withdrawn; one you confirmed is asked about, never removed; a larger genuine flow is never reduced',()=>{
  {const s=setup();const f=recordAt(s,99800);assert.ok(f.detected);s.tick('2026-10-05T11:20:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('501','2026-10-05T09:10:00+09:00')]});
    assert.deepEqual(s.perf.flows('acct'),[],'withdrawn');assert.ok(s.notes.some(([t,m])=>t==='Detected change withdrawn'&&/is your sale of 2 shares of 123450/.test(m)));
    s.tick('2026-10-05T13:30:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('501','2026-10-05T09:10:00+09:00')]});assert.deepEqual(s.perf.flows('acct'),[],'and the fill is not counted again as a withdrawal');assert.deepEqual(s.d.pending('acct'),[]);}
  {const s=setup();const f=recordAt(s,500000);s.tick('2026-10-05T11:20:00+09:00');s.d.observe('acct',{krCash:1500000,outside:[sale('502','2026-10-05T09:10:00+09:00')]});
    const [kept]=s.perf.flows('acct');assert.equal(kept.id,f.id);assert.equal(kept.amount,500000,'a ₩500,000 deposit is not reduced by a ₩99,800 sale in its window');}
  {const s=setup();const f=recordAt(s,99800);s.perf.confirmFlow('acct',f.id);s.tick('2026-10-05T11:20:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('503','2026-10-05T09:10:00+09:00')]});
    assert.equal(s.perf.flows('acct').length,1,'kept');const [ask]=s.d.asks('acct');assert.equal(ask.flowId,f.id);
    const [item]=require('../electron/cash-checks.cjs').askItems(s.d.asks('acct'));assert.equal(item.id,'flow-ask-'+f.id);assert.ok(item.dismissible);
    s.d.dismissAsk('acct',f.id);assert.deepEqual(s.d.asks('acct'),[]);s.tick('2026-10-05T11:21:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('503','2026-10-05T09:10:00+09:00')]});assert.deepEqual(s.d.asks('acct'),[],'not asked again');}
});
test('a resting order placed near a deposit is not matched to it when its own cash arrives now',()=>{
  const s=setup();const f=recordAt(s,500000);s.perf.confirmFlow('acct',f.id);
  s.tick('2026-10-05T13:01:00+09:00');assert.deepEqual(s.d.observe('acct',{krCash:1599800,outside:[sale('601','2026-10-05T09:10:00+09:00')]}),[]);
  assert.deepEqual(s.d.asks('acct'),[],'no question about the genuine deposit');assert.deepEqual(s.d.pending('acct'),[],'the sale explains its own cash');assert.equal(s.perf.flows('acct').length,1);
});
test('a flow you removed is remembered: its fill arriving later is not counted as a withdrawal',()=>{
  const s=setup();const f=recordAt(s,99800);s.perf.removeFlow('acct',f.id);s.d.noteRemoved('acct',f.id);s.tick('2026-10-05T11:20:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('701','2026-10-05T09:10:00+09:00')]});
  s.tick('2026-10-05T13:30:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('701','2026-10-05T09:10:00+09:00')]});
  assert.deepEqual(s.perf.flows('acct'),[]);assert.deepEqual(s.d.pending('acct'),[]);assert.ok(s.notes.some(([t,m])=>t==='Order outside the app'&&/that you removed; it is not counted again/.test(m)));
});
test('an early record the app settles is not taken as your act',()=>{
  // Recorded early (no history tracked yet), then the row: withdrawn by the app, never "the earlier record you removed".
  const s=setup();s.d.observe('acct',{krCash:1000000,readAt:{KR:at('2026-10-05T09:00:00+09:00'),US:null}});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1099800,readAt:{KR:at('2026-10-05T09:12:00+09:00'),US:null}});
  s.tick('2026-10-05T09:25:00+09:00');const [early]=s.d.observe('acct',{krCash:1099800,readAt:{KR:at('2026-10-05T09:25:00+09:00'),US:null}});assert.equal(early?.amount,99800);
  s.tick('2026-10-05T09:26:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('801','2026-10-05T09:10:00+09:00')],readAt:{KR:at('2026-10-05T09:26:00+09:00'),US:null}});assert.deepEqual(s.perf.flows('acct'),[]);
  s.tick('2026-10-05T09:40:00+09:00');s.d.observe('acct',{krCash:1599800,outside:[sale('801','2026-10-05T09:10:00+09:00')]});s.tick('2026-10-05T11:45:00+09:00');const [later]=s.d.observe('acct',{krCash:1599800,outside:[sale('801','2026-10-05T09:10:00+09:00')]});
  assert.equal(later?.amount,500000);assert.doesNotMatch(later.note,/you removed|you confirmed/);
});
test('at the upgrade, fills already in the cash count as seen, and a detected flow they explain is withdrawn; readings without the history do not use the seeding up',()=>{
  const s=setup();s.d.observe('acct',{krCash:1000000});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1099800});s.tick('2026-10-05T11:15:00+09:00');s.d.observe('acct',{krCash:1099800});assert.equal(s.perf.flows('acct').length,1);
  s.tick('2026-10-05T11:30:00+09:00');s.d.observe('acct',{krCash:1099800,outside:null});s.tick('2026-10-05T11:40:00+09:00');s.d.observe('acct',{krCash:1099800,outside:null});
  s.tick('2026-10-05T12:00:00+09:00');assert.deepEqual(s.d.observe('acct',{krCash:1099800,outside:[sale('901','2026-10-05T09:10:00+09:00')],ordersThrough:at('2026-10-05T12:00:00+09:00')}),[]);
  assert.deepEqual(s.perf.flows('acct'),[],'the old detected flow is withdrawn');s.tick('2026-10-05T14:30:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('901','2026-10-05T09:10:00+09:00')]});
  assert.deepEqual(s.perf.flows('acct'),[],'no false withdrawal for a fill already in the cash');assert.deepEqual(s.d.pending('acct'),[]);
});
test('a fill keeps the cash effect it was counted with: a new estimate does not move it; KIS\'s figure replaces it once; a growing fill counts its growth',()=>{
  const s=setup();const est=(n,net,filled=2)=>({...sale('a01','2026-10-05T09:10:00+09:00',net),filled,resultCosts:{netCash:net,basis:n}});
  s.d.observe('acct',{krCash:1000000,outside:[]});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[est('estimate',99800)]});
  s.tick('2026-10-05T09:14:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[est('estimate',85000)]});assert.deepEqual(s.d.pending('acct'),[],'a changed cost profile moves nothing');
  s.tick('2026-10-05T09:16:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[est('broker',99790)]});assert.deepEqual(s.d.pending('acct'),[],'₩10 of difference, below the threshold');
  s.tick('2026-10-05T09:18:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[est('estimate',80000)]});assert.deepEqual(s.d.pending('acct'),[],'KIS\'s figure is never replaced by an estimate');
  s.tick('2026-10-05T09:20:00+09:00');s.d.observe('acct',{krCash:1249500,outside:[est('estimate',249500,5)]});assert.deepEqual(s.d.pending('acct'),[],'the fill grew from 2 to 5 shares');
  s.tick('2026-10-05T12:00:00+09:00');s.d.observe('acct',{krCash:1249500,outside:[est('estimate',249500,5)]});assert.deepEqual(s.perf.flows('acct'),[]);
});
test('KIS lists the order before its cash moves: nothing recorded, no early record, and the words say so (a sale and a purchase)',()=>{
  for(const [f,cash] of [[sale('b01','2026-10-05T09:10:00+09:00'),99800],[fill('b02','2026-10-05T09:10:00+09:00',-100015),-100015]]){
    const s=setup();s.d.observe('acct',{krCash:1000000,outside:[],...rd('2026-10-05T09:00:00+09:00')});
    s.tick('2026-10-05T09:11:00+09:00');assert.deepEqual(s.d.observe('acct',{krCash:1000000,outside:[f],...rd('2026-10-05T09:11:00+09:00')}),[],'the row first');
    s.tick('2026-10-05T09:25:00+09:00');assert.deepEqual(s.d.observe('acct',{krCash:1000000,outside:[f],...rd('2026-10-05T09:25:00+09:00')}),[],'still no record after 14 minutes');
    if(cash<0)assert.equal(s.d.pending('acct')[0].holdReason,'an order made outside the app is waiting for its cash');
    s.tick('2026-10-05T09:26:00+09:00');assert.deepEqual(s.d.observe('acct',{krCash:1000000+cash,outside:[f],...rd('2026-10-05T09:26:00+09:00')}),[],'then the cash');
    assert.deepEqual(s.d.pending('acct'),[]);assert.deepEqual(s.perf.flows('acct'),[]);
    assert.ok(s.notes.some(([t,m])=>t==='Cash change explained'&&/KIS listed it before its cash reached the balance, and the cash has now arrived/.test(m)));assert.ok(!s.notes.some(([t])=>t==='Cash change reversed'));}
});
test('a deposit held when an outside purchase\'s row comes after its cash keeps its 10-minute record; a withdrawal beside an outside purchase is recorded net of it',()=>{
  {const s=setup();const buy=fill('c01','2026-10-05T09:11:00+09:00',-100015);s.d.observe('acct',{krCash:1000000,outside:[],...rd('2026-10-05T09:00:00+09:00')});
    s.tick('2026-10-05T09:10:00+09:00');s.d.observe('acct',{krCash:1500000,outside:[],...rd('2026-10-05T09:10:00+09:00')});
    s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1399985,outside:[],...rd('2026-10-05T09:11:30+09:00')});
    s.tick('2026-10-05T09:13:00+09:00');s.d.observe('acct',{krCash:1399985,outside:[buy],...rd('2026-10-05T09:13:00+09:00')});
    assert.notEqual(s.d.pending('acct')[0].holdReason,'an order made outside the app is waiting for its cash','its cash came first');
    s.tick('2026-10-05T09:24:00+09:00');const [f]=s.d.observe('acct',{krCash:1399985,outside:[buy],...rd('2026-10-05T09:24:00+09:00')});assert.equal(f?.amount,500000);}
  {const s=setup();s.d.observe('acct',{krCash:1000000,outside:[]});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:399985,outside:[fill('c02','2026-10-05T09:11:00+09:00',-100015)]});
    s.tick('2026-10-05T11:15:00+09:00');const [w]=s.d.observe('acct',{krCash:399985,outside:[fill('c02','2026-10-05T09:11:00+09:00',-100015)]});assert.equal(w.amount,-500000);}
});
test('a deposit and an outside sale in one reading: only the deposit is recorded',()=>{
  const s=setup();s.d.observe('acct',{krCash:1000000,outside:[]});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1599800,outside:[sale('d01','2026-10-05T09:10:00+09:00')]});
  assert.equal(s.d.pending('acct')[0].amount,500000);s.tick('2026-10-05T11:15:00+09:00');const [f]=s.d.observe('acct',{krCash:1599800,outside:[sale('d01','2026-10-05T09:10:00+09:00')]});assert.equal(f.amount,500000);
});
test("third review: a sale held before the history was read is explained at the first reading that has it, not seeded",()=>{
  const s=setup();s.d.observe('acct',{krCash:1000000,outside:null});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1099800,outside:null});
  assert.equal(s.d.pending('acct')[0].amount,99800,'held while the history is not read');
  s.tick('2026-10-05T09:15:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('e01','2026-10-05T09:10:00+09:00')],ordersThrough:at('2026-10-05T09:15:00+09:00')});
  assert.deepEqual(s.d.pending('acct'),[]);s.tick('2026-10-05T11:30:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('e01','2026-10-05T09:10:00+09:00')]});assert.deepEqual(s.perf.flows('acct'),[]);
  assert.ok(s.notes.some(([t])=>t==='Cash change explained'));
});
test("third review: a fill missing from one reading keeps its stored effect",()=>{
  const s=setup();const est=net=>({...sale('e02','2026-10-05T09:10:00+09:00',net),resultCosts:{netCash:net,basis:'estimate'}});
  s.d.observe('acct',{krCash:1000000,outside:[]});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[est(99800)]});
  s.tick('2026-10-05T09:14:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[]});s.tick('2026-10-05T09:16:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[est(80000)]});
  assert.deepEqual(s.d.pending('acct'),[],'the stored ₩99,800 is kept, not re-priced at ₩80,000');
});
test("third review: a removed U.S. flow never settles a Korean fill; absence is not your Remove; your replacing record is asked about",()=>{
  {const s=setup();const f=recordAt(s,99800);s.perf.removeFlow('acct',f.id);
    const row=s.d.db.prepare('SELECT payload FROM flow_watch WHERE account=?').get('acct');const w=JSON.parse(row.payload);w.recorded=w.recorded.map(x=>({...x,market:'US',removedBy:'you'}));s.d.db.prepare('UPDATE flow_watch SET payload=? WHERE account=?').run(JSON.stringify(w),'acct');
    s.tick('2026-10-05T11:20:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('e03','2026-10-05T09:10:00+09:00')]});assert.ok(s.d.pending('acct').length,'counted, not matched to the U.S. flow');}
  {const s=setup();const f=recordAt(s,99800);s.perf.removeFlow('acct',f.id);s.tick('2026-10-05T11:20:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('e04','2026-10-05T09:10:00+09:00')]});
    assert.ok(!s.notes.some(([,m])=>/that you removed/.test(m)),'removed without your Remove: not taken as yours');}
  {const s=setup();const f=recordAt(s,99800);const mine=s.perf.addFlow('acct',{day:'2026-10-05',market:'KR',amount:99800,note:'Deposit'});assert.equal(mine.replaced?.id,f.id);
    s.tick('2026-10-05T11:20:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('e05','2026-10-05T09:10:00+09:00')]});
    assert.equal(s.d.asks('acct')[0]?.flowId,mine.id,'your record that replaced it is asked about');assert.ok(s.notes.some(([,m])=>/You recorded ₩99,800 as a deposit/.test(m)));}
});
test("third review: the history read after a flow guards a same-amount deposit when a resting order's row comes before its cash",()=>{
  const s=setup();s.d.observe('acct',{krCash:1000000,outside:[],...rd('2026-10-05T09:00:00+09:00')});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[],...rd('2026-10-05T09:12:00+09:00')});
  s.tick('2026-10-05T11:15:00+09:00');const [dep]=s.d.observe('acct',{krCash:1099800,outside:[],...rd('2026-10-05T11:15:00+09:00')});assert.equal(dep.amount,99800);
  s.tick('2026-10-05T13:00:00+09:00');s.d.observe('acct',{krCash:1099800,outside:[sale('e06','2026-10-05T09:10:00+09:00')],...rd('2026-10-05T13:00:00+09:00')});
  assert.equal(s.perf.flows('acct').length,1,'the genuine deposit stays');
});
test("third review: a large fill waiting for KIS's figure holds the rise; counted once the figure is read",()=>{
  const s=setup();const waiting={...sale('e07','2026-10-05T09:10:00+09:00',24940000),awaitingCharge:true};
  s.d.observe('acct',{krCash:1000000,outside:[],...rd('2026-10-05T09:00:00+09:00')});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:25940000,outside:[waiting],...rd('2026-10-05T09:12:00+09:00')});
  s.tick('2026-10-05T09:30:00+09:00');assert.deepEqual(s.d.observe('acct',{krCash:25940000,outside:[waiting],...rd('2026-10-05T09:30:00+09:00')}),[],'no early record');
  assert.equal(s.d.pending('acct')[0].holdReason,"an order made outside the app waits for KIS's fee figure");
  s.tick('2026-10-05T09:35:00+09:00');s.d.observe('acct',{krCash:25940000,outside:[sale('e07','2026-10-05T09:10:00+09:00',24940000)],...rd('2026-10-05T09:35:00+09:00')});assert.deepEqual(s.d.pending('acct'),[]);
});
test("third review: a purchase row, then its cash with a deposit: the deposit is not held as waiting for cash",()=>{
  const s=setup();const buy=fill('e08','2026-10-05T09:10:00+09:00',-100015);s.d.observe('acct',{krCash:1000000,outside:[],...rd('2026-10-05T09:00:00+09:00')});
  s.tick('2026-10-05T09:11:00+09:00');s.d.observe('acct',{krCash:1000000,outside:[buy],...rd('2026-10-05T09:11:00+09:00')});
  s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1399985,outside:[buy],...rd('2026-10-05T09:12:00+09:00')});
  assert.notEqual(s.d.pending('acct')[0].holdReason,'an order made outside the app is waiting for its cash');
  s.tick('2026-10-05T09:23:00+09:00');const [f]=s.d.observe('acct',{krCash:1399985,outside:[buy],...rd('2026-10-05T09:23:00+09:00')});assert.equal(f?.amount,500000);
});
test("third review: historyThrough at a morning start and the morning window",()=>{
  assert.equal(historyThrough({readAt:at('2026-10-05T08:30:00+09:00'),ready:true,now:at('2026-10-05T08:40:00+09:00')}),at('2026-10-05T08:30:00+09:00'),'a morning read: only up to it');
  assert.equal(lateWindow(at('2026-10-05T08:30:00+09:00')),true,'08:00 to 09:00 is read every 5 minutes');assert.equal(lateWindow(at('2026-10-05T07:30:00+09:00')),false);
});
test("fourth review: an older recorded sale beside a genuine held deposit is seeded and settles its own flow; no false withdrawal",()=>{
  const s=setup();s.d.observe('acct',{krCash:1000000});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:3000000});s.tick('2026-10-05T11:15:00+09:00');const [old]=s.d.observe('acct',{krCash:3000000});assert.ok(old.detected,'the old release recorded the sale as a deposit');
  s.tick('2026-10-05T11:30:00+09:00');s.d.observe('acct',{krCash:3500000,outside:null});assert.equal(s.d.pending('acct')[0].amount,500000,'a genuine deposit held');
  s.tick('2026-10-05T11:35:00+09:00');s.d.observe('acct',{krCash:3500000,outside:[sale('f01','2026-10-05T09:10:00+09:00',2000000)],ordersThrough:at('2026-10-05T11:35:00+09:00')});
  assert.equal(s.d.pending('acct')[0]?.amount,500000,'the deposit is untouched');assert.ok(!s.perf.flows('acct').some(f=>f.id===old.id),'the old false deposit is withdrawn');
  s.tick('2026-10-05T13:40:00+09:00');const out=s.d.observe('acct',{krCash:3500000,outside:[sale('f01','2026-10-05T09:10:00+09:00',2000000)]});assert.deepEqual(out.map(f=>f.amount),[500000],'only the deposit is recorded');
});
test("fourth review: notes of a reading rolled back are not sent",()=>{
  const s=setup();s.d.observe('acct',{krCash:1000000,outside:[]});s.notes.length=0;const perf=s.perf;const orig=perf.flows.bind(perf);perf.flows=()=>{throw new Error('BOOM');};
  s.tick('2026-10-05T09:12:00+09:00');assert.throws(()=>s.d.observe('acct',{krCash:1000000,outside:[sale('f02','2026-10-05T09:10:00+09:00')]}));
  perf.flows=orig;assert.deepEqual(s.notes,[],'nothing sent');assert.equal(s.d.lastAt('acct'),at('2026-10-05T09:00:00+09:00'),'the reading was not saved');
  s.d.observe('acct',{krCash:1000000,outside:[sale('f02','2026-10-05T09:10:00+09:00')]});assert.equal(s.notes.filter(([t])=>t==='Order outside the app').length,1,'sent once, by the reading that is saved');
});
test("fourth review: the Remove handlers tell the detector; the Home text says the history was not read yet",()=>{
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','main.cjs'),'utf8');
  assert.match(src,/performance:remove-flow'[^\n]*performance\.removeFlow\(kisState\.snapshot\.accountKey,id\);try\{flowDetector\.noteRemoved\(kisState\.snapshot\.accountKey,id\);\}catch\{\}/);
  assert.match(src,/source:'detected-flow'\}\);performance\.removeFlow\(account,id\);try\{flowDetector\.noteRemoved\(account,id\);\}catch\{\}/);
  assert.match(src,/KIS order history not read yet · Korean cash changes wait 2 hours/);
});
// The old release recorded a sale's cash (09:12) and, minutes later, a genuine deposit of about the same amount (09:14).
const twoFlows=()=>{const s=setup();s.d.observe('acct',{krCash:1000000});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1099800});s.tick('2026-10-05T09:14:00+09:00');s.d.observe('acct',{krCash:1199800});
  s.tick('2026-10-05T11:20:00+09:00');const out=s.d.observe('acct',{krCash:1199800});assert.deepEqual(out.map(f=>f.amount).sort(),[100000,99800].sort());return {s,sale:out.find(f=>f.amount===99800),dep:out.find(f=>f.amount===100000)};};
test("fifth review: two recorded flows fit the fill: the one whose window holds the order is withdrawn, whichever amount is closer",()=>{
  for(const net of [99800,99950]){const {s,sale,dep}=twoFlows();s.tick('2026-10-05T11:30:00+09:00');s.d.observe('acct',{krCash:1199800,outside:[sale_('g01',net)],ordersThrough:at('2026-10-05T11:30:00+09:00')});
    const ids=s.perf.flows('acct').map(f=>f.id);assert.ok(!ids.includes(sale.id),'the sale\'s flow is withdrawn ('+net+')');assert.ok(ids.includes(dep.id),'the genuine deposit stays ('+net+')');}
});
test("fifth review: the sale's flow removed first: the genuine deposit is not removed",()=>{
  const {s,sale,dep}=twoFlows();s.perf.removeFlow('acct',sale.id);s.d.noteRemoved('acct',sale.id);s.tick('2026-10-05T11:30:00+09:00');
  s.d.observe('acct',{krCash:1199800,outside:[sale_('g02',99950)],ordersThrough:at('2026-10-05T11:30:00+09:00')});assert.deepEqual(s.perf.flows('acct').map(f=>f.id),[dep.id]);
  assert.ok(s.notes.some(([,m])=>/that you removed; it is not counted again/.test(m)));
});
test("fifth review: two flows whose windows both hold the order: none is removed; both are asked about",()=>{
  const s=setup();s.d.observe('acct',{krCash:1000000});s.tick('2026-10-05T09:12:00+09:00');s.d.observe('acct',{krCash:1199800});s.tick('2026-10-05T11:15:00+09:00');s.d.observe('acct',{krCash:1199800});
  const flows=s.perf.flows('acct');if(flows.length!==2){const f=flows[0];s.perf.removeFlow('acct',f.id);for(const amount of [99800,100000])s.perf.addFlow('acct',{day:'2026-10-05',market:'KR',amount,detected:true,occurredAfter:at('2026-10-05T09:00:00+09:00'),occurredBy:at('2026-10-05T09:12:00+09:00'),note:'Detected: test'});}
  s.tick('2026-10-05T11:30:00+09:00');s.d.observe('acct',{krCash:1199800,outside:[sale_('g03',99900)],ordersThrough:at('2026-10-05T11:30:00+09:00')});
  assert.equal(s.perf.flows('acct').length,2,'none removed');assert.equal(s.d.asks('acct').length,2,'both asked about');
  const items=require('../electron/cash-checks.cjs').askItems(s.d.asks('acct'));assert.ok(items.every(i=>/was detected/.test(i.detail)));
});
function sale_(orderId,net){return sale(orderId,'2026-10-05T09:10:00+09:00',net);}
