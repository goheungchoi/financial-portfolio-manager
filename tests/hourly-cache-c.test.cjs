// Hourly cache, stage C (handoff 2026-11-25 and its additions): the keep-alive. The client keeps the skeleton of the last
// review call written with the one-hour lifetime and sends it back byte for byte with one fixed message, no mark and
// max_tokens 1; the engine sends it about 55 minutes after the entry was written or renewed, at most 2 in a row, only
// while everything that makes it useful holds; it is counted, shown, never a review, and a failure or a write stops it.
// Fake transports and a mock provider only: no request leaves the process.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {adapt}=require('./fixtures/claude-flat.cjs');const {AnthropicClient}=require('../electron/anthropic-client.cjs');
const KEY='sk-ant-api03-'+'k'.repeat(40);const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const USAGE={input_tokens:1200,cache_read_input_tokens:9000,cache_creation_input_tokens:3000,output_tokens:400};
const reply=(over={})=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'s'},{type:'text',text:JSON.stringify(hold)}],stop_reason:'end_turn',stop_details:null,usage:USAGE,input_transformations:[],...over});
const PING={id:'p',type:'message',role:'assistant',model:'claude-opus-5-5',content:[],stop_reason:'max_tokens',stop_details:null,usage:{input_tokens:12,cache_read_input_tokens:24800,cache_creation_input_tokens:0,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:0},output_tokens:1}};
function transport(...replies){const sent=[];const fn=async(url,init)=>{const body=JSON.parse(init.body);sent.push(body);const r=replies.length>1?replies.shift():replies[0];
  if(r.status)return new Response(JSON.stringify({type:'error',error:{type:r.type,message:'x'}}),{status:r.status,headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify(r===PING?r:adapt(r,body)),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;}
const CTX={universe:[{symbol:'990001'}],quotes:[{symbol:'990001',price:10000}]};
const skeleton=b=>{const {messages,max_tokens,cache_control,...rest}=b;return JSON.stringify(rest);};

test('the client: the keep-alive sends the review call\'s skeleton byte for byte, one fixed message, no mark, max_tokens 1',async()=>{
  const t=transport(reply(),PING);const c=new AnthropicClient(KEY,t);await c.decide(CTX,{...CLAUDE,cacheHour:true,keepPrefix:true});const r=await c.keepAlive();
  const [review,ping]=t.sent;assert.equal(skeleton(ping),skeleton(review),'model, tier, betas, system with its 1h marks, thinking, output_config (effort and format)');
  assert.match(JSON.stringify(review.system),/"ttl":"1h"/);assert.ok(review.output_config.format,'the format the review sent is sent again');
  assert.equal(ping.max_tokens,1);assert.deepEqual(ping.messages,[{role:'user',content:'Keep-alive. No answer is needed.'}]);assert.ok(!('cache_control' in ping),'no top-level mark');
  assert.doesNotMatch(JSON.stringify(ping.messages),/990001|cache_control/,'no account data and no mark in the message');
  assert.equal(r.stopReason,'max_tokens');assert.deepEqual(r.cache,{read:24800,write:0,write5m:0,write1h:0});assert.equal(r.usage.cachedTokens,24800);
});

test('the client: a five-minute review clears the skeleton; a replay or a dry run leaves it; nothing kept means no request',async()=>{
  {const t=transport(reply());const c=new AnthropicClient(KEY,t);await c.decide(CTX,{...CLAUDE,cacheHour:true,keepPrefix:true});await c.decide(CTX,{...CLAUDE,keepPrefix:true});
    assert.deepEqual(await c.keepAlive(),{skipped:'NO_PREFIX'});assert.equal(t.sent.length,2,'no keep-alive request was sent');}
  {const t=transport(reply(),reply(),reply(),PING);const c=new AnthropicClient(KEY,t);await c.decide(CTX,{...CLAUDE,cacheHour:true,keepPrefix:true});
    await c.decide(CTX,{...CLAUDE,instructionSet:'proposed'});await c.decide({...CTX,dry:1},{...CLAUDE,cacheHour:true});await c.keepAlive();
    assert.equal(skeleton(t.sent[3]),skeleton(t.sent[0]),'the review\'s skeleton, not the replay\'s or the dry run\'s');}
});

test('the client: a refusal is KEEP_ALIVE_FAILED with the status and type only (max_tokens 1 not accepted)',async()=>{
  const t=transport(reply(),{status:400,type:'invalid_request_error'});const c=new AnthropicClient(KEY,t);await c.decide(CTX,{...CLAUDE,cacheHour:true,keepPrefix:true});
  await assert.rejects(c.keepAlive(),e=>e.message==='KEEP_ALIVE_FAILED'&&e.detail.status===400&&e.detail.type==='invalid_request_error'&&!JSON.stringify(e.detail).includes(KEY));
});

// The engine with a mock provider: a real Automation (paper tables) set to a live Claude scope with the schedule stubbed.
const MIN=60000;
function engine({answer=async()=>({vendor:'anthropic',model:'claude-opus-5-5',usage:{inputTokens:24813,outputTokens:1,cachedTokens:24800,cacheWriteTokens:0,serviceTier:'standard'},stopReason:'max_tokens',cache:{read:24800,write:0,write5m:0,write1h:0}})}={}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const paper=new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]);const sent=[],logs=[];
  const a=new Automation(db,paper,{request:async(op,payload)=>{sent.push([op,payload]);if(op==='keep-alive')return answer();throw new Error('not in this fixture: '+op);}},(id,kind,title,body)=>logs.push({kind,title,body}));
  a.providerStatus.aiConnected=true;a.providerStatus.anthropicConnected=true;a.configure({provider:'openai',reasoningEffort:'medium'});a.config.openaiModel='claude-opus-5-5';
  a.config.enabled=true;a.config.scope='kis';a.sessionArmed=true;let next=null,open=true;a.nextReviewAt=()=>next;a.sessionOpen=()=>open;a.scoutMarkets=()=>['KR'];a.watchScope=()=>'kis:x';
  const t0=Date.now();a.keepAliveEntry={at:t0,pings:0,lastPingAt:null,model:'claude-opus-5-5',stamp:a.prefixStamp()};
  const ctl={a,db,sent,logs,t0,setNext:v=>{next=v;},setOpen:v=>{open=v;},pings:()=>sent.filter(([op])=>op==='keep-alive').length,
    tick:async at=>{a.keepAliveTick(at);await new Promise(r=>setTimeout(r,5));while(a.keepAliveBusy)await new Promise(r=>setImmediate(r));}};
  return ctl;}
const rows=db=>db.prepare('SELECT payload FROM ai_calls').all().map(r=>JSON.parse(r.payload));

test('the engine: once at 55 minutes, then at most once more without a review; counted, shown, never a review',async()=>{
  const c=engine();const {a,db,t0}=c;c.setNext(t0+60*MIN);
  await c.tick(t0+54*MIN);assert.equal(c.pings(),0,'not before 55 minutes');
  await c.tick(t0+55*MIN);assert.equal(c.pings(),1);assert.equal(a.keepAliveEntry.pings,1);
  const row=rows(db).find(r=>r.kind==='keep-alive');assert.equal(row.status,'completed');assert.ok(row.estimatedMicro>0&&row.estimatedMicro<20000,'about $0.005: '+row.estimatedMicro);
  assert.ok(c.logs.some(l=>l.title==='Kept the saved instructions for the next review'&&/^about \$0\.00\d\. 24,800 tokens read/.test(l.body)));
  assert.equal(db.prepare('SELECT calls FROM ai_usage').get().calls,1,'counted in the daily calls');
  assert.equal(a.lastRun,0,'no review clock set');assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews').get().n,0,'no review stored');
  const second=a.keepAliveEntry.lastPingAt;c.setNext(second+60*MIN);await c.tick(second+54*MIN);assert.equal(c.pings(),1);await c.tick(second+55*MIN);assert.equal(c.pings(),2);
  const third=a.keepAliveEntry.lastPingAt;c.setNext(third+60*MIN);await c.tick(third+55*MIN);assert.equal(c.pings(),2,'at most 2 in a row without a review');
});

test('the engine: none while a review runs, stopped, waiting, over budget, closed at the next review, no review within the hour, or another model',async()=>{
  const at=t=>t+55*MIN;
  {const c=engine();c.setNext(c.t0+60*MIN);c.a.busy=true;await c.tick(at(c.t0));assert.equal(c.pings(),0,'a review is running');}
  {const c=engine();c.setNext(c.t0+60*MIN);c.a.config.enabled=false;await c.tick(at(c.t0));assert.equal(c.pings(),0,'auto trading stopped');}
  {const c=engine();c.setNext(c.t0+60*MIN);c.a.providerWaitFor=()=>Date.now()+MIN;await c.tick(at(c.t0));assert.equal(c.pings(),0,'the provider is waiting');}
  {const c=engine();c.setNext(c.t0+60*MIN);c.a.budgetBlocked=()=>true;await c.tick(at(c.t0));assert.equal(c.pings(),0,'over the budget or call cap');assert.equal(rows(c.db).length,0);}
  {const c=engine();c.setNext(c.t0+60*MIN);c.setOpen(false);await c.tick(at(c.t0));assert.equal(c.pings(),0,'closed when the next review starts');}
  {const c=engine();c.setNext(c.t0+122*MIN);await c.tick(at(c.t0));assert.equal(c.pings(),0,'no scheduled review within the hour');}
  {const c=engine();c.setNext(null);await c.tick(at(c.t0));assert.equal(c.pings(),0,'none scheduled');}
  {const c=engine();c.setNext(c.t0+60*MIN);c.a.config.openaiModel='gpt-6-sol';await c.tick(at(c.t0));assert.equal(c.pings(),0,'OpenAI: never');}
  {const c=engine();c.setNext(c.t0+60*MIN);await c.tick(c.t0+61*MIN);assert.equal(c.pings(),0,'past the hour: lapsed');assert.equal(c.a.keepAliveEntry.stopped,'lapsed');}
  {const c=engine();c.setNext(c.t0+60*MIN);c.a.config.reasoningEffort='high';await c.tick(at(c.t0));assert.equal(c.pings(),0,'a setting that shapes the prefix changed');assert.equal(c.a.keepAliveEntry.stopped,'settings changed');}
});

test('the engine: a keep-alive whose usage shows a write stops for that entry, said once',async()=>{
  const c=engine({answer:async()=>({vendor:'anthropic',model:'claude-opus-5-5',usage:{inputTokens:24813,outputTokens:1,cachedTokens:0,cacheWriteTokens:24800,serviceTier:'standard'},stopReason:'max_tokens',cache:{read:0,write:24800,write5m:0,write1h:24800}})});
  c.setNext(c.t0+60*MIN);await c.tick(c.t0+55*MIN);assert.equal(c.a.keepAliveEntry.stopped,'wrote');
  assert.equal(c.logs.filter(l=>l.title==='Keeping the saved instructions stopped').length,1);
  c.a.keepAliveEntry.lastPingAt=null;await c.tick(c.t0+56*MIN);assert.equal(c.pings(),1,'no more for that entry');
});

test('the engine: a refused keep-alive (max_tokens 1 not accepted) is logged once, stops for the session, and starts no provider wait',async()=>{
  const c=engine({answer:async()=>{throw Object.assign(new Error('KEEP_ALIVE_FAILED'),{detail:{status:400,type:'invalid_request_error'}});}});
  c.setNext(c.t0+60*MIN);await c.tick(c.t0+55*MIN);assert.equal(c.a.keepAliveEntry.stopped,'failed');
  assert.deepEqual(c.a.providerWaitState(),[],'no provider wait');assert.equal(c.a.reviewBackoff().count??0,0,'no review backoff');
  const fail=c.logs.filter(l=>l.title==='Keeping the saved instructions failed');assert.equal(fail.length,1);assert.match(fail[0].body,/HTTP 400, invalid_request_error/);
  assert.equal(rows(c.db).find(r=>r.kind==='keep-alive').status,'failed-or-uncertain');
  c.a.keepAliveEntry={...c.a.keepAliveEntry,stopped:null};c.answer=null;await c.tick(c.t0+56*MIN);
  assert.equal(c.logs.filter(l=>l.title==='Keeping the saved instructions failed').length,1,'said once per session');
});

test('the review sets the entry at its start when it writes the one-hour form, and clears it when it does not',async()=>{
  const {Automation}=require('../electron/automation.cjs');
  for(const value of [true,false]){const a=Object.create(Automation.prototype);a.cacheHourFor=()=>value;a.prefixStamp=()=>'s';
    // The line in review() that decides it, run as the review runs it.
    const id='r1',startedAt=1795600000000,modelConfig={openaiModel:'claude-opus-5-5'};
    const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');assert.ok(src.includes('this.keepAliveEntry=this.cacheHourReview.value?{at:startedAt,pings:0,lastPingAt:null,model:modelConfig.openaiModel,stamp:this.prefixStamp()}:null;'));
    if(a.cacheHourReview?.id!==id){a.cacheHourReview={id,value:a.cacheHourFor(startedAt,modelConfig.openaiModel)};a.keepAliveEntry=a.cacheHourReview.value?{at:startedAt,pings:0,lastPingAt:null,model:modelConfig.openaiModel,stamp:a.prefixStamp()}:null;}
    assert.deepEqual(a.keepAliveEntry,value?{at:startedAt,pings:0,lastPingAt:null,model:'claude-opus-5-5',stamp:'s'}:null);}
});

// Review of stage C (review-stage-c.md), one test per change.
test('review 1: a refused keep-alive stops them for the session: two more reviews at their hours send nothing more, said once',async()=>{
  const c=engine({answer:async()=>{throw Object.assign(new Error('PROVIDER_REQUEST_FAILED'),{detail:{status:400,type:'invalid_request_error'}});}});
  c.setNext(c.t0+60*MIN);await c.tick(c.t0+55*MIN);assert.equal(c.a.keepAliveOff,'failed');
  for(const k of [1,2]){const at=c.t0+k*60*MIN;c.a.keepAliveEntry={at,pings:0,lastPingAt:null,model:'claude-opus-5-5',stamp:c.a.prefixStamp()};c.setNext(at+60*MIN);await c.tick(at+55*MIN);}
  assert.equal(c.pings(),1,'one request in all');assert.equal(c.logs.filter(l=>l.title==='Keeping the saved instructions failed').length,1);
  assert.equal(c.a.keepAliveView().off,'failed','the runtime state says why');
});

test('review 2: never an older skeleton: the client answers STALE and sends nothing; a review that fails before any call clears the entry',async()=>{
  const t=transport(reply(),PING);const cl=new AnthropicClient(KEY,t);await cl.decide(CTX,{...CLAUDE,cacheHour:true,keepPrefix:true});
  const kept=cl.keepAlivePrefix.at;assert.deepEqual(await cl.keepAlive({notBefore:kept+1}),{skipped:'STALE'});assert.equal(t.sent.length,1,'nothing sent');
  const ok=await cl.keepAlive({notBefore:kept});assert.equal(ok.cache.read,24800);
  // The engine: the review's own failure path, with a provider that refuses the decision.
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const paper=new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]);
  const a=new Automation(db,paper,{request:async op=>{if(op==='decision')throw new Error('AI_REQUEST_FAILED');return {};}},()=>{});a.providerStatus.aiConnected=true;
  a.configure({provider:'openai',reasoningEffort:'low'});a.cacheHourFor=()=>true;a.prefixStamp=()=>'s';a.keepAliveEntry={at:1,pings:0,lastPingAt:null,model:'x',stamp:'s'};
  await a.review('User request').catch(()=>{});assert.equal(a.keepAliveEntry,null,'no entry after a review whose calls all failed');db.close();
});

