'use strict';
// "The compiled grammar is too large" (1.5.55 dry run): the Claude decision and the Claude scout without a grammar
// (artifacts/reviews/2026-11-12-claude-dry-run/design-grammar.md, option A; review conditions G1 to G7). No network.
const test=require('node:test');const assert=require('node:assert/strict');
const A=require('../electron/anthropic-client.cjs');const C=require('../electron/ai-client.cjs');const scout=require('../electron/scout.cjs');
const KEY='sk-ant-fixture-grammar-key-0000';const OPTS={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const CTX={universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:217000}]};
const reply=(content,stop='end_turn')=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'sig'},...content],stop_reason:stop,stop_details:null,usage:{input_tokens:100,output_tokens:50,service_tier:'standard'},input_transformations:[]});
const text=t=>({type:'text',text:t});
// The text form is the fallback since the enforced form (artifacts/reviews/2026-11-13-enforced-form, review E5): this fake
// refuses the decision's and the scout's enforced form as Anthropic did ("compiled grammar is too large"), so the client
// falls back for the day and every request here is in the 1.5.56 text form. Refused requests are not recorded in `sent`.
const GRAMMAR_400=()=>new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.'}}),{status:400,headers:{'content-type':'application/json'}});
const transport=(...replies)=>{const sent=[];const fn=async(url,init)=>{const b=JSON.parse(init.body);if(b.output_config?.format&&(b.tools||b.output_config.format.schema?.properties?.plan_horizon))return GRAMMAR_400();sent.push(b);const r=replies.length>1?replies.shift():replies[0];return new Response(JSON.stringify(r),{status:200,headers:{'content-type':'application/json'}});};fn.sent=sent;return fn;};
const HOLD={action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'No trade.'};
const decide=async(answer,ctx=CTX,opts=OPTS)=>new A.AnthropicClient(KEY,transport(reply([text(answer)]))).decide(ctx,opts);
const refused=async(answer,rule)=>{const e=await decide(answer).then(()=>null,x=>x);assert.ok(e,`refused: ${answer.slice(0,40)}`);assert.equal(e.message,'INVALID_AI_RESPONSE');if(rule)assert.match(String(e.detail?.rule),rule,answer.slice(0,40));return e;};

test('G1: the whole answer is one JSON object, or one json fence around one object; anything else is INVALID_AI_RESPONSE',async()=>{
  const o=JSON.stringify(HOLD);
  for(const ok of [o,`  ${o}\n`,'```json\n'+o+'\n```','\n```json\n'+o+'\n```\n'])assert.equal((await decide(ok)).decision.action,'Hold',JSON.stringify(ok.slice(0,12)));
  for(const bad of [`Here is my decision: ${o}`,`${o}\nThat is all.`,o+o,`[${o}]`,'```\n'+o+'\n```','```json\n'+o+'\n```\n```json\n'+o+'\n```','```json '+o+'```','null','"Hold"','{"action":"Hold",'])
    await refused(bad,/a decision that is not valid JSON/);
  await refused('',/no decision and no tool request/);await refused('   \n ',/no decision and no tool request/);
});

test('G2: an unknown top-level key is refused; unknown nested keys never reach the stored decision, plan, order or log',async()=>{
  await refused(JSON.stringify({...HOLD,secretField:1}),/unexpected secretField/);
  const buy={action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'Buy one.',
    plan:{horizon:'swing',thesis:'t',invalidation:'i',stopPrice:200000,targetPrice:null,horizonDays:30,confidence:'low',portfolioImpact:{weightBeforePct:0,weightAfterPct:2,related:[],relatedBeforePct:0,relatedAfterPct:0,equityReliable:true,why:'w',EXTRA_PI:1},evidence:[{claim:'c',source:'s',verified:true,EXTRA_EV:1}],valuation:null,uncertainty:null,EXTRA_PLAN:1},
    complexity:{score:40,reason:'r',EXTRA_CX:1},strategyCheck:[{horizon:'swing',instrument:'unleveraged',direction:'long',funding:'cash',idea:'i',verdict:'acted',reason:'r',EXTRA_SC:1}],
    execution:{bound:217500,cancelAfter:'',cancelIf:[{expr:'price("005930")',op:'<',value:1,EXTRA_IF:1}],EXTRA_EX:1},reversal:null,
    planVerdicts:[{symbol:'005930',verdict:'acted',reason:'r',EXTRA_PV:1}],scoutBrief:{request:'none',EXTRA_SB:1}};
  const r=await decide(JSON.stringify(buy),{...CTX,scoutBrief:{},scoutPlan:{targets:[{symbol:'005930'}]}});
  const stored=JSON.stringify(r.decision);for(const k of ['EXTRA_PI','EXTRA_EV','EXTRA_PLAN','EXTRA_CX','EXTRA_SC','EXTRA_IF','EXTRA_EX','EXTRA_PV','EXTRA_SB'])assert.ok(!stored.includes(k),k+' does not reach the decision');
  assert.equal(r.decision.action,'Buy');
});

test('G3: no coercion on the core fields',async()=>{
  for(const [patch,rule] of [[{quantity:'5'},/quantity that is not a whole number/],[{action:'hold'},/action other than/],[{action:'BUY'},/action other than/],[{explanation:null},/explanation that is not text/],[{symbol:5930},/symbol that is not text/],[{loanDate:null},/loanDate/],[{quantity:1.5},/whole number/],[{credit:'NONE'},/credit/]])
    await refused(JSON.stringify({...HOLD,...patch}),rule);
});

