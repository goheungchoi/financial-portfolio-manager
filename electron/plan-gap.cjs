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
  for(const t of gap.targets){const m=marketOf(t.symbol);const p=price(t.symbol);const value=p>0?(m==='US'?(fx?p*fx:null):p):null;
    if(value==null||!(equity>0)){t.minimumPosition={shares:1,unavailable:'price or equity unknown'};continue;}
    const cash=cashKRW(m);const row=sizing.get(t.symbol);const policy=policyOf(m);
    // As the order checks apply them: the order limit to one share in the market's currency, and concentration to the
    // shares already held plus one, against that market's account value (an account with nothing fails it).
    const held=context.positions?.[t.symbol]?.quantity??0;const base=marketEquity(m);
    const checks={cash:cash==null?null:cash>=value,sizing:row?row.maxShares>=1:null,
      companyCap:Number.isFinite(policy.maxCompanyPct)?base>0&&(held+1)*p/base*100<=policy.maxCompanyPct:null,orderCap:Number.isFinite(policy.maxOrderKRW)?p<=policy.maxOrderKRW:null};
    t.minimumPosition={shares:1,valueKRW:Math.round(value),weightPct:Math.round(value/equity*1000)/10,checks,feasible:Object.values(checks).every(v=>v!==false)&&checks.cash===true};}
  return context;
}
// Verdict quality the decision format cannot enforce on its own: logged as incomplete, never used to fail a review.
function verdictIssues(context,decision){
  const issues=[];const targets=new Map((context?.planGap?.targets??[]).map(t=>[t.symbol,t]));const vague=/^(stronger evidence|more evidence|sustained stabili[sz]ation|better (entry|after-cost case)|improvement|stabili[sz]ation)\.?$/i;
  for(const v of decision?.planVerdicts??[]){const c=v.condition;
    if(v.verdict==='waiting'){if(!c||!c.unresolved||!c.evidence||!c.recheck||c.kind==='none')issues.push(`${v.symbol}: waiting without a specific condition, resolving evidence and recheck`);else if(vague.test(c.evidence.trim()))issues.push(`${v.symbol}: the resolving evidence is vague`);
      if(c?.kind==='data'&&!v.dataGap)issues.push(`${v.symbol}: missing data without a data-gap assessment`);}
    if(['waiting','passed'].includes(v.verdict)&&targets.get(v.symbol)?.minimumPosition?.feasible&&!v.minimumPosition)issues.push(`${v.symbol}: no comparison of the minimum feasible position with cash`);}
  if(decision?.action==='Hold'&&!String(decision.plan?.invalidation??'').trim())issues.push('Hold without a reconsideration condition (plan.invalidation)');
  return issues;
}
// Targets the review gave no verdict on (planVerdicts); used to log incomplete accounting, never to fail a review.
function missingVerdicts(context,decision){const targets=context?.scoutPlan?.targets??[];if(!targets.length)return [];const seen=new Set((decision?.planVerdicts??[]).map(f=>f.symbol));return targets.map(t=>t.symbol).filter(s=>!seen.has(s));}
module.exports={planGap,missingVerdicts,marketOf,addMinimumPositions,verdictIssues};
