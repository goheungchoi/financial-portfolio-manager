// M-5 (e) and the M-5 report (multi-order, artifacts/reviews/2026-11-16-multi-order/m5-plan.md section 1): each of the
// first order's placement checks applied to a further order, in a batch of three through the app harness. The order the
// check refuses gets that check's note; the orders it does not concern are still sent. Rows 6 (the book), 11-05 (the
// cap, the submission outcomes) are also in order-batch.test.cjs and order-outcomes.test.cjs. Also the record's orders
// list and one pending decision per order kept for a closed market.
const test=require('node:test');const assert=require('node:assert/strict');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const PRICES={'005930':70000,'035720':50000,'000099':100000,'000660':200000};
const o=(item,symbol,extra={})=>({item,action:'Buy',symbol,quantity:1,credit:'none',loanDate:'',...extra});
// Three orders: 005930 (the first), then two further ones; none of them closing, so they go in this order.
const batch=async(second,{config={},cash=10000000,after=null,third=o(2,'000099')}={})=>{const m=new MockKis({kr:{cash,holdings:[{symbol:'000660',quantity:10,price:200000}]},us:{cash:5000},prices:{...PRICES}});
  const h=appHarness({mock:m}).enable();const a=h.automation(config);a.requestReview=()=>{};
  if(after){const place=m.place.bind(m);let n=0;m.place=(...x)=>{const r=place(...x);if(++n===1)after({m,h,a});return r;};}
  h.decide({...o(undefined,'005930'),explanation:'three',moreOrders:[second,...(third?[third]:[])],moreWithheld:[]});await a.review('User request').catch(()=>{});
  const r=JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);return {m,h,a,r,sent:m.book.KR.filter(x=>x.kind==='order').map(x=>`${x.side} ${x.symbol}`),note:i=>r.orders.find(x=>x.item===i)?.executionNote??null};};
