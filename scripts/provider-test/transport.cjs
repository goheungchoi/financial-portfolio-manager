'use strict';
// Isolated provider test: the one transport allowed to send. It accepts only a POST to the Responses endpoint, never
// follows a redirect, reserves the request against the meter before anything is sent, and settles it after reading
// the whole response. Each request is logged with its size, reservation, HTTP status, the provider's error code when it
// refused, the reported usage and the actual cost. Everything else in the process is refused by guard.cjs.
const URL='https://api.openai.com/v1/responses';
// persist: writes each reservation before its request is sent and again when it settles; a failure to write it means
// the request is not sent.
function controlledTransport({send,guard,meter,log=[],persist=()=>{}}){
  return async function transport(url,init={}){
    const refused=detail=>{log.push({n:null,kind:'refused',status:'destination-refused',detail});return Object.assign(new Error('ISOLATED_DESTINATION_REFUSED'),{detail});};
    if(url!==URL)throw refused(String(url));
    if(String(init.method??'GET').toUpperCase()!=='POST')throw refused('only POST is sent');
    // A request that cannot be reserved is not sent. The AI client turns any transport error into its own code, so
    // the stop is logged here, where the runner reads it.
    const body=String(init.body??'');let entry;try{entry=meter.reserve(body);}catch(error){log.push({n:null,kind:kindOf(body),status:'budget-stop',reason:error.reason??null,detail:error.detail??null});throw error;}const record={n:entry.n,kind:kindOf(body),bytes:entry.bytes,reservedUSD:entry.reservedMicro/1e6,maxOutputTokens:entry.maxOutputTokens,model:entry.model};log.push(record);
    try{persist(entry);}catch(error){meter.settle(entry,null);Object.assign(record,{status:'not-sent',error:'the reservation could not be recorded'});throw error;}
    guard.enter();let response,text;
    try{response=await send(url,{...init,redirect:'error'});text=await response.text();}
    catch(error){guard.leave();meter.settle(entry,null);try{persist(entry);}catch{}Object.assign(record,{status:'transport-error',error:error?.name==='TimeoutError'?'timeout':String(error?.message??error).slice(0,120)});throw error;}
    guard.leave();
    if(response.status>=300&&response.status<400){meter.settle(entry,null);try{persist(entry);}catch{}Object.assign(record,{status:'redirect-refused',http:response.status});throw refused('redirect');}
    let parsed=null;try{parsed=JSON.parse(text);}catch{}
    const usage=parsed?require('../../electron/ai-models.cjs').normalizeUsage(parsed):null;meter.settle(entry,usage,parsed?.model??null);try{persist(entry);}catch{}
    Object.assign(record,{status:response.ok?'accepted':'rejected',http:response.status,...(response.ok?{responseStatus:parsed?.status??null,incomplete:parsed?.incomplete_details?.reason??null}:{providerError:{type:parsed?.error?.type??null,code:parsed?.error?.code??null,param:parsed?.error?.param??null,message:String(parsed?.error?.message??'').slice(0,300)}}),
      usage,actualUSD:entry.status==='settled'?entry.actualMicro/1e6:null,costKnown:entry.status==='settled',returnedModel:parsed?.model??null,toolCalls:(parsed?.output??[]).filter(i=>i.type==='function_call').map(i=>i.name)});
    return new Response(text,{status:response.status,statusText:response.statusText,headers:{'content-type':response.headers.get('content-type')??'application/json'}});
  };
}
// Which client call a body comes from, by its cache key (electron/ai-client.cjs): the review or condensing.
function kindOf(body){try{const b=JSON.parse(body);return {'portfolio-review-v1':'review','research-compact-v1':'compact'}[b.prompt_cache_key]??String(b.prompt_cache_key??'other');}catch{return 'unreadable';}}
module.exports={controlledTransport,URL};