test('G4: the shape block is the app\'s schema with its bounds and one format sentence, inside the cached system prefix, the same for every round',async()=>{
  const call={type:'tool_use',id:'tu1',name:'get_market_evidence',input:{symbol:'005930',dataset:'quote'}};
  const t=transport(reply([call],'tool_use'),reply([text(JSON.stringify(HOLD))]));const c=new A.AnthropicClient(KEY,t);
  const first=await c.decide(CTX,{...OPTS,research:true});const cont=[...first.continuation,{type:'function_call_output',call_id:'tu1',output:'{}'}];await c.decide(CTX,{...OPTS,research:true,continuation:cont,final:true});
  const [r1,r2]=t.sent;assert.deepEqual(r1.system,r2.system,'the same system for every round');
  assert.equal(r1.system.length,2);assert.equal(r1.system[0].cache_control,undefined);assert.deepEqual(r1.system[1].cache_control,{type:'ephemeral'},'one breakpoint after the shape: the instructions and the shape are cached together');
  const [sentence,json]=[r1.system[1].text.split('\n')[0],r1.system[1].text.slice(r1.system[1].text.indexOf('\n')+1)];
  assert.equal(sentence,`${A.SHAPE_SENTENCE} ${A.PLAIN_TEXT}`);assert.equal(sentence,'Answer with only one JSON object that matches this JSON Schema, with no text before or after it. Text fields are plain text, without Markdown.','format only (C1 review R8 adds the plain-text sentence)');
  const shape=JSON.parse(json);assert.deepEqual(Object.keys(shape.properties),Object.keys(C.decisionSchema(false,false).properties),'the app\'s own schema');
  assert.equal(shape.properties.explanation.maxLength,1500);assert.deepEqual([shape.properties.quantity.minimum,shape.properties.quantity.maximum],[0,1000]);assert.equal(shape.properties.loanDate.maxLength,10);
  assert.deepEqual([shape.properties.plan.properties.horizonDays.minimum,shape.properties.plan.properties.horizonDays.maximum],[1,3650]);assert.equal(shape.properties.strategyCheck.maxItems,8);
  for(const r of [r1,r2]){assert.deepEqual(r.output_config,{effort:'medium'});assert.deepEqual(r.thinking,{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}});assert.equal(r.service_tier,'standard_only');}
  assert.deepEqual(r1.tool_choice,{type:'auto'});assert.deepEqual(r2.tool_choice,{type:'none'});
  assert.equal(JSON.stringify(C.decisionSchema(true,true)).includes('maxLength'),false,'the OpenAI schema is untouched');
});

test('G5: a research round that ends in prose is a failed review with its reason; it is not retried',async()=>{
  const e=await new A.AnthropicClient(KEY,transport(reply([text('I need more information before deciding.')]))).decide(CTX,{...OPTS,research:true}).then(()=>null,x=>x);
  assert.equal(e.message,'INVALID_AI_RESPONSE');assert.match(e.detail.rule,/not valid JSON/);
  const {Automation}=require('../electron/automation.cjs');const {DatabaseSync}=require('node:sqlite');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');let n=0;const a=new Automation(db,new PaperEngine(db,[],()=>[]),{request:async()=>{n++;throw e;}},()=>{});
  await assert.rejects(a.decisionWithRetry(CTX,OPTS,0),/INVALID_AI_RESPONSE/);assert.equal(n,1,'one attempt');
});

test('G6: the scout without a grammar: the same parse; validatePlan fails closed; unknown keys are not in the stored plan',async()=>{
  const plan={summary:'Hold cash.',cashTargetPct:50,focus:'f',targets:[{symbol:'005930',name:'Samsung',role:'candidate',targetWeightPct:10,thesis:'t',risks:'r',EXTRA_T:1}],briefAnswers:[],retrospective:'',substitutions:[],EXTRA_PLAN:1};
  const t=transport(reply([text(JSON.stringify(plan))]));const r=await new A.AnthropicClient(KEY,t).scout({brief:'x'},OPTS);
  const body=t.sent[0];assert.deepEqual(body.output_config,{effort:'medium'});assert.equal(body.system[1].text,A.shapeText(scout.SCHEMA));assert.deepEqual(body.system[1].cache_control,{type:'ephemeral'});assert.deepEqual(body.tool_choice,{type:'auto'});
  assert.ok(!JSON.stringify(r.plan).includes('EXTRA_'),'unknown keys dropped');assert.equal(r.plan.targets[0].symbol,'005930');
  for(const bad of [`Plan: ${JSON.stringify(plan)}`,'{}',JSON.stringify({...plan,targets:'none'}),JSON.stringify({...plan,summary:5})])
    await assert.rejects(new A.AnthropicClient(KEY,transport(reply([text(bad)]))).scout({brief:'x'},OPTS),e=>e.message==='INVALID_AI_RESPONSE',bad.slice(0,30));
});

test('G7: the narrative, compacting and reflection requests keep output_config.format; Claude decision and scout keep effort, thinking, service tier and the beta',async()=>{
  for(const [m,run,cap] of [['narrative',c=>c.narrative({headlines:[]},OPTS),8000],['compact',c=>c.compact({items:[]},OPTS),16000],['reflect',c=>c.reflect({evidence:{}},OPTS),8000]]){
    const t=transport(reply([text('{}')]));await run(new A.AnthropicClient(KEY,t)).catch(()=>{});const b=t.sent[0];
    assert.equal(b.output_config.format.type,'json_schema',m);assert.equal(b.max_tokens,cap,m);assert.equal(b.system.length,1,m+': one system block as before');}
});
