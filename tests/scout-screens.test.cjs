// The scout's screening tool (note 5, S3), with the planner's first review of it and the user's acceptance rule: "it has
// to be checked if any of the failed script calls block or make reviews failed". run_screen is offered to the scout
// only; its description is facts (no readings of values, no how-to); every failure of a script call comes back as a tool
// result with words while the run goes on to its plan; long scripts never make the run over budget (stand-ins); the
// engine runs off the main thread; stored scripts are cleaned; the panel's status; stopped stocks retry after 30 days.
// Made-up symbols and prices.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const scout=require('../electron/scout.cjs');const AI=require('../electron/ai-client.cjs');const {HELP}=require('../electron/formula-script.cjs');
const {ScreenEngine,threadSpawn}=require('../electron/screen-engine.cjs');const R=require('../electron/screen-run.cjs');
test('run_screen is a scout tool (and, since S4, a review desk tool); the whole description is facts: no reading of a value, no how-to',()=>{
  const names=AI.scoutTools().map(t=>t.name);assert.equal(names.filter(n=>n==='run_screen').length,1);assert.equal(names.at(-1),'run_screen','added last, so the cached prefix before it is kept');
  assert.ok(!AI.reviewTools({}).some(t=>t.name==='run_screen'),'without the desk a review has no run_screen (tests/review-screen.test.cjs covers the desk)');
  const d=scout.SCREEN_TOOL.description;assert.ok(d.endsWith(HELP));
  for(const banned of [/above about/i,/means upward/i,/strong trend/i,/weak/i,/buying pressure/i,/stretched/i,/momentum/i,/narrow the universe/i,/for example filter on/i,/strategy/i,/\bbuy\b/i,/\bsell\b/i])assert.doesNotMatch(d,banned,String(banned));
  assert.match(d,/a universe can be reduced with filter, top or bottom before live\(S\) is used/);
});
const OPENAI=(output)=>new AI.AiClient('sk-fixture-key-123',async()=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage:{input_tokens:1,output_tokens:1},output}),{status:200}));
const O={openaiModel:'gpt-6-sol',reasoningEffort:'low'};
const claude=input=>{const A=require('../electron/anthropic-client.cjs');const reply={id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'sig'},{type:'tool_use',id:'t1',name:'run_screen',input}],stop_reason:'tool_use',stop_details:null,usage:{input_tokens:100,output_tokens:50,service_tier:'standard'},input_transformations:[]};
  return new A.AnthropicClient('sk-ant-fixture-key-0000',async()=>new Response(JSON.stringify(reply),{status:200,headers:{'content-type':'application/json'}})).scout({brief:'x'},{openaiModel:'claude-opus-5-5',reasoningEffort:'medium'});};
