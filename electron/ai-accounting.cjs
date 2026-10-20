const {costDetails}=require('./ai-models.cjs');
function settle(db,table,day,callId,response,status){
  if(!['ai_usage','reflection_usage','shadow_usage'].includes(table))throw Error('INVALID_USAGE_TABLE');
  const row=db.prepare('SELECT payload FROM ai_calls WHERE id=?').get(callId);if(!row)throw Error('UNKNOWN_API_CALL');const record=JSON.parse(row.payload);
  const cost=costDetails(response.model??record.model,response.usage);
  const accountedMicro=cost?.micro??record.accountedMicro??record.reservedMicro;
  const next={...record,status,model:response.model??record.model,usage:response.usage??null,cost,estimatedMicro:cost?.micro??null,accountedMicro};
  db.exec('BEGIN IMMEDIATE');try{db.prepare(`UPDATE ${table} SET reservedMicro=reservedMicro+? WHERE day=?`).run(accountedMicro-(record.accountedMicro??record.reservedMicro),day);db.prepare('UPDATE ai_calls SET payload=? WHERE id=?').run(JSON.stringify(next),callId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return next;
}
module.exports={settle};
