// Keeps a research review's follow-up request under the size limit without cutting evidence by row position.
// Each tool response is already bounded when it is appended (review-context.cjs bound). When the conversation still
// grows past the budget, older results (never the latest round) are first condensed by the cheap model, which keeps
// every figure, date and refusal; if that is not possible or not enough, the largest older results become references
// that name the request, so the agent can ask again and read them in full.
const LIMIT=require('./ai-models.cjs').reviewByteLimit({continuation:true}),TARGET=0.9;
const size=value=>Buffer.byteLength(JSON.stringify(value));
const outputs=(items,keepFrom)=>items.map((item,i)=>({item,i})).filter(({item,i})=>i<keepFrom&&item?.type==='function_call_output');
const settled=item=>{try{const v=JSON.parse(item.output);return Boolean(v?.compacted||v?.reference);}catch{return false;}};
// items: the continuation; keepFrom: index of the first item from the latest round (kept in full).
// compact({results:[{callId,tool,output}]}) → {summaries:[{callId,summary}]}; returns {items,steps}.
// targetBytes: the size to reach (default: the limit's fitting point); before a round it leaves room for its results.
// refs: call id → the get_context_detail section holding that result in full (review-context.cjs resultStore); a result
// condensed or referenced here then points there, so reading it again needs no new tool request.
async function fit(items,{keepFrom=items.length,limit=LIMIT,compact=null,targetBytes=limit*TARGET,refs=null}={}){
  const full=id=>refs?.has(id)?{fullResult:{section:refs.get(id)}}:{};
  if(!Array.isArray(items)||size(items)<=targetBytes)return {items,steps:[]};
  const next=items.map(item=>({...item}));const steps=[];const calls=new Map(next.filter(i=>i?.type==='function_call').map(i=>[i.call_id,{name:i.name,args:i.arguments}]));
  const older=()=>outputs(next,keepFrom).filter(({item})=>!settled(item)).sort((a,b)=>b.item.output.length-a.item.output.length);
  if(compact&&older().length){
    const batch=older();let result;
    try{result=await compact({results:batch.map(({item})=>({callId:item.call_id,tool:calls.get(item.call_id)?.name??'tool',output:item.output}))});}
    catch(error){if(error?.message==='STALE_DECISION')throw error;steps.push({step:'compact',error:/^[A-Z_]{3,40}$/.test(error?.message)?error.message:'COMPACT_FAILED'});}
    if(result){const byId=new Map((result.summaries??[]).filter(s=>s&&typeof s.callId==='string'&&typeof s.summary==='string').map(s=>[s.callId,s.summary.slice(0,1500)]));
      for(const {item} of batch)if(byId.has(item.call_id))item.output=JSON.stringify({compacted:true,summary:byId.get(item.call_id),request:calls.get(item.call_id)??null,...full(item.call_id)});
      steps.push({step:'compact',bytes:size(next),usage:result.usage??null});}
  }
  for(const {item} of outputs(next,keepFrom).sort((a,b)=>b.item.output.length-a.item.output.length)){
    if(size(next)<=targetBytes)break;if(JSON.parse(item.output)?.reference)continue;
    item.output=JSON.stringify({reference:true,request:calls.get(item.call_id)??null,...full(item.call_id),note:refs?.has(item.call_id)?'Read earlier in this run; read it again in full with get_context_detail (section fullResult.section, from 0).':'Read earlier in this review; call the same tool with the same arguments to read it again in full.'});}
  if(steps.at(-1)?.step!=='compact'||size(next)!==steps.at(-1).bytes)steps.push({step:'reference',bytes:size(next)});
  return {items:next,steps};
}
const COMPACT_SCHEMA={type:'object',properties:{summaries:{type:'array',items:{type:'object',properties:{callId:{type:'string'},summary:{type:'string'}},required:['callId','summary'],additionalProperties:false}}},required:['summaries'],additionalProperties:false};
const COMPACT_INSTRUCTIONS='You condense research results that a trading agent requested earlier in its review, so it can keep working within its context limit. For each result, write one summary of at most 900 characters for the same callId. Keep every figure the agent could use to decide: prices, changes, valuation multiples, targets and upside, estimates, ratings and counts, flows, dates and earnings timing, risk and technical readings, holdings weights, and any status or refusal reason. Keep tickers and company names. Drop repetition and formatting. Do not add opinions, recommendations or facts that are not in the result. Return one entry per callId given.';
module.exports={fit,size,LIMIT,TARGET,COMPACT_SCHEMA,COMPACT_INSTRUCTIONS};
