'use strict';
// S4 (artifacts/reviews/2026-11-23-after-b2/note-7-s4-design.md, with its rulings): reviews are offered run_screen in place
// of compute. Covered here: the tool text (facts only; the trigger's neutral single-formula text), triggers and conditional
// orders still take single formulas only, the final round in both clients and both loops, the user's rule for reviews
// ("it has to be checked if any of the failed script calls block or make reviews failed") case by case through the app
// (no review failure, streak, back-off or provider wait), a stale account during a script, the review's own universe and
// its daily-history fallback, the dry run reading nothing from KIS, the Journal record, and scripts against compute.
// Made-up symbols and prices; fake transports only: no request leaves the process.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const F=require('../electron/formula.cjs');const FS=require('../electron/formula-script.cjs');const SR=require('../electron/screen-run.cjs');
const U=require('../electron/screen-universe.cjs');const H=require('../electron/history-store.cjs');const {SecurityMaster}=require('../electron/security-master.cjs');
const scout=require('../electron/scout.cjs');const AI=require('../electron/ai-client.cjs');const {AnthropicClient}=require('../electron/anthropic-client.cjs');
const {researchReview,ROUNDS}=require('../electron/research-review.cjs');const {FormulaUse}=require('../electron/formula-use.cjs');
const D=require('../electron/agent-desk.cjs');const {adapt}=require('./fixtures/claude-flat.cjs');const {errorReply}=require('../electron/provider-error-reply.cjs');
const BANNED=[/above about/i,/means upward/i,/strong trend/i,/\bweak\b/i,/buying pressure/i,/stretched/i,/momentum/i,/overbought/i,/oversold/i];

test('the review is offered run_screen in place of compute; its text and the trigger\'s are facts only',()=>{
  const names=AI.reviewTools({universe:[],agentDesk:{conditionalOrders:{allowed:true}}}).map(t=>t.name);
  assert.equal(names.filter(n=>n==='run_screen').length,1);assert.ok(!names.includes('compute'));assert.ok(!AI.reviewTools({universe:[]}).some(t=>t.name==='run_screen'),'no desk: no run_screen');
  const r=scout.REVIEW_SCREEN_TOOL;assert.equal(r.name,'run_screen');assert.ok(r.description.endsWith(scout.REVIEW_HELP));assert.doesNotMatch(r.description,/scout run/);assert.match(r.description,/for the rest of this review/);assert.match(r.description,/120 and 40 a review/);
  assert.match(r.description,/\(live\(S\) \/ close\(S, n-1\) - 1\) \* 100/);assert.match(r.description,/zscore and ratio_z of the live quote cannot be written/);assert.match(r.description,/A trigger or conditional order evaluates its formula on the latest quote/);assert.match(r.description,/this review's own stocks/);assert.match(r.description,/universe\(own="review"\)/);
  assert.deepEqual(r.parameters,scout.SCREEN_TOOL.parameters,'the same arguments as the scout\'s');
  const t=D.TRIGGER_TOOL.description;assert.ok(t.endsWith(F.NEUTRAL_HELP));assert.doesNotMatch(t,/compute/);assert.match(t,/Each condition is a single formula compared with a number/);
  for(const d of [r.description,t,D.ORDER_TOOL.description])for(const b of BANNED)assert.doesNotMatch(d,b,String(b));
  assert.doesNotMatch(D.ORDER_TOOL.description,/compute/);
  for(const k of Object.keys(F.FUNCS))assert.ok(F.NEUTRAL_HELP.includes(k),'the neutral text names '+k);
});

test('triggers and conditional orders still take single formulas only: a script is refused, a formula is saved as before',()=>{
  let now=Date.parse('2026-11-23T01:00:00Z');const desk=new D.AgentDesk(new DatabaseSync(':memory:'),()=>now);const script='x = sma("005930",20)\nprint(x)';
  const trig=expr=>desk.setTrigger('kis:a',{action:'add',id:'',name:'T',conditions:[{expr,op:'>=',value:1}],combine:'all',expiresInHours:24,reason:'r'},{universe:['005930']});
  assert.notEqual(trig(script).status,'saved','a script is not a trigger condition');assert.equal(trig('price("005930")/sma("005930",20)').status,'saved');
  const on={...D.COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:5};
  const order=expr=>desk.setOrder('kis:a',{action:'add',id:'',symbol:'005930',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr,op:'<=',value:1}],combine:'all',purpose:'stop_loss',expiresInHours:48,reason:'r',replaces:null},{config:on,universe:['005930']});
  assert.ok(!['armed','saved'].includes(order(script).status),'a script is not an order condition');
  assert.throws(()=>F.parse(script),'the formula parser refuses a script as before');
});

