// Claude (Anthropic Messages API) beside OpenAI: Anthropic provider design, artifacts/reviews/2026-11-10-anthropic-provider.
// Step A3: the portfolio decision only; scout, condensing, summary and reflection come in stage B.
// Same instructions, tools, decision schema, validation and return shape as AiClient.decide (ai-client.cjs); the
// loops keep their item list and this client translates it to and from Claude messages at the wire (design 5.3).
// Official SDK (@anthropic-ai/sdk, pinned in package.json): no SDK retries (decisionWithRetry owns retries, so the
// accounting stays one call per attempt), an explicit timeout, and the app's transport as the SDK's fetch.
// Decisions taken by the user (design 10): no refusal fallback (no `fallbacks`, no server-side-fallback beta; a refusal
// is AI_REFUSED: a failed review, no order), medium effort for decisions.
const C=require('./ai-client.cjs');const M=require('./ai-models.cjs');
const BETA='thinking-binding-controls-2026-08-01';
const TIMEOUT_MS=require('./ai-router.cjs').CLAUDE_TIMEOUT_MS;
// B2: 32,000, because thinking counts toward max_tokens on Claude Opus 5.5 (model-migration.md, Breaking change 1); the
// reservation follows it (ai-models.cjs maxOutput).
const MAX_TOKENS=32000;
const SDK=()=>{const m=require('@anthropic-ai/sdk');return m.default??m.Anthropic??m;};
// Every SDK 1.3.0 client input that otherwise comes from the environment or disk, set explicitly. With an apiKey given
// in code the SDK reads no other credential (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, profiles under
// ANTHROPIC_CONFIG_DIR / ANTHROPIC_PROFILE / APPDATA / HOME, workload identity ANTHROPIC_FEDERATION_RULE_ID and the
// rest); authToken:null keeps ANTHROPIC_AUTH_TOKEN unread as well. baseURL replaces ANTHROPIC_BASE_URL, webhookKey
// ANTHROPIC_WEBHOOK_SIGNING_KEY, logLevel and logger ANTHROPIC_LOG, openTelemetry ANTHROPIC_OPEN_TELEMETRY*. The SDK
// still reads ANTHROPIC_CUSTOM_HEADERS: the fetch wrapper drops any header not on its allowlist. The list is in
// artifacts/reviews/2026-11-10-anthropic-provider/report.md (A3b).
const QUIET={debug(){},info(){},warn(){},error(){}};
const LOCKED=Object.freeze({baseURL:'https://api.anthropic.com',authToken:null,webhookKey:null,logLevel:'off',logger:QUIET,openTelemetry:{propagation:false,traces:false},defaultHeaders:{}});
const ENDPOINT=url=>{try{const u=new URL(String(url));return u.origin==='https://api.anthropic.com'&&u.pathname==='/v1/messages'&&['','?beta=true'].includes(u.search)&&!u.username&&!u.password&&!u.hash;}catch{return false;}};
const HEADER_ALLOWED=name=>['accept','content-type','anthropic-version','anthropic-beta','authorization','user-agent','idempotency-key','x-stainless-timeout','x-stainless-retry-count'].includes(name)||/^x-stainless-(arch|lang|os|package-version|runtime|runtime-version|helper-method)$/.test(name);
const fail=(rule,extra={})=>Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:{rule,...extra}});