test('an oversize or malformed run_screen request is answered as a tool error in both clients, never INVALID_AI_RESPONSE',async()=>{
  const big='x'.repeat(6100);const ko=String.fromCodePoint(0xac00).repeat(2100);
  for(const [args,why] of [[JSON.stringify({script:big}),/the request is \d+ bytes; at most 6000/],[JSON.stringify({script:ko}),/the request is \d+ bytes; at most 6000/],['{not json',/not valid JSON/],[JSON.stringify([1]),/not an object/],[JSON.stringify({script:5}),/no script text/],[JSON.stringify({}),/no script text/]]){
    const r=await OPENAI([{type:'function_call',call_id:'c1',name:'run_screen',arguments:args}]).scout({},O);assert.match(r.toolCalls[0].args.invalid,why,args.slice(0,30));}
  const ok=await OPENAI([{type:'function_call',call_id:'c1',name:'run_screen',arguments:JSON.stringify({script:'print(1)'})}]).scout({},O);assert.deepEqual(ok.toolCalls[0].args,{script:'print(1)'});
  await assert.rejects(OPENAI([{type:'function_call',call_id:'c1',name:'screen_market',arguments:JSON.stringify({market:'x'.repeat(2100)})}]).scout({},O),e=>e.message==='INVALID_AI_RESPONSE','other tools keep their check');
  for(const [input,why] of [[{script:big},/at most 6000/],[{script:ko},/at most 6000/],[{script:null},/no script text/],[[1,2],/not an object/]]){const r=await claude(input);assert.equal(r.toolCalls[0].name,'run_screen');assert.match(r.toolCalls[0].args.invalid,why);}
  assert.deepEqual((await claude({script:'print(1)'})).toolCalls[0].args,{script:'print(1)'});
});
test('every failure of a script call comes back as a result with words; the stored script is cleaned and cut on whole characters',async()=>{
  const screens=[];const runner=async text=>{if(text==='throw')throw new Error('BOOM');if(text==='null')throw null;return R.runScreen(text,{data:{closes:()=>null}});};
  const tools=scout.focusTools({},{markets:['KR'],deferred:[]},{screen:runner,screens});
  const cases=[[{invalid:'the request is 7000 bytes; at most 6000'},/the script was not run: the request is 7000 bytes/],[{},/no script text/],[{script:7},/no script text/],[{script:'print(1 +'},null,'stopped'],[{script:'throw'},/could not be run \(BOOM\)/],[{script:'null'},/could not be run \(SCREEN_FAILED\)/],
    [{script:Array.from({length:41},()=>'print(1)').join('\n')},null,'stopped'],[{script:'print(live("111110"))'},null,'stopped'],[{script:'print(count(universe(market="MOON")))'},null,'stopped']];
  for(const [args,words,status] of cases){const r=await tools.run_screen(args);if(status)assert.equal(r.status,status,JSON.stringify(args).slice(0,40));else{assert.equal(r.status,'error');assert.match(r.words,words);}}
  assert.deepEqual(await scout.focusTools({},{markets:['KR'],deferred:[]}).run_screen({script:'print(1)'}),{status:'error',words:'the script was not run: screens are not available in this run'});
  const odd=String.fromCodePoint(0x202e)+String.fromCodePoint(7)+'# comment\nprint(1)';const kept=scout.keptScript(odd);assert.equal(kept,'  # comment\nprint(1)');
  const long=Array.from({length:50},()=>String.fromCodePoint(0x1f600).repeat(100)).join('\n');const cut=scout.keptScript(long);assert.ok(cut.isWellFormed());assert.ok(cut.endsWith('… cut'));
  const staleRun=await scout.focusTools({},{markets:['KR'],deferred:[]},{screen:runner,guard:()=>{throw new Error('STALE_DECISION');}}).run_screen({script:'print(1)'});assert.deepEqual(staleRun,{status:'error',words:'the script was not run: the account or scope changed during this run'},'the account guard, in words');
});
// A fake provider in either continuation shape, for runScout.
const fakeProvider=(shape,scripts,{context=60000}={})=>{let round=0;const sent=[];
  const request=async({final,continuation})=>{sent.push(JSON.stringify(continuation??[]));if(final||!scripts[round]?.length)return {plan:{summary:'s',cashTargetPct:null,focus:'',targets:[]}};
    const calls=scripts[round++].map((s,i)=>({name:'run_screen',callId:`r${round}c${i}`,args:scout.screenArgs(shape==='claude'?{script:s}:JSON.stringify({script:s}))}));
    const base=continuation??[{role:'user',content:'c'.repeat(context)}];
    const items=shape==='claude'?[{type:'anthropic_turn',content:calls.map(c=>({type:'tool_use',id:c.callId,name:'run_screen',input:{script:scripts[round-1][Number(c.callId.split('c')[1].slice(0))]}}))},...calls.map(c=>({type:'function_call',call_id:c.callId,name:'run_screen',arguments:JSON.stringify(c.args),vendor:'anthropic'}))]
      :calls.map((c,i)=>({type:'function_call',call_id:c.callId,name:'run_screen',arguments:JSON.stringify({script:scripts[round-1][i]})}));
    return {toolCalls:calls,continuation:[...base,...items],usage:{}};};return {request,sent};};
