// Risk-off text ('review 2026-11-25', the user's "Yes, both with dry run"; artifacts/reviews/2026-11-24-risk-off-text):
// the review's risk_off preference was removed. beforeRiskOff(body) puts it back in a request body, so a pin taken before
// still compares every other byte.
const NOW='marketRegime is a rule-based gauge from VIX, credit spreads, breadth and trends. ';
const THEN='marketRegime is a rule-based gauge from VIX, credit spreads, breadth and trends; in risk_off prefer smaller positions and require stronger evidence for new buys. ';
function beforeRiskOff(body){if(body.split(NOW).length!==2)throw new Error('the gauge sentence is not in the body once');return body.replace(NOW,THEN);}
module.exports={NOW,THEN,beforeRiskOff};
