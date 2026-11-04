// Local records of reviews that failed for their size, so a failure can be reconstructed exactly (audit 2026-11-04: the
// failure was thrown before the assembled input was saved). Each record keeps the failure code and stage, the app and
// context-schema versions, the size report (every section's bytes, the shaping steps) and the input that would have been
// sent: the shaped first request, or the research continuation that did not fit.
// - Kept in the app's own database on this computer only; nothing here is sent anywhere or written to the repository.
// - Credentials never stored: properties named like keys, secrets, tokens, passwords or authorization headers are
//   replaced, and so are values that look like an API key or a bearer token.
// - The same failure on identical input is one record with its count and first and last time.
// - Retention: records whose last occurrence is older than 30 days are deleted, at most the 20 most recent are kept,
//   and all records together stay under MAX_BYTES (oldest deleted first). An input over INPUT_BYTES is not kept; its
//   record says so and keeps the sizes.
const {createHash,randomUUID}=require('node:crypto');
const LIMITS={days:30,records:20,maxBytes:3000000,inputBytes:400000};
const SECRET_NAME=/^(api[-_]?key|app[-_]?key|app[-_]?secret|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|token|password|passphrase|credentials?|authorization|cookie)$/i;
const SECRET_VALUE=/(\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,})/;
function redact(value,depth=0){
  if(depth>40)return '[too deep]';if(typeof value==='string')return SECRET_VALUE.test(value)?'[redacted]':value;
  if(Array.isArray(value))return value.map(v=>redact(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,SECRET_NAME.test(k)?'[redacted]':redact(v,depth+1)]));
  return value;
}
class ContextFailures {
  constructor(db,clock=Date.now){this.db=db;this.clock=clock;db.exec('CREATE TABLE IF NOT EXISTS context_failures(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,firstAt INTEGER NOT NULL,lastAt INTEGER NOT NULL,count INTEGER NOT NULL,bytes INTEGER NOT NULL,payload TEXT NOT NULL)');}
  // failure: {code, stage, reviewId, appVersion, schema, report, steps, input}. Returns {id, count, inputKept}.
  save({code,stage,reviewId=null,appVersion=null,schema=null,report=null,steps=[],input}){
    const now=this.clock(),clean=redact(input),text=JSON.stringify(clean??null),inputBytes=Buffer.byteLength(text),kept=inputBytes<=LIMITS.inputBytes;
    const hash=createHash('sha256').update(JSON.stringify([code,stage,schema,text])).digest('hex');
    const prev=this.db.prepare('SELECT id,firstAt,count,payload FROM context_failures WHERE hash=?').get(hash);
    const reviewIds=[...(prev?JSON.parse(prev.payload).reviewIds:[]),reviewId].filter(Boolean).slice(-5);
    const payload=JSON.stringify({code,stage,appVersion,schema,report:redact(report),steps:redact(steps),inputBytes,...(kept?{input:clean}:{inputOmitted:`over ${LIMITS.inputBytes} bytes; only the sizes are kept`}),reviewIds});
    const id=prev?.id??'CF-'+randomUUID().slice(0,8),count=(prev?.count??0)+1;
    this.db.prepare('INSERT INTO context_failures VALUES(?,?,?,?,?,?,?) ON CONFLICT(hash) DO UPDATE SET lastAt=excluded.lastAt,count=excluded.count,bytes=excluded.bytes,payload=excluded.payload').run(id,hash,prev?.firstAt??now,now,count,Buffer.byteLength(payload),payload);
    this.prune();return {id,count,inputKept:kept};
  }
  prune(){const now=this.clock();this.db.prepare('DELETE FROM context_failures WHERE lastAt<?').run(now-LIMITS.days*86400000);
    this.db.prepare('DELETE FROM context_failures WHERE id NOT IN (SELECT id FROM context_failures ORDER BY lastAt DESC,rowid DESC LIMIT ?)').run(LIMITS.records);
    const rows=this.db.prepare('SELECT id,bytes FROM context_failures ORDER BY lastAt DESC,rowid DESC').all();let total=0;
    for(const r of rows){total+=r.bytes;if(total>LIMITS.maxBytes)this.db.prepare('DELETE FROM context_failures WHERE id=?').run(r.id);}}
  list(){return this.db.prepare('SELECT id,firstAt,lastAt,count,bytes,payload FROM context_failures ORDER BY lastAt DESC,rowid DESC').all().map(({payload,...r})=>({...r,...JSON.parse(payload)}));}
  totalBytes(){return this.db.prepare('SELECT COALESCE(SUM(bytes),0) n FROM context_failures').get().n;}
}
module.exports={ContextFailures,LIMITS,redact};