test('item 1: twelve near-limit scripts over two rounds, ASCII and Korean comments, both providers and a large context: the plan round is reached',async()=>{
  const ascii=i=>`# SCRIPTBODY ${i} `+'a'.repeat(3800)+'\nprint(1)';const korean=i=>`# SCRIPTBODY ${i} `+String.fromCodePoint(0xac00).repeat(1900)+'\nprint(2)';
  const scripts=[Array.from({length:6},(_,i)=>ascii(i)),Array.from({length:6},(_,i)=>korean(i))];
  for(const shape of ['openai','claude']){const {request,sent}=fakeProvider(shape,scripts);const ran=[];
    const tools=scout.focusTools({},{markets:['KR'],deferred:[]},{screen:async t=>{ran.push(t);return {lines:['x'.repeat(3000)],coverage:[]};},screens:[]});
    const r=await scout.runScout({request,tools,log:()=>{},overheadBytes:AI.scoutOverheadBytes()});assert.ok(r.plan,shape);assert.equal(ran.length,12,`${shape}: every script ran`);
    const last=sent.at(-1);assert.ok((last.match(/SCRIPTBODY/g)??[]).length>=12,'each script is left as its stand-in');assert.ok(!last.includes('a'.repeat(200)),'no ASCII script body is carried');assert.ok(!last.includes(String.fromCodePoint(0xac00).repeat(100)),'no Korean script body is carried');
    assert.ok(Buffer.byteLength(last)<scout.SCOUT_REQUEST_BYTES-AI.scoutOverheadBytes(),`${shape}: ${Buffer.byteLength(last)} bytes`);}
  const {request}=fakeProvider('openai',[Array.from({length:8},(_,i)=>ascii(i)),[]]);const r=await scout.runScout({request,tools:scout.focusTools({},{markets:['KR'],deferred:[]},{screen:async()=>({lines:[],coverage:[]})}),log:()=>{}});assert.ok(r.plan,'skipped calls keep no arguments');
});
test('item 3: the engine runs off the main thread: the main loop stays responsive through a long pass; a pass that never answers ends with words',async()=>{
  const fixture=path.join(__dirname,'fixtures','slow-screen-worker.cjs');const engine=new ScreenEngine({spawn:threadSpawn(fixture),timeoutMs:3000});
  let last=Date.now(),worst=0;const tick=setInterval(()=>{const t=Date.now();worst=Math.max(worst,t-last);last=t;},5);
  const value=await engine.exec('final',{text:'print(1)'},{busyMs:800});clearInterval(tick);assert.deepEqual(value.lines,['done']);assert.ok(worst<100,`the main loop's longest gap was ${worst} ms during an 800 ms pass`);
  const quick=new ScreenEngine({spawn:threadSpawn(fixture),timeoutMs:200});const runner=R.openRun({readLive:async()=>new Map(),exec:(k,p)=>quick.exec(k,p,{})});
  const r=await runner('never');assert.equal(r.stopped.code,'SCREEN_ENGINE_TIMEOUT');assert.match(r.stopped.words,/took too long/);
  const again=await runner('print(1)');assert.deepEqual(again.lines,['done'],'the engine starts again after a timeout');engine.close();quick.close();
});
test('item 3: the real engine runs a script against a read-only copy of the database',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'screen-'));const file=path.join(dir,'p.sqlite');const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL');
  const H=require('../electron/history-store.cjs');new (require('../electron/security-master.cjs').SecurityMaster)(db,async()=>({ok:false}));new (require('../electron/us-size.cjs').UsSizeOrder)(db);const store=new H.HistoryStore(db);
  db.prepare("INSERT INTO securities(symbol,name,englishName,market,type,isin,industry,sector,marketCap) VALUES('111110','A','','KOSPI','stock','',NULL,NULL,9e12)").run();
  store.put('111110',Array.from({length:31},(_,i)=>({date:new Date(Date.UTC(2026,10,1)+i*86400000).toISOString().slice(0,10),close:100+i})));
  const engine=new ScreenEngine({spawn:threadSpawn()});const env={dbPath:file,now:Date.parse('2026-12-02T03:00:00Z'),settings:{perExchange:10,etfs:false},closedDays:[],own:{holdings:['111110']}};
  const runner=R.openRun({readLive:async()=>new Map(),exec:(k,p)=>engine.exec(k,p,env)});const r=await runner('u = universe(own="holdings")\nprint(top(u, close(S,0), 1))');
  assert.equal(r.stopped,undefined);assert.match(r.lines[0],/^1\. 111110 A 130 \(close 130, 2026-12-01\)/);engine.close();db.close();
});
// The scout run itself, as automation drives it (the setup of tests/scout.test.cjs).
async function scoutRun({screenRun,plan=true,scripts=[{script:'print(1)'},{invalid:'the request is 7000 bytes; at most 6000'},{script:'print(1 +'}]}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));let step=0;
  const provider={request:async(operation)=>{if(operation!=='scout')return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'x',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};step++;
    if(step===1)return {toolCalls:scripts.map((a,i)=>({name:'run_screen',callId:'s'+i,args:a})),continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1},model:'gpt-6-sol'};
    if(!plan)throw new Error('AI_TIMEOUT');return {plan:{summary:'Plan.',cashTargetPct:30,focus:'f',targets:[]},usage:{inputTokens:1,outputTokens:1},model:'gpt-6-sol'};}};
  const a=new Automation(db,paper,provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.discovery={list:()=>[],symbols:()=>[],screen_market:async()=>({rows:[]}),search_securities:async()=>({rows:[]}),research:async()=>({}),update_watchlist:async()=>({})};
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'none'});if(screenRun!==undefined)a.openScreenRun=screenRun;
  let error=null,saved=null;try{saved=await a.scout();}catch(e){error=e;}return {a,saved,error};}
