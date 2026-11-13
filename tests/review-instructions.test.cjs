// The built-in instructions in a core and parts (instruction rewrite, artifacts/reviews/2026-11-13-instruction-rewrite,
// design.md sections 2 and 9). Step 1: the machinery with today's text, so every part set gives today's text unchanged.
const test=require('node:test'),assert=require('node:assert/strict');const crypto=require('node:crypto');
const RI=require('../electron/review-instructions.cjs');const C=require('../electron/ai-client.cjs');const A=require('../electron/anthropic-client.cjs');
const sha=t=>crypto.createHash('sha256').update(t).digest('hex').slice(0,16);
const ids=RI.REVIEW_PARTS.map(p=>p.id);
const subsets=list=>list.reduce((all,id)=>all.flatMap(s=>[s,[...s,id]]),[[]]);

test('step 1: today\'s texts, whatever parts apply',()=>{
  assert.deepEqual(ids,['two-markets','extended','leveraged','credit','discovery','scout-plan','scout-brief','interval','conditional','desk']);
  assert.equal(RI.REVIEW_CORE.length,31533);assert.equal(sha(RI.REVIEW_CORE),'b0afae298315cefb');
  assert.equal(RI.SCOUT_CORE.length,9322);assert.equal(sha(RI.SCOUT_CORE),'ed636750c54c3942');
  for(const s of subsets(ids))assert.equal(RI.reviewText(s),RI.REVIEW_CORE);
  for(const s of subsets(RI.SCOUT_PARTS.map(p=>p.id)))assert.equal(RI.scoutText(s),RI.SCOUT_CORE);
  assert.equal(C.REVIEW_INSTRUCTIONS,RI.REVIEW_CORE);assert.equal(require('../electron/scout.cjs').INSTRUCTIONS,RI.SCOUT_CORE);
});
test('an unknown or repeated part is refused',()=>{
  assert.throws(()=>RI.reviewText(['nope']),/INVALID_INSTRUCTION_PARTS/);assert.throws(()=>RI.reviewText(['credit','credit']),/INVALID_INSTRUCTION_PARTS/);
  assert.throws(()=>RI.scoutText(['credit']),/INVALID_INSTRUCTION_PARTS/);
});
test('each part follows its setting or account fact, read from the context',()=>{
  const base={environment:'kis',extendedSessions:[]};
  assert.deepEqual(RI.partsFor(base),[]);
  assert.deepEqual(RI.partsFor({...base,environment:'kis-combined'}),['two-markets']);
  assert.deepEqual(RI.partsFor({...base,extendedSessions:['U.S. pre-market']}),['extended']);
  assert.deepEqual(RI.partsFor({environment:'kis'}),['extended'],'a context saved before the fact existed keeps the description');
  assert.deepEqual(RI.partsFor({...base,productRisk:{leveragedEtps:{allowed:true}}}),['leveraged']);
  assert.deepEqual(RI.partsFor({...base,productRisk:{leveragedEtps:{allowed:false},products:[{symbol:'122630',factor:2}]}}),[],'a held product alone does not add the trading part');
  assert.deepEqual(RI.partsFor({...base,environment:'kis-combined',markets:[{market:'KR',productRisk:{leveragedEtps:{allowed:true},credit:{margin:{allowed:false},short:{allowed:false},loans:[{}]}}},{market:'US'}]}),['two-markets','leveraged','credit'],'per market in a combined review; a held loan adds credit');
  assert.deepEqual(RI.partsFor({...base,discovery:{enabled:true}}),['discovery']);assert.deepEqual(RI.partsFor({...base,discovery:{enabled:false}}),[]);
  assert.deepEqual(RI.partsFor({...base,scoutPlan:{targets:[{symbol:'005930'}]}}),['scout-plan']);assert.deepEqual(RI.partsFor({...base,scoutPlan:{targets:[]}}),[]);
  assert.deepEqual(RI.partsFor({...base,scoutBrief:{runAllowed:false}}),['scout-brief']);
  assert.deepEqual(RI.partsFor({...base,reviewInterval:{auto:true,minutes:10}}),['interval']);assert.deepEqual(RI.partsFor({...base,reviewInterval:{auto:false}}),[]);
  assert.deepEqual(RI.partsFor({...base,agentDesk:{conditionalOrders:{allowed:true}}}),['conditional','desk']);assert.deepEqual(RI.partsFor({...base,agentDesk:{}}),['desk']);
  assert.deepEqual(RI.scoutPartsFor({products:{leveragedOrInverseEtps:{allowed:true}}}),['leveraged']);assert.deepEqual(RI.scoutPartsFor({}),[]);
  // The part conditions that already move the request: the same flags as the answer schema and the review tools.
  for(const c of [{scoutBrief:{}},{scoutPlan:{targets:[{}]}},{discovery:{enabled:true}},{reviewInterval:{auto:true}},{agentDesk:{conditionalOrders:{allowed:true}}}])assert.ok(RI.partsFor({...base,...c}).length);
});
test('the text stays the same from review to review: prices, news, quotes, trigger and scope do not move it',()=>{
  const ctx=extra=>({environment:'kis-combined',extendedSessions:[],discovery:{enabled:true},reviewInterval:{auto:true},agentDesk:{conditionalOrders:{allowed:true}},scoutPlan:{targets:[{symbol:'005930'}]},scoutBrief:{runAllowed:true},...extra});
  const a=RI.partsFor(ctx({quotes:[{symbol:'005930',price:217000}],news:[{title:'a'}],triggerEvidence:{kind:'news'},reviewScope:{kind:'routine'}}));
  const b=RI.partsFor(ctx({quotes:[{symbol:'005930',price:199000}],news:[{title:'b'}],triggerEvidence:{kind:'watchlist'},reviewScope:{kind:'broad'},marketSession:{open:false}}));
  assert.deepEqual(a,b);assert.equal(RI.reviewText(a),RI.reviewText(b));
});
test('every round of one review sends the same instructions, on both providers',async()=>{
  const ctx={environment:'kis',extendedSessions:[],universe:[{symbol:'005930'}],positions:{},discovery:{enabled:true,watchlist:[]},agentDesk:{conditionalOrders:{allowed:true}},reviewInterval:{auto:true}};
  const sent=[];const openai=new C.AiClient('k'.repeat(20),async(url,init)=>{sent.push(JSON.parse(init.body));return {ok:false,status:400,text:async()=>'{}',json:async()=>({}),headers:new Map()};});
  const continuation=[{role:'user',content:JSON.stringify(ctx)},{type:'function_call',name:'get_context_detail',call_id:'c1',arguments:'{}'},{type:'function_call_output',call_id:'c1',output:'{}'}];
  for(const options of [{research:true},{research:true,continuation},{research:true,final:true,continuation}])try{await openai.decide(ctx,options);}catch{}
  assert.equal(sent.length,3);for(const b of sent)assert.equal(b.instructions,RI.reviewText(RI.partsFor(ctx)));
  const bodies=[];const fetch=async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'x'}}),{status:400,headers:{'content-type':'application/json'}});};
  const claude=new A.AnthropicClient('sk-ant-api03-'+'k'.repeat(40),fetch);
  for(const options of [{research:true},{research:true,final:true}])try{await claude.decide(ctx,{openaiModel:'claude-opus-5-5',reasoningEffort:'medium',...options});}catch{}
  assert.ok(bodies.length>=2);for(const b of bodies)assert.equal(b.system[0].text,RI.reviewText(RI.partsFor(ctx)));
});
test('the scout sends its text for its context, and the size bound counts every part',async()=>{
  const sent=[];const openai=new C.AiClient('k'.repeat(20),async(url,init)=>{sent.push(JSON.parse(init.body));return {ok:false,status:400,text:async()=>'{}',json:async()=>({}),headers:new Map()};});
  try{await openai.scout({products:{leveragedOrInverseEtps:{allowed:true}}},{});}catch{}
  assert.equal(sent[0].instructions,RI.scoutText(['leveraged']));
  assert.ok(C.scoutOverheadBytes()>=Buffer.byteLength(JSON.stringify(RI.SCOUT_ALL)),'the overhead bound uses the longest scout text');
});
test('a live review context always carries the extended sessions the user switched on (R5: the absent-field fallback never applies live)',async()=>{
  const {DatabaseSync}=require('node:sqlite');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  const ctx=(market,equity)=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity,cash:market==='US'?100:500000,universe:[],positions:{},quotes:[],orders:[],marketSession:{open:true},risk:{},executionEnabled:true,automaticExecutionEnabled:true});
  const wire=()=>{a.live={...a.live,market:'KR',identity:()=>'acct',context:async()=>ctx('KR',700000),orders:()=>[],getState:()=>({})};a.usLive={market:'US',identity:()=>'acct:US',context:async()=>ctx('US',500),orders:()=>[],getState:()=>({})};a.refreshUS=async()=>null;a.fx=()=>({usdKRW:1300});};
  a.configure({scope:'both'});wire();
  let {context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'User request'});
  assert.deepEqual(context.extendedSessions,[]);assert.ok(!RI.partsFor(context).includes('extended'));
  a.configure({scope:'both',sessionKrNxt:true,sessionUsPre:true});wire();({context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'User request'}));
  assert.deepEqual(context.extendedSessions,['Nextrade pre- and after-market','U.S. pre-market']);assert.ok(RI.partsFor(context).includes('extended'));
  a.configure({scope:'us',sessionKrNxt:true,sessionUsPre:false});assert.deepEqual(a.extendedSessions(),[],'a Korean switch does not count for a U.S. account');
  assert.equal(require('../electron/review-context.cjs').classOf('extendedSessions'),'mandatory','never condensed away');
});