test('review 3: a keep-alive that would start after the hour sends nothing (LATE), checked on the client\'s clock when about to send',async()=>{
  let now=1795600000000;const t=transport(reply(),PING);const cl=new AnthropicClient(KEY,t,{clock:()=>now});await cl.decide(CTX,{...CLAUDE,cacheHour:true,keepPrefix:true});
  now+=61*MIN;assert.deepEqual(await cl.keepAlive({notBefore:0,deadline:1795600000000+60*MIN}),{skipped:'LATE'});assert.equal(t.sent.length,1);
  const c=engine({answer:async()=>({skipped:'LATE'})});c.setNext(c.t0+60*MIN);await c.tick(c.t0+55*MIN);
  assert.equal(c.a.keepAliveEntry.stopped,'lapsed');const [,p]=c.sent.find(([op])=>op==='keep-alive');assert.deepEqual([p.options.notBefore,p.options.deadline],[c.t0,c.t0+60*MIN]);
});

test('review 4: the keep-alive times out in 20 s, below the worker cap, so a review due meanwhile waits at most that; a broken answer is caught',async()=>{
  const R=require('../electron/ai-router.cjs');assert.equal(R.CLAUDE_TIMEOUT_MS.keepAlive,20000);assert.ok(R.workerCapMs('keep-alive',{options:{openaiModel:'claude-opus-5-5'}})>20000);
  const c=engine({answer:async()=>undefined});c.setNext(c.t0+60*MIN);await c.tick(c.t0+55*MIN);assert.equal(c.a.keepAliveBusy,false,'no unhandled rejection; the flag clears');
});

