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
  ['performance',p=>p?.history?{...p,history:Object.fromEntries(Object.entries(p.history).map(([m,h])=>[m,{since:h.since,currency:h.currency,benchmark:h.benchmark,...(h.returnReliability?{returnReliability:h.returnReliability}:{}),timeWeightedReturns:h.timeWeightedReturns,risk:h.risk?{maxDrawdownPct:h.risk.maxDrawdownPct,currentDrawdownPct:h.risk.currentDrawdownPct,volatilityPct:h.risk.volatilityPct}:undefined}]))}:p],
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
const DETAIL_TOOL={type:'function',name:'get_context_detail',description:'Read a context section that was given as a summary (listed in detailAvailable), or a tool result that was shortened or had parts left out (its fullResult.section, result-N), in bounded parts. A research section whose provenance says complete false has its original at the path in provenance.original, inside that result. part: empty for the whole section, or a path of names, list indexes and symbols separated by / (for example rows/3/thesis, or NASD:NVDA/0/notes where a symbol selects the rows about it), as given in an earlier reply. page: 1 or more for long lists and long text. A reply with complete false names the paths or pages still to read.',strict:true,
  parameters:{type:'object',properties:{section:{type:'string'},part:{type:'string'},page:{type:'integer'}},required:['section','part','page'],additionalProperties:false}};
