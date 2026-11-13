const messages={VALIDATION_STATE_INVALID:'The review could not be checked against its position memory, so its decision was not used.',AI_AUTH_FAILED:'The AI provider rejected the API key. Reconnect the provider key.',AI_MODEL_UNAVAILABLE:'The selected model is unavailable to this API key or project. Check model access.',AI_QUOTA_EXHAUSTED:'The AI provider refused the request: the account\'s credit or spend limit is used up. Add credit or raise the limit in the provider\'s console; retrying alone does not restore access.',AI_RATE_LIMITED:'The AI provider\'s rate limit was reached. Wait before retrying.',AI_BAD_REQUEST:'The AI provider rejected the request format or a model setting.',AI_SERVER_ERROR:'The AI provider is temporarily unavailable. Try again later.',AI_TIMEOUT:'The AI provider did not finish within the request timeout.',AI_REQUEST_FAILED:'Could not reach the AI provider. Check connectivity and retry.',AI_OUTPUT_LIMIT:'The model reached its output allowance before completing a decision. Try a lower reasoning effort.',AI_REFUSED:'The model declined this request; no decision was executed.',INVALID_AI_RESPONSE:'The model returned an invalid decision. No order was submitted.',CONTEXT_TOO_LARGE:'A request is over the app byte limit; it was not sent to the AI provider.',CONTEXT_MANDATORY_TOO_LARGE:'The data every decision must see (holdings, cash, orders, prices, limits, guidelines) is over the app byte limit on its own; nothing was sent to the AI provider and nothing was decided.',CONTEXT_OVER_BUDGET:'The review data is over the app byte limit even after shortening every section that can be shortened; nothing was sent to the AI provider and nothing was decided.',CONTINUATION_OVER_BUDGET:'A research round (the tool results carried forward) is over the app byte limit even after condensing; that round was not sent to the AI provider and nothing was decided.',AI_CONTEXT_LIMIT:'The AI provider rejected the request as longer than the model context window.',AI_NOT_CONNECTED:'No API key is connected for the selected model\'s provider. Add it to the provider file and reconnect.',INVALID_MODEL_SETTINGS:'The model and reasoning settings are incompatible.',AI_BUDGET_EXHAUSTED:'The local daily API allowance is exhausted. Check the budget settings.',ACCOUNT_CHANGED:'The account changed during review. Refresh the portfolio and retry.',KIS_NOT_CONNECTED:'Connect the KIS account before reviewing.',STALE_DECISION:'Settings or account context changed during review. Retry with saved settings.'};
function publicCode(error){return Object.hasOwn(messages,error?.message)?error.message:null;}
// Text from a provider's refusal, made safe to keep: the loaded keys removed by value, control characters replaced,
// anything key-shaped removed, at most 300 characters (Claude refused-request design C1, C2; shared with OpenAI).
const SECRET_SHAPES=[/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]+/g,/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi,/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/g];
function cleanText(text,keys=[]){let s=String(text??'');for(const k of keys)if(typeof k==='string'&&k.length>=10)s=s.split(k).join('[redacted]');
  s=s.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');for(const r of SECRET_SHAPES)s=s.replace(r,'[redacted]');return s.replace(/\s+/g,' ').trim().slice(0,300);}
// OpenAI's billing refusals (error-codes guide, read 2026-11-13): HTTP 429 with one of these codes, or the broader type
// insufficient_quota. Retrying does not restore access; the user must act on the account. Any other 429 is a rate limit.
const QUOTA_CODES=['insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded'];
const header=(response,name)=>{try{const v=response?.headers?.get?.(name);return v==null?null:String(v);}catch{return null;}};
// An OpenAI refusal's local record (OpenAI refusal fix R1), the same shape as Claude's (anthropic-client.cjs refusalRecord):
// status, request id, error type and code, the cleaned message (none for 401, which can echo part of a key), Retry-After
// and the rate-limit headers, each pattern-checked. noCharge: a 4xx whose body was read and carries no usage, so the
// request was refused before the model ran (ai-accounting.cjs settles it at zero).
function openaiRefusal(response,parsed,raw,keys=[]){
  const status=response?.status;if(!Number.isInteger(status)||status<400||status>599)return null;const e=parsed?.error&&typeof parsed.error==='object'?parsed.error:null;
  const requestId=header(response,'x-request-id'),errorType=typeof e?.type==='string'?e.type:null,errorCode=typeof e?.code==='string'?e.code:null;
  const retryAfter=header(response,'retry-after'),contentType=String(header(response,'content-type')??'').toLowerCase().replace(/[^a-z0-9\/+.;= -]/g,'').slice(0,60);
  const num=v=>v!=null&&/^\d{1,12}$/.test(v)?Number(v):null,reset=v=>v!=null&&/^[0-9hms.]{1,12}$/.test(v)?v:null;
  const part=suffix=>{const p={limit:num(header(response,'x-ratelimit-limit-'+suffix)),remaining:num(header(response,'x-ratelimit-remaining-'+suffix)),reset:reset(header(response,'x-ratelimit-reset-'+suffix))};return Object.values(p).some(v=>v!=null)?p:null;};
  const limits=Object.fromEntries([['requests','requests'],['tokens','tokens'],['projectTokens','project-tokens']].map(([k,s])=>[k,part(s)]).filter(([,v])=>v));
  const message=status!==401?cleanText(typeof e?.message==='string'?e.message:raw??'',keys):'';
  return {status,vendor:'openai',...(requestId&&/^[A-Za-z0-9_-]{1,64}$/.test(requestId)&&cleanText(requestId,keys)===requestId?{requestId}:{}),...(errorType&&/^[a-z_]{1,40}$/.test(errorType)?{errorType}:{}),...(errorCode&&/^[a-z0-9_]{1,60}$/.test(errorCode)?{errorCode}:{}),
    anthropicError:false,...(contentType?{contentType}:{}),...(message?{message}:{}),...(retryAfter!=null&&/^\d{1,5}$/.test(retryAfter)?{retryAfterSec:Number(retryAfter)}:{}),...(Object.keys(limits).length?{limits}:{}),
    noCharge:status<500&&parsed!=null&&parsed.usage==null};
}
// An OpenAI error response -> the app's code, decided by the body's code first, then its type, then the status; the
// refusal record goes with it. keys: the loaded keys, removed from the kept message by value.
async function responseError(response,keys=[]){let raw=null,parsed=null;try{raw=await response.text();if(raw.length<100000)parsed=JSON.parse(raw);}catch{}
  const code=parsed?.error?.code,type=parsed?.error?.type,status=response?.status;
  const error=new Error(QUOTA_CODES.includes(code)||type==='insufficient_quota'?'AI_QUOTA_EXHAUSTED':code==='context_length_exceeded'?'AI_CONTEXT_LIMIT':code==='model_not_found'?'AI_MODEL_UNAVAILABLE':status===401?'AI_AUTH_FAILED':status===403||status===404?'AI_MODEL_UNAVAILABLE':status===429?'AI_RATE_LIMITED':status>=500?'AI_SERVER_ERROR':'AI_BAD_REQUEST');
  const record=openaiRefusal(response,parsed,typeof raw==='string'?raw.slice(0,8000):null,keys);if(record)error.providerError=record;return error;}
// A format failure names the rule it broke (1.5.48 audit, A5): the rule, how many tool requests and which tools (names
// only), the research round and the response status. Never arguments, keys or portfolio data.
function ruleDetail(error){const d=error?.detail;if(!d||typeof d!=='object'||typeof d.rule!=='string')return '';
  return ` Rule: ${d.rule.slice(0,120)}${Number.isInteger(d.toolCount)?` (${d.toolCount} tool request${d.toolCount===1?'':'s'}${Array.isArray(d.tools)&&d.tools.length?`: ${d.tools.slice(0,8).map(x=>String(x).slice(0,40)).join(', ')}`:''})`:''}${Number.isInteger(d.round)?`, round ${d.round}`:''}${d.status&&d.status!=='completed'?`, response ${String(d.status).slice(0,30)}`:''}.${d.decision&&typeof d.decision==='object'?` Decision: ${['action','quantity','symbol'].map(k=>String(d.decision[k]??'').slice(0,24)).filter(Boolean).join(' ')}${d.decision.credit&&d.decision.credit!=='none'?`, credit ${String(d.decision.credit).slice(0,24)}`:''}.`:''}`;}
// A stale review names the guard that tripped (automation.cjs staleReason): key names only.
// A provider error names its request id and error type, to look it up in the provider's console (Anthropic A3b).
// An OpenAI refusal (fix R1) names its request id and error code from its local record, beside the detail's keys.
function requestDetail(error){const d=error?.detail&&typeof error.detail==='object'?error.detail:{},p=error?.providerError&&typeof error.providerError==='object'?error.providerError:{};
  const pick=(v,re)=>typeof v==='string'&&re.test(v)?v:null;const id=pick(d.requestId,/^[A-Za-z0-9_-]{1,64}$/)??pick(p.requestId,/^[A-Za-z0-9_-]{1,64}$/),type=pick(p.errorCode,/^[a-z0-9_]{1,60}$/)??pick(d.errorType,/^[a-z_]{1,40}$/)??pick(p.errorType,/^[a-z_]{1,40}$/);
  return id||type?` Request: ${id??'unknown'}${type?` (${type})`:''}.`:'';}
function changedDetail(error){const c=error?.detail?.changed;return typeof c==='string'&&c?` Changed: ${c.replace(/[^A-Za-z0-9_.,: -]/g,'').slice(0,200)}.`:'';}
function detail(code,stage,error){const location=String(error?.stack??'').match(/([A-Za-z0-9_-]+\.cjs):(\d+):(\d+)/);return `${messages[code]??'Review could not complete.'} Stage: ${stage}.${code==='REVIEW_FAILED'&&location?' Reference: '+location[1]+':'+location[2]+'.':''}${ruleDetail(error)}${changedDetail(error)}${requestDetail(error)}`;}
// Size failures: the first three are the app's own limit (nothing reached the AI provider), the last is the model's.
const SIZE_CODES=['CONTEXT_MANDATORY_TOO_LARGE','CONTEXT_OVER_BUDGET','CONTINUATION_OVER_BUDGET','CONTEXT_TOO_LARGE','AI_CONTEXT_LIMIT'];
// What was measured for a size failure: the stage, size against the app's or the model's limit, the part every
// decision must see, and the largest sections. Empty for other failures.
function sizeDetail(error){const d=error?.detail;if(!d||typeof d!=='object'||!Number.isFinite(d.wireBytes))return '';
  const model=d.limit==='model context window';return ` Size${d.stage?` at ${d.stage}`:''}: ${d.wireBytes} bytes against the ${model?'model context window':`app limit of ${d.limitBytes} bytes`}${Number.isFinite(d.mandatoryBytes)?`; the part every decision must see is ${d.mandatoryBytes} bytes`:''}${Array.isArray(d.largest)&&d.largest.length?`; largest ${d.largest.slice(0,5).join(', ')}`:''}.`;}
// Failures of the response's format or protocol: repeated ones pause automatic reviews (automation.cjs reviewBackoff).
const FORMAT_CODES=['INVALID_AI_RESPONSE','AI_OUTPUT_LIMIT','AI_REFUSED'];
module.exports={messages,publicCode,responseError,openaiRefusal,cleanText,SECRET_SHAPES,QUOTA_CODES,detail,sizeDetail,ruleDetail,SIZE_CODES,FORMAT_CODES};
