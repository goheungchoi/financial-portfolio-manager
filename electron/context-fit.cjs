// Keeps a research review's follow-up request under the size limit without dropping what the agent asked for.
// Step 1 digests older tool results locally: long lists keep their ends plus a summary, long text is shortened,
// and every key and number that remains is unchanged. Step 2, only if still too big, asks the cheap model to
// condense those older results (each still answers its own request). The latest round stays in full.
const LIMIT=require('./ai-models.cjs').reviewByteLimit({continuation:true}),TARGET=0.9;
const size=value=>Buffer.byteLength(JSON.stringify(value));
const round=n=>Number.isInteger(n)?n:Math.abs(n)>=100?Math.round(n*100)/100:Number(n.toPrecision(5));
function digest(value){
  if(Array.isArray(value)){
    if(value.length&&value.every(v=>typeof v==='number')){if(value.length<=8)return value.map(round);return {count:value.length,first:round(value[0]),last:round(value.at(-1)),min:round(Math.min(...value)),max:round(Math.max(...value))};}
    if(value.length<=6)return value.map(digest);
    // Long row lists (closes, analyst notes, holdings): the first three and last two rows, and a numeric summary of the rows.
    const out=[...value.slice(0,3).map(digest),{omittedRows:value.length-5},...value.slice(-2).map(digest)];
    const numeric=value.every(v=>v&&typeof v==='object')?Object.keys(value[0]).filter(k=>value.every(v=>typeof v[k]==='number')):[];
    if(numeric.length)out.push({rowSummary:Object.fromEntries(numeric.slice(0,4).map(k=>{const xs=value.map(v=>v[k]);return [k,{min:round(Math.min(...xs)),max:round(Math.max(...xs)),first:round(xs[0]),last:round(xs.at(-1))}];}))});
    return out;
  }
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>[k,digest(v)]));
  if(typeof value==='string')return value.length>280?value.slice(0,277)+'…':value;
  if(typeof value==='number')return round(value);
  return value;
}
// Digests every tool result before index `upTo` that is not digested or condensed already.
function digestOutputs(items,upTo){for(const {item} of outputs(items,upTo)){let parsed;try{parsed=JSON.parse(item.output);}catch{continue;}if(parsed?.digest||parsed?.compacted)continue;item.output=JSON.stringify({digest:true,...(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?digest(parsed):{value:digest(parsed)})});}}
const outputs=(items,keepFrom)=>items.map((item,i)=>({item,i})).filter(({item,i})=>i<keepFrom&&item?.type==='function_call_output');
// items: the continuation; keepFrom: index of the first item from the latest round (kept in full).
// compact({results:[{callId,tool,output}]}) → {summaries:[{callId,summary}]}; returns {items,steps}.
async function fit(items,{keepFrom=items.length,limit=LIMIT,compact=null}={}){
  if(!Array.isArray(items)||size(items)<=limit*TARGET)return {items,steps:[]};
  const next=items.map(item=>({...item}));const steps=[];const calls=new Map(next.filter(i=>i?.type==='function_call').map(i=>[i.call_id,i.name]));
  digestOutputs(next,keepFrom);
  steps.push({step:'digest',bytes:size(next)});
  // One round can ask for several large lookups at once; then its own results are digested too (keys and numbers stay).
  if(size(next)>limit*TARGET){digestOutputs(next,next.length);steps.push({step:'digest-latest',bytes:size(next)});}
  if(size(next)<=limit*TARGET||!compact)return {items:next,steps};
  const older=outputs(next,keepFrom).length?outputs(next,keepFrom):outputs(next,next.length);if(!older.length)return {items:next,steps};
  let result;try{result=await compact({results:older.map(({item})=>({callId:item.call_id,tool:calls.get(item.call_id)??'tool',output:item.output}))});}catch(error){if(error?.message==='STALE_DECISION')throw error;steps.push({step:'compact',error:/^[A-Z_]{3,40}$/.test(error?.message)?error.message:'COMPACT_FAILED'});return {items:next,steps};}
  const byId=new Map((result?.summaries??[]).filter(s=>s&&typeof s.callId==='string'&&typeof s.summary==='string').map(s=>[s.callId,s.summary.slice(0,1500)]));
  for(const {item} of older)if(byId.has(item.call_id))item.output=JSON.stringify({compacted:true,summary:byId.get(item.call_id)});
  steps.push({step:'compact',bytes:size(next),usage:result?.usage??null});
  return {items:next,steps};
}
const COMPACT_SCHEMA={type:'object',properties:{summaries:{type:'array',items:{type:'object',properties:{callId:{type:'string'},summary:{type:'string'}},required:['callId','summary'],additionalProperties:false}}},required:['summaries'],additionalProperties:false};
const COMPACT_INSTRUCTIONS='You condense research results that a trading agent requested earlier in its review, so it can keep working within its context limit. For each result, write one summary of at most 900 characters for the same callId. Keep every figure the agent could use to decide: prices, changes, valuation multiples, targets and upside, estimates, ratings and counts, flows, dates and earnings timing, risk and technical readings, holdings weights, and any status or refusal reason. Keep tickers and company names. Drop repetition and formatting. Do not add opinions, recommendations or facts that are not in the result. Return one entry per callId given.';
// The first request of a review, if it is over its size limit: background sections are digested, largest first,
// until it fits; holdings, cash, prices, orders, risk and notes are never touched. Returns the steps taken.
const BACKGROUND_FIRST=['similarEpisodes','marketNarrative','macro','eventCalendar','topStories','news','performance','reviewWatches','scoutPlan','planGap','portfolioExposure','orderBooks','previousReview','research','positionSizing'];
function fitInitial(context,limit=require('./ai-models.cjs').reviewByteLimit({}),target=0.95){
  const wire=c=>size([{role:'user',content:JSON.stringify(c)}]);const steps=[];let out=context;
  if(wire(out)<=limit*target)return {context:out,steps};
  for(const key of BACKGROUND_FIRST.filter(k=>out[k]!=null).sort((a,b)=>size(out[b])-size(out[a]))){
    const before=wire(out);out={...out,[key]:digest(out[key])};steps.push({section:key,bytesSaved:before-wire(out)});if(wire(out)<=limit*target)break;}
  return {context:out,steps};
}
module.exports={fit,fitInitial,digest,size,LIMIT,COMPACT_SCHEMA,COMPACT_INSTRUCTIONS};
