const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {ResearchService,TRACE}=require('../electron/research-service.cjs');
const rc=require('../electron/review-context.cjs');const {focusTools,runScout}=require('../electron/scout.cjs');const meter=require('../electron/research-meter.cjs');

const ANALYSTS={medianTarget:250000,brokerages:6,latest:Array.from({length:6},(_,i)=>({broker:'B'+i,target:240000+i*2000,date:'2026-10-1'+i}))};
function service({fail=()=>false,names={}}={}){
  const db=new DatabaseSync(':memory:');let now=Date.parse('2026-10-17T01:00:00Z');const calls=[];
  const master={get:symbol=>({'005930':{name:'삼성전자',market:'KOSPI',type:'stock'},'122630':{name:'KODEX 레버리지',market:'KOSPI',type:'etf'},...names})[symbol]??null,status:()=>({total:3})};
  const s=new ResearchService({db,master,kis:async(op,{section})=>{calls.push(section);if(fail(section))throw new Error('KIS_DOWN');
      if(section==='overview')return {price:217000,per:33};if(section==='analysts')return ANALYSTS;if(section==='estimates')return {years:[2026],eps:[5000],forecastYears:[2026]};return {};},
    provider:async()=>({version:2,preliminary:null,filings:[{date:'2026-10-10',kind:'corporate',title:'주권매매거래정지 (불성실공시법인 지정)'},{date:'2026-01-02',kind:'corporate',title:'관리종목 지정'}],earnings:null,dividends:null}),
    kisReady:()=>true,dartReady:()=>true,clock:()=>now});
  return {s,calls,advance:ms=>{now+=ms;}};
}

test('research replies state source, retrieval time, cache use and completeness, and keep the digested originals',async()=>{
  const {s,advance}=service();let failing=false;s.kis=(k=>async(op,args)=>{if(failing&&args.section==='overview')throw new Error('KIS_DOWN');return k(op,args);})(s.kis);
  const first=await s.agent({symbol:'005930',sections:['overview','analysts']});
  assert.equal(first.provenance.overview.from,'KIS');assert.equal(first.provenance.overview.cache,'fetched');assert.equal(first.provenance.overview.retrievedAt,'2026-10-17T01:00:00.000Z');
  assert.equal(first.provenance.overview.complete,undefined,'nothing left out of the overview');
  assert.equal(first.analysts.latest.length,4,'the digest keeps four reports');assert.equal(first.provenance.analysts.complete,false);assert.equal(first.provenance.analysts.original,'originalSections/analysts');
  assert.equal(first[TRACE].originals.analysts.latest.length,6,'the original keeps all six');assert.equal(JSON.stringify(first).includes('originalSections":'),false,'originals never reach the model');
  assert.deepEqual(first.instrument,{type:'stock',leverageFactor:1,leverageBasis:'name'});
  const again=await s.agent({symbol:'005930',sections:['overview']});assert.equal(again.provenance.overview.cache,'reused');
  assert.deepEqual(again[TRACE].reads.overview.map(r=>r.cache),['hit']);
  // Expired data whose source fails is kept, marked stale, and flagged as a risk.
  advance(20*60000);failing=true;const stale=await s.agent({symbol:'005930',sections:['overview']});
  assert.equal(stale.provenance.overview.cache,'stale');assert.equal(stale.provenance.overview.stale,true);assert.ok(stale.instrument.riskFlags.some(f=>/stale data/.test(f)));
  // Once the source answers again, the expired entry is refreshed.
  advance(11*60000);failing=false;const fresh=await s.agent({symbol:'005930',sections:['overview']});
  assert.equal(fresh.provenance.overview.cache,'fetched');assert.deepEqual(fresh[TRACE].reads.overview.map(r=>r.cache),['refreshed']);
});

