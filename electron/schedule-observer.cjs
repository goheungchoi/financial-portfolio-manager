// Observation mode for event-driven review scheduling. The proposed rules run beside the current schedule and only
// record: they never change when reviews run, make AI or broker calls, submit anything, or reach any agent's inputs.
// Every 30 seconds the app's existing live data is checked against the state at the last proposed run, so a threshold
// crossing is timed when it is observed and several small moves add up. Actual reviews are logged with whether a
// proposed run covered them and how their decision changed, so savings and missed reassessments are reported apart.
// Rules (candidate settings, not an approved policy): an event-triggered review; a regular session opening; the last
// closeWindowMin minutes of a regular session; a change in holdings, open orders or order confirmation; a watched symbol
// moving movePct or more; a change in market regime; a new relevant top story; a new scout plan; and a backstop after
// maxMinutes without a proposed run while a regular session is open.
const {randomUUID}=require('node:crypto');
const DEFAULTS={movePct:1.5,maxMinutes:90,closeWindowMin:30};
const EVENT_TRIGGERS=new Set(['Pre-open review','Auto trading started','Price movement trigger','News event trigger','Agent trigger','User request','External agent']);
const orderKey=orders=>JSON.stringify((orders??[]).map(o=>[o.id,o.status,o.filled??0]).sort());
const holdKey=holdings=>JSON.stringify(Object.entries(holdings??{}).filter(([,q])=>q>0).sort());
// Why the proposed scheduler would run now, against the state saved at its last run. Pure.
function reasons(base,state,{movePct,maxMinutes,closeWindowMin}=DEFAULTS){
  if(!base)return [{rule:'first observation'}];const out=[];
  for(const [m,s] of Object.entries(state.markets??{})){if(!s?.open)continue;
    if(base.at<s.startAt)out.push({rule:'session open',market:m});
    const window=s.endAt-closeWindowMin*60000;if(state.at>=window&&base.at<window)out.push({rule:'session close',market:m,minutesLeft:Math.round((s.endAt-state.at)/60000)});}
  if(holdKey(state.holdings)!==holdKey(base.holdings))out.push({rule:'holdings changed',from:base.holdings,to:state.holdings});
  if(orderKey(state.orders)!==orderKey(base.orders))out.push({rule:'orders changed'});
  if((state.reconciliation??null)!==(base.reconciliation??null))out.push({rule:'order confirmation changed',from:base.reconciliation??null,to:state.reconciliation??null});
  for(const sym of state.watched??[]){const p=state.prices?.[sym],q=base.prices?.[sym];if(p>0&&q>0){const pct=(p/q-1)*100;if(Math.abs(pct)>=movePct)out.push({rule:'price move',symbol:sym,pct:Math.round(pct*100)/100,from:q,to:p});}}
  if((state.regime??null)!==(base.regime??null))out.push({rule:'regime change',from:base.regime??null,to:state.regime??null});
  const fresh=(state.stories??[]).filter(s=>s.relevant&&!(base.stories??[]).some(b=>b.key===s.key));if(fresh.length)out.push({rule:'new top story',story:fresh[0].key});
  if((state.scoutPlanAsOf??null)!==(base.scoutPlanAsOf??null))out.push({rule:'new scout plan'});
  const anyOpen=Object.values(state.markets??{}).some(s=>s?.open);if(anyOpen&&state.at-base.at>=maxMinutes*60000)out.push({rule:'backstop',minutes:Math.round((state.at-base.at)/60000)});
  return out;
}
// What changed between two consecutive actual decisions. material: trade, size, verdicts, condition kinds, data-gap
// materiality, stop or target levels. text: wording-only changes to thesis, invalidation or recheck, listed for review.
function decisionChanges(prev,next){
  if(!prev)return {material:[],text:[]};const material=[],text=[];const a=prev.decision??{},b=next.decision??{};
  const trade=d=>d.action==='Hold'?'Hold':`${d.action} ${d.symbol} ${d.quantity}`;if(trade(a)!==trade(b))material.push(`trade ${trade(a)} → ${trade(b)}`);
  if(b.action!=='Hold'&&a.action===b.action&&((a.plan?.stopPrice??null)!==(b.plan?.stopPrice??null)||(a.plan?.targetPrice??null)!==(b.plan?.targetPrice??null)))material.push('stop or target changed');
  const by=d=>Object.fromEntries((d.planVerdicts??[]).map(v=>[v.symbol,v]));const va=by(a),vb=by(b);
  for(const s of Object.keys(vb)){const x=va[s],y=vb[s];if(!x)continue;
    if(x.verdict!==y.verdict)material.push(`${s} verdict ${x.verdict} → ${y.verdict}`);
    if((x.condition?.kind??null)!==(y.condition?.kind??null))material.push(`${s} condition ${x.condition?.kind??'none'} → ${y.condition?.kind??'none'}`);
    if(Boolean(x.dataGap?.material)!==Boolean(y.dataGap?.material))material.push(`${s} data gap ${x.dataGap?.material?'material':'none'} → ${y.dataGap?.material?'material':'none'}`);
    if((x.condition?.recheck??'')!==(y.condition?.recheck??''))text.push(`${s} recheck`);}
  if((a.plan?.thesis??'')!==(b.plan?.thesis??''))text.push('thesis');if((a.plan?.invalidation??'')!==(b.plan?.invalidation??''))text.push('invalidation');
  return {material,text};
}
class ScheduleObserver {
  constructor(db,{clock=Date.now,settings=DEFAULTS}={}){this.db=db;this.clock=clock;this.settings={...DEFAULTS,...settings};this.base=null;this.lastReview=null;
    db.exec('CREATE TABLE IF NOT EXISTS schedule_observations(id TEXT PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL)');}
  save(kind,payload){const id=randomUUID();this.db.prepare('INSERT INTO schedule_observations VALUES(?,?,?,?)').run(id,payload.at,kind,JSON.stringify(payload));return id;}
  // A proposed run: records why, how long since the last one, and makes this state the new baseline.
  run(state,why){const at=state.at;const elapsed=this.base?Math.round((at-this.base.at)/60000):null;const id=this.save('proposed-run',{at,reasons:why,minutesSinceLast:elapsed,backstop:why.some(r=>r.rule==='backstop'),settings:this.settings});this.base=state;this.lastRunAt=at;return id;}
  // Periodic check against live state. Returns the reasons when the proposed scheduler would run now.
  observe(state){const why=reasons(this.base,state,this.settings);if(why.length)this.run(state,why);return why;}
  // An actual event-triggered review is also a proposed run, at its real time.
  noteEventReview(trigger,state){if(EVENT_TRIGGERS.has(trigger))this.run(state,[{rule:'event',trigger}]);}
  // An actual review: whether a proposed run happened since the previous actual review, its cost, and its changes.
  recordReview(review,costUSD){
    // Coverage is coarse: a proposed run since the previous actual review. Runs set off only by account or order changes
    // follow trades the current schedule already made, so they do not show the proposed rules would have found them.
    const prevAt=this.lastReview?.timestamp??-Infinity;const CONSEQUENCE=new Set(['holdings changed','orders changed','order confirmation changed']);
    const runs=this.db.prepare("SELECT payload FROM schedule_observations WHERE kind='proposed-run' AND at>? AND at<=?").all(prevAt,review.timestamp).map(r=>JSON.parse(r.payload));
    const covered=runs.some(r=>r.reasons.some(x=>!CONSEQUENCE.has(x.rule)));
    const changes=decisionChanges(this.lastReview,review);
    this.save('review',{at:review.timestamp,reviewId:review.id,trigger:review.trigger,covered,coveredBy:[...new Set(runs.flatMap(r=>r.reasons.map(x=>x.rule)))],costUSD:costUSD??null,action:review.decision?.action??null,changes});this.lastReview=review;
  }
  // Savings and safety, reported apart. projected cost: proposed runs at the median actual review cost.
  summary(since=0){
    const rows=this.db.prepare('SELECT kind,payload FROM schedule_observations WHERE at>=? ORDER BY at').all(since).map(r=>({kind:r.kind,...JSON.parse(r.payload)}));
    const reviews=rows.filter(r=>r.kind==='review'),runs=rows.filter(r=>r.kind==='proposed-run');const costs=reviews.map(r=>r.costUSD).filter(Number.isFinite).sort((a,b)=>a-b);
    const median=costs.length?costs[Math.floor(costs.length/2)]:null;const actual=costs.reduce((a,b)=>a+b,0);const projected=median==null?null:runs.length*median;
    const rules={};for(const r of runs)for(const x of r.reasons)rules[x.rule]=(rules[x.rule]??0)+1;
    return {since:new Date(since).toISOString(),settings:this.settings,actualReviews:reviews.length,proposedRuns:runs.length,actualCostUSD:Math.round(actual*1e4)/1e4,projectedCostUSD:projected==null?null:Math.round(projected*1e4)/1e4,rules,backstops:runs.filter(r=>r.backstop).length,
      uncoveredMaterial:reviews.filter(r=>!r.covered&&r.changes.material.length).map(r=>({at:new Date(r.at).toISOString(),reviewId:r.reviewId,changes:r.changes.material})),
      uncoveredTextOnly:reviews.filter(r=>!r.covered&&!r.changes.material.length&&r.changes.text.length).length,uncovered:reviews.filter(r=>!r.covered).length};
  }
}
module.exports={ScheduleObserver,reasons,decisionChanges,DEFAULTS,EVENT_TRIGGERS};