// ---- The final round: both clients return the request flagged; both loops answer it once and ask again.
const KEY='sk-ant-api03-'+'k'.repeat(40);const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const USAGE={input_tokens:1200,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:400};
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const reply=({content=[{type:'thinking',thinking:'',signature:'s'},{type:'text',text:JSON.stringify(hold)}],stop_reason='end_turn'}={})=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content,stop_reason,stop_details:null,usage:USAGE,input_transformations:[]});
const screenUse=(id,script='print(close("005930",0))')=>reply({content:[{type:'thinking',thinking:'',signature:'s'+id},{type:'tool_use',id,name:'run_screen',input:{script}}],stop_reason:'tool_use'});
function transport(...replies){const sent=[];const fn=async(url,init)=>{sent.push(JSON.parse(init.body));const r=replies.length>1?replies.shift():replies[0];return new Response(JSON.stringify(adapt(r,JSON.parse(init.body))),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;}
const CTX={universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:217000}],agentDesk:{conditionalOrders:{allowed:false}}};

test('the clients: a tool request on a final request comes back flagged (OpenAI and Claude), never thrown',async()=>{
  const openai=new AI.AiClient('sk-fixture-key-123',async()=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage:{input_tokens:1,output_tokens:1},output:[{type:'function_call',call_id:'c1',name:'run_screen',arguments:JSON.stringify({script:'print(1)'})}]}),{status:200}));
  const o=await openai.decide(CTX,{openaiModel:'gpt-6-sol',reasoningEffort:'low',research:true,final:true,continuation:[]});assert.equal(o.finalToolUse,true);assert.equal(o.toolCalls[0].name,'run_screen');assert.deepEqual(o.toolCalls[0].args,{script:'print(1)'});
  const c=await new AnthropicClient(KEY,transport(screenUse('t1'))).decide(CTX,{...CLAUDE,research:true,final:true,continuation:[]});assert.equal(c.finalToolUse,true);assert.equal(c.toolCalls[0].name,'run_screen');
  const notFinal=await new AnthropicClient(KEY,transport(screenUse('t2'))).decide(CTX,{...CLAUDE,research:true});assert.ok(!('finalToolUse' in notFinal));
  // A run_screen request's size check is the tool's own (a long script is answered in words, not refused by the client).
  const long='print(1)\n'.repeat(700);const big=await new AnthropicClient(KEY,transport(screenUse('t3',long))).decide(CTX,{...CLAUDE,research:true});assert.ok(big.toolCalls[0].args.invalid,'over 6,000 bytes: {invalid}, answered by the tool');
});

const evidenceCall=(id)=>({name:'get_market_evidence',callId:id,args:{symbol:'005930',dataset:'company'}});
const fc=c=>({type:'function_call',call_id:c.callId,name:c.name,arguments:JSON.stringify(c.args)});
function reviewLoop(lastTwo){let round=0;const asked=[];const ran=[];
  const request=async opts=>{asked.push(opts);round++;if(round<ROUNDS){const c=evidenceCall('e'+round);return {toolCalls:[c],continuation:[...(opts.continuation??[]),fc(c)]};}
    return lastTwo(round-ROUNDS,opts);};
  const notRun=[];const tool=scout.screenTool({screen:async t=>{ran.push(t);return {lines:['1'],coverage:[]};}});
  return {asked,ran,notRun,run:()=>researchReview({context:{universe:[{symbol:'005930'}]},evidence:{get:async()=>({status:'ok'})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),actions:{run_screen:async(a,o)=>{if(o?.notRun)notRun.push(o.notRun);return tool(a,o);}},request})};}
