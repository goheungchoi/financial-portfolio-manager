const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {WatchAlerts,AlertObservations,COOLDOWN_MS}=require('../electron/watch-alerts.cjs');
const t0=Date.parse('2026-10-29T00:00:00Z'),min=n=>t0+n*60000;const q=(symbol,price,at)=>({symbol,price,timestamp:at});
const run=(a,quotes,{held=[],baselines=new Map(),watches=[],now=quotes[0]?.timestamp??t0}={})=>{const r=a.check({quotes,held:new Set(held),baselines,watches,tolerance:3,wide:6,now});r.deliver();return r.trigger;};

test('holdings keep the price move trigger from the last review price',()=>{
  const a=new WatchAlerts();const base=new Map([['028050',60000]]);
  assert.equal(run(a,[q('028050',61500,min(1))],{held:['028050'],baselines:base}),null,'2.5%');
  const t=run(a,[q('028050',58100,min(2))],{held:['028050'],baselines:base});assert.equal(t.kind,'percent');assert.equal(t.symbol,'028050');
  assert.equal(run(a,[q('028050',59000,min(3))],{held:['028050'],baselines:base,watches:[{symbol:'028050',percent:1.5,baseline:60000}]}).threshold,1.5,'the AI percent still applies');
  assert.equal(run(a,[q('028050',54000,min(4))],{held:['028050'],baselines:base,watches:[{symbol:'028050',price:54500,direction:'below',baseline:60000}]}).kind,'price');
});

test('a 3-4% move in a watchlist ETF no longer starts a review; 6% does, once, then needs a new 6% move',()=>{
  // 2026-10-29: 488080 (not held) started reviews at +3.2%, -3.7% and +3.1%.
  const a=new WatchAlerts();const base=new Map([['488080',26240]]);
  for(const [p,at] of [[27090,5],[26525,40],[25535,63],[24870,118]])assert.equal(run(a,[q('488080',p,min(at))],{baselines:base}),null,`${p}`);
  const up=run(a,[q('488080',27900,min(130))],{baselines:base});assert.equal(up.kind,'watchlist');assert.equal(up.alerts[0].kind,'watchlist-move');assert.equal(Math.round(up.alerts[0].changePct*10)/10,6.3);
  assert.equal(run(a,[q('488080',28000,min(135))],{baselines:new Map([['488080',27000]])}),null,'staying beyond the threshold, whatever the review prices');
  assert.equal(run(a,[q('488080',29700,min(150))]),null,'another 6% within the hour waits');
  const again=run(a,[q('488080',29700,min(130)+COOLDOWN_MS)]);assert.equal(again.alerts[0].baseline,27900,'measured from the last alert');
});

test('simultaneous watchlist alerts go into one review; a holding move carries them along',()=>{
  const a=new WatchAlerts();const base=new Map([['462330',874],['488080',26240],['005930',100000]]);
  const t=run(a,[q('462330',800,min(1)),q('488080',24000,min(1))],{baselines:base});assert.equal(t.kind,'watchlist');assert.deepEqual(t.alerts.map(x=>x.symbol),['462330','488080']);
  const b=new WatchAlerts();const both=run(b,[q('462330',800,min(1)),q('005930',96000,min(1))],{held:['005930'],baselines:base});assert.equal(both.symbol,'005930');assert.deepEqual(both.alongside.map(x=>x.symbol),['462330']);
});

test('an entry level starts a review only when the price crosses it, once',()=>{
  // 2026-10-28: a 360750 level "above 25,500" fired at 25,655 on the first check.
  const a=new WatchAlerts();const watch={symbol:'360750',price:25500,direction:'above',baseline:25655,priceFired:false};const r=(p,at)=>{const x=a.check({quotes:[q('360750',p,min(at))],held:new Set(),baselines:new Map(),watches:[watch],tolerance:3,wide:6,now:min(at)});return {t:x.trigger,fired:x.deliver()};};
  assert.equal(r(25655,1).t,null,'set while already beyond it');assert.equal(r(25700,2).t,null);assert.equal(r(25400,3).t,null,'back below: armed');
  const hit=r(25520,4);assert.equal(hit.t.alerts[0].kind,'entry-level');assert.deepEqual(hit.fired,['360750'],'reported so the watch is marked fired');
  assert.equal(r(30000,5).t,null,'no 6% alert while an entry level is the condition');
  const fresh=new WatchAlerts();assert.equal(fresh.check({quotes:[q('NASD:AMZN',254.9,min(1))],held:new Set(),baselines:new Map(),watches:[{symbol:'NASD:AMZN',price:255,direction:'below',baseline:258}],tolerance:3,wide:6,now:min(1)}).trigger.alerts[0].kind,'entry-level','set above the level: crossing below fires');
});

