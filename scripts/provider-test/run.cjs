'use strict';
// Isolated provider test runner (artifacts/reviews/2026-11-05-provider-test-design.md). A plain Node process, not the
// app: it constructs only the review context from a verified fixture, the fixture tools and the AI client. There is no
// broker, updater, telemetry, scheduler or background job. The guard is installed before any application module
// loads, and the only way out is the controlled transport, under one budget meter.
//   node scripts/provider-test/run.cjs --dir <prepared folder> --rehearse
//   node scripts/provider-test/run.cjs --dir <prepared folder> --paid --key-file <your OpenAI key file> --confirm-paid
// --rehearse answers every request from a scripted fake provider (no network); --paid sends to OpenAI. The key is
// read from the file you name, held in memory, and never written.
const guard=require('./guard.cjs').install();
const fs=require('node:fs'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const STATEMENT='Provider schema acceptance and tool handling only: not a validation of accounting, valuation, settlement or strategy.';
// Tool paths covered offline by tests/provider-test.test.cjs, whether or not the provider exercises them in this run.
const OFFLINE=['recorded fixture served','recording cut off: unavailable','unrecorded request: unavailable','write tools not applied','compute unavailable (it would fetch daily history)','context detail read locally','retry through the meter','condensing through the meter','budget stop before sending','redirect and destination refused','provider rejection reported apart from local validation'];
const RETRYABLE=['AI_REQUEST_FAILED','AI_SERVER_ERROR','AI_TIMEOUT'];
async function runTest({dir,send,key,model='gpt-6-sol',effort='medium',routineModel='gpt-6-luna',routineEffort='none',live,limits={requests:6,usd:0.5},mode}){
  const P=require('./paths.cjs'),S=require('./state.cjs'),F=require('./fixture.cjs');
  const where=P.separate(dir,live?{live}:{});const liveDb=path.join(where.live,'portfolio.sqlite');
  const fixturePath=path.join(where.dir,'fixture.json'),reportDb=path.join(where.dir,'provider-test.sqlite');
  if(fs.existsSync(reportDb))throw Object.assign(new Error('ISOLATED_RUN_EXISTS'),{detail:'this folder already holds a run; prepare a new one'});
  const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));F.verify(fixture);
  const before={live:fs.existsSync(liveDb)?S.snapshot(liveDb):null,files:fs.readdirSync(where.dir).sort()};
  const {Meter}=require('./meter.cjs'),{controlledTransport}=require('./transport.cjs');
  const meter=new Meter(limits),requests=[];const transport=controlledTransport({send,guard,meter,log:requests});
  const {AiClient,reviewTools,instructions}=require('../../electron/ai-client.cjs');const ai=new AiClient(key,transport);
  const context=structuredClone(fixture.context);const validation={positionMemory:Array.isArray(context.positionMemory)?structuredClone(context.positionMemory):null,quotes:structuredClone(context.quotes??[])};
  const shaped=require('../../electron/review-context.cjs').shape(require('../../electron/token-saver.cjs').compact(context));
  const tools=F.server(fixture),transcript=[];const log=(kind,title,body)=>transcript.push({at:new Date().toISOString(),kind,title,body:String(body).slice(0,2000)});
  const offered=reviewTools(shaped.context).map(t=>t.name);
  const evidence={get:async args=>tools.lookup('get_market_evidence',args)};
  const discovery={get_company_research:args=>tools.lookup('get_company_research',args),get_market_overview:args=>tools.lookup('get_market_overview',args??{}),screen_market:args=>tools.lookup('screen_market',args),search_securities:args=>tools.lookup('search_securities',args),update_watchlist:tools.inert('update_watchlist')};
  const desk=shaped.context.agentDesk?Object.fromEntries(offered.filter(n=>['compute','set_review_trigger','save_note','save_assessment','set_conditional_order'].includes(n)).map(n=>[n,n==='compute'?async args=>tools.lookup('compute',args):tools.inert(n)])):null;
  const request=async options=>{options={...options,openaiModel:model,reasoningEffort:effort,validation};
    // A local stop is never retried, and is reported as itself, not as the client's request failure.
    try{return await ai.decide(shaped.context,options);}catch(error){const local=localStop();if(local)throw local;if(!RETRYABLE.includes(error?.message))throw error;log('System','Retry',error.message);
      try{return await ai.decide(shaped.context,options);}catch(again){throw localStop()??again;}}};
  const localStop=()=>{const s=requests.find(r=>r.status==='budget-stop'||r.status==='destination-refused');return s?Object.assign(new Error(s.status==='budget-stop'?'BUDGET_STOP':'ISOLATED_DESTINATION_REFUSED'),{reason:s.reason??s.detail??null}):null;};
  const compact=payload=>ai.compact(payload,{openaiModel:routineModel,reasoningEffort:routineEffort});
  let result=null,failure=null;const started=new Date().toISOString();
  if(!shaped.fits)failure={code:'CONTEXT_OVER_BUDGET',where:'local size check before any request'};
  else try{result=await require('../../electron/research-review.cjs').researchReview({context:shaped.context,detail:shaped.detail,watched:[],evidence,discovery,setInterval:tools.inert('set_review_interval'),setWatch:tools.inert('set_review_watch'),actions:desk,log,compact,request});}
  catch(error){const e=localStop()??error;failure={code:/^[A-Z_]{3,40}$/.test(e?.message)?e.message:'RUN_FAILED',reason:e?.reason??null,detail:typeof e?.detail==='string'?e.detail.slice(0,300):null};}
  const after={live:fs.existsSync(liveDb)?S.snapshot(liveDb):null};
  const report=assemble({mode,model,effort,routineModel,routineEffort,instructions:instructions(),fixture,requests,meter,tools,transcript,offered,result,failure,before,after,started,dir:where.dir,S});
  const out=new DatabaseSync(reportDb);out.exec('CREATE TABLE report(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)');out.prepare('INSERT INTO report(payload) VALUES(?)').run(JSON.stringify(report));out.close();
  fs.writeFileSync(path.join(where.dir,'report.json'),JSON.stringify(report,null,1));fs.writeFileSync(path.join(where.dir,'report.md'),markdown(report));
  report.state.files.after=fs.readdirSync(where.dir).sort();return report;
}
function assemble({mode,model,effort,routineModel,routineEffort,instructions,fixture,requests,meter,tools,transcript,offered,result,failure,before,after,started,dir,S}){
  const sentRequests=requests.filter(r=>r.n!=null),rejected=requests.filter(r=>r.status==='rejected'),stops=requests.filter(r=>r.n==null);
  const decision=result?.decision??null,withheld=decision?.withheld??null;
  const exercised=[...new Set([...tools.calls.map(c=>c.tool),...transcript.filter(t=>t.title.startsWith('Context detail')).map(()=>'get_context_detail')])];
  return {statement:STATEMENT,mode,started,finished:new Date().toISOString(),
    fixture:{kind:fixture.meta.kind,dryRun:fixture.meta.dryRun,cutoff:fixture.meta.cutoff,digest:fixture.digest,recordedBuild:fixture.meta.recordedBuild,unavailable:fixture.meta.unavailable,kept:Object.keys(fixture.meta.kept)},
    sent:{instructions,model,effort,routineModel,routineEffort},
    acceptance:{
      providerAccepted:sentRequests.length>0&&sentRequests.every(r=>r.status==='accepted'),
      // A stop or refusal inside a step the review recovers from (a plan correction) is still listed.
      localStops:stops.map(s=>({status:s.status,reason:s.reason??s.detail??null})),
      requests:sentRequests.map(r=>({n:r.n,kind:r.kind,status:r.status,http:r.http??null,providerError:r.providerError??null,responseStatus:r.responseStatus??null,toolCalls:r.toolCalls??[]})),
      finalResponseParsedAndValidated:Boolean(decision),
      localGuard:withheld?{withheld:withheld.kind??'plan',reason:withheld.reason??null,note:'a deterministic local guard withheld the decision; this is not a provider rejection'}:null,
      failure:failure?{...failure,side:rejected.length?'provider rejected a request':['BUDGET_STOP','CONTEXT_OVER_BUDGET','CONTINUATION_OVER_BUDGET','VALIDATION_STATE_INVALID','ISOLATED_DESTINATION_REFUSED','ISOLATED_NETWORK_DENIED'].includes(failure.code)?'local':'local parsing or validation of an accepted response, or transport'}:null,
      decision:decision?{action:decision.action,symbol:decision.symbol??'',quantity:decision.quantity??0}:null},
    tools:{offered,exercised,notExercised:offered.filter(n=>!exercised.includes(n)),calls:tools.calls,offlineOnly:OFFLINE,
      note:exercised.length?null:'no tool was called: this run does not verify tool handling'},
    cost:meter.summary(),
    state:{live:before.live&&after.live?{before:before.live,after:after.live,...S.compare(before.live,after.live)}:{note:'no live profile database found'},
      migration:'none: the source copy was read only to compose the fixture, and this runner does not open it',
      files:{before:before.files},networkRefused:guard.attempts.slice()},
    transcript};
}
function markdown(r){const a=r.acceptance,c=r.cost,lines=[`# Isolated provider test (${r.mode})`,'',`> ${r.statement}`,'',
  `- Fixture: ${r.fixture.kind}, dry run ${r.fixture.dryRun}, cutoff ${r.fixture.cutoff}, digest ${r.fixture.digest.slice(0,16)}`,
  `- Sent: ${r.sent.instructions.version} (${r.sent.instructions.fingerprint}), ${r.sent.model} ${r.sent.effort}; condensing ${r.sent.routineModel} ${r.sent.routineEffort}`,
  `- Provider accepted every request: ${a.providerAccepted}`,`- Final response parsed and passed local validation: ${a.finalResponseParsedAndValidated}${a.decision?` (${[a.decision.action,a.decision.symbol,a.decision.quantity||''].filter(Boolean).join(' ')})`:''}`,
  ...a.localStops.map(s=>`- Local stop before sending: ${s.status}${s.reason?` (${s.reason})`:''}`),...(a.localGuard?[`- Local guard: ${a.localGuard.withheld}: ${a.localGuard.reason} (${a.localGuard.note})`]:[]),...(a.failure?[`- Failure: ${a.failure.code} (${a.failure.side})${a.failure.reason?`: ${a.failure.reason}`:''}`]:[]),
  '','## Requests','',...a.requests.map(q=>`- ${q.n}. ${q.kind}: ${q.status}${q.http?` HTTP ${q.http}`:''}${q.providerError?` ${q.providerError.code??q.providerError.type}`:''}${q.toolCalls.length?` tools ${q.toolCalls.join(', ')}`:''}`),
  '','## Tools','',`- Offered: ${r.tools.offered.join(', ')}`,`- Exercised: ${r.tools.exercised.join(', ')||'none'}`,`- Not exercised: ${r.tools.notExercised.join(', ')||'none'}`,...(r.tools.note?[`- ${r.tools.note}`]:[]),
  ...r.tools.calls.map(x=>`  - ${x.tool} ${JSON.stringify(x.args)}: ${x.served}`),`- Tested offline only: ${r.tools.offlineOnly.join('; ')}`,
  '','## Cost','',`- ${c.requests} of ${c.limit.requests} requests; actual $${c.actualUSD.toFixed(6)}; committed $${c.committedUSD.toFixed(6)} of $${c.limit.usd.toFixed(2)}; requests of unknown cost ${c.unknownCostRequests}`,
  ...c.entries.map(e=>`  - ${e.n}: ${e.bytes} bytes, reserved $${(e.reservedMicro/1e6).toFixed(6)}${e.status==='settled'?`, actual $${(e.actualMicro/1e6).toFixed(6)} (input ${e.usage.inputTokens}, cached ${e.usage.cachedTokens}, output ${e.usage.outputTokens}, of which reasoning ${e.reasoningTokens??'not reported'}), bound held ${e.boundHeld}`:`, ${e.status}`}`),
  '','## State','',r.state.live.before?`- Live database: logically ${r.state.live.unchanged?'unchanged':'CHANGED: '+r.state.live.changedTables.join(', ')}; main file ${r.state.live.mainFileUnchanged?'unchanged':'changed'}; log ${r.state.live.walUnchanged?'unchanged':'changed'}`:`- ${r.state.live.note}`,
  `- Migration: ${r.state.migration}`,`- Network attempts refused: ${r.state.networkRefused.length}`];return lines.join('\n')+'\n';}
