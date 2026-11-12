// The start notice (restart part 1, step 2): on a start after the app stopped, when stop orders are armed or auto trading
// was running, it says that trading is paused, how many stops are not watched, and how the app last stopped. Also the
// best-effort phone message when Windows ends the session, and the armed-stop count (the watched account's unexpired
// stop-loss orders only; without a known account, no number).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {stopSentence,startNotice,sessionEndMessage,armedStops}=require('../electron/start-notice.cjs');
const {ExitRecord,lastStop}=require('../electron/exit-record.cjs');
const AT=Date.parse('2026-11-11T16:29:22Z');// 01:29 KST on 11-12
const NOW=Date.parse('2026-11-11T23:56:00Z');// 08:56 KST, same Seoul day
const S=n=>({count:n,any:n>0}),UNKNOWN={count:null,any:true},NONE={count:null,any:false};

test('how the app last stopped, in one sentence, with the KST time (and the date when it was another day)',()=>{
  assert.equal(stopSentence({kind:'windows-shutdown',at:AT},NOW),'The app was closed by a Windows restart or shutdown at 01:29.');
  assert.equal(stopSentence({kind:'unexpected',at:AT},NOW),'The app stopped unexpectedly after 01:29.');
  assert.equal(stopSentence({kind:'clean',at:AT},NOW),'The app was closed at 01:29.','"closed", not "you closed it"');
  assert.equal(stopSentence({kind:'windows-shutdown',at:AT},NOW+2*86400000),'The app was closed by a Windows restart or shutdown at 12 Nov, 01:29.');
  assert.equal(stopSentence({kind:'unexpected',at:AT,timeUncertain:true},NOW),'The app stopped unexpectedly after about 01:29.');
  assert.equal(stopSentence({kind:'unexpected',at:null},NOW),'The app stopped unexpectedly.');assert.equal(stopSentence(null),null);
});
test('the notice: the plan\'s sentence with the stop reason in front; title for Home',()=>{
  const n=startNotice({previousStop:{kind:'windows-shutdown',at:AT},stops:S(5),wasRunning:true,now:NOW});
  assert.equal(n.message,'The app was closed by a Windows restart or shutdown at 01:29. The app started and auto trading is paused. 5 stop orders are not being watched. Open the app and press Start auto trading.');
  assert.equal(n.title,'Paused: 5 stop orders not watched');
  const one=startNotice({previousStop:{kind:'clean',at:AT},stops:S(1),wasRunning:false,now:NOW});assert.match(one.message,/ 1 stop order is not being watched\. /);assert.equal(one.title,'Paused: 1 stop order not watched');
  const running=startNotice({previousStop:{kind:'unexpected',at:AT},stops:S(0),wasRunning:true,now:NOW});
  assert.equal(running.message,'The app stopped unexpectedly after 01:29. The app started and auto trading is paused. Open the app and press Start auto trading.');assert.equal(running.title,'Auto trading paused after a restart');
});
test('the account not known: "stop orders" without a number, in the notice, the title and the shutdown message',()=>{
  const n=startNotice({previousStop:{kind:'windows-shutdown',at:AT},stops:UNKNOWN,wasRunning:false,now:NOW});
  assert.equal(n.message,'The app was closed by a Windows restart or shutdown at 01:29. The app started and auto trading is paused. Stop orders are not being watched. Open the app and press Start auto trading.');
  assert.equal(n.title,'Paused: stop orders not watched');
  assert.equal(sessionEndMessage({stops:UNKNOWN,running:false}),'Windows is closing the app (restart or shutdown). Stop orders will not be watched until you open it again.');
  assert.equal(startNotice({previousStop:{kind:'clean',at:AT},stops:NONE,wasRunning:false,now:NOW}),null,'unknown account and no armed stop anywhere: no notice');
});
test('no notice on a first start, or when nothing is armed and auto trading was not running',()=>{
  assert.equal(startNotice({previousStop:null,stops:S(5),wasRunning:true,now:NOW}),null);
  assert.equal(startNotice({previousStop:{kind:'clean',at:AT},stops:S(0),wasRunning:false,now:NOW}),null);
});
test('the shutdown phone message: stops counted, or auto trading running; nothing when neither',()=>{
  assert.equal(sessionEndMessage({stops:S(5),running:true}),'Windows is closing the app (restart or shutdown). 5 stop orders will not be watched until you open it again.');
  assert.equal(sessionEndMessage({stops:S(1),running:false}),'Windows is closing the app (restart or shutdown). 1 stop order will not be watched until you open it again.');
  assert.equal(sessionEndMessage({stops:S(0),running:true}),'Windows is closing the app (restart or shutdown). Auto trading stops until you open it again and press Start.');
  assert.equal(sessionEndMessage({stops:S(0),running:false}),null);
});
function table(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE conditional_orders(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)');
  const add=(id,scope,status,purpose,expiresAt=NOW+86400000)=>db.prepare('INSERT INTO conditional_orders VALUES(?,?,?,?)').run(id,scope,status,JSON.stringify({id,purpose,expiresAt}));return {db,add};}
