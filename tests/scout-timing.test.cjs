'use strict';
// Step A4 (artifacts/reviews/2026-11-12-engine-settings/plan.md): scheduled scout runs by market event, with times
// from the session calendar, the skip rule for a run shortly after another, and the old presets mapped on upgrade.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const T=require('../electron/scout-timing.cjs');const {researchFocus}=require('../electron/scout.cjs');
const {Automation,DEFAULTS}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const at=iso=>Date.parse(iso);const ran=(finishedAt,focus=['KR','US'])=>({finishedAt,focus});const kst=t=>new Date(t+9*3600000).toISOString().slice(11,16);
const all={...T.TIMING_DEFAULTS,scoutBeforeKrOpen:true,scoutAfterKrOpen:true,scoutKrMidday:true,scoutBeforeUsOpen:true};
const times=(day,cfg=all,markets=['KR','US'],opts={})=>Object.fromEntries(T.slotsOn(cfg,day,markets,opts).map(x=>[x.slot,kst(x.at)]));

test('the defaults are the old default preset (after the open and midday); the offset is 60 minutes',()=>{
  assert.deepEqual(T.TIMING_DEFAULTS,{scoutBeforeKrOpen:false,scoutAfterKrOpen:true,scoutKrMidday:true,scoutBeforeUsOpen:false,scoutAfterOpenMinutes:60});
  for(const [k,v] of Object.entries(T.TIMING_DEFAULTS))assert.equal(DEFAULTS[k],v,k);
  assert.equal(Object.hasOwn(DEFAULTS,'scoutSchedule'),false,'the preset key is gone');
});

test('the four times on a winter weekday, from the calendar (Seoul time)',()=>{
  assert.deepEqual(times('2026-11-12'),{'before-kr-open':'08:40','after-kr-open':'10:00','kr-midday':'13:00','before-us-open':'23:00'});
  assert.deepEqual(times('2026-11-12',{...all,scoutAfterOpenMinutes:25}),{'before-kr-open':'08:40','after-kr-open':'09:25','kr-midday':'13:00','before-us-open':'23:00'},'the after-open offset');
});

test('across the U.S. daylight-saving changes, "Before the U.S. opens" moves with the U.S. open; the Korean times do not',()=>{
  assert.equal(times('2026-07-15')['before-us-open'],'22:00','summer: the open is 22:30 KST');
  assert.equal(times('2026-10-30')['before-us-open'],'22:00','Friday before DST ends (Sunday 2026-11-01)');
  assert.equal(times('2026-11-02')['before-us-open'],'23:00','Monday after: the open is 23:30 KST');
  assert.equal(times('2026-03-06')['before-us-open'],'23:00','Friday before DST starts (Sunday 2026-03-08)');
  assert.equal(times('2026-03-09')['before-us-open'],'22:00','Monday after');
  for(const day of ['2026-10-30','2026-11-02','2026-03-06','2026-03-09'])assert.equal(times(day)['after-kr-open'],'10:00',day);
  // The old fixed 22:40 was 50 minutes before the winter open and 10 minutes after the summer open.
});

test('holidays: a Korean holiday has no Korean slot; a U.S. holiday has no U.S. slot; weekends have none',()=>{
  const chuseok={closedDays:new Set(['2026-09-24','2026-09-25'])};
  assert.deepEqual(times('2026-09-24',all,['KR','US'],chuseok),{'before-us-open':'22:00'},'Chuseok: only the U.S. run');
  assert.deepEqual(times('2026-11-26'),{'before-kr-open':'08:40','after-kr-open':'10:00','kr-midday':'13:00'},'Thanksgiving: only the Korean runs');
  assert.deepEqual(times('2026-11-14'),{},'Saturday');
  assert.deepEqual(times('2026-11-12',all,['KR']),{'before-kr-open':'08:40','after-kr-open':'10:00','kr-midday':'13:00'},'a Korea-only portfolio has no U.S. slot');
  // Wednesday 2026-09-23 14:00 KST: Chuseok Thursday and Friday, then the weekend; the next Korean runs are Monday's.
  const next=T.nextTimes(all,['KR'],at('2026-09-23T05:00:00Z'),chuseok);
  assert.deepEqual(next.map(x=>x.text),['Before Korea opens 08:40','After Korea opens 10:00','Korea midday 13:00']);
  assert.deepEqual([...new Set(next.map(x=>new Date(x.at+9*3600000).toISOString().slice(0,10)))],['2026-09-28']);
});

