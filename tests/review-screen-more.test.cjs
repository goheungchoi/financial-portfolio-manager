'use strict';
// S4, the planner's first review (artifacts/reviews/2026-11-23-after-b2/review-s4-first.md): scripts become stand-ins as
// soon as a round's calls are read (a review never fails on their size), the failure matrix on the real run and engine
// and on OpenAI through the app, the warm-up of only what a script names, the fresher of the store and the review's own
// history, own="review" with market and type, a written live() code outside the review, the per-review cache and time
// budget, the review's scope for holdings, the final round followed by a plan correction, the scout's final round through
// both clients, and the Journal's Scripts section. Made-up symbols and prices; fake transports only.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const FS=require('../electron/formula-script.cjs');const F=require('../electron/formula.cjs');const SR=require('../electron/screen-run.cjs');const U=require('../electron/screen-universe.cjs');
const H=require('../electron/history-store.cjs');const {SecurityMaster}=require('../electron/security-master.cjs');const scout=require('../electron/scout.cjs');
const AI=require('../electron/ai-client.cjs');const {AnthropicClient}=require('../electron/anthropic-client.cjs');const {researchReview,ROUNDS}=require('../electron/research-review.cjs');
const {adapt}=require('./fixtures/claude-flat.cjs');const {errorReply}=require('../electron/provider-error-reply.cjs');const {Automation}=require('../electron/automation.cjs');
const KEY='sk-ant-api03-'+'k'.repeat(40);const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};const GPT={openaiModel:'gpt-6-sol',reasoningEffort:'low'};
const hold={action:'Hold',symbol:'',quantity:0,explanation:'No trade.'};
const USAGE={input_tokens:1200,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:400};
const msg=(content,stop_reason='end_turn')=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'s'},...content],stop_reason,stop_details:null,usage:USAGE,input_transformations:[]});
const holdMsg=()=>msg([{type:'text',text:JSON.stringify(hold)}]);
const uses=(calls)=>msg(calls.map(([id,input])=>({type:'tool_use',id,name:'run_screen',input})),'tool_use');
function claudeTransport(pick){const sent=[];const fn=async(url,init)=>{const body=JSON.parse(init.body);sent.push({body,bytes:Buffer.byteLength(init.body)});const r=pick(body,sent.length);return new Response(JSON.stringify(r.adapt===false?r.msg:adapt(r,body)),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;}
function openaiFetch(pick){const sent=[];const fn=async(url,init)=>{const body=JSON.parse(init.body);sent.push({body,bytes:Buffer.byteLength(init.body)});return new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',usage:{input_tokens:1,output_tokens:1},output:pick(body,sent.length)}),{status:200});};fn.sent=sent;return fn;}
const fnCalls=calls=>calls.map(([id,input])=>({type:'function_call',call_id:id,name:'run_screen',arguments:JSON.stringify(input)}));
const holdOut=()=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(hold)}]}];
// A script at the language's size (about 3.9 KB) with a token deep inside it, and one far over the request cap.
const atCap=i=>{const lines=Array.from({length:38},(_,j)=>`# line ${j} of script ${i} ${j===20?'DEEPTOKEN':''}`.padEnd(98,'.'));return [...lines,'print(close("005930",0))'].join('\n');};
const huge='# '+'DEEPTOKEN '.repeat(7200)+'\nprint(1)';

