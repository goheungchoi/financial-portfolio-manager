// M-3.1 (artifacts/reviews/2026-11-16-multi-order/m3-plan.md): the engines with several orders open (severalOpen on, as
// only tests set it), on the mock broker, through the app harness (what main.cjs builds around them). Matrix rows of
// M-0's A4 table in their one-order-per-review form; the batch forms come with M-4/M-5. With the switch off, the same
// situations keep today's one-open-order rule.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness,READING_ORDER}=require('./helpers/app-harness.cjs');
const PRICES={'005930':70000,'000660':200000,'035420':200000,'NASD:AAPL':200,'NASD:MSFT':400};
const rig=({severalOpen=true,kr={},us={},knobs={}}={})=>{const m=new MockKis({kr:{cash:10000000,...kr},us:{cash:5000,...us},prices:PRICES});Object.assign(m,knobs);return appHarness({mock:m,severalOpen}).enable();};
const status=r=>r.status??r.error;

// ---- the harness runs main.cjs's readings in main.cjs's order
// The order of the reading steps in main.cjs's detectFlows (its source): each name's first call site in that function.
function mainOrder(source){const start=source.indexOf('detectFlows=()=>');const body=source.slice(start,source.indexOf('\n  live.flowsToday',start));if(start<0)throw new Error('detectFlows not found');
  return READING_ORDER.map(name=>({name,at:body.indexOf(name+'(')})).map(x=>{if(x.at<0)throw new Error(x.name+' not in detectFlows');return x;}).sort((a,b)=>a.at-b.at).map(x=>x.name);}
test('the harness runs the readings in main.cjs\'s order (detectFlows), and the check fails when main.cjs\'s order changes',()=>{
  const main=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8');assert.deepEqual(mainOrder(main),READING_ORDER);
  // The same check on a copy of main.cjs with the recorder's Korean reading moved before its U.S. reading: it fails.
  const us=main.indexOf('fundingTransfers.observeUS(',main.indexOf('detectFlows=()=>')),kr=main.indexOf('fundingTransfers.observeKR(',us);assert.ok(us>0&&kr>us);
  const swapped=main.slice(0,us)+'fundingTransfers.observeKR('+main.slice(us+'fundingTransfers.observeUS('.length,kr)+'fundingTransfers.observeUS('+main.slice(kr+'fundingTransfers.observeKR('.length);
  assert.notDeepEqual(mainOrder(swapped),READING_ORDER,'a changed order in main.cjs is caught');
  // And the tracker's split is read first, inside its call (peekNet), as main.cjs passes it.
  const df=main.slice(main.indexOf('detectFlows=()=>'));assert.ok(df.indexOf('peekNet')>df.indexOf('inFlight.observe(')&&df.indexOf('peekNet')<df.indexOf('fundingTransfers.observeUS('));
});

