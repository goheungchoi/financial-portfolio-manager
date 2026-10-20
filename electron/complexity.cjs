// Routing assessment for one review, computed before a model is chosen and with no AI call (see docs/ROUTING-EVALUATION.md).
// Two separate questions:
//   consequence  is enough at stake to need the configured model regardless? Measured against total equity: the largest
//                held position and the largest new position the sizing rules allow, when a market can trade now.
//                It never depends on what a model proposes, so it also covers inaction.
//   difficulty   does this case need stronger reasoning? Signals are grouped by underlying event: a group counts its
//                strongest signal and distinct groups add. The review's trigger adds nothing by itself.
// Every feature records its source: 'snapshot' (this context), 'baseline' (against the last review on the configured
// model, so moves add up while the cheaper model runs) or 'previous-review' (the last review's own outputs).
// The previous review's rating of the next decision can only raise the score, from either model, and expires once
// something material has changed since that review.
const POINTS={move3:15,move15:8,regime:8,breadthShift:5,breadthExtreme:6,fear:4,news:10,earningsHeld:16,earningsCandidate:10,macro:6,overPlan:6,passedTarget:6,lowConfidence:6};
const AGENT_SHARE=0.3,GATE_PCT=20;
const iso=t=>new Date(t+9*3600000).toISOString().slice(0,10);
const breadth=c=>c?.marketRegime?.components?.find(x=>x.name==='KOSPI advancers %')?.value??null;
const usdKrw=c=>c?.fx?.usdKRW??c?.macro?.indicators?.find(i=>i.name==='USD/KRW')?.value??null;
// Total equity in KRW: the combined figure when present, else each market's equity with USD at the current rate.
function equityKRW(c){if(Number.isFinite(c?.equity)&&c.equity>0&&c.currency!=='USD')return c.equity;const rate=usdKrw(c);let total=0;for(const m of c?.markets??[]){if(!Number.isFinite(m.equity))continue;total+=m.currency==='USD'?(rate?m.equity*rate:0):m.equity;}return total>0?total:null;}
function consequence(c,gatePct=GATE_PCT){
  const equity=equityKRW(c);const rate=usdKrw(c);const tradable=(c?.markets??[]).filter(m=>m.executionEnabled&&m.marketSession?.open).map(m=>m.market);
  const price=s=>(c?.quotes??[]).find(q=>q.symbol===s)?.price;
  const held=Object.entries(c?.positions??{}).filter(([,p])=>p&&(p.quantity??0)>0).map(([symbol,p])=>{const px=price(symbol);const native=px>0?px*p.quantity:p.costTotal??0;const krw=(p.currency??(/:/.test(symbol)?'USD':'KRW'))==='USD'?(rate?native*rate:null):native;return {symbol,weightPct:equity&&krw!=null?krw/equity*100:null};});
  const largestHeld=held.reduce((a,b)=>(b.weightPct??0)>(a?.weightPct??0)?b:a,null);
  const largestNew=(c?.positionSizing?.rows??[]).filter(r=>r.maxShares>0&&Number.isFinite(r.maxWeightPct)).reduce((a,b)=>b.maxWeightPct>(a?.maxWeightPct??0)?b:a,null);
  const reasons=[];
  if(tradable.length&&largestHeld?.weightPct>=gatePct)reasons.push(`${largestHeld.symbol} is ${largestHeld.weightPct.toFixed(0)}% of equity`);
  if(tradable.length&&largestNew&&largestNew.maxWeightPct>=gatePct)reasons.push(`a new ${largestNew.symbol} position could be ${largestNew.maxWeightPct.toFixed(0)}% of equity`);
  return {gate:reasons.length>0,gatePct,equityKRW:equity,tradableMarkets:tradable,largestHeldPct:largestHeld?.weightPct??null,largestNewPct:largestNew?.maxWeightPct??null,reasons};
}
function assess(context,{baseline=null,previousReview=null,now=Date.now(),gatePct=GATE_PCT}={}){
  const features=[];const groups={price:0,market:0,news:0,events:0,conflict:0,confidence:0};
  const feature=(group,points,source,detail)=>{features.push({group,points,source,detail});};
  const held=new Set(Object.entries(context?.positions??{}).filter(([,p])=>p&&(p.quantity??0)>0).map(([s])=>s));const targets=context?.scoutPlan?.targets??[];
  const watched=new Set([...held,...targets.map(t=>t.symbol)]);const tradable=new Set((context?.markets??[]).filter(m=>m.executionEnabled&&m.marketSession?.open).map(m=>m.market));
  // price: per watched symbol, its move since the baseline and its fresh move from the previous close; the group counts the largest.
  const before=new Map((baseline?.quotes??[]).map(q=>[q.symbol,q.price]));
  for(const q of context?.quotes??[]){if(!watched.has(q.symbol)||!(q.price>0))continue;const p=before.get(q.symbol);
    if(p>0){const m=Math.abs(q.price/p-1)*100;if(m>=1.5)feature('price',m>=3?POINTS.move3:POINTS.move15,'baseline',`${q.symbol} moved ${m.toFixed(1)}% since the last main-model review`);}
    if(!q.stale&&Math.abs(q.changePct??0)>=1.5){const m=Math.abs(q.changePct);feature('price',m>=3?POINTS.move3:POINTS.move15,'snapshot',`${q.symbol} ${q.changePct>0?'+':''}${q.changePct}% on the day`);}}
  // market: one stress picture, counted once.
  if(baseline?.marketRegime?.regime&&context?.marketRegime?.regime&&baseline.marketRegime.regime!==context.marketRegime.regime)feature('market',POINTS.regime,'baseline',`regime changed to ${context.marketRegime.regime}`);
  const b0=breadth(baseline),b1=breadth(context);if(b0!=null&&b1!=null&&Math.abs(b1-b0)>=15)feature('market',POINTS.breadthShift,'baseline',`KOSPI breadth moved ${Math.round(b1-b0)} points`);
  if(b1!=null&&(b1<=20||b1>=80))feature('market',POINTS.breadthExtreme,'snapshot',`KOSPI breadth ${Math.round(b1)}% advancing`);
  if(context?.marketRegime?.components?.some(x=>x.name==='VIX 5-day change %'&&x.value>=20))feature('market',POINTS.fear,'snapshot','VIX up 20% or more in 5 days');
  // news: important items not in the baseline.
  if(baseline){const seen=new Set((baseline.news??[]).map(n=>n.title));const fresh=(context?.news??[]).filter(n=>n.importance==='high'&&!seen.has(n.title));if(fresh.length)feature('news',POINTS.news,'baseline',`${fresh.length} new important news item${fresh.length===1?'':'s'}`);}
  // events: within a day; candidates only in a market that can trade now.
  const today=iso(now),tomorrow=iso(now+86400000);const soon=e=>e.date>=today&&e.date<=tomorrow;const candidates=new Set([...targets.map(t=>t.symbol),...(context?.universe??[]).map(u=>u.symbol)]);
  for(const e of (context?.eventCalendar??[]).filter(soon)){
    if(e.kind==='earnings'&&held.has(e.symbol))feature('events',POINTS.earningsHeld,'snapshot',`earnings within a day for holding ${e.symbol}`);
    else if(e.kind==='earnings'&&candidates.has(e.symbol)&&tradable.has(/:/.test(e.symbol)?'US':'KR'))feature('events',POINTS.earningsCandidate,'snapshot',`earnings within a day for candidate ${e.symbol}`);
    else if(e.kind==='macro'&&/FOMC|CPI|jobs report|PCE|GDP/i.test(e.title))feature('events',POINTS.macro,'snapshot',`${e.title} within a day`);}
  // conflict: distinct conflicts add (up to 12).
  const sizing=new Map((context?.positionSizing?.rows??[]).map(r=>[r.symbol,r]));
  const over=targets.filter(t=>Number.isFinite(t.targetWeightPct)&&sizing.get(t.symbol)&&t.targetWeightPct>sizing.get(t.symbol).maxWeightPct+5);if(over.length)feature('conflict',POINTS.overPlan,'snapshot',`the plan wants more ${over[0].symbol} than the sizing rules allow`);
  const passed=(previousReview?.decision?.planVerdicts??[]).filter(v=>v.verdict==='passed'&&targets.some(t=>t.symbol===v.symbol&&['add','candidate'].includes(t.role)));if(passed.length)feature('conflict',POINTS.passedTarget,'previous-review',`the last review passed on ${passed[0].symbol}, which the scout still recommends`);
  if(previousReview?.decision?.plan?.confidence==='low')feature('confidence',POINTS.lowConfidence,'previous-review','the last review had low confidence');
  for(const g of Object.keys(groups)){const pts=features.filter(f=>f.group===g).map(f=>f.points);groups[g]=g==='conflict'?Math.min(12,pts.reduce((a,b)=>a+b,0)):pts.length?Math.max(...pts):0;}
  const rule=Math.min(100,Object.values(groups).reduce((a,b)=>a+b,0));
  // The previous review's rating: escalation only, and only while nothing material has changed since it.
  const self=previousReview?.decision?.complexity?.score;
  const material=features.some(f=>f.source==='baseline'&&(f.group==='price'||f.group==='news'||f.detail.startsWith('regime changed')));
  let score=rule,agent=null;
  if(Number.isFinite(self)){const raised=Math.round(rule*(1-AGENT_SHARE)+self*AGENT_SHARE);agent={score:self,model:previousReview.routing?.model??previousReview.model??null,reasons:previousReview.decision.complexity.reason??null,expired:material,applied:!material&&raised>rule};if(agent.applied)score=raised;}
  return {score,rule,groups,features,agent,consequence:consequence(context,gatePct)};
}
// Differences between two decisions on the same inputs (docs/ROUTING-EVALUATION.md section 4).
// priceKRW is the trade price in won (U.S. prices converted), so a size difference is measured against equity in won.
function triage(a,b,{equityKRW=null,priceKRW=null}={}){
  if(!a||!b)return 'missing';const verdicts=d=>JSON.stringify((d.planVerdicts??[]).map(v=>[v.symbol,v.verdict]).sort());
  if(a.action!==b.action)return 'action';if(a.action!=='Hold'&&a.symbol!==b.symbol)return 'symbol';
  if(a.action!=='Hold'){const qa=a.quantity||0,qb=b.quantity||0;const rel=Math.abs(qa-qb)/Math.max(qa,qb,1);const pct=equityKRW&&priceKRW?Math.abs(qa-qb)*priceKRW/equityKRW*100:0;if(rel>0.25||pct>=1)return 'size';}
  if(verdicts(a)!==verdicts(b))return 'verdict';
  return a.explanation===b.explanation?'same':'wording';
}
// For live complexity routing (not enabled until the evaluation passes): the difficulty score with its reasons.
function score(context,{previous=null,previousReview=null,now=Date.now()}={}){const r=assess(context,{baseline:previous,previousReview,now});return {score:r.score,rule:r.rule,parts:r.groups,agent:r.agent,reasons:r.features.map(f=>f.detail),consequence:r.consequence};}
module.exports={assess,consequence,triage,score,equityKRW,usdKrw,POINTS,GATE_PCT};
