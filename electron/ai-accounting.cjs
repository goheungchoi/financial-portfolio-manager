const {costDetails}=require('./ai-models.cjs');
// vendor: which API served the call (Anthropic provider design 6.3): as the result says, else from the model id; a
// failed call's error carries no vendor, so its model decides. Unknown models record none.
const vendorOf=(response,record)=>{if(['openai','anthropic'].includes(response?.vendor))return response.vendor;try{return require('./ai-models.cjs').vendorOf(response?.model??record.model);}catch{return null;}};
function settle(db,table,day,callId,response,status){
  if(!['ai_usage','reflection_usage'].includes(table))throw Error('INVALID_USAGE_TABLE');
  const row=db.prepare('SELECT payload FROM ai_calls WHERE id=?').get(callId);if(!row)throw Error('UNKNOWN_API_CALL');const record=JSON.parse(row.payload);
  // A certain refusal (Claude refused-request design 2, review ruling 2): a 4xx answer with a received body and no usage is
  // refused before the model runs, so it settles at zero (status 'refused') instead of keeping its reservation. It stays
  // one call in the counters. Timeouts, connection errors, 5xx, 529, a missing status and any answer with usage are
  // unchanged.
  const refusal=require('./provider-error-reply.cjs').providerError(response?.providerError);
  // Zero only when certain (diff review F2): a refusal on a retry after an uncertain attempt (5xx, 529, timeout,
  // connection error) on the same call record keeps the reservation.
  const refused=Boolean(refusal?.noCharge&&refusal.status<500&&response.usage==null&&response.earlierUncertain!==true);
  const cost=refused?null:costDetails(response.model??record.model,response.usage);
  const accountedMicro=refused?0:cost?.micro??record.accountedMicro??record.reservedMicro;
  // responseChars: the size of the provider's response body, when the client measured it (2026-11-10 incident).
  const next={...record,status:refused?'refused':status,model:response.model??record.model,usage:response.usage??null,cost,estimatedMicro:refused?0:cost?.micro??null,accountedMicro,...(refusal?{providerError:refusal}:{}),
    // The enforced decision form: which form answered, whether it fell back to text, and the JSON-text parts dropped (E1, E3).
    ...(['enforced','text'].includes(response?.answerForm)?{answerForm:response.answerForm}:{}),...(response?.formFallback===true?{formFallback:true}:{}),...(Array.isArray(response?.textPartsDropped)&&response.textPartsDropped.length?{textPartsDropped:response.textPartsDropped.filter(k=>['strategyCheck','scoutBrief','planVerdicts'].includes(k))}:{}),...(Number.isInteger(response.responseChars)&&response.responseChars>=0?{responseChars:response.responseChars}:{}),...(typeof response.stopReason==='string'?{stopReason:response.stopReason.slice(0,30)}:{}),...(response.requestSizes&&typeof response.requestSizes==='object'?{requestSizes:Object.fromEntries(Object.entries(response.requestSizes).filter(([k,v])=>/^[a-zA-Z]{1,30}$/.test(k)&&Number.isInteger(v)).slice(0,8))}:{}),...(Number.isInteger(response.droppedThinking)&&response.droppedThinking>0?{droppedThinking:response.droppedThinking}:{}),...(vendorOf(response,record)?{vendor:vendorOf(response,record)}:{})};
  // B1: the provider's own daily row (ai_usage_vendor) gets the same correction, under the provider the call was reserved
  // for (the vendor of the model it was reserved with). Profiles without the table (tests of this module) skip it.
  const delta=accountedMicro-(record.accountedMicro??record.reservedMicro);let reservedVendor=null;try{reservedVendor=require('./ai-models.cjs').vendorOf(record.model);}catch{}
  const perVendor=(table==='ai_usage'||table==='reflection_usage'&&reservedVendor==='anthropic')&&reservedVendor&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_usage_vendor'").get();
  // A refusal's release goes to the day the call was reserved on (the caller passes the reservation's day, also after
  // midnight KST) and never takes a row below zero (review C4).
  const add=refused?'MAX(0,reservedMicro+?)':'reservedMicro+?';
  db.exec('BEGIN IMMEDIATE');try{db.prepare(`UPDATE ${table} SET reservedMicro=${add} WHERE day=?`).run(delta,day);if(perVendor)db.prepare(`UPDATE ai_usage_vendor SET reservedMicro=${add} WHERE day=? AND vendor=?`).run(delta,day,reservedVendor);db.prepare('UPDATE ai_calls SET payload=? WHERE id=?').run(JSON.stringify(next),callId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return next;
}
module.exports={settle};
