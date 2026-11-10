// Lag fix L2 (artifacts/reviews/2026-11-10-lag): the state the window polls every two seconds carries the latest three
// decisions in brief; the full review lists, trade outcomes and news events (about 1.6 MB of 1.7) come from
// runtime:history, which only the Journal and News pages request. Main-process code keeps reading
// automation.getState() in full.
const HISTORY_KEYS=Object.freeze(['reviews','allReviews','outcomes','newsEvents']);
// What Home shows for a decision (Dashboard.tsx) and what other screens read from the latest ones.
const briefReview=r=>({id:r.id,timestamp:r.timestamp,trigger:r.trigger??null,provider:r.provider??null,...(r.vendor?{vendor:r.vendor}:{}),
  decision:r.decision?{action:r.decision.action,symbol:r.decision.symbol,quantity:r.decision.quantity,explanation:r.decision.explanation,...(r.decision.withheld?{withheld:r.decision.withheld}:{})}:null});
// version: Automation.historyVersion(), the same key the history reads are cached under (L2b): the window fetches the
// history again only when it differs. null (unknown) makes the window fetch every time, as before.
function lightState(state,{version=null}={}){
  const out={...state};for(const k of HISTORY_KEYS)delete out[k];out.historyVersion=version;
  out.reviews=(state.reviews??[]).slice(0,3).map(briefReview);
  out.historyCounts=Object.fromEntries(HISTORY_KEYS.map(k=>[k,Array.isArray(state[k])?state[k].length:0]));
  return out;
}
const historyOf=state=>Object.fromEntries(HISTORY_KEYS.map(k=>[k,state[k]??[]]));
module.exports={HISTORY_KEYS,briefReview,lightState,historyOf};
