// Standard text-token rates (USD per million tokens) checked against official model pages: GPT 2026-10-16 KST; Claude
// Opus 5.5 2026-11-10 (platform.claude.com pricing and model overview). vendor: the API that serves the model; the model
// id alone selects it (Anthropic provider design T1). GPT rows derive their cache rates (read = input × 0.1, write =
// input × 1.25) and pay a surcharge above 272,000 input tokens; Claude rows carry their own cache rates (read, 5-minute
// write) and have no surcharge.
const MODELS={'gpt-6-luna':{vendor:'openai',input:0.1,output:0.5},'gpt-6-sol':{vendor:'openai',input:2,output:10},'gpt-6-astra':{vendor:'openai',input:10,output:50},'claude-opus-5-5':{vendor:'anthropic',input:4,output:20,cached:0.2,write:5}};
const EFFORTS={openai:['none','low','medium','high'],anthropic:['low','medium','high']};
// The table row for a model id: the exact id, or for GPT a dated snapshot of it (gpt-6-sol-2026-10-01). Claude ids
// match exactly, so a dated or unknown claude-* id is never priced or routed as Opus.
function rowKey(model){if(typeof model!=='string')return null;return Object.keys(MODELS).find(k=>model===k||MODELS[k].vendor==='openai'&&model.startsWith(k+'-20'))??null;}
function vendorOf(model){const key=rowKey(model);if(!key)throw new Error('INVALID_MODEL_SETTINGS');return MODELS[key].vendor;}
// Claude models may not be saved as a trading model (main or routine) until trading on Claude is approved (Anthropic
// provider design 6.3, stage D). The one place to lift it is this constant, in a release, never by a setting.
const CLAUDE_TRADING_ENABLED=false;
function assertTradingModel(model){if(!CLAUDE_TRADING_ENABLED&&vendorOf(model)==='anthropic')throw new Error('CLAUDE_NOT_ENABLED_FOR_TRADING');}
// Claude: efforts low, medium or high (no "none": thinking is adaptive) and 16,000 output tokens, thinking included.
function settings(config={}){const model=config.openaiModel??'gpt-6-luna',effort=config.reasoningEffort??'none';if(!Object.hasOwn(MODELS,model))throw new Error('INVALID_MODEL_SETTINGS');const vendor=MODELS[model].vendor;if(!EFFORTS[vendor].includes(effort)||model==='gpt-6-astra'&&effort==='none')throw new Error('INVALID_MODEL_SETTINGS');return {model,effort,maxOutput:vendor==='anthropic'?16000:effort==='none'?4096:8192};}
// Request size limits for a portfolio review: the first request, and follow-up rounds that carry research results.
// The budget reservation and the AI client both use this, so they always agree.
const reviewByteLimit=options=>options?.continuation?140000:70000;
function reservation(config,context={},options={}){const selected=settings(config);const input=options.continuation??[{role:'user',content:JSON.stringify(context)}];const bytes=Buffer.byteLength(JSON.stringify(input));if(bytes>(options.maxBytes??70000))throw new Error('CONTEXT_TOO_LARGE');const rate=MODELS[selected.model];return Math.max(10000,Math.ceil(((bytes+20000)*rate.input+selected.maxOutput*rate.output)*1.2));}
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
 const key=rowKey(model);const rate=MODELS[key];
 if(!rate||!usage||!Number.isSafeInteger(usage.inputTokens)||!Number.isSafeInteger(usage.outputTokens)||usage.inputTokens<0||usage.outputTokens<0)return null;
 const cached=usage.cachedTokens??0,written=usage.cacheWriteTokens??0;
 if(!Number.isSafeInteger(cached)||!Number.isSafeInteger(written)||cached<0||written<0||cached+written>usage.inputTokens)return null;
 const tier=usage.serviceTier??'default';
 // Claude: only the standard tier is priced here; priority, batch or another tier is an unknown cost (the call keeps
 // its reservation) until its rates are added.
 if(rate.vendor==='anthropic'){if(!['standard','default'].includes(tier))return null;
  const components={ordinaryInputMicro:(usage.inputTokens-cached-written)*rate.input,cachedInputMicro:cached*rate.cached,cacheWriteMicro:written*rate.write,outputMicro:usage.outputTokens*rate.output};
  return {micro:Math.round(Object.values(components).reduce((a,b)=>a+b,0)*1000)/1000,...components,rates:{input:rate.input,cached:rate.cached,write:rate.write,output:rate.output},pricingDate:'2026-11-10',tier,cacheDetailsKnown:usage.cachedTokens!=null&&usage.cacheWriteTokens!=null,basis:'Reported token usage × published USD rates; not an invoice'};}const multiplier={default:1,standard:1,flex:.5,priority:2,fast:2}[tier];if(!multiplier)return null;
 const long=usage.inputTokens>272000, input=rate.input*(long?2:1)*multiplier,output=rate.output*(long?1.5:1)*multiplier;
 const components={ordinaryInputMicro:(usage.inputTokens-cached-written)*input,cachedInputMicro:cached*input*.1,cacheWriteMicro:written*input*1.25,outputMicro:usage.outputTokens*output};
 return {micro:Math.round(Object.values(components).reduce((a,b)=>a+b,0)*1000)/1000,...components,rates:{input,cached:input*.1,write:input*1.25,output},pricingDate:'2026-10-16',tier,cacheDetailsKnown:usage.cachedTokens!=null&&usage.cacheWriteTokens!=null,basis:'Reported token usage × published USD rates; not an invoice'};
}
function usageEstimate(model,usage){return costDetails(model,usage)?.micro??null;}
function budgetExceeded(config,usage,reserve,reflection=false){const calls=reflection?'reflectionCallsPerDay':'maxCallsPerDay',usd=reflection?'reflectionUSDPerDay':'maxUSDPerDay',prefix=reflection?'reflectionUnlimited':'unlimited';return (!config[prefix+'Calls']&&usage.calls>=config[calls])||(!config[prefix+'Budget']&&usage.reservedMicro+reserve>config[usd]*1e6);}
module.exports={reviewByteLimit,MODELS,vendorOf,assertTradingModel,CLAUDE_TRADING_ENABLED,settings,reservation,usageEstimate,normalizeUsage,costDetails,budgetExceeded};
