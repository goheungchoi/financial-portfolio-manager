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
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-25.2');assert.equal(RI.ORDERS_VERSION,'review 2026-11-25.2 orders');assert.equal(RI.SCOUT_INSTRUCTIONS_VERSION,'scout 2026-11-25b');
  assert.equal(RI.fingerprint(),'cb76073c9969edd4');assert.equal(RI.fingerprint(undefined,{orders:true}),'136bb024468c1184');
  assert.equal(RI.fingerprint(undefined,{short:true}),'bda0a00141be7eb9');assert.equal(RI.fingerprint(undefined,{orders:true,short:true}),'a42c4a83ae4bd05b');
});
test('the four other preference sentences are gone (the user\'s "Remove all four"); what stays reads cleanly; the proposed set had none and is unchanged',()=>{
  const F=require('./fixtures/risk-off-text.cjs');
  assert.doesNotMatch(RI.REVIEW_CORE,/Prioritize justified loss-reduction rebalancing or cash preservation|a lack of candidates is not a reason to Hold|Keeping cash idle is a valid decision|\(for example risk-off or mixed signals\)|Prefer Hold when expected edge does not cover costs/);
  assert.match(RI.REVIEW_CORE,/ Never chase recovery with leverage, averaging down solely to recover losses, or larger risk limits\. Hold is allowed when a trade is not justified\./);
  assert.match(RI.REVIEW_CORE,/ screen_market, search_securities and update_watchlist can build a shortlist, and discovery\.starterCandidates are evaluated like any other universe symbol, with evidence gathered before any Buy\. /);
  assert.match(RI.REVIEW_CORE,/specific reasons are fine, but the same general reason repeated for every target is not\./);assert.match(RI.REVIEW_CORE,/A tax estimate is not withheld cash\. Precedence:/);
  assert.equal(F.beforeFour(RI.REVIEW_CORE).length,31482,'put back, the 2026-11-25 core');
  assert.equal(RI.fingerprint('proposed'),'07d9d66f7954bf84');assert.equal(RI.fingerprint('proposed',{orders:true}),'0da5c379de492680');
  // One dry run in all: 'review 2026-11-25' was never released (the installed build is at 'review 2026-11-24'); the gate counts
  // only the fingerprints in force, so a dry run on this version is the one the update asks for.
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-25.2');
});