test('the scout run: failing scripts never fail it; screens are saved with the plan or with a failure; a throwing runner or opener is answered',async()=>{
  const ok=await scoutRun({screenRun:()=>async t=>R.runScreen(t,{})});assert.equal(ok.error,null);assert.equal(ok.saved.plan.summary,'Plan.');
  const kept=ok.a.scoutScreens();assert.equal(kept.failed,false);assert.deepEqual(kept.screens.map(s=>s.status),['ok','error','stopped']);assert.equal(ok.a.scoutError??null,null);
  const st=ok.a.getState().scout;assert.equal(st.screenRun.count,3);assert.equal(st.screenRun.failed,false);assert.equal(st.latest.screens,undefined,'the full screens go to the panel only when it asks');
  const throwing=await scoutRun({screenRun:()=>async()=>{throw new Error('BOOM');}});assert.equal(throwing.error,null);assert.match(throwing.a.scoutScreens().screens[0].words,/could not be run \(BOOM\)/);
  const noOpen=await scoutRun({screenRun:()=>{throw new Error('x');}});assert.equal(noOpen.error,null);assert.match(noOpen.a.scoutScreens().screens[0].words,/screens are not available/);
  const failed=await scoutRun({screenRun:()=>async t=>R.runScreen(t,{}),plan:false});assert.ok(failed.error);const f=failed.a.scoutScreens();assert.equal(f.failed,true);assert.equal(f.screens.length,3,'kept with the failed run');
  const fs2=failed.a.getState().scout;assert.equal(fs2.screenRun.count,3,'a failed run\'s screens reach the panel though no plan had any');assert.equal(fs2.screenRun.failed,true);
  assert.equal(fs2.failedAfter.screens,undefined);assert.ok(JSON.stringify(fs2.failedAfter).length<300,'the failure record stays small');
});
test('the status: as-of days with how many stocks have them, no history yet, cached also when it fails',()=>{
  const {screenStatus}=require('../electron/screen-status.cjs');const H=require('../electron/history-store.cjs');const db=new DatabaseSync(':memory:');new (require('../electron/security-master.cjs').SecurityMaster)(db,async()=>({ok:false}));const store=new H.HistoryStore(db);
  const deps={db,store,usSize:{top:()=>null},own:k=>k==='holdings'?['111110','222220','333330']:[],settings:()=>({perExchange:2,etfs:false}),closedDays:()=>new Set(),clock:()=>Date.parse('2026-12-02T03:00:00Z')};
  let s=screenStatus({deps,refresher:{status:{state:'waiting',why:'an order of the app is open'}},enabled:true});assert.deepEqual(s.markets.KR,{stocks:3,read:0,current:0,older:0,full:0,median:0,stopped:0});
  const {statusLines}=loadStatusLines();assert.deepEqual(statusLines(s),['Korea: no history yet (3 stocks to read).','Not refreshing now: an order of the app is open.']);
  store.put('111110',[{date:'2026-12-01',close:1}]);store.put('222220',[{date:'2026-11-28',close:1}]);s=screenStatus({deps,refresher:{status:{state:'done'}},enabled:true});
  assert.deepEqual(statusLines(s),['Korea as of 2026-12-01: 1 of 3 stocks; 1 older; 1 not read yet. Full depth: 0 (median 1 of 311 days).']);
  const src=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8');assert.match(src,/catch\{screenStatusValue=\{error:true\};\}/);assert.match(src,/if\(screenStatusAt&&now-screenStatusAt<60000\)return screenStatusValue;screenStatusAt=now;/,'the time is set before the work, so a failure is cached too');
});
function loadStatusLines(){const ts=require('typescript');const React=require('react');const src=fs.readFileSync(path.join(__dirname,'../src/ScoutScreens.tsx'),'utf8');
  const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;const mod={exports:{}};new Function('require','module','exports',js)(require,mod,mod.exports);return {...mod.exports,React};}