// JSON Schema keywords Claude's structured outputs do not accept (numeric, string and array constraints). The app's own
// validators (validateDecision, the tool-argument checks) enforce them after the reply, so nothing is loosened. A union
// type (type: ['number','null']) becomes anyOf, which the structured-output docs list; the other keywords of that node
// stay on its non-null branch. Walks schema positions only: a property NAMED like a keyword is left alone.
const UNSUPPORTED=['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','minProperties','maxProperties'];
function toAnthropicSchema(schema){
  const node=s=>{
    if(!s||typeof s!=='object'||Array.isArray(s))return s;
    const out={};
    for(const [k,v] of Object.entries(s)){
      if(UNSUPPORTED.includes(k))continue;
      if(k==='properties'||k==='$defs'||k==='definitions')out[k]=Object.fromEntries(Object.entries(v??{}).map(([name,sub])=>[name,node(sub)]));
      else if(k==='items'||k==='additionalProperties'&&typeof v==='object'||k==='not')out[k]=node(v);
      else if(['anyOf','allOf','oneOf'].includes(k))out[k]=(v??[]).map(node);
      else out[k]=v;
    }
    if(Array.isArray(out.type)){const {type,description,...rest}=out;const branch=t=>t==='null'?{type:'null'}:{type:t,...rest};
      return {...(description!==undefined?{description}:{}),anyOf:type.map(branch)};}
    return out;
  };
  return node(JSON.parse(JSON.stringify(schema)));
}
// OpenAI function tools → Claude tools, in the same order every call (the order is part of the cached prefix).
const toTools=tools=>tools.map(t=>({name:t.name,description:t.description,input_schema:toAnthropicSchema(t.parameters)}));

// The item list → Claude messages (design 5.3). A user item is a user message; an anthropic_turn is the assistant
// message with its blocks exactly as Claude returned them (thinking included); the synthetic function_call items
// beside a turn are skipped (they are inside the turn); consecutive function_call_output items become ONE user
// message of tool_result blocks, in call order. Items from OpenAI (reasoning, message, function_call) are refused.
function toMessages(items){
  const messages=[];let results=null;
  const flush=()=>{if(results){messages.push({role:'user',content:results});results=null;}};
  for(const item of items){
    if(C.fromOpenAI(item))throw fail('a conversation from another provider');
    if(item?.type==='function_call_output'){(results??=[]).push({type:'tool_result',tool_use_id:String(item.call_id),content:String(item.output??'')});continue;}
    flush();
    if(item?.type==='anthropic_turn'){if(!Array.isArray(item.content))throw fail('a malformed assistant turn');messages.push({role:'assistant',content:item.content});}
    else if(item?.type==='function_call'&&item.vendor==='anthropic')continue;
    else if(item?.role==='user'&&(typeof item.content==='string'||Array.isArray(item.content)))messages.push({role:'user',content:item.content});
    else throw fail('an item the Claude client cannot send');
  }
  flush();return messages;
}
// Anthropic status and error type → the app's codes (design 5.4). Only a fixed code leaves this function: never the
// provider's message, which can quote the request.
function mapError(error){
  const S=SDK();if(error?.name==='AbortError'||error?.name==='TimeoutError'||error instanceof S.APIConnectionTimeoutError)return 'AI_TIMEOUT';
  if(error instanceof S.APIConnectionError)return 'AI_REQUEST_FAILED';
  if(!(error instanceof S.APIError))return null;
  const status=error.status,type=error.type??error.error?.error?.type??null,text=String(error.error?.error?.message??'');
  const credit=/credit balance is too low/i.test(text);
  if(status===401||type==='authentication_error')return 'AI_AUTH_FAILED';
  if(status===402||type==='billing_error'||credit&&[400,403].includes(status))return 'AI_QUOTA_EXHAUSTED';
  if(status===403||status===404||type==='permission_error'||type==='not_found_error')return 'AI_MODEL_UNAVAILABLE';
  if(status===429||type==='rate_limit_error')return 'AI_RATE_LIMITED';
  if(status===413||type==='request_too_large')return 'CONTEXT_TOO_LARGE';
  if(status===400&&/prompt is too long/i.test(text))return 'AI_CONTEXT_LIMIT';
  if(status===400||type==='invalid_request_error')return 'AI_BAD_REQUEST';
  if(status>=500||type==='api_error'||type==='overloaded_error')return 'AI_REQUEST_FAILED';
  // Any other 4xx is a request the API will refuse again: not retried (A3 review, finding 3).
  if(status>=400&&status<500)return 'AI_BAD_REQUEST';
  return null;
}
// What an API error keeps for looking it up later in the Console (A3 review, finding 2): the response's request id and
// the error type, each pattern-checked. Nothing else from the body: the provider message can quote the request.
function errorDetail(error){
  const S=SDK();if(!(error instanceof S.APIError))return null;
  const id=String(error.requestID??error.headers?.get?.('request-id')??''),type=String(error.type??error.error?.error?.type??'');
  const out={...(/^[A-Za-z0-9_-]{1,64}$/.test(id)?{requestId:id}:{}),...(/^[a-z_]{1,40}$/.test(type)?{errorType:type}:{})};
  return Object.keys(out).length?out:null;
}

