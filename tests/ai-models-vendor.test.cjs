// Anthropic provider, step A1 (artifacts/reviews/2026-11-10-anthropic-provider/plan.md): the model table knows each
// model's vendor and Claude Opus 5.5's rates; usage and cost read Anthropic's usage shape. OpenAI behaviour must not
// change: the request body AiClient.decide sends for fixed contexts, and GPT costs, settings, reservations and usage,
// are pinned against values captured from 1.5.49 before the change (tests/fixtures/ai-models-pin-1549.json).
const test=require('node:test'),assert=require('node:assert/strict');const crypto=require('node:crypto');
const m=require('../electron/ai-models.cjs');const {AiClient}=require('../electron/ai-client.cjs');
const PIN=require('./fixtures/ai-models-pin-1549.json');
const CTX={universe:[{symbol:'005930'},{symbol:'NASD:NVDA'}],quotes:[{symbol:'005930',price:217000}],agentDesk:{conditionalOrders:{allowed:true}},discovery:{enabled:true,watchlist:[]},scoutBrief:{},scoutPlan:{targets:[{symbol:'005930'}]}};
const USAGE={inputTokens:30000,outputTokens:900,cachedTokens:20000,cacheWriteTokens:9000,serviceTier:'default'};

test('pin: the OpenAI decide request body is byte-identical to 1.5.49',async()=>{
  for(const [name,opts] of [['research',{research:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium'}],['final',{research:true,final:true,openaiModel:'gpt-6-sol',reasoningEffort:'medium'}],['plain',{openaiModel:'gpt-6-luna',reasoningEffort:'none'}]]){
    let body;const c=new AiClient('fixture_key_123',async(_u,init)=>{body=init.body;return {ok:true,text:async()=>JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,explanation:'x'})}]}]})};});
    try{await c.decide(CTX,opts);}catch{}
    // Agent tools T1 (instructions 'review 2026-11-11') added cci, stochrsi and ultimate to the formula help in the
    // compute tool's description; with exactly those entries taken out, the body must still be 1.5.49's byte for byte.
    const F=require('../electron/formula.cjs');const added=['cci','stochrsi','ultimate'].map(k=>`; ${k}(${F.FUNCS[k][0].split('').map(t=>t==='s'?'sym':'n').join(',')}): ${F.FUNCS[k][2]}`).join('');
    const escaped=JSON.stringify(added).slice(1,-1);if(name!=='plain')assert.ok(body.includes(escaped),name+': the new help entries are sent');body=body.split(escaped).join('');
    // Instructions 'review 2026-11-11.2' (fact check X1): the abolished KRX single-price auction is no longer named.
    // Those two sentences are put back as they were, so every other byte is still compared with 1.5.49.
    for(const [now,then] of [['(Nextrade pre- or after-market, or a U.S. pre-market, after-market or KIS daytime session)','(Nextrade pre- or after-market, the KRX after-hours single-price auction, or a U.S. pre-market, after-market or KIS daytime session)'],
      [', and prefer protecting or trimming positions over opening large new ones. U.S.',', prefer protecting or trimming positions over opening large new ones, and note that the KRX single-price auction fills every ten minutes within a tight band around the close. U.S.']]){const e=JSON.stringify(now).slice(1,-1);if(body.includes(e))body=body.split(e).join(JSON.stringify(then).slice(1,-1));}
    // Instructions 'review 2026-11-12' (step A-R): set_conditional_order gained replaces (one sentence, one property,
    // one required entry). Exactly those are taken out; each must be present once in a body with tools.
    for(const part of [JSON.stringify(' replaces is null, or with action "add" the id of an armed stop loss for the same symbol and side: the new stop loss is armed and that order cancelled together, and if the new one is refused, that order stays armed unchanged.').slice(1,-1),'"replaces":{"type":["string","null"]},','"replaces",']){
      if(name!=='plain')assert.equal(body.split(part).length,2,name+': sent once: '+part.slice(0,40));body=body.split(part).join('');}
    // Instructions 'review 2026-11-13' (instruction rewrite, step 2): complexity left the answer form and its sentence left
    // the text. Exactly those are put back, each at its place, so every other byte is still compared with 1.5.49.
    const sentence=JSON.stringify('complexity rates, from 0 to 100, how hard the decision in the next review is likely to be, with a one-line reason: low when nothing is close to changing (cash or positions far from stops and targets, no candidate near its entry condition, no earnings or major data due, a quiet market), high when a position nears its stop or target, a candidate nears its entry condition, earnings or major data are due within a day, or the market is moving sharply; the app uses it with its own measures to choose the model for the next review. ').slice(1,-1);
    assert.ok(!body.includes('complexity'),name+': no complexity is sent');
    for(const [at,put] of [['positionSizing gives, per symbol',sentence+'positionSizing gives, per symbol'],['"strategyCheck":{"type":"array"','"complexity":{"type":"object","properties":{"score":{"type":"integer"},"reason":{"type":"string"}},"required":["score","reason"],"additionalProperties":false},"strategyCheck":{"type":"array"'],['"plan","strategyCheck"','"plan","complexity","strategyCheck"']]){
      assert.equal(body.split(at).length,2,name+': once: '+at.slice(0,30));body=body.replace(at,put);}
    assert.deepEqual({sha256:crypto.createHash('sha256').update(body).digest('hex'),length:body.length},PIN[name],name);
  }
});
test('pin: GPT costs, settings, reservation and usage are unchanged',()=>{
  for(const model of ['gpt-6-luna','gpt-6-sol','gpt-6-astra','gpt-6-sol-2026-10-01'])assert.deepEqual(m.costDetails(model,USAGE),PIN['cost '+model],model);
  assert.deepEqual(m.costDetails('gpt-6-sol',{inputTokens:300000,outputTokens:900,cachedTokens:200000,cacheWriteTokens:90000,serviceTier:'default'}),PIN['cost sol long'],'the long-input surcharge still applies to GPT');
  assert.deepEqual(m.costDetails('gpt-6-sol',{...USAGE,serviceTier:'flex'}),PIN['cost sol flex']);
  assert.equal(m.reservation({openaiModel:'gpt-6-sol',reasoningEffort:'medium'},{a:'x'.repeat(1000)}),PIN['reservation sol']);
  assert.deepEqual([m.settings({openaiModel:'gpt-6-sol',reasoningEffort:'medium'}),m.settings({})],PIN.settings);
  const openaiBody={usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:50,cache_write_tokens:20},output_tokens_details:{reasoning_tokens:5}},service_tier:'flex'};
  assert.deepEqual(m.normalizeUsage(openaiBody),PIN.usage);assert.deepEqual(m.normalizeUsage(openaiBody,'openai'),PIN.usage);
});
test('each model names its vendor; unknown models are refused',()=>{
  assert.equal(m.vendorOf('gpt-6-sol'),'openai');assert.equal(m.vendorOf('gpt-6-luna'),'openai');assert.equal(m.vendorOf('gpt-6-sol-2026-10-01'),'openai','a dated GPT id keeps matching its row');
  assert.equal(m.vendorOf('claude-opus-5-5'),'anthropic');
  for(const bad of ['claude-opus-5-5-20260101','claude-opus-5','claude-haiku-5-5','claude-sonnet-5-5','gpt-7',undefined,null,'',42])assert.throws(()=>m.vendorOf(bad),/INVALID_MODEL_SETTINGS/,String(bad));
  assert.equal(m.MODELS['claude-opus-5-5'].vendor,'anthropic');assert.ok(Object.entries(m.MODELS).every(([k,r])=>r.vendor===(k.startsWith('claude-')?'anthropic':'openai')));
  assert.equal(Object.keys(m.MODELS).filter(k=>k.startsWith('claude-')).length,1,'only Opus 5.5 in step A1 (Haiku comes in stage B)');
});
test('Claude settings: efforts low, medium and high; no "none"; 32,000 output tokens (B2)',()=>{
  assert.throws(()=>m.settings({openaiModel:'claude-opus-5-5',reasoningEffort:'none'}),/INVALID_MODEL_SETTINGS/);
  assert.throws(()=>m.settings({openaiModel:'claude-opus-5-5'}),/INVALID_MODEL_SETTINGS/,'the default effort none is not valid for Claude');
  for(const effort of ['low','medium','high'])assert.deepEqual(m.settings({openaiModel:'claude-opus-5-5',reasoningEffort:effort}),{model:'claude-opus-5-5',effort,maxOutput:32000});
  for(const effort of ['xhigh','max','Medium',''])assert.throws(()=>m.settings({openaiModel:'claude-opus-5-5',reasoningEffort:effort}),/INVALID_MODEL_SETTINGS/,effort);
  assert.throws(()=>m.settings({openaiModel:'claude-opus-5-5-20260101',reasoningEffort:'medium'}),/INVALID_MODEL_SETTINGS/,'dated Claude ids are not accepted');
});
test('Anthropic usage normalises to the app meaning: input includes cache reads and writes',()=>{
  const u=m.normalizeUsage({usage:{input_tokens:1000,cache_read_input_tokens:8000,cache_creation_input_tokens:2000,output_tokens:500}},'anthropic');
  assert.deepEqual(u,{inputTokens:11000,outputTokens:500,cachedTokens:8000,cacheWriteTokens:2000,reasoningTokens:null,serviceTier:'standard'});
  // Missing cache fields count as zero; a missing or broken count is unknown, not zero.
  assert.deepEqual(m.normalizeUsage({usage:{input_tokens:1000,output_tokens:5}},'anthropic'),{inputTokens:1000,outputTokens:5,cachedTokens:0,cacheWriteTokens:0,reasoningTokens:null,serviceTier:'standard'});
  assert.equal(m.normalizeUsage({usage:{input_tokens:-1,output_tokens:5}},'anthropic').inputTokens,null);
  assert.equal(m.normalizeUsage({usage:{input_tokens:10,cache_read_input_tokens:1.5,output_tokens:5}},'anthropic').inputTokens,null);
  assert.equal(m.normalizeUsage({},'anthropic'),null);assert.equal(m.normalizeUsage(null,'anthropic'),null);
  assert.equal(m.normalizeUsage({usage:{input_tokens:1,output_tokens:1,service_tier:'priority'}},'anthropic').serviceTier,'priority');
  assert.throws(()=>m.normalizeUsage({usage:{}},'other'),/INVALID_MODEL_SETTINGS/);
});
test('Opus 5.5 cost uses its own cache rates and no long-input surcharge',()=>{
  const u=m.normalizeUsage({usage:{input_tokens:1000,cache_read_input_tokens:8000,cache_creation_input_tokens:2000,output_tokens:500}},'anthropic');
  const c=m.costDetails('claude-opus-5-5',u);assert.equal(c.micro,1000*4+8000*0.2+2000*5+500*20);
  assert.deepEqual(c.rates,{input:4,cached:0.2,write:5,output:20});assert.equal(c.tier,'standard');assert.equal(c.cacheDetailsKnown,true);
  const big={inputTokens:500000,outputTokens:1000,cachedTokens:400000,cacheWriteTokens:50000,serviceTier:'standard'};
  assert.equal(m.costDetails('claude-opus-5-5',big).micro,50000*4+400000*0.2+50000*5+1000*20,'no 272,000-token surcharge on Claude');
  // Only the standard tier is priced for Claude in this step; anything else is an unknown cost (the reservation stays).
  assert.equal(m.costDetails('claude-opus-5-5',{...big,serviceTier:'priority'}),null);assert.equal(m.costDetails('claude-opus-5-5',{...big,serviceTier:'batch'}),null);
  assert.equal(m.costDetails('claude-opus-5-5-20260101',big),null,'a dated id does not match the Claude row');assert.equal(m.costDetails('claude-haiku-5-5',big),null);
  assert.equal(m.costDetails('claude-opus-5-5',{...big,cachedTokens:600000}),null,'cache counts above the input are refused');
  assert.equal(m.usageEstimate('claude-opus-5-5',u),c.micro);
});
test('the Opus reservation is finite and above GPT Sol for the same context',()=>{
  const ctx={a:'x'.repeat(5000)};const opus=m.reservation({openaiModel:'claude-opus-5-5',reasoningEffort:'medium'},ctx),sol=m.reservation({openaiModel:'gpt-6-sol',reasoningEffort:'medium'},ctx);
  assert.ok(Number.isFinite(opus)&&opus>sol,`opus ${opus} > sol ${sol}`);assert.ok(opus>=32000*20,'covers 32,000 output tokens at $20 per million');
  assert.throws(()=>m.reservation({openaiModel:'claude-opus-5-5',reasoningEffort:'none'},ctx),/INVALID_MODEL_SETTINGS/);
});
// A1b: a Claude model cannot be saved as a trading model, main or routine, and a replay cannot run on it, until trading
// on Claude is approved. 1.5.49 refused these ids as unknown; A1 made them known, so the refusal is now explicit.
const automation=()=>{const {DatabaseSync}=require('node:sqlite');const {Automation}=require('../electron/automation.cjs'),{PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');return new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),{},()=>{});};
test('A1b: configure refuses a Claude id as the main or routine model and keeps the saved settings',()=>{
  assert.equal(m.CLAUDE_TRADING_ENABLED,false);assert.throws(()=>m.assertTradingModel('claude-opus-5-5'),/CLAUDE_NOT_ENABLED_FOR_TRADING/);m.assertTradingModel('gpt-6-sol');
  const a=automation();a.configure({openaiModel:'gpt-6-sol',reasoningEffort:'medium',routineModel:'gpt-6-luna',routineEffort:'none'});const before=JSON.stringify(a.config);
  assert.throws(()=>a.configure({openaiModel:'claude-opus-5-5',reasoningEffort:'medium'}),/CLAUDE_NOT_ENABLED_FOR_TRADING/);
  assert.throws(()=>a.configure({routineModel:'claude-opus-5-5',routineEffort:'low'}),/CLAUDE_DRY_RUN_REQUIRED/);// B3: until a completed Claude dry run
  assert.throws(()=>a.configure({openaiModel:'claude-opus-5-5',reasoningEffort:'none'}),/INVALID_MODEL_SETTINGS/,'an invalid effort is still the settings error');
  assert.equal(JSON.stringify(a.config),before,'nothing was saved');
  // Saved to the database too: a new automation over the same database reads the GPT settings.
  const again=new (require('../electron/automation.cjs').Automation)(a.db,a.paper,{},()=>{});assert.equal(again.config.openaiModel,'gpt-6-sol');assert.equal(again.config.routineModel,'gpt-6-luna');
  // GPT ids are still accepted for both roles.
  a.configure({openaiModel:'gpt-6-astra',reasoningEffort:'low',routineModel:'gpt-6-sol',routineEffort:'low'});assert.equal(a.config.openaiModel,'gpt-6-astra');
});
test('A1b: a replay on a Claude model is refused as an invalid model; a GPT model change still passes that check',async()=>{
  const a=automation();a.narrativeAvailable=()=>null;
  // C1: Claude Opus 5.5 at medium is a replay model once the Claude gate is open; here it is closed, so it is refused for
  // that (CLAUDE_DRY_RUN_REQUIRED). Any other Claude id or effort stays an invalid model.
  await assert.rejects(a.replay({model:{openaiModel:'claude-opus-5-5',reasoningEffort:'medium'}}),/CLAUDE_DRY_RUN_REQUIRED/);
  await assert.rejects(a.replay({model:{openaiModel:'claude-opus-5-5',reasoningEffort:'low'}}),/INVALID_MODEL_SETTINGS/);
  await assert.rejects(a.replay({model:{openaiModel:'claude-opus-5-5-20260101',reasoningEffort:'medium'}}),/INVALID_MODEL_SETTINGS/);
  await assert.rejects(a.replay({model:{openaiModel:'gpt-6-sol',reasoningEffort:'low'}}),e=>e.message!=='INVALID_MODEL_SETTINGS','a GPT model passes the model check');
});
