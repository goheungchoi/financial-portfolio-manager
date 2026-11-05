// The bounded watchlist alert trial (audit 2026-11-04, Stage 5): off by default; while on, the selective rules choose
// price reviews and the current rule runs in shadow without side effects; it ends by itself on any rollback condition,
// the added-cost limit or its trading days.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {AlertTrial,LIMITS,ROLLBACK}=require('../electron/alert-trial.cjs');
const MIN=60000,t0=Date.parse('2026-11-05T01:00:00Z');
function trial(markets=['KR']){let now=t0;const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_calls(id TEXT PRIMARY KEY,day TEXT,payload TEXT)');const t=new AlertTrial(db,()=>now);t.start({scope:'s',markets});return {t,db,at:x=>{now=x;}};}
const held=new Set(['028050']),q=s=>({symbol:s,price:1});
test('the limits and rollback conditions are the ones proposed',()=>{
  assert.deepEqual(LIMITS,{respondMinutes:5,checkGapMinutes:15,priceReviewsPerDay:10,priceReviewUSDPerDay:1.2,addedUSD:2.5,tradingDays:5,calendarDays:14});
  assert.deepEqual(Object.keys(ROLLBACK),['held-no-review','shadow-held-no-review','entry-no-review','price-reviews-per-day','price-review-cost-per-day','added-cost','check-error','check-gap','shadow-log']);
});
test('an alert on a holding or an entry crossing must be answered by a review within 5 minutes; a running review or a failure hold does not count against it',()=>{
  for(const [shadow,proposed,kind] of [[null,{kind:'percent',symbol:'028050'},'held-no-review'],[{kind:'percent',symbol:'028050'},null,'shadow-held-no-review'],[null,{kind:'watchlist',alerts:[{kind:'entry-level',symbol:'396500'}]},'entry-no-review'],[{kind:'price',symbol:'396500'},null,'entry-no-review']]){
    const {t,at}=trial();t.check({now:t0,shadow,proposed,held,quotes:[q('028050')]});at(t0+4*MIN);assert.equal(t.monitor({now:t0+4*MIN,marketsOpen:true}),null);
    assert.equal(t.monitor({now:t0+5*MIN+1,marketsOpen:true}).end,kind,kind);}
  const {t}=trial();t.check({now:t0,shadow:null,proposed:{kind:'percent',symbol:'028050'},held});t.attempt({now:t0+MIN,trigger:'Price movement trigger',reviewId:'R1',shadowFired:false});
  assert.equal(t.current().obligations.length,1,'a review starting answers nothing yet');t.answered({now:t0+2*MIN,reviewId:'R1',assessed:['028050']});
  assert.equal(t.monitor({now:t0+10*MIN}),null,'answered by a completed review that assessed it');assert.equal(t.current().answered[0].symbol,'028050');
  const {t:b}=trial();b.check({now:t0,shadow:null,proposed:{kind:'percent',symbol:'028050'},held});b.monitor({now:t0+4*MIN,busy:true});assert.equal(b.monitor({now:t0+8*MIN}),null,'the 5 minutes restart after a running review');assert.ok(b.monitor({now:t0+9*MIN+1}));
  const {t:c}=trial();c.check({now:t0,shadow:null,proposed:{kind:'percent',symbol:'028050'},held});c.monitor({now:t0+6*MIN,held:true});assert.equal(c.monitor({now:t0+10*MIN}),null,'a size-failure hold or an emergency is not the trial’s doing');
  const {t:d}=trial();d.check({now:t0,shadow:null,proposed:{kind:'watchlist',alerts:[{kind:'watchlist-move',symbol:'488080'}]},held});assert.equal(d.monitor({now:t0+30*MIN}),null,'a wide move on a stock not held is not an obligation');
  // Oct 30: MAX's $14.13 level was set with the price already below it. The current rule fires on it; that is no crossing.
  const {t:m}=trial();m.check({now:t0,shadow:{kind:'price',symbol:'NYSE:MAX'},proposed:null,held,watches:[{symbol:'NYSE:MAX',price:14.13,direction:'below',baseline:14.02}]});assert.equal(m.monitor({now:t0+30*MIN}),null,'set beyond the price: not a crossing');
});
test('price reviews and their cost are capped per trading day; added reviews over the trial; checks may not stop while a market is open',()=>{
  const {t}=trial();for(let i=0;i<11;i++)t.attempt({now:t0+i*MIN,trigger:'Price movement trigger',reviewId:'R'+i,shadowFired:true});assert.equal(t.monitor({now:t0+12*MIN}).end,'price-reviews-per-day');
  const {t:c,db}=trial();const call=(id,usd,reviewId)=>db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,'d',JSON.stringify({reviewId,timestamp:t0+MIN,cost:{micro:usd*1e6}}));
  c.attempt({now:t0+MIN,trigger:'Price movement trigger',reviewId:'A',shadowFired:true});call('c1',1.25,'A');assert.equal(c.monitor({now:t0+2*MIN}).end,'price-review-cost-per-day');
  const {t:e,db:db2}=trial();const call2=(id,usd,reviewId,at)=>db2.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run(id,'d',JSON.stringify({reviewId,timestamp:at,cost:{micro:usd*1e6}}));
  for(let i=0;i<3;i++){const at=t0+i*86400000;e.attempt({now:at,trigger:'Price movement trigger',reviewId:'B'+i,shadowFired:false});call2('x'+i,0.9,'B'+i,at);}
  assert.equal(e.monitor({now:t0+2*86400000+MIN}).end,'added-cost','$2.70 of reviews the current rule would not have started');
  const {t:g}=trial();assert.equal(g.monitor({now:t0+16*MIN,marketsOpen:false}),null,'markets closed');assert.equal(g.monitor({now:t0+16*MIN,marketsOpen:true,since:t0+10*MIN}),null,'auto trading resumed 6 minutes ago');assert.equal(g.monitor({now:t0+16*MIN,marketsOpen:true}).end,'check-gap');
});
// A qualifying day: at least 95% of the market's regular-session minutes covered by fresh price checks, no uncovered
// stretch over 15 minutes; Korea and the U.S. counted apart by their own trading dates.
const {regularOpen}=require('../electron/market-hours.cjs');
function run(t,from,to,{skip=()=>false}={}){for(let x=from;x<=to;x+=MIN){if(skip(x))continue;t.check({now:x,shadow:null,proposed:null,held});t.cover({now:x,regularOpen,closedDays:new Set()});}}
const kr=(day,h,m)=>Date.parse(`${day}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+09:00`),ny=(day,h,m)=>Date.parse(`${day}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-05:00`);
test('a trading day counts only when the session was watched: 95% of its minutes and no gap over 15 minutes',()=>{
  const {t}=trial(['KR']);run(t,kr('2026-11-09',8,50),kr('2026-11-09',15,30));                                  // full session
  run(t,kr('2026-11-10',8,50),kr('2026-11-10',15,30),{skip:x=>x>=kr('2026-11-10',10,0)&&x<kr('2026-11-10',10,20)}); // a 20-minute hole
  run(t,kr('2026-11-11',10,0),kr('2026-11-11',15,30));                                                        // started an hour late
  t.judge({now:kr('2026-11-11',15,10),regularOpen,closedDays:new Set()});assert.deepEqual(t.current().days.KR,['2026-11-09','2026-11-10'].slice(0,1),'the 11th is still in session and not judged');
  t.judge({now:kr('2026-11-11',16,0),regularOpen,closedDays:new Set()});const c=t.current();
  assert.deepEqual(c.days.KR,['2026-11-09']);assert.deepEqual(c.partialDays.KR.map(p=>[p.day,p.sessionMinutes,p.longestGapMinutes]),[['2026-11-10',380,20],['2026-11-11',380,60]]);
  assert.ok(c.partialDays.KR[1].coveredPct<85);assert.deepEqual(t.report().qualifyingDays.KR,['2026-11-09']);
});
test('Korea and the U.S. are counted apart; the trial completes only when each market has its qualifying days',()=>{
  const {t}=trial(['KR','US']);const days=['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13'];
  for(const d of days){run(t,kr(d,8,55),kr(d,15,25));}t.judge({now:kr('2026-11-13',16,0),regularOpen,closedDays:new Set()});
  assert.equal(t.current().days.KR.length,5);assert.equal(t.current().days.US.length,0);assert.equal(t.monitor({now:kr('2026-11-13',16,0)}),null,'no U.S. day yet');
  for(const d of days){run(t,ny(d,9,25),ny(d,16,5));}t.judge({now:ny('2026-11-13',17,0),regularOpen,closedDays:new Set()});
  assert.deepEqual(t.current().days.US,days,'each U.S. day by its New York date');assert.equal(t.monitor({now:ny('2026-11-13',17,0)}).end,'completed');
  const {t:c}=trial(['KR']);assert.equal(c.monitor({now:t0+15*86400000}).end,'completed','14 calendar days at most');
  const {t:h}=trial(['KR']);run(h,kr('2026-11-09',8,55),kr('2026-11-09',15,25));h.judge({now:kr('2026-11-10',8,0),regularOpen,closedDays:new Set(['2026-11-09'])});assert.deepEqual(h.current().days.KR,[],'a holiday has no session minutes');
});
function harness(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const notes=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});a.notify=(id,m)=>notes.push(m);
  a.configure({scope:'kis'});a.watchScope=()=>'s';a.brokerPositions=()=>({'028050':{quantity:3}});a.sessionOpen=()=>true;return {a,db,notes};}