// The scripted provider for --rehearse: one research round asking for a recorded result, a cut-off recording, an
// unrecorded request and a write, then a Hold. No network.
function rehearsal(){let n=0;const call=(name,args,i)=>({type:'function_call',name,call_id:'r'+i,arguments:JSON.stringify(args)});
  return async(url,init)=>{n++;const body=JSON.parse(init.body);const usage={input_tokens:Math.ceil(Buffer.byteLength(init.body)/4),output_tokens:200,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:50}};
    if(body.prompt_cache_key==='research-compact-v1')return new Response(JSON.stringify({status:'completed',model:body.model,usage,output:[{type:'message',content:[{type:'output_text',text:'{"digest":"condensed"}'}]}]}),{status:200});
    const out=n===1?[call('get_market_evidence',{symbol:'028050',dataset:'daily_technicals'},1),call('get_company_research',{symbol:'028050',sections:['events','risk']},2),call('get_market_evidence',{symbol:'396500',dataset:'order_book'},3),call('set_review_watch',{symbol:'028050',above:100000},4)]
      :[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Rehearsal: hold.'})}]}];
    return new Response(JSON.stringify({status:'completed',model:body.model,usage,output:out}),{status:200});};}
async function main(argv){const arg=n=>{const i=argv.indexOf(n);return i>=0?argv[i+1]:null;};const dir=arg('--dir');if(!dir)throw new Error('--dir is required');
  let send,key,mode;
  if(argv.includes('--rehearse')){send=rehearsal();key='rehearsal-key-0000';mode='rehearsal (scripted provider, no network)';}
  else if(argv.includes('--paid')){if(!argv.includes('--confirm-paid'))throw new Error('--paid needs --confirm-paid');const file=arg('--key-file');if(!file)throw new Error('--paid needs --key-file');
    const raw=fs.readFileSync(file,'utf8').trim();let k=raw;try{const j=JSON.parse(raw);k=j.apiKey??j.api_key??j.key??j.OPENAI_API_KEY??raw;}catch{}key=String(k);send=guard.original.fetch;mode='paid';}
  else throw new Error('choose --rehearse or --paid');
  const report=await runTest({dir,send,key,mode,model:arg('--model')??undefined,effort:arg('--effort')??undefined});
  process.stdout.write(markdown(report));}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{process.stderr.write(`Isolated provider test stopped: ${e.message}${e.detail?` (${typeof e.detail==='string'?e.detail:JSON.stringify(e.detail)})`:''}\n`);process.exit(1);});
module.exports={runTest,rehearsal,markdown,STATEMENT};
