// Position memory and reversals (audit 2026-11-04, Stage 4): reviews see the last filled entry and exit with their
// rationale, and an opening that reverses a recent filled exit must say what changed.
const test=require('node:test');const assert=require('node:assert/strict');const PM=require('../electron/position-memory.cjs');
const {validateDecision}=require('../electron/ai-client.cjs');const {researchReview}=require('../electron/research-review.cjs');
const DAY=86400000,T=Date.parse('2026-11-03T01:00:00Z'),ACCOUNT='acct';
const plan={strategy:'swing',thesis:'Q3 margin recovery',invalidation:'Q3 operating margin below 8%',stopPrice:84000,targetPrice:110000,horizonDays:60};
// The Kia episode: a Buy on Oct 26, a sale on Nov 2 that required evidence of margin recovery, and Holds in between.
const outcome=(id,side,effect,at,price,{review=id,quantity=1,requested=quantity,decision}={})=>({id:'broker:'+id,orderId:id,reviewId:review,source:'broker',accountKey:ACCOUNT,symbol:'000270',side,effect,status:'Filled',quantity,requested,averagePrice:price,timestamp:at,
  decision:decision===undefined?{action:side,explanation:`${side} rationale`,plan}:decision,reviewEvidence:{quote:{symbol:'000270',price,bid:price-100,ask:price+100}}});
const entry=outcome('R1','Buy','OPEN_LONG',T-8*DAY,106000);
const exit=outcome('R3','Sell','CLOSE_LONG',T-DAY,88800,{decision:{action:'Sell',explanation:'Sell until there is evidence of margin recovery.',plan:null}});
const reviewAt=new Map([['R1',T-8*DAY-60000],['R3',T-DAY-60000]]);
const build=(outcomes,opts={})=>PM.build(outcomes,{accounts:[ACCOUNT],positions:{},reviewAt,reviewsSince:()=>4,now:T,...opts});
test('the last filled entry and exit are given with their review, rationale, fill and quote; an unexecuted recommendation is not',()=>{
  const [row]=build([entry,exit]);assert.equal(row.symbol,'000270');assert.equal(row.lastMaterial,'exit');assert.equal(row.holding,0);assert.equal(row.reviewsSince,4,'intervening Holds are counted, not a replacement');
  assert.equal(row.lastExit.decisionId,'R3');assert.match(row.lastExit.rationale,/evidence of margin recovery/);assert.equal(row.lastExit.fillPrice,88800);assert.deepEqual(row.lastExit.quoteAtDecision,{price:88800,bid:88700,ask:88900});
  assert.equal(row.lastEntry.decisionId,'R1');assert.equal(row.lastEntry.invalidation,'Q3 operating margin below 8%');assert.equal(row.lastEntry.stopPrice,84000);assert.equal(row.lastEntry.decidedAt,new Date(T-8*DAY-60000).toISOString());
  // A sale that never filled (no outcome) and another account's fills are not in it; neither is a retracted fill.
  assert.deepEqual(build([entry,{...exit,accountKey:'other'}])[0].lastMaterial,'entry');assert.equal(build([entry,{...exit,status:'Retracted',quantity:0}])[0].lastExit,undefined);
});
test('partial fills and the remaining holding are kept; a missing rationale is unavailable, never guessed',()=>{
  const [row]=build([outcome('R1','Buy','OPEN_LONG',T-2*DAY,95100,{quantity:1,requested:3,decision:null})],{positions:{'000270':{quantity:1}}});
  assert.equal(row.holding,1);assert.equal(row.lastEntry.partial,true);assert.equal(row.lastEntry.filled,1);assert.equal(row.lastEntry.requested,3);assert.equal(row.lastEntry.rationale,'unavailable');
  // Unknown credit identities are not material decisions; old closed positions drop out after 30 days, held ones stay.
  assert.deepEqual(build([{...entry,effect:'unknown'}]),[]);assert.deepEqual(build([{...entry,timestamp:T-40*DAY}]),[]);assert.equal(build([{...entry,timestamp:T-40*DAY}],{positions:{'000270':{quantity:1}}}).length,1);
});
const memory=build([entry,exit]);
test('an opening within 30 days of a filled exit in the same direction is a reversal that must be explained; a reduction is only asked',()=>{
  const buy={action:'Buy',symbol:'000270',quantity:1,credit:'none'};const r=PM.reversalOf(buy,memory,{now:T});assert.equal(r.required,true);assert.equal(r.prior.decisionId,'R3');
  assert.equal(PM.reversalOf(buy,memory,{now:T+31*DAY}),null,'older than 30 days');assert.equal(PM.reversalOf({...buy,action:'Hold'},memory,{now:T}),null);
  assert.equal(PM.reversalOf({action:'Sell',symbol:'000270',quantity:1,credit:'none'},memory,{now:T}),null,'a sale after a sale reverses nothing');
  const held=build([entry]);const sell=PM.reversalOf({action:'Sell',symbol:'000270',quantity:1,credit:'none'},held,{now:T});assert.equal(sell.required,false,'a reduction is never withheld');assert.equal(sell.kind,'reverses-entry');
  // A short sale after a cover reverses the cover; a cover after a short sale is a reduction.
  const cover=outcome('C1','Buy','CLOSE_SHORT',T-DAY,50000),short=outcome('S1','Sell','OPEN_SHORT',T-3*DAY,52000);
  assert.equal(PM.reversalOf({action:'Sell',symbol:'000270',quantity:1,credit:'short'},build([short,cover]),{now:T}).required,true);assert.equal(PM.reversalOf({action:'Buy',symbol:'000270',quantity:1,credit:'cover'},build([short]),{now:T}).required,false);
});
// A complete Buy (plan and evidence) of one Kia share at 95,100, above the 88,800 exit.
const full={action:'Buy',symbol:'000270',quantity:1,explanation:'Re-enter Kia.',credit:'none',loanDate:'',plan:{...plan,targetPrice:null,confidence:'medium',portfolioImpact:{weightBeforePct:0,weightAfterPct:6.5,related:[],relatedBeforePct:0,relatedAfterPct:6.5,equityReliable:true,why:'small position'},
  evidence:[{claim:'Q3 operating profit up 24.3%',source:'Kia Q3 release',verified:true}],valuation:null,uncertainty:null}};
