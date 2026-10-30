const {validRequest,DATASETS}=require('./market-evidence.cjs');
function refusal(args,symbols){
  const symbol=typeof args?.symbol==='string'?args.symbol:'';
  if(!DATASETS.includes(args?.dataset))return `Unknown dataset ${JSON.stringify(args?.dataset??null)}. Use one of: ${DATASETS.join(', ')}.`;
  if(!symbols.includes(symbol))return `${symbol||'The symbol'} is not in this review's universe, so it has no quotes or price data here. Use get_company_research for company facts, or update_watchlist to add it to the next review's universe.`;
  return 'Invalid request: pass exactly symbol and dataset.';
}
// Up to three research rounds of up to four tool requests each; the fourth request must answer.
const ROUNDS=4,MAX_CALLS=4;
// Before every model call the complete request is measured as it will be sent. Older results are condensed or become
// references first; if the latest round is still too large, its results are bounded again to the space left (whole
// parts kept, the rest named so the agent can ask for them), and then become references. A request that still does not
// fit is not sent. keepFrom: index of the latest round's first item. store: each call's complete result and the section
// that holds it (review-context.cjs resultStore), so a result bounded again is cut from the original and still points
// to all of it, and a result condensed or referenced points there too.
async function fitRequest(items,{keepFrom,compact,log,store=null}){
  const cf=require('./context-fit.cjs'),rc=require('./review-context.cjs'),target=cf.LIMIT*cf.TARGET,refs=store?.refs()??null;
  const first=await cf.fit(items,{keepFrom,compact,refs});let out=first.items;const steps=[...first.steps];
  const latest=out.map((item,i)=>({item,i})).filter(({item,i})=>i>=keepFrom&&item?.type==='function_call_output');
  if(cf.size(out)>target&&latest.length){const room=Math.floor((target-cf.size(out)+latest.reduce((sum,{item})=>sum+cf.size(item),0))/latest.length)-300;
    // Each output is answered again from the store (the k-th output of a call id is its k-th answer), so a detail read
    // is made again within the new room and its next.from follows what it now holds.
    const seen=new Map();out=out.map((item,i)=>{if(item?.type!=='function_call_output')return item;const k=seen.get(item.call_id)??0;seen.set(item.call_id,k+1);
      return i>=keepFrom?{...item,output:JSON.stringify(store?.again(item.call_id,Math.max(800,room),k)??rc.bound(JSON.parse(item.output),Math.max(800,room)))}:item;});steps.push({step:'rebound',perCall:room,bytes:cf.size(out)});}
  if(cf.size(out)>target){const last=await cf.fit(out,{keepFrom:out.length,refs});out=last.items;steps.push(...last.steps);}
  if(steps.length)log('System','Research context condensed',JSON.stringify(steps));
  // Still over after condensing: the round is not sent (a local limit, not the provider's).
  if(cf.size(out)>cf.LIMIT){const e=new Error('CONTINUATION_OVER_BUDGET');e.detail={limit:'app bytes',stage:'research continuation',wireBytes:cf.size(out),limitBytes:cf.LIMIT,largest:out.map((it,i)=>[`item ${i} ${it?.type??it?.role}`,cf.size(it)]).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,b])=>`${k}:${b}`)};throw e;}
  return out;
}
// wrap, when given, sees every tool call (name, function) and returns the function to run: the shadow evaluation uses it
// to share evidence between the live and shadow runs and to keep both tool transcripts.
// watched: the watchlist symbols this review could research (for the coverage count in metrics).
async function researchReview({context,evidence,request,log,setWatch,setInterval,discovery,actions,compact,wrap=null,detail=null,watched=[]}){
  const via=(name,fn)=>wrap?wrap(name,fn):fn;
  let continuation,keepFrom=0;const usage={inputTokens:0,outputTokens:0,cachedTokens:0};const cache=new Map();
  const add=u=>{usage.inputTokens+=u?.inputTokens??0;usage.outputTokens+=u?.outputTokens??0;usage.cachedTokens+=u?.cachedTokens??0;};
  // Each response is bounded by the round's budget: what the request may still grow by, shared by the round's calls.
  // Every tool result is kept whole for this review (as section result-N of get_context_detail), so whatever bounding
  // cuts or leaves out can be read in full, by path, continuing from each reply's next.from. The meter counts what was asked, read and sent.
  const store=require('./review-context.cjs').resultStore(detail),meter=require('./research-meter.cjs').createMeter();
  const done=()=>meter.summary(watched);
  let perCall=16000;const answer=(call,value,keep=true,runCache=false)=>{const sent=keep?store.keep(call.callId,value,perCall):require('./review-context.cjs').bound(value,perCall);
    meter.call(call.name,call.args,value,sent,{runCache});continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(sent)});};
  // A review that fails still reports what it researched (error.metrics), for the failed review's log and a fallback run.
  try{
  for(let round=0;round<ROUNDS;round++){
    // Near the size limit, older results are digested (and if needed condensed by the cheap model) so the agent keeps what it asked for.
    if(round>0)continuation=await fitRequest(continuation,{keepFrom,compact,log,store});
    const result=await request({research:Boolean(evidence),final:round===ROUNDS-1,continuation});add(result.usage);
    if(!result.toolCalls){
      // A Buy held back because its plan is incomplete gets one request naming the missing field; the safeguard stays.
      // The answer is accepted only if it is a complete plan; otherwise the Buy stays withheld and says so.
      if(result.decision?.withheld&&Array.isArray(result.continuation)){
        const w=result.decision.withheld;log('System','Plan correction requested',`${w.quantity} ${w.symbol}: ${w.reason}`);
        const ask={role:'user',content:`The app held back your Buy of ${w.quantity} ${w.symbol} because its plan is incomplete: ${w.reason}. Return your decision again with every plan field filled from your own analysis (thesis, invalidation, stopPrice below the current price, horizonDays, confidence, portfolioImpact, evidence with sources, and valuation and uncertainty where they apply). Mark a fact verified only if you read it in its source. If you cannot justify a complete plan, return Hold. Do not change the trade only to satisfy the format.`};
        try{const items=[...result.continuation,ask];const again=await request({research:false,final:true,continuation:await fitRequest(items,{keepFrom:items.length,compact,log,store})});add(again.usage);
          if(again.decision&&!again.decision.withheld){log('System','Plan correction accepted',`${again.decision.action} ${again.decision.symbol??''} ${again.decision.quantity??''}`.trim());return {...again,usage,metrics:done(),decision:{...again.decision,planCorrected:{missing:w.reason}}};}
          log('System','Plan correction not accepted',again.decision?.withheld?.reason??'no decision');}
        catch(error){log('System','Plan correction failed',/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED');}
        const {continuation:_,...kept}=result;return {...kept,usage,metrics:done(),decision:{...result.decision,withheld:{...w,correctionTried:true}}};
      }
      const {continuation:_,...final}=result;return {...final,usage,metrics:done()};
    }
    if(!evidence||round===ROUNDS-1||result.toolCalls.length>MAX_CALLS||!Array.isArray(result.continuation))throw new Error('INVALID_AI_RESPONSE');
    keepFrom=Array.isArray(continuation)?continuation.length:0;continuation=result.continuation;
    // Before this round's results are added: older results are condensed or referenced first, then the space left
    // (below the follow-up limit, with room for the model's reply) is shared by the round's calls, at most 16 KB each.
    {const cf=require('./context-fit.cjs');const calls=Math.max(1,result.toolCalls.length);const fitted=await cf.fit(continuation,{keepFrom:continuation.length,compact,refs:store.refs(),targetBytes:cf.LIMIT*cf.TARGET-calls*8000});if(fitted.steps.length){continuation=fitted.items;log('System','Research context condensed',JSON.stringify(fitted.steps));}
      perCall=Math.max(1500,Math.min(16000,Math.floor((cf.LIMIT*cf.TARGET-cf.size(continuation))/calls)-200));}
    for(const call of result.toolCalls){
      // Summarized sections are read in full on request (review-context.cjs).
      if(call.name==='get_context_detail'){const section=String(call.args?.section??'');const value=store.read(call.args,Math.min(8000,perCall),call.callId);log('Tool','Context detail · '+section+(call.args?.part?' · '+call.args.part:''),value.status??(value.complete?'complete':'partial'));answer(call,value,false);continue;}
      if(call.name==='set_review_interval'&&setInterval){const value=await via('set_review_interval',setInterval)(call.args);log('Tool','Review interval updated',JSON.stringify(value));answer(call,value);continue;}
      if(call.name==='set_review_watch'&&setWatch){const value=await via('set_review_watch',setWatch)(call.args);log('Tool','Review watch updated',JSON.stringify(value));answer(call,value);continue;}
      // Desk tools: formulas, triggers, notes and conditional orders. A refused request is answered, not fatal; a changed account still stops the review.
      if(actions?.[call.name]){log('Agent','Desk request · '+call.name,JSON.stringify(call.args));let value;try{value=await via(call.name,actions[call.name])(call.args);}catch(error){if(error.message==='STALE_DECISION')throw error;value={status:'rejected',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DESK_REQUEST_FAILED'};}log('Tool','Desk result · '+call.name,JSON.stringify(value));answer(call,value);continue;}
      if(discovery&&['screen_market','search_securities','update_watchlist','get_company_research','get_market_overview'].includes(call.name)&&discovery[call.name]){log('Agent','Discovery request',JSON.stringify(call.args));const key=call.name==='update_watchlist'?null:call.name+JSON.stringify(call.args);let value=key?cache.get(key):undefined;const reused=value!==undefined;if(!value){try{value=await via(call.name,discovery[call.name])(call.args);}catch(error){value={status:'unavailable',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DISCOVERY_FAILED'};}if(key)cache.set(key,value);}log('Tool','Discovery result',JSON.stringify(value));answer(call,value,true,reused);continue;}
      // A refusal names what was asked and why, so the agent can switch tools and the console shows the cause.
      if(call.name!=='get_market_evidence'||!validRequest(call.args,context.universe.map(row=>row.symbol))){const value={status:'rejected',request:call.args??null,reason:call.name==='get_market_evidence'?refusal(call.args,context.universe.map(row=>row.symbol)):'UNKNOWN_TOOL'};log('Tool','Request refused · '+call.name,JSON.stringify(value));answer(call,value);continue;}
      log('Agent','Market data request',JSON.stringify(call.args));
      const key=JSON.stringify(call.args);let value=cache.get(key);const reused=value!==undefined;
      if(!value){value=await via('get_market_evidence',args=>evidence.get(args,context))(call.args);cache.set(key,value);}
      log('Tool','Market data result',JSON.stringify(value));answer(call,value,true,reused);
    }
  }
  throw new Error('INVALID_AI_RESPONSE');
  }catch(error){if(error&&typeof error==='object'&&!error.metrics)error.metrics=done();throw error;}
}
module.exports={researchReview,fitRequest,ROUNDS,MAX_CALLS};
