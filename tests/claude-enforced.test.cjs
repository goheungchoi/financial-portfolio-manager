'use strict';
// The enforced Claude decision form (artifacts/reviews/2026-11-13-enforced-form: design.md, review.md E1 to E10, verified on
// the real API in verify/report.md). No network: every transport is a fake.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');
require('./fixtures/order-book.cjs');
const A=require('../electron/anthropic-client.cjs');const C=require('../electron/ai-client.cjs');const ER=require('../electron/provider-error-reply.cjs');
const KEY='sk-ant-fixture-enforced-key-0000';const OPTS={openaiModel:'claude-opus-5-5',reasoningEffort:'medium'};
const LIMIT=54;const DIR=path.join(__dirname,'../artifacts/reviews/2026-11-13-enforced-form');
const reply=(content,stop='end_turn')=>({id:'msg',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'sig'},...content],stop_reason:stop,stop_details:null,usage:{input_tokens:1000,output_tokens:200,service_tier:'standard'},input_transformations:[]});
const text=t=>({type:'text',text:t});
const GRAMMAR={status:400,body:{type:'error',error:{type:'invalid_request_error',message:'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.'},request_id:'req_fixture_grammar'}};
// Replies in turn; a reply {status,body} answers with that status. Records every request.
const transport=(...replies)=>{const sent=[];const fn=async(url,init)=>{const b=JSON.parse(init.body);sent.push(b);const r=replies.length>1?replies.shift():replies[0];const out=typeof r==='function'?r(b):r;
  return new Response(JSON.stringify(out.status?out.body:out),{status:out.status??200,headers:{'content-type':'application/json','request-id':'req_fixture_1'}});};fn.sent=sent;return fn;};
// A complete flat answer: every field present, the markers where nothing is meant.
const FLAT=Object.freeze({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'No trade.',plan_horizon:'none',plan_thesis:'',plan_invalidation:'',plan_stopPrice:0,plan_targetPrice:0,plan_horizonDays:0,plan_confidence:'low',
  plan_portfolioImpact_weightBeforePct:0,plan_portfolioImpact_weightAfterPct:0,plan_portfolioImpact_related:[],plan_portfolioImpact_relatedBeforePct:0,plan_portfolioImpact_relatedAfterPct:0,plan_portfolioImpact_equityReliable:true,plan_portfolioImpact_why:'',
  plan_evidence:[],plan_valuation_method:'',plan_valuation_inputs:'',plan_valuation_justification:'',plan_uncertainty_acceptableAtThisSize:'',plan_uncertainty_beforeAddingMore:'',complexity_score:20,complexity_reason:'quiet',strategyCheck:'',
  execution_bound:0,execution_cancelAfter:'',execution_cancelIf:[],reversal_priorDecisionId:'',reversal_basis:'none',reversal_whatChanged:'',reversal_priorRequirement:'',reversal_newEvidence:[],reversal_afterCost:'',scoutBrief:'',planVerdicts:''});
const plain=f=>{const {scoutBrief,planVerdicts,...rest}=f;return rest;};
// An opening the app accepts: a Buy with a complete plan and sourced, verified evidence.
const BUY={...FLAT,action:'Buy',symbol:'005930',quantity:1,explanation:'Buy one share.',plan_horizon:'swing',plan_thesis:'Memory prices recover',plan_invalidation:'A close below 90',plan_stopPrice:90,plan_targetPrice:0,plan_horizonDays:60,plan_confidence:'medium',
  plan_portfolioImpact_weightAfterPct:2,plan_portfolioImpact_why:'A small new position',plan_evidence:[{claim:'Q3 operating profit rose',source:'Q3 earnings release, 2026-10-30',verified:true}],plan_uncertainty_acceptableAtThisSize:'Small size',plan_uncertainty_beforeAddingMore:'The Q4 guidance'};
const CTX={universe:[{symbol:'005930'}],quotes:[{symbol:'005930',price:100}]};
const decide=async(answer,{ctx=CTX,opts=OPTS}={})=>new A.AnthropicClient(KEY,transport(reply([text(JSON.stringify(answer))]))).decide(ctx,opts);

