// Shapes a review's context to fit its size budget without losing what the decision rests on.
// 1. A mandatory decision snapshot (holdings, cash, equity reliability, orders, execution restrictions, limits, prices,
//    trigger evidence) is never shortened.
// 2. Long background sections start as summaries; the full section stays with the review and the agent reads it with
//    get_context_detail. A summary keeps ids, dates and missing-data flags, so it never implies complete evidence.
// 3. Only if the request is still over budget, background sections are compressed section by section (sizing keeps
//    symbol, shares and binding constraint; order books keep bid, ask, sizes and freshness; and so on), each recorded
//    as detail the agent can still read. Nothing is cut by row position.
// 4. If the mandatory snapshot alone cannot fit, the review fails with that reason instead of calling the model.
const MANDATORY=['environment','market','currency','baseCurrency','equity','cash','positions','orders','orderReconciliation','equityReliability','equityUncertainty',
  'markets','risk','emergency','marketSession','executionEnabled','automaticExecutionEnabled','buyingPower','productRisk','quotes','universe','triggerEvidence','fx','tradingCosts','userGuidelines','objective'];
const bytes=value=>Buffer.byteLength(JSON.stringify(value??null));
const wire=context=>Buffer.byteLength(JSON.stringify([{role:'user',content:JSON.stringify(context)}]));
const clip=(text,n)=>{const s=String(text??'');return s.length>n?s.slice(0,n-1)+'…':s;};
const norm=t=>String(t??'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

// Summaries given from the start (the full section is available on request).
const SUMMARIES={
  // Scout answers to earlier briefs: what was asked and the start of the answer, by brief id and date.
  'scoutPlan.briefAnswers':rows=>Array.isArray(rows)?rows.map(r=>({briefId:r.briefId,...(r.at?{at:r.at}:{}),...(r.answeredAt?{answeredAt:r.answeredAt}:{}),asked:clip(r.asked,160),answer:clip(r.answer??r.reply??r.summary,240)})):rows,
  // Past episodes: date, title, similarity, themes and what indices did next; driver text on request.
  similarEpisodes:rows=>Array.isArray(rows)?rows.map(({drivers,narrative,summary,...rest})=>({...rest,...(Array.isArray(drivers)?{drivers:drivers.slice(0,2).map(d=>clip(d,90)),driverCount:drivers.length}:{})})):rows,
  // Performance: identical period returns (a short history makes 1M..All the same) are stated once.
  performance:p=>{if(!p?.history)return p;const history=Object.fromEntries(Object.entries(p.history).map(([m,h])=>{if(!Array.isArray(h?.timeWeightedReturns))return [m,h];const groups=[];
    for(const r of h.timeWeightedReturns){const g=groups.find(x=>x.returnPct===r.returnPct&&x.benchmarkPct===r.benchmarkPct&&x.from===r.from);if(g){g.periods.push(r.period);g.partial=g.partial||r.partial;}else groups.push({periods:[r.period],from:r.from,returnPct:r.returnPct,benchmarkPct:r.benchmarkPct,partial:r.partial});}
    return [m,{...h,timeWeightedReturns:groups.map(g=>({period:g.periods.join('/'),from:g.from,returnPct:g.returnPct,benchmarkPct:g.benchmarkPct,...(g.partial?{partial:true}:{})}))}];}));return {...p,history};},
  // News: the same story from several outlets is one item, with every symbol and the highest importance kept.
  news:rows=>{if(!Array.isArray(rows))return rows;const out=[];for(const r of rows){const k=norm(r.title).slice(0,80);const same=out.find(o=>norm(o.title).slice(0,80)===k);
    if(same){same.symbols=[...new Set([...(same.symbols??[]),...(r.symbols??[])])];if(r.importance==='high')same.importance='high';same.outlets=(same.outlets??1)+1;}else out.push({...r});}return out;},
};
// Section-specific compression, used only while the request is over budget, in this order.
const COMPRESS=[
  ['marketNarrative',n=>n&&typeof n==='object'?{asOf:n.asOf,regime:n.regime,summary:clip(n.summary,400),drivers:(n.drivers??[]).map(d=>({kind:d.kind,title:d.title,...(d.sectors?{sectors:d.sectors}:{})}))}:n],
  ['scoutPlan',s=>s&&typeof s==='object'?{...s,summary:clip(s.summary,300),focus:clip(s.focus,200),targets:(s.targets??[]).map(t=>({...t,...(t.thesis?{thesis:clip(t.thesis,160)}:{}),...(t.watch?{watch:clip(t.watch,120)}:{})}))}:s],
  ['positionSizing',s=>s&&Array.isArray(s.rows)?{...s,rows:s.rows.map(r=>({symbol:r.symbol,maxShares:r.maxShares,limitedBy:r.limitedBy,suggestedStop:r.suggestedStop,maxWeightPct:r.maxWeightPct}))}:s],
  ['orderBooks',o=>o&&Array.isArray(o.books)?{readAt:o.readAt,staleAfterSeconds:o.staleAfterSeconds,books:o.books.map(b=>({symbol:b.symbol,bid:b.bid,ask:b.ask,bidSize:b.bidSize,askSize:b.askSize,ageSeconds:b.ageSeconds,stale:b.stale}))}:o],
  ['macro',m=>Array.isArray(m?.series)?{...m,series:m.series.map(({history,...s})=>s)}:Array.isArray(m)?m.map(({history,...s})=>s):m],
  ['eventCalendar',e=>Array.isArray(e)?e.map(r=>({date:r.date??r.day,kind:r.kind,title:clip(r.title??r.name,90),...(r.symbols?{symbols:r.symbols}:{}),...(r.symbol?{symbol:r.symbol}:{})})):e],
  ['similarEpisodes',e=>Array.isArray(e)?e.map(({drivers,sharedThemes,...r})=>r):e],
  ['performance',p=>p?.history?{...p,history:Object.fromEntries(Object.entries(p.history).map(([m,h])=>[m,{since:h.since,currency:h.currency,benchmark:h.benchmark,timeWeightedReturns:h.timeWeightedReturns,risk:h.risk?{maxDrawdownPct:h.risk.maxDrawdownPct,currentDrawdownPct:h.risk.currentDrawdownPct,volatilityPct:h.risk.volatilityPct}:undefined}]))}:p],
  ['topStories',t=>Array.isArray(t)?t.map(r=>({title:clip(r.title,120),outlets:r.outlets,...(r.symbols?{symbols:r.symbols}:{})})):t],
  ['planGap',g=>g&&Array.isArray(g.targets)?{...g,targets:g.targets.map(({minimumPosition,...t})=>({...t,...(minimumPosition?{minimumPosition:{feasible:minimumPosition.feasible,weightPct:minimumPosition.weightPct}}:{})}))}:g],
];
const getPath=(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o);
const setPath=(o,p,v)=>{const [k,...rest]=p.split('.');return rest.length?{...o,[k]:setPath(o[k]??{},rest.join('.'),v)}:{...o,[k]:v};};
// limit: the app's byte limit for the first request; target leaves room below it.
function shape(context,{limit=require('./ai-models.cjs').reviewByteLimit({}),target=0.92}={}){
  let out=context;const detail={},steps=[];
  for(const [path,fn] of Object.entries(SUMMARIES)){const value=getPath(out,path);if(value==null)continue;const next=fn(value);if(bytes(next)<bytes(value)){detail[path]=value;out=setPath(out,path,next);steps.push({section:path,kind:'summary',bytesSaved:bytes(value)-bytes(next)});}}
  for(const [key,fn] of COMPRESS){if(wire(out)<=limit*target)break;if(MANDATORY.includes(key)||out[key]==null)continue;const value=out[key],next=fn(value);
    if(bytes(next)<bytes(value)){detail[key]??=getPath(context,key);out={...out,[key]:next};steps.push({section:key,kind:'compressed',bytesSaved:bytes(value)-bytes(next)});}}
  const available=Object.keys(detail);if(available.length)out={...out,detailAvailable:available};
  const mandatory=Object.fromEntries(MANDATORY.filter(k=>out[k]!==undefined).map(k=>[k,out[k]]));
  return {context:out,detail,steps,fits:wire(out)<=limit,report:report(out,limit),mandatoryBytes:wire(mandatory)};
}
// What a request consists of: total wire bytes against the limit and the largest sections.
function report(context,limit){return {wireBytes:wire(context),limitBytes:limit,largest:Object.entries(context).map(([k,v])=>[k,bytes(v)]).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,b])=>`${k}:${b}`)};}
const DETAIL_TOOL={type:'function',name:'get_context_detail',description:'Read a context section that was given as a summary (listed in detailAvailable), in bounded parts. part: empty for the section (or its list of parts when large), a part name, or a symbol to select rows about it. page: 1 or more for long lists.',strict:true,
  parameters:{type:'object',properties:{section:{type:'string'},part:{type:'string'},page:{type:'integer'}},required:['section','part','page'],additionalProperties:false}};
