// Sectors S2 (artifacts/reviews/2026-11-25-sectors): the AI assignment. One call for several instruments on the helper
// model, only what describes the instrument (nothing of the account), a strict enum answer, stored once and asked again
// only when KIS's category changes or on "Assign again", at most 20 a call and 60 a day, never during a review, a scout run
// or a keep-alive, counted and shown, a failure said once and tried the next day. Mock provider and fake transports only.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const S=require('../electron/sectors.cjs');const {adapt}=require('./fixtures/claude-flat.cjs');
const ACCOUNT_KEYS=/quantity|value|weightPct|cost|cash|equity|price|units|positions|holdingsValue/i;

test('what is sent: only what describes the instrument; nothing of the account even when the caller passes it',()=>{
  const p=S.classifyPayload([{symbol:'990001',name:'Fixture A',englishName:'FIXTURE A',listing:'KOSPI',type:'stock',category:'전기·전자',quantity:120,value:12000000,cost:9000000,cash:500000,weight:12.5,valueKRW:1,price:100000},
    {symbol:'990002',name:'Fixture Fund',listing:'KOSPI',type:'etf',category:null,fund:{index:'Fixture 200',structure:'수익증권',holdings:[{name:'Fixture A',weightPct:21.37,units:3,value:5}],nav:1}}]);
  assert.deepEqual(Object.keys(p),['sectors','instruments']);assert.deepEqual(p.sectors,S.ALL);
  assert.deepEqual(p.instruments[0],{symbol:'990001',name:'Fixture A',englishName:'FIXTURE A',listing:'KOSPI',type:'stock',exchangeCategory:'전기·전자'});
  assert.deepEqual(p.instruments[1].fund,{index:'Fixture 200',structure:'수익증권',largestHoldings:[{name:'Fixture A',weightPct:21.4}]},'a fund\'s own basket weights, not the account\'s');
  const text=JSON.stringify(p.instruments.map(i=>({...i,fund:i.fund?{...i.fund,largestHoldings:(i.fund.largestHoldings??[]).map(h=>h.name)}:undefined})));
  assert.doesNotMatch(text,ACCOUNT_KEYS);assert.doesNotMatch(JSON.stringify(p),/120|12000000|9000000|500000|12\.5/);
  assert.equal(S.classifyPayload(Array.from({length:30},(_,i)=>({symbol:String(990100+i)}))).instruments.length,20,'at most 20 a call');
  assert.doesNotMatch(S.CLASSIFY_INSTRUCTIONS,/buy|sell|trad|order|weight/i,'classification only');assert.match(S.CLASSIFY_INSTRUCTIONS,/If neither tells you the sector, answer Unclassified; do not guess./);
});

test('the answer: a sector of the list for a symbol asked; anything else is dropped; the detail at most 40 characters',()=>{
  const got=S.parseClassification({items:[{symbol:'990001',sector:'Industrials',detail:'Shipbuilding'},{symbol:'990002',sector:'Crypto',detail:''},{symbol:'990009',sector:'Energy',detail:''},{symbol:'990003',sector:'Commodities',detail:'x'.repeat(60)},{symbol:'990001',sector:'Energy',detail:''}]},['990001','990002','990003']);
  assert.deepEqual([...got],[['990001',{sector:'Industrials',detail:'Shipbuilding'}],['990003',{sector:'Commodities',detail:'x'.repeat(40)}]]);
  assert.equal(S.parseClassification(null,['990001']).size,0);
});

