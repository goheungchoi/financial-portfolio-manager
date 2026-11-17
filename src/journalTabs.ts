// Journal redesign (1.5.50, artifacts/reviews/2026-11-11-next-update/journal-plan.md): the tab model and the decision
// summary, kept apart from the components so they can be tested on their own.
import type {DeskState} from './RuntimeSettings';
// J1: one row of six tabs, Decisions first.
export const JOURNAL_TABS=['Decisions','Orders and triggers','Trades','Lessons','Scoreboard','Replay'] as const;
// A saved tab that no longer exists opens Decisions; the earlier "Reviewed lessons" is now Lessons.
export const journalTab=(saved:string|null|undefined):string=>saved==='Reviewed lessons'?'Lessons':(JOURNAL_TABS as readonly string[]).includes(String(saved))?String(saved):'Decisions';
// Badges: armed conditional orders, and lessons awaiting review (as before). unmonitored: orders are armed but not
// checked, because auto trading is paused.
export function journalBadges(state:{desk?:DeskState|null;lessons:{lifecycle?:{status:string}|null}[]}):{'Orders and triggers':number;Lessons:number;unmonitored:boolean}{
  const armed=state.desk?.orders?.length??0,pending=state.lessons.filter(l=>!l.lifecycle||['pending','needs-review'].includes(l.lifecycle.status)).length;
  return {'Orders and triggers':armed,Lessons:pending,unmonitored:armed>0&&state.desk?.monitoringActive===false};
}
// J2: the first sentences of an explanation, and whether there is more.
export function firstSentences(text:string,n=3):{short:string;more:boolean}{
  const parts=String(text??'').match(/[^.!?]+(?:[.!?]+["”’)]*|$)\s*/g)?.filter(s=>s.trim())??[];
  return {short:parts.slice(0,n).join('').trim(),more:parts.length>n};
}
// What became of the review's order, for the Journal's pill and its Order fact. An order the engine saved is not
// necessarily sent: one refused before it left the app (KIS's request limit, an expired check, its session closed, an
// unconfirmed credit path) is recorded with an id. Until 2026-11-17 the pill said "Order submitted" for every order with
// an id. orderOutcome is the engine's status and reason, recorded from that date; an older record falls back on its note.
type OrderRecord={proposalId?:string|null;orderId?:string|null;executionNote?:string|null;orderOutcome?:{status?:string|null;reason?:string|null}|null};
const NOT_SENT=['ORDER_NOT_SENT','SESSION_CLOSED','CREDIT_PATH_UNVERIFIED'];
export function orderPill(review:OrderRecord):string{
  if(!review.orderId)return review.proposalId?'Proposal created':'No order';
  const o=review.orderOutcome;
  if(!o)return /^Not sent/.test(review.executionNote??'')?'Not sent':'Order sent';
  if(o.status==='Rejected')return NOT_SENT.includes(o.reason??'')?'Not sent':'Rejected by KIS';
  if(o.status==='Uncertain'||o.status==='Submitting')return 'Unclear: check KIS';
  return 'Order sent';}
// J2: up to three facts the decision already records. A fact that is not recorded is left out: no placeholder, no guess.
export function decisionFacts(review:OrderRecord&{decision:{plan?:{thesis?:string}|null}},usage?:{calls:number;micro:number}|null):{label:string;value:string}[]{
  const facts=[{label:'Order',value:orderPill(review)}];
  const thesis=typeof review.decision.plan?.thesis==='string'?review.decision.plan.thesis.trim():'';if(thesis)facts.push({label:'Plan',value:firstSentences(thesis,1).short});
  if(usage&&Number.isFinite(usage.calls)&&usage.calls>0)facts.push({label:'AI',value:`${usage.calls} AI call${usage.calls>1?'s':''}${Number.isFinite(usage.micro)&&usage.micro>0?usage.micro<5000?' · < $0.01':` · $${(usage.micro/1e6).toFixed(2)}`:''}`});
  return facts;
}
