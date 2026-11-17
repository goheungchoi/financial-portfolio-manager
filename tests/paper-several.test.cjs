// M-3.4 (multi-order, m3-plan.md; matrix row 34 in its one-order-per-review form): the paper engine with an order resting.
// A later proposal (a later review, or a conditional order) is made after the earlier order's submission, so its version
// is current and it is submitted; its checks count the resting order's reservation. A proposal made before another order
// was submitted, filled or cancelled is refused PORTFOLIO_CHANGED (the account it was checked against changed), as today;
// the batch form (several proposals of one review) is Part B's.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PaperEngine}=require('../electron/paper-engine.cjs');
function paper(){let t=Date.now(),seq=1;const prices={'005930':50000,'000660':100000};const db=new DatabaseSync(':memory:');
  const p=new PaperEngine(db,[{symbol:'005930',name:'A',price:50000},{symbol:'000660',name:'B',price:100000}],()=>Object.entries(prices).map(([symbol,price])=>({symbol,price,sequence:seq,timestamp:t,volume:1,stale:false})),()=>t);
  p.setPaused(false);return {p,prices,next:()=>{seq++;t+=1000;}};}
test('row 34 (one order per review): a proposal made while another paper order rests is submitted, and counts the resting reservation',()=>{
  const {p}=paper();const a=p.submit(p.propose({symbol:'005930',side:'Buy',quantity:10}).id);assert.equal(a.status,'Pending');
  const b=p.submit(p.propose({symbol:'000660',side:'Buy',quantity:5}).id);assert.equal(b.status,'Pending','a later proposal is current');
  const all=p.orders().filter(o=>o.status==='Pending').length;assert.equal(all,2,'both rest');
  // The resting buys' reservations count: a buy the cash would allow alone but not beside them is refused.
  const c=p.submit(p.propose({symbol:'000660',side:'Buy',quantity:90}).id);assert.equal(c.status,'Rejected');assert.notEqual(c.reason,'PORTFOLIO_CHANGED');
});
test('row 34: a proposal made before another order was submitted is refused PORTFOLIO_CHANGED (as today), and a new one is then submitted',()=>{
  const {p}=paper();const early=p.propose({symbol:'000660',side:'Buy',quantity:5});p.submit(p.propose({symbol:'005930',side:'Buy',quantity:10}).id);
  assert.deepEqual(p.submit(early.id),{status:'Rejected',reason:'PORTFOLIO_CHANGED'});assert.equal(p.submit(p.propose({symbol:'000660',side:'Buy',quantity:5}).id).status,'Pending');
});