test('needs an assignment: not with your label, not when the table gives it, not when stored from the same category; again when KIS\'s category changes',()=>{
  assert.equal(S.needsAssignment({symbol:'990001',label:'Mine',kisNames:['전기·전자']}).need,false);
  assert.equal(S.needsAssignment({symbol:'990001',kisNames:['제약']}).need,false);
  assert.deepEqual(S.needsAssignment({symbol:'990001',kisNames:[null,'전기·전자']}),{need:true,category:'전기·전자'});
  const stored={sector:'Information Technology',category:'전기·전자'};
  assert.equal(S.needsAssignment({symbol:'990001',kisNames:['전기·전자'],stored}).need,false,'not repeated');
  assert.deepEqual(S.needsAssignment({symbol:'990001',kisNames:['기계·장비'],stored}),{need:true,category:'기계·장비'},'asked again when the category changes');
  assert.equal(S.needsAssignment({symbol:'990002',type:'etf',kisNames:['ETF(실물복제/수익증권)'],stored:{sector:'Broad index',category:null}}).need,false,'a fund has no category; stored once');
  assert.deepEqual(S.needsAssignment({symbol:'990002',type:'etf',kisNames:['ETF(실물복제/수익증권)']}),{need:true,category:null});
});

test('the store: a write clears the resolver for the symbol so it shows at once; Assign again removes it',()=>{
  const db=new DatabaseSync(':memory:');const cleared=[];const store=new S.SectorStore(db,{onWrite:s=>cleared.push(s)});
  let reads=0;const r=new S.SectorResolver({label:()=>'',read:s=>{reads++;return {type:'stock',kisNames:['전기·전자'],stored:store.get(s)};}});store.onWrite=s=>{cleared.push(s);r.clear(s);};
  assert.equal(r.of('990001').sector,'Unclassified');store.write('990001',{sector:'Information Technology',detail:'Semiconductors',model:'claude-haiku-5-5',at:1,category:'전기·전자'});
  assert.deepEqual(r.of('990001'),{sector:'Information Technology',detail:'Semiconductors',source:'ai',model:'claude-haiku-5-5',at:1},'at once');assert.deepEqual(cleared,['990001']);
  assert.equal(store.forget('990001'),true);assert.equal(r.of('990001').sector,'Unclassified');assert.throws(()=>store.write('990001',{sector:'Crypto',at:1}),/INVALID_SECTOR/);
});

// The engine with a mock provider.
function engine({answer,candidates}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const paper=new PaperEngine(db,[{symbol:'990001',price:1,name:'F'}],()=>[]);const sent=[],logs=[];
  const a=new Automation(db,paper,{request:async(op,payload)=>{sent.push([op,payload]);if(op==='classify')return answer(payload);throw new Error('not in this fixture: '+op);}},(id,kind,title,body)=>logs.push({kind,title,body}));
  a.providerStatus.aiConnected=true;a.configure({provider:'openai',reasoningEffort:'low'});a.consentFor=()=>true;a.sectorStore=new S.SectorStore(db);a.sectorCandidates=()=>candidates;
  return {a,db,sent,logs,calls:()=>sent.filter(([op])=>op==='classify')};}
const items=n=>Array.from({length:n},(_,i)=>({symbol:String(990100+i),name:'Fixture '+i,listing:'KOSPI',type:'stock',category:'전기·전자',quantity:10,value:1000}));
const ok=p=>({items:p.payload.instruments.map(i=>({symbol:i.symbol,sector:'Industrials',detail:''})),usage:{inputTokens:900,outputTokens:200,cachedTokens:0,cacheWriteTokens:0,serviceTier:'default'},model:'gpt-6-luna',provider:'ai'});

test('the engine: one call for several, stored, counted and shown; 20 a call, 60 a day; nothing of the account sent',async()=>{
  const e=engine({answer:ok,candidates:items(25)});const r=await e.a.assignSectors();assert.deepEqual(r,{asked:20,assigned:20});
  assert.equal(e.calls().length,1);const [,p]=e.calls()[0];assert.equal(p.payload.instruments.length,20);assert.doesNotMatch(JSON.stringify(p.payload),/quantity|"value"/);
  assert.equal(p.options.openaiModel,e.a.agentModel('compacting').openaiModel,'the helper model set for condensing');
  assert.equal(e.a.sectorStore.get('990100').sector,'Industrials');assert.equal(e.a.sectorStore.get('990100').category,'전기·전자');
  const row=e.db.prepare('SELECT payload FROM ai_calls').all().map(x=>JSON.parse(x.payload)).find(x=>x.kind==='sectors');assert.equal(row.status,'completed');
  assert.equal(e.db.prepare('SELECT calls FROM ai_usage').get().calls,1);assert.ok(e.logs.some(l=>l.title==='Sectors assigned'&&/^20 of 20 instruments given a sector by gpt-6-luna, about \$/.test(l.body)));
  await e.a.assignSectors();await e.a.assignSectors();assert.equal(e.a.sectorStore.day(require('../electron/kis-activity.cjs').seoulDate()).asked,60);
  assert.deepEqual(await e.a.assignSectors(),{skipped:'daily cap'});assert.equal(e.calls().length,3,'60 a day');
});