test('the review loop: a tool request on the final round is answered "no tools in this round" and asked once more; a second one fails the review as before',async()=>{
  const calls=[{name:'run_screen',callId:'s9',args:{script:'u = universe(own="review")\nprint(top(u, ret(S,20), 3))'}},evidenceCall('e9')];
  const ok=reviewLoop((i,opts)=>i===0?{finalToolUse:true,toolCalls:calls,continuation:[...opts.continuation,...calls.map(fc)]}:{decision:hold});
  const r=await ok.run();assert.equal(r.decision.action,'Hold');assert.equal(ok.asked.length,ROUNDS+1);assert.deepEqual(ok.asked.slice(-2).map(o=>o.final),[true,true]);
  assert.equal(ok.ran.length,0,'nothing runs on the final round');assert.deepEqual(ok.notRun,['no tools in this round: give your answer now'],'the script is answered through the tool (recorded), not run');const last=ok.asked.at(-1).continuation;
  for(const id of ['s9','e9'])assert.match(last.find(x=>x.type==='function_call_output'&&x.call_id===id).output,/no tools in this round: give your answer now/);
  assert.match(last.find(x=>x.type==='function_call'&&x.call_id==='s9').arguments,/# not run \(no tools in the final round\)/,'the script is replaced by its stand-in, with its own reason');
  const twice=reviewLoop((i,opts)=>({finalToolUse:true,toolCalls:calls,continuation:[...opts.continuation,...calls.map(fc)]}));
  await assert.rejects(twice.run(),e=>e.message==='INVALID_AI_RESPONSE'&&e.detail.rule==='a tool request on the final round'&&e.detail.round===ROUNDS+1);
  // A review without research keeps its rule: a tool request fails it.
  await assert.rejects(researchReview({context:{universe:[]},evidence:null,log:()=>{},request:async()=>({toolCalls:[calls[0]],continuation:[]})}),e=>e.detail?.rule==='a tool request in a review without research');
});
test('the scout loop: the same, answered once and asked again; a second request fails the run',async()=>{
  const plan={summary:'s',cashTargetPct:null,focus:'',targets:[]};const call={name:'run_screen',callId:'f1',args:{script:'print(1)'}};
  const run=second=>{const sent=[];let n=0;const request=async({final,continuation})=>{sent.push({final,continuation});n++;if(!final)return {toolCalls:[{name:'run_screen',callId:'r'+n,args:{script:'print(1)'}}],continuation:[...(continuation??[]),{type:'function_call',call_id:'r'+n,name:'run_screen',arguments:'{"script":"print(1)"}'}]};
      if(sent.filter(s=>s.final).length===1)return {finalToolUse:true,toolCalls:[call],continuation:[...continuation,fc(call)]};return second();};
    return {sent,go:scout.runScout({request,tools:scout.focusTools({},{markets:['KR'],deferred:[]},{screen:async()=>({lines:['1'],coverage:[]})}),log:()=>{}})};};
  const ok=run(()=>({plan}));const r=await ok.go;assert.ok(r.plan);const last=ok.sent.at(-1);assert.equal(last.final,true);
  assert.match(last.continuation.find(x=>x.type==='function_call_output'&&x.call_id==='f1').output,/no tools in this round/);
  const bad=run(()=>({finalToolUse:true,toolCalls:[call],continuation:[]}));await assert.rejects(bad.go,e=>e.message==='INVALID_AI_RESPONSE');
});

// ---- The user's rule through the app: a failing script never fails, blocks or slows a review.
function automation(t){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Fixture',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const claude=new AnthropicClient(KEY,t);const viaWorker=async fn=>{try{return await fn();}catch(e){const r=errorReply('decision',e);throw Object.assign(new Error(r.code),{usage:r.usage,model:r.model,...(r.detail?{detail:r.detail}:{})});}};
  const provider={request:async(op,payload)=>{if(op!=='decision')throw new Error('PROVIDER_REQUEST_FAILED');return viaWorker(()=>claude.decide(payload.context,{...payload.options,...CLAUDE}));}};
  const a=new Automation(db,paper,provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({status:'ok'})};
  const warmed=[];a.series={closes:()=>null,ensure:async s=>{warmed.push(s);}};a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:false});
  return {a,db,warmed};
}
const counters=(a,db)=>({lastError:a.lastError??null,backoff:a.reviewBackoff(),failures:db.prepare('SELECT COALESCE(SUM(count),0) AS n FROM review_failures').get().n,streak:a.guardrails.state(a.config).failureStreak,providerWait:a.providerBackoff('anthropic')});
const CLEAN={lastError:null,backoff:{count:0,until:0},failures:0,streak:0,providerWait:{count:0,until:0}};
const toolResult=t=>JSON.stringify(t.sent[1].messages.at(-1));