// ---- 1. Stand-ins in every round: a review is never failed by the size of its scripts.
test('item 1, both clients through the real loop: a 65 KB context, 11 scripts at the size cap and one of 72 KB; the decision is reached and no request carries a script in full',async()=>{
  const CTX={universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:217000}],agentDesk:{conditionalOrders:{allowed:false}},notes:'n'.repeat(65000)};
  const rounds=[[['a1',{script:huge}],['a2',{script:atCap(2)}],['a3',{script:atCap(3)}],['a4',{script:atCap(4)}]],[5,6,7,8].map(i=>['b'+i,{script:atCap(i)}]),[9,10,11,12].map(i=>['c'+i,{script:atCap(i)}])];
  const ran=[];const tool=scout.screenTool({screen:async t=>{ran.push(t);return {lines:['x'.repeat(400)],coverage:[]};}});
  const loop=request=>researchReview({context:CTX,evidence:{get:async()=>({status:'ok'})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),actions:{run_screen:(a,o)=>tool(a,o)},request});
  const claude=claudeTransport((body,n)=>n<=3?{msg:uses(rounds[n-1]),adapt:false}:holdMsg());const c=new AnthropicClient(KEY,claude);
  const r1=await loop(o=>c.decide(CTX,{...CLAUDE,...o}));assert.equal(r1.decision.action,'Hold');
  const gpt=openaiFetch((body,n)=>n<=3?fnCalls(rounds[n-1]):holdOut());const g=new AI.AiClient('sk-fixture-key-123',gpt);
  const r2=await loop(o=>g.decide(CTX,{...GPT,...o}));assert.equal(r2.decision.action,'Hold');
  for(const [name,t] of [['Claude',claude],['OpenAI',gpt]]){assert.equal(t.sent.length,4,name);
    for(const s of t.sent.slice(1)){assert.ok(!JSON.stringify(s.body).includes('DEEPTOKEN'),`${name}: no script in full in a later request`);assert.ok(s.bytes<140000,`${name}: ${s.bytes} bytes`);}}
  assert.equal(ran.length,22,'11 scripts ran in each review; the oversized one was answered, not run');
});
test('item 1, the Claude tool_use shapes: an array or null input is replaced by its stand-in before the next request',async()=>{
  const CTX={universe:[{symbol:'005930'}],quotes:[],agentDesk:{conditionalOrders:{allowed:false}}};
  const t=claudeTransport((b,n)=>n===1?{msg:msg([{type:'tool_use',id:'x1',name:'run_screen',input:[]},{type:'tool_use',id:'x2',name:'run_screen',input:null}],'tool_use'),adapt:false}:holdMsg());const c=new AnthropicClient(KEY,t);
  const tool=scout.screenTool({screen:async()=>({lines:['1'],coverage:[]})});
  const r=await researchReview({context:CTX,evidence:{get:async()=>({})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),actions:{run_screen:(a,o)=>tool(a,o)},request:o=>c.decide(CTX,{...CLAUDE,...o})});
  assert.equal(r.decision.action,'Hold');const uses2=t.sent[1].body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_use');
  assert.equal(uses2.length,2);for(const u of uses2){assert.equal(typeof u.input,'object');assert.ok(!Array.isArray(u.input)&&u.input!==null);assert.match(u.input.script,/^# not run/);}
});
test('item 1, the room check: a script whose result would not leave room for the decision is answered, not run',async()=>{
  const cf=require('../electron/context-fit.cjs');const room=cf.LIMIT*cf.TARGET;const ran=[];const tool=scout.screenTool({screen:async t=>{ran.push(t);return {lines:['1'],coverage:[]};},noRoomWords:'the script was not run: this review has no room left for another screen result; decide with what you have'});
  let n=0;const big=[{role:'user',content:'z'.repeat(Math.floor(room-1000))}];
  const r=await researchReview({context:{universe:[]},evidence:{get:async()=>({})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),actions:{run_screen:(a,o)=>tool(a,o)},
    request:async o=>{n++;if(n===1)return {toolCalls:[{name:'run_screen',callId:'r1',args:{script:'print(1)'}}],continuation:[...big,{type:'function_call',call_id:'r1',name:'run_screen',arguments:'{"script":"print(1)"}'}]};
      const out=o.continuation.find(x=>x.type==='function_call_output'&&x.call_id==='r1');assert.match(out.output,/no room left/);return {decision:hold};}});
  assert.equal(r.decision.action,'Hold');assert.equal(ran.length,0);
});

// ---- The app: a Claude review with 12 scripts, and the failure matrix on the real run and on OpenAI.
function app(provider){const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Fixture',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const a=new Automation(db,paper,provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({status:'ok'})};
  a.series={closes:()=>null,ensure:async()=>{}};a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:false});return {a,db};}