test('the engine: a failure is said once and tried the next day; no call during a review, a scout run, a keep-alive or with background AI paused',async()=>{
  const e=engine({answer:()=>{throw new Error('AI_REQUEST_FAILED');},candidates:items(3)});assert.deepEqual(await e.a.assignSectors(),{failed:'AI_REQUEST_FAILED'});
  assert.deepEqual(await e.a.assignSectors(),{skipped:'failed today'});assert.equal(e.logs.filter(l=>l.title==='Sector assignment failed').length,1);assert.equal(e.calls().length,1);
  for(const [k,v] of [['busy',true],['scouting',true],['keepAliveBusy',true],['backgroundPaused',true]]){const f=engine({answer:ok,candidates:items(2)});f.a[k]=v;f.a.sectorTick(Date.now());await new Promise(r=>setTimeout(r,5));assert.equal(f.calls().length,0,k);}
  const g=engine({answer:ok,candidates:items(2)});g.a.sectorTick(Date.now());await new Promise(r=>setTimeout(r,20));assert.equal(g.calls().length,1);g.a.sectorTick(Date.now()+60000);await new Promise(r=>setTimeout(r,5));assert.equal(g.calls().length,1,'at most every 10 minutes');
  const h=engine({answer:ok,candidates:items(2)});h.a.consentFor=()=>false;assert.deepEqual(await h.a.assignSectors(),{skipped:'DATA_SHARING_NOT_ENABLED'});assert.equal(h.calls().length,0);
});

test('the clients: Claude and OpenAI send the classification instructions and the strict enum schema, and nothing else of the app',async()=>{
  const {AnthropicClient}=require('../electron/anthropic-client.cjs');const sent=[];
  const t=async(url,init)=>{const body=JSON.parse(init.body);sent.push(body);const r={id:'m',type:'message',role:'assistant',model:'claude-haiku-5-5',content:[{type:'text',text:JSON.stringify({items:[{symbol:'990001',sector:'Energy',detail:''}]})}],stop_reason:'end_turn',stop_details:null,usage:{input_tokens:10,output_tokens:5},input_transformations:[]};return new Response(JSON.stringify(adapt(r,body)),{status:200,headers:{'content-type':'application/json'}});};
  const c=new AnthropicClient('sk-ant-api03-'+'s'.repeat(40),t);const r=await c.classify(S.classifyPayload(items(1)),{openaiModel:'claude-haiku-5-5',reasoningEffort:'low'});
  assert.deepEqual(r.items,[{symbol:'990001',sector:'Energy',detail:''}]);assert.equal(sent[0].system[0].text,S.CLASSIFY_INSTRUCTIONS);assert.ok(JSON.stringify(sent[0].output_config.format).includes('"Multi-asset"'));
  const {AiClient}=require('../electron/ai-client.cjs');const oa=[];const o=new AiClient('sk-'+'o'.repeat(40),async(url,init)=>{oa.push(JSON.parse(init.body));return new Response(JSON.stringify({status:'completed',model:'gpt-6-luna',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({items:[]})}]}],usage:{input_tokens:5,output_tokens:2}}),{status:200});});
  await o.classify(S.classifyPayload(items(1)),{openaiModel:'gpt-6-luna',reasoningEffort:'low'});assert.equal(oa[0].instructions,S.CLASSIFY_INSTRUCTIONS);assert.deepEqual(oa[0].text.format.schema,S.CLASSIFY_SCHEMA);assert.equal(oa[0].prompt_cache_key,'sector-classify-v1');
});