test('review 5: a replay or any non-review caller leaves the skeleton; a skipped keep-alive is not counted and keeps no reservation',async()=>{
  const t=transport(reply(),reply(),PING);const cl=new AnthropicClient(KEY,t);await cl.decide(CTX,{...CLAUDE,cacheHour:true,keepPrefix:true});
  await cl.decide(CTX,{...CLAUDE});await cl.keepAlive();assert.equal(skeleton(t.sent[2]),skeleton(t.sent[0]),'a replay of the current set left it');
  const c=engine({answer:async()=>({skipped:'NO_PREFIX'})});c.setNext(c.t0+60*MIN);await c.tick(c.t0+55*MIN);
  assert.equal(rows(c.db).filter(r=>r.kind==='keep-alive').length,0,'no row');const u=c.db.prepare('SELECT calls,reservedMicro FROM ai_usage').get();assert.deepEqual([u.calls,u.reservedMicro],[0,0]);
  assert.equal(c.a.keepAliveEntry.stopped,'no_prefix');
});

// Follow-up after the second review (two hardening points).
test('follow-up 1: an answer of no known shape stops the entry and settles its row; later ticks send nothing more',async()=>{
  const c=engine({answer:async()=>undefined});c.setNext(c.t0+60*MIN);await c.tick(c.t0+55*MIN);await c.tick(c.t0+56*MIN);await c.tick(c.t0+57*MIN);
  assert.equal(c.pings(),1);assert.equal(c.a.keepAliveEntry.stopped,'unexpected');
  const ka=rows(c.db).filter(r=>r.kind==='keep-alive');assert.equal(ka.length,1);assert.equal(ka[0].status,'failed-or-uncertain','not left pending');
});