test('E4: every Claude schema the app can send counts at most 54; the decision covers every leaf of decisionSchema; the flat form has no union, null or nested object',()=>{
  const all=[['decision brief+targets',A.flatDecisionSchema(true,true)],['decision brief',A.flatDecisionSchema(true,false)],['decision targets',A.flatDecisionSchema(false,true)],['decision plain',A.flatDecisionSchema(false,false)],
    ['scout',A.toAnthropicSchema(require('../electron/scout.cjs').SCHEMA)],['narrative',A.toAnthropicSchema(require('../electron/narrative.cjs').SCHEMA)],['compacting',A.toAnthropicSchema(require('../electron/context-fit.cjs').COMPACT_SCHEMA)],['reflection',A.toAnthropicSchema(require('../electron/reflection.cjs').SCHEMA)]];
  for(const [name,s] of all)assert.ok(A.grammarCount(s)<=LIMIT,`${name}: ${A.grammarCount(s)} over ${LIMIT}`);
  assert.deepEqual(all.slice(0,4).map(([,s])=>A.grammarCount(s)),[53,52,52,51]);
  // Every leaf of the nested schema has a flat key or sits inside a JSON-text part.
  for(const [b,t] of [[true,true],[false,false]]){const nested=C.decisionSchema(b,t),flat=A.flatDecisionSchema(b,t).properties;const leaves=[];
    const obj=n=>n?.anyOf?.find(x=>x?.type==='object')??(n?.type==='object'?n:null);
    const walk=(node,prefix)=>{for(const [k,v] of Object.entries(node.properties)){const key=prefix?`${prefix}_${k}`:k;if(!prefix&&A.TEXT_PARTS.includes(k))continue;const o=obj(v);if(o&&v.type!=='array')walk(o,key);else leaves.push(key);}};walk(nested,'');
    for(const l of leaves)assert.ok(l in flat,`${l} has a place`);for(const k of A.TEXT_PARTS)if(k in nested.properties)assert.deepEqual(flat[k],{type:'string'},k);}
  const s=JSON.stringify(A.flatDecisionSchema(true,true));assert.ok(!s.includes('anyOf')&&!s.includes('"null"'));
  for(const v of Object.values(A.flatDecisionSchema(true,true).properties))assert.ok(v.type!=='object','no nested object');
  // The schema the app sends is the one verified on the real API; the format text is the verified one plus the E9 sentence.
  assert.equal(JSON.stringify(A.flatDecisionSchema(true,true)),JSON.stringify(JSON.parse(fs.readFileSync(path.join(DIR,'claude-decision-brief-targets.json'),'utf8')).schema));
  const verified=fs.readFileSync(path.join(DIR,'claude-decision-format-text.txt'),'utf8').split('\n');const lines=A.FORMAT_TEXT.split('\n');
  assert.deepEqual(lines.filter(l=>!verified.includes(l)),['Where the instructions say null, write the marker named here.']);assert.equal(lines.length,verified.length+1);
});

test('E2: on an accepted Buy, the execution bound cases; a 0 never appears as a stop, target, horizon or bound',async()=>{
  const r=await decide(plain(BUY));assert.equal(r.decision.action,'Buy');assert.equal(r.decision.withheld,undefined);assert.equal(r.answerForm,'enforced');
  assert.deepEqual([r.decision.plan.stopPrice,r.decision.plan.targetPrice,r.decision.plan.horizonDays],[90,null,60],'target 0 is none');
  const target=await decide({...plain(BUY),plan_targetPrice:120,plan_valuation_method:'P/E',plan_valuation_inputs:'EPS 8 (Q3 release) x 15',plan_valuation_justification:'Its 5-year median'});assert.equal(target.decision.action,'Buy');assert.equal(target.decision.plan.targetPrice,120);assert.equal(target.decision.plan.valuation.method,'P/E');assert.equal(r.decision.execution,undefined,'no execution instruction');
  const bound=await decide({...plain(BUY),execution_bound:95});assert.equal(bound.decision.execution.bound,95);
  const cancel=await decide({...plain(BUY),execution_cancelAfter:'2026-11-13T15:30:00+09:00'});assert.deepEqual([cancel.decision.execution.bound,cancel.decision.execution.cancelAfter],[null,'2026-11-13T15:30:00+09:00']);assert.equal(cancel.decision.execution.invalid,undefined);
  const negative=await decide({...plain(BUY),execution_bound:-5});assert.ok(negative.decision.execution.invalid.some(x=>/^bound/.test(x)),'a negative bound is kept as invalid: the app withholds the order');
  const zeros=await decide({...plain(BUY),plan_horizonDays:0});assert.equal(zeros.decision.plan.horizonDays??null,null);
  const noStop=await decide({...plain(BUY),plan_stopPrice:0});assert.equal(noStop.decision.action,'Hold');assert.match(noStop.decision.withheld.reason,/no stop price/);
  // Anywhere downstream in the stored decision: no stop, target, horizon or bound of 0.
  for(const d of [r,target,bound,cancel,zeros,noStop].map(x=>x.decision)){const s=JSON.stringify(d);for(const k of ['stopPrice','targetPrice','horizonDays','bound'])assert.ok(!new RegExp(`"${k}":0[,}]`).test(s),`${k} 0 in ${s.slice(0,80)}`);}
  const markers=await decide({...plain(FLAT),action:'Buy',symbol:'005930',quantity:1,explanation:'Buy.'});assert.equal(markers.decision.action,'Hold','a plan of markers on a Buy is an incomplete plan');assert.ok(markers.continuation,'the plan-correction round gets the conversation');
});

