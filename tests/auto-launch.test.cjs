const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');const {launchState,start,stop}=require('../electron/auto-launch.cjs');
function fixture(){const db=new DatabaseSync(':memory:');const kr={accountKey:'fixture',environment:'mock',reportedTotal:10000,cash:10000,holdings:[]};const us={...kr,accountKey:'fixture:US'};let reviews=0;const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);const a=new Automation(db,paper,{request:async()=>{reviews++;return {provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'Fixture'}};}},()=>{});a.marketHours=()=>({open:true,markets:[],preOpen:null,next:null});const broker=snapshot=>({request:async op=>{assert.equal(op,'live-context');return {balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}};}});a.live=new LiveEngine(db,broker(kr),()=>({status:'connected',snapshot:kr}));a.usLive=new LiveEngine(db,broker(us),()=>({status:'connected',snapshot:us}),{market:'US'});a.refreshUS=async()=>({balance:us,quotes:[],marketSession:{open:false,status:'closed'}});a.providerStatus.aiConnected=true;a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true});return {a,db,kr,us,reviews:()=>reviews};}
test('one action activates saved market policy, automatic submission and the schedule; a review already due starts from the scheduler',async()=>{const {a,db,reviews}=fixture();try{a.live.configure({symbols:['005930'],maxCompanyPct:100,lossLimit:{mode:'percent',value:10}},'ENABLE MOCK');a.live.stop();assert.match(await start(a,launchState(a).token),/review is due and starts shortly/);assert.equal(reviews(),0,'Start itself runs no review');assert.equal(a.firstAfterStart,true);await a.review('Auto trading started');assert.equal(launchState(a).running,true);assert.equal(a.live.policy().maxCompanyPct,100);assert.equal(a.live.policy().lossLimit.value,10);assert.equal(reviews(),1);stop(a);assert.equal(a.live.enabled,false);assert.equal(a.config.autoSubmit,false);assert.equal(a.sessionArmed,false);}finally{db.close();}});
test('changed configuration, missing sharing and unfunded second market cannot activate',async()=>{const {a,db,us}=fixture();try{const old=launchState(a).token;a.configure({intervalMinutes:30});await assert.rejects(start(a,old),/changed/);a.configure({shareKisWithOpenAI:false});await assert.rejects(start(a,launchState(a).token),/sharing/);a.configure({shareKisWithOpenAI:true,scope:'both'});us.reportedTotal=0;await assert.rejects(start(a,launchState(a).token),/funded/);assert.equal(a.live.enabled,false);assert.equal(a.usLive.enabled,false);assert.equal(a.sessionArmed,false);}finally{db.close();}});
test('stop during account refresh cancels pending start without rearming',async()=>{const {a,db}=fixture();try{a.configure({scope:'both'});let resume;a.refreshUS=()=>new Promise(resolve=>{resume=resolve;});const task=start(a,launchState(a).token);stop(a);resume();await assert.rejects(task,/canceled/);assert.equal(a.live.enabled,false);assert.equal(a.usLive.enabled,false);assert.equal(a.sessionArmed,false);}finally{db.close();}});
test('duplicate start is rejected while launch is pending and budget blocks launch',async()=>{const {a,db}=fixture();try{a.configure({scope:'us'});let resume;a.refreshUS=()=>new Promise(resolve=>{resume=resolve;});const token=launchState(a).token;const task=start(a,token);await assert.rejects(start(a,token),/already/);a.refreshUS=async()=>({balance:a.usLive.getConnection().snapshot,quotes:[],marketSession:{open:false,status:'closed'}});resume(await a.refreshUS());await task;await a.review('User request');stop(a);a.configure({maxCallsPerDay:1});await assert.rejects(start(a,launchState(a).token),/budget/);}finally{db.close();}});
test('with markets closed, starting auto trading waits for the pre-open review instead of reviewing now',async()=>{
  const f=fixture();f.a.marketHours=()=>({open:false,markets:[],preOpen:null,next:{market:'KR',at:Date.now()+3600000}});f.a.configure({scope:'kis'});
  const message=await start(f.a,launchState(f.a).token);assert.match(message,/Markets are closed/);assert.equal(f.reviews(),0,'no review ran');assert.equal(launchState(f.a).running,true);
});
// R15 removed (2026-11-19, decision.md): with U.S. automatic orders on, Start says that U.S. buys and sales go out
// automatically, counted against won cash, and lists the U.S. limits as saved, each set or not set.
test('Start with the U.S. market: one line names automatic U.S. buys and sales and each U.S. limit, set or not set',async()=>{
  const f=fixture();try{f.a.marketHours=()=>({open:false,markets:[],preOpen:null,next:{market:'KR',at:Date.now()+3600000}});f.a.configure({scope:'us'});
    const message=await start(f.a,launchState(f.a).token);
    assert.match(message,/ U\.S\.: buys and sales are sent automatically, each counted against your won cash; limits: maximum order not set, daily turnover not set, per company not set, daily loss off\.$/);
    stop(f.a);f.a.usLive.configure({symbols:[],maxOrderKRW:500,lossLimit:{mode:'percent',value:3}},'ENABLE MOCK');f.a.usLive.stop();
    assert.match(await start(f.a,launchState(f.a).token),/limits: maximum order \$500, daily turnover not set, per company not set, daily loss 3%\.$/);
    stop(f.a);f.a.configure({scope:'kis'});assert.doesNotMatch(await start(f.a,launchState(f.a).token),/U\.S\.:/,'Korea only: no U.S. line');
  }finally{f.db.close();}});
