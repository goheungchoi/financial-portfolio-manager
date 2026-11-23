const {validRequest,DATASETS}=require('./market-evidence.cjs');
function refusal(args,symbols){
  const symbol=typeof args?.symbol==='string'?args.symbol:'';
  if(!DATASETS.includes(args?.dataset))return `Unknown dataset ${JSON.stringify(args?.dataset??null)}. Use one of: ${DATASETS.join(', ')}.`;
  if(!symbols.includes(symbol))return `${symbol||'The symbol'} is not in this review's universe, so it has no quotes or price data here. Use get_company_research for company facts, or update_watchlist to add it to the next review's universe.`;
  return 'Invalid request: pass exactly symbol and dataset.';
}
// Up to three research rounds of up to four tool requests each; the fourth request must answer. A round with more
// requests than its allowance (the instructions say four) runs the first four and answers each of the rest as not run,
// so the model can ask again; a batch over HARD_MAX_CALLS is refused as malformed (1.5.48 audit, A5).
const FINAL_ROUND_WORDS='no tools in this round: give your answer now';
const ROUNDS=4,MAX_CALLS=4,HARD_MAX_CALLS=12;
// M-4 part 3 (m4-plan.md section 4): the correction round for a decision with further orders. One request names every
// held-back order that can be corrected (correctionTargets) with its reason, and asks for those orders only. Each target
// is accepted alone when the answer has a standing order for its stock (checked as any order: validateDecision there,
// furtherAtDecision after); otherwise it stays held back, marked correctionTried. Orders that stood are never re-asked
// and stay as they were; an answer's order for any other stock is not taken. Still one extra request.
async function correctSeveral(result,targets,{request,fitRequest,log,add,finish}){
  const d=result.decision,{sameStock}=require('./broker-open-orders.cjs');
  const name=t=>`${t.action?t.action+' ':''}${t.quantity} ${t.symbol}`;
  log('System','Plan correction requested',targets.map(t=>`${name(t)}: ${t.reason}`).join('; '));
  const ask={role:'user',content:`The app held back ${targets.length===1?'one of your orders':`${targets.length} of your orders`}:\n${targets.map((t,i)=>`${i+1}. ${name(t)}: ${t.reason}.`).join('\n')}\n`+
    'Return your decision again with only these orders, corrected from your own analysis: the first in the decision and the rest in moreOrders. '+
    'For an incomplete plan, fill every plan field (thesis, invalidation, stopPrice on the losing side of the current price, horizonDays, confidence, portfolioImpact, evidence with sources, and valuation and uncertainty where they apply); mark a fact verified only if you read it in its source. '+
    'For a reversal, fill reversal from your own analysis: priorDecisionId, basis, whatChanged, priorRequirement, newEvidence with sources and dates when the basis is new evidence, and afterCost when you would buy back above the exit price; correcting the earlier reasoning is a valid basis; do not invent a changed fact. '+
    'Leave out any order you cannot justify; if none, return Hold. The orders that were not held back stand as you gave them: do not repeat them. Do not change a trade only to satisfy the format.'};
  let again=null;
  try{const items=await fitRequest([...result.continuation,ask]);again=await request({research:false,final:true,continuation:items});add(again);}
  catch(error){log('System','Plan correction failed',/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED');}
  const a=again?.decision??null,same=(x,t)=>typeof x?.symbol==='string'&&(x.symbol===t.symbol||sameStock(x.symbol,t.symbol));
  const offered=a?[...(a.action!=='Hold'?[a]:[]),...(Array.isArray(a.moreOrders)?a.moreOrders:[])]:[];
  const held=a?[...(a.withheld?[a.withheld]:[]),...(a.moreWithheld??[])]:[];
  const ORDER=['action','symbol','quantity','credit','loanDate','execution','plan','reversal','reversalFlag'],fields=o=>Object.fromEntries(ORDER.filter(k=>k in o).map(k=>[k,o[k]]));
  let first=d;const more=[...d.moreOrders],accepted=new Set();
  for(const t of targets){const m=offered.find(o=>same(o,t));
    if(!m){log('System','Plan correction not accepted',`${name(t)}: ${held.find(w=>same(w,t))?.reason??(a?'not returned':'no decision')}`);continue;}
    accepted.add(t);log('System','Plan correction accepted',`${m.action} ${m.symbol} ${m.quantity}`);
    if(t.item===0){const {withheld:_w,plan:_p,execution:_e,reversal:_r,reversalFlag:_f,...rest}=d;first={...rest,...fields(m),explanation:a.explanation,planCorrected:{missing:t.reason}};}
    else more.push({item:t.item,...fields(m),planCorrected:{missing:t.reason}});}
  // An order in the answer for a stock that was not a target is not taken, and the Journal says so (nothing the AI
  // proposed disappears without a trace).
  for(const o of offered)if(!targets.some(t=>same(o,t)))log('System','Correction order not taken',`${o.action} ${o.quantity} ${o.symbol}: not asked for; not taken.`);
  more.sort((x,y)=>(x.item??0)-(y.item??0));
  const tried=new Set(targets.filter(t=>!accepted.has(t)));
  if(first===d&&d.withheld&&targets.some(t=>t.item===0&&tried.has(t)))first={...d,withheld:{...d.withheld,correctionTried:true}};
  const target=w=>targets.find(t=>t.item!==0&&t.item===w.item);
  const withheld=(d.moreWithheld??[]).filter(w=>!(target(w)&&accepted.has(target(w)))).map(w=>target(w)?{...w,correctionTried:true}:w);
  const {moreOrders:_m,moreWithheld:_x,...out}=first;
  return finish({...out,moreOrders:more,...(withheld.length?{moreWithheld:withheld}:{})});
}
const protocolError=(rule,extra={})=>Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:{rule,...extra}});
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
  if(cf.size(out)>cf.LIMIT){const e=new Error('CONTINUATION_OVER_BUDGET');e.detail={limit:'app bytes',stage:'research continuation',wireBytes:cf.size(out),limitBytes:cf.LIMIT,largest:out.map((it,i)=>[`item ${i} ${it?.type??it?.role}`,cf.size(it)]).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,b])=>`${k}:${b}`)};e.input=out;throw e;}
  return out;
}
// watched: the watchlist symbols this review could research (for the coverage count in metrics).
async function researchReview({context,evidence,request,log,setWatch,setInterval,discovery,actions,compact,detail=null,watched=[]}){
  // Every tool call goes through via(name, fn). The shadow evaluation's evidence sharing hooked in here until step A1.
  const via=(name,fn)=>fn;
  let continuation,keepFrom=0;const usage={inputTokens:0,outputTokens:0,cachedTokens:0};const cache=new Map();
  const add=u=>{usage.inputTokens+=u?.inputTokens??0;usage.outputTokens+=u?.outputTokens??0;usage.cachedTokens+=u?.cachedTokens??0;};
  // Claude thinking blocks the API dropped in this review (anthropic-client.cjs droppedThinking, after condensing
  // rewrote an older result). Counted only when a Claude call reported it, so OpenAI metrics keep their shape.
  let dropped=null;const drops=r=>{if(Number.isInteger(r?.droppedThinking)&&r.droppedThinking>=0)dropped=(dropped??0)+r.droppedThinking;};
  // Each response is bounded by the round's budget: what the request may still grow by, shared by the round's calls.
  // Every tool result is kept whole for this review (as section result-N of get_context_detail), so whatever bounding
  // cuts or leaves out can be read in full, by path, continuing from each reply's next.from. The meter counts what was asked, read and sent.
  const store=require('./review-context.cjs').resultStore(detail),meter=require('./research-meter.cjs').createMeter();
  // What research tools changed before the review ended (desk orders, triggers, notes, the watch and the interval): a
  // review that fails afterwards reports these apart from its result, never as "nothing happened" (1.5.48 audit, A5).
  const changes=[];const applied=(name,value)=>{if(value&&typeof value==='object'&&['rejected','unavailable','error'].includes(value.status))return;changes.push({tool:name,status:typeof value?.status==='string'?value.status.slice(0,30):'applied',...(value?.id?{id:String(value.id).slice(0,60)}:{})});};
  const done=()=>{const m=meter.summary(watched);return dropped==null?m:{...m,droppedThinking:dropped};};
  let perCall=16000;const answer=(call,value,keep=true,runCache=false)=>{const sent=keep?store.keep(call.callId,value,perCall):require('./review-context.cjs').bound(value,perCall);
    meter.call(call.name,call.args,value,sent,{runCache});continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(sent)});};
  // A review that fails still reports what it researched (error.metrics), for the failed review's log and a fallback run.
  try{
  for(let round=0;round<ROUNDS;round++){
    // Near the size limit, older results are digested (and if needed condensed by the cheap model) so the agent keeps what it asked for.
    if(round>0)continuation=await fitRequest(continuation,{keepFrom,compact,log,store});
    let result=await request({research:Boolean(evidence),final:round===ROUNDS-1,continuation});add(result.usage);drops(result);
    // A tool request on the final round (both clients return it flagged): each call is answered "no tools in this round"
    // and one more final request is made; a tool request in that one fails the review, as before.
    if(round===ROUNDS-1&&result.toolCalls?.length&&evidence&&Array.isArray(result.continuation)){const S=require('./scout.cjs');
      log('System','Tool request on the final round',`${result.toolCalls.length} (${[...new Set(result.toolCalls.map(c=>String(c.name).slice(0,40)))].slice(0,8).join(', ')}): answered "no tools in this round"; one more request`);
      const items=[...result.continuation];
      for(const c of result.toolCalls){let value={status:'error',words:FINAL_ROUND_WORDS};if(c.name==='run_screen'&&typeof actions?.run_screen==='function'){try{const v=await actions.run_screen(c.args,{notRun:FINAL_ROUND_WORDS});if(v&&typeof v==='object')value=v;}catch{}}
        meter.call(c.name,c.args,value,value);items.push({type:'function_call_output',call_id:c.callId,output:JSON.stringify(value)});}
      const replace=new Map();for(const c of result.toolCalls)if(c.name==='run_screen')replace.set(c.callId,S.screenStandIn(c.args,{reason:'no tools in the final round'}));S.shrinkCalls(items,replace);
      result=await request({research:Boolean(evidence),final:true,continuation:await fitRequest(items,{keepFrom:items.length,compact,log,store})});add(result.usage);drops(result);
      if(result.toolCalls?.length)throw protocolError('a tool request on the final round',{round:ROUNDS+1,toolCount:result.toolCalls.length,tools:[...new Set(result.toolCalls.map(c=>String(c.name).slice(0,40)))].slice(0,8)});}
    if(!result.toolCalls){
      // M-4 part 3: with further orders, one request lists every held-back order that can be corrected (the first and
      // the further ones, each with its reason); each corrected order is accepted or not on its own, by stock.
      if(Array.isArray(result.decision?.moreOrders)&&Array.isArray(result.continuation)){const targets=require('./ai-client.cjs').correctionTargets(result.decision);
        if(targets.length)return await correctSeveral(result,targets,{request,fitRequest:items=>fitRequest(items,{keepFrom:items.length,compact,log,store}),log,add:r=>{add(r.usage);drops(r);},finish:decision=>{const {continuation:_,...kept}=result;return {...kept,usage,metrics:done(),decision};}});}
      // A Buy held back because its plan is incomplete gets one request naming the missing field; the safeguard stays.
      // The answer is accepted only if it is a complete plan; otherwise the Buy stays withheld and says so.
      if(result.decision?.withheld&&Array.isArray(result.continuation)){
        const w=result.decision.withheld;log('System',w.kind==='reversal'?'Reversal explanation requested':'Plan correction requested',`${w.quantity} ${w.symbol}: ${w.reason}`);
        // A reversal held back gets the same single request, for its reversal explanation (audit 2026-11-04, Stage 4).
        const ask=w.kind==='reversal'?{role:'user',content:`The app held back your opening of ${w.quantity} ${w.symbol} because ${w.reason}. Return your decision again with reversal filled from your own analysis: priorDecisionId, basis, whatChanged, priorRequirement, newEvidence with sources and dates when the basis is new evidence, and afterCost when you would buy back above the exit price. Correcting the earlier reasoning is a valid basis; do not invent a changed fact. If nothing has changed and the earlier reasoning stands, return Hold.`}:{role:'user',content:`The app held back your Buy of ${w.quantity} ${w.symbol} because its plan is incomplete: ${w.reason}. Return your decision again with every plan field filled from your own analysis (thesis, invalidation, stopPrice below the current price, horizonDays, confidence, portfolioImpact, evidence with sources, and valuation and uncertainty where they apply). Mark a fact verified only if you read it in its source. If you cannot justify a complete plan, return Hold. Do not change the trade only to satisfy the format.`};
        try{const items=[...result.continuation,ask];const again=await request({research:false,final:true,continuation:await fitRequest(items,{keepFrom:items.length,compact,log,store})});add(again.usage);drops(again);
          if(again.decision&&!again.decision.withheld){log('System','Plan correction accepted',`${again.decision.action} ${again.decision.symbol??''} ${again.decision.quantity??''}`.trim());return {...again,usage,metrics:done(),decision:{...again.decision,planCorrected:{missing:w.reason}}};}
          log('System','Plan correction not accepted',again.decision?.withheld?.reason??'no decision');}
        catch(error){log('System','Plan correction failed',/^[A-Z_]{3,40}$/.test(error.message)?error.message:'REQUEST_FAILED');}
        const {continuation:_,...kept}=result;return {...kept,usage,metrics:done(),decision:{...result.decision,withheld:{...w,correctionTried:true}}};
      }
      const {continuation:_,...final}=result;return {...final,usage,metrics:done()};
    }
    const tools=[...new Set(result.toolCalls.map(c=>String(c.name).slice(0,40)))].slice(0,8);
    if(!evidence)throw protocolError('a tool request in a review without research',{round:round+1,toolCount:result.toolCalls.length,tools});
    if(round===ROUNDS-1)throw protocolError('a tool request on the final round',{round:round+1,toolCount:result.toolCalls.length,tools});
    if(result.toolCalls.length>HARD_MAX_CALLS)throw protocolError(`more tool requests at once than the ceiling of ${HARD_MAX_CALLS}`,{round:round+1,toolCount:result.toolCalls.length,tools});
    if(!Array.isArray(result.continuation))throw protocolError('a tool request without its conversation',{round:round+1});
    keepFrom=Array.isArray(continuation)?continuation.length:0;continuation=result.continuation;
    {const S=require('./scout.cjs');const replace=new Map();result.toolCalls.forEach((c,i)=>{if(c.name==='run_screen')replace.set(c.callId,S.screenStandIn(c.args,{skipped:i>=MAX_CALLS}));});S.shrinkCalls(continuation,replace);}
    const over=result.toolCalls.slice(MAX_CALLS);if(over.length)log('System','Research requests over the round limit',`${result.toolCalls.length} requests in round ${round+1}; the first ${MAX_CALLS} run, ${over.length} answered as not run (${over.map(c=>c.name).join(', ')}).`);
    // Before this round's results are added: older results are condensed or referenced first, then the space left
    // (below the follow-up limit, with room for the model's reply) is shared by the round's calls, at most 16 KB each.
    {const cf=require('./context-fit.cjs');const calls=Math.max(1,result.toolCalls.length);const fitted=await cf.fit(continuation,{keepFrom:continuation.length,compact,refs:store.refs(),targetBytes:cf.LIMIT*cf.TARGET-calls*8000});if(fitted.steps.length){continuation=fitted.items;log('System','Research context condensed',JSON.stringify(fitted.steps));}
      perCall=Math.max(1500,Math.min(16000,Math.floor((cf.LIMIT*cf.TARGET-cf.size(continuation))/calls)-200));}
    for(const call of result.toolCalls.slice(0,MAX_CALLS)){
      // Summarized sections are read in full on request (review-context.cjs).
      if(call.name==='get_context_detail'){const section=String(call.args?.section??'');const value=store.read(call.args,Math.min(8000,perCall),call.callId);log('Tool','Context detail · '+section+(call.args?.part?' · '+call.args.part:''),value.status??(value.complete?'complete':'partial'));answer(call,value,false);continue;}
      if(call.name==='set_review_interval'&&setInterval){const value=await via('set_review_interval',setInterval)(call.args);log('Tool','Review interval updated',JSON.stringify(value));applied(call.name,value);answer(call,value);continue;}
      if(call.name==='set_review_watch'&&setWatch){const value=await via('set_review_watch',setWatch)(call.args);log('Tool','Review watch updated',JSON.stringify(value));applied(call.name,value);answer(call,value);continue;}
      // Desk tools: formulas, triggers, notes and conditional orders. A refused request is answered, not fatal; a changed account still stops the review.
      if(actions?.[call.name]){log('Agent','Desk request · '+call.name,JSON.stringify(call.args));let value;const noRoom=call.name==='run_screen'&&require('./context-fit.cjs').size(continuation)+perCall>require('./context-fit.cjs').LIMIT*require('./context-fit.cjs').TARGET;
        try{value=await via(call.name,noRoom?args=>actions.run_screen(args,{noRoom:true}):actions[call.name])(call.args);}catch(error){if(error.message==='STALE_DECISION')throw error;value={status:'rejected',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DESK_REQUEST_FAILED'};}log('Tool','Desk result · '+call.name,JSON.stringify(value));if(call.name!=='run_screen')applied(call.name,value);answer(call,value);continue;}
      if(discovery&&['screen_market','search_securities','update_watchlist','get_company_research','get_market_overview'].includes(call.name)&&discovery[call.name]){log('Agent','Discovery request',JSON.stringify(call.args));const key=call.name==='update_watchlist'?null:call.name+JSON.stringify(call.args);let value=key?cache.get(key):undefined;const reused=value!==undefined;if(!value){try{value=await via(call.name,discovery[call.name])(call.args);}catch(error){value={status:'unavailable',reason:/^[A-Z_]{3,40}$/.test(error.message)?error.message:'DISCOVERY_FAILED'};}if(key)cache.set(key,value);}log('Tool','Discovery result',JSON.stringify(value));answer(call,value,true,reused);continue;}
      // A refusal names what was asked and why, so the agent can switch tools and the console shows the cause.
      if(call.name!=='get_market_evidence'||!validRequest(call.args,context.universe.map(row=>row.symbol))){const value={status:'rejected',request:call.args??null,reason:call.name==='get_market_evidence'?refusal(call.args,context.universe.map(row=>row.symbol)):'UNKNOWN_TOOL'};log('Tool','Request refused · '+call.name,JSON.stringify(value));answer(call,value);continue;}
      log('Agent','Market data request',JSON.stringify(call.args));
      const key=JSON.stringify(call.args);let value=cache.get(key);const reused=value!==undefined;
      if(!value){value=await via('get_market_evidence',args=>evidence.get(args,context))(call.args);cache.set(key,value);}
      log('Tool','Market data result',JSON.stringify(value));answer(call,value,true,reused);
    }
    // The requests over the round's allowance, answered in their order after the ones that ran: nothing was done for them.
    for(const call of over)continuation.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify({status:'not_run',reason:`over this round's limit of ${MAX_CALLS} requests; nothing was done for it. Ask again in the next round if it is still needed.`})});
  }
  throw protocolError(`no decision after ${ROUNDS} research rounds`,{round:ROUNDS});
  }catch(error){if(error&&typeof error==='object'){if(!error.metrics)error.metrics=done();if(changes.length&&!error.applied)error.applied=changes;}throw error;}
}
module.exports={researchReview,fitRequest,ROUNDS,MAX_CALLS,HARD_MAX_CALLS};
