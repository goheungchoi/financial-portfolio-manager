// Isolated provider test (artifacts/reviews/2026-11-05-provider-test-design.md): the runner's guards, budget, fixture
// and report, offline. The network guard is installed for this whole test process first, as the runner does.
const guard=require('../scripts/provider-test/guard.cjs').install();
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {Meter,OVERHEAD_TOKENS}=require('../scripts/provider-test/meter.cjs');const {controlledTransport,URL}=require('../scripts/provider-test/transport.cjs');
const F=require('../scripts/provider-test/fixture.cjs');const P=require('../scripts/provider-test/paths.cjs');const S=require('../scripts/provider-test/state.cjs');
const {runTest}=require('../scripts/provider-test/run.cjs');
const denied=fn=>{let e=null;try{const r=fn();if(r&&typeof r.then==='function')r.catch(()=>{});}catch(x){e=x;}assert.equal(e?.message,'ISOLATED_NETWORK_DENIED');};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'fpm-provider-test-'));

test('every network and process path the app could use is refused outside the controlled transport',async()=>{
  const net=require('node:net'),tls=require('node:tls'),dns=require('node:dns'),http=require('node:http'),https=require('node:https'),http2=require('node:http2'),dgram=require('node:dgram'),cp=require('node:child_process'),wt=require('node:worker_threads');
  const before=guard.attempts.length;
  denied(()=>fetch('https://api.openai.com/v1/responses'));denied(()=>fetch('https://openapi.koreainvestment.com:9443/'));
  if(globalThis.WebSocket)denied(()=>new WebSocket('wss://example.com'));if(globalThis.EventSource)denied(()=>new EventSource('https://example.com'));
  denied(()=>http.request('http://example.com'));denied(()=>http.get('http://example.com'));denied(()=>https.request('https://example.com'));denied(()=>https.get('https://api.openai.com'));
  denied(()=>http2.connect('https://example.com'));denied(()=>net.connect(443,'example.com'));denied(()=>net.createConnection({host:'example.com',port:80}));
  denied(()=>new net.Socket().connect(443,'example.com'));denied(()=>net.connect('\\\\.\\pipe\\portfolio-agent'));denied(()=>tls.connect(443,'example.com'));
  // The permitted host is refused too while no controlled request is in flight.
  denied(()=>tls.connect({host:'api.openai.com',port:443}));denied(()=>dns.lookup('api.openai.com',()=>{}));
  denied(()=>dns.lookup('example.com',()=>{}));denied(()=>dns.promises.lookup('example.com'));denied(()=>dns.resolve4('example.com',()=>{}));denied(()=>dgram.createSocket('udp4'));
  for(const name of ['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync'])denied(()=>cp[name]('tasklist'));denied(()=>new wt.Worker('x.js'));
  // The app's own clients built after the guard get the refusing fetch.
  const {AiClient}=require('../electron/ai-client.cjs');await assert.rejects(new AiClient('sk-fixture-key-123').decide({universe:[],quotes:[]},{openaiModel:'gpt-6-luna',reasoningEffort:'none'}));
  assert.ok(guard.attempts.length-before>=25,'each attempt is recorded');
});
const body=(extra={})=>JSON.stringify({model:'gpt-6-sol',service_tier:'default',max_output_tokens:8192,instructions:'x'.repeat(5000),tools:[{type:'function',name:'t',parameters:{}}],input:[{role:'user',content:'y'.repeat(20000)}],...extra});
const ok=(usage={input_tokens:100,output_tokens:100,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:60}})=>async()=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage,output:[]}),{status:200});
test('the reservation bounds the whole serialized request and refuses what it cannot price',async()=>{
  const m=new Meter();const b=body();const e=m.reserve(b);
  assert.equal(e.inputTokens,Buffer.byteLength(b)+OVERHEAD_TOKENS,'instructions, tools and input are all in the bound');assert.equal(e.reservedMicro,Math.ceil(e.inputTokens*2+8192*10));
  for(const [bad,reason] of [[{model:'gpt-unknown'},'unknown model pricing'],[{max_output_tokens:undefined},'no explicit max_output_tokens'],[{service_tier:'priority'},'unknown service tier']]){
    let sent=0;const t=controlledTransport({send:async()=>{sent++;return ok()();},guard,meter:new Meter()});await assert.rejects(t(URL,{method:'POST',body:body(bad)}),e=>e.message==='BUDGET_STOP'&&e.reason===reason);assert.equal(sent,0,reason+': not sent');}
  // Long requests take the long-context rates.
  assert.equal(new Meter().bound(body({input:'z'.repeat(300000)})).long,true);
});
test('six requests and $0.50 in all; a request that cannot fit is not started; concurrent reservations cannot overcommit',async()=>{
  let sent=0;const meter=new Meter({requests:6,usd:0.5});const t=controlledTransport({send:async(...a)=>{sent++;return ok()(...a);},guard,meter});
  const small=JSON.stringify({model:'gpt-6-luna',service_tier:'default',max_output_tokens:100,input:'hi'});
  for(let i=0;i<6;i++)await t(URL,{method:'POST',body:small});await assert.rejects(t(URL,{method:'POST',body:small}),e=>e.reason==='request limit');assert.equal(sent,6);
  // Two at once against a ceiling that fits one: the second is refused before anything is sent.
  sent=0;const m2=new Meter({requests:6,usd:0.2});let release;const slow=controlledTransport({send:()=>new Promise(r=>{release=()=>r(ok()());}),guard,meter:m2});
  const first=slow(URL,{method:'POST',body:body()});await assert.rejects(slow(URL,{method:'POST',body:body()}),e=>e.reason==='dollar ceiling');release();await first;
  // A failure of unknown cost keeps its whole reservation.
  const m3=new Meter();const failing=controlledTransport({send:async()=>{throw Object.assign(new Error('timed out'),{name:'TimeoutError'});},guard,meter:m3});
  await assert.rejects(failing(URL,{method:'POST',body:body()}));assert.equal(m3.entries[0].status,'unknown-cost');assert.equal(m3.committed(),m3.entries[0].reservedMicro);
  // Reasoning tokens are part of the output tokens: billed once, reported apart.
  const m4=new Meter();await controlledTransport({send:ok(),guard,meter:m4})(URL,{method:'POST',body:body()});const e=m4.entries[0];
  assert.equal(e.actualMicro,100*2+100*10,'100 input, 100 output (60 of them reasoning) at gpt-6-sol rates');assert.equal(e.reasoningTokens,60);assert.equal(e.boundHeld,true);
});
test('the transport refuses other destinations, other methods and redirects, and reports a provider rejection',async()=>{
  const meter=new Meter();let seen=null;const t=controlledTransport({send:async(u,init)=>{seen=init;return new Response('',{status:302,headers:{location:'https://elsewhere'}});},guard,meter});
  await assert.rejects(t('https://api.openai.com/v1/chat/completions',{method:'POST',body:body()}),/ISOLATED_DESTINATION_REFUSED/);await assert.rejects(t(URL,{method:'GET'}),/ISOLATED_DESTINATION_REFUSED/);
  await assert.rejects(t(URL,{method:'POST',body:body(),redirect:'follow'}),/ISOLATED_DESTINATION_REFUSED/);assert.equal(seen.redirect,'error','redirects are never followed');
  const log=[];const r=controlledTransport({send:async()=>new Response(JSON.stringify({error:{type:'invalid_request_error',code:'invalid_json_schema',param:'text.format',message:'bad schema'}}),{status:400}),guard,meter:new Meter(),log});
  const res=await r(URL,{method:'POST',body:body()});assert.equal(res.status,400);assert.equal(log[0].status,'rejected');assert.equal(log[0].providerError.code,'invalid_json_schema');
});
// A small source database with a recorded dry run, for composing.
function source({credential=false}={}){const dir=tmp(),file=path.join(dir,'source.sqlite');const db=new DatabaseSync(file);const cut=Date.parse('2026-11-04T13:30:43.134Z');const MIN=60000;
  db.exec('CREATE TABLE dry_runs(id TEXT PRIMARY KEY,timestamp INTEGER,payload TEXT);CREATE TABLE trade_outcomes(id TEXT PRIMARY KEY,payload TEXT);CREATE TABLE outcome_versions(outcomeId TEXT,version INTEGER,signature TEXT,payload TEXT,recordedAt INTEGER);CREATE TABLE reviews(id TEXT PRIMARY KEY,payload TEXT)');
  const snapshot={environment:'kis-combined',currency:'KRW',universe:[{symbol:'028050'}],quotes:[{symbol:'028050',price:100,stale:true}],positions:{'028050':{quantity:1}},equity:1000,marketSession:{open:false,status:'closed'},waits:[{symbol:'028050',reason:'r'}],discovery:{enabled:true},agentDesk:{conditionalOrders:{allowed:false}},...(credential?{connection:{appKey:'abcdef123456'}}:{})};
  const transcript=[{at:'2026-11-04T13:30:50.000Z',title:'Market data request',body:'{"symbol":"028050","dataset":"daily_technicals"}'},{at:'2026-11-04T13:30:51.000Z',title:'Market data result',body:'{"status":"available","bars":[1,2,3]}'},
    {at:'2026-11-04T13:30:55.000Z',title:'Discovery request',body:'{"symbol":"028050","sections":["events"]}'},{at:'2026-11-04T13:30:57.000Z',title:'Discovery result',body:'{"x":"'+'a'.repeat(3994)}];
  db.prepare('INSERT INTO dry_runs VALUES(?,?,?)').run('4c76aa03-test',cut+60000,JSON.stringify({summary:{assembledAt:'2026-11-04T13:30:43.134Z',account:{key:'acct',label:'KIS live'},sessions:{KR:'closed',US:'closed'},quotes:{count:1,stale:1}},snapshot,review:{model:'gpt-6-sol',effort:'medium',calls:3,costUSD:0.12,transcript}}));
  const outcome=(id,t,price,extra={})=>({id,source:'broker',accountKey:'acct',symbol:'028050',side:'Buy',status:'Filled',quantity:1,averagePrice:price,timestamp:t,reviewId:'rev-'+id,updatedAt:t,...extra});
  // A: revised after the cutoff (the version in force then is the first). B: filled after the cutoff. Reviews: one before, one after.
  db.prepare('INSERT INTO trade_outcomes VALUES(?,?)').run('A',JSON.stringify(outcome('A',cut-3*86400000,100,{updatedAt:cut+DAY})));db.prepare('INSERT INTO outcome_versions VALUES(?,?,?,?,?)').run('A',1,'s',JSON.stringify(outcome('A',cut-3*86400000,100)),cut-3*86400000);
  db.prepare('INSERT INTO outcome_versions VALUES(?,?,?,?,?)').run('A',2,'s',JSON.stringify(outcome('A',cut-3*86400000,999)),cut+DAY);
  db.prepare('INSERT INTO trade_outcomes VALUES(?,?)').run('B',JSON.stringify(outcome('B',cut+10*MIN,120)));
  db.prepare('INSERT INTO reviews VALUES(?,?)').run('rev-A',JSON.stringify({timestamp:cut-3*86400000-MIN,account:{key:'acct'}}));db.prepare('INSERT INTO reviews VALUES(?,?)').run('later',JSON.stringify({timestamp:cut+5*MIN,account:{key:'acct'}}));
  db.close();return {dir,file,cut};}