// Audit item 15 (2026-11-19): only Start arms a session. After a restart ("Paused after restart", enabled saved on), an
// Engine settings save used to send the saved enabled:true and re-arm the scheduler without Start: no Start checks,
// the engines' automatic switches still off, so paid reviews ran and their orders waited as two-minute proposals.
// Every caller in electron/ that can pass enabled: Start (arms), Stop (disarms; also the guardrail's auto-stopped
// trip, which calls it), the renderer's settings saves through runtime:configure (only the keys changed; one that
// carries enabled, the "Scheduled reviews" switch, can disarm and never arms), and the key
// import at main.cjs ({provider:'openai'}, no enabled). The agent bridge and the phone paths never call configure.
const restarted=f=>{const {Automation}=require('../electron/automation.cjs');const b=new Automation(f.db,f.a.paper,{request:async()=>({provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,explanation:'x'}})},()=>{});
  b.marketHours=f.a.marketHours;b.live=f.a.live;b.usLive=f.a.usLive;b.refreshUS=f.a.refreshUS;b.providerStatus.aiConnected=true;return b;};
test('item 15: after a restart a settings save leaves the session paused (Home reads Manual); Start arms it; Stop and a trip disarm it',async()=>{
  const f=fixture();try{assert.match(await start(f.a,launchState(f.a).token),/Auto trading started/);assert.equal(f.a.sessionArmed,true);
    const b=restarted(f);assert.equal(b.config.enabled,true,'saved on');assert.equal(b.sessionArmed,false,'paused after restart');
    b.configure({intervalMinutes:30});assert.equal(b.sessionArmed,false,'a save of changed keys only');
    b.configure({intervalMinutes:45,enabled:true});assert.equal(b.sessionArmed,false,'even one that sends the saved enabled:true (the old renderer)');
    assert.equal(launchState(b).running,false,'Home: launch.running false, so the chip reads Manual');assert.equal(b.nextReviewAt(),null,'no scheduled review');assert.equal(b.conditionalMonitoringActive(),false);
    b.configure({provider:'openai'});assert.equal(b.sessionArmed,false,'the key import at main.cjs:80');
    assert.match(await start(b,launchState(b).token),/Auto trading started/);assert.equal(b.sessionArmed,true,'Start arms it');assert.equal(launchState(b).running,true);
    b.configure({intervalMinutes:30});assert.equal(b.sessionArmed,true,'a save does not disarm a running session');
    stop(b);assert.equal(b.sessionArmed,false,'Stop disarms');
    await start(b,launchState(b).token);b.trip('auto-stopped','test');assert.equal(b.sessionArmed,false,'the guardrail trip (auto-stopped) disarms through Stop');
    b.configure({intervalMinutes:30,enabled:false});assert.equal(b.sessionArmed,false,'a save with enabled:false keeps it disarmed');
    b.configure({enabled:true});assert.equal(b.sessionArmed,false,'turning Scheduled reviews on from off saves the switch; the schedule runs from the next Start');assert.equal(b.config.enabled,true);
  }finally{f.db.close();}});
test('item 15: the renderer sends only the keys changed (no enabled), and only Start passes enabled:true in electron/',()=>{
  const fs=require('node:fs'),path=require('node:path');const ui=fs.readFileSync(path.join(__dirname,'../src/RuntimeSettings.tsx'),'utf8');
  assert.ok(ui.includes('...Object.fromEntries([...changed.current].map(key=>[key,config![key]])),...(confirmed'),'changed keys only');assert.ok(!ui.includes('enabled:config!.enabled'));
  const hits=[];for(const f of fs.readdirSync(path.join(__dirname,'../electron')).filter(x=>x.endsWith('.cjs'))){const s=fs.readFileSync(path.join(__dirname,'../electron',f),'utf8');for(const m of s.matchAll(/\.configure\(\{[^}]*enabled:true[^}]*\}\)/g))hits.push(f+': '+m[0]);}
  assert.deepEqual(hits,['auto-launch.cjs: .configure({enabled:true,autoSubmit:true})'],'only Start');});
test('item 15: the status says which pause it is: "Paused after restart" until the first Start, then "Paused"; the switch says when it takes effect',async()=>{
  const f=fixture();try{await start(f.a,launchState(f.a).token);const b=restarted(f);
    assert.deepEqual(b.schedulerStatus(),{label:'Paused after restart',detail:'Your settings were restored. Use Start auto trading to resume, or run a manual review.'},'the restart case');
    b.configure({intervalMinutes:30});assert.equal(b.schedulerStatus().label,'Paused after restart','a save keeps the restart wording');
    await start(b,launchState(b).token);assert.notEqual(b.schedulerStatus().label,'Paused');
    b.configure({enabled:false});assert.equal(b.schedulerStatus().label,'Manual reviews only','switched off');
    b.configure({enabled:true});assert.deepEqual(b.schedulerStatus(),{label:'Paused',detail:'Press Start auto trading to resume.'},'off and on again: not a restart');
    assert.equal(launchState(b).running,false,'Home reads Manual');
    await start(b,launchState(b).token);assert.equal(b.sessionArmed,true);assert.notEqual(b.schedulerStatus().label,'Paused');
  }finally{f.db.close();}
  const ui=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/EngineSettings.tsx'),'utf8');
  assert.ok(ui.includes(`<Row title="Scheduled reviews" hint={state.launch?.running?'Review on a timer and when prices move':'Takes effect when you press Start auto trading.'}>`),'the switch\'s hint in each state');});
