const test=require('node:test');const assert=require('node:assert/strict');
const {researchReview}=require('../electron/research-review.cjs');const {validateDecision}=require('../electron/ai-client.cjs');const {triage}=require('../electron/complexity.cjs');
const context={universe:[{symbol:'NASD:GOOGL'}],quotes:[{symbol:'NASD:GOOGL',price:323.68}]};
// 2026-10-23 23:03 and 23:35 KST: sol's Alphabet Buy came back without horizonDays and was held back.
const raw=horizon=>({action:'Buy',symbol:'NASD:GOOGL',quantity:1,explanation:'Long-term investment: buy one Alphabet share.',credit:'none',loanDate:'',plan:{thesis:'Cash generation and AI demand',invalidation:'Earnings show cash flow falling',stopPrice:300,targetPrice:370,horizonDays:horizon,confidence:'medium',portfolioImpact:{weightBeforePct:0,weightAfterPct:28.5,related:['NASD:GOOGL'],relatedBeforePct:0,relatedAfterPct:28.5,equityReliable:true,why:'A long-term cash-generative business at 28.5% is acceptable concentration for this growth goal.'}}});
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
test('review fix: withheld pairs stay in the adjudication queue with their details',()=>{
  const fs=require('node:fs'),path=require('node:path');
  assert.match(fs.readFileSync(path.join(__dirname,'..','scripts','routing-report.cjs'),'utf8'),/const MATERIAL=\['action','symbol','size','verdict','withheld'\];/);
  const auto=fs.readFileSync(path.join(__dirname,'..','electron','automation.cjs'),'utf8');assert.match(auto,/withheld:\{symbol:d\.withheld\.symbol,quantity:d\.withheld\.quantity,reason:d\.withheld\.reason/);
});
test('a Buy without the before-and-after portfolio comparison is held back; the app checks the stated weights',()=>{
  const noImpact=validateDecision({...raw(365),plan:{...raw(365).plan,portfolioImpact:null}},['NASD:GOOGL'],{requirePlan:true});
  assert.equal(noImpact.action,'Hold');assert.equal(noImpact.withheld.reason,'no before-and-after portfolio comparison');
  const hold=validateDecision({action:'Hold',symbol:'',quantity:0,explanation:'x',credit:'none',loanDate:'',plan:{thesis:'',invalidation:'i',stopPrice:null,targetPrice:null,horizonDays:null,confidence:'low',portfolioImpact:null}},['NASD:GOOGL'],{requirePlan:true});assert.equal(hold.action,'Hold','a Hold needs none');
  // 2026-10-24 01:10: Nvidia stated as 14.6% on inflated equity; on real equity one share is about 18.9%.
  const {impactCheck}=require('../electron/plan-gap.cjs');
  // Just before the Nvidia buy: Alphabet's KRW (about ₩431k) committed, Samsung E&A ₩177,300, Alphabet $323.08.
  const ctx={markets:[{market:'KR',equity:888081+177300,cash:888081},{market:'US',equity:323.08,cash:0}],cash:{KRW:888081,USD:0},fx:{usdKRW:1324.6},equity:888081+177300+323.08*1324.6,quotes:[{symbol:'NASD:NVDA',price:212.78}],positions:{'NASD:GOOGL':{quantity:1}},equityReliability:{reliable:true}};
  const nvda={action:'Buy',symbol:'NASD:NVDA',quantity:1,plan:{portfolioImpact:{weightAfterPct:14.6}}};const c=impactCheck(ctx,nvda);
  assert.equal(c.appWeightBeforePct,0);assert.ok(Math.abs(c.appWeightAfterPct-18.9)<0.2,`after ${c.appWeightAfterPct}%, about 18.9% of real equity`);assert.ok(c.differencePts>3,'flagged');
});
test('reviews are told whether equity is reliable for the comparison',()=>{
  const fs=require('node:fs'),path=require('node:path');const src=fs.readFileSync(path.join(__dirname,'..','electron','automation.cjs'),'utf8');
  assert.match(src,/context\.equityReliability=\{reliable:!reasons\.length/);assert.match(fs.readFileSync(path.join(__dirname,'..','electron','ai-client.cjs'),'utf8'),/If equityReliability\.reliable is false, set equityReliable to false and say the comparison cannot be trusted/);
});
test('protocol 2026-10-24: withheld pairs are queued and incomplete-plan is an adjudication category',()=>{
  const fs=require('node:fs'),path=require('node:path');const {PROTOCOL_VERSION}=require('../electron/routing-sim.cjs');assert.equal(PROTOCOL_VERSION,'2026-10-24');
  const rep=fs.readFileSync(path.join(__dirname,'..','scripts','routing-report.cjs'),'utf8');assert.match(rep,/'evidence-ignored','incomplete-plan'\]/);
  const doc=fs.readFileSync(path.join(__dirname,'..','docs','ROUTING-EVALUATION.md'),'utf8');assert.match(doc,/`symbol`, `withheld` \(material differences/);assert.match(doc,/A\nwithheld Buy is not automatically a model error/);assert.match(doc,/protocol version 2026-10-24/);
});