const DAY=86400000;
test('the composed fixture uses only what was in force at the cutoff, says where each field came from, and keeps the recorded flags',()=>{
  const {file}=source();const f=F.compose({source:file,dryRun:'4c76aa03'});
  assert.equal(f.meta.kind,'synthetic compatibility fixture');assert.equal(f.meta.cutoff,'2026-11-04T13:30:43.134Z');assert.deepEqual(f.meta.session,{KR:'closed',US:'closed'});
  assert.deepEqual(f.context.marketSession,{open:false,status:'closed'},'session as recorded');assert.equal(f.context.quotes[0].stale,true,'staleness as recorded');assert.deepEqual(f.context.waits,[{symbol:'028050',reason:'r'}],'waits kept as recorded, not converted');
  const m=f.context.positionMemory;assert.equal(m.length,1);assert.equal(m[0].lastEntry.fillPrice,100,'the version in force at the cutoff, not the later revision');
  assert.deepEqual(f.meta.excludedAfterCutoff.map(x=>x.id),['B'],'a later fill is left out');assert.match(f.provenance.positionMemory.method,/1 reviews made by then/);
  for(const k of Object.keys(f.context))assert.ok(f.provenance[k]?.source&&'at' in f.provenance[k]&&f.provenance[k].method,`provenance for ${k}`);
  assert.equal(f.context.equityUncertainty.unavailable,true);assert.ok(f.meta.unavailable.some(u=>u.field==='equityUncertainty'));
  assert.deepEqual(f.tools.map(t=>[t.tool,t.status,t.recordedAt]),[['get_market_evidence','available','2026-11-04T13:30:51.000Z'],['get_company_research','truncated','2026-11-04T13:30:57.000Z']],'a timeline with the times results arrived');
  F.verify(f);assert.throws(()=>F.verify({...f,context:{...f.context,equity:2}}),/FIXTURE_ALTERED/);
  assert.throws(()=>F.compose({source:source({credential:true}).file,dryRun:'4c76aa03'}),/FIXTURE_HOLDS_CREDENTIALS/);
});
test('state that cannot be recovered at the cutoff is unavailable, never replaced by current state',()=>{
  const {file,cut}=source();const db=new DatabaseSync(file);db.prepare('INSERT INTO trade_outcomes VALUES(?,?)').run('C',JSON.stringify({id:'C',source:'broker',accountKey:'acct',symbol:'028050',side:'Sell',status:'Filled',quantity:1,averagePrice:110,timestamp:cut-DAY,updatedAt:cut+DAY}));db.close();
  const f=F.compose({source:file,dryRun:'4c76aa03'});assert.equal(f.context.positionMemory,undefined);assert.ok(f.meta.unavailable.some(u=>u.field==='positionMemory'&&u.outcomes.includes('C')));
});
test('fixture tools: an exact recorded request is served; anything else is unavailable; writes are not applied',async()=>{
  const f=F.compose({source:source().file,dryRun:'4c76aa03'});const s=F.server(f);
  assert.deepEqual(s.lookup('get_market_evidence',{dataset:'daily_technicals',symbol:'028050'}),{status:'available',bars:[1,2,3]},'argument order does not matter');
  assert.match(s.lookup('get_company_research',{symbol:'028050',sections:['events']}).reason,/cut off/);assert.match(s.lookup('screen_market',{}).reason,/does not fetch/);
  assert.equal((await s.inert('save_note')({symbol:'028050'})).status,'not-applied');assert.deepEqual(s.calls.map(c=>c.served),['recorded','unavailable: recording cut off','unavailable: not recorded','not applied']);
});
test('the test folder is kept apart from the live profile by real path, junctions and case included',()=>{
  const root=tmp(),live=path.join(root,'Live Profile');fs.mkdirSync(live);
  assert.throws(()=>P.separate(path.join(live,'test'),{live}),/ISOLATED_PATH_REFUSED/);assert.throws(()=>P.separate(root,{live}),/ISOLATED_PATH_REFUSED/);
  if(process.platform==='win32')assert.throws(()=>P.separate(path.join(live.toUpperCase(),'x'),{live}),/ISOLATED_PATH_REFUSED/);
  const link=path.join(root,'innocent');fs.symlinkSync(live,link,'junction');assert.throws(()=>P.separate(path.join(link,'run'),{live}),/ISOLATED_PATH_REFUSED/,'a junction into the live profile');
  assert.equal(P.separate(path.join(root,'elsewhere'),{live}).dir.toLowerCase(),path.join(fs.realpathSync.native(root),'elsewhere').toLowerCase());
});
test('the state comparison sees rows still in the write-ahead log',()=>{
  const file=path.join(tmp(),'w.sqlite');const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE t(x);INSERT INTO t VALUES(1)');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const a=S.snapshot(file);db.exec('INSERT INTO t VALUES(2)');const b=S.snapshot(file);db.close();
  const c=S.compare(a,b);assert.equal(c.unchanged,false);assert.deepEqual(c.changedTables,['t']);assert.equal(c.mainFileUnchanged,true,'the main file alone would have shown no change');
});
// End to end with a fake provider, on a composed fixture and a stand-in live profile.
function prepared(){const live=path.join(tmp(),'Live');fs.mkdirSync(live);const db=new DatabaseSync(path.join(live,'portfolio.sqlite'));db.exec('CREATE TABLE live_intents(x);INSERT INTO live_intents VALUES(1)');db.close();
  const dir=path.join(tmp(),'run');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'fixture.json'),JSON.stringify(F.compose({source:source().file,dryRun:'4c76aa03'})));return {dir,live};}
