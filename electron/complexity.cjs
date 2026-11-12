// Equity and currency helpers for review contexts, used by plan-gap.cjs. The routing assessment that used to live
// here (score, consequence, triage) was removed with model routing in step A1 (artifacts/reviews/2026-11-12-engine-
// settings); docs/archive/ROUTING-EVALUATION.md describes it.
// Context sections may be shortened to fit a request (review-context.cjs reference): an array becomes
// {reference, incomplete, items: <count>, focusRows: [...rows about the review's symbols], ...}. A stored context of a
// shortened review is used as the next baseline, so every list read here accepts both shapes: the rows, or the focus
// rows a shortened section kept, or nothing (2026-11-10 23:32: news as an object made .map throw, and every review
// failed). Anything else is an empty list.
const rows=v=>Array.isArray(v)?v:v&&typeof v==='object'?(Array.isArray(v.focusRows)?v.focusRows:Array.isArray(v.items)?v.items:[]):[];
const list=(obj,key)=>rows(obj&&typeof obj==='object'?obj[key]:null);
const usdKrw=c=>c?.fx?.usdKRW??list(c?.macro,'indicators').find(i=>i?.name==='USD/KRW')?.value??null;
// Markets in a review context: a combined context lists them in markets[]; a single-market context carries the market,
// currency, equity, session and execution flags at its top level.
function marketsOf(c){if(Array.isArray(c?.markets))return c.markets.filter(m=>m&&typeof m==='object');if(!c||!c.market&&!c.currency)return [];
  return [{market:c.market??(c.currency==='USD'?'US':'KR'),currency:c.currency??'KRW',equity:c.equity,executionEnabled:c.executionEnabled,marketSession:c.marketSession,...(c.buyingPower?{buyingPower:c.buyingPower}:{})}];}
// Total equity in KRW: the combined figure when present, else each market's equity with USD at the current rate.
function equityKRW(c){if(Number.isFinite(c?.equity)&&c.equity>0&&c.currency!=='USD')return c.equity;const rate=usdKrw(c);let total=0;for(const m of marketsOf(c)){if(!Number.isFinite(m.equity))continue;total+=m.currency==='USD'?(rate?m.equity*rate:0):m.equity;}return total>0?total:null;}
module.exports={equityKRW,usdKrw,marketsOf,rows};
