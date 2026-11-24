// Built-in preference text removed from the review (artifacts/reviews/2026-11-24-risk-off-text):
// - 'review 2026-11-25' (the user's "Yes, both with dry run"): the risk_off preference;
// - 'review 2026-11-25.2' (the user's "Remove all four"): the emergency passage's cash preservation, the discovery
//   passage's two preferences (the tools kept as one plain sentence), the plan gap's bracketed example, and the Hold
//   preference.
// - 'review 2026-11-25.3' (the user's "Remove the sentences which are the same kind as the ones I found"): never chase
//   recovery, the extended-session advice, unknown tax as a reason to Hold.
// beforeRiskOff(text) puts every one back, in order, in a request body or a core, so a pin taken before still compares
// every other byte. Each piece must be present exactly once.
const THREE=[
  ['liquidity and transaction costs. Hold is allowed when a trade is not justified.','liquidity and transaction costs. Never chase recovery with leverage, averaging down solely to recover losses, or larger risk limits. Hold is allowed when a trade is not justified.'],
  ['so use a limit price close to the current quote; the app caps extended-session orders at a small share of equity.','so use a limit price close to the current quote, keep the order small (the app caps extended-session orders at a small share of equity), and prefer protecting or trimming positions over opening large new ones.'],
  ['Unknown tax qualifies an after-tax claim. ','Unknown tax qualifies an after-tax claim; it is not a reason to Hold and never a reason to drop a protective exit. '],
];
const FOUR=[
  ['Never chase recovery with leverage, averaging down solely to recover losses, or larger risk limits.','Prioritize justified loss-reduction rebalancing or cash preservation; never chase recovery with leverage, averaging down solely to recover losses, or larger risk limits.'],
  ['screen_market, search_securities and update_watchlist can build a shortlist, and discovery.starterCandidates are evaluated like any other universe symbol, with evidence gathered before any Buy.','When a market holds substantial idle cash and has few or no review-universe candidates, a lack of candidates is not a reason to Hold: use screen_market or search_securities and update_watchlist to build a shortlist, and evaluate discovery.starterCandidates like any other universe symbol, gathering evidence before any Buy. Keeping cash idle is a valid decision only after candidates were considered against userGuidelines.'],
  ['the same general reason repeated for every target','the same general reason (for example risk-off or mixed signals) repeated for every target'],
  ['A tax estimate is not withheld cash. Precedence:','A tax estimate is not withheld cash. Prefer Hold when expected edge does not cover costs or required evidence is missing. Precedence:'],
];
const NOW='marketRegime is a rule-based gauge from VIX, credit spreads, breadth and trends. ';
const THEN='marketRegime is a rule-based gauge from VIX, credit spreads, breadth and trends; in risk_off prefer smaller positions and require stronger evidence for new buys. ';
const once=(text,now,then)=>{if(text.split(now).length!==2)throw new Error('not in the text once: '+now.slice(0,50));return text.replace(now,then);};
// The three only (the text as 'review 2026-11-25.2' had it).
function beforeThree(text){let t=text;for(const [now,then] of THREE)t=once(t,now,then);return t;}
// The three and the four (the text as 'review 2026-11-25' had it).
function beforeFour(text){let t=beforeThree(text);for(const [now,then] of FOUR)t=once(t,now,then);return t;}
// Every removal put back (the text as 'review 2026-11-24' had it).
function beforeRiskOff(text){return once(beforeFour(text),NOW,THEN);}
module.exports={NOW,THEN,THREE,FOUR,beforeThree,beforeFour,beforeRiskOff};
