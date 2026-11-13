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

// A refused request's local record (artifacts/reviews/2026-11-12-claude-dry-run, design and review): what the provider
// answered, kept on this computer only (the call record, the dry-run record and the Dry-run panel). It never enters the
// error code, `detail`, the log, the phone, the review context or a later request (review C1).
// - status, errorType, requestId: always, for any answer with an HTTP status.
// - message: for every 4xx except 401 and 429 (the provider's error.message, or for a body that is not an Anthropic error
//   object, its text), with the loaded key removed by value and anything shaped like a credential removed, then cut to
//   300 characters (review C2). The shapes are narrow so the diagnosis survives (diff review F1): `sk-` only at the
//   start of a token, and a long run only when it looks like a key (32 or more letters and digits with no - or _
//   separator, mixing both), so a beta name, a model id, a tool or field name stays readable.
// - anthropicError: whether the body was an Anthropic error object ({type:'error', error:{type, message}}); contentType.
// - noCharge: a 4xx with a received body and no usage, which the provider refuses before the model runs (review ruling 2).
const SECRET_SHAPES=[/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]+/g,/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi,/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/g];
function cleanText(text,keys=[]){let s=String(text??'');for(const k of keys)if(typeof k==='string'&&k.length>=10)s=s.split(k).join('[redacted]');
  s=s.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');for(const r of SECRET_SHAPES)s=s.replace(r,'[redacted]');return s.replace(/\s+/g,' ').trim().slice(0,300);}
function refusalRecord(error,call,keys=[]){
  const S=SDK();if(!(error instanceof S.APIError)||!Number.isInteger(error.status))return null;const status=error.status;if(status<400||status>599)return null;
  const lookupKeys=errorDetail(error)??{};let parsed=null;try{parsed=JSON.parse(call?.errorBody??'');}catch{}
  const anthropicError=Boolean(parsed&&parsed.type==='error'&&parsed.error&&typeof parsed.error.type==='string');
  const contentType=String(call?.contentType??'').toLowerCase().replace(/[^a-z0-9\/+.;= -]/g,'').slice(0,60);
  const refused=status>=400&&status<500,withMessage=refused&&status!==401&&status!==429;
  const message=withMessage?cleanText(anthropicError?parsed.error.message:(call?.errorBody??error.message),keys):'';
  return {status,...lookupKeys,anthropicError,...(contentType?{contentType}:{}),...(message?{message}:{}),noCharge:refused&&call?.errorBody!=null};
}

// Claude decision and scout without a grammar (artifacts/reviews/2026-11-12-claude-dry-run/design-grammar.md, option A;
// review G1 to G6). Anthropic refused the decision's structured-output grammar as too large (1.5.55 dry run), so these
// two requests carry no output_config.format. The shape is stated in a Claude-only system block: the app's own schema,
// with its real limits, and one sentence, format only (G4). It is the same text for every round of a review and sits
// inside the cached system prefix. The answer is parsed strictly (G1): the whole text is one JSON object, or exactly one
// ```json fence around one object with only whitespace outside; no searching, no repair. The app's validators then
// check every field as before (checkDecision rejects unknown top-level keys and any coercion; validatePlan fails closed).
const SHAPE_SENTENCE='Answer with only one JSON object that matches this JSON Schema, with no text before or after it.';
// C1 review R8: Claude wrote its explanation with Markdown, which the Journal, the console and the phone show as plain text.
const PLAIN_TEXT='Text fields are plain text, without Markdown.';
const shapeText=schema=>`${SHAPE_SENTENCE} ${PLAIN_TEXT}\n${JSON.stringify(schema)}`;
// G4: the decision shape the model reads carries the bounds the app refuses on (checkDecision, the execution checks) or
// caps at (the list limits), which the grammar could not hold. A copy: the schema the OpenAI request sends is unchanged.
function decisionShape(schema){const s=JSON.parse(JSON.stringify(schema));const p=s.properties??{};const obj=n=>n?.anyOf?.find(b=>b?.type==='object')??(n?.type==='object'?n:null);
  if(p.explanation)p.explanation.maxLength=1500;if(p.quantity)Object.assign(p.quantity,{minimum:0,maximum:1000});if(p.loanDate)p.loanDate.maxLength=10;
  const hd=obj(p.plan)?.properties?.horizonDays;if(hd)Object.assign(hd,{minimum:1,maximum:3650});
  const ex=obj(p.execution)?.properties;if(ex?.cancelAfter)ex.cancelAfter.maxLength=40;if(ex?.cancelIf){ex.cancelIf.maxItems=5;if(ex.cancelIf.items?.properties?.expr)ex.cancelIf.items.properties.expr.maxLength=200;}
  const score=obj(p.complexity)?.properties?.score;if(score)Object.assign(score,{minimum:0,maximum:100});
  if(p.strategyCheck)p.strategyCheck.maxItems=8;if(p.planVerdicts)p.planVerdicts.maxItems=12;return s;}
function onlyObject(text,{empty,invalid}){const t=String(text??'').trim();if(!t)throw fail(empty,{status:'end_turn'});
  const fence=/^```json[ \t]*\r?\n([\s\S]*)\r?\n```$/.exec(t);if(!fence&&t.startsWith('```'))throw fail(invalid,{status:'end_turn'});
  let value;try{value=JSON.parse(fence?fence[1]:t);}catch{throw fail(invalid,{status:'end_turn'});}
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail(invalid,{status:'end_turn'});return value;}

// The enforced decision form (artifacts/reviews/2026-11-13-enforced-form: design.md, review.md E1 to E10, verified on the
// real API in verify/report.md). Anthropic compiles a structured-output grammar only up to a size measured as properties +
// unions + arrays (at most 62 with callable tools, 69 without; undocumented). The app's nested decision schema counts 115,
// so Claude gets a flat form built from it: nested parts become top-level fields named by their path (plan_stopPrice),
// nullable values become plain ones with a "none" marker, and three list parts that never reach an order are JSON text in
// a string. Largest shape 53, under the guard of 54 (tests/claude-enforced.test.cjs). The rebuild turns the flat answer
// back into the nested decision before the unchanged validateDecision; a marker is never read as a value.
const TEXT_PARTS=Object.freeze(['strategyCheck','scoutBrief','planVerdicts']);
const objectOf=n=>n?.anyOf?.find(b=>b?.type==='object')??(n?.type==='object'?n:null);
const plainType=n=>{if(Array.isArray(n.type)){const {type,...rest}=n;return {...rest,type:type.find(t=>t!=='null')};}if(n.anyOf){const b=n.anyOf.find(x=>x.type!=='null');const {anyOf,...rest}=n;return {...rest,...b};}return n;};
function flatten(schema){const props={};
  for(const [k,v] of Object.entries(schema.properties)){
    if(TEXT_PARTS.includes(k)){props[k]={type:'string'};continue;}
    const o=objectOf(v);if(!o){props[k]=plainType(v);continue;}
    const walk=(node,prefix)=>{for(const [ck,cv] of Object.entries(node.properties)){const key=`${prefix}_${ck}`;const co=objectOf(cv);
      if(co&&cv.type!=='array'){walk(co,key);continue;}
      let leaf=cv.type==='array'?cv:plainType(cv);if(key==='reversal_basis')leaf={...leaf,enum:[...leaf.enum,'none']};props[key]=leaf;}};
    walk(o,k);}
  return toAnthropicSchema({type:'object',properties:props,required:Object.keys(props),additionalProperties:false});}
const FLAT=new Map();
function flatDecisionSchema(brief,targets){const key=`${Boolean(brief)}/${Boolean(targets)}`;if(!FLAT.has(key))FLAT.set(key,flatten(C.decisionSchema(Boolean(brief),Boolean(targets))));return FLAT.get(key);}
// The count Anthropic's grammar limit follows (the probe's rule): properties + unions + arrays.
function grammarCount(x){let n=0;const w=o=>{if(!o||typeof o!=='object')return;if(o.anyOf||Array.isArray(o.type))n++;if(o.type==='array'){n++;w(o.items);}if(o.properties)for(const v of Object.values(o.properties)){n++;w(v);}for(const b of o.anyOf??[])w(b);};w(x);return n;}
// The format text for the enforced form (format only; review E9 adds the sentence on the instructions' null).
const FORMAT_TEXT=(()=>{const shapes=decisionShape(C.decisionSchema(true,true)).properties;return [
  'Answer in the JSON form the request enforces. Text fields are plain text, without Markdown.',
  'A field name with an underscore is a part of one item: plan_stopPrice is the stop price of the plan, execution_cancelIf is the cancel conditions of the execution.',
  'Where there is no value, write 0 for a number, an empty string for text, an empty list for a list, and none where the choices include it. A stop price, target price, number of holding days or execution bound of 0 means none.',
  'No portfolio comparison: plan_portfolioImpact_why is empty. No valuation: plan_valuation_method is empty. No execution instruction: execution_bound 0, execution_cancelAfter empty and execution_cancelIf empty. No reversal: reversal_basis none.',
  'Where the instructions say null, write the marker named here.',
  ...TEXT_PARTS.map(k=>`${k} is JSON written as text in that string, matching this JSON Schema, or an empty string when there is nothing: ${JSON.stringify(shapes[k])}`)].join('\n');})();
// Exactly 0 is "none"; a negative number is passed on, so the validators refuse or drop it as they do today.
const zeroNone=v=>v===0?null:v;
// A JSON-text part: the whole string is one JSON value of the expected kind; "" is none. No searching, no repair.
function textPart(text,kind){const t=String(text??'').trim();if(!t)return {none:true};let v;try{v=JSON.parse(t);}catch{return {bad:true};}
  if(kind==='array'?!Array.isArray(v):!v||typeof v!=='object'||Array.isArray(v))return {bad:true};return {value:v};}
// The flat answer -> the app's nested decision. Unknown or missing keys: refused with checkDecision's wording. A text part
// that does not parse is handled as its nested form is today when malformed (the lists keep no entries, the brief is
// dropped) and named in `dropped` (review E1). Returns {decision, dropped}.
function rebuildDecision(flat,schema){
  if(!flat||typeof flat!=='object'||Array.isArray(flat))throw fail('a decision that is not an object');
  const want=Object.keys(schema.properties),have=Object.keys(flat);const missing=want.filter(k=>!have.includes(k)),extra=have.filter(k=>!want.includes(k));
  if(missing.length||extra.length)throw fail(`decision fields${missing.length?` missing ${missing.slice(0,6).join(', ')}`:''}${extra.length?` unexpected ${extra.slice(0,6).map(k=>String(k).slice(0,30)).join(', ')}`:''}`);
  const f=flat,str=v=>typeof v==='string'?v.trim():'',dropped=[];
  const d={action:f.action,symbol:f.symbol,quantity:f.quantity,credit:f.credit,loanDate:f.loanDate,explanation:f.explanation};
  d.plan={horizon:f.plan_horizon,thesis:f.plan_thesis,invalidation:f.plan_invalidation,stopPrice:zeroNone(f.plan_stopPrice),targetPrice:zeroNone(f.plan_targetPrice),horizonDays:zeroNone(f.plan_horizonDays),confidence:f.plan_confidence,
    portfolioImpact:str(f.plan_portfolioImpact_why)?{weightBeforePct:f.plan_portfolioImpact_weightBeforePct,weightAfterPct:f.plan_portfolioImpact_weightAfterPct,related:f.plan_portfolioImpact_related,relatedBeforePct:f.plan_portfolioImpact_relatedBeforePct,relatedAfterPct:f.plan_portfolioImpact_relatedAfterPct,equityReliable:f.plan_portfolioImpact_equityReliable,why:f.plan_portfolioImpact_why}:null,
    evidence:f.plan_evidence,
    valuation:str(f.plan_valuation_method)?{method:f.plan_valuation_method,inputs:f.plan_valuation_inputs,justification:f.plan_valuation_justification}:null,
    uncertainty:str(f.plan_uncertainty_acceptableAtThisSize)||str(f.plan_uncertainty_beforeAddingMore)?{acceptableAtThisSize:f.plan_uncertainty_acceptableAtThisSize,beforeAddingMore:f.plan_uncertainty_beforeAddingMore}:null};
  d.complexity={score:f.complexity_score,reason:f.complexity_reason};
  const part=(k,kind)=>{const r=textPart(f[k],kind);if(r.bad)dropped.push(k);return r;};
  d.strategyCheck=part('strategyCheck','array').value??[];
  const noExecution=f.execution_bound===0&&!str(f.execution_cancelAfter)&&Array.isArray(f.execution_cancelIf)&&!f.execution_cancelIf.length;
  d.execution=noExecution?null:{bound:zeroNone(f.execution_bound),cancelAfter:f.execution_cancelAfter,cancelIf:f.execution_cancelIf};
  d.reversal=f.reversal_basis==='none'?null:{priorDecisionId:f.reversal_priorDecisionId,basis:f.reversal_basis,whatChanged:f.reversal_whatChanged,priorRequirement:f.reversal_priorRequirement,newEvidence:f.reversal_newEvidence,afterCost:f.reversal_afterCost};
  if('scoutBrief' in schema.properties){const r=part('scoutBrief','object');if(r.value)d.scoutBrief=r.value;}
  if('planVerdicts' in schema.properties)d.planVerdicts=part('planVerdicts','array').value??[];
  return {decision:d,dropped};
}
// The grammar refusal that sends a request once more in the 1.5.56 text form (review E3).
const GRAMMAR_REFUSAL=/compiled grammar is too large|too complex for compilation/i;
const grammarRefused=e=>e?.message==='AI_BAD_REQUEST'&&GRAMMAR_REFUSAL.test(String(e?.providerError?.message??''));
const seoulDay=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date(t));

