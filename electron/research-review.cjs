const {validRequest,DATASETS}=require('./market-evidence.cjs');
function refusal(args,symbols){
  const symbol=typeof args?.symbol==='string'?args.symbol:'';
  if(!DATASETS.includes(args?.dataset))return `Unknown dataset ${JSON.stringify(args?.dataset??null)}. Use one of: ${DATASETS.join(', ')}.`;
  if(!symbols.includes(symbol))return `${symbol||'The symbol'} is not in this review's universe, so it has no quotes or price data here. Use get_company_research for company facts, or update_watchlist to add it to the next review's universe.`;
  return 'Invalid request: pass exactly symbol and dataset.';
}
// Up to three research rounds of up to four tool requests each; the fourth request must answer.
const ROUNDS=4,MAX_CALLS=4;
// wrap, when given, sees every tool call (name, function) and returns the function to run: the shadow evaluation uses it
// to share evidence between the live and shadow runs and to keep both tool transcripts.
async function researchReview({context,evidence,request,log,setWatch,setInterval,discovery,actions,compact,wrap=null}){
  const via=(name,fn)=>wrap?wrap(name,fn):fn;
  let continuation,keepFrom=0;const usage={inputTokens:0,outputTokens:0};const cache=new Map();
  const answer=(call,value)=>continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(value)});
  for(let round=0;round<ROUNDS;round++){
    // Near the size limit, older results are digested (and if needed condensed by the cheap model) so the agent keeps what it asked for.
    if(round>0){const fitted=await require('./context-fit.cjs').fit(continuation,{keepFrom,compact});if(fitted.steps.length){continuation=fitted.items;log('System','Research context condensed',JSON.stringify(fitted.steps));}}
    const result=await request({research:Boolean(evidence),final:round===ROUNDS-1,continuation});
    usage.inputTokens+=result.usage?.inputTokens??0;usage.outputTokens+=result.usage?.outputTokens??0;
    if(!result.toolCalls)return {...result,usage};
    if(!evidence||round===ROUNDS-1||result.toolCalls.length>MAX_CALLS||!Array.isArray(result.continuation))throw new Error('INVALID_AI_RESPONSE');
    keepFrom=Array.isArray(continuation)?continuation.length:0;continuation=result.continuation;
    for(const call of result.toolCalls){
      if(call.name==='set_review_interval'&&setInterval){const value=await via('set_review_interval',setInterval)(call.args);log('Tool','Review interval updated',JSON.stringify(value));answer(call,value);continue;}
      if(call.name==='set_review_watch'&&setWatch){const value=await via('set_review_watch',setWatch)(call.args);log('Tool','Review watch updated',JSON.stringify(value));answer(call,value);continue;}
      // Desk tools: formulas, triggers, notes and conditional orders. A refused request is answered, not fatal; a changed account still stops the review.
      if(actions?.[call.name]){log('Agent','Desk request · '+call.name,JSON.stringify(call.args));let value;try{value=await via(call.name,actions[call.name])(call.args);}catch(error){if(error.message==='STALE_DECISION')throw error;value={status:'rejected',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DESK_REQUEST_FAILED'};}log('Tool','Desk result · '+call.name,JSON.stringify(value));answer(call,value);continue;}
      if(discovery&&['screen_market','search_securities','update_watchlist','get_company_research','get_market_overview'].includes(call.name)&&discovery[call.name]){log('Agent','Discovery request',JSON.stringify(call.args));const key=call.name==='update_watchlist'?null:call.name+JSON.stringify(call.args);let value=key?cache.get(key):undefined;if(!value){try{value=await via(call.name,discovery[call.name])(call.args);}catch(error){value={status:'unavailable',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DISCOVERY_FAILED'};}if(key)cache.set(key,value);}log('Tool','Discovery result',JSON.stringify(value));answer(call,value);continue;}
      // A refusal names what was asked and why, so the agent can switch tools and the console shows the cause.
      if(call.name!=='get_market_evidence'||!validRequest(call.args,context.universe.map(row=>row.symbol))){const value={status:'rejected',request:call.args??null,reason:call.name==='get_market_evidence'?refusal(call.args,context.universe.map(row=>row.symbol)):'UNKNOWN_TOOL'};log('Tool','Request refused · '+call.name,JSON.stringify(value));answer(call,value);continue;}
      log('Agent','Market data request',JSON.stringify(call.args));
      const key=JSON.stringify(call.args);let value=cache.get(key);
      if(!value){value=await via('get_market_evidence',args=>evidence.get(args,context))(call.args);cache.set(key,value);}
      log('Tool','Market data result',JSON.stringify(value));answer(call,value);
    }
  }
  throw new Error('INVALID_AI_RESPONSE');
}
module.exports={researchReview,ROUNDS,MAX_CALLS};
