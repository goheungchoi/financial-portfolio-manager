// Decision complexity: how hard the review about to run is likely to be, from 0 to 100, computed from the review
// context with no AI call. It predicts whether the cheaper model could decide differently from the configured one.
// Three parts plus the previous review's own rating:
//   stakes    what a wrong call could cost: positions held, buying power the sizing allows, a regular session open
//   change    what is new since the last review on the configured model (so moves add up while the cheaper model runs):
//             price moves, important news, a trigger, a regime shift, a new scout plan
//   ambiguity how close the call is: a stressed day (sharp moves from the previous close, extreme breadth, fear rising),
//             earnings or major data within a day, low confidence last time
// previous is the context of the last review on the configured model; previousReview is the latest review of any model.
// The previous review's rating counts fully when the configured model wrote it; a cheaper model's rating can only
// raise the score, since it may misjudge its own limits.
const WEIGHTS={positions:12,bigPosition:5,buyable:8,regular:10,extended:4,move3:15,move15:8,news:10,trigger:10,regime:8,breadth:5,plan:6,earningsHeld:16,earningsCandidate:10,macro:6,lowConfidence:6,dayMove:8,extremeBreadth:6,fear:4,agentShare:0.3};
const CAPS={stakes:35,change:35,ambiguity:30};
const iso=t=>new Date(t+9*3600000).toISOString().slice(0,10);
const breadth=c=>c?.marketRegime?.components?.find(x=>x.name==='KOSPI advancers %')?.value??null;
const positionsOf=c=>Object.entries(c?.positions??{}).filter(([,p])=>p&&(p.quantity??0)>0);
function score(context,{previous=null,previousReview=null,strongModel=null,now=Date.now()}={}){
  const reasons=[];const add=(part,points,reason)=>{if(points>0){parts[part]+=points;reasons.push(reason);}};const parts={stakes:0,change:0,ambiguity:0};
  // Stakes
  const held=positionsOf(context);if(held.length)add('stakes',WEIGHTS.positions,`${held.length} position${held.length===1?'':'s'} held`);
  if(held.some(([,p])=>Math.abs(p.unrealizedPct??p.returnPct??0)>=5))add('stakes',WEIGHTS.bigPosition,'a position is up or down 5% or more');
  const buyable=(context?.positionSizing?.rows??[]).some(r=>r.maxShares>0)||(context?.markets??[]).some(m=>m.market==='US'&&(m.buyingPower?.usd??0)>0);if(buyable)add('stakes',WEIGHTS.buyable,'buying power the sizing allows');
  const tradable=(context?.markets??[]).filter(m=>m.executionEnabled&&m.marketSession?.open);
  const regular=m=>m.marketSession?.session?m.marketSession.session.regular===true:true;
  if(tradable.some(regular))add('stakes',WEIGHTS.regular,'a regular session is open');
  else if(tradable.length)add('stakes',WEIGHTS.extended,'only an extended session is open');
  // Change since the previous review
  if(previous){
    const before=new Map((previous.quotes??[]).map(q=>[q.symbol,q.price]));const watch=new Set([...held.map(([s])=>s),...(context.scoutPlan?.targets??[]).map(t=>t.symbol)]);
    let biggest=0,which=null;for(const q of context.quotes??[]){const p=before.get(q.symbol);if(!(p>0)||!(q.price>0)||!watch.has(q.symbol))continue;const move=Math.abs(q.price/p-1)*100;if(move>biggest){biggest=move;which=q.symbol;}}
    if(biggest>=3)add('change',WEIGHTS.move3,`${which} moved ${biggest.toFixed(1)}% since the last review`);else if(biggest>=1.5)add('change',WEIGHTS.move15,`${which} moved ${biggest.toFixed(1)}% since the last review`);
    const seen=new Set((previous.news??[]).map(n=>n.title));const fresh=(context.news??[]).filter(n=>n.importance==='high'&&!seen.has(n.title));if(fresh.length)add('change',WEIGHTS.news,`${fresh.length} new important news item${fresh.length===1?'':'s'}`);
    if(previous.marketRegime?.regime&&context.marketRegime?.regime&&previous.marketRegime.regime!==context.marketRegime.regime)add('change',WEIGHTS.regime,`regime changed to ${context.marketRegime.regime}`);
    const b0=breadth(previous),b1=breadth(context);if(b0!=null&&b1!=null&&Math.abs(b1-b0)>=15)add('change',WEIGHTS.breadth,`KOSPI breadth moved ${Math.round(b1-b0)} points`);
    if(context.scoutPlan?.asOf&&context.scoutPlan.asOf!==previous.scoutPlan?.asOf)add('change',WEIGHTS.plan,'a new scout plan');
  }
  if(context?.triggerEvidence)add('change',WEIGHTS.trigger,`started by a ${context.triggerEvidence.kind??'market'} trigger`);
  // Ambiguity
  const today=iso(now),tomorrow=iso(now+86400000);const soon=e=>e.date>=today&&e.date<=tomorrow;const heldSet=new Set(held.map(([s])=>s));const candidates=new Set([...(context?.scoutPlan?.targets??[]).map(t=>t.symbol),...(context?.universe??[]).map(u=>u.symbol)]);
  const earnings=(context?.eventCalendar??[]).filter(e=>e.kind==='earnings'&&soon(e));
  const heldEarnings=earnings.filter(e=>heldSet.has(e.symbol));const openMarkets=new Set(tradable.map(m=>m.market));const candEarnings=earnings.filter(e=>!heldSet.has(e.symbol)&&candidates.has(e.symbol)&&openMarkets.has(/:/.test(e.symbol)?'US':'KR'));
  if(heldEarnings.length)add('ambiguity',WEIGHTS.earningsHeld,`earnings within a day for a holding (${heldEarnings.map(e=>e.symbol).join(', ')})`);
  else if(candEarnings.length)add('ambiguity',WEIGHTS.earningsCandidate,`earnings within a day for a candidate (${candEarnings.map(e=>e.symbol).join(', ')})`);
  if((context?.eventCalendar??[]).some(e=>e.kind==='macro'&&soon(e)&&/FOMC|CPI|jobs report|PCE|GDP/i.test(e.title)))add('ambiguity',WEIGHTS.macro,'major U.S. data within a day');
  // A stressed day: a watched stock far from its previous close, very one-sided breadth, volatility jumping.
  const watched=new Set([...held.map(([s])=>s),...(context?.scoutPlan?.targets??[]).map(t=>t.symbol)]);const dayMoves=(context?.quotes??[]).filter(q=>watched.has(q.symbol)&&!q.stale&&Math.abs(q.changePct??0)>=3);
  if(dayMoves.length)add('ambiguity',WEIGHTS.dayMove,`${dayMoves[0].symbol} ${dayMoves[0].changePct>0?'+':''}${dayMoves[0].changePct}% on the day`);
  const b=breadth(context);if(b!=null&&(b<=20||b>=80))add('ambiguity',WEIGHTS.extremeBreadth,`KOSPI breadth ${Math.round(b)}% advancing`);
  if(context?.marketRegime?.components?.some(x=>x.name==='VIX 5-day change %'&&x.value>=20))add('ambiguity',WEIGHTS.fear,'VIX up 20% or more in 5 days');
  if(previousReview?.decision?.plan?.confidence==='low')add('ambiguity',WEIGHTS.lowConfidence,'the last review had low confidence');
  for(const k of Object.keys(parts))parts[k]=Math.min(parts[k],CAPS[k]);
  const rule=parts.stakes+parts.change+parts.ambiguity;
  // The previous review's own rating of how hard the next decision will be.
  const self=previousReview?.decision?.complexity?.score;let total=rule,agent=null;
  if(Number.isFinite(self)){const strong=!strongModel||previousReview.routing?.model===strongModel||!previousReview.routing;const blended=Math.round(rule*(1-WEIGHTS.agentShare)+self*WEIGHTS.agentShare);
    total=strong?blended:Math.max(rule,blended);agent={score:self,model:previousReview.routing?.model??null,counted:strong?'full':'upward only'};if(total!==rule)reasons.push(`the last review rated the next decision ${self}/100${strong?'':' (cheaper model, counted only upward)'}`);}
  return {score:Math.max(0,Math.min(100,Math.round(total))),rule,parts,agent,reasons};
}
module.exports={score,WEIGHTS,CAPS};