test('the harness counts a real failure (so the clean counters below mean something)',async()=>{
  const t=transport(reply({content:[{type:'text',text:'not json'}]}));const {a,db}=automation(t);await assert.rejects(a.review('User request'));
  const c=counters(a,db);assert.equal(c.lastError,'INVALID_AI_RESPONSE');assert.equal(c.failures,1);assert.equal(c.streak,1);assert.equal(c.backoff.count,1);
});
for(const [name,setup,words] of [
  ['no screening engine in this run',a=>{delete a.openScreenRun;},/screens are not available in this run/],
  ['the run cannot be opened',a=>{a.openScreenRun=()=>{throw new Error('boom');};},/screens are not available in this run/],
  ['the engine fails with a code',a=>{a.openScreenRun=()=>async()=>{throw Object.assign(new Error('SCREEN_ENGINE_FAILED'),{code:'SCREEN_ENGINE_FAILED'});};},/could not be run \(SCREEN_ENGINE_FAILED\)/],
  ['the engine fails without a code',a=>{a.openScreenRun=()=>async()=>{throw new TypeError('x is not a function');};},/could not be run \(SCREEN_FAILED\)/],
  ['the script stops on a line',a=>{a.openScreenRun=()=>async()=>({lines:[],coverage:[],stopped:{line:1,words:'line 1: price() is not used in scripts'}});},/price\(\) is not used in scripts/],
  ['the request had no script',null,/the request had no script text/],
  ['the script is over the size limit',null,/the script was not run/],
]){
  test(`the user's rule, ${name}: the review completes, nothing counted as a failure, no back-off, no provider wait`,async()=>{
    const input=name==='the request had no script'?{}:name==='the script is over the size limit'?{script:'print(1)\n'.repeat(700)}:{script:'print(close("005930",0))'};
    const t=transport(reply({content:[{type:'thinking',thinking:'',signature:'s1'},{type:'tool_use',id:'tu1',name:'run_screen',input}],stop_reason:'tool_use'}),reply());const {a,db}=automation(t);
    if(setup)setup(a);else a.openScreenRun=()=>async()=>({lines:['1'],coverage:[]});
    const r=await a.review('User request');assert.equal(r.decision.action,'Hold');assert.deepEqual(counters(a,db),CLEAN);assert.match(toolResult(t),words);
    const rec=JSON.parse(db.prepare('SELECT payload FROM reviews').get().payload);assert.equal(rec.formulaUse.screenCalls,1);assert.ok(['error','stopped'].includes(rec.formulaUse.scripts[0].status));
  });
}
test('a stale account during a script: the script is answered in words, and the review is stopped by its own stale check exactly as for any other tool',async()=>{
  const outcome=async bump=>{const t=transport(bump==='screen'?reply({content:[{type:'thinking',thinking:'',signature:'s1'},{type:'tool_use',id:'tu1',name:'run_screen',input:{script:'print(1)'}}],stop_reason:'tool_use'}):reply({content:[{type:'thinking',thinking:'',signature:'s1'},{type:'tool_use',id:'tu1',name:'get_market_evidence',input:{symbol:'005930',dataset:'company'}}],stop_reason:'tool_use'}),reply());
    const {a,db}=automation(t);a.openScreenRun=()=>async()=>{a.revision++;return {lines:['1'],coverage:[]};};const outputs=[];const real=a.deskActions.bind(a);a.deskActions=(...x)=>{const acts=real(...x);const rs=acts.run_screen;acts.run_screen=async args=>{const v=await rs(args);outputs.push(v);return v;};return acts;};if(bump==='evidence')a.evidence={get:async()=>{if(t.sent.length)a.revision++;return {status:'ok'};}};// only the model's request, not the prefetch
    const error=await a.review('User request').then(()=>null,e=>e.message);return {error,counters:counters(a,db),outputs,requests:t.sent.length};};
  const viaScreen=await outcome('screen'),viaEvidence=await outcome('evidence');
  assert.match(viaScreen.outputs[0].words,/the account or scope changed during this run/);assert.ok(viaScreen.error,'the review is stopped');assert.equal(viaScreen.requests,viaEvidence.requests,'no further request in either');
  assert.equal(viaScreen.error,viaEvidence.error);assert.deepEqual(viaScreen.counters,viaEvidence.counters,'counted the same as a stale review through another tool');
});
test('run_screen never throws from the tool, whatever the screen or the guard does',async()=>{
  const cases=[{screen:async()=>{throw new Error('STALE_DECISION');}},{screen:async()=>{throw null;}},{screen:async()=>undefined},{screen:'not a function'},{screen:async()=>({}),guard:()=>{throw new Error('STALE_DECISION');}}];
  for(const c of cases){const tool=scout.screenTool({...c,onRecord:()=>{throw new Error('record fails');}});for(const args of [{script:'print(1)'},{},null,{invalid:'not JSON'}]){const v=await tool(args);assert.ok(v&&typeof v==='object');}}
});