test('1 the loss limit, read live: a breach after order 1 blocks the later openings; order 1 stands',async()=>{
  const {sent,note}=await batch(o(1,'035720'),{config:{lossAction:'stop'},after:({a})=>{const s=a.emergencyState.bind(a);a.emergencyState=()=>({...s(),active:true,activeMarkets:['KR']});}});
  assert.deepEqual(sent,['Buy 005930']);assert.match(note(1),/^Guardrail: new buys are blocked after the daily loss limit/);assert.match(note(2),/^Guardrail: new buys are blocked/);
});
test('2 a credit path not executable: that order is a draft; the others are sent',async()=>{
  const {sent,note}=await batch({item:1,action:'Sell',symbol:'035720',quantity:1,credit:'short',loanDate:''});
  assert.deepEqual(sent,['Buy 005930','Buy 000099']);assert.match(note(1),/^Draft only: /);
});
test('3 execution off for its market (the engine stopped after order 1): the later orders in it are not proposed',async()=>{
  const {sent,note}=await batch(o(1,'035720'),{after:({h})=>{h.kr.enabled=false;}});
  assert.deepEqual(sent,['Buy 005930']);assert.match(note(1),/trading session is off|KIS_TRADING_DISABLED/);
});
test('4 the market closed: each order is its own pending decision; a later review placing one closes that one as carried out',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{...PRICES}});m.sessionOpen.KR=false;const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};
  h.decide({...o(undefined,'005930'),explanation:'three',moreOrders:[o(1,'035720'),o(2,'000099')],moreWithheld:[]});await a.review('User request').catch(()=>{});
  const r=JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);assert.deepEqual(m.book.KR,[],'nothing placed');
  assert.ok(r.orders.every(x=>/market is closed: Buy .* is kept as a pending decision/.test(x.executionNote)));
  const rows=()=>h.db.prepare('SELECT payload FROM pending_decisions').all().map(x=>JSON.parse(x.payload));
  assert.deepEqual(rows().map(p=>[p.symbol,p.action,p.status]).sort(),[['000099','Buy','pending'],['005930','Buy','pending'],['035720','Buy','pending']]);
  // The market opens; a review places Buy 000099 alone as its first order: that row is carried out, the other two reassessed.
  m.sessionOpen.KR=true;h.decide({...o(undefined,'000099'),explanation:'one'});await a.review('User request').catch(()=>{});
  assert.deepEqual(Object.fromEntries(rows().map(p=>[p.symbol,p.status])),{'005930':'reassessed','035720':'reassessed','000099':'carried-out'});
});
test('4b the market closed after order 1 (the broker refuses): the later orders are refused, each its own; order 1 stands',async()=>{
  const {sent,r}=await batch(o(1,'035720'),{after:({m})=>{m.sessionOpen.KR=false;}});
  assert.deepEqual(sent,['Buy 005930']);assert.deepEqual(r.orders.map(x=>x.outcome.code),['SESSION_CLOSED','SESSION_CLOSED']);
});
test('a further order opposite a pending decision revises it, as the first order would',async()=>{
  const m=new MockKis({kr:{cash:10000000,holdings:[{symbol:'035720',quantity:5,price:50000}]},us:{cash:5000},prices:{...PRICES}});m.sessionOpen.KR=false;const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};
  h.decide({...o(undefined,'035720'),explanation:'buy'});await a.review('User request').catch(()=>{});
  h.decide({...o(undefined,'005930'),explanation:'two',moreOrders:[{item:1,action:'Sell',symbol:'035720',quantity:1,credit:'none',loanDate:''}],moreWithheld:[]});await a.review('User request').catch(()=>{});
  const rows=h.db.prepare('SELECT payload FROM pending_decisions').all().map(x=>JSON.parse(x.payload)).filter(p=>p.symbol==='035720');
  assert.deepEqual(rows.map(p=>[p.action,p.status]).sort(),[['Buy','revised'],['Sell','pending']]);
});
test('a further order placed closes its own pending decision as carried out',async()=>{
  const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{...PRICES}});m.sessionOpen.KR=false;const h=appHarness({mock:m}).enable();const a=h.automation();a.requestReview=()=>{};
  h.decide({...o(undefined,'035720'),explanation:'one'});await a.review('User request').catch(()=>{});
  m.sessionOpen.KR=true;h.decide({...o(undefined,'005930'),explanation:'two',moreOrders:[o(1,'035720')],moreWithheld:[]});await a.review('User request').catch(()=>{});
  assert.equal(JSON.parse(h.db.prepare('SELECT payload FROM pending_decisions').get().payload).status,'carried-out');
});
test('5 execution bounds the app cannot honour, and a restriction already stopping the order: that order only',async()=>{
  {const {sent,note}=await batch(o(1,'035720',{execution:{bound:null,cancelAfter:'',cancelIf:[],invalid:['bound -1']}}));
    assert.deepEqual(sent,['Buy 005930','Buy 000099']);assert.match(note(1),/^Execution withheld: Buy 035720 came with restrictions the app cannot honour \(bound -1\)/);}
  // A cancel condition already met (rows 5 and 7 are one function, restrictionStop, before and after pricing).
  {const {sent,note}=await batch(o(1,'035720',{execution:{bound:null,cancelAfter:'',cancelIf:[{expr:'price("035720")',op:'>',value:1}]}}));
    assert.deepEqual(sent,['Buy 005930','Buy 000099']);assert.match(note(1),/^Execution withheld: Buy 035720: a cancel condition was met: /);}
});
test('9 the lot check for a closing order: a sale larger than the shares free is not proposed; the others are sent',async()=>{
  const {sent,note}=await batch({item:1,action:'Sell',symbol:'000660',quantity:20,credit:'none',loanDate:''});
  assert.deepEqual(sent,['Buy 005930','Buy 000099']);assert.match(note(1),/^Not proposed: Sell 20 000660 is more than the shares it can close: 10 free in its lot/);
});
test('10 the engine\'s checks with the reservations of the orders before: a buy the remaining cash cannot cover is refused; the next is sent',async()=>{
  // 1,000,000 KRW: order 1 (70,000) fits, order 2 (100 x 50,000) does not, order 3 (100,000) does.
  const {sent,note}=await batch(o(1,'035720',{quantity:100}),{cash:1000000});
  assert.deepEqual(sent,['Buy 005930','Buy 000099']);assert.match(note(1),/INSUFFICIENT_CAPACITY/);
});
test('11 the daily automatic-order cap: one slot each; past it the order waits for approval, the record says so',async()=>{
  const {sent,note,r}=await batch(o(1,'035720'),{config:{maxAutoOrdersPerDay:2}});
  assert.deepEqual(sent,['Buy 005930','Buy 035720']);assert.match(note(2),/^Guardrail: the daily limit of 2 automatic orders is reached\. Proposal awaits manual approval\./);
  assert.ok(r.orders.find(x=>x.item===2).proposalId,'proposed, awaiting approval');
});
test('the record\'s orders list: one row per further order, in item order, with its proposal, order, note and outcome; a single order has none',async()=>{
  const {r}=await batch(o(1,'035720'));
  // orderOutcome (M-6 part 3): the engine's status and reason of each order, as for the first.
  assert.deepEqual(r.orders.map(x=>Object.keys(x).sort()),[['action','executionNote','item','orderId','orderOutcome','outcome','proposalId','quantity','symbol'],['action','executionNote','item','orderId','orderOutcome','outcome','proposalId','quantity','symbol']]);
  assert.ok(r.orders.every(x=>x.orderId&&x.proposalId));assert.ok(r.orderId,'the first keeps its own');
});
