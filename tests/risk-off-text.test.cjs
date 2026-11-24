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
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-25.4');assert.equal(RI.ORDERS_VERSION,'review 2026-11-25.4 orders');assert.equal(RI.SCOUT_INSTRUCTIONS_VERSION,'scout 2026-11-25b');
  assert.equal(RI.fingerprint(),'e36e408915854800');assert.equal(RI.fingerprint(undefined,{orders:true}),'270c1047cfa0a70e');
  assert.equal(RI.fingerprint(undefined,{short:true}),'67577dc81443657e');assert.equal(RI.fingerprint(undefined,{orders:true,short:true}),'236a6e7d3e6aff2e');
});
test('the four other preference sentences are gone (the user\'s "Remove all four"); what stays reads cleanly; the proposed set had none of the four (its fingerprints are those of the .3 step, which changed its unknown-tax line)',()=>{
  const F=require('./fixtures/risk-off-text.cjs');
  assert.doesNotMatch(RI.REVIEW_CORE,/Prioritize justified loss-reduction rebalancing or cash preservation|a lack of candidates is not a reason to Hold|Keeping cash idle is a valid decision|\(for example risk-off or mixed signals\)|Prefer Hold when expected edge does not cover costs/);
  assert.match(RI.REVIEW_CORE,/liquidity and transaction costs\. Hold is allowed when a trade is not justified\./,'.3: "Never chase recovery…" removed too');
  assert.match(RI.REVIEW_CORE,/ screen_market, search_securities and update_watchlist can build a shortlist, and discovery\.starterCandidates are evaluated like any other universe symbol, with evidence gathered before any Buy\. /);
  assert.match(RI.REVIEW_CORE,/specific reasons are fine, but the same general reason repeated for every target is not\./);assert.match(RI.REVIEW_CORE,/A tax estimate is not withheld cash\. Precedence:/);
  assert.equal(F.beforeFour(RI.REVIEW_CORE).length,31482,'put back, the 2026-11-25 core');
  assert.equal(RI.fingerprint('proposed'),'756c0cd4aa6601c4');assert.equal(RI.fingerprint('proposed',{orders:true}),'a1418621c76413d5');
  // One dry run in all: 'review 2026-11-25' was never released (the installed build is at 'review 2026-11-24'); the gate counts
  // only the fingerprints in force, so a dry run on this version is the one the update asks for.
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-25.4');
});
test('three more of the same kind are gone (the user\'s "Remove the sentences which are the same kind as the ones I found"); the facts and the app\'s cap stay; the precedence sentence stays',()=>{
  const F=require('./fixtures/risk-off-text.cjs');
  for(const t of [RI.REVIEW_CORE,RI.PROPOSED_REVIEW_CORE])assert.doesNotMatch(t,/Never chase recovery|keep the order small|prefer protecting or trimming positions over opening large new ones|it is not a reason to Hold and never a reason to drop a protective exit/);
  assert.match(RI.REVIEW_CORE,/liquidity is thin and spreads are wide, so use a limit price close to the current quote; the app caps extended-session orders at a small share of equity\. /);
  assert.match(RI.REVIEW_CORE,/Unknown tax estimates are unknown, not zero\./);assert.match(RI.REVIEW_CORE,/Unknown tax qualifies an after-tax claim\. /);
  assert.match(RI.PROPOSED_REVIEW_CORE,/- An unknown tax is unknown, not zero\. It qualifies an after-tax claim\.\n/);
  assert.match(RI.REVIEW_CORE,/The defaults in these instructions fill gaps where userGuidelines are silent\./,'precedence kept');
  assert.equal(F.beforeThree(RI.REVIEW_CORE).length,31057,'put back, the .2 core');
  // Still one dry run in all: '.2' and '.3' are unreleased; the installed build carries 'review 2026-11-24'.
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-25.4');assert.equal(RI.PROPOSED_VERSION,'proposed 2026-11-25.2');
});
test('the first two of the last pass are gone (the user\'s "Remove the first two"): the news Hold preference and the plan-gap sentence, in both sets; the other three stay',()=>{
  const F=require('./fixtures/risk-off-text.cjs');const proposed=[RI.PROPOSED_REVIEW_CORE,...RI.PROPOSED_REVIEW_PARTS.map(p=>p.text)].join('\n');
  for(const t of [RI.REVIEW_CORE,proposed])assert.doesNotMatch(t,/prefer Hold when the effect is unclear|Closing the gap is never a goal in itself|is worse than holding/);
  assert.match(RI.REVIEW_CORE,/assess whether those disclosures or headlines change the thesis, risk or valuation of the affected holdings or watchlist symbols\. reviewedLessons/);
  assert.match(RI.REVIEW_CORE,/the same general reason repeated for every target is not\. When you disagree with the plan/);
  assert.match(RI.REVIEW_CORE,/Prefer liquid, orderable stocks/);assert.match(RI.REVIEW_CORE,/a weak or small sample calls for more caution, not reversal/);assert.match(RI.REVIEW_CORE,/take a smaller position/);
  assert.equal(F.beforeTwo(RI.REVIEW_CORE).length,30788,'put back, the .3 core');
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-25.4');assert.equal(RI.PROPOSED_VERSION,'proposed 2026-11-25.2');
});
