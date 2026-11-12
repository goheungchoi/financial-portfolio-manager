// How the app last stopped (restart part 1, step 1): a clean quit, a Windows session end and a stop with no word are told
// apart on the next start; a first start has no record; a clock that moved backwards is flagged; nothing ever throws.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {ExitRecord,lastStop}=require('../electron/exit-record.cjs');
const T=Date.parse('2026-11-11T16:29:00Z');// 01:29 KST
function run(db,clock){const r=new ExitRecord(db,()=>clock.now);return r;}

test('first start: no record, so no stop to tell; the run is recorded',()=>{
  const db=new DatabaseSync(':memory:');const clock={now:T};const r=run(db,clock);
  assert.equal(r.begin(),null);assert.equal(lastStop(null),null);
  assert.deepEqual(r.read(),{startedAt:T,heartbeatAt:T,stop:null});
});
test('a clean quit by the user: "clean" at the quit time',()=>{
  const db=new DatabaseSync(':memory:');const clock={now:T};let r=run(db,clock);r.begin();clock.now=T+120000;r.heartbeat();clock.now=T+150000;assert.equal(r.stop('clean'),true);
  clock.now=T+3600000;r=run(db,clock);const prev=r.begin();assert.deepEqual(lastStop(prev,clock.now),{kind:'clean',at:T+150000});
});
test('Windows ends the session: "windows-shutdown" with Windows\' reasons; the quit that follows does not overwrite it',()=>{
  const db=new DatabaseSync(':memory:');const clock={now:T};let r=run(db,clock);r.begin();clock.now=T+22000;
  r.stop('windows-shutdown',['shutdown','critical']);clock.now=T+23000;r.stop('clean');assert.equal(r.heartbeat(),false,'no heartbeat after a stop');
  clock.now=T+8*3600000;r=run(db,clock);assert.deepEqual(lastStop(r.begin(),clock.now),{kind:'windows-shutdown',at:T+22000,reasons:['shutdown','critical']});
});
test('a stop with no word (crash, kill, power loss): "unexpected" at the last heartbeat',()=>{
  const db=new DatabaseSync(':memory:');const clock={now:T};let r=run(db,clock);r.begin();for(let i=1;i<=3;i++){clock.now=T+i*60000;r.heartbeat();}
  clock.now=T+7*3600000;r=run(db,clock);assert.deepEqual(lastStop(r.begin(),clock.now),{kind:'unexpected',at:T+180000});
  assert.deepEqual(lastStop({startedAt:T},T+1),{kind:'unexpected',at:T},'no heartbeat yet: the start time');
});
test('a clock that moved backwards: the time is kept as recorded and flagged, the kind is unchanged',()=>{
  const db=new DatabaseSync(':memory:');const clock={now:T};let r=run(db,clock);r.begin();clock.now=T+60000;r.heartbeat();
  clock.now=T-3600000;r=run(db,clock);const s=lastStop(r.begin(),clock.now);assert.deepEqual(s,{kind:'unexpected',at:T+60000,timeUncertain:true});
  assert.deepEqual(lastStop({stop:{kind:'clean',at:T+5}},T),{kind:'clean',at:T+5,timeUncertain:true});
});
test('nothing throws: a damaged row, an unknown stop kind, and a database that cannot be written',()=>{
  const db=new DatabaseSync(':memory:');const r=run(db,{now:T});db.exec('CREATE TABLE IF NOT EXISTS app_exit(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');db.prepare('INSERT INTO app_exit VALUES(1,?)').run('{damaged');
  assert.equal(r.begin(),null,'a damaged record reads as none (a first start)');
  assert.deepEqual(lastStop({heartbeatAt:T,stop:{kind:'reboot',at:T+1}},T+9),{kind:'unexpected',at:T},'an unknown kind is not trusted');
  assert.equal(r.stop('reboot'),false);
  const broken={exec(){throw new Error('SQLITE_IOERR');},prepare(){throw new Error('SQLITE_IOERR');}};const b=new ExitRecord(broken,()=>T);
  assert.doesNotThrow(()=>{assert.equal(b.begin(),null);assert.equal(b.heartbeat(),false);assert.equal(b.stop('clean'),false);});
});
test('main.cjs: the session-end handlers write the row and never hold Windows back; the clean quit is recorded in will-quit',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(src,/win\.on\('query-session-end',event=>\{try\{exitRecord\?\.stop\('windows-shutdown',event\?\.reasons,true\);\}catch\{\}\}\);/,'the question writes a tentative stop');
  assert.match(src,/win\.on\('session-end',event=>\{try\{exitRecord\?\.stop\('windows-shutdown',event\?\.reasons\);\}catch\{\}/,'the end confirms it (the phone alert follows, in step 2)');
  assert.ok(!/session-end[^\n]*preventDefault/.test(src),'no preventDefault on a session end');
  assert.match(src,/app\.on\('will-quit', \(\) => \{\r?\n  try\{exitRecord\?\.stop\('clean'\);\}catch\{\}/);
  assert.match(src,/setInterval\(\(\)=>\{let scope=null;try\{scope=automation\?\.watchScope\(\);\}catch\{\}exitRecord\.heartbeat\(scope\);\},60000\)\.unref\(\)/,'every 60 s, with the watched account scope (step 2 review)');
});

// Review change: query-session-end is a question; the shutdown can still be cancelled.
test('query, then session-end: a confirmed Windows shutdown, at the session-end time, with the reasons',()=>{
  const db=new DatabaseSync(':memory:');const clock={now:T};let r=run(db,clock);r.begin();clock.now=T+20000;r.stop('windows-shutdown',['shutdown'],true);
  assert.equal(r.read().stop.tentative,true);clock.now=T+21000;r.stop('windows-shutdown',['shutdown']);assert.equal(r.read().stop.tentative,undefined);
  clock.now=T+60000;assert.equal(r.heartbeat(),false,'no heartbeat after a confirmed stop');
  clock.now=T+3600000;r=run(db,clock);assert.deepEqual(lastStop(r.begin(),clock.now),{kind:'windows-shutdown',at:T+21000,reasons:['shutdown']});
});
test('query, then a heartbeat (the shutdown was cancelled), then a clean quit: recorded clean',()=>{
  const db=new DatabaseSync(':memory:');const clock={now:T};let r=run(db,clock);r.begin();clock.now=T+20000;r.stop('windows-shutdown',['shutdown'],true);
  clock.now=T+60000;assert.equal(r.heartbeat(),true,'the heartbeat clears the tentative stop');assert.equal(r.read().stop,null);
  clock.now=T+90000;r.stop('clean');clock.now=T+3600000;r=run(db,clock);assert.deepEqual(lastStop(r.begin(),clock.now),{kind:'clean',at:T+90000});
});
test('query alone and nothing more: still reported as a Windows shutdown; a clean quit right after it does not replace it',()=>{
  const db=new DatabaseSync(':memory:');const clock={now:T};let r=run(db,clock);r.begin();clock.now=T+20000;r.stop('windows-shutdown',['critical'],true);
  clock.now=T+21000;r.stop('clean');assert.equal(r.read().stop.kind,'windows-shutdown');
  clock.now=T+8*3600000;r=run(db,clock);assert.deepEqual(lastStop(r.begin(),clock.now),{kind:'windows-shutdown',at:T+20000,reasons:['critical']});
});
