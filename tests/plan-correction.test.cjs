const test=require('node:test');const assert=require('node:assert/strict');
const {researchReview}=require('../electron/research-review.cjs');const {validateDecision}=require('../electron/ai-client.cjs');const {triage}=require('../electron/complexity.cjs');
const context={universe:[{symbol:'NASD:GOOGL'}],quotes:[{symbol:'NASD:GOOGL',price:323.68}]};
// 2026-10-23 23:03 and 23:35 KST: sol's Alphabet Buy came back without horizonDays and was held back.
const raw=horizon=>({action:'Buy',symbol:'NASD:GOOGL',quantity:1,explanation:'Long-term investment: buy one Alphabet share.',credit:'none',loanDate:'',plan:{thesis:'Cash generation and AI demand',invalidation:'Earnings show cash flow falling',stopPrice:300,targetPrice:370,horizonDays:horizon,confidence:'medium'}});
const reply=horizon=>{const decision=validateDecision(raw(horizon),['NASD:GOOGL'],{requirePlan:true});return {decision,usage:{inputTokens:10,outputTokens:5},...(decision.withheld?{continuation:[{role:'user',content:'context'}]}:{})};};
test('a Buy withheld for a missing horizon gets one correction request and is accepted when complete',async()=>{
  const asked=[],logs=[];const replies=[reply(null),reply(365)];
  const r=await researchReview({context,evidence:null,request:async opts=>{asked.push(opts);return replies.shift();},log:(k,t,b)=>logs.push(t)});
  assert.equal(r.decision.action,'Buy');assert.deepEqual(r.decision.planCorrected,{missing:'no horizon'});assert.equal(r.decision.plan.horizonDays,365);
  assert.equal(asked.length,2,'exactly one correction');assert.equal(asked[1].final,true,'no more tool calls');assert.match(asked[1].continuation.at(-1).content,/held back your Buy of 1 NASD:GOOGL because its plan is incomplete: no horizon/);
  assert.deepEqual(r.usage,{inputTokens:20,outputTokens:10});assert.ok(logs.includes('Plan correction requested')&&logs.includes('Plan correction accepted'));assert.equal('continuation' in r,false);
});
test('if the correction is still incomplete, the Buy stays withheld and is marked as such; the safeguard is not weakened',async()=>{
  const replies=[reply(null),reply(null)];let calls=0;
  const r=await researchReview({context,evidence:null,request:async()=>{calls++;return replies.shift();},log:()=>{}});
  assert.equal(calls,2,'bounded: one retry only');assert.equal(r.decision.action,'Hold');assert.equal(r.decision.withheld.symbol,'NASD:GOOGL');assert.equal(r.decision.withheld.correctionTried,true);
});
test('a complete Buy needs no correction; evaluations keep a withheld Buy distinct from a Hold',async()=>{
  let calls=0;const r=await researchReview({context,evidence:null,request:async()=>{calls++;return reply(365);},log:()=>{}});assert.equal(calls,1);assert.equal(r.decision.planCorrected,undefined);
  const hold={action:'Hold',symbol:'',quantity:0,explanation:'x',planVerdicts:[]};assert.equal(triage({...hold,withheld:{symbol:'NASD:GOOGL',quantity:1,reason:'no horizon'}},hold),'withheld');assert.equal(triage(hold,{...hold}),'same');
});
test('reviews are told how to explain a reversal of the previous review',()=>{
  const fs=require('node:fs'),path=require('node:path');const src=fs.readFileSync(path.join(__dirname,'..','electron','ai-client.cjs'),'utf8');
  assert.match(src,/previousReview is the last review on this account; when your action or a verdict reverses it/);
  const auto=fs.readFileSync(path.join(__dirname,'..','electron','automation.cjs'),'utf8');assert.match(auto,/context\.previousReview=\{at:/);
  const {fingerprint}=require('../electron/token-saver.cjs');const base={universe:[],quotes:[]};assert.equal(fingerprint({...base,previousReview:{action:'Hold'}}).exact,fingerprint({...base,previousReview:{action:'Buy'}}).exact,'the previous review alone does not force a review');
});
