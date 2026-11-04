// Lesson evidence and reflections (audit 2026-11-04, Stage 4): a sale's evidence carries its entries and exit; only a
// material change reopens a lesson or queues a paid reflection; one procedural draft; the Kia reflection redone once.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const L=require('../electron/learning-memory.cjs');const {ReflectionQueue,REFLECTION_VERSION}=require('../electron/reflection.cjs');
const DAY=86400000,T=Date.parse('2026-11-02T01:00:00Z');
const plan={strategy:'swing',thesis:'Q3 margin recovery',invalidation:'Q3 operating margin below 8%',stopPrice:84000};
const fill=(id,side,effect,at,price,extra={})=>({id:'broker:'+id,orderId:id,reviewId:'R-'+id,source:'broker',accountKey:'acct',environment:'live',market:'KR',currency:'KRW',symbol:'000270',side,effect,status:'Filled',quantity:1,requested:1,averagePrice:price,timestamp:at,
  decision:{action:side,explanation:`${side} because ${id}`,plan:side==='Buy'?plan:null},reviewEvidence:{quote:{price,bid:price-100,ask:price+100}},...extra});
const buy=fill('B1','Buy','OPEN_LONG',T-7*DAY,106000);
const sale=fill('S1','Sell','CLOSE_LONG',T,88800,{gross:88800,fees:180,netCash:88620,gainAfterFees:-17380,gainAfterEstimatedTax:-17380,costBasis:'broker',taxStatus:'Estimated transaction tax'});
function setup(rows=[buy,sale]){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE lessons(id TEXT PRIMARY KEY,text TEXT,approved INTEGER);CREATE TABLE trade_outcomes(id TEXT PRIMARY KEY,payload TEXT);CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT)');
  for(const r of rows)db.prepare('INSERT INTO reviews VALUES(?,?)').run(r.reviewId,JSON.stringify({timestamp:r.timestamp-60000}));
  const put=o=>db.prepare('INSERT OR REPLACE INTO trade_outcomes VALUES(?,?)').run(o.id,JSON.stringify(o));rows.forEach(put);const memory=new L.LearningMemory(db);memory.sync();return {db,memory,put,id:'outcome:'+sale.id};}
