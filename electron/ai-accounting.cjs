const {costDetails}=require('./ai-models.cjs');
// vendor: which API served the call (Anthropic provider design 6.3): as the result says, else from the model id; a
// failed call's error carries no vendor, so its model decides. Unknown models record none.
const vendorOf=(response,record)=>{if(['openai','anthropic'].includes(response?.vendor))return response.vendor;try{return require('./ai-models.cjs').vendorOf(response?.model??record.model);}catch{return null;}};
function settle(db,table,day,callId,response,status){
  if(!['ai_usage','reflection_usage'].includes(table))throw Error('INVALID_USAGE_TABLE');
  const row=db.prepare('SELECT payload FROM ai_calls WHERE id=?').get(callId);if(!row)throw Error('UNKNOWN_API_CALL');const record=JSON.parse(row.payload);
  const cost=costDetails(response.model??record.model,response.usage);
  const accountedMicro=cost?.micro??record.accountedMicro??record.reservedMicro;
  // responseChars: the size of the provider's response body, when the client measured it (2026-11-10 incident).
  const next={...record,status,model:response.model??record.model,usage:response.usage??null,cost,estimatedMicro:cost?.micro??null,accountedMicro,...(Number.isInteger(response.responseChars)&&response.responseChars>=0?{responseChars:response.responseChars}:{}),...(vendorOf(response,record)?{vendor:vendorOf(response,record)}:{})};
  // B1: the provider's own daily row (ai_usage_vendor) gets the same correction, under the provider the call was reserved
  // for (the vendor of the model it was reserved with). Profiles without the table (tests of this module) skip it.
  const delta=accountedMicro-(record.accountedMicro??record.reservedMicro);let reservedVendor=null;try{reservedVendor=require('./ai-models.cjs').vendorOf(record.model);}catch{}
  const perVendor=table==='ai_usage'&&reservedVendor&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_usage_vendor'").get();
  db.exec('BEGIN IMMEDIATE');try{db.prepare(`UPDATE ${table} SET reservedMicro=reservedMicro+? WHERE day=?`).run(delta,day);if(perVendor)db.prepare('UPDATE ai_usage_vendor SET reservedMicro=reservedMicro+? WHERE day=? AND vendor=?').run(delta,day,reservedVendor);db.prepare('UPDATE ai_calls SET payload=? WHERE id=?').run(JSON.stringify(next),callId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return next;
}
module.exports={settle};
