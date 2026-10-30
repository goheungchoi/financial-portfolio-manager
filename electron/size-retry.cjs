// After a review failed on the app's own size limit (a deterministic failure: the same inputs fail again), whether a new
// review may try again. It compares what can change a decision (electron/review-gate.cjs), not the exact inputs: the old
// check required identical quotes (volumes, percentage changes) and identical trigger evidence (each price trigger's own
// price and time), so during a session every price trigger counted as new.
// 2026-10-30 09:00-09:30 KST: a review over the size limit was rebuilt and failed again every 1-2 minutes.
const RG=require('./review-gate.cjs');
const ALWAYS=['User request','Emergency loss response','Auto trading started'];
const BACKSTOP_MS=30*60000;
const hhmm=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'});
// One-off events in a review's trigger evidence: a price level reached or crossed (a holding's review-watch level, a
// candidate's entry level), an agent trigger whose conditions were met, a filing that started a news review and an
// order update (a fill, partial fill, cancellation or rejection). Each happens once, so a size failure must not
// swallow it: one the failed review did not have is a reason to retry, and one that gets no decision is put back
// (electron/automation.cjs restoreEvents). Repeated percentage moves are not events: the price comparison covers them.
// Review of 4bf7185..1dfddb9, P1: an entry level crossed by 0.1% and a newly met agent trigger were both dropped.
const LEVELS=['price','entry-level'];
// An order update as an event: the order in its status and filled quantity (a later fill is a new event).
const orderEventKey=o=>`order:${o.id}|${o.status}|${o.filled??0}`;
const levelOf=x=>'level:'+(x.watchRevision??`${x.symbol}|${x.direction}|${x.threshold}`);
function eventItems(evidence){if(!evidence||typeof evidence!=='object')return [];
  if(evidence.kind==='order')return (evidence.orders??[]).filter(o=>o?.id).map(o=>({key:orderEventKey(o),type:'order',id:o.id,label:`${o.status} ${o.side} ${o.symbol} (${o.filled??0}/${o.quantity})`}));
  if(evidence.kind==='news')return (evidence.events??[]).filter(e=>e?.id).map(e=>({key:'news:'+e.id,type:'news',id:e.id,label:`filing “${String(e.title??'').slice(0,60)}”`}));
  if(evidence.kind==='agent-trigger')return evidence.trigger?.id?[{key:'agent:'+evidence.trigger.id,type:'agent',id:evidence.trigger.id,label:`agent trigger ${evidence.trigger.name??evidence.trigger.id} met`}]:[];
  const items=evidence.kind==='watchlist'?evidence.alerts??[]:[evidence,...(evidence.alongside??[])];
  return items.filter(x=>LEVELS.includes(x?.kind)&&x.symbol&&Number.isFinite(x.threshold)&&['above','below'].includes(x.direction)).map(x=>({key:levelOf(x),type:'level',symbol:x.symbol,revision:x.watchRevision??null,label:`${x.symbol} ${x.kind==='entry-level'?'crossed its entry level':'reached its level'} ${x.threshold} (${x.direction})`}));}
const eventKeys=evidence=>eventItems(evidence).map(e=>e.key);
// failed: {at, code, version, state (decisionState of the failed inputs), seen (news keys known then), eventKeys (the
// one-off events it had)}. evidence: this review's trigger evidence. Returns {retry, why}: why says what allowed the
// retry, or why it was not tried.
function retryAfterSizeFailure(failed,{trigger,evidence=null,emergency=false,version=null,state=null,events=[],config={},now=Date.now()}){
  if(ALWAYS.includes(trigger))return {retry:true,why:trigger};
  const fresh=eventItems(evidence).filter(e=>!(failed.eventKeys??[]).includes(e.key));
  if(fresh.length)return {retry:true,why:fresh.map(e=>e.label).join('; ')+', new since the failure',kinds:['event']};
  if(emergency)return {retry:true,why:'the daily loss limit is active'};
  if(failed.version&&version&&failed.version!==version)return {retry:true,why:`the app was updated (${failed.version} to ${version})`};
  if(now-failed.at>=BACKSTOP_MS)return {retry:true,why:`${Math.round((now-failed.at)/60000)} minutes since the failure at ${hhmm(failed.at)} KST`};
  if(!failed.state||!state)return {retry:true,why:'the failed inputs were not recorded'};
  const g=RG.compare({...failed.state,at:failed.at,seen:failed.seen??[]},state,{trigger:'Scheduled review',now,config:{...config,maxSkipMinutes:1e9},events});
  const reasons=g.reasons.filter(r=>!['trigger','backstop','baseline'].includes(r.kind));
  return reasons.length?{retry:true,why:reasons.slice(0,3).map(r=>r.detail).join('; '),kinds:[...new Set(reasons.map(r=>r.kind))]}:{retry:false,why:`nothing decision-relevant changed since the size failure at ${hhmm(failed.at)} KST`};
}
// Whether a price trigger is worth rebuilding a review for while a size failure stands: it reports a level event the
// failed review did not have, or one of its percentage moves passed the review gate's limit (half the price-move trigger
// for a holding, the full trigger otherwise) since the failure. A level is an event however small the move that reached it.
function priceTriggerMoved(failed,trigger,{tolerance=3}={}){if(!failed?.state||!trigger)return true;
  if(eventItems(trigger).some(e=>!(failed.eventKeys??[]).includes(e.key)))return true;
  const all=[trigger,...(trigger.alongside??[]),...(trigger.alerts??[])].filter(x=>x?.symbol&&x.price>0);if(!all.length)return true;
  // Only levels the failed review already had: held.
  const items=all.filter(x=>!LEVELS.includes(x.kind));if(!items.length)return false;
  return items.some(x=>{const then=failed.state.quotes?.[x.symbol]?.price;if(!(then>0))return true;const limit=x.symbol in (failed.state.positions??{})?Math.max(.1,tolerance/2):tolerance;return Math.abs(x.price/then-1)*100>=limit;});}
module.exports={retryAfterSizeFailure,priceTriggerMoved,eventItems,eventKeys,orderEventKey,BACKSTOP_MS,ALWAYS};
