const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const n=require('../electron/narrative.cjs');const {EpisodeLibrary}=require('../electron/episodes.cjs');
const days=(start,count)=>{const out=[];let t=Date.parse(start+'T00:00:00Z');while(out.length<count){const d=new Date(t);if(d.getUTCDay()%6)out.push(d.toISOString().slice(0,10));t+=86400000;}return out;};
test('signals cover index moves, macro readings, breadth and sectors with stable ids',()=>{
  const closes={SOX:[{day:'2026-10-15',close:11581.22},{day:'2026-10-16',close:11137.29}],KOSPI:[{day:'2026-10-16',close:5668}]};
  const s=n.signals({indexCloses:closes,labels:{SOX:'Philadelphia Semiconductor'},macro:{series:[{id:'US_10Y',name:'U.S. 10-year Treasury',value:4.6,unit:'%',date:'2026-10-16',change:0.08},{id:'US_WTI',name:'WTI',value:null}]},market:{breadth:[{index:'KOSPI',advanceRatioPct:84.9,changePct:2.05}],kospiSectors:[{code:'0013',name:'전기·전자',changePct:1.75}],foreignTopBuys:[{name:'삼성전자'}]}});
  assert.deepEqual(s.map(x=>x.id),['IDX_SOX','MACRO_US_10Y','BREADTH_KOSPI','SECTOR_0013','FLOW_FOREIGN_TOP'],'KOSPI has one close and WTI no value, so both are left out');
  assert.equal(s[0].change1dPct,-3.83);
});
test('headlines are recent, deduplicated and numbered',()=>{
  const now=Date.parse('2026-10-17T00:00:00Z');const h=n.headlines([{title:'AI stocks plunge',published:'2026-10-16T20:00:00Z',source:'CNBC',url:'https://a'},{title:'AI stocks plunge!',published:'2026-10-16T21:00:00Z',source:'X'},{title:'Old news',published:'2026-10-10T00:00:00Z'},{title:'반도체 급락',published:'2026-10-16T09:00:00+09:00',source:'KIS',url:'kis-news:1',symbols:['000660']}],now);
  assert.deepEqual(h.map(x=>[x.i,x.title]),[[0,'AI stocks plunge'],[1,'반도체 급락']]);assert.equal(h[1].url,undefined,'only web links are kept');
});
test('drivers must cite real signals; continuing drivers keep their id and start date; agents see confirmed, visible drivers',()=>{
  const db=new DatabaseSync(':memory:');let now=Date.parse('2026-10-16T08:00:00Z');const store=new n.NarrativeStore(db,()=>now);
  const raw={summary:'Chips sold off.',regime:'risk_off',drivers:[
    {kind:'trigger',title:'AI profitability doubts',summary:'Leaked financials raised doubts.',direction:'negative',themes:['ai_profitability','bogus'],affects:['U.S. AI stocks'],confirmedBy:[{signal:'IDX_SOX',observation:'SOX −3.8% on the day'},{signal:'MADE_UP',observation:'x'}],confidence:'high',continues:'',sources:[0,9]},
    {kind:'background',title:'Rumor without data',summary:'',direction:'negative',themes:['other'],affects:[],confirmedBy:[{signal:'NOPE',observation:'x'}],confidence:'low',continues:'',sources:[]}]};
  const first=n.validate(raw,{signalIds:['IDX_SOX'],headlineList:[{title:'AI stocks plunge',source:'CNBC',url:'https://a'}],previous:null,now});
  assert.deepEqual(first.drivers[0].themes,['ai_profitability']);assert.equal(first.drivers[0].confirmedBy.length,1);assert.equal(first.drivers[0].sources.length,1);assert.equal(first.drivers[1].confirmed,false);
  const saved=store.save(first);now+=86400000;
  const second=n.validate({...raw,drivers:[{...raw.drivers[0],continues:saved.drivers[0].id}]},{signalIds:['IDX_SOX'],headlineList:[],previous:saved,now});
  assert.equal(second.drivers[0].id,saved.drivers[0].id);assert.equal(second.drivers[0].since,'2026-10-16');
  const view=n.agentView(saved,now);assert.equal(view.drivers.length,1,'unconfirmed drivers are withheld');assert.deepEqual(view.drivers[0].confirmedBy,['SOX −3.8% on the day']);
  store.hide(saved.drivers[0].id);assert.equal(n.agentView(store.latest(),now),null,'a hidden driver is withheld too');assert.equal(n.agentView(saved,now+4*86400000),null,'stale after three days');
  assert.throws(()=>n.validate({drivers:[],regime:'panic'},{signalIds:[],headlineList:[]}),/INVALID_AI_RESPONSE/);
});
test('episodes: large moves become one episode per week, the seeded case gets its drivers, outcomes fill in later',()=>{
  const db=new DatabaseSync(':memory:');const lib=new EpisodeLibrary(db);const d=days('2026-09-21',40);
  const series=(fn)=>d.map((day,i)=>({day,close:fn(day,i)}));
  const kospi=series((day,i)=>day==='2026-10-15'?5200:day>'2026-10-15'?5250+i:5600+i*2),sox=series((day,i)=>day==='2026-10-14'?11000:day>='2026-10-15'?10500+i:11800+i),spx=series((day,i)=>7700+i);
  const created=lib.detect({KOSPI:kospi,SOX:sox,SPX:spx});
  assert.equal(created.length,1,'the 14th and 15th are one episode');const e=lib.list()[0];assert.equal(e.day,'2026-10-15','the larger move anchors it');assert.equal(e.title,'Semiconductor and AI selloff');assert.equal(e.kind,'selloff');assert.equal(e.drivers.length,5);
  assert.ok(e.outcomes.KOSPI.d1>0);assert.ok(e.outcomes.KOSPI.d5!=null);
  assert.equal(lib.detect({KOSPI:kospi,SOX:sox,SPX:spx}).length,0,'not detected twice');
});
test('similar episodes match on shared themes, weighting triggers, and penalize the opposite direction',()=>{
  const lib=new EpisodeLibrary(new DatabaseSync(':memory:'));
  lib.write({id:'E-1',day:'2026-10-15',kind:'selloff',title:'Chip selloff',drivers:[{kind:'trigger',title:'AI profits',themes:['ai_profitability']},{kind:'background',title:'Rates',themes:['rates']}],moves:{},outcomes:{KOSPI:{d1:1,d5:-2,d20:null}},signals:{VIX:20}});
  lib.write({id:'E-2',day:'2026-03-02',kind:'rally',title:'Policy rally',drivers:[{kind:'trigger',title:'Stimulus',themes:['korea_policy']}],moves:{}});
  const now={drivers:[{kind:'trigger',themes:['ai_profitability'],direction:'negative',confirmed:true},{kind:'background',themes:['rates','oil_energy'],direction:'negative',confirmed:true}]};
  const s=lib.similar(now,{vix:22});assert.equal(s.length,1);assert.equal(s[0].day,'2026-10-15');assert.deepEqual(s[0].sharedThemes.sort(),['ai_profitability','rates']);assert.ok(s[0].similarity>0.5&&s[0].similarity<1);
  assert.equal(lib.similar({drivers:[{kind:'trigger',themes:['ai_profitability'],direction:'positive',confirmed:true}]}).length,1);
  assert.equal(lib.similar({drivers:[]}).length,0);
});
test('building the narrative is metered, keeps cited drivers, records an episode and reaches the next review',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]);const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1000000,cash:1000000,holdings:[]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const provider={request:async(op,payload)=>{supplied.push([op,payload]);if(op==='narrative')return {narrative:{summary:'Chips sold off on AI profit doubts.',regime:'risk_off',drivers:[{kind:'trigger',title:'AI profitability doubts',summary:'s',direction:'negative',themes:['ai_profitability'],affects:['Korean memory chips'],confirmedBy:[{signal:'IDX_SOX',observation:'SOX −3.8%'}],confidence:'high',continues:'',sources:[0]},{kind:'background',title:'Unconfirmed',summary:'',direction:'negative',themes:['other'],affects:[],confirmedBy:[],confidence:'low',continues:'',sources:[]}]},usage:{inputTokens:10,outputTokens:5},model:'gpt-6-sol'};
    return {decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,paper,provider,()=>{});a.live=live;a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};
  const d=days('2026-09-21',20);a.indexCloses=()=>({SOX:d.map((day,i)=>({day,close:day==='2026-10-15'?10000:11000+i})),KOSPI:d.map((day,i)=>({day,close:5600+i}))});
  a.news=[{title:'AI stocks plunge',published:new Date().toISOString(),source:'CNBC',url:'https://cnbc.example/a'}];
  assert.match(a.narrativeAvailable(),/OpenAI/);a.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'none'});
  const saved=await a.buildNarrative();assert.equal(saved.regime,'risk_off');assert.equal(saved.drivers.filter(x=>x.confirmed).length,1);
  const call=supplied.find(([op])=>op==='narrative')[1];assert.ok(call.context.signals.some(s=>s.id==='IDX_SOX'));assert.equal(call.context.headlines[0].title,'AI stocks plunge');assert.equal(call.options.reasoningEffort,'low');
  assert.equal(db.prepare('SELECT calls FROM ai_usage').get().calls,1);assert.equal(a.episodes.list().length,1,'the SOX drop became an episode');
  await a.review();const ctx=supplied.find(([op])=>op==='decision')[1].context;assert.equal(ctx.marketNarrative.drivers.length,1);assert.equal(ctx.marketNarrative.regime,'risk_off');
  assert.ok(a.getState().narrative.latest);
});
test('the narrative request uses its own schema and no tools',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');let body;
  const client=new AiClient('sk-fixture-key-123',async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'s',regime:'neutral',drivers:[]})}]}]}));});
  const r=await client.narrative({signals:[]},{openaiModel:'gpt-6-sol',reasoningEffort:'low'});assert.equal(r.narrative.regime,'neutral');assert.equal(body.text.format.name,'market_narrative');assert.equal(body.tools,undefined);assert.equal(body.store,false);
});
