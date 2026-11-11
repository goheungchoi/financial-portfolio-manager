// CPU fixes F1-F3 (artifacts/reviews/2026-11-11-cpu/fix-plan.md).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PaperEngine}=require('../electron/paper-engine.cjs');
const changes=db=>db.prepare('SELECT total_changes() AS n').get().n;
function paper(start=Date.parse('2026-11-11T03:00:00Z')){const db=new DatabaseSync(':memory:');let now=start,sequence=1,price=100;
  const engine=new PaperEngine(db,[{symbol:'005930',name:'Fixture',price:100}],()=>[{symbol:'005930',price,timestamp:now,sequence,volume:10,stale:false}],()=>now);
  return {db,engine,step:(ms=1000)=>{sequence++;now+=ms;},price:v=>{price=v;},at:t=>{now=t;}};}
const stored=db=>JSON.parse(db.prepare('SELECT payload FROM paper_account WHERE id=1').get().payload);

// F1: PaperEngine.tick() saves the account only when it changed.
test('F1: ticks with nothing changed leave total_changes() unchanged',()=>{const {db,engine,step}=paper();try{
  engine.tick();const before=changes(db);for(let i=0;i<5;i++){step();engine.tick();}assert.equal(changes(db),before);
}finally{db.close();}});
test('F1: a new day peak is saved in its tick, an equal or lower value is not',()=>{const {db,engine,step,price}=paper();try{
  engine.saveAccount({...engine.account(),cash:1000,dayBaseline:1100,dayPeakEquity:1100,positions:{'005930':{quantity:1,costTotal:100,markPrice:100}}});engine.tick();
  const before=changes(db);price(150);step();engine.tick();assert.equal(stored(db).dayPeakEquity,1150);assert.equal(changes(db),before+1);
  price(120);step();engine.tick();assert.equal(changes(db),before+1,'lower equity keeps the peak and writes nothing');assert.equal(stored(db).dayPeakEquity,1150);
}finally{db.close();}});
test('F1: the day roll at Seoul midnight is saved in its tick',()=>{const {db,engine,at}=paper(Date.parse('2026-11-11T14:59:59Z'));try{
  engine.saveAccount({...engine.account(),dailyTurnover:5000});engine.tick();const before=changes(db);assert.equal(stored(db).day,'2026-11-11');
  at(Date.parse('2026-11-11T15:00:01Z'));engine.tick();const a=stored(db);assert.equal(a.day,'2026-11-12');assert.equal(a.dailyTurnover,0);assert.equal(changes(db),before+1);
}finally{db.close();}});
test('F1: a fill is saved as before: order, fill and account in the same tick',()=>{const {db,engine,step}=paper();try{
  engine.setPaused(false);const proposal=engine.propose({symbol:'005930',side:'Buy',quantity:2});engine.submit(proposal.id);const v0=stored(db).version,cash0=stored(db).cash;
  step();engine.tick();const a=stored(db);assert.ok(a.version>v0);assert.ok(a.cash<cash0);assert.equal(a.positions['005930'].quantity,2);
  assert.equal(engine.orders().at(-1).status,'Filled');assert.equal(db.prepare('SELECT count(*) n FROM paper_fills').get().n,1);
  const before=changes(db);step();engine.tick();assert.equal(changes(db),before,'nothing pending afterwards: no write');
}finally{db.close();}});
test('F1: a cancellation on pause bumps the version and is saved',()=>{const {db,engine,step}=paper();try{
  engine.setPaused(false);const proposal=engine.propose({symbol:'005930',side:'Buy',quantity:2});engine.submit(proposal.id);
  // Pause through the stored account (setPaused cancels at once); the tick must cancel and save.
  engine.saveAccount({...stored(db),paused:true});const v0=stored(db).version;step();engine.tick();
  assert.equal(engine.orders().at(-1).status,'Canceled');assert.equal(stored(db).version,v0+1);
}finally{db.close();}});

