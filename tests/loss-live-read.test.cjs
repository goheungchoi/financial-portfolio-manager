// M-5 (b): the daily-loss breach is read live when an order is placed, as the late, unavailable and uncertain checks
// already were. Before, it was the value taken when the review started (context.emergency): a balance reading that
// reached the limit while the AI was deciding did not block the review's Buy. One rule for every order (the first and,
// from M-5, each further one).
const test=require('node:test');const assert=require('node:assert/strict');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
// The limit is reached after the review's context is assembled: when the AI's decision is logged.
const run=async(lossAction,decision)=>{const m=new MockKis({kr:{cash:10000000,holdings:[{symbol:'005930',quantity:10,price:70000}]},us:{cash:5000},prices:{'005930':70000}});const h=appHarness({mock:m}).enable();const a=h.automation({lossAction});
  let breached=false;const state=a.emergencyState.bind(a);a.emergencyState=()=>breached?{...state(),active:true,activeMarkets:['KR']}:state();
  const log=a.log.bind(a);a.log=(...x)=>{if(x[1]==='Agent'&&x[2]==='Decision')breached=true;return log(...x);};
  h.decide(decision);await a.review('User request').catch(()=>{});const r=JSON.parse(h.db.prepare('SELECT payload FROM reviews').get().payload);return {r,h};};
const buy={action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',plan:{stopPrice:60000}};
test('a breach reached while the AI decided blocks the review\'s Buy (read when the order is placed)',async()=>{
  const {r,h}=await run('stop',buy);assert.equal(r.proposalId,null,'no proposal');assert.match(r.executionNote,/^Guardrail: new buys are blocked after the daily loss limit/);
  assert.ok(h.logs.some(x=>x[2]==='Guardrail · buys blocked'));
});
test('a sale is not blocked by it; with "review more often, keep trading" a Buy is not blocked, as before',async()=>{
  assert.notEqual((await run('stop',{action:'Sell',symbol:'005930',quantity:1,credit:'none',loanDate:''})).r.proposalId,null,'the sale is proposed');
  assert.notEqual((await run('review',buy)).r.proposalId,null,'lossAction review: proposed');
});
