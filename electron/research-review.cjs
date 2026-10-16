const {validRequest}=require('./market-evidence.cjs');
async function researchReview({context,evidence,request,log,setWatch,setInterval}){
  let continuation;const usage={inputTokens:0,outputTokens:0};const cache=new Map();
  for(let round=0;round<3;round++){
    const result=await request({research:Boolean(evidence),final:round===2,continuation});
    usage.inputTokens+=result.usage?.inputTokens??0;usage.outputTokens+=result.usage?.outputTokens??0;
    if(!result.toolCalls)return {...result,usage};
    if(!evidence||round===2||result.toolCalls.length>2||!Array.isArray(result.continuation))throw new Error('INVALID_AI_RESPONSE');
    continuation=result.continuation;
    for(const call of result.toolCalls){
      if(call.name==='set_review_interval'&&setInterval){const value=await setInterval(call.args);log('Tool','Review interval updated',JSON.stringify(value));continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(value)});continue;}
      if(call.name==='set_review_watch'&&setWatch){const value=await setWatch(call.args);log('Tool','Review watch updated',JSON.stringify(value));continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(value)});continue;}
      if(call.name!=='get_market_evidence'||!validRequest(call.args,context.universe.map(row=>row.symbol)))throw new Error('INVALID_AI_RESPONSE');
      log('Agent','Market data request',JSON.stringify(call.args));
      const key=JSON.stringify(call.args);let value=cache.get(key);
      if(!value){value=await evidence.get(call.args,context);cache.set(key,value);}
      log('Tool','Market data result',JSON.stringify(value));
      continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(value)});
    }
  }
  throw new Error('INVALID_AI_RESPONSE');
}
module.exports={researchReview};
