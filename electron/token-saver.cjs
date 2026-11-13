const {createHash}=require('node:crypto');
// Token saving for AI reviews: skip unchanged scheduled reviews, compact and order context for prompt caching, and
// tell when the daily budget is nearly used (model routing was removed in step A1, 2026-11-12).
const VOLATILE=/^(timestamp|retrievedAt|updatedAt|fetchedAt|generatedAt|heartbeat|savedAt|at|asOfTimestamp)$|At$/;
const IGNORED=new Set(['performance','decisionScoreboard','triggerEvidence','reviewInterval','reviewWatches','paperVersion']);
const MONEY=/price|last|close|value|equity|cash|amount|total|marketValue|pnl|gain|profit|cost|notional|evaluation|usdKRW|rate/i;
// What a skip compares, as an explicit list of decision-relevant fields; every other section (background the agents
// read, derived figures) is left out, and stays in the model's inputs. Holdings, cash and prices are compared within
// the tolerance; sessions, execution switches, orders, the emergency state, lessons, guidelines, the regime label and
// headlines marked important exactly. Other headlines arrive hourly; important ones also start their own review.
// Review of 8ef1be1, P2: every field outside a background list had to match exactly, so a quote's running volume going
// from 1,000 to 1,001 forced a paid scheduled review. Quotes now count by price and freshness only: change % follows
// the price, and volume has no defined signal yet (a relative-volume signal is a separate, later change). Trading costs
// and the emergency loss amount are recomputed from prices on every quote, so only their settings and state count.
const same=v=>v;
const COMPARED={environment:same,market:same,currency:same,baseCurrency:same,objective:same,userGuidelines:same,reviewedLessons:same,lessonConflicts:same,
  positions:same,cash:same,equity:same,buyingPower:same,fx:same,orders:same,orderReconciliation:same,equityReliability:same,equityUncertainty:same,
  marketSession:same,markets:same,executionEnabled:same,automaticExecutionEnabled:same,productRisk:same,
  quotes:q=>Array.isArray(q)?q.map(x=>({symbol:x?.symbol,price:x?.price,stale:x?.stale})):q,
  universe:u=>Array.isArray(u)?u.map(x=>x?.symbol).sort():u,
  discovery:d=>Array.isArray(d?.watchlist)?{enabled:d.enabled,symbols:d.watchlist.map(x=>x?.symbol).sort()}:d,
  tradingCosts:t=>Array.isArray(t?.markets)?t.markets.map(m=>({market:m.market,settings:m.settings})):t?.settings??t?.basis??null,
  emergency:e=>e&&typeof e==='object'?{active:e.active,scope:e.scope,...(e.activeMarkets?{activeMarkets:e.activeMarkets}:{}),breached:e.loss?.breached??null,policy:e.loss?.policy??null}:e,
  marketRegime:r=>r?.regime??null,
  news:n=>Array.isArray(n)?n.filter(x=>x?.importance==='high').map(x=>x.title):n,
  // A new top story changes the view; its coverage counts growing does not.
  topStories:t=>Array.isArray(t)?t.map(s=>s.terms?.[0]).sort():t};