test('instrument type, leverage and material filings are stated whatever sections were read',async()=>{
  const {s}=service();
  const etf=await s.agent({symbol:'122630',sections:['overview']});
  assert.equal(etf.instrument.type,'etf');assert.equal(etf.instrument.leverageFactor,2);assert.equal(etf.instrument.leverageBasis,'name');assert.ok(etf.instrument.riskFlags.some(f=>/leveraged: 2x/.test(f)));
  const halted=await s.agent({symbol:'005930',sections:['events']});
  const flags=halted.instrument.riskFlags??[];assert.ok(flags.some(f=>/material filing 2026-10-10: 주권매매거래정지/.test(f)),flags.join('; '));
  assert.equal(flags.some(f=>/관리종목/.test(f)),false,'filings older than 90 days are not flagged');assert.equal(halted.provenance.events.from,'KIS + OpenDART');
});

test('bounding pins identity, the next-session marker, instrument risk and provenance wherever they sat',()=>{
  const value={release:{text:'Long line. '.repeat(3000)},overview:{price:1},instrument:{type:'etf',leverageFactor:-2,riskFlags:['inverse: -2x the daily move, reset daily']},provenance:{release:{from:'SEC EDGAR',retrievedAt:'2026-10-17T00:00:00.000Z'}},nextSession:{awaitingOpen:true},symbol:'X'};
  const out=rc.bound(value,4000,{ref:'result-1'});
  assert.ok(rc.outBytes(out)<=4000);assert.equal(Object.keys(out)[0],'nextSession');assert.deepEqual(out.instrument,value.instrument);assert.deepEqual(out.provenance,value.provenance);
  assert.equal(out.fullResult.section,'result-1');assert.ok(out.cuts.some(c=>c.path==='release/text'));
});

// A research tool for the scout: a long release and analysts the digest shortened, with the originals kept.
const research=calls=>async args=>{calls.push(args.symbol);const out={symbol:args.symbol,release:{text:'Release sentence. '.repeat(1400)},analysts:{latest:[1,2,3,4]},provenance:{analysts:{from:'KIS',cache:'reused',complete:false,original:'originalSections/analysts'}}};
  out[TRACE]={originals:{analysts:{latest:[1,2,3,4,5,6]}},reads:{release:[{cache:'fetched'}],analysts:[{cache:'hit'}]}};return out;};

