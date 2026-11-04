// Position memory for trading reviews (audit 2026-11-04, Stage 4): per held or recently traded symbol, the last filled
// entry and the last filled exit, each with the review that decided it (id, rationale, thesis, invalidation, stop), the
// fill (time, price, quantity, partial or not), the quote the review saw, and how many reviews have run since. Only
// filled orders count: an unexecuted recommendation is not a decision the position rests on, and an intervening Hold
// never breaks the link. A review with no recorded rationale gives 'unavailable', never a guess.
// 2026-11-03: the Kia re-entry did not see that the Nov 2 sale required evidence of margin recovery.
const {effectOf}=require('./credit-paths.cjs');
const DAY=86400000,RECENT_DAYS=30,HELD_DAYS=365,LIMIT=10;
// A decision that opens a position within this many days of a filled exit in the same direction reverses that exit.
const REVERSAL_DAYS=30;
const clip=(t,n)=>{const s=String(t??'').trim().replace(/\s+/g,' ');return s.length>n?s.slice(0,n-1)+'…':s;};
const iso=t=>Number.isFinite(t)?new Date(t).toISOString():null;
const OPPOSITE={OPEN_LONG:'CLOSE_LONG',OPEN_SHORT:'CLOSE_SHORT',CLOSE_LONG:'OPEN_LONG',CLOSE_SHORT:'OPEN_SHORT'};
// One filled order as the review sees it. reviewAt: review id -> its time.
function view(o,reviewAt){const d=o.decision??null,p=d?.plan??null,q=o.reviewEvidence?.quote??null;
  return {decisionId:o.reviewId??null,decidedAt:iso(reviewAt.get(o.reviewId)),filledAt:iso(o.timestamp),effect:o.effect,...(o.credit?{credit:o.credit.kind,...(o.credit.loanDate?{loanDate:o.credit.loanDate}:{})}:{}),
    filled:o.quantity,requested:o.requested??o.quantity,...(o.requested>o.quantity?{partial:true}:{}),fillPrice:o.averagePrice??null,orderId:o.orderId??null,
    ...(q?{quoteAtDecision:{price:q.price??null,...(q.bid!=null?{bid:q.bid}:{}),...(q.ask!=null?{ask:q.ask}:{})}}:{}),
    rationale:d?.explanation?clip(d.explanation,500):'unavailable',...(p?{thesis:clip(p.thesis,240),invalidation:clip(p.invalidation,200),...(p.stopPrice!=null?{stopPrice:p.stopPrice}:{}),...(p.targetPrice!=null?{targetPrice:p.targetPrice}:{}),...(p.horizonDays!=null?{horizonDays:p.horizonDays}:{}),...(p.strategy?{strategy:p.strategy}:{})}:{})};}
// The memory rows. outcomes: trade_outcomes rows; accounts: the account keys of this review; positions: context
// positions; reviewAt: review id -> time; reviewsSince(symbol, time): reviews run since then.
function build(outcomes,{accounts=[],positions={},reviewAt=new Map(),reviewsSince=()=>null,now=Date.now()}={}){
  const filled=outcomes.filter(o=>o.source==='broker'&&accounts.includes(o.accountKey)&&o.quantity>0&&o.status!=='Retracted'&&/^(OPEN|CLOSE)_/.test(o.effect??'')).sort((a,b)=>a.timestamp-b.timestamp);
  const symbols=[...new Set(filled.map(o=>o.symbol))].map(symbol=>{const mine=filled.filter(o=>o.symbol===symbol),held=positions?.[symbol]?.quantity>0,last=mine.at(-1);
    return {symbol,held,last:last.timestamp,mine};}).filter(s=>now-s.last<=(s.held?HELD_DAYS:RECENT_DAYS)*DAY).sort((a,b)=>Number(b.held)-Number(a.held)||b.last-a.last).slice(0,LIMIT);
  return symbols.map(({symbol,held,mine})=>{const entry=mine.filter(o=>o.effect.startsWith('OPEN_')).at(-1),exit=mine.filter(o=>o.effect.startsWith('CLOSE_')).at(-1),last=mine.at(-1);
    return {symbol,holding:held?positions[symbol].quantity:0,lastMaterial:last===exit?'exit':'entry',...(entry?{lastEntry:view(entry,reviewAt)}:{}),...(exit?{lastExit:view(exit,reviewAt)}:{}),
      ...(Number.isFinite(reviewsSince(symbol,last.timestamp))?{reviewsSince:reviewsSince(symbol,last.timestamp)}:{})};});
}
// Whether a decision reverses the last filled decision on its symbol: an opening within REVERSAL_DAYS of a filled exit
// in the same direction (required: an unexplained one is withheld), or a reduction of a recent filled entry (asked
// for, never withheld: a reduction is protective). Returns {required, prior, kind} or null.
function reversalOf(decision,memory,{now=Date.now()}={}){if(!decision||decision.action==='Hold'||!Array.isArray(memory))return null;
  let eff;try{eff=effectOf({side:decision.action,credit:decision.credit&&decision.credit!=='none'?decision.credit:null}).effect;}catch{return null;}
  const row=memory.find(r=>r.symbol===decision.symbol);if(!row)return null;const prior=row.lastMaterial==='exit'?row.lastExit:row.lastEntry;
  if(!prior||prior.effect!==OPPOSITE[eff])return null;const t=Date.parse(prior.filledAt??'');if(!Number.isFinite(t)||now-t>REVERSAL_DAYS*DAY)return null;
  return {required:eff.startsWith('OPEN_'),kind:eff.startsWith('OPEN_')?'reverses-exit':'reverses-entry',prior};}
// What is missing from a reversal explanation, or null. Presence and consistency only: whether the reasoning is sound
// cannot be checked here. price: the current price.
function reversalGap(r,rev,{price=null}={}){if(!r)return 'no reversal explanation';const prior=rev.prior,unavailable=prior.rationale==='unavailable'||!prior.decisionId;
  if(r.priorDecisionId!==(unavailable?'unavailable':prior.decisionId)&&!(prior.decisionId&&r.priorDecisionId===prior.decisionId))return `priorDecisionId must name the filled decision it reverses (${unavailable?'unavailable':prior.decisionId})`;
  if(!['new-evidence','corrected-reasoning'].includes(r.basis))return 'no basis (new-evidence or corrected-reasoning)';
  if(clip(r.whatChanged,999).length<20)return 'whatChanged does not say what is different';
  if(clip(r.priorRequirement,999).length<10)return unavailable?'no current justification (the earlier rationale is unavailable)':'priorRequirement does not say how the earlier requirement or invalidation is met or why it no longer applies';
  if(r.basis==='new-evidence'){const since=Date.parse(prior.decidedAt??prior.filledAt??'');const ok=(r.newEvidence??[]).filter(e=>clip(e.claim,999)&&clip(e.source,999)&&Date.parse(e.date??'')>=(Number.isFinite(since)?since-DAY:0));if(!ok.length)return 'new-evidence without a sourced item dated after the earlier decision';}
  if(rev.kind==='reverses-exit'&&rev.prior.effect==='CLOSE_LONG'&&price>0&&prior.fillPrice>0&&price>prior.fillPrice&&clip(r.afterCost,999).length<20)return `afterCost: the price ${price} is above the exit fill ${prior.fillPrice}; say why the higher repurchase still pays after costs`;
  return null;}
module.exports={build,view,reversalOf,reversalGap,REVERSAL_DAYS};
