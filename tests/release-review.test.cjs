// Release review of 1.5.48-stage5.1 (2026-11-05): regressions for its findings 1-4 (finding 5 is in alert-trial.test.cjs).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const DAY=86400000,MIN=60000;

// 1. The reversal rule does not depend on how the prompt was compressed.
const {shape}=require('../electron/review-context.cjs');const {AiClient,validateDecision}=require('../electron/ai-client.cjs');const PM=require('../electron/position-memory.cjs');
const now=Date.parse('2026-11-05T02:00:00Z');
const memory=[{symbol:'000270',holding:0,lastMaterial:'exit',lastExit:{decisionId:'sale',effect:'CLOSE_LONG',filledAt:new Date(now-DAY).toISOString(),decidedAt:new Date(now-DAY).toISOString(),fillPrice:88800,rationale:'Wait for margin recovery. '+'detail '.repeat(800)}},
  {symbol:'028050',holding:3,lastMaterial:'entry',lastEntry:{decisionId:'buy',effect:'OPEN_LONG',filledAt:new Date(now-10*DAY).toISOString(),fillPrice:60300,rationale:'Contracts. '+'more '.repeat(300)}}];
const plan={horizon:'swing',thesis:'margin recovery',invalidation:'margin falls',stopPrice:84000,targetPrice:null,horizonDays:60,confidence:'medium',portfolioImpact:{weightBeforePct:0,weightAfterPct:6.5,related:[],relatedBeforePct:0,relatedAfterPct:6.5,equityReliable:true,why:'small position'},evidence:[{claim:'profit increased',source:'release',verified:true}],valuation:null,uncertainty:null};
const buy={action:'Buy',symbol:'000270',quantity:1,credit:'none',loanDate:'',explanation:'Buy again',reversal:null,plan,complexity:{score:10,reason:'r'},strategyCheck:[],execution:null};
const context={environment:'kis',universe:[{symbol:'000270'},{symbol:'028050'}],quotes:[{symbol:'000270',price:95100}],positions:{'028050':{quantity:3}},positionMemory:memory,previousReview:{action:'Hold'}};
async function decide(ctx,options){const reply={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(buy)}]}],usage:{input_tokens:1,output_tokens:1}};
  const c=new AiClient('k'.repeat(20),async()=>({ok:true,status:200,text:async()=>JSON.stringify(reply),headers:new Map()}));return c.decide(ctx,options);}
test('finding 1: the same unexplained re-entry is held back at every compression tier, validated against the full memory',async()=>{
  const tiers=[70000,4000,600].map(limit=>shape(context,{limit}));assert.ok(tiers.some(t=>t.steps.some(s=>s.section==='positionMemory'&&s.kind==='referenced')),'one tier makes position memory a reference');
  for(const t of tiers){const r=await decide(t.context,{research:false,validation:{positionMemory:memory,quotes:context.quotes}});assert.equal(r.decision.action,'Hold');assert.equal(r.decision.withheld.kind,'reversal');}
  // Continuations and repair rounds carry the same snapshot.
  const r=await decide(tiers[2].context,{research:true,continuation:[{role:'user',content:'x'}],validation:{positionMemory:memory,quotes:context.quotes}});assert.equal(r.decision.action,'Hold');
});
test('finding 1: malformed validation state is an explicit failure, never "no earlier trade"',async()=>{
  const ref=shape(context,{limit:600}).context;assert.ok(!Array.isArray(ref.positionMemory));
  await assert.rejects(decide(ref,{research:false}),/VALIDATION_STATE_INVALID/,'the prompt’s reference is not used as validation state');
  assert.throws(()=>validateDecision(buy,['000270'],{requirePlan:true,memory:ref.positionMemory,now}),/VALIDATION_STATE_INVALID/);assert.throws(()=>PM.enforce(buy,{reference:'x'}),/VALIDATION_STATE_INVALID/);
});
test('finding 1: the execution boundary holds back the same decision; reductions and holdings pass',()=>{
  const held=PM.enforce(buy,memory,{price:95100,now});assert.equal(held.action,'Hold');assert.equal(held.withheld.atBoundary,true);
  assert.equal(PM.enforce({...buy,action:'Sell',symbol:'028050',plan:null},memory,{now}).action,'Sell','a reduction is never held back');
  assert.equal(PM.enforce({...buy,symbol:'028050'},memory,{now}).action,'Buy','adding to a holding after its entry is no reversal');
  assert.equal(PM.enforce(buy,[],{now}).action,'Buy','no recorded exit');
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');
  assert.ok(src.includes("require('./position-memory.cjs').enforce(result.decision,context.positionMemory??[]"),'the review applies it before execution');
  for(const s of ['options={...options,...modelConfig,validation};','validation:dryValidation};','...(validation?{validation}:{})'])assert.ok(src.includes(s),`every request carries the snapshot: ${s}`);
});

