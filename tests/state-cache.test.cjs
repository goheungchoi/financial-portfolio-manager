// Lag fix L1 (artifacts/reviews/2026-11-10-lag): Automation.getState() reuses its history reads between writes, so the
// 2-second state refresh no longer rescans whole tables. Behaviour-neutral: the cached state equals the uncached one
// after each kind of write, at the same instant.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const realNow=Date.now;let now=Date.parse('2026-11-10T05:00:00Z');
test.beforeEach(()=>{now=Date.parse('2026-11-10T05:00:00Z');Date.now=()=>now;});test.afterEach(()=>{Date.now=realNow;});
function setup({routing=20,payloadBytes=200}={}){
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]);
  const a=new Automation(db,paper,{request:async()=>{throw new Error('NO_NETWORK');}},()=>{});
  const pad='t'.repeat(payloadBytes);
  for(let i=0;i<routing;i++)db.prepare('INSERT INTO routing_eval VALUES(?,?,?,?)').run('r'+i,now-i*3600000,'acct',JSON.stringify({id:'r'+i,timestamp:now-i*3600000,triage:['wording','verdict','action','size'][i%4],shadow:{usage:{micro:10+i},transcript:pad},live:{usage:{micro:100+i},transcript:pad}}));
  for(let i=0;i<5;i++)db.prepare('INSERT INTO reviews VALUES(?,?)').run('v'+i,JSON.stringify({id:'v'+i,timestamp:now-i*600000,trigger:i%2?'Price movement trigger':'Scheduled review',provider:'openai',decision:{action:'Hold',symbol:'',quantity:0},assessed:['005930']}));
  for(let i=0;i<6;i++)a.alertObservations.record(now-i*300000,{current:{kind:'holding',symbol:i%2?'005930':'NASD:NVDA',changePct:3.2},proposed:null,held:new Set(['005930']),scope:'kis:acct'});
  return {db,a};
}
// Same instant, caches on and off; compared through JSON, as the window receives it.
const compare=(a,label)=>{a.stateCacheOff=false;a.getState();const cached=JSON.parse(JSON.stringify(a.getState()));a.stateCacheOff=true;const plain=JSON.parse(JSON.stringify(a.getState()));a.stateCacheOff=false;
  for(const k of new Set([...Object.keys(cached),...Object.keys(plain)]))assert.deepEqual(cached[k],plain[k],`${label}: ${k}`);return cached;};
// Counts statements prepared against a table between two points.
const spy=db=>{const seen=[];const prep=db.prepare.bind(db);db.prepare=sql=>{seen.push(sql);return prep(sql);};return {count:re=>seen.filter(s=>re.test(s)).length,reset:()=>seen.length=0};};

