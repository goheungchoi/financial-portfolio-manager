// After a review failed on the app's own size limit (a deterministic failure: the same inputs fail again), whether a new
// review may try again. It compares what can change a decision (electron/review-gate.cjs), not the exact inputs: the old
// check required identical quotes (volumes, percentage changes) and identical trigger evidence (each price trigger's own
// price and time), so during a session every price trigger counted as new.
// 2026-10-30 09:00-09:30 KST: a review over the size limit was rebuilt and failed again every 1-2 minutes.
const RG=require('./review-gate.cjs');
const ALWAYS=['User request','Emergency loss response','Auto trading started'];
const BACKSTOP_MS=30*60000;
const hhmm=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'});
// failed: {at, code, version, state (decisionState of the failed inputs), seen (news keys known then)}. Returns
// {retry, why}: why says what allowed the retry, or why it was not tried.
function retryAfterSizeFailure(failed,{trigger,emergency=false,version=null,state=null,events=[],config={},now=Date.now()}){
  if(ALWAYS.includes(trigger))return {retry:true,why:trigger};
  if(emergency)return {retry:true,why:'the daily loss limit is active'};
  if(failed.version&&version&&failed.version!==version)return {retry:true,why:`the app was updated (${failed.version} to ${version})`};
  if(now-failed.at>=BACKSTOP_MS)return {retry:true,why:`${Math.round((now-failed.at)/60000)} minutes since the failure at ${hhmm(failed.at)} KST`};
  if(!failed.state||!state)return {retry:true,why:'the failed inputs were not recorded'};
  const g=RG.compare({...failed.state,at:failed.at,seen:failed.seen??[]},state,{trigger:'Scheduled review',now,config:{...config,maxSkipMinutes:1e9},events});
  const reasons=g.reasons.filter(r=>!['trigger','backstop','baseline'].includes(r.kind));
  return reasons.length?{retry:true,why:reasons.slice(0,3).map(r=>r.detail).join('; '),kinds:[...new Set(reasons.map(r=>r.kind))]}:{retry:false,why:`nothing decision-relevant changed since the size failure at ${hhmm(failed.at)} KST`};
}
// Whether a price trigger is worth rebuilding a review for while a size failure stands: one of its symbols moved past
// the review gate's limit (half the price-move trigger for a holding, the full trigger otherwise) since the failure.
function priceTriggerMoved(failed,trigger,{tolerance=3}={}){if(!failed?.state||!trigger)return true;
  const items=[trigger,...(trigger.alongside??[]),...(trigger.alerts??[])].filter(x=>x?.symbol&&x.price>0);if(!items.length)return true;
  return items.some(x=>{const then=failed.state.quotes?.[x.symbol]?.price;if(!(then>0))return true;const limit=x.symbol in (failed.state.positions??{})?Math.max(.1,tolerance/2):tolerance;return Math.abs(x.price/then-1)*100>=limit;});}
module.exports={retryAfterSizeFailure,priceTriggerMoved,BACKSTOP_MS,ALWAYS};
