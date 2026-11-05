'use strict';
// Isolated provider test: one budget for every model request in the process (review, research rounds, repairs,
// retries, condensing). The controlled transport reserves before it sends and settles after; nothing else can send.
// - The reservation is an upper bound for the whole request as serialized (instructions, schema, tools, input and
//   continuation are all in the body): input tokens are at most the body's UTF-8 bytes (every token covers at least
//   one byte) plus OVERHEAD_TOKENS for the provider's own message framing, all billed at the uncached rate; output is
//   the request's explicit max_output_tokens (which includes reasoning) at the output rate; the long-context rates
//   apply when the bound passes the long-context threshold. A body without max_output_tokens, an unknown model or an
//   unknown service tier is not sent.
// - Reservations are taken synchronously, so concurrent requests cannot overcommit. A request that would pass the
//   request limit or the dollar ceiling is not started (BUDGET_STOP).
// - After a response the reservation becomes the actual cost from the reported usage (ai-models.cjs costDetails,
//   which bills output tokens once: reasoning tokens are part of them and reported apart only). A request whose cost
//   is unknown (no usage reported, a failure, a timeout) keeps its whole reservation.
const models=require('../../electron/ai-models.cjs');
const OVERHEAD_TOKENS=2048,LONG_CONTEXT_TOKENS=272000,TIERS=['default'];
const stop=(reason,detail)=>Object.assign(new Error('BUDGET_STOP'),{reason,detail});
class Meter {
  constructor({requests=6,usd=0.5}={}){this.limit={requests,micro:Math.round(usd*1e6)};this.entries=[];}
  // What has been committed: reservations still open, actual costs, and reservations kept for unknown costs.
  committed(){return this.entries.reduce((n,e)=>n+(e.status==='settled'?e.actualMicro:e.reservedMicro),0);}
  bound(body){
    let b;try{b=JSON.parse(body);}catch{throw stop('unreadable request body');}
    const rate=models.MODELS[b.model];if(!rate)throw stop('unknown model pricing',String(b.model));
    const tier=b.service_tier??'default';if(!TIERS.includes(tier))throw stop('unknown service tier',String(tier));
    const maxOut=b.max_output_tokens;if(!Number.isSafeInteger(maxOut)||maxOut<=0)throw stop('no explicit max_output_tokens');
    const bytes=Buffer.byteLength(body),inputTokens=bytes+OVERHEAD_TOKENS,long=inputTokens>LONG_CONTEXT_TOKENS;
    const micro=Math.ceil(inputTokens*rate.input*(long?2:1)+maxOut*rate.output*(long?1.5:1));
    return {model:b.model,tier,bytes,inputTokens,maxOutputTokens:maxOut,long,reservedMicro:micro};
  }
  reserve(body){
    const bound=this.bound(body);
    if(this.entries.length+1>this.limit.requests)throw stop('request limit',`${this.limit.requests} requests`);
    const committed=this.committed();if(committed+bound.reservedMicro>this.limit.micro)throw stop('dollar ceiling',`$${(committed/1e6).toFixed(6)} committed, $${(bound.reservedMicro/1e6).toFixed(6)} needed, $${(this.limit.micro/1e6).toFixed(2)} ceiling`);
    const entry={n:this.entries.length+1,status:'reserved',...bound};this.entries.push(entry);return entry;
  }
  settle(entry,usage,model=null){
    const cost=usage?models.costDetails(model??entry.model,usage):null;
    if(!cost){entry.status='unknown-cost';return entry;}
    Object.assign(entry,{status:'settled',actualMicro:cost.micro,usage,reasoningTokens:usage.reasoningTokens??null,boundHeld:usage.inputTokens<=entry.inputTokens&&usage.outputTokens<=entry.maxOutputTokens});return entry;
  }
  summary(){return {limit:{requests:this.limit.requests,usd:this.limit.micro/1e6},requests:this.entries.length,committedUSD:this.committed()/1e6,
    actualUSD:this.entries.filter(e=>e.status==='settled').reduce((n,e)=>n+e.actualMicro,0)/1e6,unknownCostRequests:this.entries.filter(e=>e.status!=='settled').length,entries:this.entries};}
}
module.exports={Meter,OVERHEAD_TOKENS,LONG_CONTEXT_TOKENS};