test('a reply that must name its full result keeps that reference at the size limit, shortening something else',()=>{
  const value={symbol:'005930',release:{text:'Sentence. '.repeat(300)},provenance:{release:{from:'OpenDART',cache:'reused',complete:false,original:'originalSections/release'}}};
  const limit=rc.outBytes(value)+20;assert.ok(rc.outBytes({...value,fullResult:{section:'result-1',read:'x'.repeat(40)}})>limit,'the boundary: the value fits, the value and its reference do not');
  const out=rc.bound(value,limit,{ref:'result-1',always:true});
  assert.ok(rc.outBytes(out)<=limit);assert.equal(out.fullResult.section,'result-1','the originals stay reachable');assert.deepEqual(out.provenance,value.provenance);assert.ok(out.cuts.some(c=>c.path==='release/text'));
  assert.equal(rc.bound(value,limit,{ref:'result-1'}),value,'without originals a fitting reply is unchanged');
});
test('coverage counts only usable evidence: refused, skipped and empty replies are attempts, and missing sections make it partial',()=>{
  const m=meter.createMeter();const reply=(sections)=>({provenance:Object.fromEntries(Object.entries(sections).map(([k,cache])=>[k,{cache}]))});
  m.call('get_company_research',{symbol:'A'},{status:'skipped',reason:'reads used'},{});
  m.call('get_company_research',{symbol:'B'},reply({overview:'unavailable'}),{});
  m.call('get_company_research',{symbol:'C'},reply({overview:'reused',analysts:'unavailable'}),{});
  m.call('get_company_research',{symbol:'D'},reply({overview:'stale'}),{});
  m.call('get_market_evidence',{symbol:'E'},{status:'rejected'},{});m.call('get_market_evidence',{symbol:'F'},{rows:[]},{});
  const s=m.summary(['A','B','C','D','E','F','G']);
  assert.deepEqual(s.researchedSymbols,['C','D','F'],'cached and stale evidence counts; nothing usable does not');assert.deepEqual(s.partialSymbols,['C']);assert.deepEqual(s.unavailableSymbols,['A','B','E']);
  assert.deepEqual(s.coverage,{watched:7,researched:3,partial:1,notResearched:['A','B','E','G'],attemptedNotResearched:['A','B','E']});
});
test('the scout reads shortened results back in full without spending a next-session read',async()=>{
  const calls=[];const tools=focusTools({research:research(calls),update_watchlist:()=>({status:'ok'})},{markets:['KR'],deferred:['US']},{reads:1});
  const sent=[];let round=0;
  const request=async({continuation})=>{round++;
    if(round===1)return {toolCalls:[{name:'get_company_research',callId:'a',args:{symbol:'NASD:AVGO'}}],continuation:[{role:'user',content:'context'}]};
    const outputs=continuation.filter(o=>o.type==='function_call_output').map(o=>JSON.parse(o.output));sent.push(outputs);
    if(round===2){const ref=outputs[0].fullResult.section;assert.equal(ref,'result-1');assert.equal(outputs[0].nextSession.readsLeft,0);
      return {toolCalls:[{name:'get_context_detail',callId:'d1',args:{section:ref,part:'release/text',from:100}},{name:'get_context_detail',callId:'d2',args:{section:ref,part:'originalSections/analysts',from:0}},{name:'get_company_research',callId:'b',args:{symbol:'NASD:MSFT'}}],continuation};}
    return {plan:{targets:[]}};};
  const result=await runScout({request,tools,log:()=>{},watched:['NASD:AVGO','NASD:MSFT','005930']});
  const [page,original,second]=sent[1].slice(1);
  assert.equal(page.from,100);assert.equal(page.text,'Release sentence. '.repeat(1400).slice(100,page.to),'a read from 100 starts at character 100');assert.match(page.text,/Release sentence/);
  assert.deepEqual(original.data,{latest:[1,2,3,4,5,6]},'the original before the digest');
  assert.equal(second.status,'skipped','the one next-session read was spent by the first company read, not by the detail reads');assert.deepEqual(calls,['NASD:AVGO']);
  const m=result.metrics;assert.equal(m.format,meter.FORMAT);assert.equal(m.detailReads,2);assert.equal(m.researchReads,1);assert.equal(m.fetched,1);assert.equal(m.reused,1);
  // The refused read of MSFT was attempted, not researched.
  assert.deepEqual(m.coverage,{watched:3,researched:1,partial:0,notResearched:['NASD:MSFT','005930'],attemptedNotResearched:['NASD:MSFT']});assert.deepEqual(m.unavailableSymbols,['NASD:MSFT']);assert.ok(m.toolCalls===4&&m.resultBytes>0&&m.detailBytes>0);
});

test('the scout budget covers the whole request: older results become references to their full section, and an oversized request is not sent',async()=>{
  const calls=[];const tools=focusTools({research:research(calls)},{markets:['US'],deferred:[]});
  let round=0;let last;
  const request=async({continuation})=>{round++;last=continuation;
    if(round<3)return {toolCalls:[{name:'get_company_research',callId:'r'+round,args:{symbol:round===1?'NASD:AVGO':'NASD:MSFT'}}],continuation:[...(continuation??[{role:'user',content:'context'}])]};
    return {plan:{targets:[]}};};
  // 9 KB of room below 90% of the limit once instructions and tools are counted: the second round needs the first result's room.
  const result=await runScout({request,tools,log:()=>{},maxBytes:20000,overheadBytes:9000});
  assert.ok(result.plan);const outputs=last.filter(o=>o.type==='function_call_output').map(o=>JSON.parse(o.output));
  assert.equal(outputs[0].reference,true,'the older result gave way');assert.equal(outputs[0].fullResult.section,'result-1');assert.match(outputs[0].note,/get_context_detail/);
  assert.ok(9000+Buffer.byteLength(JSON.stringify(last))<=20000,'the request sent fits the whole-request limit');
  let sentAgain=0;
  await assert.rejects(runScout({request:async()=>{sentAgain++;return {toolCalls:[{name:'search_securities',callId:'s',args:{}}],continuation:[{role:'user',content:'x'.repeat(30000)}]};},tools:{search_securities:()=>({rows:[]})},log:()=>{},maxBytes:20000,overheadBytes:6000}),
    error=>error.message==='CONTEXT_OVER_BUDGET'&&/over its 20000-byte limit/.test(error.detail));
  assert.equal(sentAgain,1,'the oversized request was never sent');
});

