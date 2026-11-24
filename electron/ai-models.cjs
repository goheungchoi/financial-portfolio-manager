// Standard text-token rates (USD per million tokens) checked against official model pages: GPT 2026-10-16 KST; Claude
// Opus 5.5 2026-11-10 (platform.claude.com pricing and model overview). vendor: the API that serves the model; the model
// id alone selects it (Anthropic provider design T1). GPT rows derive their cache rates (read = input × 0.1, write =
// input × 1.25) and pay a surcharge above 272,000 input tokens; Claude rows carry their own cache rates (read, 5-minute
// write) and have no surcharge.
// Claude Haiku 5.5 (Haiku compacting H-1; platform.claude.com pricing and the Haiku 5.5 model page, read 2026-11-15): the
// first Claude row priced by prompt length. A request whose prompt is over 100,000 tokens, counting cache reads and
// writes, pays the long rates on every category, output included. Only context compacting may use it.
const MODELS={'gpt-6-luna':{vendor:'openai',input:0.1,output:0.5},'gpt-6-sol':{vendor:'openai',input:2,output:10},'gpt-6-astra':{vendor:'openai',input:10,output:50},'claude-opus-5-5':{vendor:'anthropic',input:4,output:20,cached:0.2,write:5},
  'claude-haiku-5-5':{vendor:'anthropic',input:0.1,output:0.5,cached:0.01,write:0.125,longAbove:100000,long:{input:0.5,output:2.5,cached:0.05,write:0.625}}};
// The one Claude model a trading review may use (Haiku compacting H-1, review C): with the gate open any other Claude id
// is refused for trading before the D-1 save conditions.
const CLAUDE_TRADING_MODEL='claude-opus-5-5';
// The rates for a request of this many prompt tokens (all input, cache reads and writes included).
const ratesFor=(rate,promptTokens)=>rate.long&&promptTokens>rate.longAbove?{...rate,...rate.long}:rate;
const EFFORTS={openai:['none','low','medium','high'],anthropic:['low','medium','high']};
// The table row for a model id: the exact id, or for GPT a dated snapshot of it (gpt-6-sol-2026-10-01). Claude ids
// match exactly, so a dated or unknown claude-* id is never priced or routed as Opus.
function rowKey(model){if(typeof model!=='string')return null;return Object.keys(MODELS).find(k=>model===k||MODELS[k].vendor==='openai'&&model.startsWith(k+'-20'))??null;}
function vendorOf(model){const key=rowKey(model);if(!key)throw new Error('INVALID_MODEL_SETTINGS');return MODELS[key].vendor;}
// Claude models may not be saved as a trading model (main or routine) until trading on Claude is approved (Anthropic
// provider design 6.3, stage D). The one place to lift it is this constant, in a release, never by a setting.
// Claude trading D-3, the last commit: the gate opens; the save conditions and the review-time check of D-1 apply.
const CLAUDE_TRADING_ENABLED=true;
// Tests only (Claude trading D-1): the conditions behind the gate are tested before the constant flips. The app never
// calls setClaudeTradingForTests; claudeTradingEnabled() is the constant unless a test set it.
let testOverride=null;const claudeTradingEnabled=()=>testOverride??CLAUDE_TRADING_ENABLED;const setClaudeTradingForTests=v=>{testOverride=v==null?null:Boolean(v);};
function assertTradingModel(model){if(vendorOf(model)!=='anthropic')return;if(!claudeTradingEnabled())throw new Error('CLAUDE_NOT_ENABLED_FOR_TRADING');if(model!==CLAUDE_TRADING_MODEL)throw new Error('CLAUDE_MODEL_NOT_FOR_TRADING');}
// Claude: efforts low, medium or high (no "none": thinking is adaptive) and 16,000 output tokens, thinking included.
function settings(config={}){const model=config.openaiModel??'gpt-6-luna',effort=config.reasoningEffort??'none';if(!Object.hasOwn(MODELS,model))throw new Error('INVALID_MODEL_SETTINGS');const vendor=MODELS[model].vendor;if(!EFFORTS[vendor].includes(effort)||model==='gpt-6-astra'&&effort==='none')throw new Error('INVALID_MODEL_SETTINGS');return {model,effort,maxOutput:vendor==='anthropic'?32000:effort==='none'?4096:8192};}
// Request size limits for a portfolio review: the first request, and follow-up rounds that carry research results.
// The budget reservation and the AI client both use this, so they always agree. model (a name or {openaiModel}): the
// trading model. Item 12 step 1 (artifacts/reviews/2026-11-17-review-cost/step1-note.md): on Claude the first request may
// be 80,000 bytes, so the performance section is never shortened (CONTEXT_KEEP) while the rest is trimmed as at 70,000 or
// less (measured on 27 reviews: at most about 69.2 KB with performance whole). OpenAI models: 70,000, as before. The
// follow-up limit is 140,000 for every model.
const modelName=model=>typeof model==='string'?model:model?.openaiModel;
const onClaude=model=>{try{return vendorOf(modelName(model))==='anthropic';}catch{return false;}};
const reviewByteLimit=(options,model)=>options?.continuation?140000:onClaude(model)?80000:70000;
// The review-context sections never shortened in a first request, by model: on Claude, performance (the AI read it back
// in 19 of 27 reviews when it was shortened).
const CLAUDE_CONTEXT_KEEP=Object.freeze(['performance']);
const contextKeep=model=>onClaude(model)?CLAUDE_CONTEXT_KEEP:[];
function reservation(config,context={},options={}){const input=options.continuation??[{role:'user',content:JSON.stringify(context)}];const bytes=Buffer.byteLength(JSON.stringify(input));if(bytes>(options.maxBytes??70000))throw new Error('CONTEXT_TOO_LARGE');return reservationAt(config,bytes,options.kind);}
// B3: Claude's output cap per agent (thinking counts toward it): the decision and the scout 32,000; condensing 16,000 (it
// hit 4,096 on GPT-6 Luna with no reasoning); the narrative and reflection 8,000. OpenAI keeps its own (settings()).
const CLAUDE_OUTPUT=Object.freeze({decide:32000,scout:32000,compact:16000,narrative:8000,reflect:8000});
// M-4 (multi-order, m4-plan.md; the user's D1 "As many as fit"): the most orders one review may return for a model: 1 plus
// the further orders that fit its output cap after the longest stored answer of any kind and a 20% reserve, at about
// 1,000 tokens a further order (the longest stored order, 2,931 bytes, at about 3 bytes a token). Measured from the
// stored reviews on 2026-11-17 (m4-plan.md); recalibrated from the first dry runs' counts (M-7). A model with no stored
// trade answer is 1. Correction rounds answer under the same cap and rewrite at most these orders, so they fit too.
const WORST_ANSWER=Object.freeze({'claude-opus-5-5':4353,'gpt-6-sol':7380}),FURTHER_ORDER_TOKENS=1000,ANSWER_RESERVE=0.2;
function orderCeiling(config,kind='decide'){const selected=settings(config),worst=WORST_ANSWER[selected.model];if(!Number.isFinite(worst))return 1;const cap=outputCap(config,kind);
  return 1+Math.max(0,Math.floor((cap-worst-ANSWER_RESERVE*cap)/FURTHER_ORDER_TOKENS));}