// ---- The review's universe and its fallback to the review's own daily history.
const late=c=>({closes:c,at:Date.parse('2026-12-02T00:30:00Z')});// read after both markets' 12-01 close plus the margin
const master=()=>{const db=new DatabaseSync(':memory:');new SecurityMaster(db,async()=>({ok:false}));const put=db.prepare("INSERT INTO securities(symbol,name,englishName,market,type,isin,industry,sector,marketCap) VALUES(?,?,'',?,?,'',NULL,NULL,?)");
  [['111110','A','KOSPI','stock',9e12],['111120','B','KOSPI','stock',8e12],['999980','H','KOSPI','stock',1e9]].forEach(r=>put.run(...r));return db;};
const day=(start,i)=>new Date(Date.parse(start+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
const rowsFrom=(start,n,base)=>Array.from({length:n},(_,i)=>({date:day(start,i),close:base+i,high:base+i+1,low:base+i-1,volume:1000,value:1e6}));
const seoul=(d,hm)=>Date.parse(`${d}T${hm}:00+09:00`);
const deps=(extra={})=>{const db=master();return {db,store:new H.HistoryStore(db),usSize:{top:()=>null},own:k=>({holdings:['111110'],watchlist:['111110','999980'],plan:[],allowlist:[],review:[]})[k]??[],settings:()=>({perExchange:300,etfs:true}),closedDays:()=>new Set(),clock:()=>seoul('2026-12-02','10:00'),...extra};};
test('a review screens its own stocks: universe(own="review"), its lists limited to them, anything else refused in words',()=>{
  const d=deps({allowed:new Set(['111110','111120'])});d.store.put('111110',rowsFrom('2026-08-01',124,100));d.store.put('111120',rowsFrom('2026-08-01',124,200));
  const c=U.screenContext(d);const go=t=>FS.run(t,c.ctx);
  assert.deepEqual(U.universeFor(d,{own:'review'},d.clock()),{name:'review',symbols:['111110','111120']});assert.deepEqual(U.universeFor(d,{own:'watchlist'},d.clock()).symbols,['111110'],'999980 is not this review\'s');
  assert.deepEqual(U.universeFor(d,{market:'KOSPI'},d.clock()),{refused:'REVIEW_UNIVERSE_ONLY'});
  const ok=go('u = universe(own="review")\nprint(top(u, ret(S,20), 2))');assert.equal(ok.stopped,undefined);assert.equal(ok.lines.length,1);
  for(const t of ['print(close("999980",0))','print(count(list("999980"), close(S,0) > 0))','print(count(universe(market="KOSPI"), close(S,0) > 0))']){const r=go(t);assert.ok(r.stopped,t);assert.match(r.stopped.words,/this review's stocks|review/,t);}
  const outside=U.screenContext(deps());assert.ok(!FS.run('print(close("999980",0))',outside.ctx).stopped?.words?.includes('review'),'outside a review nothing changes');
});
test('the fallback: a stock with no stored history reads the review\'s daily history, cut to the as-of day, marked with its own day; never for another stock or outside a review',()=>{
  const fb=rowsFrom('2026-09-01',93,500);const asked=[];const fallback=s=>{asked.push(s);return s==='111120'?late(fb):null;};
  const d=deps({allowed:new Set(['111110','111120']),fallback});d.store.put('111110',rowsFrom('2026-08-01',124,100));const c=U.screenContext(d);
  const last=fb.filter(r=>r.date<='2026-12-01').at(-1);const r=FS.run('print(close("111120",0))',c.ctx);assert.equal(r.stopped,undefined);
  assert.equal(parseFloat(r.lines[0]),last.close,'the 12-01 close; 12-02 (after the as-of day) is never used');assert.match(r.lines[0],new RegExp(`as of close ${last.date}, from the review's daily history`));
  assert.equal(c.ctx.isStale('111120'),false,'a fallback stock is not counted stale');assert.ok(!asked.includes('111110'),'a stored stock never reads the fallback');
  assert.ok(FS.run('print(close("999980",0))',c.ctx).stopped);assert.ok(!asked.includes('999980'),'not this review\'s: never read');
  const plain=U.screenContext(deps({fallback}));FS.run('print(close("111120",0))',plain.ctx);assert.ok(!asked.filter(s=>s==='111120').length||asked.length===1,'outside a review (no allowed list) the fallback is not read');
});

// ---- live() in a review: fresh review quotes first; a dry run reads nothing.
test('the review reader: fresh quotes from the review, the rest through the reader; a dry run never reads',async()=>{
  const now=seoul('2026-12-02','10:00');let reads=[];const readLive=async s=>{reads.push(...s);return new Map(s.map(x=>[x,{price:7,readAt:now,closed:false}]));};
  const quotes=[{symbol:'111110',price:100,timestamp:now-30000},{symbol:'111120',price:200,timestamp:now-120000},{symbol:'111130',price:300,timestamp:now-1000,stale:true}];
  const open=()=>true;const r=await SR.reviewReader({quotes,sessionOpen:open,readLive,clock:()=>now})(['111110','111120','111130','111140']);
  assert.deepEqual(r.get('111110'),{price:100,readAt:now-30000,closed:false});assert.deepEqual(reads,['111120','111130','111140'],'too old, stale or absent: read');
  reads=[];const closed=await SR.reviewReader({quotes,sessionOpen:()=>false,readLive,clock:()=>now})(['111110']);assert.deepEqual(reads,['111110'],'a closed session: the quote is not taken as live');assert.equal(closed.get('111110').price,7);
  reads=[];const dry=await SR.reviewReader({quotes,dryRun:true,sessionOpen:open,readLive,clock:()=>now})(['111110','111120']);assert.deepEqual(reads,[],'a dry run reads nothing');
  assert.equal(dry.get('111110').price,100);assert.equal(dry.get('111120').missing,'no live price (dry run)');
});
test('the dry run: run_screen is real but warms no daily history; a review warms its own stocks once',async()=>{
  const {a,warmed}=automation(transport(reply()));const seen=[];a.openScreenRun=o=>{seen.push(o.review);return async()=>({lines:['1'],coverage:[]});};
  const ctx={universe:[{symbol:'005930'},{symbol:'111110'}],quotes:[]};const scope=a.watchScope();
  const dry=a.deskActions(scope,ctx,'r1',()=>{},null,{dryRun:true});await dry.run_screen({script:'print(close("005930",0))'});await dry.run_screen({script:'print(close("111110",1))'});
  assert.equal(seen[0].dryRun,true);assert.deepEqual(warmed,[],'nothing read for a dry run');assert.ok(seen[0].allowed.includes('005930')&&seen[0].allowed.includes('111110'));
  const real=a.deskActions(scope,ctx,'r2',()=>{},null);await real.run_screen({script:'print(1)'});assert.deepEqual(warmed,[],'a script that reads no history warms nothing');
  await real.run_screen({script:'print(close("111110",0))'});await real.run_screen({script:'print(sma("111110",5), close("005930",0))'});
  assert.equal(seen[1].dryRun,false);assert.deepEqual(warmed,['111110','005930'],'only the stocks a script names, each once a review');
});

// ---- The Journal record.
test('FormulaUse.screen: every call counted, the first 4 kept, the script and printed lines cut; no scripts, no new keys',()=>{
  const none=new FormulaUse().summary({action:'Hold'});assert.ok(!('screenCalls' in none)&&!('scripts' in none));
  const u=new FormulaUse();for(let i=0;i<6;i++)u.screen(i===0?'print(1)\n'.repeat(400):`print(${i})`,{status:i===1?'stopped':'ok',stopped:i===1?{line:1,words:'w'}:undefined,lines:i===0?Array.from({length:50},()=>'y'.repeat(100)):['1'],coverage:[{line:1,universe:'review',size:2,evaluated:2,noHistory:0,stale:0,errors:0,noLive:0,extra:'dropped'}],live:{asked:1,read:1}});
  const s=u.summary({action:'Hold'});assert.equal(s.screenCalls,6);assert.equal(s.scripts.length,4);
  assert.ok(s.scripts[0].script.length<=2000+8&&s.scripts[0].script.endsWith('… cut'));assert.ok(Buffer.byteLength(s.scripts[0].lines.join(''))<=2000);
  assert.equal(s.scripts[1].words,'w');assert.deepEqual(Object.keys(s.scripts[2].coverage[0]),['line','universe','size','evaluated','noHistory','stale','errors','noLive']);
});

// ---- Scripts against compute. The limit, stated: functions that do not use the latest price are compared exactly; for
// change, ret, zscore and ratio_z compute is given a quote equal to the last close (a script's split view uses the last
// close there); price() is refused in a script, and stands as close(S,0) (the quote equal to the last close) and as
// live(S) (the quote read live).
const series=(seed,n=120)=>{let x=seed;const out=[];for(let i=0;i<n;i++){x=(x*1103515245+12345)%2147483648;const c=100+((x>>8)%4000)/40;out.push({date:day('2026-07-01',i),close:c,high:c+((x>>4)%50)/40,low:c-((x>>6)%50)/40,volume:1000+(x%500),value:(1000+(x%500))*c});}return out;};
test('a script prints what compute returns, function by function (the limit above)',async()=>{
  const A=series(7),B=series(11);const S={'111110':A,'111120':B};const asOf=A.at(-1).date;
  const compute={price:s=>S[s]?.at(-1).close??null,previousClose:s=>S[s]?.at(-2).close??null,closes:s=>S[s]??null};
  const ctx={data:compute,isStale:()=>false,names:()=>null,universe:()=>({refused:'UNKNOWN_UNIVERSE'}),asOf:{KR:asOf,US:asOf}};
  const exprs=['close("111110",0)','close("111110",3)','change("111110")','ret("111110",5)','sma("111110",10)','ema("111110",10)','std("111110",10)','high("111110",20)','low("111110",20)','rsi("111110",14)',
    'zscore("111110",20)','ratio_z("111110","111120",20)','corr("111110","111120",20)','avgvalue("111110",10)','atr("111110",14)','adx("111110",14)','macd("111110")','cci("111110",14)','stochrsi("111110",14)','ultimate("111110")',
    'abs(ret("111110",5))','min(sma("111110",5),sma("111110",10))','max(1,2)','round(sma("111110",5))','log(close("111110",0))','sqrt(close("111110",0))','(close("111110",0)/sma("111110",20)-1)*100'];
  const covered=new Set(exprs.flatMap(e=>[...e.matchAll(/([a-z_]+)\(/g)].map(m=>m[1])));for(const k of Object.keys(F.FUNCS).filter(k=>k!=='price'))assert.ok(covered.has(k),'compared: '+k);
  // The split view: in a script, ret, change, zscore and ratio_z take the last close as the latest price and the closes
  // before it as history (formula-script.cjs), as compute sees a live quote and the completed closes during a session.
  const split={price:s=>S[s]?.at(-1).close??null,previousClose:s=>S[s]?.at(-2).close??null,closes:s=>S[s]?.slice(0,-1)??null};
  for(const e of exprs){const want=F.evaluate(F.parse(e).ast,/\b(ret|change|zscore|ratio_z)\(/.test(e)?split:compute);const r=FS.run(`print(${e})`,ctx);assert.equal(r.stopped,undefined,e);assert.equal(parseFloat(r.lines[0]),Number(want.toPrecision(8)),e);}
  assert.match(FS.run('print(price("111110"))',ctx).stopped.words,/price/);
  assert.equal(F.evaluate(F.parse('price("111110")').ast,compute),parseFloat(FS.run('print(close("111110",0))',ctx).lines[0]),'price() as close(S,0)');
  const quote=123.45;const lr=await SR.runScreen('print(live("111110"))',ctx,{readLive:async s=>new Map(s.map(x=>[x,{price:quote,readAt:Date.now(),closed:false}]))});
  assert.equal(parseFloat(lr.lines[0]),F.evaluate(F.parse('price("111110")').ast,{...compute,price:()=>quote}),'price() as live(S)');
});
