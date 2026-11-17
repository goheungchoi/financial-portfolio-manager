// M-7 (c) (multi-order, m7-plan.md section 2, as ruled): the dry run and replay ask for the same further orders as a
// review. The dry run computes n as a review does (ordersFor, with its own model); a replay asks what the saved review
// asked (its context's ordersPerReview), never more; replay's version is the context's; scoring is order by order,
// matched by stock (a stock one side did not order counts 0 for it).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const R=require('../electron/replay.cjs');
const days=(n,start)=>{const out=[];const t=Date.parse(start+'T00:00:00Z');for(let i=0;i<n;i++)out.push(new Date(t+i*86400000).toISOString().slice(0,10));return out;};
test('replay asks what the saved review asked: its ordersPerReview, never more; 1 for a single-order context',()=>{
  assert.equal(R.replayOrders({ordersPerReview:3}),3);assert.equal(R.replayOrders({}),1);assert.equal(R.replayOrders({ordersPerReview:1}),1);assert.equal(R.replayOrders(null),1);
});
test('replay\'s version is the context\'s: a several-order context reports the orders version',()=>{
  const t=R.textOf({context:{universe:[],ordersPerReview:3}},{instructions:'x'});assert.equal(t.instructions.baseline.version,'review 2026-11-17 orders');assert.ok(t.instructions.baseline.parts.includes('more-orders'));
  assert.equal(R.textOf({context:{universe:[]}},{instructions:'x'}).instructions.baseline.version,'review 2026-11-15');
});
test('scoring order by order: each order with its own stock; the sum; a stock not ordered counts 0; waiting if any order waits',()=>{
  const d=days(12,'2026-10-01');const up=d.map((date,i)=>({date,close:100+i})),flat=d.map(date=>({date,close:100})),bench=d.map(date=>({date,close:1000}));
  const closes=s=>s==='UP'?up:s==='FLAT'?flat:[],benchOf=()=>bench;
  const one=R.outcomeAll({action:'Buy',symbol:'UP',quantity:1},'2026-10-01',closes,benchOf);assert.deepEqual(one,R.outcome({action:'Buy',symbol:'UP'},'2026-10-01',up,bench),'a single decision scores as before');
  const both=R.outcomeAll({action:'Buy',symbol:'UP',quantity:1,moreOrders:[{action:'Sell',symbol:'FLAT',quantity:1}]},'2026-10-01',closes,benchOf);
  assert.equal(both.excessPct,R.outcome({action:'Buy',symbol:'UP'},'2026-10-01',up,bench).excessPct+R.outcome({action:'Sell',symbol:'FLAT'},'2026-10-01',flat,bench).excessPct);
  assert.deepEqual(R.outcomeAll({action:'Hold',symbol:'',moreOrders:[]},'2026-10-01',closes,benchOf),{excessPct:0,basis:'hold'});
  assert.equal(R.outcomeAll({action:'Hold',symbol:'',moreOrders:[{action:'Buy',symbol:'NONE',quantity:1}]},'2026-10-01',closes,benchOf).excessPct,null,'an order without prices yet: waiting');
  // brief carries the further orders, so "differs" counts a difference in any order.
  assert.deepEqual(R.brief({action:'Buy',symbol:'A',quantity:1,moreOrders:[{action:'Sell',symbol:'B',quantity:2,plan:{}}]}),{action:'Buy',symbol:'A',quantity:1,more:[{action:'Sell',symbol:'B',quantity:2}]});
  assert.deepEqual(R.brief({action:'Buy',symbol:'A',quantity:1}),{action:'Buy',symbol:'A',quantity:1},'today');
});
// The app: a review whose context asked for 3 orders, then its replay and a dry run.
const rig=()=>{const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot}));const calls=[];
  const provider={request:async(op,payload)=>{calls.push(payload);return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'},usage:{inputTokens:10,outputTokens:2},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  const d=days(30,'2026-09-25');a.series={closes:()=>d.map((date,i)=>({date,close:100+i})),ensure:async()=>{}};a.indexCloses=()=>({KOSPI:d.map(date=>({date,close:1000}))});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',guidelines:'Grow.'});return {a,calls};};
test('a replay of a review that asked for 3 orders asks for 2 further orders again, with the context\'s part; a single-order one asks for none',async()=>{
  for(const n of [3,1]){const {a,calls}=rig();a.ordersFor=()=>n;await a.review();const saved=a.replays.context(a.getState().reviews[0].id);
    assert.equal(saved.ordersPerReview,n>1?n:undefined,'the saved context says what the review asked');
    a.ordersFor=()=>{throw new Error('a replay never asks ordersFor')};const before=calls.length;await a.replay({instructions:'Be careful.',limit:1});
    const replayed=calls.slice(before);assert.equal(replayed.length,2,'baseline and variant');
    for(const p of replayed)assert.equal(p.options.moreOrders,n>1?n-1:undefined,`n=${n}`);}
});
test('a dry run asks for further orders as a review would (ordersFor with its own model); none at n = 1',async()=>{
  for(const n of [3,1]){const {a,calls}=rig();let asked=null;a.ordersFor=m=>{asked=m;return n;};await a.dryRun('review').catch(()=>{});
    const sent=calls.at(-1);assert.ok(sent,'the dry run sent a request');assert.equal(asked.openaiModel,'gpt-6-sol','its own model');
    assert.equal(sent.options.moreOrders,n>1?n-1:undefined);assert.equal(sent.context.ordersPerReview,n>1?n:undefined);}
});