// 2. One settlement movement is used once.
const {InFlight}=require('../electron/valuation.cjs');
function track(){let t=1e12;const db=new DatabaseSync(':memory:');let f=new InFlight(db,()=>t);return {see:(us,orders=[])=>{const r=f.observe('a',{us,orders,fx:1300});t+=1000;return r;},restart:()=>{f=new InFlight(db,()=>t);}};}
const A={id:'A',side:'Buy',filled:1,fillPrice:100},B={id:'B',side:'Buy',filled:1,fillPrice:100},C={id:'C',side:'Buy',filled:1,fillPrice:60},S={id:'S',side:'Sell',filled:1,fillPrice:100};
test('finding 2: one cash movement settles fills once, only the one set that fits; what it does not match stays open',()=>{
  // Strict A5 (stage 2b S2): two $100 buys and a $100 settlement fit two sets, so nothing is settled; a $200 one fits only both.
  let x=track();x.see({cash:500});x.see({cash:500},[A,B]);assert.equal(x.see({cash:400},[A,B]).buysUSD,200,'two $100 buys, one $100 settlement: A or B, so neither');assert.equal(x.see({cash:300},[A,B]).buysUSD,200,'nor at the second');
  x=track();x.see({cash:500});x.see({cash:500},[A,B]);assert.equal(x.see({cash:300},[A,B]).buysUSD,0,'$200 fits only {A, B}');
  x=track();x.see({cash:500});x.see({cash:500},[A,C]);assert.equal(x.see({cash:420},[A,C]).buysUSD,160,'$80 matches no run of fills: nothing settled');assert.equal(x.see({cash:320},[A,C]).buysUSD,60,'then $100: the older fill');
  x=track();x.see({cash:500});x.see({cash:500},[A,S]);assert.deepEqual([x.see({cash:500},[A,S])].map(r=>[r.buysUSD,r.sellsUSD])[0],[100,100],'a buy and a sale netting to zero stay open');
  assert.deepEqual([x.see({cash:400},[A,S])].map(r=>[r.buysUSD,r.sellsUSD])[0],[100,100],'a movement while both sides are open cannot be divided');
});
test('finding 2: an old reported total is no evidence; a coincident withdrawal settles nothing; partial fills; restart between legs',()=>{
  let x=track();x.see({cash:500,unsettled:{buyKRW:130000}});assert.equal(x.see({cash:500,unsettled:{buyKRW:130000}},[A]).buysUSD,100,'$100 reported before the buy is not its settlement');
  assert.equal(x.see({cash:500,unsettled:{buyKRW:260000}},[A]).buysUSD,0,'a rise of $100 is');
  x=track();x.see({cash:1500});x.see({cash:1500},[A]);assert.equal(x.see({cash:500},[A]).buysUSD,100,'a $1,000 fall is not a $100 settlement');
  x=track();x.see({cash:500});const half={id:'P',side:'Buy',filled:1,fillPrice:100};x.see({cash:500},[half]);const full={...half,filled:2,fillPrice:101};assert.equal(x.see({cash:500},[full]).buysUSD,202,'two shares averaging $101 are $202 in all (the earlier expectation of $201 took the new share at the new average)');
  x=track();x.see({cash:500});x.see({cash:500},[A,C]);x.see({cash:400},[A,C]);x.restart();assert.equal(x.see({cash:400},[A,C]).buysUSD,60,'after a restart the remainder is kept');assert.equal(x.see({cash:340},[A,C]).buysUSD,0);
});

