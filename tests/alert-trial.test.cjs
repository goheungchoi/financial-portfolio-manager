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
  const {t}=trial();t.check({now:t0,shadow:null,proposed:{kind:'percent',symbol:'028050'},held});t.attempt({now:t0+2*MIN,trigger:'Price movement trigger',reviewId:'R1',shadowFired:false});
  assert.equal(t.monitor({now:t0+10*MIN}),null,'answered by a review');
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
test('it completes after its trading days in each market, or after 14 calendar days',()=>{
  const {t}=trial(['KR','US']);for(let i=0;i<5;i++)t.check({now:t0+i*86400000,shadow:null,proposed:null,held,quotes:[q('028050')]});
  assert.equal(t.monitor({now:t0+4*86400000}),null,'no U.S. days yet');for(let i=0;i<5;i++)t.check({now:t0+i*86400000+12*3600000,shadow:null,proposed:null,held,quotes:[q('NASD:NVDA')]});
  assert.equal(t.monitor({now:t0+4*86400000+12*3600000}).end,'completed');
  const {t:c}=trial(['KR']);assert.equal(c.monitor({now:t0+15*86400000}).end,'completed');
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
  a.lastTrialCheck=0;try{a.tick();}catch{}
  assert.equal(a.config.alertTrial,'off');assert.equal(a.alertTrial.all()[0].status,'rolled back');assert.equal(a.alertTrial.all()[0].endReason,'held-no-review');assert.match(notes.join(' '),/Watchlist alert trial ended\. Rolled back: 028050: A held position moved/);
  a.lastPrices=new Map([['488080',26240]]);assert.equal(a.priceTrigger('s',[{symbol:'488080',price:27090,timestamp:now}],now).symbol,'488080','the current rule decides again');
  assert.equal(a.watchlistAlertsState().trial.status,'rolled back');
});