const hasToolHistory=items=>items.some(i=>i?.type==='function_call_output'||i?.type==='anthropic_turn'&&Array.isArray(i.content)&&i.content.some(b=>b?.type==='tool_use'));
class AnthropicClient {
  #key;
  // timeoutMs: per-call timeouts, overridable for tests only.
  constructor(key,transport=fetch,{timeoutMs=TIMEOUT_MS}={}){if(typeof key!=='string'||!/^[A-Za-z0-9_\-]{10,512}$/.test(key))throw new Error('INVALID_PROVIDER_FILE');this.#key=key;this.transport=transport;this.timeoutMs={...TIMEOUT_MS,...timeoutMs};}
  // One SDK client per call: its fetch measures this call's request parts and response size, keeps redirect:'error',
  // and hands the SDK a plain Response built from the body text (the transport may return a Response-like object).
  // B1: the key Test (key-test.cjs) through the SDK's model list: no tokens, one attempt (maxRetries 0), the same
  // credential and header rules as client(), and only this one address allowed. Only the status is read. The key goes
  // as Authorization: Bearer, as the SDK sends it for API version 2026-10-21 (platform.claude.com/docs/en/manage-claude/
  // authentication.md: "Send it as Authorization: Bearer <key>"); no beta header on the model list.
  async testKey(timeoutMs=require('./key-test.cjs').TIMEOUT_MS){const K=require('./key-test.cjs');const S=SDK();
    const models=url=>{try{const u=new URL(String(url));return u.origin==='https://api.anthropic.com'&&u.pathname==='/v1/models'&&!u.username&&!u.password&&!u.hash;}catch{return false;}};
    const fetchFn=async(url,init={})=>{if(!models(url))throw new Error('UNEXPECTED_ADDRESS');
      const sent=new Headers();for(const [name,value] of new Headers(init.headers))if(HEADER_ALLOWED(name))sent.set(name,value);sent.set('authorization','Bearer '+this.#key);sent.delete('anthropic-beta');
      const response=await this.transport(url,{...init,headers:sent,redirect:'error'});return new Response('{"data":[],"has_more":false,"first_id":null,"last_id":null}',{status:response.status??(response.ok===false?500:200),headers:{'content-type':'application/json'}});};
    try{await new S({...LOCKED,apiKey:this.#key,maxRetries:0,timeout:timeoutMs,fetch:fetchFn}).models.list({limit:1});return {result:'ok'};}
    catch(error){return {result:Number.isInteger(error?.status)?K.classify(error.status):'unreachable'};}}
  // B3: one Claude request with a structured answer for the agents other than the trading review: the same locked client,
  // headers, recording and stop-reason handling as decide; adaptive thinking (bound with drop_block only where a history
  // with thinking blocks is replayed, the scout); effort explicit; json_schema output; the agent's output cap and timeout.
  async structured({kind,system,input,schema,options,maxBytes,tools=null,final=false}){
    const selected=M.settings(options);if(M.vendorOf(selected.model)!=='anthropic')throw new Error('INVALID_MODEL_SETTINGS');
    let reportedUsage=null,returnedModel=selected.model;const call={responseChars:null,sizes:null};
    const inputBytes=Buffer.byteLength(JSON.stringify(input));if(inputBytes>maxBytes)throw Object.assign(new Error('CONTEXT_TOO_LARGE'),{detail:{rule:`the ${kind} request is ${inputBytes} bytes, over its ${maxBytes}-byte limit`}});
    try{
      const replayed=Boolean(tools)&&hasToolHistory(input);
      const body={model:selected.model,max_tokens:M.outputCap(options,kind),service_tier:'standard_only',...(tools?{betas:[BETA]}:{}),
        system:[{type:'text',text:system,cache_control:{type:'ephemeral'}}],
        ...(tools?{tools:toTools(tools),tool_choice:final?{type:'none'}:{type:'auto'}}:{}),
        thinking:tools?{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}}:{type:'adaptive'},
        output_config:{effort:selected.effort,format:{type:'json_schema',schema:toAnthropicSchema(schema)}},
        ...(replayed?{cache_control:{type:'ephemeral'}}:{}),
        messages:toMessages(input)};
      let reply;try{reply=await this.client(this.timeoutMs[kind],call).beta.messages.create(body);}catch(error){
        if(call.refused)throw Object.assign(new Error('AI_REQUEST_FAILED'),{detail:{rule:call.refused}});
        const detail=errorDetail(error);throw Object.assign(new Error(mapError(error)??'AI_REQUEST_FAILED'),detail?{detail}:{});}
      if(call.responseChars>C.RESPONSE_CHAR_LIMIT)throw fail(`a response of ${C.kb(call.responseChars)}, above the ${C.kb(C.RESPONSE_CHAR_LIMIT)} limit`);
      reportedUsage=M.normalizeUsage(reply,'anthropic');returnedModel=typeof reply.model==='string'?reply.model:selected.model;
      const blocks=Array.isArray(reply.content)?reply.content:[];
      const base={usage:reportedUsage,provider:'openai',vendor:'anthropic',model:returnedModel,responseChars:call.responseChars,droppedThinking:(reply.input_transformations??[]).filter(t=>t?.type==='thinking_dropped').length,stopReason:typeof reply.stop_reason==='string'?reply.stop_reason.slice(0,30):null,requestSizes:call.sizes};
      if(reply.stop_reason==='refusal'){const category=String(reply.stop_details?.category??'').replace(/[^a-z_]/g,'').slice(0,30);throw Object.assign(new Error('AI_REFUSED'),{stopReason:'refusal',detail:{rule:`a refusal${category?` (${category})`:''}`}});}
      if(reply.stop_reason==='max_tokens')throw Object.assign(new Error('AI_OUTPUT_LIMIT'),{stopReason:'max_tokens'});
      const calls=blocks.filter(b=>b?.type==='tool_use');
      if(calls.length){
        const names=calls.map(c=>String(c.name).slice(0,40)),invalid=rule=>fail(rule,{toolCount:calls.length,tools:[...new Set(names)].slice(0,8),status:'tool_use'});
        if(!tools)throw invalid(`a tool request from the ${kind}, which has no tools`);if(final)throw invalid('a tool request on the final round');
        if(calls.length>12)throw invalid(`${calls.length} tool requests at once`);
        if(calls.some(c=>typeof c.id!=='string'||c.id.length>200||!c.input||typeof c.input!=='object'||Array.isArray(c.input)||JSON.stringify(c.input).length>2000))throw invalid('a malformed or oversized tool request');
        const offered=tools.map(t=>t.name);
        return {...base,toolCalls:calls.map(c=>({name:offered.includes(c.name)?c.name:'unknown:'+String(c.name).slice(0,40),callId:c.id,args:c.input})),continuation:[...input,{type:'anthropic_turn',content:blocks},...calls.map(c=>({type:'function_call',call_id:c.id,name:c.name,arguments:JSON.stringify(c.input),vendor:'anthropic'}))]};}
      if(reply.stop_reason!=='end_turn')throw fail(`a response that stopped with ${String(reply.stop_reason??'no reason').replace(/[^a-z_ ]/g,'').slice(0,30)}`,{status:String(reply.stop_reason??'missing').slice(0,30)});
      const output=blocks.filter(b=>b?.type==='text').map(b=>String(b.text??'')).join('');
      let parsed;try{parsed=JSON.parse(output);}catch{throw fail(output.trim()?`a ${kind} answer that is not valid JSON`:`no ${kind} answer`,{status:'end_turn'});}
      return {...base,parsed};
    }catch(error){const safe=new Error(require('./ai-errors.cjs').publicCode(error)??(['TimeoutError','AbortError'].includes(error.name)?'AI_TIMEOUT':'AI_REQUEST_FAILED'));safe.usage=reportedUsage;safe.model=returnedModel;safe.responseChars=call.responseChars;if(error.detail)safe.detail=error.detail;if(typeof error.stopReason==='string')safe.stopReason=error.stopReason;if(call.sizes)safe.requestSizes=call.sizes;throw safe;}
  }
  async narrative(context,options={}){const n=require('./narrative.cjs');const {parsed,...r}=await this.structured({kind:'narrative',system:n.INSTRUCTIONS,input:[{role:'user',content:JSON.stringify(context)}],schema:n.SCHEMA,options,maxBytes:120000});return {...r,narrative:parsed};}
  async compact(payload,options={}){const f=require('./context-fit.cjs');const {parsed,...r}=await this.structured({kind:'compact',system:f.COMPACT_INSTRUCTIONS,input:[{role:'user',content:JSON.stringify(payload)}],schema:f.COMPACT_SCHEMA,options,maxBytes:400000});return {...parsed,...r};}
  async reflect(context,options={}){const {parsed,...r}=await this.structured({kind:'reflect',system:require('./ai-client.cjs').REFLECTION_INSTRUCTIONS,input:[{role:'user',content:JSON.stringify(context)}],schema:require('./reflection.cjs').SCHEMA,options,maxBytes:70000});return {...r,reflection:require('./reflection.cjs').validate(parsed)};}
  async scout(context,options={}){const scout=require('./scout.cjs');const input=options.continuation??[{role:'user',content:JSON.stringify(context)}];
    const r=await this.structured({kind:'scout',system:scout.INSTRUCTIONS,input,schema:scout.SCHEMA,options,maxBytes:options.maxBytes??scout.SCOUT_REQUEST_BYTES,tools:require('./ai-client.cjs').scoutTools(),final:Boolean(options.final)});
    if(r.toolCalls)return r;const {parsed,...rest}=r;
    try{return {...rest,plan:scout.validatePlan(parsed)};}catch{throw Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:'the plan did not match the required format'});}}
  client(timeout,call){
    const S=SDK();
    const fetchFn=async(url,init={})=>{
      // Only the Messages endpoint is ever called; anything else is refused before the transport sees it.
      if(!ENDPOINT(url)){call.refused='a request to an unexpected address';throw new Error('UNEXPECTED_ADDRESS');}
      // Only known headers leave: a header added through the environment (ANTHROPIC_CUSTOM_HEADERS) or a tracing
      // propagator is dropped, and the credential and the beta are set here, whatever the SDK computed.
      const sent=new Headers();for(const [name,value] of new Headers(init.headers))if(HEADER_ALLOWED(name))sent.set(name,value);
      sent.set('authorization','Bearer '+this.#key);sent.set('anthropic-beta',BETA);sent.set('content-type','application/json');init={...init,headers:sent};
      try{const b=JSON.parse(init.body),n=v=>Buffer.byteLength(JSON.stringify(v??null));call.sizes={totalBytes:Buffer.byteLength(init.body),inputBytes:n(b.messages),instructionsBytes:n(b.system),toolsBytes:n(b.tools)};}catch{}
      const response=await this.transport(url,{...init,redirect:'error'});const text=await response.text();call.responseChars=text.length;
      const headers=new Headers(response.headers instanceof Headers?response.headers:{'content-type':'application/json',...(response.headers??{})});
      return new Response(text,{status:response.status??(response.ok===false?500:200),headers});
    };
    return new S({...LOCKED,apiKey:this.#key,maxRetries:0,timeout,fetch:fetchFn});
  }
  async decide(context,options={}) {
    const selected=M.settings(options);if(M.vendorOf(selected.model)!=='anthropic')throw new Error('INVALID_MODEL_SETTINGS');
    let reportedUsage=null,returnedModel=selected.model;const call={responseChars:null,sizes:null};
    const input=options.continuation??[{role:'user',content:JSON.stringify(context)}];const inputBytes=Buffer.byteLength(JSON.stringify(input)),limitBytes=M.reviewByteLimit(options);
    if(inputBytes>limitBytes){const e=new Error(options.continuation?'CONTINUATION_OVER_BUDGET':'CONTEXT_OVER_BUDGET');e.detail={limit:'app bytes',stage:options.continuation?'research continuation (request check)':'first request (request check)',wireBytes:inputBytes,limitBytes,largest:options.continuation?options.continuation.map((it,i)=>[`item ${i} ${it.type??it.role}`,Buffer.byteLength(JSON.stringify(it))]).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,b])=>`${k}:${b}`):require('./review-context.cjs').report(context,limitBytes).largest};throw e;}
    try {
      const messages=toMessages(input);
      // Cache (design 5.5): one breakpoint on the system block caches the tools and the instructions; in research rounds
      // the top-level breakpoint caches the conversation so far, so rounds 2 to 4 read it. The messages are not edited
      // for caching, so a replayed thinking block always meets the conversation it was made in.
      const body={model:selected.model,max_tokens:MAX_TOKENS,service_tier:'standard_only',betas:[BETA],
        system:[{type:'text',text:C.REVIEW_INSTRUCTIONS,cache_control:{type:'ephemeral'}}],
        // Tools: in research rounds, and also in any request whose conversation already holds tool calls (the plan
        // correction is sent with research off): Claude refuses tool_use or tool_result blocks without tool definitions,
        // and the same tools keep the prefix the thinking blocks are bound to. Only research rounds before the last may
        // call them.
        ...(options.research||hasToolHistory(input)?{tools:toTools(C.reviewTools(context)),tool_choice:options.research&&!options.final?{type:'auto'}:{type:'none'}}:{}),
        // Thinking is always adaptive on Claude Opus 5.5; drop_block keeps a review going when condensing rewrote an older
        // tool result (a thinking block after the change is dropped instead of failing the request).
        thinking:{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}},
        output_config:{effort:selected.effort,format:{type:'json_schema',schema:toAnthropicSchema(C.decisionSchema(Boolean(context.scoutBrief),Boolean(context.scoutPlan?.targets?.length)))}},
        ...(options.continuation?{cache_control:{type:'ephemeral'}}:{}),
        messages};
      let reply;try{reply=await this.client(this.timeoutMs.decide,call).beta.messages.create(body);}catch(error){
        if(call.refused)throw Object.assign(new Error('AI_REQUEST_FAILED'),{detail:{rule:call.refused}});
        const detail=errorDetail(error);throw Object.assign(new Error(mapError(error)??'AI_REQUEST_FAILED'),detail?{detail}:{});}
      this.lastRequestSizes=call.sizes;
      if(call.responseChars>C.RESPONSE_CHAR_LIMIT)throw fail(`a response of ${C.kb(call.responseChars)}, above the ${C.kb(C.RESPONSE_CHAR_LIMIT)} limit`);
      reportedUsage=M.normalizeUsage(reply,'anthropic');returnedModel=typeof reply.model==='string'?reply.model:selected.model;
      const blocks=Array.isArray(reply.content)?reply.content:[];
      const droppedThinking=(reply.input_transformations??[]).filter(t=>t?.type==='thinking_dropped').length;
      // B2: the stop reason and the measured request sizes go with each reply, for the dry run's measurement.
      const base={usage:reportedUsage,provider:'openai',vendor:'anthropic',model:returnedModel,responseChars:call.responseChars,droppedThinking,stopReason:typeof reply.stop_reason==='string'?reply.stop_reason.slice(0,30):null,requestSizes:call.sizes};
      if(reply.stop_reason==='refusal'){const category=String(reply.stop_details?.category??'').replace(/[^a-z_]/g,'').slice(0,30);throw Object.assign(new Error('AI_REFUSED'),{stopReason:'refusal',requestSizes:call.sizes,detail:{rule:`a refusal${category?` (${category})`:''}`}});}
      if(reply.stop_reason==='max_tokens')throw Object.assign(new Error('AI_OUTPUT_LIMIT'),{stopReason:'max_tokens',requestSizes:call.sizes,usage:reportedUsage});
      const calls=blocks.filter(b=>b?.type==='tool_use');
      if(calls.length){
        // The same bounded tool protocol as AiClient.decide: research on, not the final round, the ceiling, offered
        // tools only, bounded ids and arguments. Each refusal names its rule, the count and the tool names only.
        const names=calls.map(c=>String(c.name).slice(0,40)),invalid=rule=>fail(rule,{toolCount:calls.length,tools:[...new Set(names)].slice(0,8),status:String(reply.stop_reason??'missing').slice(0,30)});
        if(!options.research)throw invalid('a tool request in a review without research');
        if(options.final)throw invalid('a tool request on the final round');
        if(calls.length>require('./research-review.cjs').HARD_MAX_CALLS)throw invalid(`more tool requests at once than the ceiling of ${require('./research-review.cjs').HARD_MAX_CALLS}`);
        const offered=C.offeredToolNames(context);if(calls.some(c=>!offered.includes(c.name)))throw invalid('a tool that was not offered');
        if(calls.some(c=>typeof c.id!=='string'||c.id.length>200||!c.input||typeof c.input!=='object'||Array.isArray(c.input)||JSON.stringify(c.input).length>(c.name==='save_assessment'?6000:2000)))throw invalid('a malformed or oversized tool request');
        const turn={type:'anthropic_turn',content:blocks};
        return {...base,toolCalls:calls.map(c=>({name:c.name,callId:c.id,args:c.input})),continuation:[...input,turn,...calls.map(c=>({type:'function_call',call_id:c.id,name:c.name,arguments:JSON.stringify(c.input),vendor:'anthropic'}))]};
      }
      if(reply.stop_reason!=='end_turn')throw fail(`a response that stopped with ${String(reply.stop_reason??'no reason').replace(/[^a-z_ ]/g,'').slice(0,30)}`,{status:String(reply.stop_reason??'missing').slice(0,30)});
      const output=blocks.filter(b=>b?.type==='text').map(b=>String(b.text??'')).join('');
      if(output.length>C.DECISION_OUTPUT_CHAR_LIMIT)throw fail(`a decision of ${C.kb(output.length)}, above the ${C.kb(C.DECISION_OUTPUT_CHAR_LIMIT)} limit`,{status:'end_turn'});
      let raw;try{raw=JSON.parse(output);}catch{throw fail(output.trim()?'a decision that is not valid JSON':'no decision and no tool request',{status:'end_turn'});}
      const memory=C.validationMemory(context,options);const decision=C.validateDecision(raw,context.universe.map(row=>row.symbol),{requirePlan:true,memory,quotes:options.validation?.quotes??context.quotes??[],context});
      // A Buy held back for an incomplete plan keeps its conversation, so the review can ask once for the missing field.
      return {...base,decision,...(decision.withheld&&decision.withheld.kind!=='permission'?{continuation:[...input,{type:'anthropic_turn',content:blocks}]}:{})};
    }catch(error){const safe=new Error(require('./ai-errors.cjs').publicCode(error)??(['TimeoutError','AbortError'].includes(error.name)?'AI_TIMEOUT':'AI_REQUEST_FAILED'));safe.usage=reportedUsage;safe.model=returnedModel;safe.responseChars=call.responseChars;if(error.detail)safe.detail=error.detail;
      // B2: a failure keeps its stop reason and the measured request sizes for the dry run's measurement.
      if(typeof error.stopReason==='string')safe.stopReason=error.stopReason;if(call.sizes)safe.requestSizes=call.sizes;throw safe;}
  }
}
module.exports={AnthropicClient,toAnthropicSchema,toTools,toMessages,mapError,errorDetail,ENDPOINT,HEADER_ALLOWED,LOCKED,BETA,TIMEOUT_MS,MAX_TOKENS,UNSUPPORTED};
