// Risk-off text (artifacts/reviews/2026-11-24-risk-off-text; the user's rule for built-in text, and on removing these
// sentences, knowing the review change asks for a new Claude dry run: "Yes, both with dry run."): the built-in text no
// longer tells the AI what to do in risk_off. The gauge stays as a fact. Made-up readings.
const test=require('node:test');const assert=require('node:assert/strict');
const RI=require('../electron/review-instructions.cjs');const PR=require('../electron/portfolio-risk.cjs');
test('the three wordings are gone: the review text, the scout text and the gauge\'s note; the gauge is still described as a fact',()=>{
  for(const t of [RI.REVIEW_CORE,RI.PROPOSED_REVIEW_CORE,...RI.REVIEW_PARTS.map(p=>p.text)])assert.doesNotMatch(t,/in risk_off prefer smaller positions|require stronger evidence for new buys/);
  for(const t of [RI.SCOUT_CORE,RI.PROPOSED_SCOUT_CORE])assert.doesNotMatch(t,/Keep more cash in risk_off/);
  assert.match(RI.REVIEW_CORE,/marketRegime is a rule-based gauge from VIX, credit spreads, breadth and trends\. /);
  const g=PR.regime({vix:30,vix5dChangePct:25,hySpread:5,hySpreadChange:0.6,advanceRatioPct:30,kospiVs50dPct:-6,sox20dPct:-12,oil20dPct:15});
  assert.equal(g.note,'Rule-based from stress readings, separate from the AI-written narrative.');assert.doesNotMatch(g.note,/smaller positions|stronger evidence/);
});
test('the gauge itself is unchanged: regime, score and components for the same readings',()=>{
  const g=PR.regime({vix:30,vix5dChangePct:25,advanceRatioPct:30,kospiVs50dPct:-6,sox20dPct:-12,oil20dPct:15});
  assert.equal(g.regime,'risk_off');assert.ok(g.score<=-2);assert.deepEqual(g.components.map(c=>[c.name,c.score]),[['VIX',-1],['VIX 5-day change %',-1],...g.components.slice(2).map(c=>[c.name,c.score])]);
  const calm=PR.regime({vix:12,vix5dChangePct:-20,kospiVs50dPct:4,sox20dPct:12});assert.equal(calm.regime,'risk_on');
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','portfolio-risk.cjs'),'utf8');
  assert.match(src,/return \{regime:score<=-2\?'risk_off':score>=2\?'risk_on':'neutral',score,components:parts,note:'Rule-based from stress readings, separate from the AI-written narrative\.'\};/);
});
test('versions and fingerprints moved: the review asks for a new Claude dry run once',()=>{
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-25');assert.equal(RI.ORDERS_VERSION,'review 2026-11-25 orders');assert.equal(RI.SCOUT_INSTRUCTIONS_VERSION,'scout 2026-11-25b');
  assert.equal(RI.fingerprint(),'2e155a5b9452c226');assert.equal(RI.fingerprint(undefined,{orders:true}),'36913349434ce621');
  assert.equal(RI.fingerprint(undefined,{short:true}),'03d337dbcb5e4765');assert.equal(RI.fingerprint(undefined,{orders:true,short:true}),'0997fb689307bf23');
});
