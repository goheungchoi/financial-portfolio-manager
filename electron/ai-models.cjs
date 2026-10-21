// Standard text-token rates checked against official model pages, 2026-10-16 KST.
const MODELS={'gpt-6-luna':{input:0.1,output:0.5},'gpt-6-sol':{input:2,output:10},'gpt-6-astra':{input:10,output:50}};
function settings(config={}){const model=config.openaiModel??'gpt-6-luna',effort=config.reasoningEffort??'none';if(!Object.hasOwn(MODELS,model)||!['none','low','medium','high'].includes(effort)||model==='gpt-6-astra'&&effort==='none')throw new Error('INVALID_MODEL_SETTINGS');return {model,effort,maxOutput:effort==='none'?4096:8192};}
// Request size limits for a portfolio review: the first request, and follow-up rounds that carry research results.
// The budget reservation and the AI client both use this, so they always agree.
const reviewByteLimit=options=>options?.continuation?140000:70000;
function reservation(config,context={},options={}){const selected=settings(config);const input=options.continuation??[{role:'user',content:JSON.stringify(context)}];const bytes=Buffer.byteLength(JSON.stringify(input));if(bytes>(options.maxBytes??70000))throw new Error('CONTEXT_TOO_LARGE');const rate=MODELS[selected.model];return Math.max(10000,Math.ceil(((bytes+20000)*rate.input+selected.maxOutput*rate.output)*1.2));}
function normalizeUsage(body){
 const u=body?.usage;if(!u)return null;
 const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
 return {inputTokens:count(u.input_tokens),outputTokens:count(u.output_tokens),cachedTokens:count(u.input_tokens_details?.cached_tokens),cacheWriteTokens:count(u.input_tokens_details?.cache_write_tokens),reasoningTokens:count(u.output_tokens_details?.reasoning_tokens),serviceTier:body.service_tier??'default'};
}
function costDetails(model,usage){
 const key=Object.keys(MODELS).find(k=>model===k||model?.startsWith(k+'-20'));const rate=MODELS[key];
 if(!rate||!usage||!Number.isSafeInteger(usage.inputTokens)||!Number.isSafeInteger(usage.outputTokens)||usage.inputTokens<0||usage.outputTokens<0)return null;
 const cached=usage.cachedTokens??0,written=usage.cacheWriteTokens??0;
 if(!Number.isSafeInteger(cached)||!Number.isSafeInteger(written)||cached<0||written<0||cached+written>usage.inputTokens)return null;
 const tier=usage.serviceTier??'default';const multiplier={default:1,standard:1,flex:.5,priority:2,fast:2}[tier];if(!multiplier)return null;
 const long=usage.inputTokens>272000, input=rate.input*(long?2:1)*multiplier,output=rate.output*(long?1.5:1)*multiplier;
 const components={ordinaryInputMicro:(usage.inputTokens-cached-written)*input,cachedInputMicro:cached*input*.1,cacheWriteMicro:written*input*1.25,outputMicro:usage.outputTokens*output};
 return {micro:Math.round(Object.values(components).reduce((a,b)=>a+b,0)*1000)/1000,...components,rates:{input,cached:input*.1,write:input*1.25,output},pricingDate:'2026-10-16',tier,cacheDetailsKnown:usage.cachedTokens!=null&&usage.cacheWriteTokens!=null,basis:'Reported token usage × published USD rates; not an invoice'};
}
function usageEstimate(model,usage){return costDetails(model,usage)?.micro??null;}
function budgetExceeded(config,usage,reserve,reflection=false){const calls=reflection?'reflectionCallsPerDay':'maxCallsPerDay',usd=reflection?'reflectionUSDPerDay':'maxUSDPerDay',prefix=reflection?'reflectionUnlimited':'unlimited';return (!config[prefix+'Calls']&&usage.calls>=config[calls])||(!config[prefix+'Budget']&&usage.reservedMicro+reserve>config[usd]*1e6);}
module.exports={reviewByteLimit,MODELS,settings,reservation,usageEstimate,normalizeUsage,costDetails,budgetExceeded};
