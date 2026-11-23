// S4 (artifacts/reviews/2026-11-23-after-b2/note-7-s4-design.md, 'review 2026-11-24'): reviews are offered run_screen in
// place of compute, the trigger tool carries the neutral single-formula text in place of "(see compute)", and the review
// core's compute sentence became the run_screen sentence and the rule for numbers a script did not return. Request-body
// pins put the earlier pieces back, each at most once, so every other byte is still compared with the body they pin.
const d=require('../../electron/agent-desk.cjs');const F=require('../../electron/formula.cjs');const {REVIEW_SCREEN_TOOL}=require('../../electron/scout.cjs');
const RI=require('../../electron/review-instructions.cjs');
const OLD_SENTENCE='compute evaluates formulas over prices and daily history for numbers the context does not give.';
const NEW_SENTENCE='run_screen runs a short script over this review\'s own stocks (closes, indicators, rankings, live prices) for numbers the context does not give. If a script you relied on did not return the numbers you asked for, do not state or estimate them: say in your explanation which were not available, and do not take an action that depended on them.';
const OLD_TRIGGER=d.TRIGGER_TOOL.description.replace('Each condition is a single formula compared','Each condition is a formula (see compute) compared').replace(' '+F.NEUTRAL_HELP,'');
const enc=v=>JSON.stringify(v).slice(1,-1);
// [after, before] pairs, as they appear in a request body (strings JSON-escaped; schemas as the client sends them).
// OpenAI request bodies only.
function pieces(){
  const schema=t=>JSON.stringify(t.parameters);
  // run_screen carries strict before its description; compute carried it after.
  return [[enc(REVIEW_SCREEN_TOOL.description)+'","parameters"',enc(d.COMPUTE_TOOL.description)+'","strict":true,"parameters"'],[schema(REVIEW_SCREEN_TOOL),schema(d.COMPUTE_TOOL)],['"name":"run_screen","strict":true','"name":"compute"'],
    [enc(d.TRIGGER_TOOL.description),enc(OLD_TRIGGER)],[enc(NEW_SENTENCE),enc(OLD_SENTENCE)]];}
function beforeS4(body){let out=body;for(const [after,before] of pieces()){const n=out.split(after).length-1;if(n>1)throw new Error('an S4 piece is sent more than once: '+after.slice(0,40));if(n===1)out=out.split(after).join(before);}return out;}
// The text has the new sentence exactly once (the core) and never the old one; checked by the tests that use beforeS4.
const coreHasNewSentence=()=>RI.REVIEW_CORE.split(NEW_SENTENCE).length===2&&!RI.REVIEW_CORE.includes(OLD_SENTENCE);
module.exports={beforeS4,OLD_SENTENCE,NEW_SENTENCE,OLD_TRIGGER,coreHasNewSentence};