const reversal={priorDecisionId:'R3',basis:'new-evidence',whatChanged:'Q3 results showed operating profit up 24.3% year on year.',priorRequirement:'The sale required margin recovery; the Q3 operating margin rose to 9.1%.',newEvidence:[{claim:'Q3 operating margin 9.1%',source:'Kia Q3 release',date:'2026-11-02'}],afterCost:'Forward EPS 18,000 at 7x gives 126,000, covering the 7% higher price and both-way costs.'};
const decide=(value,price=95100)=>validateDecision(value,['000270'],{requirePlan:true,memory,quotes:[{symbol:'000270',price}],now:T});
test('an unexplained re-entry is held back as a reversal; a complete one passes',()=>{
  const none=decide({...full,reversal:null});assert.equal(none.action,'Hold');assert.equal(none.withheld.kind,'reversal');assert.match(none.withheld.reason,/reverses the filled sale of 2026-11-02 \(review R3\): no reversal explanation/);
  const ok=decide({...full,reversal});assert.equal(ok.action,'Buy');assert.equal(ok.reversal.priorDecisionId,'R3');assert.equal(ok.withheld,undefined);
  const corrected=decide({...full,reversal:{...reversal,basis:'corrected-reasoning',newEvidence:[],priorRequirement:'Sales volumes do not show margins; the sale overweighted one quarter of margin pressure.'}});assert.equal(corrected.action,'Buy','correcting the earlier reasoning needs no invented fact');
});
test('the explanation must name the decision it reverses and be consistent; text alone is not accepted as evidence',()=>{
  const gap=r=>decide({...full,reversal:{...reversal,...r}}).withheld?.reason??null;
  assert.match(gap({priorDecisionId:'R1'}),/priorDecisionId must name the filled decision it reverses \(R3\)/);assert.match(gap({basis:'hunch'}),/no basis/);assert.match(gap({whatChanged:'more'}),/whatChanged/);
  assert.match(gap({newEvidence:[{claim:'Q3 margin',source:'release',date:'2026-10-20'}]}),/new-evidence without a sourced item dated after the earlier decision/,'evidence older than the exit is not new');
  assert.match(gap({afterCost:''}),/afterCost: the price 95100 is above the exit fill 88800/);assert.equal(decide({...full,reversal:{...reversal,afterCost:''}},88000).action,'Buy','no after-cost case below the exit price');
});
test('a missing historical rationale needs a current justification and does not block trading',()=>{
  const old=build([entry,{...exit,decision:null}]);assert.equal(old[0].lastExit.rationale,'unavailable');
  const v=validateDecision({...full,reversal:{...reversal,priorDecisionId:'unavailable',basis:'corrected-reasoning',newEvidence:[],priorRequirement:'The sale rationale is not recorded; the current case is the Q3 margin.'}},['000270'],{requirePlan:true,memory:old,quotes:[{symbol:'000270',price:95100}],now:T});
  assert.equal(v.action,'Buy');
});
test('a sale that reverses a recent entry is flagged when unexplained and is never held back',()=>{
  const sell=validateDecision({action:'Sell',symbol:'000270',quantity:1,explanation:'Stop hit.',credit:'none',loanDate:'',plan:null,reversal:null},['000270'],{requirePlan:true,memory:build([entry]),quotes:[],now:T});
  assert.equal(sell.action,'Sell');assert.match(sell.reversalFlag.reason,/no reversal explanation/);
});
test('one bounded repair attempt for a missing reversal, then withheld with the reason',async()=>{
  const reply=r=>{const decision=decide({...full,reversal:r});return {decision,usage:{inputTokens:10,outputTokens:5},...(decision.withheld?{continuation:[{role:'user',content:'context'}]}:{})};};
  const asked=[],logs=[];let replies=[reply(null),reply(reversal)];
  const ok=await researchReview({context:{universe:[{symbol:'000270'}]},evidence:null,request:async o=>{asked.push(o);return replies.shift();},log:(k,t)=>logs.push(t)});
  assert.equal(ok.decision.action,'Buy');assert.equal(asked.length,2);assert.match(asked[1].continuation.at(-1).content,/held back your opening of 1 000270 because it reverses the filled sale/);assert.match(asked[1].continuation.at(-1).content,/do not invent a changed fact/);assert.ok(logs.includes('Reversal explanation requested'));
  replies=[reply(null),reply(null)];let calls=0;const no=await researchReview({context:{universe:[{symbol:'000270'}]},evidence:null,request:async()=>{calls++;return replies.shift();},log:()=>{}});
  assert.equal(calls,2,'one retry only');assert.equal(no.decision.action,'Hold');assert.equal(no.decision.withheld.kind,'reversal');assert.equal(no.decision.withheld.correctionTried,true);
});
test('position memory is a registered background section; shortened, it keeps the rows of focus symbols',()=>{
  const RC=require('../electron/review-context.cjs');assert.equal(RC.classOf('positionMemory'),'background');assert.equal(RC.TYPES.positionMemory,'array');
  const rows=[...build([entry,exit]),{symbol:'005930',holding:0,lastMaterial:'exit'}];const ref=RC.reference('positionMemory',rows,new Set(['000270']));
  assert.deepEqual(ref.focusRows.map(r=>r.symbol),['000270']);assert.equal(ref.focusRows[0].lastExit.decisionId,'R3');assert.deepEqual(ref.otherSymbols,['005930']);
  const short=RC.COMPRESS.find(([k])=>k==='positionMemory')[1](rows);assert.equal(short[0].lastExit.fillPrice,88800,'fills are never cut');
});