test('armed stops: only the watched account\'s unexpired stop-loss orders count (review of step 2)',()=>{
  const {db,add}=table();
  add('a','both:LIVE','armed','stop_loss');add('b','both:LIVE','armed','stop_loss');
  add('x','both:LIVE','armed','stop_loss',NOW-60000);// past its expiry, still marked armed: expiry is applied lazily per scope
  add('m','both:MOCK','armed','stop_loss');// a second account (the mock one)
  add('p','paper','armed','stop_loss');add('t','both:LIVE','armed','take_profit');add('c','both:LIVE','cancelled','stop_loss');
  db.prepare('INSERT INTO conditional_orders VALUES(?,?,?,?)').run('d','both:LIVE','armed','{damaged');
  assert.deepEqual(armedStops(db,{scope:'both:LIVE',now:NOW}),{count:2,any:true},'the expired row and the other account\'s row are left out');
  assert.deepEqual(armedStops(db,{scope:'both:MOCK',now:NOW}),{count:1,any:true});
  assert.deepEqual(armedStops(db,{scope:'both:OTHER',now:NOW}),{count:0,any:false});
});
test('armed stops without a known account: no number; "any" says whether unexpired stops exist in an account scope',()=>{
  const {db,add}=table();add('x','both:LIVE','armed','stop_loss',NOW-60000);add('p','paper','armed','stop_loss');
  assert.deepEqual(armedStops(db,{scope:null,now:NOW}),{count:null,any:false},'only an expired one and a paper one');
  add('a','both:LIVE','armed','stop_loss');assert.deepEqual(armedStops(db,{scope:'both:disconnected',now:NOW}),{count:null,any:true});
  assert.deepEqual(armedStops(new DatabaseSync(':memory:'),{scope:'both:LIVE',now:NOW}),{count:null,any:false},'no table: never throws');
});
test('the exit record keeps the watched account scope from the heartbeat; the next start reads it',()=>{
  const db=new DatabaseSync(':memory:');let r=new ExitRecord(db,()=>AT-120000);r.begin();r.heartbeat('both:disconnected');assert.equal(r.read().scope,undefined,'a disconnected scope is not kept');
  r.heartbeat('both:LIVE');r.heartbeat(null);assert.equal(r.read().scope,'both:LIVE','a later missing scope keeps the last known one');
  r.stop('windows-shutdown',['shutdown']);r=new ExitRecord(db,()=>NOW);assert.equal(lastStop(r.begin(),NOW).scope,'both:LIVE');
});
test('the shutdown phone alert confirmed sent is kept on the record and read back',()=>{
  const db=new DatabaseSync(':memory:');let r=new ExitRecord(db,()=>AT);r.begin();r.stop('windows-shutdown',['shutdown']);assert.equal(r.markPhoneSent(),true);
  r=new ExitRecord(db,()=>NOW);assert.deepEqual(lastStop(r.begin(),NOW),{kind:'windows-shutdown',at:AT,reasons:['shutdown'],phoneSent:true});
  assert.equal(new ExitRecord(new DatabaseSync(':memory:'),()=>AT).markPhoneSent(),false,'no run, no stop: nothing to mark');
});
test('main.cjs wiring: the notice once per start for the last run\'s account; the Home item until Start or Dismiss; the phone alert after the row, never waited on',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(src,/restartNotice=N\.startNotice\(\{previousStop,stops:N\.armedStops\(store\.db,\{scope:previousStop\?\.scope\?\?null\}\),wasRunning:Boolean\(automation\.config\.enabled&&automation\.config\.autoSubmit\)\}\)/);
  assert.match(src,/exitRecord\.heartbeat\(scope\);\},60000\)\.unref\(\)/);
  assert.match(src,/const id='restart-notice:'\+\(exitRecord\?\.current\?\.startedAt\?\?Date\.now\(\)\);setTimeout\(\(\)=>\{try\{notifier\.notify\(id,restartNotice\.message\);\}catch\{\}\},3000\);/);
  assert.match(src,/if\(restartNotice&&!restartNoticeDismissed&&!require\('\.\/auto-launch\.cjs'\)\.launchState\(automation\)\.running\)items\.push\(\{id:'restart-notice'/);
  const i=src.indexOf("win.on('session-end'"),j=src.indexOf("exitRecord?.stop('windows-shutdown',event?.reasons);",i),k=src.indexOf("providerService.request('push'",i);
  assert.ok(i>0&&j>i&&k>j,'the row is written before the phone send');assert.match(src.slice(i,k+200),/N\.armedStops\(store\.db,\{scope\}\)/,'the watched account at that moment');
  assert.match(src.slice(i,k+200),/void Promise\.resolve\(providerService\.request\('push',\{message\}\)\)/,'not awaited');
});