// Review of S2: three changes.
test('review 1: a rate-limited classify neither starts nor extends a provider wait, nor touches the review backoff',async()=>{
  const limited=()=>{throw Object.assign(new Error('AI_RATE_LIMITED'),{providerError:{status:429,vendor:'openai',errorType:'rate_limit_error',retryAfterSec:60}});};
  const control=engine({answer:limited,candidates:items(1)});control.a.noteProviderOutcome('openai',(()=>{try{limited();}catch(e){return e;}})());
  assert.ok(control.a.providerWaitState().length>0,'the same refusal on a noted operation starts a wait (the control)');
  const e=engine({answer:limited,candidates:items(2)});const before=JSON.stringify(e.a.reviewBackoff());
  assert.deepEqual(await e.a.assignSectors(),{failed:'AI_RATE_LIMITED'});assert.deepEqual(e.a.providerWaitState(),[],'no provider wait');assert.equal(JSON.stringify(e.a.reviewBackoff()),before);
  assert.match(e.logs.find(l=>l.title==='Sector assignment failed').body,/AI_RATE_LIMITED/,'the line carries the code');
});

test('review 2: Unclassified is an answer: stored with its model, time and category, shown as not told, not asked again until the category changes',async()=>{
  assert.ok(S.CLASSIFY_SCHEMA.properties.items.items.properties.sector.enum.includes('Unclassified'));
  assert.deepEqual([...S.parseClassification({items:[{symbol:'990001',sector:'Unclassified',detail:''}]},['990001'])],[['990001',{sector:'Unclassified',detail:null}]]);
  // The model says Unclassified for one, leaves one out and gives a bad sector for a third: all three stored as not told.
  const e=engine({answer:()=>({items:[{symbol:'990100',sector:'Unclassified',detail:''},{symbol:'990102',sector:'Crypto',detail:''},{symbol:'990103',sector:'Energy',detail:''}],usage:{inputTokens:900,outputTokens:50,cachedTokens:0,cacheWriteTokens:0,serviceTier:'default'},model:'gpt-6-luna'}),candidates:items(4)});
  assert.deepEqual(await e.a.assignSectors(),{asked:4,assigned:1});
  for(const s of ['990100','990101','990102'])assert.deepEqual((({sector,model,category})=>({sector,model,category}))(e.a.sectorStore.get(s)),{sector:'Unclassified',model:'gpt-6-luna',category:'전기·전자'},s);
  assert.equal(e.a.sectorStore.get('990103').sector,'Energy');
  assert.ok(e.logs.some(l=>l.title==='Sectors assigned'&&/^1 of 4 instruments given a sector .* 3 could not be told; they stay Unclassified until KIS's category changes or you press Assign again\.$/.test(l.body)));
  const stored=e.a.sectorStore.get('990100');const r=S.resolve({symbol:'990100',kisNames:['전기·전자'],stored});
  assert.deepEqual([r.sector,r.source,r.untold,r.model],['Unclassified','ai',true,'gpt-6-luna']);
  assert.equal(S.needsAssignment({symbol:'990100',kisNames:['전기·전자'],stored}).need,false,'not asked again every day');
  assert.equal(S.needsAssignment({symbol:'990100',kisNames:['화학'],stored}).need,true,'asked again when the category changes');
});

test('review 2: the editor line says the AI could not tell, with its model and date',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../src/UnifiedPortfolio.tsx'),'utf8');
  assert.ok(src.includes("s.app.source==='ai'&&s.app.sector==='Unclassified'?`AI could not tell (${s.app.model??'—'}, ${s.app.at?new Date(s.app.at).toLocaleDateString('en-CA'):'—'})`"));
  assert.ok(src.includes("editRow?.sectorInfo?.app.source==='ai'&&!sector.trim()&&<button"),'Assign again shows for any AI result, not told included');
});
