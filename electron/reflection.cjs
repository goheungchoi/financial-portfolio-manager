const {seoulDate}=require('./kis-activity.cjs');
const {randomUUID}=require('node:crypto');
const models=require('./ai-models.cjs');
const fields=['facts','uncertainty','hypothesis','lesson','applicability'];
const SCHEMA={type:'object',properties:Object.fromEntries(fields.map(k=>[k,{type:'string'}])),required:fields,additionalProperties:false};
function validate(value){if(!value||Object.keys(value).sort().join()!==[...fields].sort().join()||fields.some(k=>typeof value[k]!=='string'||!value[k].trim()||value[k].length>1800))throw new Error('INVALID_REFLECTION');return value;}
class ReflectionQueue {
  constructor(db,memory){this.db=db;this.memory=memory;this.busy=false;this.reason='Disabled';db.exec('CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,day TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reflections(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reflection_usage(day TEXT PRIMARY KEY,calls INTEGER,reservedMicro INTEGER)');for(const j of this.jobs())if(j.status==='running')this.save({...j,status:j.attempts>=3?'failed':'retry',nextAt:Date.now()+60000,error:'Interrupted; previous request may have been billed'});}
  jobs(){return this.db.prepare('SELECT payload FROM reflections ORDER BY rowid').all().map(r=>JSON.parse(r.payload));}
  save(j){this.db.prepare('INSERT INTO reflections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(j.id,JSON.stringify(j));}
  sync(){for(const j of this.jobs())if(this.memory.lifecycle(j.lessonId)?.signature!==j.signature&&j.status!=='superseded')this.save({...j,status:'superseded'});for(const r of this.db.prepare('SELECT id,payload,signature FROM lesson_evidence').all()){const e=JSON.parse(r.payload),l=this.memory.lifecycle(r.id);if(!e.assessment?.eligible||l?.status==='retired')continue;const id=r.id+':'+r.signature;if(!this.db.prepare('SELECT id FROM reflections WHERE id=?').get(id))this.save({id,lessonId:r.id,signature:r.signature,symbol:e.symbol,status:'queued',attempts:0,nextAt:0,createdAt:Date.now()});}}
  state(){return {reason:this.reason,busy:this.busy,usage:this.db.prepare('SELECT calls,reservedMicro FROM reflection_usage WHERE day=?').get(seoulDate())??{calls:0,reservedMicro:0},jobs:this.jobs().slice(-50).reverse().map(({signature,...j})=>j)};}
  async tick(config,connected,provider,log=()=>{}){
    if(this.busy)return;this.sync();
    if(!config.reflectionEnabled){this.reason='Disabled';return;}if(!connected){this.reason='API key required';return;}
    const job=this.jobs().find(j=>['queued','retry'].includes(j.status)&&j.nextAt<=Date.now()&&this.memory.lifecycle(j.lessonId)?.status!=='retired'&&(this.memory.describe(j.lessonId)?.source==='paper'||config.shareKisWithAI));
    if(!job){this.reason='Waiting for eligible sales or data-sharing permission';return;}
    const evidence=this.memory.describe(job.lessonId);
    // Whitelisted normalized evidence only; account identities and raw broker payloads never leave this process.
    const context={evidence};const reserve=models.reservation(config,context),day=seoulDate();const usage=this.db.prepare('SELECT calls,reservedMicro FROM reflection_usage WHERE day=?').get(day)??{calls:0,reservedMicro:0};
    if(models.budgetExceeded(config,usage,reserve,true)){this.reason='Reflection daily budget reached';return;}
    const callId=randomUUID(),callRecord={source:'reflection',model:config.openaiModel,reasoningEffort:config.reasoningEffort,reservedMicro:reserve,status:'pending',timestamp:Date.now()};this.busy=true;this.reason='Reflecting';const running={...job,status:'running',attempts:job.attempts+1,model:config.openaiModel,startedAt:Date.now(),reservedMicro:(job.reservedMicro??0)+reserve};
    try{
      this.db.exec('BEGIN IMMEDIATE');try{this.save(running);this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(callId,day,JSON.stringify(callRecord));this.db.prepare('INSERT OR REPLACE INTO reflection_usage VALUES(?,?,?)').run(day,usage.calls+1,usage.reservedMicro+reserve);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
      log(job.id,'System','Post-trade reflection started',job.symbol);
      const reply=await provider.request('reflection',{context,options:{openaiModel:config.openaiModel,reasoningEffort:config.reasoningEffort}});const {cost}=require('./ai-accounting.cjs').settle(this.db,'reflection_usage',day,callId,reply,'completed');const result=validate(reply.reflection);
      const current=this.memory.lifecycle(job.lessonId);const stale=current?.signature!==job.signature;
      this.save({...running,status:stale?'superseded':'completed',result,usage:reply.usage??null,cost,estimatedMicro:cost?.micro??null,completedAt:Date.now()});
      // Do not overwrite reviewed user text or auto-approve an AI hypothesis.
      log(job.id,'System',stale?'Reflection superseded':'Reflection ready for review',JSON.stringify(result));this.reason='Ready';
    }catch(error){require('./ai-accounting.cjs').settle(this.db,'reflection_usage',day,callId,error,'failed-or-uncertain');this.save({...running,status:running.attempts>=3?'failed':'retry',nextAt:Date.now()+60000*2**running.attempts,error:'Reflection failed; reservation retained'});this.reason='Retry scheduled';log(job.id,'System','Reflection failed','Retry is bounded to three attempts; reservations are retained.');}finally{this.busy=false;}
  }
}
module.exports={ReflectionQueue,SCHEMA,validate};