test('the due slot: the most recent passed one of today, once each',()=>{
  assert.equal(T.dueSlot(all,['KR','US'],at('2026-11-11T23:30:00Z')),null,'08:30 KST');
  assert.equal(T.dueSlot(all,['KR','US'],at('2026-11-11T23:45:00Z')).id,'2026-11-12 before-kr-open');
  assert.equal(T.dueSlot(all,['KR','US'],at('2026-11-12T05:00:00Z')).id,'2026-11-12 kr-midday','14:00: midday, the latest passed');
  const us=T.dueSlot(all,['KR','US'],at('2026-11-12T14:05:00Z'));assert.equal(us.id,'2026-11-12 before-us-open');assert.equal(us.market,'US');
  assert.equal(T.dueSlot({...all,scoutBeforeUsOpen:false},['KR','US'],at('2026-11-12T14:05:00Z')).id,'2026-11-12 kr-midday','a switch that is off has no slot');
});

test('a scheduled run focuses on its slot\'s market whatever the clock distance',()=>{
  const now=at('2026-11-12T13:40:00Z');// 22:40 KST, 50 minutes before the winter U.S. open
  const plain=researchFocus(['KR','US'],now);assert.notDeepEqual(plain.markets,['US'],'without the slot the U.S. is not the focus 50 minutes out');
  assert.deepEqual(researchFocus(['KR','US'],now,{slot:{market:'US',label:'Before the U.S. opens'}}),{markets:['US'],deferred:['KR'],basis:'scheduled run: Before the U.S. opens'});
  assert.deepEqual(researchFocus(['KR'],now,{slot:{market:'US',label:'x'}}),researchFocus(['KR'],now),'a slot for a market not in the portfolio changes nothing');
});

test('the skip rule: a run within the hour is skipped unless the slot\'s market opened in between',()=>{
  const after={slot:'after-kr-open',label:'After Korea opens',market:'KR'};const mid={slot:'kr-midday',label:'Korea midday',market:'KR'};const us={slot:'before-us-open',label:'Before the U.S. opens',market:'US'};const pre={slot:'before-kr-open',label:'Before Korea opens',market:'KR'};
  assert.deepEqual(T.skipRule(after,null,at('2026-11-12T01:00:00Z')),{skip:false},'no earlier run');
  const s=T.skipRule(after,ran(at('2026-11-12T00:40:00Z')),at('2026-11-12T01:00:00Z'));assert.equal(s.skip,true);assert.match(s.reason,/^A scout run that researched Korea finished at 09:40 KST, 20 min ago, and Korea has not opened since/);assert.match(s.reason,/Skipped "After Korea opens"\.$/);
  const opened=T.skipRule({...after},ran(at('2026-11-11T23:52:00Z')),at('2026-11-12T00:40:00Z'));assert.equal(opened.skip,false,'requested at 08:52, slot at 09:40: Korea opened in between');assert.match(opened.reason,/Korea opened since the last scout run \(48 min ago\)/);
  assert.equal(T.skipRule(after,ran(at('2026-11-11T23:52:00Z')),at('2026-11-12T01:00:00Z')).skip,false,'68 minutes: outside the hour');
  assert.equal(T.skipRule(mid,ran(at('2026-11-12T03:30:00Z')),at('2026-11-12T04:00:00Z')).skip,true,'midday 30 minutes after a run');
  assert.equal(T.skipRule(pre,ran(at('2026-11-11T23:20:00Z')),at('2026-11-11T23:40:00Z')).skip,true,'before the open after a run at 08:20: Korea did not open');
  assert.equal(T.skipRule(us,ran(at('2026-11-12T13:30:00Z')),at('2026-11-12T14:00:00Z')).skip,true,'22:30 run, 23:00 slot: the U.S. is not open yet');
  assert.equal(T.SKIP_WITHIN_MINUTES,60);
});