test('the scout client measures instructions and tool definitions against its limit',async()=>{
  const {AiClient,scoutOverheadBytes}=require('../electron/ai-client.cjs');let sent=0;
  const client=new AiClient('sk-fixture-key-123',async()=>{sent++;return new Response('{}');});
  const overhead=scoutOverheadBytes();assert.ok(overhead>10000,'instructions, tools and schema: '+overhead);
  await assert.rejects(client.scout({note:'x'.repeat(1000)},{openaiModel:'gpt-6-sol',reasoningEffort:'low',maxBytes:overhead}),error=>error.message==='CONTEXT_TOO_LARGE'&&/instructions and tools/.test(error.detail));
  assert.equal(sent,0);
});

test('research counts from a cheaper run and its confirmation add up',()=>{
  const a={format:meter.FORMAT,...Object.fromEntries(meter.COUNTS.map(k=>[k,1])),researchedSymbols:['A'],partialSymbols:['A'],unavailableSymbols:['B','C'],coverage:{watched:3,researched:1,partial:1,notResearched:['B','C'],attemptedNotResearched:['B','C']}};
  const b={format:meter.FORMAT,...Object.fromEntries(meter.COUNTS.map(k=>[k,2])),researchedSymbols:['A','B'],partialSymbols:[],unavailableSymbols:[],coverage:{watched:3,researched:2,partial:0,notResearched:['C'],attemptedNotResearched:[]}};
  const m=meter.merge(a,b);assert.equal(m.toolCalls,3);assert.deepEqual(m.researchedSymbols,['A','B']);assert.deepEqual(m.partialSymbols,[],'A came back whole in the second run');assert.deepEqual(m.unavailableSymbols,['C']);
  assert.deepEqual(m.coverage,{watched:3,researched:2,partial:0,notResearched:['C'],attemptedNotResearched:['C']});
  assert.equal(meter.merge(null,b),b);
});

test('trading reviews keep results with originals and report research metrics',async()=>{
  const {researchReview}=require('../electron/research-review.cjs');const calls=[];let round=0,seen;
  const request=async({continuation})=>{round++;
    if(round===1)return {toolCalls:[{name:'get_company_research',callId:'c1',args:{symbol:'005930'}},{name:'get_company_research',callId:'c2',args:{symbol:'005930'}}],continuation:[{role:'user',content:'ctx'}]};
    if(round===2){seen=continuation.filter(o=>o.type==='function_call_output').map(o=>JSON.parse(o.output));return {toolCalls:[{name:'get_context_detail',callId:'d',args:{section:seen[0].fullResult.section,part:'originalSections/analysts',from:0}}],continuation};}
    const detail=JSON.parse(continuation.at(-1).output);assert.deepEqual(detail.data,{latest:[1,2,3,4,5,6]});
    return {decision:{action:'Hold',symbol:'',quantity:0},usage:{inputTokens:3,outputTokens:1,cachedTokens:2}};};
  const r=await researchReview({context:{universe:[{symbol:'005930'}]},evidence:{get:async()=>({})},request,log:()=>{},discovery:{get_company_research:research(calls)},watched:['005930','000660']});
  assert.equal(seen[0].fullResult.section,'result-1','a reply with digested parts names its full section even when nothing was cut here');
  assert.deepEqual(calls,['005930'],'the repeated request was answered from the run cache');
  assert.equal(r.metrics.runCacheHits,1);assert.equal(r.metrics.detailReads,1);assert.deepEqual(r.metrics.coverage,{watched:2,researched:1,partial:0,notResearched:['000660'],attemptedNotResearched:[]});assert.equal(r.usage.cachedTokens,2);
});