test('observation counts avoided reviews and when alerts on stocks not held came under the new rules',()=>{
  const o=new AlertObservations(new DatabaseSync(':memory:'));const held=new Set(['NASD:GOOGL']);const pct=(symbol,changePct)=>({kind:'percent',symbol,changePct});
  o.record(min(5),{current:pct('488080',3.2),proposed:null,held});o.record(min(63),{current:pct('488080',-3.7),proposed:null,held});
  o.record(min(70),{current:pct('462330',-3.2),proposed:null,held});o.record(min(90),{current:null,proposed:{kind:'watchlist',alerts:[{symbol:'462330'}]},held});
  o.record(min(100),{current:pct('NASD:GOOGL',9.8),proposed:pct('NASD:GOOGL',9.8),held});o.record(min(101),{current:null,proposed:null,held});
  const s=o.summary(t0);assert.equal(s.currentReviews,4);assert.equal(s.proposedReviews,2);assert.equal(s.avoided,2);
  assert.deepEqual(s.notHeldAlerts.map(x=>[x.symbol,x.delayMinutes]),[['488080',null],['462330',20]]);assert.equal(s.delayed,1);assert.equal(s.notAlerted,1);
});

test('the scheduler: off keeps the one rule, observe keeps it and logs the new rules, on uses the new rules',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.watchScope=()=>'s';a.brokerPositions=()=>({'028050':{quantity:3}});a.sessionOpen=()=>true;const now=Date.now();
  const quotes=[{symbol:'488080',price:27090,timestamp:now}];const reset=()=>{a.lastPrices=new Map([['488080',26240],['028050',60000]]);a.watchAlerts.clear();};
  assert.equal(a.config.watchlistAlerts,'observe','observing by default');
  a.configure({watchlistAlerts:'off'});reset();assert.equal(a.priceTrigger('s',quotes,now).symbol,'488080');assert.equal(db.prepare('SELECT COUNT(*) n FROM alert_observations').get().n,0);
  a.configure({watchlistAlerts:'observe'});reset();assert.equal(a.priceTrigger('s',quotes,now).symbol,'488080','the current rule still decides');
  const row=JSON.parse(db.prepare('SELECT payload FROM alert_observations').get().payload);assert.deepEqual(row.current.symbols,['488080']);assert.equal(row.proposed,null);
  a.configure({watchlistAlerts:'on'});reset();assert.equal(a.priceTrigger('s',quotes,now),null,'3.2% on a stock not held');
  assert.equal(a.priceTrigger('s',[{symbol:'028050',price:58000,timestamp:now}],now).symbol,'028050','a holding still alerts at 3%');
  a.sessionOpen=()=>false;reset();assert.equal(a.priceTrigger('s',[{symbol:'488080',price:30000,timestamp:now}],now),null,'only in an open session');
  assert.throws(()=>a.configure({watchlistAlerts:'loud'}),/INVALID_SETTINGS/);assert.throws(()=>a.configure({watchlistMovePct:0}),/INVALID_SETTINGS/);
  assert.equal(a.watchlistAlertsState().watchlistPct,6);a.configure({watchlistMovePct:8});assert.equal(a.watchlistAlertsState().watchlistPct,8);
});
test('through the scheduler: checks without an alert still record which side of a level the price is on',()=>{
  // Review P2 (1.5.41): with the rules on, sides were saved only when something alerted, so "above 25,500" set at 25,655
  // never fired after 25,400 then 25,520.
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.watchScope=()=>'s';a.brokerPositions=()=>({});a.sessionOpen=()=>true;a.configure({watchlistAlerts:'on'});const now=Date.now();
  a.watches.set('s',{symbol:'360750',percent:null,price:25500,direction:'above',reason:'Entry above 25,500'},{universe:[{symbol:'360750'}],quotes:[{symbol:'360750',price:25655}]});
  const at=(price,i)=>a.priceTrigger('s',[{symbol:'360750',price,timestamp:now+i*60000}],now+i*60000);
  assert.equal(at(25655,0),null,'set while already above it');assert.equal(at(25400,1),null,'back below, nothing to alert');
  const hit=at(25520,2);assert.equal(hit?.alerts?.[0]?.kind,'entry-level');assert.equal(a.watches.list('s')[0].priceFired,true,'delivered: the level is fired');
  assert.equal(at(25400,3),null);assert.equal(at(25600,4),null,'once');
});
test('observation: both rules read the level as it was before the check, with their own record of what fired',()=>{
  // Review P2 (1.5.41): the rule in force marked the level fired before the selective rules read it, so the log showed
  // current: price and proposed: null for a crossing both rules saw.
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.watchScope=()=>'s';a.brokerPositions=()=>({'NASD:GOOGL':{quantity:1}});a.sessionOpen=()=>true;const now=Date.now();
  const rows=()=>db.prepare('SELECT payload FROM alert_observations ORDER BY id').all().map(r=>JSON.parse(r.payload));
  const set=(symbol,price,direction,quote)=>a.watches.set('s',{symbol,percent:null,price,direction,reason:'r'},{universe:[{symbol}],quotes:[{symbol,price:quote}]});
  const at=(symbol,price,i)=>a.priceTrigger('s',[{symbol,price,timestamp:now+i*60000}],now+i*60000);
  set('360750',25500,'above',25400);assert.equal(at('360750',25520,0)?.kind,'price','the rule in force decides');
  assert.deepEqual(rows()[0],{current:{kind:'price',symbols:['360750']},proposed:{kind:'watchlist',symbols:['360750']},currentHeld:false},'a crossing both rules see');
  assert.equal(at('360750',25400,1),null);assert.equal(at('360750',25600,2),null);assert.equal(rows().length,1,'fired once under each rule');
  set('360750',25500,'above',25655);assert.equal(at('360750',25655,3)?.kind,'price');assert.equal(rows()[1].proposed,null,'already above when set: no crossing');
  assert.equal(at('360750',25400,4),null);assert.equal(at('360750',25520,5),null,'the rule in force fired it already');
  assert.deepEqual(rows()[2],{current:null,proposed:{kind:'watchlist',symbols:['360750']},currentHeld:null},'the selective rule still sees the crossing');
  set('NASD:GOOGL',280,'below',285);assert.equal(at('NASD:GOOGL',279,6)?.kind,'price');assert.equal(rows()[3].proposed.kind,'price','a holding level: the same under both');
  a.watchAlerts.clear();assert.equal(at('NASD:GOOGL',278,7),null);assert.equal(rows().length,4,'fired earlier by the rule in force: not again after a restart');
});
test('observation: a review moving a level’s baseline does not make it a new level',()=>{
  // Review P2 (2b2c1cd): the level was named by its baseline, which every review rebases, so it fired again after one.
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.watchScope=()=>'s';a.brokerPositions=()=>({});a.sessionOpen=()=>true;const now=Date.now();const count=()=>db.prepare('SELECT COUNT(*) n FROM alert_observations').get().n;
  a.watches.set('s',{symbol:'360750',percent:null,price:25500,direction:'above',reason:'r'},{universe:[{symbol:'360750'}],quotes:[{symbol:'360750',price:25400}]});
  const at=(price,i)=>a.priceTrigger('s',[{symbol:'360750',price,timestamp:now+i*60000}],now+i*60000);
  at(25520,0);assert.equal(count(),1);a.watches.rebase('s',[{symbol:'360750',price:25520}]);
  at(25400,1);at(25600,2);assert.equal(count(),1,'no second entry alert after the review');
  a.watches.set('s',{symbol:'360750',percent:null,price:25500,direction:'above',reason:'set again'},{universe:[{symbol:'360750'}],quotes:[{symbol:'360750',price:25400}]});
  at(25400,3);at(25550,4);assert.equal(count(),2,'set again by the AI: a new level');
});