test('the Screens section renders: a stopped script, a script not run, null live, no status, and nothing when the scout is off',()=>{
  const {ScreenList,ScoutScreens,React}=loadStatusLines();const {renderToStaticMarkup}=require('react-dom/server');
  const html=renderToStaticMarkup(React.createElement(ScreenList,{loaded:{failed:true,at:1,screens:[{at:1,script:'# a\nprint(1 +',status:'stopped',stopped:{line:2,words:'line 2: this line cannot be read'},lines:[],coverage:[],live:null},{at:2,script:'',status:'error',words:'the script was not run: the request had no script text'}]}}));
  assert.match(html,/The latest run failed/);assert.match(html,/Stopped: print\(1 \+/);assert.match(html,/line 2: this line cannot be read/);assert.match(html,/Not run: Script/);assert.doesNotMatch(html,/Live prices/);
  assert.equal(renderToStaticMarkup(React.createElement(ScoutScreens,{status:{enabled:false},run:null})),'');assert.match(renderToStaticMarkup(React.createElement(ScoutScreens,{status:null,run:{runId:'r',at:1,failed:true,count:2}})),/Screens · 2 in the latest run, which failed/);
  assert.match(fs.readFileSync(path.join(__dirname,'../src/ScoutPanel.tsx'),'utf8'),/<ScoutScreens key=\{scout\.screenRun\?\.runId\?\?'none'\}/,'a new run remounts the section, so its list is loaded again');
});
test('a stock that stopped deepening tries again after 30 days; the request size stays within the scout\'s limit',()=>{
  const H=require('../electron/history-store.cjs');const s=new H.HistoryStore(new DatabaseSync(':memory:'));
  s.db.prepare("INSERT INTO screen_progress(symbol,newest,oldest,depth,stopped,resetDay,resetNights) VALUES('111110','2030-03-01','2029-12-01',60,'the closes KIS gives keep changing between reads','2030-03-01',3),('222220','2030-03-01','2029-12-01',60,'the closes KIS gives keep changing between reads','2030-01-15',3)").run();
  assert.deepEqual(s.stoppedCount(),{count:2,reasons:['the closes KIS gives keep changing between reads']});assert.equal(s.retryStopped(Date.parse('2030-03-10T00:00:00Z')),1);assert.equal(s.progress('222220').stopped,null);
  const overhead=AI.scoutOverheadBytes();assert.ok(Buffer.byteLength(JSON.stringify(scout.SCREEN_TOOL))<7000);assert.ok(overhead<scout.SCOUT_REQUEST_BYTES*0.2,`${overhead}`);
});
test('C: waiting for an order is charged once, as it passes',async()=>{
  let t=0;const sleep=async ms=>{t+=ms;};const exec=R.localExec({});const state=R.newRun();
  await R.runWith('print(1)',exec,{runState:state,orderSending:()=>t<2000,clock:()=>t,sleep});assert.ok(Math.abs((R.RUN_WAIT_MS-state.waitLeft)-2000)<=2*200,`charged ${R.RUN_WAIT_MS-state.waitLeft} ms for a 2 s order`);
  t=0;const all=R.newRun();await R.runWith('print(1)',exec,{runState:all,orderSending:()=>true,clock:()=>t,sleep});assert.ok(all.waitLeft<=0&&t>=R.RUN_WAIT_MS-200&&t<=R.RUN_WAIT_MS+400,`a continuous order uses the 60 s budget in ${t} ms of waiting`);
});
test('D: the room for a screen counts the overhead once; a refusal is kept for the panel and not cached',async()=>{
  const ascii=i=>`# SCRIPTBODY ${i} `+'a'.repeat(3800)+'\nprint(1)';const scripts=[Array.from({length:6},(_,i)=>ascii(i)),Array.from({length:6},(_,i)=>ascii(i+6))];
  const {request}=fakeProvider('openai',scripts,{context:100000});const ran=[];const r=await scout.runScout({request,tools:scout.focusTools({},{markets:['KR'],deferred:[]},{screen:async t=>{ran.push(t);return {lines:['x'.repeat(500)],coverage:[]};}}),log:()=>{},overheadBytes:AI.scoutOverheadBytes()});
  assert.ok(r.plan);assert.equal(ran.length,12,'with a 100 KB context all twelve scripts run');
  const tight=fakeProvider('openai',[[ascii(0)],[ascii(0)]],{context:136000});const kept=[];const calls=[];
  const r2=await scout.runScout({request:tight.request,tools:scout.focusTools({},{markets:['KR'],deferred:[]},{screen:async t=>{calls.push(t);return {lines:[],coverage:[]};},screens:kept}),log:()=>{},overheadBytes:AI.scoutOverheadBytes()});
  assert.ok(r2.plan);assert.equal(calls.length,0);assert.equal(kept.length,2,'both refusals are kept: the second was not taken from the cache');assert.match(kept[0].words,/no room left for another screen result/);
});
test('F: skipped calls of other tools keep their arguments; only run_screen\'s are replaced',async()=>{
  let sent;const calls=[...Array.from({length:6},(_,i)=>({name:'search_securities',callId:'q'+i,args:{query:String(i)}})),{name:'screen_market',callId:'m',args:{market:'US'}},{name:'run_screen',callId:'s',args:{script:'print(SCRIPTBODY)'}}];
  const request=async({continuation})=>{if(!continuation)return {toolCalls:calls,continuation:calls.map(c=>({type:'function_call',call_id:c.callId,name:c.name,arguments:JSON.stringify(c.args)}))};sent=JSON.stringify(continuation);return {plan:{summary:'s',cashTargetPct:null,focus:'',targets:[]}};};
  await scout.runScout({request,tools:{search_securities:async()=>({rows:[]})},log:()=>{}});assert.ok(sent.includes('\\"market\\":\\"US\\"'),'the skipped screen_market keeps what it asked');assert.ok(sent.includes('# not run (over this round\'s tool limit): print(SCRIPTBODY)'),'a skipped run_screen is a stand-in that says so');assert.ok(!sent.includes('\\"script\\":\\"print(SCRIPTBODY)\\"'),'its script is not kept');
});