function decisionView(context){return Object.fromEntries(Object.entries(COMPARED).filter(([k])=>context?.[k]!==undefined).map(([k,f])=>[k,f(context[k])]));}
// Money-like numbers are kept as {money:value} so comparison can allow a tolerance; everything else must match exactly.
function canonical(value,key=''){
  if(Array.isArray(value))return value.map(item=>canonical(item));
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!VOLATILE.test(k)&&!IGNORED.has(k)&&value[k]!=null).map(k=>[k,canonical(value[k],k)]));
  if(typeof value==='number'&&Number.isFinite(value)&&MONEY.test(key))return {money:value};
  return value;
}
// Decision-relevant state: holdings, prices and cash (compared within a tolerance), news, lessons, macro date, emergency, sessions.
// `exact` hashes everything except money values, so a structural change (new news item, sold shares) is detected cheaply.
function fingerprint(context){
  const state=canonical(decisionView(context));const strip=v=>Array.isArray(v)?v.map(strip):v&&typeof v==='object'?('money' in v&&Object.keys(v).length===1?'#':Object.fromEntries(Object.entries(v).map(([k,x])=>[k,strip(x)]))):v;
  return {exact:createHash('sha256').update(JSON.stringify(strip(state))).digest('hex'),state};
}
function within(a,b,pct){
  if(Array.isArray(a))return Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>within(x,b[i],pct));
  if(a&&typeof a==='object'){if(!b||typeof b!=='object')return false;if('money' in a&&Object.keys(a).length===1)return 'money' in b&&(a.money===b.money||Math.abs(a.money-b.money)<=Math.max(Math.abs(a.money),Math.abs(b.money))*pct/100);const ka=Object.keys(a),kb=Object.keys(b);return ka.length===kb.length&&ka.every(k=>within(a[k],b[k],pct));}
  return a===b;
}
// Skips only scheduled reviews whose state matches the last completed review (prices and cash within half the
// price-movement tolerance), for at most maxSkipMinutes after that review.
function shouldSkip({trigger,config,fingerprint:next,last,now=Date.now()}){
  if(!config.skipUnchanged||trigger!=='Scheduled review'||!last||!next||last.exact!==next.exact)return false;
  return now-last.completedAt<config.maxSkipMinutes*60000&&within(last.state,next.state,Math.max(0.1,(config.eventTolerancePct??3)/2));
}
// Removes null/empty values, rounds long decimals and puts stable parts first so repeated prompts share a cacheable prefix.
// Ordered from least to most frequently changing. tradingCosts ends with its price-dependent quotes (heldSale,
// allUSHoldingsSale, oneShare).
const STABLE_FIRST=['environment','market','currency','baseCurrency','objective','userGuidelines','reviewedLessons','lessonConflicts','discovery','reviewInterval','extendedSessions','reviewWatches','decisionScoreboard','macro','tradingCosts'];
const lastKey=(value,keys)=>{if(Array.isArray(value))return value.map(v=>lastKey(v,keys));if(!value||typeof value!=='object')return value;const out=Object.fromEntries(Object.entries(value).filter(([k])=>!keys.includes(k)).map(([k,v])=>[k,lastKey(v,keys)]));for(const k of keys)if(value[k]!==undefined)out[k]=value[k];return out;};
function prune(value){
  if(Array.isArray(value)){const items=value.map(prune).filter(v=>v!==undefined);return items.length?items:undefined;}
  if(value&&typeof value==='object'){const entries=Object.entries(value).map(([k,v])=>[k,prune(v)]).filter(([,v])=>v!==undefined);return entries.length?Object.fromEntries(entries):undefined;}
  if(value===null||value===undefined||value==='')return undefined;
  if(typeof value==='number'&&!Number.isInteger(value))return Math.round(value*10000)/10000;
  return value;
}
// Keys the provider-side validation relies on are always kept, even when empty.
function compact(context){
  const pruned=prune(context)??{};const ordered={};
  // extendedSessions is kept when empty: an empty list says no extended session is on, and an absent one counts as on
  // (review-instructions.cjs, a context saved before the field existed), so pruning it would add the extended part.
  if(Array.isArray(context?.extendedSessions))pruned.extendedSessions=[...context.extendedSessions];
  for(const key of STABLE_FIRST)if(key in pruned)ordered[key]=key==='tradingCosts'?lastKey(pruned[key],['heldSale','allUSHoldingsSale','oneShare']):pruned[key];
  for(const [key,value] of Object.entries(pruned))if(!(key in ordered))ordered[key]=value;
  ordered.universe=pruned.universe??[];
  if(Array.isArray(ordered.news))ordered.news=ordered.news.map(({title,published,symbols,importance})=>prune({title:String(title??'').slice(0,160),published,symbols,importance})).filter(Boolean);
  return ordered;
}
// The daily budget is "near" at 80% of the USD allowance or of the call count. Near it, "Slow down near the budget"
// doubles the review interval (automation.cjs slowFactor); since step A1 it no longer switches to a cheaper model.
function nearBudget(config,usage){return (!config.unlimitedBudget&&usage.reservedMicro>=config.maxUSDPerDay*1e6*0.8)||(!config.unlimitedCalls&&usage.calls>=Math.floor(config.maxCallsPerDay*0.8));}
module.exports={decisionView,fingerprint,shouldSkip,compact,nearBudget,canonical,within};
