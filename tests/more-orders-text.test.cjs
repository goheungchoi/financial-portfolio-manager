// M-6 part 2 (multi-order, artifacts/reviews/2026-11-16-multi-order/m6-plan.md section 3): the instruction part a review
// gets only when it may return several orders (context.ordersPerReview > 1), the text exactly as the planner cleared it
// (2026-11-17), its version and fingerprint pinned. At one order the text, version and fingerprint are today's.
const test=require('node:test');const assert=require('node:assert/strict');
const RI=require('../electron/review-instructions.cjs');const C=require('../electron/ai-client.cjs');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const CLEARED='context.ordersPerReview is the most orders this review may return. Put the first in the decision fields and the others in moreOrders, each a Buy or a Sell of a different stock with its own plan, execution and reversal. Where these instructions say one bounded trade, read up to ordersPerReview. Fewer orders, one order or Hold are complete answers, and each order needs the same evidence as a single one. The app checks each order on its own and holds back any that fails, with its reason; the others go on to be sent. An order for a stock that already has an open order is held back. Closing orders (sales, repayments and covers) are sent first, then the others in your order; limits and cash are checked as each is sent, so a later order can be refused when earlier ones have used the room.';
test('the text, exactly as cleared; its versions and fingerprints pinned (never change a pinned entry)',()=>{
  assert.equal(RI.MORE_ORDERS_TEXT,CLEARED);
  assert.equal(RI.ORDERS_VERSION,'review 2026-11-25.5 orders');assert.equal(RI.PROPOSED_ORDERS_VERSION,'proposed 2026-11-25.3 orders');
  assert.equal(RI.fingerprint('current',{orders:true}),'ed412ea0edf116a2');assert.equal(RI.fingerprint('proposed',{orders:true}),'baefcb594987fc45');
  // The single-order fingerprints are the pinned ones (tests/instructions-version.test.cjs), not these.
  assert.equal(RI.fingerprint('current'),'1004c642ceabd60d');assert.equal(RI.fingerprint('proposed'),'4125be8df9bf2e10');
});
test('at one order: no part, today\'s version, and the text never mentions it',()=>{
  for(const ctx of [{},{ordersPerReview:1},{ordersPerReview:'3'}]){assert.ok(!RI.partsFor(ctx).includes('more-orders'),JSON.stringify(ctx));
    assert.equal(RI.record(ctx).version,'review 2026-11-25.5');assert.doesNotMatch(RI.setReviewText(RI.partsFor(ctx)),/ordersPerReview/);}
  assert.doesNotMatch(RI.REVIEW_ALL,/ordersPerReview/,'the size bound text is today\'s');
});
test('at several orders: the part comes last in both sets, and the record carries the orders version and fingerprint',()=>{
  const ctx={ordersPerReview:4,agentDesk:{}};const ids=RI.partsFor(ctx);assert.equal(ids.at(-1),'more-orders');
  for(const set of ['current','proposed']){const text=RI.setReviewText(ids,set);assert.ok(text.endsWith('\n\n'+CLEARED),set);assert.ok(RI.reviewBlocks(ids,set).parts.endsWith(CLEARED),set);}
  assert.deepEqual(RI.record(ctx),{version:'review 2026-11-25.5 orders',fingerprint:'ed412ea0edf116a2',parts:ids});
  assert.equal(RI.record(ctx,'proposed').version,'proposed 2026-11-25.3 orders');
  assert.equal(C.instructions(ctx).version,'review 2026-11-25.5 orders','the review record\'s instructions');
});
test('through the app: with n > 1 the context says it, the request carries the part, and the review records the orders version; at n = 1 none of it',async()=>{
  for(const n of [1,3]){const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});const h=appHarness({mock:m}).enable();const a=h.automation();a.ordersFor=()=>n;
    const seen=[];const provider=a.provider;a.provider={...provider,request:async(op,payload)=>{if(op==='decision')seen.push(payload);return provider.request(op,payload);}};
    await a.review('User request').catch(()=>{});const r=JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);assert.ok(seen.length);
    if(n===1){assert.ok(seen.every(p=>!('ordersPerReview' in p.context)));assert.equal(r.instructions.version,'review 2026-11-25.5');}
    else{assert.ok(seen.every(p=>p.context.ordersPerReview===3),'kept through compaction');assert.ok(RI.partsFor(seen[0].context).includes('more-orders'));assert.equal(r.instructions.version,'review 2026-11-25.5 orders');assert.ok(r.instructions.parts.includes('more-orders'));}}
});
