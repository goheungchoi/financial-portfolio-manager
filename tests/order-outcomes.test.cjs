// M-5 (d) (multi-order, artifacts/reviews/2026-11-16-multi-order/m5-plan.md section 5; the user's "Place the others"):
// each order's outcome in a batch is classed. A refusal of this order is that order only; a 'stop' outcome leaves the
// rest not sent (the orders before stand); an error the app does not know stops the rest and fails the review.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const O=require('../electron/order-outcomes.cjs');const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
test('every code the order path can produce is in one class: a new code forces a choice',()=>{
  const files=['live-engine','kis-client','kis-overseas','kis-worker','kis-service','credit-paths','funding-ledger','paper-engine','exposure','broker-open-orders'];
  const codes=new Set();for(const f of files){const s=fs.readFileSync(path.join(__dirname,'..','electron',f+'.cjs'),'utf8');for(const m of s.matchAll(/(?:new (?:Error|KisError)|fail)\(\s*'([A-Z][A-Z0-9_]{2,})'/g))codes.add(m[1]);}
  // Codes returned as values or thrown from a variable: notSendable and lossRestriction (live-engine), the worker's
  // expired ticket, and the batch's own checks.
  for(const c of ['DISABLED_OR_EXPIRED','ACCOUNT_CHANGED','LIMIT_CHANGED','DAILY_LOSS_RESTRICTED','TICKET_EXPIRED','STALE_DECISION','AUTO_TRADING_STOPPED','BATCH_LIMIT'])codes.add(c);
  assert.ok(codes.size>60,`${codes.size} codes collected`);
  assert.deepEqual([...codes].filter(c=>O.classOf(c)==='unknown'),[],'name each in ORDER or STOP (electron/order-outcomes.cjs)');
  assert.deepEqual([...O.ORDER].filter(c=>O.STOP.has(c)),[],'never both');
  assert.equal(O.classOf('SOMETHING_NEW'),'unknown');assert.equal(O.codeOf(new Error('boom: lowercase')),null);
});
// A batch of three Korean buys sent in this sequence (all openings): 005930 (the first order), 035720, 990060. The second
// order's broker preparation fails with the code given.
const three=async({prepare=null,place=null}={})=>{const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000,'035720':50000,'990060':100000}});
  if(prepare)m.fault('prepare-order',null).fault('prepare-order',prepare);if(place)m.fault('place-order',null).fault('place-order',place);
  const h=appHarness({mock:m}).enable();const a=h.automation();const reviews=[];a.requestReview=(...x)=>reviews.push(x);
  const o=(item,symbol)=>({item,action:'Buy',symbol,quantity:1,credit:'none',loanDate:''});
  h.decide({...o(undefined,'005930'),explanation:'three',moreOrders:[o(1,'035720'),o(2,'990060')],moreWithheld:[]});let error=null;await a.review('User request').catch(e=>{error=e;});
  return {m,h,a,reviews,error,sent:m.book.KR.filter(r=>r.kind==='order').map(r=>r.symbol)};};
test('a refusal of order 2 (every code of the ORDER class): that order only; orders 1 and 3 are sent',async()=>{
  for(const code of O.ORDER){const {sent,h,a,error}=await three({prepare:{fail:code}});
    assert.deepEqual(sent,['005930','990060'],code);assert.equal(error,null,code);assert.notEqual(a.lastError,'REVIEW_FAILED',code);
    // Thrown from the send, the order is named as not sent. PRODUCT_ and EXTENDED_APPROVAL_REQUIRED are turned by the
    // engine's autoSubmit into the order awaiting approval, returned: still this order only.
    if(!['PRODUCT_APPROVAL_REQUIRED','EXTENDED_APPROVAL_REQUIRED'].includes(code))assert.ok(h.logs.some(x=>x[2]==='Order not sent'&&x[3]===`Not sent: Buy 1 035720: ${code}.`),code);}
});
test('a STOP outcome on order 2 (every code of the class): order 1 stands, order 3 is not sent; the review is not failed; one follow-up review',async()=>{
  for(const code of O.STOP){const {sent,h,reviews,error}=await three({prepare:{fail:code}});
    assert.deepEqual(sent,['005930'],code);assert.equal(error,null,code);
    assert.ok(h.logs.some(x=>x[2]==='Order not sent · batch'&&x[3]===`Not sent: Buy 1 990060: an earlier order in this review failed (${code}).`),code);
    assert.equal(reviews.length,1,code);assert.match(reviews[0][1],new RegExp(`Buy 035720 \\(${code}\\); Buy 990060`),code);}
});
test('an error the app does not know on order 2: order 1 stands, order 3 is not sent, and the review fails with every outcome',async()=>{
  const {sent,a,error}=await three({prepare:{fail:'SOMETHING_NEW'}});assert.deepEqual(sent,['005930']);
  assert.equal(a.lastError,'REVIEW_FAILED');
  const {a:b}=await three({prepare:{fail:'BROKER_UNAVAILABLE'}});assert.notEqual(b.lastError,'REVIEW_FAILED','a known stop does not fail the review');
});
test('order 2 unclear (rule U): orders 3.. still sent; order 2 counts in full in the open-order sums',async()=>{
  const {sent,h}=await three({place:'lost'});assert.deepEqual(sent,['005930','035720','990060'],'the lost reply left an order at KIS; the third was still sent');
  const unclear=h.kr.orders().find(o=>o.symbol==='035720');assert.equal(unclear.status,'Uncertain');
  const open=h.kr.pendingOrders(null,null).find(o=>o.symbol==='035720');assert.equal(open.quantity,1,'counted in full');assert.equal(open.fullQuantity,1);
});
test('checked before each order: the saved settings changed during the batch stops the rest',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000,'035720':50000}});const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};
  // A saved change lands right after order 1 reached KIS.
  const place=m.place.bind(m);m.place=(...x)=>{const r=place(...x);a.revision++;return r;};
  h.decide({action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'two',moreOrders:[{item:1,action:'Buy',symbol:'035720',quantity:1,credit:'none',loanDate:''}],moreWithheld:[]});
  await a.review('User request').catch(()=>{});assert.deepEqual(m.book.KR.filter(r=>r.kind==='order').map(r=>r.symbol),['005930']);
  assert.ok(h.logs.some(x=>x[3]==='Not sent: Buy 1 035720: the account or saved settings changed during the batch.'));
});