test('L1: the cached state equals the uncached one, warm and after each kind of write',()=>{
  const {db,a}=setup();let s=compare(a,'warm');assert.equal(s.tokenSaving.shadow.pairs,20);
  db.prepare('INSERT INTO routing_eval VALUES(?,?,?,?)').run('new',now,'acct',JSON.stringify({id:'new',timestamp:now,triage:'symbol',shadow:{usage:{micro:1}},live:{usage:{micro:2}}}));
  s=compare(a,'routing_eval insert');assert.equal(s.tokenSaving.shadow.pairs,21,'the new row is counted');assert.equal(s.tokenSaving.shadow.byTriage.symbol,1);
  db.prepare('UPDATE routing_eval SET payload=? WHERE id=?').run(JSON.stringify({id:'new',timestamp:now,triage:'verdict',shadow:{usage:{micro:1}},live:{usage:{micro:2}}}),'new');
  s=compare(a,'routing_eval update');assert.equal(s.tokenSaving.shadow.byTriage.symbol,undefined,'an update in place is seen');
  db.prepare('INSERT INTO reviews VALUES(?,?)').run('v9',JSON.stringify({id:'v9',timestamp:now,trigger:'User request',provider:'openai',decision:{action:'Hold',symbol:'',quantity:0}}));
  s=compare(a,'review insert');assert.equal(s.allReviews[0]?.id,'v9','the newest review is listed');
  a.alertObservations.record(now,{current:{kind:'holding',symbol:'005930',changePct:4},proposed:{kind:'holding',symbol:'005930',changePct:4},held:new Set(['005930']),scope:'kis:acct'});
  s=compare(a,'alert observation');assert.equal(s.watchlistAlerts.summary.checks.proposed,1);
  a.newsEvents.add?.({id:'n1',title:'Headline',symbol:'005930',url:'https://example.test/n1',published:new Date(now).toISOString(),source:'fixture'});compare(a,'news event');
  db.prepare("INSERT INTO auto_order_slots VALUES(?,?,?)").run('slot1',new Date(now+9*3600000).toISOString().slice(0,10),JSON.stringify({id:'slot1',ref:'conditional:x',state:'reserved',source:'conditional'}));
  s=compare(a,'auto order slot');assert.equal(s.guardrails.autoOrdersToday,1);
  a.configure({eventTolerancePct:2.5});s=compare(a,'settings change');assert.equal(s.watchlistAlerts.holdingPct,2.5);
  db.prepare('DELETE FROM routing_eval WHERE id=?').run('new');s=compare(a,'delete');assert.equal(s.tokenSaving.shadow.pairs,20);
});
test('L1: without a write, a second call reads no history table; a write or the next minute reads it again',()=>{
  const {db,a}=setup();a.getState();const s=spy(db);
  a.getState();assert.equal(s.count(/FROM routing_eval/),0,'routing_eval not read');assert.equal(s.count(/FROM alert_observations/),0);assert.equal(s.count(/FROM news_events/),0);assert.equal(s.count(/FROM reviews ORDER BY rowid DESC/),0);assert.equal(s.count(/SELECT payload FROM reviews$/),0,'the learning sync does not rescan reviews');
  s.reset();db.prepare('INSERT INTO reviews VALUES(?,?)').run('w1',JSON.stringify({id:'w1',timestamp:now,provider:'openai'}));a.getState();assert.ok(s.count(/FROM routing_eval/)>=1,'a write makes it read again');
  s.reset();a.getState();assert.equal(s.count(/FROM routing_eval/),0);
  s.reset();now+=60000;a.getState();assert.ok(s.count(/FROM routing_eval/)>=1,'the next minute reads again');
  // Another account scope never sees this scope's cached values.
  s.reset();a.watchScope=()=>'both:other';a.getState();assert.ok(s.count(/FROM routing_eval/)>=1,'a new scope reads again');
});
test('L1: the shadow totals read four fields, equal to parsing whole payloads (missing and null triage kept apart)',()=>{
  const {db,a}=setup({routing:6});
  db.prepare('INSERT INTO routing_eval VALUES(?,?,?,?)').run('m',now,'acct',JSON.stringify({id:'m',timestamp:now,shadow:{usage:{}},live:{}}));
  db.prepare('INSERT INTO routing_eval VALUES(?,?,?,?)').run('n',now,'acct',JSON.stringify({id:'n',timestamp:now,triage:null,shadow:{usage:{micro:5}},live:{usage:{micro:7}}}));
  const {seoulDate}=require('../electron/kis-activity.cjs');const rows=db.prepare('SELECT payload FROM routing_eval ORDER BY timestamp DESC LIMIT 2000').all().map(r=>JSON.parse(r.payload));const by={};for(const r of rows)by[r.triage]=(by[r.triage]??0)+1;const today=seoulDate();
  const old={pairs:rows.length,today:rows.filter(r=>seoulDate(r.timestamp)===today).length,byTriage:by,candidates:rows.filter(r=>['action','symbol','size','verdict'].includes(r.triage)).length,shadowMicro:rows.reduce((x,r)=>x+(r.shadow.usage?.micro??0),0),liveMicro:rows.reduce((x,r)=>x+(r.live.usage?.micro??0),0)};
  assert.deepEqual(a.routingEvalUncached(),old);assert.equal(old.byTriage.undefined,1);assert.equal(old.byTriage.null,1);
});
test('L1: the learning sync runs again only after a write or in the next minute; quote observations run every time',()=>{
  const {db,a}=setup();let syncs=0,observes=0;const sync=a.outcomes.sync.bind(a.outcomes);a.outcomes.sync=()=>{syncs++;return sync();};const observe=a.trials.observe.bind(a.trials);a.trials.observe=(...x)=>{observes++;return observe(...x);};
  a.getState();a.getState();a.getState();assert.equal(syncs,1);assert.ok(observes>=3);
  db.prepare('INSERT INTO paper_fills(id,payload) VALUES(?,?)').run('f1',JSON.stringify({id:'f1'}));a.getState();assert.equal(syncs,2,'after a write');
  now+=60000;a.getState();assert.equal(syncs,3,'in the next minute');
  a.stateCacheOff=true;a.getState();assert.equal(syncs,4,'off: every call');
});
test('L1: the shared date formatters give the same days as building one per call',()=>{
  const {sessionOf}=require('../electron/watch-alerts.cjs');const {seoulDate}=require('../electron/kis-activity.cjs');
  for(let t=Date.parse('2026-03-07T00:00:00Z');t<Date.parse('2026-11-10T00:00:00Z');t+=3*3600000+17*60000){
    assert.equal(sessionOf('US',t),new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(t)));assert.equal(sessionOf('KR',t),new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date(t)));
    const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(t)),v=k=>p.find(x=>x.type===k).value;assert.equal(seoulDate(t),`${v('year')}-${v('month')}-${v('day')}`);}
});
test('L1: timing guard: 500 shadow rows of 50 KB; a warm getState stays fast and reads no history',()=>{
  const {db,a}=setup({routing:500,payloadBytes:25000});const t0=realNow();a.getState();const cold=realNow()-t0;
  const s=spy(db);const t1=realNow();for(let i=0;i<5;i++)a.getState();const warm=(realNow()-t1)/5;
  assert.equal(s.count(/FROM routing_eval/),0);assert.ok(warm<60,`warm ${warm.toFixed(1)} ms (cold ${cold.toFixed(0)} ms)`);
});