const reply=(output,usage={input_tokens:1000,output_tokens:50,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:10}})=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage,output}),{status:200});
const hold={type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'})}]};
const call=(name,args,i)=>({type:'function_call',name,call_id:'c'+i,arguments:JSON.stringify(args)});
test('the report separates acceptance, local validation and tool coverage; a Hold with no tools does not verify tool handling',async()=>{
  let x=prepared();let r=await runTest({...x,send:async()=>reply([hold]),key:'sk-fixture-key-123',mode:'test'});
  assert.equal(r.acceptance.providerAccepted,true);assert.equal(r.acceptance.finalResponseParsedAndValidated,true);assert.deepEqual(r.tools.exercised,[]);assert.match(r.tools.note,/does not verify tool handling/);
  assert.equal(r.statement.includes('not a validation of accounting'),true);assert.equal(r.state.live.unchanged,true);assert.deepEqual(r.state.files.after,['fixture.json','provider-test.sqlite','report.json','report.md']);
  // Tools exercised: a recorded result, a cut-off recording, an unrecorded request and a write.
  x=prepared();let n=0;r=await runTest({...x,send:async()=>++n===1?reply([call('get_market_evidence',{symbol:'028050',dataset:'daily_technicals'},1),call('get_company_research',{symbol:'028050',sections:['events']},2),call('get_market_evidence',{symbol:'028050',dataset:'order_book'},3),call('save_note',{symbol:'028050',text:'n'},4)]):reply([hold]),key:'sk-fixture-key-123',mode:'test'});
  assert.deepEqual(r.tools.calls.map(c=>c.served),['recorded','unavailable: recording cut off','unavailable: not recorded','not applied']);assert.ok(r.tools.notExercised.includes('compute'));assert.equal(r.cost.requests,2);
  // A provider rejection is reported as the provider's; a budget stop as local, with nothing sent.
  x=prepared();r=await runTest({...x,send:async()=>new Response(JSON.stringify({error:{type:'invalid_request_error',code:'invalid_json_schema',message:'no'}}),{status:400}),key:'sk-fixture-key-123',mode:'test'});
  assert.equal(r.acceptance.providerAccepted,false);assert.equal(r.acceptance.requests[0].providerError.code,'invalid_json_schema');assert.equal(r.acceptance.failure.side,'provider rejected a request');
  x=prepared();let sent=0;r=await runTest({...x,send:async()=>{sent++;return reply([hold]);},key:'sk-fixture-key-123',mode:'test',limits:{requests:6,usd:0.01}});
  assert.equal(sent,0);assert.equal(r.acceptance.failure.code,'BUDGET_STOP');assert.equal(r.acceptance.failure.side,'local');assert.equal(r.acceptance.localStops.length,1,'a budget stop is not retried');assert.equal(r.acceptance.providerAccepted,false,'nothing was sent, so nothing was accepted');
  // A retryable failure is retried through the meter: two requests.
  x=prepared();n=0;r=await runTest({...x,send:async()=>++n===1?new Response('{"error":{"type":"server_error"}}',{status:500}):reply([hold]),key:'sk-fixture-key-123',mode:'test'});assert.equal(r.cost.requests,2);assert.equal(r.acceptance.finalResponseParsedAndValidated,true);
  // A folder already used is refused; a run folder inside the live profile is refused.
  await assert.rejects(runTest({...x,send:async()=>reply([hold]),key:'sk-fixture-key-123',mode:'test'}),/ISOLATED_RUN_EXISTS/);
  await assert.rejects(runTest({dir:path.join(x.live,'run'),live:x.live,send:async()=>reply([hold]),key:'sk-fixture-key-123',mode:'test'}),/ISOLATED_PATH_REFUSED/);
});
test('condensing goes through the same meter as the review',async()=>{
  const meter=new Meter(),log=[];const t=controlledTransport({send:async()=>reply([{type:'message',content:[{type:'output_text',text:'{"digest":"d"}'}]}]),guard,meter,log});
  const {AiClient}=require('../electron/ai-client.cjs');await new AiClient('sk-fixture-key-123',t).compact({items:[]},{openaiModel:'gpt-6-luna',reasoningEffort:'none'}).catch(()=>{});
  assert.equal(log[0].kind,'compact');assert.equal(meter.entries.length,1);
});