test('follow-up 2: releaseCall takes back only a row still pending',()=>{
  const c=engine();const {a,db}=c;const day=require('../electron/kis-activity.cjs').seoulDate();
  a.reserveCall({openaiModel:'claude-opus-5-5'},10000,'k1',day,JSON.stringify({kind:'keep-alive',status:'pending',reservedMicro:10000}));
  assert.equal(a.releaseCall('claude-opus-5-5',10000,'never-reserved',day),false,'an id never reserved changes nothing');
  assert.deepEqual(Object.values(db.prepare('SELECT calls,reservedMicro FROM ai_usage').get()),[1,10000]);
  assert.equal(a.releaseCall('claude-opus-5-5',10000,'k1',day),true);assert.deepEqual(Object.values(db.prepare('SELECT calls,reservedMicro FROM ai_usage').get()),[0,0]);
  assert.equal(a.releaseCall('claude-opus-5-5',10000,'k1',day),false,'a second release changes nothing');assert.deepEqual(Object.values(db.prepare('SELECT calls,reservedMicro FROM ai_usage').get()),[0,0]);
  a.reserveCall({openaiModel:'claude-opus-5-5'},10000,'k2',day,JSON.stringify({kind:'keep-alive',status:'pending',reservedMicro:10000}));
  require('../electron/ai-accounting.cjs').settle(db,'ai_usage',day,'k2',{model:'claude-opus-5-5',usage:null},'failed-or-uncertain');
  const before=db.prepare('SELECT calls,reservedMicro FROM ai_usage').get();assert.equal(a.releaseCall('claude-opus-5-5',10000,'k2',day),false,'a settled row is not taken back');
  assert.deepEqual(db.prepare('SELECT calls,reservedMicro FROM ai_usage').get(),before);
});
