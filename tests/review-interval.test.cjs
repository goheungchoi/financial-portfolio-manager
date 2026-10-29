const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const {ReviewInterval}=require('../electron/review-interval.cjs');
test('AI intervals require opt-in, stay bounded, persist and isolate account scopes',()=>{const db=new DatabaseSync(':memory:');try{const interval=new ReviewInterval(db),fixed={autoReviewInterval:false,intervalMinutes:10},auto={...fixed,autoReviewInterval:true};assert.equal(interval.set('a',{minutes:2,reason:'Volatile'},fixed).status,'rejected');for(const minutes of [0,61,1.2])assert.equal(interval.set('a',{minutes,reason:'Test'},auto).status,'rejected');assert.equal(interval.set('a',{minutes:20,reason:'Quiet'},auto).status,'saved');assert.equal(new ReviewInterval(db).get('a',auto).minutes,20);assert.equal(interval.get('b',auto).minutes,10);assert.equal(interval.get('a',fixed).minutes,10);}finally{db.close();}});
test('research loop supplies interval tool output to the final decision',async()=>{const {researchReview}=require('../electron/research-review.cjs');let count=0,updated;const result=await researchReview({context:{universe:[]},evidence:{},log:()=>{},setInterval:value=>(updated=value,{status:'saved'}),request:async options=>++count===1?{toolCalls:[{name:'set_review_interval',callId:'interval',args:{minutes:5,reason:'Market open'}}],continuation:[]}:(assert.equal(options.continuation[0].call_id,'interval'),{decision:{action:'Hold'}})});assert.equal(updated.minutes,5);assert.equal(result.decision.action,'Hold');});
test('a shorter interval than the user\'s needs a moving holding, is at least five minutes and lasts an hour',()=>{
  // 2026-10-29: the agent set 5 to 10 minutes all afternoon to wait for a results presentation and the next U.S. quote.
  let now=Date.parse('2026-10-29T04:18:00Z');const interval=new ReviewInterval(new DatabaseSync(':memory:'),()=>now);const auto={autoReviewInterval:true,intervalMinutes:30,eventTolerancePct:3};
  const waiting=interval.set('a',{minutes:5,reason:'E&A IR profit mix unverified; reassess Alphabet at the U.S. open'},auto,{heldMoves:[{symbol:'028050',changePct:-2.2}]});
  assert.equal(waiting.status,'rejected');assert.equal(waiting.reason,'SHORTER_NEEDS_A_MOVING_HOLDING');assert.match(waiting.note,/filing, results or the next session/);assert.equal(interval.get('a',auto).minutes,30,'your interval stays');
  assert.equal(interval.set('a',{minutes:45,reason:'Calm'},auto).status,'saved','lengthening needs no move');
  const moving={heldMoves:[{symbol:'028050',changePct:-3.4}]};assert.match(interval.set('a',{minutes:2,reason:'E&A falling'},auto,moving).note,/at least 5/);
  const saved=interval.set('a',{minutes:10,reason:'E&A falling 3.4%'},auto,moving);assert.equal(saved.status,'saved');assert.equal(saved.minutes,10);assert.equal(saved.until,'2026-10-29T05:18:00.000Z');
  now+=59*60000;assert.equal(interval.get('a',auto).minutes,10);now+=60000;const back=interval.get('a',auto);assert.equal(back.minutes,30,'after an hour');assert.match(back.reason,/ended after an hour/);assert.equal(back.until,undefined);
});
test('review P2: a short interval saved before the rule, in an existing database, falls back to the user\'s interval',()=>{
  // As the live database held it on 2026-10-29: the agent's 5-minute interval, saved with no end.
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE review_intervals(scope TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  db.prepare('INSERT INTO review_intervals VALUES(?,?)').run('a',JSON.stringify({minutes:5,reason:'Korean construction down ~5%, E&A IR profit mix unverified',updatedAt:Date.parse('2026-10-29T04:45:14Z')}));
  db.prepare('INSERT INTO review_intervals VALUES(?,?)').run('b',JSON.stringify({minutes:45,reason:'Calm',updatedAt:1}));
  const interval=new ReviewInterval(db,()=>Date.parse('2026-10-29T06:00:00Z'));const auto={autoReviewInterval:true,intervalMinutes:30,eventTolerancePct:3};
  const a=interval.get('a',auto);assert.equal(a.minutes,30,'the saved 5 minutes no longer applies');assert.match(a.reason,/no longer applies/);
  assert.equal(interval.set('a',{minutes:5,reason:'Still waiting on the presentation'},auto).status,'rejected');assert.equal(interval.get('a',auto).minutes,30,'and a refused request does not bring it back');
  assert.equal(interval.get('b',auto).minutes,45,'a longer saved interval still applies');assert.equal(interval.get('b',{...auto,intervalMinutes:60}).minutes,60,'until the user raises theirs above it');
});