// 3. A flow belongs to the day it moved, not the day it was recorded.
const {PerformanceHistory}=require('../electron/performance.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const loss=(flows,{baseline=1000000,equity=1000000}={})=>LiveEngine.prototype.lossOf.call({flows:()=>flows},{baseline,baselineHigh:baseline,valuation:'broker-total',lossLimit:{mode:'amount',value:30000}},{reportedTotal:equity});
test('finding 3: an older deposit or withdrawal entered today is already in the baseline; it is no loss',()=>{
  const at=Date.parse('2026-11-05T02:00:00Z');const p=new PerformanceHistory(new DatabaseSync(':memory:'),()=>at);const since=at-3600000;
  p.addFlow('a',{day:'2026-11-03',market:'KR',amount:500000,note:'old deposit'});p.addFlow('a',{day:'2026-11-04',market:'KR',amount:-200000,note:'old withdrawal'});
  const f=p.flowsSince('a','KR',since);assert.equal(f.confirmed,0);assert.equal(f.uncertain.confirmed,0);const l=loss(f);assert.equal(l.loss,0);assert.equal(l.breached,false);
  // A deposit the detector saw before the baseline reading, confirmed today: still before the baseline.
  p.addFlow('a',{day:'2026-11-05',market:'KR',amount:300000,detected:true,occurredAfter:since-2*3600000,occurredBy:since-60000,note:'detected'});const d=p.flows('a').find(x=>x.detected);p.confirmFlow('a',d.id);
  assert.equal(p.flowsSince('a','KR',since).confirmed,0,'confirmation does not move when it happened');
  // One that moved after the baseline counts, and removing it takes it out again.
  const after=p.addFlow('a',{day:'2026-11-05',market:'KR',amount:100000,occurredAfter:since+60000,occurredBy:since+120000,note:'later'});assert.equal(p.flowsSince('a','KR',since).confirmed,100000);assert.equal(loss(p.flowsSince('a','KR',since),{equity:1100000}).loss,0);
  p.removeFlow('a',after.id);assert.equal(p.flowsSince('a','KR',since).confirmed,0);
});
test('finding 3: a same-day entry with only a date is a scenario, not an adjustment; a U.S. session across Korean midnight',()=>{
  const at=Date.parse('2026-11-05T02:00:00Z');const p=new PerformanceHistory(new DatabaseSync(':memory:'),()=>at);const since=Date.parse('2026-11-05T00:10:00Z');
  p.addFlow('a',{day:'2026-11-05',market:'KR',amount:-500000,note:'withdrawal today, time unknown'});const f=p.flowsSince('a','KR',since);assert.equal(f.confirmed,0);assert.equal(f.uncertain.confirmed,-500000);
  const l=loss(f,{equity:500000});assert.equal(l.breached,false,'not asserted as a loss');assert.equal(l.ambiguous,true,'reported as ambiguous with its scenarios');assert.ok(l.scenarios.some(s=>s.name==='flows of uncertain timing counted'&&!s.breached));
  // U.S. baseline at 23:40 KST on Nov 4 (09:40 New York); a deposit dated Nov 5 in Seoul came after it.
  const us=new PerformanceHistory(new DatabaseSync(':memory:'),()=>at);const usSince=Date.parse('2026-11-04T14:40:00Z');us.addFlow('a',{day:'2026-11-05',market:'US',amount:100,note:'after midnight KST'});
  assert.equal(us.flowsSince('a','US',usSince).confirmed,100);
});

// 4. A day's range change resets at the day boundary (resolution across midnight is measured from yesterday's last range).
test('finding 4: range changes accumulate within a day only; a new day starts from the last range of the previous one',()=>{
  let t=Date.parse('2026-11-02T03:00:00Z');const h=new PerformanceHistory(new DatabaseSync(':memory:'),()=>t);
  const st=(low,high)=>({totals:{KRW:low,USD:0,equityKRW:low},cash:{KRW:low,USD:0},rows:[],fx:{usdKRW:1300},valuation:{version:'v',combined:{low,high,exact:low===high,complete:true,scope:['KR','US'],reasons:[]},markets:{KR:{at:t,equity:{low,high}},US:{at:t,equity:{low:0,high:0}}},fx:{at:t}}});
  h.record('a',st(900000,1000000));t+=3600000;h.record('a',st(950000,1000000));t=Date.parse('2026-11-03T03:00:00Z');h.record('a',st(950000,950000));
  const s=h.series('a','COMBINED');assert.equal(s[1].pnl,0);assert.deepEqual(s[1].pnlRange,{low:-50000,high:0},'only the next day’s ₩50,000 narrowing is in its range, not the first day’s');assert.equal(h.history('a')[1].valuation.ranges.COMBINED.narrowed,50000);
});