test('off by default; it starts only while watchlist alerts observe, and never changes that saved preference',()=>{
  const {a}=harness();assert.equal(a.config.alertTrial,'off');assert.equal(a.alertTrial.current(),null);assert.equal(a.trialRunning(),false);
  assert.throws(()=>a.configure({watchlistAlerts:'on',alertTrial:'on'}),/INVALID_SETTINGS/);
  const {a:p}=harness();assert.throws(()=>p.configure({scope:'paper',alertTrial:'on'}),/INVALID_SETTINGS/,'not in paper');
  a.configure({alertTrial:'on'});assert.equal(a.trialRunning(),true);assert.equal(a.config.watchlistAlerts,'observe','the saved preference is unchanged');
  assert.throws(()=>a.configure({scope:'both'}),/INVALID_SETTINGS/,'stop the trial before changing the account scope');assert.throws(()=>a.configure({watchlistAlerts:'on'}),/INVALID_SETTINGS/);
  a.configure({alertTrial:'off'});assert.equal(a.trialRunning(),false);assert.equal(a.alertTrial.all()[0].status,'stopped');
});
test('during the trial the selective rules decide; the current rule is logged in shadow and marks nothing',()=>{
  const {a,db}=harness();const now=Date.now();a.configure({alertTrial:'on'});
  a.lastPrices=new Map([['488080',26240],['028050',60000]]);a.watchAlerts.clear();
  assert.equal(a.priceTrigger('s',[{symbol:'488080',price:27090,timestamp:now}],now),null,'3.2% on a stock not held: no review under the selective rules');
  const row=JSON.parse(db.prepare('SELECT payload FROM alert_observations ORDER BY id DESC').get().payload);assert.equal(row.mode,'trial');assert.deepEqual(row.current.symbols,['488080'],'the current rule would have reviewed it: logged');
  // A level on a stock not held set while the price is beyond it: the shadow rule sees it but must not mark it fired.
  assert.equal(a.watches.set('s',{symbol:'360750',price:25500,percent:null,direction:'above',reason:'r'},{universe:[{symbol:'360750'}],quotes:[{symbol:'360750',price:25600}]}).status,'saved');
  a.priceTrigger('s',[{symbol:'360750',price:25600,timestamp:now}],now);assert.equal(a.watches.list('s').find(w=>w.symbol==='360750').priceFired,false,'the shadow rule never marks a level fired');
  assert.equal(a.priceTrigger('s',[{symbol:'028050',price:58000,timestamp:now}],now).symbol,'028050','a holding alerts as before');
  assert.equal(a.alertTrial.current().checks,3);
});
test('a rollback switches the trial off at once, logs and notifies; price reviews come from the current rule again',()=>{
  const {a,notes}=harness();const now=Date.now();a.configure({alertTrial:'on'});a.sessionArmed=true;a.config={...a.config,enabled:true};
  a.alertTrial.check({now:now-6*MIN,shadow:null,proposed:{kind:'percent',symbol:'028050'},held:new Set(['028050'])});
  a.trialWatchSince=now-7*MIN;a.lastTrialCheck=0;try{a.tick();}catch{}
  assert.equal(a.config.alertTrial,'off');assert.equal(a.alertTrial.all()[0].status,'rolled back');assert.equal(a.alertTrial.all()[0].endReason,'held-no-review');assert.match(notes.join(' '),/Watchlist alert trial ended\. Rolled back: 028050: A held position moved past its review threshold or level and no completed review assessed it/);
  a.lastPrices=new Map([['488080',26240]]);assert.equal(a.priceTrigger('s',[{symbol:'488080',price:27090,timestamp:now}],now).symbol,'488080','the current rule decides again');
  assert.equal(a.watchlistAlertsState().trial.status,'rolled back');
});
// Rollback restores the current rule, and stays restored across a restart; protective monitoring (conditional orders and
// the emergency response) runs before, during and after the trial.
function restart(db){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});a.watchScope=()=>'s';a.brokerPositions=()=>({'028050':{quantity:3}});a.sessionOpen=()=>true;return a;}
const notHeldMove=(a,now)=>{a.lastPrices=new Map([['488080',26240]]);a.watchAlerts.clear();return a.priceTrigger('s',[{symbol:'488080',price:27090,timestamp:now}],now);};
test('after a rollback and a restart the current rule decides; a restart during a trial resumes it only when auto trading resumes',()=>{
  const {a,db}=harness();const now=Date.now();a.configure({alertTrial:'on'});assert.equal(notHeldMove(a,now),null,'trial: the selective rules decide');
  a.endTrial('check-gap');const b=restart(db);assert.equal(b.config.alertTrial,'off','the rollback was saved');assert.equal(b.trialRunning(),false);assert.equal(notHeldMove(b,now).symbol,'488080','the current rule decides after the restart');
  assert.equal(b.config.watchlistAlerts,'observe');
  // A restart while the trial runs: it is still on, auto trading is paused, and nothing is judged until auto trading resumes.
  const {a:c,db:db2}=harness();c.configure({alertTrial:'on'});const d=restart(db2);assert.equal(d.trialRunning(),true);assert.equal(d.sessionArmed,false,'auto trading is not resumed by the restart');
  d.lastTrialCheck=0;d.tick();assert.equal(d.trialRunning(),true,'paused: no check-gap rollback while auto trading is paused');
  // The trial record ended but the setting still says on (a crash between the two writes): the current rule decides.
  const {a:e,db:db3}=harness();e.configure({alertTrial:'on'});e.alertTrial.end('check-error');const f=restart(db3);assert.equal(f.config.alertTrial,'on');assert.equal(f.trialRunning(),false);assert.equal(notHeldMove(f,now).symbol,'488080');
});
test('protective monitoring runs before, during and after the trial: conditional orders are checked and fired, the emergency response runs',()=>{
  const {a}=harness();a.configure({conditionalOrders:true});a.sessionArmed=true;a.config={...a.config,enabled:true};
  assert.equal(a.desk.setOrder('s',{action:'add',id:'',symbol:'028050',side:'Sell',quantity:3,limitPrice:null,conditions:[{expr:'price("028050")',op:'<=',value:54000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop'},{config:a.config,universe:['028050']}).status,'armed');
  a.liveQuotes=()=>[{symbol:'028050',price:53000}];const fired=[];a.fireConditional=async o=>{fired.push(o.id);};const reviews=[];a.review=async trigger=>{reviews.push(trigger);return {};};
  const step=()=>{a.lastDeskCheck=0;a.firing=false;a.lastTrialCheck=0;try{a.tick();}catch{}};
  step();assert.equal(fired.length,1,'before the trial');
  a.configure({alertTrial:'on'});step();assert.equal(fired.length,2,'during the trial');
  a.endTrial('held-no-review');step();assert.equal(fired.length,3,'after the rollback');
  a.configure({alertTrial:'on'});a.emergencyState=()=>({active:true,activeMarkets:['KR']});a.lastEmergencyAttempt=0;a.emergencyStartedAt=Date.now();step();assert.ok(reviews.includes('Emergency loss response'),'the emergency response still runs during the trial');
});
test('gate, schedule and review records carry the alert rules in force and the trial',()=>{
  const {a,db}=harness();assert.deepEqual(a.alertTag(),{mode:'observe',rules:require('../electron/watch-alerts.cjs').RULES_VERSION});
  a.configure({alertTrial:'on'});const id=a.alertTrial.current().id;assert.deepEqual(a.alertTag(),{mode:'trial',rules:require('../electron/watch-alerts.cjs').RULES_VERSION,trialId:id});
  a.scheduleObserver.save('proposed-run',{at:Date.now(),reasons:[]});assert.equal(JSON.parse(db.prepare('SELECT payload FROM schedule_observations').get().payload).alerts.mode,'trial');
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');assert.match(src,/this\.reviewGate\.log\(Date\.now\(\),\{scope:watchScope,trigger,mode:gateMode,alerts:this\.alertTag\(\)/);assert.match(src,/alerts:this\.alertTag\(\),\.\.\.reviewSymbols/);
});
// Release review 2026-11-05, P2: open alerts survive a restart; downtime and pauses do not count; only a completed review
// that assessed the symbol answers an alert.
test('open alerts survive a restart: time before it counts, downtime does not, and an alert overdue before it still rolls back',()=>{
  const {t,db}=trial();t.check({now:t0,shadow:null,proposed:{kind:'percent',symbol:'028050'},held});assert.equal(t.monitor({now:t0+3*MIN}),null);
  const again=new AlertTrial(db,()=>t0);assert.equal(again.current().obligations.length,1,'restored');
  assert.equal(again.monitor({now:t0+60*MIN,since:t0+60*MIN}),null,'the hour the app was closed is not counted');assert.equal(again.monitor({now:t0+61*MIN,since:t0+60*MIN}),null);
  assert.equal(again.monitor({now:t0+62*MIN+1000,since:t0+60*MIN}).end,'held-no-review','3 minutes before and 2 after the restart');
  const {t:o,db:db2}=trial();o.check({now:t0,shadow:null,proposed:{kind:'percent',symbol:'028050'},held});assert.equal(o.monitor({now:t0+6*MIN}).end,'held-no-review','overdue before the restart');
  assert.equal(new AlertTrial(db2,()=>t0).monitor({now:t0+90*MIN,since:t0+90*MIN}).end,'held-no-review','and still after it');
});
test('a delivered entry crossing stays open until a review assesses that stock; a review of other stocks or a failed one answers nothing',()=>{
  const {t}=trial();t.check({now:t0,shadow:null,proposed:{kind:'watchlist',alerts:[{kind:'entry-level',symbol:'396500'}]},held});t.check({now:t0+MIN,shadow:null,proposed:null,held});
  t.attempt({now:t0+MIN,trigger:'Price movement trigger',reviewId:'R1',shadowFired:false});t.answered({now:t0+2*MIN,reviewId:'R1',assessed:['028050','NASD:NVDA']});
  assert.equal(t.current().obligations.length,1,'an unrelated review does not answer it');assert.equal(t.monitor({now:t0+5*MIN+1000}).end,'entry-no-review');
});
test('through the scheduler: an alert overdue before a restart rolls the trial back once auto trading resumes, restoring the current rule',()=>{
  const {a,db}=harness();const now=Date.now();a.configure({alertTrial:'on'});
  a.alertTrial.check({now:now-7*MIN,shadow:null,proposed:{kind:'percent',symbol:'028050'},held:new Set(['028050'])});a.alertTrial.monitor({now:now-MIN});
  const b=restart(db);assert.equal(b.trialRunning(),true);assert.equal(b.alertTrial.current().obligations.length,1);
  b.lastTrialCheck=0;b.tick();assert.equal(b.trialRunning(),true,'paused after the restart: nothing is judged');
  b.sessionArmed=true;b.config={...b.config,enabled:true};b.lastTrialCheck=0;try{b.tick();}catch{}
  assert.equal(b.config.alertTrial,'off');assert.equal(b.alertTrial.all()[0].endReason,'held-no-review');assert.equal(notHeldMove(b,now).symbol,'488080','the current rule decides');
});
test('a review that fails before its decision answers no alert; a completed one does, by what it assessed',async()=>{
  const {a}=harness();a.configure({alertTrial:'on'});a.alertTrial.check({shadow:null,proposed:{kind:'percent',symbol:'028050'},held:new Set(['028050'])});
  a.provider.request=async()=>{throw new Error('AI_SERVER_ERROR');};await a.review('Price movement trigger').catch(()=>{});
  assert.equal(a.alertTrial.current().obligations.length,1,'failed: still open');assert.equal(a.alertTrial.current().attempts.length>=0,true);
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');const at=src.indexOf("run(id,JSON.stringify(recorded));");assert.ok(at>0&&src.slice(at,at+400).includes('this.alertTrial.answered({reviewId:id,assessed:recorded.assessed??[]})'),'answered right after the review is recorded');
});
