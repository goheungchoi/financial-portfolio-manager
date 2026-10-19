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
// Targets the review gave no verdict on (planVerdicts); used to log incomplete accounting, never to fail a review.
function missingVerdicts(context,decision){const targets=context?.scoutPlan?.targets??[];if(!targets.length)return [];const seen=new Set((decision?.planVerdicts??[]).map(f=>f.symbol));return targets.map(t=>t.symbol).filter(s=>!seen.has(s));}
module.exports={planGap,missingVerdicts,marketOf};