test('E1: a non-empty JSON-text part that is not accepted is dropped, named (no content) on the result, the call record and the console line',async()=>{
  const ctx={...CTX,scoutBrief:{},scoutPlan:{targets:[{symbol:'005930'}]}};
  const r=await decide({...FLAT,strategyCheck:'not json at all',planVerdicts:'{"an":"object, not a list"}',scoutBrief:'[]'},{ctx});
  assert.deepEqual(r.textPartsDropped,['strategyCheck','scoutBrief','planVerdicts']);assert.equal(r.decision.action,'Hold','the decision stands');
  const ok=await decide({...FLAT,strategyCheck:JSON.stringify([{horizon:'swing',instrument:'unleveraged',direction:'long',funding:'cash',idea:'none',verdict:'none-found',reason:'r'}])},{ctx});assert.equal(ok.textPartsDropped,undefined);assert.equal(ok.decision.strategyCheck.length,1);
  const empty=await decide(FLAT,{ctx});assert.equal(empty.textPartsDropped,undefined,'an empty string is none, not dropped');
  // The engine: the call record and the console line name the parts, never their text.
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const a=new Automation(db,new PaperEngine(db,[],()=>[]),{request:async()=>r},(id,kind,title,body)=>events.push({title,body}));
  await a.decisionWithRetry(ctx,OPTS,0);const line=events.find(e=>e.title==='Claude answer: text part not accepted');assert.ok(line);assert.match(line.body,/^strategyCheck, scoutBrief, planVerdicts were not valid JSON/);assert.ok(!line.body.includes('not json at all'));
  db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run('c1','2026-11-13',JSON.stringify({reviewId:'r',model:'claude-opus-5-5',reservedMicro:1000,status:'pending'}));
  require('../electron/ai-accounting.cjs').settle(db,'ai_usage','2026-11-13','c1',r,'completed');assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM ai_calls WHERE id='c1'").get().payload).textPartsDropped,['strategyCheck','scoutBrief','planVerdicts']);
});

