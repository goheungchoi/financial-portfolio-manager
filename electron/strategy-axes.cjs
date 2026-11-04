// A trade's strategy as four separate axes (audit 2026-11-04, Stage 4): horizon (long-term, swing, short-term), which
// the review chooses; direction (long or short) and funding (cash, margin or borrowed shares), derived from the
// validated order's position effect, so a Buy to cover closes a short and never becomes a long trade; and the
// instrument (unleveraged, leveraged, inverse or leveraged inverse, with its daily factor), from the security master
// and the user's product overrides, never from the review. A short holding period is not a short position, and a
// leveraged ETF is not a margin loan.
// Before: one strategy field mixed horizon with instrument (leveraged-tactical) and said nothing of direction or funding.
const {effectOf}=require('./credit-paths.cjs');
const HORIZONS=['long-term','swing','short-term'];
const INSTRUMENTS=['unleveraged','leveraged','inverse','leveraged-inverse'];
// The product risk section that applies to a symbol (a combined review keeps one per market).
function riskFor(context,symbol){const us=String(symbol).includes(':');return context?.productRisk??context?.markets?.find(m=>m.market===(us?'US':'KR'))?.productRisk??null;}
// The axes of a decision, or null for a Hold or an order whose effect cannot be determined.
function axesOf(decision,context){if(!decision||decision.action==='Hold')return null;let e;try{e=effectOf({side:decision.action,credit:decision.credit&&decision.credit!=='none'?decision.credit:null});}catch{return null;}
  const product=(riskFor(context,decision.symbol)?.products??[]).find(p=>p.symbol===decision.symbol),factor=product?.factor??1;
  return {horizon:HORIZONS.includes(decision.plan?.horizon)?decision.plan.horizon:null,direction:e.effect.endsWith('_SHORT')?'short':'long',effect:e.effect,funding:e.funding==='MARGIN'?'margin':e.funding==='SHORT'?'borrowed':'cash',
    instrument:product&&INSTRUMENTS.includes(product.kind)?product.kind:'unleveraged',leverageFactor:factor,inverse:factor<0};}
// The strategy label older records and the scoreboard use, derived from the axes: the horizon, or leveraged-tactical for
// a short-term leveraged or inverse trade; anything else is ambiguous and marked unknown rather than guessed.
function label(axes){if(!axes?.horizon)return 'unknown';if(axes.instrument==='unleveraged')return axes.horizon;return axes.horizon==='short-term'?'leveraged-tactical':'unknown';}
// Why an opening is not permitted on these axes, or null: every axis is checked against the account's permissions.
// A reduction (a sale, cover or repayment) is never refused here.
function gap(decision,context){const axes=axesOf(decision,context),plan=decision?.plan;if(!axes||!axes.effect.startsWith('OPEN_'))return null;const risk=riskFor(context,decision.symbol)??{};
  if(!axes.horizon)return 'no horizon (long-term, swing or short-term)';
  if(axes.instrument!=='unleveraged'){const l=risk.leveragedEtps;if(!l?.allowed)return `a ${axes.instrument} product (${axes.leverageFactor}x daily) is not permitted for this account`;
    if(plan?.horizonDays>l.maxHoldingDays)return `horizonDays ${plan.horizonDays} is longer than the ${l.maxHoldingDays}-day limit for leveraged or inverse products`;}
  if(axes.funding==='margin'&&!risk.credit?.margin?.allowed)return 'margin buying is not permitted for this account';
  if(axes.direction==='short'&&!risk.credit?.short?.allowed)return 'short selling is not permitted for this account';
  return null;}
module.exports={axesOf,label,gap,riskFor,HORIZONS,INSTRUMENTS};