const viaWorker=async fn=>{try{return await fn();}catch(e){const r=errorReply('decision',e);throw Object.assign(new Error(r.code),{usage:r.usage,model:r.model,...(r.detail?{detail:r.detail}:{})});}};
const claudeApp=t=>{const c=new AnthropicClient(KEY,t);return app({request:async(op,p)=>{if(op!=='decision')throw new Error('PROVIDER_REQUEST_FAILED');return viaWorker(()=>c.decide(p.context,{...p.options,...CLAUDE}));}});};
const openaiApp=f=>{const c=new AI.AiClient('sk-fixture-key-123',f);return app({request:async(op,p)=>{if(op!=='decision')throw new Error('PROVIDER_REQUEST_FAILED');return viaWorker(()=>c.decide(p.context,{...p.options,...GPT}));}});};
const counters=(a,db)=>({lastError:a.lastError??null,backoff:a.reviewBackoff(),failures:db.prepare('SELECT COALESCE(SUM(count),0) AS n FROM review_failures').get().n,streak:a.guardrails.state(a.config).failureStreak,providerWait:[a.providerBackoff('anthropic'),a.providerBackoff('openai')].map(p=>({count:p.count,until:p.until}))});// a completed review stamps lastOkAt
const CLEAN={lastError:null,backoff:{count:0,until:0},failures:0,streak:0,providerWait:[{count:0,until:0},{count:0,until:0}]};
test('item 1 through the app on Claude: 12 scripts at the size cap over three rounds; the review decides and nothing is counted',async()=>{
  const rounds=[0,1,2].map(r=>[1,2,3,4].map(i=>['s'+r+i,{script:atCap(r*4+i)}]));const t=claudeTransport((b,n)=>n<=3?{msg:uses(rounds[n-1]),adapt:false}:holdMsg());
  const {a,db}=claudeApp(t);a.openScreenRun=()=>async()=>({lines:['y'.repeat(800)],coverage:[]});
  const r=await a.review('User request');assert.equal(r.decision.action,'Hold');assert.deepEqual(counters(a,db),CLEAN);
  const rec=JSON.parse(db.prepare('SELECT payload FROM reviews').get().payload);assert.equal(rec.formulaUse.screenCalls,12);assert.equal(rec.formulaUse.scripts.length,4);
});
// The real run (screen-run openRun, planStep and finalStep, screen-universe over a real store) for a review.
const master=()=>{const db=new DatabaseSync(':memory:');new SecurityMaster(db,async()=>({ok:false}));const put=db.prepare("INSERT INTO securities(symbol,name,englishName,market,type,isin,industry,sector,marketCap) VALUES(?,?,'',?,?,'',NULL,NULL,?)");
  [['005930','S','KOSPI','stock',9e12],['111110','A','KOSPI','stock',8e12],['222220','D','KOSDAQ','stock',5e12],['333330','F','KOSPI','etf',3e12],['999980','H','KOSPI','stock',1e9],['NASD:AAA','I','NASD','stock',null]].forEach(r=>put.run(...r));return db;};
