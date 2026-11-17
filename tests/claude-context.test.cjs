// Item 12 step 1 (artifacts/reviews/2026-11-17-review-cost/step1-note.md, cleared): on Claude the trading review's first
// request may be 80,000 bytes and the performance section is never shortened (the AI read it back in 19 of 27 reviews
// when it was); every other section is trimmed as at 70,000 or less. OpenAI: 70,000 and today's trimming, byte for byte.
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const M=require('../electron/ai-models.cjs');const RC=require('../electron/review-context.cjs');
const CLAUDE={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'},SOL={openaiModel:'gpt-6-sol',reasoningEffort:'medium'};
// A context shaped like the live ones: about 27 KB mandatory, about 100 KB before trimming, performance with its history.
function fixture(){const rows=(n,f)=>Array.from({length:n},(_,i)=>f(i));const text=n=>'t'.repeat(n);
  const positions=Object.fromEntries(rows(20,i=>[`00${String(1000+i)}`,{quantity:10+i,costTotal:1000000+i,price:50000+i,name:text(300),notes:text(600)}]));
  const performance={history:{KR:{since:'2026-01-01',currency:'KRW',benchmark:'KOSPI',timeWeightedReturns:rows(8,i=>({period:['1D','1W','1M','3M','6M','YTD','1Y','All'][i],from:'2026-01-01',returnPct:i<2?i:5.5,benchmarkPct:i<2?i:3})),
    risk:{maxDrawdownPct:-8,currentDrawdownPct:-2,volatilityPct:14,betaPct:1},recentDailyPnl:rows(120,i=>({day:`2026-10-${String(1+i).padStart(2,'0')}`,pnl:1000*i,pct:0.1*i})),
    unrealized:rows(40,i=>({symbol:`00${1000+i}`,pnl:5000*i,pct:i})),cashSharePct:12,movers:rows(20,i=>({symbol:`00${1000+i}`,pct:i,reason:text(200)}))}}};
  return {environment:'kis',market:'KR',currency:'KRW',baseCurrency:'KRW',equity:100000000,cash:10000000,positions,orders:[],
    universe:rows(20,i=>({symbol:`00${1000+i}`,name:text(80)})),quotes:rows(20,i=>({symbol:`00${1000+i}`,price:50000+i,timestamp:1})),
    performance,macro:rows(12,i=>({id:'M'+i,name:text(80),history:rows(20,j=>({date:'2026-10-'+j,value:j}))})),news:rows(60,i=>({title:text(140)+i,source:text(30),symbols:[]})),
    similarEpisodes:rows(6,i=>({date:'2026-0'+i,title:text(100),drivers:[text(120),text(120)],sharedThemes:[text(40)]})),eventCalendar:rows(25,i=>({date:'2026-11-'+i,kind:'earnings',title:text(110)})),
    topStories:rows(10,i=>({title:text(180)+i,outlets:3})),assessments:rows(8,i=>({symbol:`00${1000+i}`,thesis:text(400),invalidation:text(200),evidence:[{sourceId:'s'+i}]})),
    positionMemory:rows(12,i=>({symbol:`00${1000+i}`,lastEntry:{rationale:text(500),thesis:text(300)}})),marketNarrative:{asOf:'x',regime:'neutral',summary:text(1500),drivers:rows(8,i=>({kind:'trigger',title:text(80),detail:text(400)}))},
    sectorLeads:{KR:{asOf:'x',sectors:rows(20,i=>({name:text(20),pct:i}))}},discovery:{enabled:true,watchlist:rows(15,i=>({symbol:'W'+i,reason:text(200)}))}};}
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
test('the limit by model: Claude 80,000 for a first request, OpenAI 70,000; 140,000 for a follow-up for every model',()=>{
  assert.equal(M.reviewByteLimit({},CLAUDE),80000);assert.equal(M.reviewByteLimit({},'claude-opus-5-5'),80000);assert.equal(M.reviewByteLimit({},SOL),70000);assert.equal(M.reviewByteLimit({},{openaiModel:'gpt-6-luna'}),70000);
  assert.equal(M.reviewByteLimit({}),70000,'no model: as before');for(const m of [CLAUDE,SOL,undefined])assert.equal(M.reviewByteLimit({continuation:[]},m),140000);
  assert.deepEqual([...M.contextKeep(CLAUDE)],['performance']);assert.deepEqual(M.contextKeep(SOL),[]);
});
test('on Claude the first context keeps performance whole (history included), fits 80,000, and no other section is cut more than at 70,000',()=>{
  const c=fixture();assert.ok(RC.wire(c)>95000,'the fixture is over the limit untrimmed');
  const claude=RC.shape(c,{limit:M.reviewByteLimit({},CLAUDE),keep:M.contextKeep(CLAUDE)}),gpt=RC.shape(c);
  assert.deepEqual(claude.context.performance,c.performance,'performance whole');assert.ok(!(claude.context.detailAvailable??[]).includes('performance'));
  assert.ok(!claude.steps.some(s=>s.section.split('.')[0]==='performance'),'no performance step');assert.ok(claude.fits&&RC.wire(claude.context)<=80000);
  assert.ok(gpt.steps.some(s=>s.section==='performance'),'on GPT performance is shortened, as today');
  // Every other section: cut by the same steps or fewer.
  const kinds=r=>{const m={};for(const s of r.steps)(m[s.section]??=new Set()).add(s.kind);return m;};const k70=kinds(gpt),k80=kinds(claude);
  for(const [section,set] of Object.entries(k80))for(const kind of set)assert.ok(k70[section]?.has(kind),`${section} ${kind} on Claude but not at 70,000`);
});
test('OpenAI: 70,000 and today\'s trimming, byte for byte (pinned)',()=>{
  const c=fixture();const today=RC.shape(c),explicit=RC.shape(c,{limit:M.reviewByteLimit({},SOL),keep:M.contextKeep(SOL)});
  assert.equal(sha(explicit.context),sha(today.context));assert.deepEqual(explicit.steps,today.steps);
  assert.equal(sha(today.context),PIN,'the GPT shape of the fixture is pinned');
});
const PIN=(()=>sha(RC.shape(fixture()).context))();
test('the reservation and replay: a 75,000-byte saved Claude context is not refused on Claude; on GPT it is, as before',()=>{
  const ctx={universe:[],big:'x'.repeat(75000)};
  assert.doesNotThrow(()=>M.reservation(CLAUDE,ctx,{maxBytes:M.reviewByteLimit({},CLAUDE)}));assert.throws(()=>M.reservation(SOL,ctx,{maxBytes:M.reviewByteLimit({},SOL)}),/CONTEXT_TOO_LARGE/);
  // Both replay paths reserve with the replay model's own limit.
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.equal(src.split('models.reservation(config,context,{maxBytes:models.reviewByteLimit({},config)})').length-1,2,'both replay reservations');
  assert.ok(!/models\.reservation\(config,context,\{\}\)/.test(src),'no replay reservation at the default 70,000');
});
test('through the app: the review shapes with the trading model\'s limit and kept sections; the dry run with its own model',async()=>{
  const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
  for(const [model,limit,keep] of [[CLAUDE,80000,['performance']],[SOL,70000,[]]]){const m=new MockKis({kr:{cash:10000000},us:{cash:5000},prices:{'005930':70000}});const h=appHarness({mock:m}).enable();const a=h.automation();
    const agentModel=a.agentModel.bind(a);a.agentModel=agent=>agent==='trading'?{...agentModel(agent),...model}:agentModel(agent);a.claudeTradingRefusal=()=>null;a.missingKey=()=>null;a.config={...a.config,shareKisWithAnthropic:true};
    const calls=[];const shape=RC.shape;RC.shape=(c,o)=>{calls.push(o);return shape(c,o);};
    try{await a.review('User request').catch(()=>{});await a.dryRun('review').catch(()=>{});}finally{RC.shape=shape;}
    assert.ok(calls.length>=2,`${model.openaiModel}: the review and the dry run shaped`);for(const o of calls){assert.equal(o?.limit,limit,model.openaiModel);assert.deepEqual([...(o?.keep??[])],keep,model.openaiModel);}
    const size=h.logs.find(x=>x[2]==='Review size');assert.equal(JSON.parse(size[3]).limitBytes,limit,'the size report says the limit');}
});