function outputCap(config,kind='decide'){const selected=settings(config);return MODELS[selected.model].vendor==='anthropic'?(CLAUDE_OUTPUT[kind]??selected.maxOutput):selected.maxOutput;}
// The reservation for a request of a given size (B2: the card's "can reserve up to", from the byte limits).
// A model priced by prompt length is reserved at its long rates when the bytes could pass the threshold (bytes ≥ tokens).
function reservationAt(config,bytes,kind){const selected=settings(config);const rate=ratesFor(MODELS[selected.model],bytes+20000);return Math.max(10000,Math.ceil(((bytes+20000)*rate.input+outputCap(config,kind)*rate.output)*1.2));}
// The app's usage meaning for both vendors: inputTokens is all input, cachedTokens and cacheWriteTokens are the parts of
// it read from and written to the cache. Anthropic reports uncached input separately, so its three counts are summed
// (a missing cache count is zero; a broken one makes the total unknown). Claude reports no reasoning-token count.
function normalizeUsage(body,vendor='openai'){
 const u=body?.usage;const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
 if(vendor==='anthropic'){if(!u)return null;const base=count(u.input_tokens),read=u.cache_read_input_tokens==null?0:count(u.cache_read_input_tokens),write=u.cache_creation_input_tokens==null?0:count(u.cache_creation_input_tokens);
  return {inputTokens:base!=null&&read!=null&&write!=null?base+read+write:null,outputTokens:count(u.output_tokens),cachedTokens:read,cacheWriteTokens:write,reasoningTokens:null,serviceTier:typeof u.service_tier==='string'?u.service_tier.slice(0,20):'standard'};}
 if(vendor!=='openai')throw new Error('INVALID_MODEL_SETTINGS');if(!u)return null;
 return {inputTokens:count(u.input_tokens),outputTokens:count(u.output_tokens),cachedTokens:count(u.input_tokens_details?.cached_tokens),cacheWriteTokens:count(u.input_tokens_details?.cache_write_tokens),reasoningTokens:count(u.output_tokens_details?.reasoning_tokens),serviceTier:body.service_tier??'default'};
}
function costDetails(model,usage){
 const key=rowKey(model);let rate=MODELS[key];
 if(!rate||!usage||!Number.isSafeInteger(usage.inputTokens)||!Number.isSafeInteger(usage.outputTokens)||usage.inputTokens<0||usage.outputTokens<0)return null;
 const cached=usage.cachedTokens??0,written=usage.cacheWriteTokens??0;
 if(!Number.isSafeInteger(cached)||!Number.isSafeInteger(written)||cached<0||written<0||cached+written>usage.inputTokens)return null;
 const tier=usage.serviceTier??'default';
 // Claude: only the standard tier is priced here; priority, batch or another tier is an unknown cost (the call keeps
 // its reservation) until its rates are added.
 // Haiku compacting H-1 (review A): usage.inputTokens is already all input (uncached + cache reads + cache writes,
 // normalizeUsage), the prompt length the long-context rule counts.
 if(rate.vendor==='anthropic'){if(!['standard','default'].includes(tier))return null;rate=ratesFor(rate,usage.inputTokens);
  const components={ordinaryInputMicro:(usage.inputTokens-cached-written)*rate.input,cachedInputMicro:cached*rate.cached,cacheWriteMicro:written*rate.write,outputMicro:usage.outputTokens*rate.output};
  return {micro:Math.round(Object.values(components).reduce((a,b)=>a+b,0)*1000)/1000,...components,rates:{input:rate.input,cached:rate.cached,write:rate.write,output:rate.output},pricingDate:key==='claude-haiku-5-5'?'2026-11-15':'2026-11-10',...(rate.longAbove?{longContext:usage.inputTokens>rate.longAbove}:{}),tier,cacheDetailsKnown:usage.cachedTokens!=null&&usage.cacheWriteTokens!=null,basis:'Reported token usage × published USD rates; not an invoice'};}const multiplier={default:1,standard:1,flex:.5,priority:2,fast:2}[tier];if(!multiplier)return null;
 const long=usage.inputTokens>272000, input=rate.input*(long?2:1)*multiplier,output=rate.output*(long?1.5:1)*multiplier;
 const components={ordinaryInputMicro:(usage.inputTokens-cached-written)*input,cachedInputMicro:cached*input*.1,cacheWriteMicro:written*input*1.25,outputMicro:usage.outputTokens*output};
 return {micro:Math.round(Object.values(components).reduce((a,b)=>a+b,0)*1000)/1000,...components,rates:{input,cached:input*.1,write:input*1.25,output},pricingDate:'2026-10-16',tier,cacheDetailsKnown:usage.cachedTokens!=null&&usage.cacheWriteTokens!=null,basis:'Reported token usage × published USD rates; not an invoice'};
}
function usageEstimate(model,usage){return costDetails(model,usage)?.micro??null;}
function budgetExceeded(config,usage,reserve,reflection=false){const calls=reflection?'reflectionCallsPerDay':'maxCallsPerDay',usd=reflection?'reflectionUSDPerDay':'maxUSDPerDay',prefix=reflection?'reflectionUnlimited':'unlimited';return (!config[prefix+'Calls']&&usage.calls>=config[calls])||(!config[prefix+'Budget']&&usage.reservedMicro+reserve>config[usd]*1e6);}
// Provider naming P2 (artifacts/reviews/2026-11-24-provider-naming): the settings keep provider "openai" for "an AI model
// decides" and openaiModel for the trading model of either company, as stored (renaming them would move the start token).
// The code reads the decision maker through decisionMaker: 'ai', 'rules' or 'external'.
// Exactly the stored value the old comparisons accepted: 'openai' is the AI; any other value is not (as before).
const decisionMaker=config=>{const p=config?.provider;return p==='openai'?'ai':p==='local'?'rules':p==='external'?'external':null;};
module.exports={decisionMaker,contextKeep,CLAUDE_CONTEXT_KEEP,orderCeiling,WORST_ANSWER,FURTHER_ORDER_TOKENS,ANSWER_RESERVE,CLAUDE_TRADING_MODEL,ratesFor,reviewByteLimit,MODELS,vendorOf,assertTradingModel,CLAUDE_TRADING_ENABLED,claudeTradingEnabled,setClaudeTradingForTests,settings,reservation,reservationAt,CLAUDE_OUTPUT,outputCap,usageEstimate,normalizeUsage,costDetails,budgetExceeded};
