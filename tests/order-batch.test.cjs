// M-5 (c) (multi-order, artifacts/reviews/2026-11-16-multi-order/m5-plan.md section 3): a review's orders sent as one
// batch. Closing orders first, in the AI's order among themselves, then openings in the AI's order; each order's book
// read one order ahead of its send (one read per order in the usual case; read again when it is no longer usable at
// pricing); an order with no book is that order's own "not sent"; the batch limit; one follow-up review.
const test=require('node:test');const assert=require('node:assert/strict');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const order=(item,action,symbol)=>({item,action,symbol,quantity:1,credit:'none',loanDate:''});
const setup=(prices={'005930':70000,'000660':200000,'035720':50000,'990060':100000})=>{
  const m=new MockKis({kr:{cash:10000000,holdings:[{symbol:'000660',quantity:10,price:200000},{symbol:'990060',quantity:10,price:100000}]},us:{cash:5000},prices});
  const h=appHarness({mock:m}).enable();const a=h.automation();const events=[];const book=a.orderBook;a.orderBook=async s=>{events.push(['book',s,m.book.KR.length]);return book(s);};
  const reviews=[];a.requestReview=(...x)=>reviews.push(x);return {m,h,a,events,reviews};};
const run=async(h,first,more)=>{h.decide({...first,explanation:'batch',moreOrders:more,moreWithheld:[]});await h.a.review('User request').catch(e=>{h.error=e;});return JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);};
const sent=m=>m.book.KR.filter(r=>r.kind==='order').map(r=>`${r.side} ${r.symbol}`);
test('the sequence: closing orders first in the AI\'s order, then openings in the AI\'s order',async()=>{
  const {m,h}=setup();const r=await run(h,order(undefined,'Buy','005930'),[order(1,'Sell','000660'),order(2,'Buy','035720'),order(3,'Sell','990060')]);
  assert.deepEqual(sent(m),['Sell 000660','Sell 990060','Buy 005930','Buy 035720']);
  assert.ok(r.proposalId&&r.orderId,'the first order keeps its own fields in the record');
});
test('books one order ahead: each read once, the next one requested before this one is sent',async()=>{
  const {m,h,events}=setup();await run(h,order(undefined,'Buy','005930'),[order(1,'Buy','035720'),order(2,'Sell','000660')]);
  const books=events.filter(e=>e[0]==='book');assert.deepEqual(books.map(e=>e[1]),['000660','005930','035720'],'one read per order, in the send sequence');
  // The book of the order sent second is requested before the first is sent; the third before the second.
  assert.deepEqual(books.map(e=>e[2]),[0,0,1]);assert.equal(sent(m).length,3);
});
test('a book no longer usable when its order is priced is read again; a book that never arrives is that order\'s own "not sent"',async()=>{
  {const {m,h,a,events}=setup();const old=a.orderBook;let first=true;
    a.orderBook=async s=>{const r=await old(s);if(s==='035720'&&first){first=false;return {...r,retrievedAt:Date.now()-9999};}return r;};
    // The book was read while the order before was placed; time passes before this order is priced.
    const eb=a.executionBounds.bind(a);a.executionBounds=(d,...x)=>{if(d.symbol==='035720'){const t=Date.now();while(Date.now()-t<20);}return eb(d,...x);};
    await run(h,order(undefined,'Buy','005930'),[order(1,'Buy','035720')]);
    assert.equal(events.filter(e=>e[0]==='book'&&e[1]==='035720').length,2,'read again at pricing');assert.deepEqual(sent(m),['Buy 005930','Buy 035720']);}
  {const {m,h,reviews}=setup({'005930':70000,'000660':200000,'035720':0});
    // The order with no book is in the middle of the sequence (Sell 000660, Buy 035720, Buy 005930).
    const r=await run(h,order(undefined,'Buy','035720'),[order(1,'Buy','005930'),order(2,'Sell','000660')]);
    assert.deepEqual(sent(m),['Sell 000660','Buy 005930'],'the others are sent, the one after it too');assert.equal(r.orderId,null);assert.match(r.executionNote,/^No usable order book for 035720 for a minute/);
    assert.equal(reviews.length,1,'one follow-up review');assert.match(reviews[0][1],/Buy 035720 \(no order book/);}
});
test('the batch limit: an order not started within the limit is not sent, nor the rest; one follow-up review',async()=>{
  const {m,h,a,reviews}=setup();a.batchLimitMs=10;
  const eb=a.executionBounds.bind(a);a.executionBounds=(d,...x)=>{if(d.symbol==='000660'){const t=Date.now();while(Date.now()-t<30);}return eb(d,...x);};
  const r=await run(h,order(undefined,'Buy','005930'),[order(1,'Sell','000660'),order(2,'Buy','035720')]);
  assert.deepEqual(sent(m),['Sell 000660'],'the first in sequence started in time');
  assert.equal(r.proposalId,null);assert.match(r.executionNote,/^Not sent: Buy 1 005930: the batch limit \(5 minutes from the decision\) passed\.$/);
  assert.ok(h.logs.filter(x=>x[2]==='Order not sent · batch').length===2);
  assert.equal(reviews.length,1);assert.match(reviews[0][1],/Buy 005930 \(batch limit\); Buy 035720 \(batch limit\)/);
});
test('a single order goes as before: priced by placementPrice, no batch',async()=>{
  const {m,h,a,events}=setup();let batch=0;const pb=a.placeBatch.bind(a);a.placeBatch=(...x)=>{batch++;return pb(...x);};
  h.decide({...order(undefined,'Buy','005930'),explanation:'one'});await a.review('User request');assert.equal(batch,0);assert.deepEqual(sent(m),['Buy 005930']);assert.equal(events.length,1);
});