const day=(start,i)=>new Date(Date.parse(start+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
const rowsFrom=(start,n,base)=>Array.from({length:n},(_,i)=>({date:day(start,i),close:base+i,high:base+i+1,low:base+i-1,volume:1000,value:1e6}));
const seoul=(d,hm)=>Date.parse(`${d}T${hm}:00+09:00`);
const late=c=>({closes:c,at:Date.parse('2026-12-02T00:30:00Z')});// read after both markets' 12-01 close plus the margin
const deps=(extra={})=>{const db=master();return {db,store:new H.HistoryStore(db),usSize:{top:()=>null},own:k=>({holdings:['005930'],watchlist:['111110','999980'],plan:[],allowlist:[],review:[]})[k]??[],settings:()=>({perExchange:300,etfs:true}),closedDays:()=>new Set(),clock:()=>seoul('2026-12-02','10:00'),...extra};};
const realRun=({readLive=async()=>new Map()}={})=>({guard,review})=>{const d=deps({allowed:new Set(review.allowed),fallback:()=>null});d.store.put('005930',rowsFrom('2026-08-01',124,100));
  return SR.openRun({readLive:SR.reviewReader({quotes:review.quotes,dryRun:review.dryRun,sessionOpen:()=>true,readLive}),exec:SR.localExec(U.screenContext(d).ctx)});};
for(const [name,script,words,opts] of [
  ['a syntax error','print(1 +',/cannot be read|line 1/],['a bound (41 lines)',Array.from({length:41},()=>'print(1)').join('\n'),/40 lines|line 41|lines/],['price()','print(price("005930"))',/price\(\) is not used|live\(S\)|close\(S,0\)/],
  ['a universe outside the review','print(count(universe(market="KOSPI")))',/review/],['a stock outside the review','print(close("999980",0))',/review's stocks/],['no history','print(close("111110",0))',/no history/],
  ['live reads failing','print(live("005930"))',/no live price/,{readLive:async()=>{throw new Error('KIS down');}}],
]){
  for(const vendor of ['Claude','OpenAI'])test(`the failure matrix on the real run, ${vendor}: ${name}: the review decides, nothing counted, the words reach the model`,async()=>{
    const input={script};const T=vendor==='Claude'?claudeTransport((b,n)=>n===1?{msg:uses([['u1',input]]),adapt:false}:holdMsg()):openaiFetch((b,n)=>n===1?fnCalls([['u1',input]]):holdOut());
    const {a,db}=vendor==='Claude'?claudeApp(T):openaiApp(T);a.openScreenRun=realRun(opts);
    const r=await a.review('User request');assert.equal(r.decision.action,'Hold');assert.deepEqual(counters(a,db),CLEAN);assert.match(JSON.stringify(T.sent[1].body),words);});
}
test('the real engine (worker thread) in a review: a review stock is screened, a stock outside it refused in words',async()=>{
  const {ScreenEngine,threadSpawn}=require('../electron/screen-engine.cjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'screen-'));const file=path.join(dir,'p.sqlite');const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL');
  new SecurityMaster(db,async()=>({ok:false}));new (require('../electron/us-size.cjs').UsSizeOrder)(db);const store=new H.HistoryStore(db);
  db.prepare("INSERT INTO securities(symbol,name,englishName,market,type,isin,industry,sector,marketCap) VALUES('111110','A','','KOSPI','stock','',NULL,NULL,9e12)").run();
  db.exec("CREATE TABLE IF NOT EXISTS research_cache(symbol TEXT,source TEXT,payload TEXT)");store.put('111110',rowsFrom('2026-11-01',31,100));
  const engine=new ScreenEngine({spawn:threadSpawn()});const env={dbPath:file,now:Date.parse('2026-12-02T03:00:00Z'),settings:{perExchange:10,etfs:false},closedDays:[],own:{},allowed:['111110']};
  try{const run=SR.openRun({readLive:async()=>new Map(),exec:(k,p)=>engine.exec(k,p,env)});const tool=scout.screenTool({screen:run});
    const ok=await tool({script:'u = universe(own="review")\nprint(top(u, close(S,0), 1))'});assert.equal(ok.status,'ok');assert.match(ok.lines[0],/^1\. 111110/);
    const out=await tool({script:'print(close("999980",0))'});assert.notEqual(out.status,'ok');assert.match(JSON.stringify(out),/review's stocks/);}
  finally{engine.close();db.close();}
});

// ---- 2. Warm only what a script names; 7. the review's own scope.
test('item 2: more than 6 review stocks: the one a script names is read; a universe reads all its stocks (bounded); a current store reads nothing',async()=>{
  const {a}=app({request:async()=>{throw new Error('x');}});const warmed=[];a.series={closes:()=>null,ensure:async s=>{warmed.push(s);}};
  const stocks=Array.from({length:10},(_,i)=>String(111110+i));a.screens={store:{progress:s=>s==='111111'?{newest:'2999-01-01'}:null},closedDays:()=>new Set()};
  const run=a.reviewScreens({screenRun:async()=>({lines:[],coverage:[]}),allowed:stocks});
  await run('print(close("111119",0))');assert.deepEqual(warmed,['111119'],'the 10th stock, named');
  await run('print(count(universe(own="review"), sma(S,5) > 0))');assert.deepEqual(warmed.slice(1).sort(),stocks.filter(s=>!['111119','111111'].includes(s)).sort(),'the rest once each; 111111 is current in the store');
  const many=Array.from({length:40},(_,i)=>String(200000+i));const w2=[];a.series={ensure:async s=>{w2.push(s);}};await a.reviewScreens({screenRun:async()=>({}),allowed:many})('print(count(universe(own="review"), close(S,0) > 0))');
  assert.equal(w2.length,Automation.REVIEW_SCRIPTS.warmMax,'at most warmMax a review');
});
test('item 7: the allowed list is the review\'s universe and the holdings of its own context, not every engine\'s',()=>{
  const {a}=app({request:async()=>{throw new Error('x');}});a.brokerPositions=()=>({'NASD:AAA':{quantity:3}});const seen=[];a.openScreenRun=o=>{seen.push(o.review.allowed);return async()=>({});};
  a.deskActions(a.watchScope(),{universe:[{symbol:'111110'}],positions:{'005930':{quantity:2},'222220':{quantity:0}}},'r',()=>{},null);
  a.deskActions(a.watchScope(),{universe:[{symbol:'111110'}],positions:[{symbol:'005930',quantity:2}]},'r2',()=>{},null,{dryRun:true});
  assert.deepEqual(seen,[['111110','005930'],['111110','005930']]);
});

// ---- 6. The per-review cache and the time budget.
test('a script without live() runs once a review (the same text is answered from the first run); one with live() runs each time',async()=>{
  const {a}=app({request:async()=>{throw new Error('x');}});let n=0;const run=a.reviewScreens({screenRun:async()=>{n++;return {lines:[String(n)]};},allowed:['005930'],dryRun:true});
  const x=await run('print(close("005930",0))');const y=await run('print(close("005930",0))');assert.equal(n,1);assert.deepEqual(x,y);
  await run('print(live("005930"))');await run('print(live("005930"))');assert.equal(n,3);
});
test('one script-time budget a review: past it a script is answered "this review spent its script time"; the review goes on',async()=>{
  const {a}=app({request:async()=>{throw new Error('x');}});const budget={...Automation.REVIEW_SCRIPTS,ms:150,warmMs:50};
  const run=a.reviewScreens({screenRun:t=>t.includes('slow')?new Promise(()=>{}):Promise.resolve({lines:['1']}),allowed:['005930'],dryRun:true,budget});
  const tool=scout.screenTool({screen:run});assert.equal((await tool({script:'print(1)'})).status,'ok');
  const t0=Date.now();const slow=await tool({script:'# slow\nprint(live("005930"))'});assert.match(slow.words,/this review spent its script time/);assert.ok(Date.now()-t0<1000);
  const after=await tool({script:'print(2)'});assert.match(after.words,/this review spent its script time/,'every later script is answered at once');
});

// ---- 3. The fresher of the store and the review's own history; 4. own="review" with market and type; 5. live() codes.
test('item 3: a store days behind and the review\'s history current: the review\'s is read, not stale, labelled with its day; both behind: labelled with the real day',()=>{
  const fresh=rowsFrom('2026-09-01',92,500);const old=rowsFrom('2026-08-01',119,100);// store ends 2026-11-27, review history 2026-12-01
  const d=deps({allowed:new Set(['111110']),fallback:s=>s==='111110'?late(fresh):null});d.store.put('111110',old);const c=U.screenContext(d);
  assert.equal(c.ctx.isStale('111110'),false);const r=FS.run('print(rsi("111110",14))\nprint(count(universe(own="review"), close(S,0) > 0))',c.ctx);
  assert.match(r.lines[0],/as of close 2026-12-01, from the review's daily history/);assert.match(r.lines[1],/^1 /,'counted and evaluated');
  const behind=deps({allowed:new Set(['111110']),fallback:()=>late(rowsFrom('2026-08-01',110,100))});behind.store.put('111110',old);const b=U.screenContext(behind);
  assert.equal(b.ctx.isStale('111110'),true);const r2=FS.run('print(close("111110",0))',b.ctx);assert.match(r2.lines[0],new RegExp(`as of close ${old.at(-1).date}, older than the market's last close`));assert.doesNotMatch(r2.lines[0],/as of close 2026-12-01\)/);
  const v=FS.run('x = close("111110",0)\nprint(x)',c.ctx);assert.match(v.lines[0],/from the review's daily history/,'a name keeps its mark');
});
test('item 4: universe(own="review") takes market, type and top_cap; an unknown market is refused; a cut is noted',()=>{
  const d=deps({allowed:new Set(['005930','111110','222220','333330','NASD:AAA'])});const u=s=>U.universeFor(d,{own:'review',...s},d.clock());
  assert.deepEqual(u({market:'KOSDAQ'}).symbols,['222220']);assert.deepEqual(u({market:'NASD'}).symbols,['NASD:AAA']);assert.deepEqual(u({market:'US'}).symbols,['NASD:AAA']);
  assert.deepEqual(u({type:'etf'}).symbols,['333330']);assert.deepEqual(u({market:'MOON'}),{refused:'UNKNOWN_UNIVERSE'});assert.deepEqual(u({type:'bond'}),{refused:'UNKNOWN_UNIVERSE'});
  assert.deepEqual(u({top_cap:2}),{name:'review',symbols:['005930','111110'],note:'2 of the 5 in review (top_cap)'});
});
test('item 5: a written live("code") outside the review never joins the reads; it is refused in words',async()=>{
  const d=deps({allowed:new Set(['111110'])});d.store.put('111110',rowsFrom('2026-08-01',124,100));const ctx=U.screenContext(d).ctx;
  assert.deepEqual(SR.planStep('print(close("111110",0) > 0 or live("999980") > 0)',ctx).asked,[]);
  const asked=[];const r=await SR.runScreen('print(close("111110",0) > 0 or live("999980") > 0)',ctx,{readLive:async s=>{asked.push(...s);return new Map();}});
  assert.deepEqual(asked,[],'never read (here or never reached)');assert.ok(r);
  const direct=await SR.runScreen('print(live("999980"))',ctx,{readLive:async s=>{asked.push(...s);return new Map();}});assert.deepEqual(asked,[]);assert.match(JSON.stringify(direct),/review's stocks/);
  assert.deepEqual(SR.planStep('print(live("999980"))',U.screenContext(deps()).ctx).asked,['999980'],'outside a review nothing changes');
});

// ---- The final round followed by a plan correction; the scout's final round through both clients.
test('a final-round answer followed by a plan correction: at most 6 requests, and the decision stands',async()=>{
  let n=0;const asked=[];const ev=id=>({name:'get_market_evidence',callId:id,args:{symbol:'005930',dataset:'company'}});const fc=c=>({type:'function_call',call_id:c.callId,name:c.name,arguments:JSON.stringify(c.args)});
  const withheld={action:'Buy',symbol:'005930',quantity:1,explanation:'x',withheld:{kind:'plan',quantity:1,symbol:'005930',reason:'the plan has no stop'}};
  const r=await researchReview({context:{universe:[{symbol:'005930'}]},evidence:{get:async()=>({status:'ok'})},log:()=>{},compact:async x=>x,detail:()=>({status:'complete',complete:true}),
    request:async o=>{n++;asked.push(o.final);const cont=[...(o.continuation??[])];if(n<ROUNDS){const c=ev('e'+n);return {toolCalls:[c],continuation:[...cont,fc(c)]};}
      if(n===ROUNDS){const c=ev('f');return {finalToolUse:true,toolCalls:[c],continuation:[...cont,fc(c)]};}if(n===ROUNDS+1)return {decision:withheld,continuation:cont};return {decision:{action:'Buy',symbol:'005930',quantity:1,explanation:'x'}};}});
  assert.ok(n<=6,`${n} requests`);assert.equal(n,ROUNDS+2);assert.equal(r.decision.planCorrected?.missing,'the plan has no stop');
});
test('the scout\'s final round through both real clients: answered once, then the plan',async()=>{
  const plan={summary:'Hold cash.',cashTargetPct:50,focus:'f',targets:[],briefAnswers:[],retrospective:'',substitutions:[]};
  const tools=()=>scout.focusTools({},{markets:['KR'],deferred:[]},{screen:async()=>({lines:['1'],coverage:[]})});
  let finals=0;const ct=claudeTransport(b=>{if(b.tool_choice?.type==='none'&&++finals>1)return {msg:msg([{type:'text',text:JSON.stringify(plan)}]),adapt:false};return {msg:uses([['k'+finals+Math.random().toString(36).slice(2,6),{script:'print(1)'}]]),adapt:false};});
  const c=new AnthropicClient(KEY,ct);const r1=await scout.runScout({request:o=>c.scout({brief:'x'},{...CLAUDE,...o}),tools:tools(),log:()=>{},overheadBytes:AI.scoutOverheadBytes()});assert.ok(r1.plan);
  const lastClaude=JSON.stringify(ct.sent.at(-1).body);assert.match(lastClaude,/no tools in this round/);assert.match(lastClaude,/not run \(no tools in the final round\)/);
  let gFinals=0,k=0;const gf=openaiFetch(b=>{if(b.tool_choice==='none'&&++gFinals>1)return [{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}];return fnCalls([['g'+(++k),{script:'print(1)'}]]);});
  const g=new AI.AiClient('sk-fixture-key-123',gf);const r2=await scout.runScout({request:o=>g.scout({brief:'x'},{...GPT,...o}),tools:tools(),log:()=>{},overheadBytes:AI.scoutOverheadBytes()});assert.ok(r2.plan);
  assert.match(JSON.stringify(gf.sent.at(-1).body),/no tools in this round/);
});

// ---- The Journal's Scripts section, rendered.
test('the Journal: More → "Scripts (n)" lists the kept scripts as the Scout panel does; nothing when none ran',()=>{
  const ts=require('typescript');const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
  const load=(file,stubs)=>{const js=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const mod={exports:{}};new Function('require','module','exports',js)(n=>n.startsWith('.')?(stubs[n]??new Proxy({},{get:(_,k)=>k==='__esModule'?true:()=>null})):require(n),mod,mod.exports);return mod.exports;};
  const screens=load('ScoutScreens.tsx',{});const {DecisionScripts}=load('JournalView.tsx',{'./ScoutScreens':screens});
  const rec={script:'# rank\nprint(1)',status:'ok',words:null,lines:['1 (as of close 2026-12-01)'],coverage:[{line:2,universe:'review',size:3,evaluated:3,noHistory:0,stale:0,errors:0,noLive:0}],live:null};
  const html=renderToStaticMarkup(React.createElement(DecisionScripts,{review:{formulaUse:{screenCalls:6,scripts:[rec,{...rec,status:'error',words:'the script was not run: no tools in this round: give your answer now'}]}}}));
  assert.match(html,/aria-label="Scripts of this review"/);assert.match(html,/Scripts \(6\)/);assert.match(html,/as of close 2026-12-01/);assert.match(html,/no tools in this round/);assert.match(html,/The first 2 are kept\./);assert.match(html,/<td>review<\/td>/);
  assert.equal(renderToStaticMarkup(React.createElement(DecisionScripts,{review:{formulaUse:{computeCalls:1}}})),'');assert.equal(renderToStaticMarkup(React.createElement(DecisionScripts,{review:{}})),'');
});

// ---- The equivalence with compute, extended: the fallback, a U.S. stock, windows near 250, short history, a stale store.
test('scripts and compute agree on the fallback, a U.S. stock and windows near 250; short history and a stale store are counted, never given another value',()=>{
  const gen=(seed,n)=>{let x=seed;return Array.from({length:n},(_,i)=>{x=(x*1103515245+12345)%2147483648;const c=50+((x>>8)%4000)/40;return {date:day('2026-01-01',i),close:c,high:c+1,low:c-1,volume:1000+(x%300),value:(1000+(x%300))*c};});};
  const asOf='2026-12-01';const K=gen(3,335).filter(r=>r.date<=asOf),US=gen(5,335).filter(r=>r.date<=asOf);
  const d=deps({allowed:new Set(['111110','NASD:AAA']),fallback:s=>s==='111110'?late(K):null});d.store.put('NASD:AAA',US);const ctx=U.screenContext(d).ctx;
  const data={'111110':K,'NASD:AAA':US};const compute={price:s=>data[s].at(-1).close,previousClose:s=>data[s].at(-2).close,closes:s=>data[s]};
  for(const sym of ['111110','NASD:AAA'])for(const e of [`sma("${sym}",250)`,`high("${sym}",249)`,`std("${sym}",240)`,`rsi("${sym}",200)`,`avgvalue("${sym}",250)`,`corr("111110","NASD:AAA",250)`]){
    const r=FS.run(`print(${e})`,ctx);assert.equal(r.stopped,undefined,e);assert.equal(parseFloat(r.lines[0]),Number(F.evaluate(F.parse(e).ast,compute).toPrecision(8)),e);}
  const short=deps({allowed:new Set(['111110']),fallback:()=>late(K.slice(-20))});const s=FS.run('print(count(universe(own="review"), sma(S,60) > 0))',U.screenContext(short).ctx);assert.match(s.lines[0],/0 of 1 evaluated.*no history/);
  const stale=deps({allowed:new Set(['111110'])});stale.store.put('111110',K.slice(0,-3));const st=FS.run('print(count(universe(own="review"), close(S,0) > 0))',U.screenContext(stale).ctx);assert.match(st.lines[0],/0 of 1 evaluated.*stale/);
});

// ---- Second review of S4 (A–D).
test('A: only a complete, successful answer is reused: not one with a stock without history, a stop, or while a daily read is still running',async()=>{
  const {a}=app({request:async()=>{throw new Error('x');}});let n=0;const answers=[{lines:['1'],coverage:[{line:1,noHistory:2,stale:0,errors:0,noLive:0}]},{lines:[],coverage:[],stopped:{line:1,words:'w'}},{lines:['ok'],coverage:[{line:1,noHistory:0,stale:0,errors:0,noLive:0}]}];
  const run=a.reviewScreens({screenRun:async()=>answers[Math.min(n++,2)],allowed:['005930'],dryRun:true});const t='print(count(universe(own="review"), close(S,0) > 0))';
  await run(t);await run(t);await run(t);await run(t);assert.equal(n,3,'two incomplete answers ran again; the complete third is reused');
  let release;const slow=new Promise(r=>{release=r;});const b=app({request:async()=>{throw new Error('x');}}).a;b.series={ensure:()=>slow};let m=0;
  const run2=b.reviewScreens({screenRun:async()=>{m++;return {lines:['1'],coverage:[]};},allowed:['005930'],budget:{...Automation.REVIEW_SCRIPTS,warmMs:30}});
  await run2('print(close("005930",0))');await run2('print(close("005930",0))');assert.equal(m,2,'the read timed out and is still running: not reused');
  release();await new Promise(r=>setImmediate(r));await run2('print(close("005930",0))');await run2('print(close("005930",0))');assert.equal(m,3,'after the read finished, one more run, then reused');
});
test('B: a stock named by its code is always read (lower case too), within 6 a script; universes share the 24 a review',async()=>{
  const {a}=app({request:async()=>{throw new Error('x');}});const warmed=[];a.series={ensure:async s=>{warmed.push(s);}};
  const stocks=[...Array.from({length:29},(_,i)=>String(300000+i)),'NASD:AAA'];const run=a.reviewScreens({screenRun:async()=>({lines:[],coverage:[]}),allowed:stocks});
  await run('print(count(universe(own="review"), sma(S,5) > 0))');assert.equal(warmed.length,24);
  await run('print(close("300028",0), close("nasd:aaa",0))');assert.deepEqual(warmed.slice(24),['300028','NASD:AAA'],'named after the shared bound was spent, lower case normalised');
  const many=Array.from({length:8},(_,i)=>String(400000+i));const w=[];a.series={ensure:async s=>{w.push(s);}};
  await a.reviewScreens({screenRun:async()=>({}),allowed:many})(`print(${many.map(s=>`close("${s}",0)`).join(', ')})`);assert.deepEqual(w,many.slice(0,6),'at most 6 named a script');
});
test('C: a script cut off by the review\'s time is cancelled: no final pass and no live read start after it',async()=>{
  const {a}=app({request:async()=>{throw new Error('x');}});const d=deps({allowed:new Set(['005930'])});d.store.put('005930',rowsFrom('2026-08-01',124,100));const local=SR.localExec(U.screenContext(d).ctx);
  const calls=[];const exec=async(kind,p)=>{calls.push(kind);if(kind==='plan')await new Promise(r=>setTimeout(r,250));return local(kind,p);};const reads=[];
  const runner=SR.openRun({readLive:async s=>{reads.push(...s);return new Map();},exec});
  const run=a.reviewScreens({screenRun:runner,allowed:['005930'],dryRun:true,budget:{...Automation.REVIEW_SCRIPTS,ms:100}});
  await assert.rejects(run('print(live("005930"))'),e=>e.code==='REVIEW_SCRIPT_TIME');await new Promise(r=>setTimeout(r,400));
  assert.deepEqual(calls,['plan'],'the plan pass that was running ended; nothing after it');assert.deepEqual(reads,[]);
  const fresh=SR.openRun({readLive:async s=>{reads.push(...s);return new Map([[s[0],{price:7,readAt:Date.now(),closed:false}]]);},exec:local});assert.match((await fresh('print(live("005930"))')).lines[0],/^7/,'a script not cancelled runs as before');
});
test('D: a row dated on the as-of day from the review\'s history counts only if read after that day\'s close plus the margin, in both markets',()=>{
  const MS=require('../electron/market-sessions.cjs');const kr=rowsFrom('2026-09-01',92,500),us=rowsFrom('2026-09-01',92,50);
  for(const [sym,rows,during,after] of [['111110',kr,seoul('2026-12-01','14:00'),seoul('2026-12-01','15:50')],['NASD:AAA',us,MS.zoned('2026-12-01','12:00','America/New_York'),MS.zoned('2026-12-01','16:20','America/New_York')]]){
    for(const [at,want] of [[during,'2026-11-30'],[after,'2026-12-01'],[undefined,'2026-11-30']]){
      const d=deps({allowed:new Set([sym]),fallback:()=>({closes:rows,at})});const c=U.screenContext(d);
      assert.equal(c.ctx.asOfFor(sym),want,`${sym} read at ${at}`);}}
});
