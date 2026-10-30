const {createHash}=require('node:crypto');
// Token saving for AI reviews: skip unchanged scheduled reviews, compact and order context for prompt caching,
// and route routine reviews to a cheaper model while escalating important ones.
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
const STABLE_FIRST=['environment','market','currency','baseCurrency','objective','userGuidelines','reviewedLessons','lessonConflicts','discovery','reviewInterval','reviewWatches','decisionScoreboard','macro','tradingCosts'];
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
  for(const key of STABLE_FIRST)if(key in pruned)ordered[key]=key==='tradingCosts'?lastKey(pruned[key],['heldSale','allUSHoldingsSale','oneShare']):pruned[key];
  for(const [key,value] of Object.entries(pruned))if(!(key in ordered))ordered[key]=value;
  ordered.universe=pruned.universe??[];
  if(Array.isArray(ordered.news))ordered.news=ordered.news.map(({title,published,symbols,importance})=>prune({title:String(title??'').slice(0,160),published,symbols,importance})).filter(Boolean);
  return ordered;
}
// Picks the model for this review. 'auto' sends routine reviews to the cheaper model; emergencies, user requests and
// important disclosures use the configured model. Near the daily budget, routine reviews always use the cheaper model.
// 'complexity' sends a review to the configured model when a hard rule applies or the complexity score reaches the threshold,
// and only once a routing evaluation has passed (eligible); otherwise the configured model decides.
// Order: escalations, then shadow evaluation (main model only, so the experiment cannot change live decisions), then
// complexity routing, then the budget fallback for the other modes. Validated complexity routing has no budget fallback:
// the routing simulation evaluates this same function, so the evaluated policy is the deployed one.
function route(config,{trigger,emergencyActive=false,triggerEvidence=null,nearBudget=false,complexity=null,hardRule=null,eligible=false}){
  const strong={openaiModel:config.openaiModel,reasoningEffort:config.reasoningEffort},routine={openaiModel:config.routineModel,reasoningEffort:config.routineEffort};
  const important=emergencyActive?'emergency':trigger==='User request'?'user request':triggerEvidence?.kind==='news'&&(triggerEvidence.events??[]).some(e=>e.importance==='high')?'important disclosure':null;
  if(important)return {...strong,tier:'escalated',reason:important};
  if(config.shadowEvaluation)return {...strong,tier:'fixed',reason:'shadow evaluation: main model only'};
  // Complexity routing without a valid evaluation pass keeps the main model, before any budget fallback.
  if(config.modelRouting==='complexity'&&!eligible)return {...strong,tier:'fixed',reason:'complexity routing not validated'};
  if(config.modelRouting==='complexity'){
    if(hardRule)return {...strong,tier:'escalated',reason:hardRule};
    const score=complexity?.score??100;return score>=config.complexityThreshold?{...strong,tier:'escalated',reason:`complexity ${score} ≥ ${config.complexityThreshold}`}:{...routine,tier:'routine',reason:`complexity ${score} < ${config.complexityThreshold}`};
  }
  if(nearBudget&&config.degradeNearBudget)return {...routine,tier:'routine',reason:'near daily budget'};
  if(config.modelRouting==='auto')return {...routine,tier:'routine',reason:'routine review'};
  return {...strong,tier:'fixed',reason:'fixed model'};
}
// The daily budget is "near" at 80% of the USD allowance or of the call count.
function nearBudget(config,usage){return (!config.unlimitedBudget&&usage.reservedMicro>=config.maxUSDPerDay*1e6*0.8)||(!config.unlimitedCalls&&usage.calls>=Math.floor(config.maxCallsPerDay*0.8));}
module.exports={decisionView,fingerprint,shouldSkip,compact,route,nearBudget,canonical,within};