test('a sale carries the entry it closes: review id, rationale, thesis, invalidation, stop, fill and quote',()=>{const {memory,id}=setup();
  const e=memory.describe(id);assert.equal(e.evidenceVersion,2);assert.equal(e.episode.entries.length,1);const entry=e.episode.entries[0];
  assert.equal(entry.decisionId,'R-B1');assert.equal(entry.thesis,'Q3 margin recovery');assert.equal(entry.invalidation,'Q3 operating margin below 8%');assert.equal(entry.stopPrice,84000);assert.equal(entry.fillPrice,106000);assert.deepEqual(entry.quoteAtDecision,{price:106000,bid:105900,ask:106100});
  assert.equal(e.episode.exit.decisionId,'R-S1');assert.match(e.episode.exit.rationale,/Sell because S1/);assert.equal(e.episode.exit.decidedAt,new Date(T-60000).toISOString());
});
test('the episode starts where the position was last flat; a sale with no recorded entry says so',()=>{
  const first=fill('S0','Sell','CLOSE_LONG',T-5*DAY,99000),again=fill('B2','Buy','OPEN_LONG',T-3*DAY,95000);
  const {memory,id}=setup([buy,first,again,sale]);assert.deepEqual(memory.describe(id).episode.entries.map(x=>x.decisionId),['R-B2']);
  const lone=setup([sale]);assert.deepEqual(lone.memory.describe(lone.id).episode.entries,[]);assert.match(lone.memory.describe(lone.id).episode.entriesUnavailable,/No filled entry/);
});
test('a small fee correction updates the record but keeps the signature, the approval and the reflection',()=>{const {db,memory,put,id}=setup();
  const signature=memory.lifecycle(id).signature;memory.review(id,{action:'approve',expectedSignature:signature});
  put({...sale,fees:230,netCash:88570,gainAfterFees:-17430,gainAfterEstimatedTax:-17430,version:2});memory.sync();
  assert.equal(memory.lifecycle(id).signature,signature);assert.equal(memory.lifecycle(id).status,'approved');assert.equal(memory.describe(id).fees,230,'the record is current');
  const h=db.prepare('SELECT payload FROM lesson_history ORDER BY seq').all().map(r=>JSON.parse(r.payload)).at(-1);assert.equal(h.action,'evidence-updated');assert.equal(h.material,false);assert.equal(h.previousEvidence.fees,180,'the earlier version is kept');
  for(const change of [{gainAfterFees:1200},{quantity:2},{averagePrice:90000},{gainAfterFees:-25000}]){assert.equal(L.materialChange(memory.describe(id),{...memory.describe(id),...change}),true,JSON.stringify(change));}
  put({...sale,gainAfterFees:250,gainAfterEstimatedTax:250});memory.sync();assert.equal(memory.lifecycle(id).status,'needs-review','a result that changes sign is material');
});
test('evidence from before this version (no episode) with the same facts keeps its signature and approval',()=>{const {db,memory,id}=setup();
  const signature=memory.lifecycle(id).signature;memory.review(id,{action:'approve',expectedSignature:signature});const {episode,evidenceVersion,...old}=JSON.parse(db.prepare('SELECT payload FROM lesson_evidence WHERE id=?').get(id).payload);
  db.prepare('UPDATE lesson_evidence SET payload=? WHERE id=?').run(JSON.stringify(old),id);memory.sync();assert.equal(memory.lifecycle(id).signature,signature);assert.equal(memory.lifecycle(id).status,'approved');assert.equal(memory.describe(id).evidenceVersion,2);
});
const result={facts:'f',uncertainty:'u',hypothesis:'h',lesson:'l',applicability:'a'};const config={reflectionEnabled:true,shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',reflectionCallsPerDay:5,reflectionUSDPerDay:1};
test('a lesson awaiting review whose reflection lacked the entry and exit is reflected on once more; the earlier one is kept',async()=>{const {db,memory,id}=setup();try{
  const q=new ReflectionQueue(db,memory);q.sync();const base=q.jobs().find(j=>j.lessonId===id);assert.equal(base.evidenceVersion,2,'a new lesson starts from complete evidence');
  // The Kia case: a completed reflection from version-1 evidence.
  q.save({...base,status:'completed',result:{...result,lesson:'old'},evidenceVersion:undefined});q.sync();q.sync();new ReflectionQueue(db,memory).sync();
  const again=q.jobs().filter(j=>j.id.endsWith(':evidence-2'));assert.equal(again.length,1,'once, however often it syncs');assert.equal(again[0].regenerates,base.id);
  let sent=null;await q.tick(config,true,{request:async(op,args)=>{sent=args.context;return {reflection:result,usage:{inputTokens:1,outputTokens:1}};}});
  assert.ok(sent.evidence.episode.entries.length===1,'the request carries the entry');assert.equal(JSON.stringify(sent).includes('acct'),false,'no account identity');
  const done=q.jobs().find(j=>j.id===again[0].id);assert.equal(done.status,'completed');assert.equal(done.evidenceVersion,2);assert.equal(done.instructions,REFLECTION_VERSION);assert.equal(done.evidence.episode.exit.decisionId,'R-S1');
  assert.equal(q.jobs().find(j=>j.id===base.id).result.lesson,'old','the earlier reflection is kept');assert.equal('evidence' in q.state().jobs[0],false,'snapshots stay out of the screen state');
  q.sync();assert.equal(q.jobs().filter(j=>['queued','retry'].includes(j.status)).length,0,'nothing more is queued');
}finally{db.close();}});
test('an approved lesson is not reflected on again because the evidence format changed',()=>{const {db,memory,id}=setup();try{
  memory.review(id,{action:'approve',expectedSignature:memory.lifecycle(id).signature});const q=new ReflectionQueue(db,memory);q.sync();const base=q.jobs()[0];q.save({...base,status:'completed',result,evidenceVersion:undefined});q.sync();
  assert.equal(q.jobs().length,1);}finally{db.close();}});
test('one procedural draft per database: pending until approved, then given to live reviews with its exception',()=>{const {db,memory}=setup();try{
  const p=L.PROCEDURAL.id;memory.proposeProcedural();memory.proposeProcedural();new L.LearningMemory(db).proposeProcedural();
  assert.equal(db.prepare('SELECT count(*) n FROM lessons WHERE id=?').get(p).n,1);const state=memory.lifecycle(p);assert.equal(state.status,'pending');assert.equal(state.kind,'procedural');assert.equal(state.reviewDays,30);
  assert.match(memory.list().find(l=>l.id===p).text,/never delays a protective exit or a mandatory risk action/);assert.equal(memory.describe(p).confidence,'low');
  const live={environment:'kis',universe:[{symbol:'005930'}],positions:{}};assert.equal(memory.relevantLessons(live,['acct']).length,0,'a draft reaches no review');
  const q=new ReflectionQueue(db,memory);q.sync();assert.equal(q.jobs().some(j=>j.lessonId===p),false,'no paid reflection for it');
  const t0=Date.now();memory.review(p,{action:'approve',expectedSignature:state.signature});const approved=memory.lifecycle(p);assert.ok(Math.abs(approved.expiresAt-(t0+30*DAY))<5000,'first review after 30 days');
  const lessons=memory.relevantLessons(live,['acct']);assert.equal(lessons[0].id,p);assert.match(lessons[0].text,/^Procedural reminder \(low empirical support\): Before exiting or re-entering/);assert.equal(memory.relevantLessons({...live,environment:'local-paper'},[]).length,0);
  memory.review(p,{action:'retire',expectedSignature:state.signature});memory.proposeProcedural();assert.equal(memory.lifecycle(p).status,'retired','never re-created');
}finally{db.close();}});
test('the reflection request is told to use the episode and not to infer a rule from one outcome',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/ai-client.cjs'),'utf8');assert.match(src,/evidence\.episode gives the filled entries since the position was last flat/);assert.match(src,/do not propose a new empirical trading rule from it/);
});