// ---- rows 2, 22, 28: orders of different stocks open in both markets; fills of three in one reading, each its own
test('rows 2, 22, 28: three orders open in two markets; their fills in one reading are each matched to their own order and costs',async()=>{
  const h=rig();const a=await h.send('KR','005930','Buy',10,70000),b=await h.send('KR','000660','Buy',5,200000),c=await h.send('US','NASD:AAPL','Buy',3,200);
  assert.deepEqual([a,b,c].map(status),['Accepted','Accepted','Accepted']);
  h.mock.fill('KR',a.brokerOrderId,4);h.mock.fill('KR',b.brokerOrderId);h.mock.fill('US',c.brokerOrderId);await h.reconcile('KR');await h.reconcile('US');
  const o=x=>h.order(x.market,x.id);assert.deepEqual([o(a),o(b),o(c)].map(x=>[x.status,x.filled]),[['Partially filled',4],['Filled',5],['Filled',3]]);
  assert.equal(o(b).fillPrice,200000);assert.ok(o(b).resultCosts&&o(a).resultCosts,'costs per order');h.reading();assert.deepEqual(h.flows,[],'no detected flow');
});
test('row 1 (switch off): a second order in a market is refused while one is open there, as today (one open order per market)',async()=>{
  const h=rig({severalOpen:false});assert.equal(status(await h.send('KR','005930','Buy',10,70000)),'Accepted');
  assert.equal(status(await h.send('KR','000660','Buy',5,200000)),'RECONCILIATION_REQUIRED');assert.equal(status(await h.send('US','NASD:AAPL','Buy',3,200)),'Accepted','the other market\'s own order, as today');
  assert.equal(status(await h.send('US','NASD:MSFT','Buy',1,400)),'RECONCILIATION_REQUIRED');
});
// ---- rows 5, 6: the funding check with an order open, under both answers of Q1 (whether KIS's orderable cash nets it)
test('rows 5, 6: a second buy that fits the cash alone but not beside the open one is never sent, whether KIS nets open orders (Q1) or not',async()=>{
  for(const netsOpenCash of [false,true]){const h=rig({kr:{cash:1000000},knobs:{netsOpenCash}});assert.equal(status(await h.send('KR','005930','Buy',10,70000)),'Accepted');
    const r=await h.send('KR','000660','Buy',2,200000);assert.notEqual(status(r),'Accepted',`Q1 ${netsOpenCash}: refused`);assert.equal(h.mock.book.KR.length,1,'nothing sent');
    assert.equal(status(await h.send('KR','000660','Buy',1,200000)),'Accepted',`Q1 ${netsOpenCash}: one that fits beside it is sent`);
    // Row 6: the U.S. buy, back to back, sees the Korean reservations: with no funding regime verified the ledger's shared
    // pool counts them (its known overcount: it can refuse a buy USD alone would pay, never admit one too many).
    assert.equal(status(await h.send('US','NASD:AAPL','Buy',3,200)),'INSUFFICIENT_CAPACITY','the shared pool sees the Korean buys');assert.equal(h.mock.book.US.length,0);}
  const h=rig();assert.equal(status(await h.send('KR','005930','Buy',10,70000)),'Accepted');assert.equal(status(await h.send('US','NASD:AAPL','Buy',3,200)),'Accepted','room for both: both sent, back to back');
  const c=h.ledger.commitments('acct');assert.ok(c.krw>=700000&&c.usd>=600,'both reserved in the one ledger');
});
// ---- row 8: two sales of one holding, under both answers of Q2
test('row 8: a second sale of a holding with a sale of it open is refused (the same stock open at KIS, D3), and sold once the first is done, under both answers of Q2',async()=>{
  for(const netsOpenQty of [false,true]){const h=rig({kr:{holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:60000,price:70000}]},knobs:{netsOpenQty}});
    const a=await h.send('KR','005930','Sell',6,70000);assert.equal(status(a),'Accepted');assert.equal(status(await h.send('KR','005930','Sell',4,70000)),'OPEN_BROKER_ORDERS',`Q2 ${netsOpenQty}: never two open at once`);
    assert.notEqual(status(await h.send('KR','005930','Sell',6,70000)),'Accepted','nor more than is free');
    // The refused proposals keep their shares until they expire (credit-paths remaining: 120 s), as any proposal does.
    h.mock.fill('KR',a.brokerOrderId);await h.reconcile('KR');for(const o of h.kr.orders().filter(o=>o.status==='Ready'))h.kr.writeOrder({...o,expiresAt:Date.now()-1});
    assert.equal(status(await h.send('KR','005930','Sell',4,70000)),'Accepted',`Q2 ${netsOpenQty}: the rest of the holding`);}
});
// ---- rows 9-13 through the mock's lost replies and slow history
test('rows 9, 10: a lost reply (placed at KIS) blocks only its stock; history settles it; another stock trades meanwhile',async()=>{
  const h=rig();h.mock.fault('place-order','lost');const a=await h.send('KR','005930','Buy',10,70000);assert.equal(status(a),'Uncertain');assert.equal(h.kr.enabled,true,'the market stays on');
  assert.equal(status(await h.send('KR','000660','Buy',5,200000)),'Accepted','row 9: another stock');assert.equal(status(await h.send('KR','005930','Buy',1,70000)),'RECONCILIATION_REQUIRED','row 10: its own stock');
  // The order has no number (the reply was lost): history cannot settle it by number; you link it by its terms.
  await h.reconcile('KR');assert.equal(h.order('KR',a.id).status,'Uncertain');
  await h.kr.linkUncertain(a.id,h.mock.book.KR[0].orderId,'LINK BROKER ORDER');assert.equal(h.order('KR',a.id).status,'Accepted');
  // Linked, it is an open order of its stock at KIS: another order of the stock waits for it (D3); once it is done, it trades.
  assert.equal(status(await h.send('KR','005930','Buy',1,70000)),'OPEN_BROKER_ORDERS');h.mock.fill('KR',h.mock.book.KR[0].orderId);await h.reconcile('KR');
  assert.equal(status(await h.send('KR','005930','Buy',1,70000)),'Accepted','its stock trades again');
});
test('rows 11, 12: an unconfirmed cancellation or revision blocks its stock, counted at the larger terms; the other stocks trade',async()=>{
  for(const cancel of [true,false]){const h=rig();const a=await h.send('KR','005930','Buy',10,70000);h.mock.fault('revise-order','lost');
    await assert.rejects(h.kr.revise(a.id,cancel?{cancel:true}:{price:70100}));const o=h.order('KR',a.id);assert.ok(o.unconfirmed,'unconfirmed');
    assert.equal(status(await h.send('KR','005930','Buy',1,70000)),'RECONCILIATION_REQUIRED');assert.equal(status(await h.send('KR','000660','Buy',1,200000)),'Accepted');
    if(!cancel)assert.ok(h.order('KR',a.id).notional>=10*70100,'the larger price committed');
    // History shows the request's link: the app adopts it and the stock is free again.
    // History shows the request's link: the app adopts it. Cancelled, the stock is free; revised, its order is still open at
    // KIS, so another order of the stock waits for it (D3).
    await h.reconcile('KR');assert.ok(!h.order('KR',a.id).unconfirmed,'history confirmed it');assert.equal(status(await h.send('KR','005930','Buy',1,70000)),cancel?'Accepted':'OPEN_BROKER_ORDERS');}
});
test('row 13: history that cannot be read with an order open stops every new order in that market, and only until it reads again',async()=>{
  const h=rig({kr:{holdings:[{symbol:'035420',name:'Naver',quantity:3,cost:200000,price:200000}]}});await h.send('KR','005930','Buy',10,70000);h.mock.fault('orders',{fail:'NETWORK_UNAVAILABLE'},2);
  assert.equal(await h.reconcile('KR'),'NETWORK_UNAVAILABLE');assert.equal(status(await h.send('KR','000660','Buy',1,200000)),'RECONCILIATION_REQUIRED');
  assert.equal(status(await h.send('KR','035420','Sell',1,200000)),'RECONCILIATION_REQUIRED','protective sales too (D4)');assert.equal(status(await h.send('US','NASD:AAPL','Buy',1,200)),'Accepted','the other market is unaffected');
  await h.reconcile('KR');await h.reconcile('KR');assert.equal(status(await h.send('KR','000660','Buy',1,200000)),'Accepted','after a good read');
});
// ---- rows 14, 15, 17, 30, 31 in their one-order form: a refusal of one order while another rests
test('rows 14, 15: the request limit before the place (not sent) and a lost reply at it (uncertain), while another order rests',async()=>{
  const h=rig();const a=await h.send('KR','005930','Buy',10,70000);h.mock.fault('place-order','not-sent');const b=await h.send('KR','000660','Buy',5,200000);
  assert.deepEqual([b.status,b.reason],['Rejected','ORDER_NOT_SENT']);assert.equal(h.mock.book.KR.length,1,'nothing reached KIS');assert.equal(h.kr.enabled,true);
  h.mock.fault('place-order','lost-unplaced');const c=await h.send('KR','035420','Buy',5,200000);assert.equal(c.status,'Uncertain','sent, reply lost: uncertain');
  assert.equal(h.order('KR',a.id).status,'Accepted','the resting order is untouched');
});
test('rows 17, 30, 31: a KIS rejection, trading stopped, a closed session: the one order is refused; the resting order is untouched',async()=>{
  const h=rig();const a=await h.send('KR','005930','Buy',10,70000);h.mock.fault('place-order',{reject:'APBK0919'});
  const b=await h.send('KR','000660','Buy',5,200000);assert.deepEqual([b.status,b.reason],['Rejected','BROKER_REJECTED']);assert.equal(status(await h.send('KR','035420','Buy',1,200000)),'Accepted','the next is sent');
  h.mock.sessionOpen.KR=false;assert.equal(status(await h.send('KR','000660','Buy',1,200000)),'SESSION_CLOSED');h.mock.sessionOpen.KR=true;
  h.kr.stop();assert.equal(status(await h.send('KR','000660','Buy',1,200000)),'KIS_TRADING_DISABLED');assert.equal(h.order('KR',a.id).status,'Accepted');
});
// ---- rows 18-21: restarts
test('rows 18, 20: after a restart, open orders reconcile and are tracked again; an order never sent is never sent after it expires',async()=>{
  const h=rig();const a=await h.send('KR','005930','Buy',10,70000),b=await h.send('KR','000660','Buy',5,200000),c=await h.send('US','NASD:AAPL','Buy',3,200);
  const ready=h.kr.propose({symbol:'035420',side:'Buy',quantity:1,limitPrice:200000});h.mock.fill('KR',b.brokerOrderId,2);h.restart();
  await h.reconcile('KR');await h.reconcile('US');assert.deepEqual([a,b,c].map(x=>h.order(x.market,x.id).status),['Accepted','Partially filled','Accepted']);
  h.kr.writeOrder({...h.order('KR',ready.id),expiresAt:Date.now()-1});await assert.rejects(h.kr.submit(ready.id,'PLACE MOCK ORDER'),/DISABLED_OR_EXPIRED/);assert.equal(h.mock.book.KR.length,2);
});
test('rows 19, 21: an order left Submitting by a crash, and two unclear orders of identical terms: never linked by guess; only their stock waits for you',async()=>{
  const h=rig();h.mock.fault('place-order','lost');const a=await h.send('KR','005930','Buy',10,70000);
  h.kr.writeOrder({...h.order('KR',a.id),status:'Submitting'});h.restart();
  await h.reconcile('KR');assert.equal(h.order('KR',a.id).status,'Submitting','no number: history does not settle it by guess');
  assert.equal(status(await h.send('KR','005930','Buy',10,70000)),'RECONCILIATION_REQUIRED');assert.equal(status(await h.send('KR','000660','Buy',1,200000)),'Accepted');
  // Two unclear orders of identical terms at KIS (yours and the app's): linking one names one number; the other stays.
  await assert.rejects(h.kr.linkUncertain(a.id,'999','LINK BROKER ORDER'),/BROKER_ORDER_MISMATCH/);
});
// ---- rows 27, 29
test('row 27: a revision of one order and a send of another are serialized (busy), neither lost',async()=>{
  const h=rig();const a=await h.send('KR','005930','Buy',10,70000);const [r,b]=await Promise.allSettled([h.kr.revise(a.id,{price:70100}),h.send('KR','000660','Buy',1,200000)]);
  assert.equal(r.status,'fulfilled');assert.equal(status(b.value),'KIS_ORDER_BUSY','the second waits its turn (the tracker retries)');
  assert.equal(status(await h.send('KR','000660','Buy',1,200000)),'Accepted');assert.equal(h.order('KR',a.id).currentPrice,70100);
});
test('row 29: an automatic opening order is refused when the daily loss cannot be checked; a sale still goes; the resting order stays',async()=>{
  const h=rig({kr:{holdings:[{symbol:'035420',name:'Naver',quantity:3,cost:200000,price:200000}]}});const a=await h.send('KR','005930','Buy',10,70000);
  h.kr.currentLoss=()=>({unavailable:true});
  assert.equal(status(await h.send('KR','000660','Buy',1,200000,{automatic:true})),'DAILY_LOSS_RESTRICTED');assert.equal(status(await h.send('KR','035420','Sell',1,200000,{automatic:true})),'Accepted');
  assert.equal(h.order('KR',a.id).status,'Accepted');
});