const hasToolHistory=items=>items.some(i=>i?.type==='function_call_output'||i?.type==='anthropic_turn'&&Array.isArray(i.content)&&i.content.some(b=>b?.type==='tool_use'));
class AnthropicClient {
  #key;
  // timeoutMs: per-call timeouts, overridable for tests only.
  // textDay: the KST day on which a kind (decide, scout) fell back to the text form; later requests that day go straight
  // to it (review E3). clock: tests only.
  #textDay={};
  constructor(key,transport=fetch,{timeoutMs=TIMEOUT_MS,clock=Date.now}={}){if(typeof key!=='string'||!/^[A-Za-z0-9_\-]{10,512}$/.test(key))throw new Error('INVALID_PROVIDER_FILE');this.#key=key;this.transport=transport;this.timeoutMs={...TIMEOUT_MS,...timeoutMs};this.clock=clock;}
  // The enforced form first; on a grammar refusal the same request once more in the text form, inside the same call
  // (one call record; the refusal costs nothing), remembered for the rest of the KST day. Any other error as before.
  async withFallback(kind,run){const day=seoulDay(this.clock());if(this.#textDay[kind]===day)return run('text');
    try{return await run('enforced');}catch(error){if(!grammarRefused(error))throw error;this.#textDay[kind]=day;
      try{return {...await run('text'),formFallback:true};}catch(retry){if(retry&&typeof retry==='object')retry.formFallback=true;throw retry;}}}
  textFormToday(kind){return this.#textDay[kind]===seoulDay(this.clock());}
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
  async structured({kind,system,input,schema,options,maxBytes,tools=null,final=false,textFormat=false}){
    const selected=M.settings(options);if(M.vendorOf(selected.model)!=='anthropic')throw new Error('INVALID_MODEL_SETTINGS');
    let reportedUsage=null,returnedModel=selected.model;const call={responseChars:null,sizes:null};
    const inputBytes=Buffer.byteLength(JSON.stringify(input));if(inputBytes>maxBytes)throw Object.assign(new Error('CONTEXT_TOO_LARGE'),{detail:{rule:`the ${kind} request is ${inputBytes} bytes, over its ${maxBytes}-byte limit`}});
    try{
      const replayed=Boolean(tools)&&hasToolHistory(input);
      const body={model:selected.model,max_tokens:M.outputCap(options,kind),service_tier:'standard_only',...(tools?{betas:[BETA]}:{}),
        system:textFormat?[{type:'text',text:system},{type:'text',text:shapeText(schema),cache_control:{type:'ephemeral'}}]:[{type:'text',text:system,cache_control:{type:'ephemeral'}}],
        ...(tools?{tools:toTools(tools),tool_choice:final?{type:'none'}:{type:'auto'}}:{}),
        thinking:tools?{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}}:{type:'adaptive'},
        output_config:textFormat?{effort:selected.effort}:{effort:selected.effort,format:{type:'json_schema',schema:toAnthropicSchema(schema)}},
        ...(replayed?{cache_control:{type:'ephemeral'}}:{}),
        messages:toMessages(input)};
      let reply;try{reply=await this.client(this.timeoutMs[kind],call).beta.messages.create(body);}catch(error){
        if(call.refused)throw Object.assign(new Error('AI_REQUEST_FAILED'),{detail:{rule:call.refused}});
        const detail=errorDetail(error),providerError=refusalRecord(error,call,[this.#key]);throw Object.assign(new Error(mapError(error)??'AI_REQUEST_FAILED'),detail?{detail}:{},providerError?{providerError}:{});}
      if(call.responseChars>C.RESPONSE_CHAR_LIMIT)throw fail(`a response of ${C.kb(call.responseChars)}, above the ${C.kb(C.RESPONSE_CHAR_LIMIT)} limit`);
      reportedUsage=M.normalizeUsage(reply,'anthropic');returnedModel=typeof reply.model==='string'?reply.model:selected.model;if(typeof reply.stop_reason==='string')call.stopReason=reply.stop_reason.replace(/[^a-z_]/g,'').slice(0,30);
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
      let parsed;if(textFormat)parsed=onlyObject(output,{empty:`no ${kind} answer`,invalid:`a ${kind} answer that is not one JSON object`});
      else{try{parsed=JSON.parse(output);}catch{throw fail(output.trim()?`a ${kind} answer that is not valid JSON`:`no ${kind} answer`,{status:'end_turn'});}}
      return {...base,parsed,answerForm:textFormat?'text':'enforced'};
    }catch(error){const safe=new Error(require('./ai-errors.cjs').publicCode(error)??(['TimeoutError','AbortError'].includes(error.name)?'AI_TIMEOUT':'AI_REQUEST_FAILED'));safe.usage=reportedUsage;safe.model=returnedModel;safe.responseChars=call.responseChars;if(error.detail)safe.detail=error.detail;if(typeof error.stopReason==='string')safe.stopReason=error.stopReason;else if(call.stopReason)safe.stopReason=call.stopReason;if(call.sizes)safe.requestSizes=call.sizes;if(error.providerError)safe.providerError=error.providerError;safe.answerForm=textFormat?'text':'enforced';throw safe;}
  }
  async narrative(context,options={}){const n=require('./narrative.cjs');const {parsed,...r}=await this.structured({kind:'narrative',system:n.INSTRUCTIONS,input:[{role:'user',content:JSON.stringify(context)}],schema:n.SCHEMA,options,maxBytes:120000});return {...r,narrative:parsed};}
  async compact(payload,options={}){const f=require('./context-fit.cjs');const {parsed,...r}=await this.structured({kind:'compact',system:f.COMPACT_INSTRUCTIONS,input:[{role:'user',content:JSON.stringify(payload)}],schema:f.COMPACT_SCHEMA,options,maxBytes:400000});return {...parsed,...r};}
  async reflect(context,options={}){const {parsed,...r}=await this.structured({kind:'reflect',system:require('./ai-client.cjs').REFLECTION_INSTRUCTIONS,input:[{role:'user',content:JSON.stringify(context)}],schema:require('./reflection.cjs').SCHEMA,options,maxBytes:70000});return {...r,reflection:require('./reflection.cjs').validate(parsed)};}
  async scout(context,options={}){const scout=require('./scout.cjs'),RI=require('./review-instructions.cjs');const input=options.continuation??[{role:'user',content:JSON.stringify(context)}];
    // The scout's own schema counts 28 with its 6 tools: enforced as it is, with the same fallback (enforced-form design 6).
    const r=await this.withFallback('scout',form=>this.structured({kind:'scout',system:RI.scoutText(RI.scoutPartsFor(context)),input,schema:scout.SCHEMA,options,maxBytes:options.maxBytes??scout.SCOUT_REQUEST_BYTES,tools:require('./ai-client.cjs').scoutTools(),final:Boolean(options.final),textFormat:form==='text'}));
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
      // A refused answer's body (bounded) and content type, for the refused request's local record (refusalRecord).
      if((response.status??200)>=400){call.errorBody=text.slice(0,8000);call.contentType=headers.get('content-type')??'';}
      return new Response(text,{status:response.status??(response.ok===false?500:200),headers});
    };
    return new S({...LOCKED,apiKey:this.#key,maxRetries:0,timeout,fetch:fetchFn});
  }
  async decide(context,options={}){return this.withFallback('decide',form=>this.decideAs(context,options,form));}
  async decideAs(context,options={},form='enforced') {
    const RI=require('./review-instructions.cjs');
    const selected=M.settings(options);if(M.vendorOf(selected.model)!=='anthropic')throw new Error('INVALID_MODEL_SETTINGS');
    let reportedUsage=null,returnedModel=selected.model;const call={responseChars:null,sizes:null};
    const input=options.continuation??[{role:'user',content:JSON.stringify(context)}];const inputBytes=Buffer.byteLength(JSON.stringify(input)),limitBytes=M.reviewByteLimit(options);
    if(inputBytes>limitBytes){const e=new Error(options.continuation?'CONTINUATION_OVER_BUDGET':'CONTEXT_OVER_BUDGET');e.detail={limit:'app bytes',stage:options.continuation?'research continuation (request check)':'first request (request check)',wireBytes:inputBytes,limitBytes,largest:options.continuation?options.continuation.map((it,i)=>[`item ${i} ${it.type??it.role}`,Buffer.byteLength(JSON.stringify(it))]).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,b])=>`${k}:${b}`):require('./review-context.cjs').report(context,limitBytes).largest};throw e;}
    try {
      const messages=toMessages(input);
      // Cache (design 5.5): one breakpoint on the system block caches the tools and the instructions; in research rounds
      // the top-level breakpoint caches the conversation so far, so rounds 2 to 4 read it. The messages are not edited
      // for caching, so a replayed thinking block always meets the conversation it was made in.
      // Option A (grammar design): the decision's shape as a Claude-only system block after the instructions; the cache
      // breakpoint on it caches the tools, the instructions and the shape together.
      // The enforced form: the flat schema as output_config.format and the format text as the second system block. The text
      // form (1.5.56, the fallback): no format, the shape block. Either way one form for every round of a review.
      const brief=Boolean(context.scoutBrief),targets=Boolean(context.scoutPlan?.targets?.length);const enforced=form!=='text';const flatSchema=enforced?flatDecisionSchema(brief,targets):null;
      const body={model:selected.model,max_tokens:MAX_TOKENS,service_tier:'standard_only',betas:[BETA],
        system:[{type:'text',text:RI.reviewText(RI.partsFor(context))},{type:'text',text:enforced?FORMAT_TEXT:shapeText(decisionShape(C.decisionSchema(brief,targets))),cache_control:{type:'ephemeral'}}],
        // Tools: in research rounds, and also in any request whose conversation already holds tool calls (the plan
        // correction is sent with research off): Claude refuses tool_use or tool_result blocks without tool definitions,
        // and the same tools keep the prefix the thinking blocks are bound to. Only research rounds before the last may
        // call them.
        ...(options.research||hasToolHistory(input)?{tools:toTools(C.reviewTools(context)),tool_choice:options.research&&!options.final?{type:'auto'}:{type:'none'}}:{}),
        // Thinking is always adaptive on Claude Opus 5.5; drop_block keeps a review going when condensing rewrote an older
        // tool result (a thinking block after the change is dropped instead of failing the request).
        thinking:{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}},
        output_config:enforced?{effort:selected.effort,format:{type:'json_schema',schema:flatSchema}}:{effort:selected.effort},
        ...(options.continuation?{cache_control:{type:'ephemeral'}}:{}),
        messages};
      let reply;try{reply=await this.client(this.timeoutMs.decide,call).beta.messages.create(body);}catch(error){
        if(call.refused)throw Object.assign(new Error('AI_REQUEST_FAILED'),{detail:{rule:call.refused}});
        const detail=errorDetail(error),providerError=refusalRecord(error,call,[this.#key]);throw Object.assign(new Error(mapError(error)??'AI_REQUEST_FAILED'),detail?{detail}:{},providerError?{providerError}:{});}
      this.lastRequestSizes=call.sizes;
      if(call.responseChars>C.RESPONSE_CHAR_LIMIT)throw fail(`a response of ${C.kb(call.responseChars)}, above the ${C.kb(C.RESPONSE_CHAR_LIMIT)} limit`);
      reportedUsage=M.normalizeUsage(reply,'anthropic');returnedModel=typeof reply.model==='string'?reply.model:selected.model;if(typeof reply.stop_reason==='string')call.stopReason=reply.stop_reason.replace(/[^a-z_]/g,'').slice(0,30);
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
      // G1: the whole answer is one JSON object (or one json fence around it); G5: a round that ends in prose is a failed
      // review with this rule, never a retry (decisionWithRetry retries request failures only).
      const answer=onlyObject(output,{empty:'no decision and no tool request',invalid:'a decision that is not valid JSON'});
      let raw=answer,dropped=[];if(enforced){({decision:raw,dropped}=rebuildDecision(answer,flatSchema));}
      const memory=C.validationMemory(context,options);const decision=C.validateDecision(raw,context.universe.map(row=>row.symbol),{requirePlan:true,memory,quotes:options.validation?.quotes??context.quotes??[],context});
      // A Buy held back for an incomplete plan keeps its conversation, so the review can ask once for the missing field.
      return {...base,decision,answerForm:enforced?'enforced':'text',...(dropped.length?{textPartsDropped:dropped}:{}),...(decision.withheld&&decision.withheld.kind!=='permission'?{continuation:[...input,{type:'anthropic_turn',content:blocks}]}:{})};
    }catch(error){const safe=new Error(require('./ai-errors.cjs').publicCode(error)??(['TimeoutError','AbortError'].includes(error.name)?'AI_TIMEOUT':'AI_REQUEST_FAILED'));safe.usage=reportedUsage;safe.model=returnedModel;safe.responseChars=call.responseChars;if(error.detail)safe.detail=error.detail;
      // B2: a failure keeps its stop reason and the measured request sizes for the dry run's measurement.
      if(typeof error.stopReason==='string')safe.stopReason=error.stopReason;else if(call.stopReason)safe.stopReason=call.stopReason;if(call.sizes)safe.requestSizes=call.sizes;if(error.providerError)safe.providerError=error.providerError;safe.answerForm=form==='text'?'text':'enforced';throw safe;}
  }
  // The loaded key removed from a text by value (review C2): the provider worker runs a refused request's message through
  // every client it holds before the message leaves the worker. The key itself never leaves this object.
  redact(text){return String(text??'').split(this.#key).join('[redacted]');}
}
module.exports={AnthropicClient,TEXT_PARTS,flatDecisionSchema,grammarCount,FORMAT_TEXT,rebuildDecision,textPart,grammarRefused,onlyObject,shapeText,decisionShape,SHAPE_SENTENCE,PLAIN_TEXT,toAnthropicSchema,toTools,toMessages,mapError,errorDetail,refusalRecord,cleanText,ENDPOINT,HEADER_ALLOWED,LOCKED,BETA,TIMEOUT_MS,MAX_TOKENS,UNSUPPORTED};
