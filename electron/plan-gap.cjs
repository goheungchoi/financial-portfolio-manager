// Where the portfolio stands against the scout's plan, as plain figures: cash and invested share per market and,
// for each target, its planned weight next to the weight held now. Target weights are shares of equity in the
// target's own market, as the scout defines them. Facts only; the review decides what, if anything, to do.
const marketOf=symbol=>String(symbol).includes(':')?'US':'KR';
const pct=(part,whole)=>whole>0?Math.round(part/whole*1000)/10:null;
function planGap(context){
  const plan=context?.scoutPlan;if(!plan?.targets?.length)return null;
  const markets=Array.isArray(context.markets)&&context.markets.length?context.markets:[{market:context.market??'KR',equity:context.equity,cash:typeof context.cash==='number'?context.cash:context.cash?.[context.currency??'KRW']}];
  const price=symbol=>(context.quotes??[]).find(q=>q.symbol===symbol)?.price??(context.universe??[]).find(u=>u.symbol===symbol)?.price??null;
  const held=symbol=>{const q=context.positions?.[symbol]?.quantity??0,p=price(symbol);return q>0&&p>0?q*p:0;};
  const byMarket=Object.fromEntries(markets.map(m=>[m.market,m]));
  const targets=plan.targets.map(t=>{const m=byMarket[marketOf(t.symbol)];const heldPct=m?pct(held(t.symbol),m.equity)??0:null;
    return {symbol:t.symbol,name:t.name,role:t.role,targetPct:t.targetWeightPct??null,heldPct,gapPct:t.targetWeightPct==null||heldPct==null?null:Math.round((t.targetWeightPct-heldPct)*10)/10};});
  const summary=markets.filter(m=>m.equity>0).map(m=>{const inMarket=targets.filter(t=>marketOf(t.symbol)===m.market&&t.targetPct!=null);
    return {market:m.market,cashPct:pct(m.cash??0,m.equity),investedPct:Math.round((100-(pct(m.cash??0,m.equity)??0))*10)/10,...(inMarket.length?{plannedInvestedPct:Math.round(inMarket.reduce((s,t)=>s+t.targetPct,0)*10)/10}:{})};});
  return {planAsOf:plan.asOf,planCashTargetPct:plan.cashTargetPct??null,markets:summary,targets};
}
// The smallest feasible position for each target: one share, as a share of total equity, and whether cash, the sizing
// rules and the caps allow it. Facts for the review's comparison with staying in cash; one share can be a large weight.
// Only for targets the plan may buy (BUY_ROLES: add and candidate; plan-verdicts check, 2026-11-25): for a hold, trim or exit
// target one share or cash is not the plan's question, so it has no minimumPosition and raises no issue (verdictIssues).
const BUY_ROLES=new Set(['add','candidate']);
function addMinimumPositions(context){
  const gap=context?.planGap;if(!gap?.targets?.length)return context;const C=require('./complexity.cjs');
  const equity=C.equityKRW(context),fx=C.usdKrw(context);const markets=C.marketsOf(context);
  const price=s=>(context.quotes??[]).find(q=>q.symbol===s)?.price??null;const sizing=new Map((context.positionSizing?.rows??[]).map(r=>[r.symbol,r]));
  const cashKRW=m=>{if(m==='US'){const us=markets.find(x=>x.market==='US');const usd=us?.buyingPower?.usd??(typeof context.cash==='object'?context.cash?.USD:context.currency==='USD'?context.cash:null);return fx&&Number.isFinite(usd)?usd*fx:null;}return typeof context.cash==='object'?context.cash?.KRW??null:context.currency==='KRW'?context.cash:null;};
  // The trading limits of the target's market: per market in a combined context, the context's own in a single-market one.
  const policyOf=m=>context.risk?.markets?context.risk.markets[m]??{}:(context.market??'KR')===m?context.risk??{}:{};
  // The account value the order checks use: the U.S. side adds the KRW that funds its buys through integrated margin.
  const marketEquity=m=>{const x=Array.isArray(context.markets)&&context.markets.length?context.markets.find(r=>r.market===m):context;const equity=x?.equity;
    return Number.isFinite(equity)?equity+(m==='US'?Number(x.buyingPower?.fromKRWUSD)||0:0):null;};
  // Whether the target's market takes the app's orders now (plan verdicts, 2026-11-19): the marketSession the engine
  // reported for this review, the app's order window (the regular session, or an extended one switched on), as the
  // automatic send checks it. A market this context does not cover is closed to it; no session reported is unknown.
  const sessionOf=m=>Array.isArray(context.markets)&&context.markets.length?context.markets.find(x=>x.market===m)?.marketSession:(context.market??'KR')===m?context.marketSession:{open:false};
  const marketOpen=m=>{const s=sessionOf(m);return s&&typeof s.open==='boolean'?s.open:null;};
  for(const t of gap.targets){if(!BUY_ROLES.has(t.role))continue;const m=marketOf(t.symbol);const p=price(t.symbol);const value=p>0?(m==='US'?(fx?p*fx:null):p):null;
    if(value==null||!(equity>0)){t.minimumPosition={shares:1,unavailable:'price or equity unknown'};continue;}
    const cash=cashKRW(m);const row=sizing.get(t.symbol);const policy=policyOf(m);
    // As the order checks apply them: the order limit to one share in the market's currency, and concentration to the
    // shares already held plus one, against that market's account value (an account with nothing fails it).
    const held=context.positions?.[t.symbol]?.quantity??0;const base=marketEquity(m);
    const checks={cash:cash==null?null:cash>=value,sizing:row?row.maxShares>=1:null,
      companyCap:Number.isFinite(policy.maxCompanyPct)?base>0&&(held+1)*p/base*100<=policy.maxCompanyPct:null,orderCap:Number.isFinite(policy.maxOrderKRW)?p<=policy.maxOrderKRW:null,marketOpen:marketOpen(m)};
    t.minimumPosition={shares:1,valueKRW:Math.round(value),weightPct:Math.round(value/equity*1000)/10,checks,feasible:Object.values(checks).every(v=>v!==false)&&checks.cash===true};}
  return context;
}
// Verdict quality the decision format cannot enforce on its own: logged as incomplete, never used to fail a review.
// earlier: the plan verdicts of this account's earlier reviews the same Seoul day (plan verdicts step 2, 2026-11-19). A
// comparison given there for the same symbol, verdict and condition (kind, waitReason, recheck) still counts, so an
// unchanged wait is not asked for it again every review. It is not copied into this decision.
const sameCondition=(a,b)=>String(a?.kind??'')===String(b?.kind??'')&&String(a?.waitReason??'')===String(b?.waitReason??'')&&String(a?.recheck??'').trim()===String(b?.recheck??'').trim();
function comparedToday(v,earlier){return (earlier??[]).some(e=>e&&e.symbol===v.symbol&&e.verdict===v.verdict&&e.minimumPosition&&sameCondition(e.condition,v.condition));}
function verdictIssues(context,decision,{earlier=[]}={}){
  const issues=[];const targets=new Map((context?.planGap?.targets??[]).map(t=>[t.symbol,t]));const vague=/^(stronger evidence|more evidence|sustained stabili[sz]ation|better (entry|after-cost case)|improvement|stabili[sz]ation)\.?$/i;
  for(const v of decision?.planVerdicts??[]){const c=v.condition;
    if(v.verdict==='waiting'){if(!c||!c.unresolved||!c.evidence||!c.recheck||c.kind==='none')issues.push(`${v.symbol}: waiting without a specific condition, resolving evidence and recheck`);else if(vague.test(c.evidence.trim()))issues.push(`${v.symbol}: the resolving evidence is vague`);
      if(c?.kind==='data'&&!v.dataGap)issues.push(`${v.symbol}: missing data without a data-gap assessment`);}
    if(['waiting','passed'].includes(v.verdict)&&BUY_ROLES.has(targets.get(v.symbol)?.role)&&targets.get(v.symbol)?.minimumPosition?.feasible&&!v.minimumPosition&&!comparedToday(v,earlier))issues.push(`${v.symbol}: no comparison of buying one share with staying in cash (market open, none given today)`);}
  if(decision?.action==='Hold'&&!String(decision.plan?.invalidation??'').trim())issues.push('Hold without a reconsideration condition (plan.invalidation)');
  // A gap at its retry limit should not produce the same data wait again.
  // A wait on the same gap (the same identity) is another exhausted wait; a wait on different evidence starts afresh,
  // unless the symbol's data waits as a whole reached their limit, which no new wording resets.
  const RG=require('./research-gaps.cjs');
  for(const g of context?.researchGaps??[])if(g.status==='retry limit reached'){const v=(decision?.planVerdicts??[]).find(x=>x.symbol===g.symbol);if(v?.verdict!=='waiting'||v.condition?.kind!=='data')continue;
    const whole=(g.symbolWait?.dataReviews??0)>=RG.STREAK_LIMIT;if(whole||!g.id||RG.gapIdentity(v.symbol,v).id===g.id)issues.push(`${g.symbol}: still waiting on data after ${whole?g.symbolWait.dataReviews:g.reviews} reviews (retry limit reached)`);}
  return issues;
}
// Targets the review gave no verdict on (planVerdicts); used to log incomplete accounting, never to fail a review.
function missingVerdicts(context,decision){const targets=context?.scoutPlan?.targets??[];if(!targets.length)return [];const seen=new Set((decision?.planVerdicts??[]).map(f=>f.symbol));return targets.map(t=>t.symbol).filter(s=>!seen.has(s));}
// The app's own weight of a proposed Buy's symbol before and after, against total equity, for comparison with the
// weights the review stated in plan.portfolioImpact. Null when equity or the price is unknown.
function impactCheck(context,decision){
  const C=require('./complexity.cjs');const equity=C.equityKRW(context),fx=C.usdKrw(context);const s=decision.symbol;const q=(context.quotes??[]).find(x=>x.symbol===s);
  const unit=q?.price>0?(marketOf(s)==='US'?(fx?q.price*fx:null):q.price):null;if(!(equity>0)||unit==null)return null;
  const held=context.positions?.[s]?.quantity??0;const pct=v=>Math.round(v/equity*1000)/10;
  const before=pct(held*unit),after=pct((held+(decision.quantity||0))*unit);const stated=decision.plan.portfolioImpact;
  return {appWeightBeforePct:before,appWeightAfterPct:after,statedWeightAfterPct:stated.weightAfterPct,differencePts:Math.round(Math.abs(after-stated.weightAfterPct)*10)/10,equityReliable:context.equityReliability?.reliable??null};
}
module.exports={BUY_ROLES,planGap,missingVerdicts,marketOf,addMinimumPositions,verdictIssues,impactCheck};