// Size of a value once it is a tool result in the request: the result travels as a JSON string inside the JSON
// request, so every quote, backslash and control character is escaped twice. All tool budgets are in these bytes.
const outBytes=value=>Buffer.byteLength(JSON.stringify(JSON.stringify(value??null)));
// A long text in pieces of at most limit bytes each (as sent), split between characters.
function chunks(text,limit){
  const out=[];let cur='',size=0;for(const ch of text){const c=outBytes(ch)-6;if(cur&&size+c>limit){out.push(cur);cur='';size=0;}cur+=ch;size+=c;}
  out.push(cur);return out;
}
// One bounded piece of a summarized section. part is a path of names, list indexes and symbols separated by '/'
// (for example "rows/3/thesis" or "NASD:NVDA/0/notes"; a symbol selects the rows about it). A list too long for one
// reply comes in pages; a row, field or text too large for one reply is replaced by its path (or comes in pages of
// text), so everything can be read, and complete is true only when nothing was left out of this reply.
// A name inside a path: '/' is written ~1 and '~' is written ~0 (as in a JSON pointer), so a name such as "P/E" is
// one step.
const segment=k=>String(k).replaceAll('~','~0').replaceAll('/','~1'),unsegment=s=>s.replaceAll('~1','/').replaceAll('~0','~');
function detailPart(detail,{section,part='',page=1},limit=8000){
  if(!detail||!Object.hasOwn(detail,section))return {status:'rejected',reason:`No detail for ${JSON.stringify(section)}; available: ${Object.keys(detail??{}).join(', ')||'none'}.`};
  let value=detail[section];const at=[];
  for(const written of String(part??'').split('/').filter(Boolean)){const step=unsegment(written);
    if(Array.isArray(value)&&/^\d+$/.test(step)&&Number(step)<value.length){value=value[Number(step)];at.push(written);continue;}
    if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,step)){value=value[step];at.push(written);continue;}
    const rows=Array.isArray(value)?value:value&&typeof value==='object'?value.rows??value.books??value.targets??null:null;const matched=Array.isArray(rows)?rows.filter(r=>r?.symbol===step):[];
    if(matched.length){value=matched;at.push(written);continue;}
    return {status:'rejected',reason:`No part, index or symbol ${JSON.stringify(step)} in ${[section,...at].join('/')}.`,...(value&&typeof value==='object'?{parts:Array.isArray(value)?`indexes 0 to ${value.length-1}`:Object.keys(value).map(segment)}:{})};
  }
  const path=at.join('/'),head={section,...(path?{part:path}:{})},sub=k=>path?`${path}/${segment(k)}`:segment(k),room=limit-500;
  const pageOf=count=>Math.min(Math.max(1,Number.isInteger(page)?page:1),count);
  if(outBytes(value)<=limit)return {...head,data:value,complete:true};
  if(typeof value==='string'){const pieces=chunks(value,room);const n=pageOf(pieces.length);return {...head,page:n,pages:pieces.length,text:pieces[n-1],complete:false,note:'Long text: read every page with the same part to have all of it.'};}
  if(Array.isArray(value)){
    const items=value.map((row,i)=>outBytes(row)>room-200?{omitted:true,path:sub(i),bytes:outBytes(row),...(row?.symbol?{symbol:row.symbol}:{})}:row);
    const pages=[];let cur=[];for(const item of items){if(cur.length&&outBytes([...cur,item])>room){pages.push(cur);cur=[];}cur.push(item);}pages.push(cur);
    const n=pageOf(pages.length),omitted=pages[n-1].filter(r=>r?.omitted===true&&typeof r.path==='string').map(r=>r.path);
    return {...head,page:n,pages:pages.length,totalItems:value.length,data:pages[n-1],complete:pages.length===1&&!omitted.length,...(omitted.length?{note:'Rows too large for one reply are given by path: read each with that path as part.'}:{})};}
  if(value&&typeof value==='object'){
    const data={},omittedParts=[];for(const [k,v] of Object.entries(value)){if(outBytes({...data,[k]:v})+120*(omittedParts.length+1)<=room)data[k]=v;else omittedParts.push({part:sub(k),bytes:outBytes(v)});}
    return {...head,data,omittedParts,complete:false,note:'Parts too large for this reply are listed by path: read each with that path as part.'};}
  return {...head,status:'too_large',bytes:outBytes(value),complete:false};
}
// Bounds a tool response before it joins the conversation, in bytes as sent (outBytes): whole top-level parts are
// kept in order while they fit. 16 KB each: four responses in a round plus the review's first request stay within the
// follow-up limit. ref, when given, is the get_context_detail section that holds the full response: everything cut or
// left out is listed by path in it, so the agent can read exactly that, in pages.
// always: name the full result even when nothing here is cut (a research reply whose digest left parts out says where
// in it the originals are). Parts in PINNED (identity, the next-session marker, instrument risk and provenance) come
// first and are never shortened or left out, wherever they sat in the reply.
const PINNED=['nextSession','status','symbol','name','market','asOf','instrument','fundData','provenance'];
function bound(value,limit=16000,{ref=null,always=false}={}){
  const full=ref?{fullResult:{section:ref,read:'Every path in cuts and omittedParts, and every provenance original, is readable in full with get_context_detail: this section, part set to the path, page 1 and up.'}}:{};
  // A reply that must name its full result counts that reference in its size: when both do not fit, it is shortened.
  const named=always&&ref&&value&&typeof value==='object'&&!Array.isArray(value);
  if(outBytes(named?{...value,...full}:value)<=limit)return named?{...value,...full}:value;
  if(!value||typeof value!=='object'||Array.isArray(value))return {status:'too_large',bytes:outBytes(value),...full,note:ref?'Too large for one reply: read it in pages from fullResult.':'Ask for a narrower request (fewer sections or one symbol).'};
  // A part that does not fit is shortened to the room left when that room is useful (see shrink), so a section asked for
  // alone still arrives; only what cannot fit at all is left out.
  const spare=500+outBytes(full),out=Object.fromEntries(PINNED.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])),omitted=[],shortened=[],cuts=[];
  for(const [k,v] of Object.entries(value)){if(Object.hasOwn(out,k))continue;
    if(outBytes({...out,[k]:v})<=limit-spare){out[k]=v;continue;}
    const room=limit-spare-outBytes({...out,[k]:null});
    if(room>=1200&&v&&typeof v==='object'){const cut=shrink(v,room-200);if(cut&&outBytes({...out,[k]:cut.value})<=limit-spare-200){out[k]=cut.value;shortened.push(segment(k));cuts.push(...cut.cuts.map(c=>({...c,path:c.path?`${segment(k)}/${c.path}`:segment(k)})));continue;}}
    omitted.push(segment(k));
  }
  // Every part's list cuts come before its text cuts, so when the list of cuts must give way, the text cuts go first
  // and the count left out is stated; the shortened parts themselves stay readable by name.
  cuts.sort((a,b)=>('items' in a?0:1)-('items' in b?0:1));let unlisted=0;
  const result=()=>({...out,...(omitted.length?{omittedParts:omitted}:{}),...(shortened.length?{shortenedParts:shortened}:{}),...(cuts.length?{cuts}:{}),...(unlisted?{cutsNotListed:unlisted}:{}),...full,
    note:(omitted.length?'Some parts were left out to fit':'Long texts and lists in some parts were shortened to fit')+(unlisted?` (${unlisted} more cuts inside shortenedParts are not listed)`:'')+(ref?'; read them in full from fullResult.':'; request them separately or a narrower part.')});
  while(cuts.length&&outBytes(result())>limit){cuts.pop();unlisted++;}
  return result();
}
// Statements kept whole when a response is shortened: a guidance sentence cut in half loses its qualification.
const KEEP_WHOLE=new Set(['guidance','results']);
// A copy of a value cut down to limit bytes as sent, and the cuts made, by path: free text (not a list entry) is halved,
// longest first, to no less than 200 characters, then the longest list loses its last entries, statement lists
// (KEEP_WHOLE) last. A list entry is never cut inside, so each statement left is complete. Null when it cannot fit.
function shrink(value,limit){
  const copy=structuredClone(value),cuts=new Map();
  const largest=kind=>{let best=null;
    const visit=(node,holder,key,path,inList)=>{
      if(kind==='text'&&typeof node==='string'&&!inList&&node.length>400&&(!best||node.length>best.size))best={holder,key,path,size:node.length};
      if(node&&typeof node==='object'){
        if(kind==='list'&&Array.isArray(node)&&node.length>1){const rank=[KEEP_WHOLE.has(key)?0:1,outBytes(node)];if(!best||rank[0]>best.rank[0]||rank[0]===best.rank[0]&&rank[1]>best.rank[1])best={list:node,path,rank};}
        for(const [k,v] of Object.entries(node))visit(v,node,k,path?`${path}/${segment(k)}`:segment(k),Array.isArray(node));}};
    visit(copy,null,null,'',false);return best;};
  for(let i=0;i<400&&outBytes(copy)>limit;i++){
    const text=largest('text');if(text){const s=text.holder[text.key];if(!cuts.has(text.path))cuts.set(text.path,{path:text.path,chars:s.length});
      const kept=s.slice(0,Math.max(200,Math.floor(s.length/2)));text.holder[text.key]=kept+'…';cuts.get(text.path).keptChars=kept.length;continue;}
    const list=largest('list');if(list){if(!cuts.has(list.path))cuts.set(list.path,{path:list.path,items:list.list.length});list.list.pop();cuts.get(list.path).keptItems=list.list.length;continue;}
    break;
  }
  // Lists first: a list that lost entries matters more than a text inside it, and a cut inside an entry that was later
  // removed is no longer in the reply (the list cut covers it).
  const all=[...cuts.values()],lists=all.filter(c=>'items' in c);
  const gone=c=>lists.some(l=>c!==l&&c.path.startsWith(l.path?l.path+'/':'')&&Number(c.path.slice(l.path?l.path.length+1:0).split('/')[0])>=l.keptItems);
  return outBytes(copy)<=limit?{value:copy,cuts:[...lists,...all.filter(c=>!('items' in c))].filter(c=>!gone(c))}:null;
}
// The full results of one run (a trading review or a scout run), read back with get_context_detail. Every tool result
// is section result-N, numbered by result so a repeated call id never overwrites an earlier one; a research reply keeps
// the sections its digest shortened as originalSections. base: the run's summarized context sections, if any.
const TRACE=Symbol.for('fpm.research-trace');
function resultStore(base=null){
  const stored={},byCall=new Map();let count=0;
  const details=()=>({...(base??{}),...stored}),originalsOf=value=>{const o=value?.[TRACE]?.originals;return o&&Object.keys(o).length?o:null;};
  return {details,
    // Keeps a result and returns it bounded to limit, naming the section that holds all of it.
    keep(callId,value,limit){const ref=`result-${++count}`,originals=originalsOf(value);
      stored[ref]=originals?{...value,originalSections:originals}:value;byCall.set(callId,{value,ref});return bound(value,limit,{ref,always:Boolean(originals)});},
    // A kept result bounded again, from all of it, to a new limit (null for a call that was not kept).
    again(callId,limit){const kept=byCall.get(callId);return kept?bound(kept.value,limit,{ref:kept.ref,always:Boolean(originalsOf(kept.value))}):null;},
    refs:()=>new Map([...byCall].map(([id,{ref}])=>[id,ref])),
    read:(args,limit)=>detailPart(details(),{section:String(args?.section??''),part:String(args?.part??''),page:args?.page},limit)};
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
module.exports={sameInputs,cashOf,detailPart,chunks,combineTradingCosts,shape,report,bound,resultStore,wire,bytes,outBytes,MANDATORY,SUMMARIES,COMPRESS,PINNED,DETAIL_TOOL};