test('upgrade: each old preset becomes its switches; the user\'s kr-us becomes After Korea opens and Before the U.S. opens',()=>{
  const sw=s=>T.migrate({scoutSchedule:s});
  assert.deepEqual(sw('kr-us'),{scoutBeforeKrOpen:false,scoutAfterKrOpen:true,scoutKrMidday:false,scoutBeforeUsOpen:true});
  assert.deepEqual(sw('daily'),{scoutBeforeKrOpen:false,scoutAfterKrOpen:true,scoutKrMidday:false,scoutBeforeUsOpen:false});
  assert.deepEqual(sw('twice'),{scoutBeforeKrOpen:false,scoutAfterKrOpen:true,scoutKrMidday:true,scoutBeforeUsOpen:false});
  assert.deepEqual(sw('three'),{scoutBeforeKrOpen:false,scoutAfterKrOpen:true,scoutKrMidday:true,scoutBeforeUsOpen:true});
  assert.deepEqual(sw('unknown'),sw('twice'),'an unknown preset is the old default');
  assert.equal(T.migrate({}),null);assert.equal(T.migrate({scoutSchedule:'kr-us',scoutKrMidday:true}),null,'already switches: nothing to map');
});

const automation=(saved,log=()=>{})=>{const db=new DatabaseSync(':memory:');const a0=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  if(saved){db.prepare('UPDATE automation_settings SET payload=? WHERE id=1').run(JSON.stringify(saved));}
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},log);return a;};

test('the engine: a saved profile with kr-us loads as switches; the preset key is ignored on load and when sent',()=>{
  // The live profile's settings as saved before A4 (scoutEnabled true, scoutSchedule kr-us; A0 report).
  const a=automation({...DEFAULTS,scoutEnabled:true,scoutSchedule:'kr-us',scoutBeforeKrOpen:undefined,scoutAfterKrOpen:undefined,scoutKrMidday:undefined,scoutBeforeUsOpen:undefined,scoutAfterOpenMinutes:undefined});
  assert.deepEqual([a.config.scoutBeforeKrOpen,a.config.scoutAfterKrOpen,a.config.scoutKrMidday,a.config.scoutBeforeUsOpen,a.config.scoutAfterOpenMinutes],[false,true,false,true,60]);
  assert.equal(Object.hasOwn(a.config,'scoutSchedule'),false);
  const before=JSON.stringify(a.config);a.configure({scoutSchedule:'three'});assert.equal(JSON.stringify(a.config),before,'a sent preset is ignored');
  for(const bad of [{scoutAfterOpenMinutes:5},{scoutAfterOpenMinutes:241},{scoutAfterOpenMinutes:30.5},{scoutBeforeUsOpen:'yes'}])assert.throws(()=>a.configure(bad),/INVALID_SETTINGS/,JSON.stringify(bad));
  a.configure({scoutBeforeKrOpen:true,scoutAfterOpenMinutes:45});assert.equal(a.config.scoutBeforeKrOpen,true);assert.equal(a.config.scoutAfterOpenMinutes,45);
});

test('the engine tick: runs each due slot once for its market, skips one shortly after another run and logs why',()=>{
  const logs=[];const a=automation(null,(id,actor,title,body)=>logs.push([title,body]));
  a.configure({scope:'kis',scoutEnabled:true,scoutBeforeKrOpen:false,scoutAfterKrOpen:true,scoutKrMidday:true,scoutBeforeUsOpen:true});
  const runs=[];a.scoutAvailable=()=>null;a.scout=async(trigger,o)=>{runs.push([trigger,o]);};let latest=null;a.scoutStore.latest=()=>latest;
  assert.equal(a.scoutTick(at('2026-11-11T23:50:00Z')),null,'08:50 KST: nothing due');
  assert.equal(a.scoutTick(at('2026-11-12T01:05:00Z')).ran,true);assert.deepEqual(runs[0],['Scheduled',{slot:{market:'KR',label:'After Korea opens'}}]);
  assert.equal(a.scoutTick(at('2026-11-12T01:20:00Z')),null,'once per slot');
  latest={timestamp:at('2026-11-12T03:40:00Z')};// a requested run finished at 12:40 KST
  const skipped=a.scoutTick(at('2026-11-12T04:00:00Z'));assert.match(skipped.skipped,/finished at 12:40 KST, 20 min ago/);assert.equal(runs.length,1);
  assert.deepEqual(logs.at(-1)[0],'Scout run skipped · Korea midday');assert.equal(a.scoutTick(at('2026-11-12T04:30:00Z')),null,'a skipped slot is not retried');
  assert.equal(a.scoutTick(at('2026-11-12T14:05:00Z')),null,'a Korea-only portfolio has no U.S. run');
  a.configure({scope:'both'});a.lastScoutAttempt=0;const us=a.scoutTick(at('2026-11-12T14:05:00Z'));assert.equal(us.ran,true);assert.deepEqual(runs.at(-1),['Scheduled',{slot:{market:'US',label:'Before the U.S. opens'}}]);
});