// One bounded, selectable piece of a summarized section: a named part, the rows about one symbol, or a page of a list.
// Every reply says what else exists (parts, pages), so nothing left out is implied to be complete.
function detailPart(detail,{section,part='',page=1},limit=8000){
  if(!detail||!Object.hasOwn(detail,section))return {status:'rejected',reason:`No detail for ${JSON.stringify(section)}; available: ${Object.keys(detail??{}).join(', ')||'none'}.`};
  let value=detail[section],selected=part||null;
  if(part&&value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,part))value=value[part];
  else if(part&&value&&typeof value==='object'){const rows=(Array.isArray(value)?value:value.rows??value.books??value.targets??[]).filter(r=>r?.symbol===part);if(!rows.length)return {status:'rejected',reason:`No part or symbol ${JSON.stringify(part)} in ${section}.`,parts:Array.isArray(value)?undefined:Object.keys(value)};value=rows;}
  else selected=null;
  if(bytes(value)<=limit)return {section,...(selected?{part:selected}:{}),data:value,complete:true};
  if(Array.isArray(value)){const pages=[];let cur=[];for(const row of value){if(cur.length&&bytes([...cur,row])>limit-400){pages.push(cur);cur=[];}cur.push(row);}if(cur.length)pages.push(cur);
    const n=Math.min(Math.max(1,Number.isInteger(page)?page:1),pages.length);const rows=pages[n-1].map(r=>bytes(r)>limit-400?{tooLarge:true,bytes:bytes(r),...(r?.symbol?{symbol:r.symbol}:{})}:r);
    return {section,...(selected?{part:selected}:{}),page:n,pages:pages.length,totalItems:value.length,data:rows,complete:pages.length===1};}
  if(value&&typeof value==='object')return {section,...(selected?{part:selected}:{}),parts:Object.entries(value).map(([k,v])=>({part:k,bytes:bytes(v)})),note:'Too large to return at once: ask for one part by name.',complete:false};
  return {section,status:'too_large',bytes:bytes(value),complete:false};
}
// Bounds a tool response before it joins the conversation: whole top-level parts are kept in order while they fit,
// and the parts left out are named so the agent can ask for them; nothing is cut inside a part.
// 16 KB each: four responses in a round plus the review's first request stay within the follow-up limit.
function bound(value,limit=16000){
  if(bytes(value)<=limit||!value||typeof value!=='object'||Array.isArray(value))return bytes(value)<=limit?value:{status:'too_large',bytes:bytes(value),note:'Ask for a narrower request (fewer sections or one symbol).'};
  const out={},omitted=[];for(const [k,v] of Object.entries(value)){if(bytes({...out,[k]:v})<=limit-300)out[k]=v;else omitted.push(k);}
  return {...out,omittedParts:omitted,note:'These parts were left out to fit; request them separately.'};
}
// Combined reviews: each market's trading costs move out of markets[] into one tradingCosts, with the tax model, fee
// assumption and rule version stated once for both markets. Returns {markets, tradingCosts}.
function combineTradingCosts(markets){
  const per=markets.map(row=>row.tradingCosts??{});const shared=per.find(t=>t.taxModel)??{};
  return {markets:markets.map(({tradingCosts,...row})=>row),tradingCosts:{...(shared.taxModel?{taxModel:shared.taxModel,acquisitionFeeAssumption:shared.acquisitionFeeAssumption,ruleVersion:shared.tax?.ruleVersion}:{}),
    markets:per.map(({taxModel,acquisitionFeeAssumption,...t},i)=>({market:t.market??markets[i].market,...t,...(t.tax?{tax:(({ruleVersion,...x})=>x)(t.tax)}:{})}))}};
}
// Whether a review would repeat inputs that already failed for size: the same structure (holdings, orders, sessions,
// important news) and prices within the tolerance, with cash and trigger evidence exactly equal; any fill,
// cancellation, cash change, important headline, session change or new trigger is a material change that runs again.
function sameInputs(failed,next,tolerancePct){
  const saver=require('./token-saver.cjs');if(!failed||!next||failed.exact!==next.exact)return false;
  return JSON.stringify(failed.cash??null)===JSON.stringify(next.cash??null)&&saver.within(failed.state,next.state,Math.max(0.1,tolerancePct/2));
}
// Compared exactly, beside the fingerprint (which allows a price tolerance and ignores trigger evidence): cash in every
// market and what set this review off (a new agent trigger, news event or price watch is material).
const cashOf=context=>({cash:context.cash??null,markets:(context.markets??[]).map(m=>[m.market,m.cash]),trigger:context.triggerEvidence??null});
module.exports={sameInputs,cashOf,detailPart,combineTradingCosts,shape,report,bound,wire,bytes,MANDATORY,SUMMARIES,COMPRESS,DETAIL_TOOL};