test('E3: a grammar refusal sends the request once more in the text form inside the same call, remembered for the KST day; other 400s are not resent',async()=>{
  let now=Date.parse('2026-11-13T10:00:00+09:00');const clock=()=>now;
  const t=transport(GRAMMAR,reply([text(JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Text form.'}))]));const c=new A.AnthropicClient(KEY,t,{clock});
  const r=await c.decide(CTX,OPTS);assert.equal(r.formFallback,true);assert.equal(r.answerForm,'text');assert.equal(r.decision.explanation,'Text form.');
  assert.ok(t.sent[0].output_config.format,'first the enforced form');assert.equal(t.sent[1].output_config.format,undefined,'then the 1.5.56 text form');assert.match(t.sent[1].system[1].text,/^Answer with only one JSON object/);
  // Later the same KST day: straight to the text form, no enforced request.
  now=Date.parse('2026-11-13T23:59:00+09:00');await c.decide(CTX,OPTS);assert.equal(t.sent.length,3);assert.equal(t.sent[2].output_config.format,undefined);assert.equal(c.textFormToday('decide'),true);
  // After midnight KST: the enforced form is tried again.
  now=Date.parse('2026-11-14T00:01:00+09:00');assert.equal(c.textFormToday('decide'),false);await c.decide(CTX,OPTS).catch(()=>{});assert.ok(t.sent[3].output_config.format,'a new day tries the enforced form');
  // Another 400 is not resent.
  const other=transport({status:400,body:{type:'error',error:{type:'invalid_request_error',message:'something else'}}});await assert.rejects(new A.AnthropicClient(KEY,other).decide(CTX,OPTS),/AI_BAD_REQUEST/);assert.equal(other.sent.length,1);
  // A failed resend still says it fell back.
  const failing=transport(GRAMMAR,{status:500,body:{type:'error',error:{type:'api_error',message:'x'}}});const e=await new A.AnthropicClient(KEY,failing).decide(CTX,OPTS).then(()=>null,x=>x);assert.equal(e.formFallback,true);
  assert.equal(ER.errorReply('decision',e).formFallback,true,'the worker reply carries it');
});

test('E3: through the engine, one call record: formFallback marked, the refusal at $0 (only the resend settled), one console line',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const t=transport(GRAMMAR,reply([text(JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Text.'}))]));const client=new A.AnthropicClient(KEY,t);
  const a=new Automation(db,new PaperEngine(db,[],()=>[]),{request:async(op,p)=>client.decide(p.context,p.options)},(id,kind,title,body)=>events.push({title,body}));
  db.prepare('INSERT INTO ai_calls VALUES(?,?,?)').run('c1','2026-11-13',JSON.stringify({reviewId:'r',model:'claude-opus-5-5',reservedMicro:1168517,status:'pending'}));
  const r=await a.decisionWithRetry(CTX,OPTS,0);require('../electron/ai-accounting.cjs').settle(db,'ai_usage','2026-11-13','c1',r,'completed');
  const rec=JSON.parse(db.prepare("SELECT payload FROM ai_calls WHERE id='c1'").get().payload);assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_calls').get().n,1,'one call record');
  assert.deepEqual([rec.status,rec.formFallback,rec.answerForm],['completed',true,'text']);assert.ok(rec.accountedMicro<rec.reservedMicro&&rec.accountedMicro>0,'settled on the resend\'s usage; the refusal adds nothing');
  assert.equal(events.filter(e=>e.title==='Claude refused the enforced form; sent as text').length,1);
});

test('E7, E8: a Hold or Sell with plan text and a Hold with a symbol come out exactly as the nested form gives them',()=>{
  const schema=A.flatDecisionSchema(false,false);const v=d=>C.validateDecision(d,['005930','000270'],{requirePlan:true,quotes:CTX.quotes,context:CTX});
  for(const f of [{...plain(FLAT),plan_thesis:'Waiting for the earnings call',plan_invalidation:'A guidance cut'},{...plain(FLAT),action:'Hold',symbol:'005930',explanation:'Hold Samsung.'},{...plain(FLAT),action:'Sell',symbol:'005930',quantity:3,explanation:'Trim.',plan_thesis:'Take profit',plan_invalidation:'n/a'}]){
    const nested={action:f.action,symbol:f.symbol,quantity:f.quantity,credit:'none',loanDate:'',explanation:f.explanation,plan:{horizon:'none',thesis:f.plan_thesis,invalidation:f.plan_invalidation,stopPrice:null,targetPrice:null,horizonDays:null,confidence:'low',portfolioImpact:null,evidence:[],valuation:null,uncertainty:null},complexity:{score:20,reason:'quiet'},strategyCheck:[],execution:null,reversal:null};
    assert.deepEqual(v(A.rebuildDecision(f,schema).decision),v(nested),`${f.action} ${f.symbol}`);}
  assert.equal(v(A.rebuildDecision({...plain(FLAT),symbol:'005930'},schema).decision).symbol,'005930','a Hold keeps its symbol, as today (checkDecision checks a symbol only on a Buy or Sell)');
});

test('E10: a scoutBrief of request none reads as no brief',()=>{
  const schema=A.flatDecisionSchema(true,false);const d=A.rebuildDecision({...plain(FLAT),scoutBrief:JSON.stringify({request:'none',feedback:[]})},schema).decision;
  assert.deepEqual(d.scoutBrief,{request:'none',feedback:[]});const v=C.validateDecision(d,['005930'],{requirePlan:true,quotes:CTX.quotes,context:CTX});assert.equal(v.scoutBrief,undefined,'no brief');
});

test('the scout: enforced with its own schema (count 28), the same fallback; narrative, compacting and reflection unchanged',async()=>{
  const scout=require('../electron/scout.cjs');const plan={summary:'Hold cash.',cashTargetPct:50,focus:'f',targets:[],briefAnswers:[],retrospective:'',substitutions:[]};
  const t=transport(reply([text(JSON.stringify(plan))]));const r=await new A.AnthropicClient(KEY,t).scout({brief:'x'},OPTS);assert.deepEqual(r.plan.targets,[]);
  assert.deepEqual(t.sent[0].output_config,{effort:'medium',format:{type:'json_schema',schema:A.toAnthropicSchema(scout.SCHEMA)}});assert.equal(t.sent[0].system.length,1);
  const f=transport(GRAMMAR,reply([text(JSON.stringify(plan))]));const fr=await new A.AnthropicClient(KEY,f).scout({brief:'x'},OPTS);assert.equal(fr.formFallback,true);assert.equal(f.sent[1].output_config.format,undefined);assert.equal(f.sent[1].system[1].text,A.shapeText(scout.SCHEMA));
});