test('the upgrade day: a 09:10 run under the old preset does not repeat at the new 10:00 slot',()=>{
  const a=automation(null);a.configure({scope:'kis',scoutEnabled:true});const runs=[];a.scoutAvailable=()=>null;a.scout=async()=>{runs.push(1);};
  a.scoutStore.markSlot(a.watchScope(),'2026-11-12 09:10');a.scoutStore.latest=()=>({timestamp:at('2026-11-12T00:11:00Z')});
  const r=a.scoutTick(at('2026-11-12T01:00:00Z'));assert.match(r.skipped,/09:11 KST, 49 min ago/);assert.equal(runs.length,0);
});

test('the review context and the scout state list the next runs by name and Seoul time',()=>{
  const a=automation(null);a.configure({scope:'kis',scoutEnabled:true});
  const real=Date.now;Date.now=()=>at('2026-11-12T00:30:00Z');
  try{assert.deepEqual(a.scoutState().times,['After Korea opens 10:00','Korea midday 13:00']);}finally{Date.now=real;}
});

test('A4 review F1: a slot more than 30 minutes late is dropped and logged, unless its time is in its market session and that session is still open',()=>{
  // Before Korea opens (08:40): the 30-minute rule only.
  const pre=T.dueSlot(all,['KR'],at('2026-11-11T23:50:00Z'));assert.equal(pre.slot,'before-kr-open');
  assert.deepEqual(T.lateness(pre,at('2026-11-12T00:10:00Z')),{onTime:true},'09:10: exactly 30 minutes late is on time');
  const late=T.lateness(pre,at('2026-11-12T00:11:00Z'));assert.equal(late.onTime,false,'09:11: 31 minutes late, and 08:40 is not in the session');
  assert.match(late.reason,/^Due at 08:40 KST and found 31 min late\. A scheduled run more than 30 min late is dropped, not run late, unless its time is in its market's session and that session is still open\. Dropped "Before Korea opens"\.$/);
  // After Korea opens (10:00): valid until the Korean close, with the lateness noted.
  const after={...T.dueSlot({...all,scoutKrMidday:false},['KR'],at('2026-11-12T01:40:00Z'))};assert.equal(after.slot,'after-kr-open');
  assert.deepEqual(T.lateness(after,at('2026-11-12T01:40:00Z')),{onTime:true,note:'Due at 10:00 KST, run 40 min late while Korea is still open'},'10:40 runs');
  assert.equal(T.lateness(after,at('2026-11-12T06:29:00Z')).onTime,true,'15:29: still open');
  assert.equal(T.lateness(after,at('2026-11-12T06:31:00Z')).onTime,false,'15:31: the session closed at 15:30');
  // Before the U.S. opens (23:00 winter): its time is before the session, so 31 minutes late is dropped even with the U.S. open.
  const us=T.dueSlot(all,['US'],at('2026-11-12T14:05:00Z'));assert.equal(T.lateness(us,at('2026-11-12T14:31:00Z')).onTime,false,'23:31, the U.S. open: still dropped');
  assert.equal(T.ON_TIME_MINUTES,30);
  // The reviewer's case: the app opens at 21:00 with After Korea opens and Korea midday on.
  const logs=[];const a=automation(null,(id,actor,title,body)=>logs.push([title,body]));a.configure({scope:'kis',scoutEnabled:true});const runs=[];a.scoutAvailable=()=>null;a.scout=async(...x)=>{runs.push(x);};
  const r=a.scoutTick(at('2026-11-12T12:00:00Z'));assert.match(r.dropped,/^Due at 13:00 KST and found 480 min late/);assert.equal(runs.length,0);
  assert.equal(logs.at(-1)[0],'Scout run dropped · Korea midday');assert.equal(a.scoutTick(at('2026-11-12T12:05:00Z')),null,'a dropped slot is handled');
});

test('A4 review F2: only a run whose research covered the market of a slot can cancel the slot',()=>{
  const us={slot:'before-us-open',label:'Before the U.S. opens',market:'US'};const after={slot:'after-kr-open',label:'After Korea opens',market:'KR'};
  assert.deepEqual(T.skipRule(us,ran(at('2026-11-12T13:30:00Z'),['KR']),at('2026-11-12T14:00:00Z')),{skip:false},'a Korea-focused run 30 min before does not cancel the U.S. run');
  assert.equal(T.skipRule(us,ran(at('2026-11-12T13:30:00Z'),['US']),at('2026-11-12T14:00:00Z')).skip,true,'a U.S.-focused run does');
  assert.equal(T.skipRule(us,ran(at('2026-11-12T13:30:00Z'),['KR','US']),at('2026-11-12T14:00:00Z')).skip,true,'a run that covered both does');
  assert.deepEqual(T.skipRule(after,ran(at('2026-11-12T00:40:00Z'),['US']),at('2026-11-12T01:00:00Z')),{skip:false},'a U.S.-focused run does not cancel a Korean slot');
  assert.equal(T.skipRule(us,{finishedAt:at('2026-11-12T13:30:00Z'),focus:null},at('2026-11-12T14:00:00Z')).skip,false,'no focus known: never skipped');
  // In the engine: the run records its focus, and the tick reads it.
  const a=automation(null);a.configure({scope:'both',scoutEnabled:true,scoutBeforeUsOpen:true});const runs=[];a.scoutAvailable=()=>null;a.scout=async(...x)=>{runs.push(x);};
  let latest={timestamp:at('2026-11-12T13:30:00Z'),focus:['KR']};a.scoutStore.latest=()=>latest;
  assert.equal(a.scoutTick(at('2026-11-12T14:05:00Z')).ran,true,'after a Korea-focused run at 22:30 the U.S. run happens');
  const b=automation(null);b.configure({scope:'both',scoutEnabled:true,scoutBeforeUsOpen:true});b.scoutAvailable=()=>null;b.scout=async()=>{};b.scoutStore.latest=()=>({timestamp:at('2026-11-12T13:30:00Z'),focus:['US']});
  assert.match(b.scoutTick(at('2026-11-12T14:05:00Z')).skipped,/^A scout run that researched the U\.S\. finished at 22:30 KST/);
  // A plan saved before A4 has no focus: the clock rule at its time decides (09:11 KST: Korea).
  const c=automation(null);c.configure({scope:'both',scoutEnabled:true});c.scoutStore.latest=()=>({timestamp:at('2026-11-12T00:11:00Z')});assert.deepEqual(c.lastScoutRun(c.watchScope()).focus,['KR']);
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/automation.cjs'),'utf8');assert.ok(src.includes('const saved=this.scoutStore.save(scope,plan,{runId:id,trigger,focus:focus.markets,'),'each run saves the markets its research covered');
});

test('the next-run times in the review context change nothing for skipping: not in the skip fingerprint, not in the review gate',()=>{
  const saver=require('../electron/token-saver.cjs');const gate=require('../electron/review-gate.cjs');
  const ctx=runs=>({market:'KR',currency:'KRW',cash:1000,positions:{},scoutBrief:{runAllowed:true,remainingRunsToday:3,scheduledRuns:runs,openBriefs:[]}});
  assert.equal(saver.fingerprint(ctx(['After Korea opens 10:00 KST'])).exact,saver.fingerprint(ctx(['Korea midday 13:00 KST'])).exact,'token-saver fingerprint (decisionView reads only COMPARED keys; scoutBrief is not one)');
  assert.deepEqual(gate.decisionState(ctx(['After Korea opens 10:00 KST'])),gate.decisionState(ctx(['Korea midday 13:00 KST'])),'review-gate decisionState');
  assert.ok(!Object.keys(saver.decisionView(ctx(['x']))).includes('scoutBrief'));
});

test('A4 review F1 in the engine: opened at 10:40, After Korea opens runs under its label with the lateness noted',()=>{
  const a=automation(null);a.configure({scope:'kis',scoutEnabled:true,scoutKrMidday:false});const runs=[];a.scoutAvailable=()=>null;a.scout=async(...x)=>{runs.push(x);};
  assert.equal(a.scoutTick(at('2026-11-12T01:40:00Z')).ran,true);assert.deepEqual(runs[0],['Scheduled',{slot:{market:'KR',label:'After Korea opens',note:'Due at 10:00 KST, run 40 min late while Korea is still open'}}]);
  const b=automation(null);b.configure({scope:'kis',scoutEnabled:true,scoutKrMidday:false});b.scoutAvailable=()=>null;b.scout=async()=>{throw new Error('must not run');};
  assert.match(b.scoutTick(at('2026-11-12T06:31:00Z')).dropped,/^Due at 10:00 KST and found 331 min late/,'15:31: dropped');
});