// F2: an index for the news list, with the same rows and order.
const {NewsEvents}=require('../electron/news-events.cjs');
test('F2: the news list returns the same rows in the same order, ties included, and reads through the index',()=>{const db=new DatabaseSync(':memory:');try{
  const news=new NewsEvents(db);new NewsEvents(db);// creating it twice is harmless
  const seen=[5,3,5,9,1,9,9,2,5,7];seen.forEach((t,i)=>news.save({id:'u'+i,firstSeenAt:t,title:'t'+i,symbols:[]}));db.prepare('DELETE FROM news_events WHERE id=?').run('u4');news.save({id:'u4',firstSeenAt:9,title:'again',symbols:[]});
  const plain=db.prepare('SELECT payload FROM news_events NOT INDEXED ORDER BY firstSeenAt DESC,rowid DESC LIMIT ?');
  for(const limit of [1,3,100])assert.deepEqual(news.list(limit).map(e=>e.id),plain.all(limit).map(r=>JSON.parse(r.payload).id));
  assert.deepEqual(news.list(5).map(e=>e.id),['u4','u6','u5','u3','u9']);
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM news_events ORDER BY firstSeenAt DESC,rowid DESC LIMIT 100').all().map(r=>r.detail).join(' | ');
  assert.match(plan,/USING INDEX news_events_seen/);assert.doesNotMatch(plan,/TEMP B-TREE/);
}finally{db.close();}});

// F3: the attention panel reads the backoff and the cached news list, not the whole getState().
const {Automation}=require('../electron/automation.cjs');
const automation=()=>{const db=new DatabaseSync(':memory:');return {db,a:new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F3',price:1000}],()=>[]),{},()=>{})};};
test('F3: reviewBackoffState() equals getState().reviewBackoff with the backoff cleared and active',()=>{const {db,a}=automation();try{
  assert.equal(a.reviewBackoffState(),null);assert.equal(a.getState().reviewBackoff,null);
  const err=Object.assign(new Error('INVALID_AI_RESPONSE'),{detail:{rule:'final round'}});a.noteReviewOutcome('INVALID_AI_RESPONSE',err);a.noteReviewOutcome('INVALID_AI_RESPONSE',err);
  const b=a.reviewBackoffState();assert.ok(b&&b.until>Date.now());assert.deepEqual(b,a.getState().reviewBackoff);assert.deepEqual(Object.keys(b),['until','count','lastCode','lastRule']);
  a.db.prepare('UPDATE review_backoff SET payload=json_set(payload,\'$.until\',?) WHERE id=1').run(Date.now()-1);assert.equal(a.reviewBackoffState(),null,'an expired backoff shows nothing');
}finally{db.close();}});
test('F3: the attention panel shares the cached news list with getState()',()=>{const {db,a}=automation();try{
  const now=Date.now();a.newsEvents.save({id:'n1',firstSeenAt:now,title:'Important',importance:'high',symbols:['005930']});a.newsEvents.save({id:'n2',firstSeenAt:now-1,title:'Other',importance:'low',symbols:[]});
  const s=a.getState();const shared=a.stateCached('newsEvents',()=>{throw new Error('a second read');});assert.equal(shared,s.newsEvents,'same cached list, no second read');
  assert.deepEqual(shared.map(e=>e.id),a.newsEvents.list(100).map(e=>e.id));
}finally{db.close();}});
test('F3: attentionState in main.cjs no longer builds the whole state and reads the news through the cache',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');const body=src.slice(src.indexOf('const attentionState=()=>{'),src.indexOf('return {items',src.indexOf('const attentionState=()=>{')));
  assert.ok(body.length>500,'found attentionState');assert.ok(!body.includes('automation.getState('),'no full getState()');assert.ok(body.includes('automation.reviewBackoffState()'));
  assert.ok(body.includes("automation.stateCached('newsEvents',()=>automation.newsEvents.list(100))"));assert.ok(!/automation\.newsEvents\.list\(100\)\.filter/.test(body));
});

// F1 follow-on: a write committed by another connection makes the history cache read again (PRAGMA data_version);
// the app's own writes still count through total_changes() as before.
test('F1: the history cache sees writes from another connection, and stays warm without writes',()=>{
  const file=require('node:path').join(require('node:os').tmpdir(),`cpu-fixes-${process.pid}-${Date.now()}.sqlite`);const db=new DatabaseSync(file),other=new DatabaseSync(file);
  try{const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'F1',price:1000}],()=>[]),{},()=>{});db.exec('CREATE TABLE probe_t(k TEXT)');let reads=0;const read=()=>{reads++;return reads;};
    a.stateCached('probe',read);a.stateCached('probe',read);assert.equal(reads,1,'warm without writes');
    other.exec("INSERT INTO probe_t VALUES('other')");assert.equal(a.stateCached('probe',read),2,'another connection wrote: read again');
    assert.equal(a.stateCached('probe',read),2);db.prepare("INSERT INTO probe_t VALUES('own')").run();assert.equal(a.stateCached('probe',read),3,'own write: read again');
  }finally{other.close();db.close();for(const s of ['','-wal','-shm'])require('node:fs').rmSync(file+s,{force:true});}
});
