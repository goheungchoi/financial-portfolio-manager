// M-4 part 1 (multi-order, artifacts/reviews/2026-11-16-multi-order/m4-plan.md, cleared): the decision's format with
// further orders. OpenAI: moreOrders, a strict list of at most n-1 orders in the first order's shape. Claude: moreOrders as
// JSON text in one string (a text part that reaches orders; D2), each form within the size guard of 54, the format text
// gaining one sentence. A form over the guard is never sent: the request goes as text. The ceiling per model is the
// formula of D1. At one order per review nothing changes (tests/single-order-pins.test.cjs).
const test=require('node:test');const assert=require('node:assert/strict');
const C=require('../electron/ai-client.cjs'),A=require('../electron/anthropic-client.cjs'),M=require('../electron/ai-models.cjs');
const variants=[[true,true,true],[true,false,true],[false,true,true],[false,false,true],[true,true,false],[true,false,false],[false,true,false],[false,false,false]];
test('OpenAI: above one order, moreOrders is a strict list of at most n-1 orders, each a Buy or a Sell in the first order\'s shape',()=>{
  const s=C.decisionSchema(true,true,true,2),m=s.properties.moreOrders;assert.ok(s.required.includes('moreOrders'));assert.equal(m.type,'array');assert.equal(m.maxItems,2);
  assert.deepEqual(m.items.required,['action','symbol','quantity','credit','loanDate','plan','execution','reversal']);assert.equal(m.items.additionalProperties,false);
  assert.deepEqual(m.items.properties.action.enum,['Buy','Sell']);for(const k of ['symbol','quantity','credit','loanDate','plan','execution','reversal'])assert.deepEqual(m.items.properties[k],s.properties[k],k);
  assert.ok(!('moreOrders' in C.decisionSchema(true,true,true).properties),'none at one order');assert.equal(C.furtherOrders({moreOrders:2}),2);assert.equal(C.furtherOrders({}),0);assert.equal(C.furtherOrders({moreOrders:-1}),0);
});
test('OpenAI: the request carries the list only when further orders are asked for',async()=>{
  const bodies=[];const client=new C.AiClient('sk-fixture-key-123',async(url,o)=>{bodies.push(JSON.parse(o.body));return new Response(JSON.stringify({status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'ok',moreOrders:[]})}]}]}));});
  await client.decide({universe:[]},{moreOrders:2}).catch(()=>{});await client.decide({universe:[]}).catch(()=>{});
  assert.equal(bodies[0].text.format.schema.properties.moreOrders.maxItems,2);assert.ok(!('moreOrders' in bodies[1].text.format.schema.properties));
});
test('Claude: moreOrders is one text field; every form with it counts at most 54 (the largest exactly 54), one more than without',()=>{
  const counts=variants.map(([b,t,tr])=>[A.grammarCount(A.flatDecisionSchema(b,t,tr)),A.grammarCount(A.flatDecisionSchema(b,t,tr,5))]);
  for(const [one,more] of counts){assert.equal(more,one+1);assert.ok(more<=A.GRAMMAR_LIMIT);}assert.equal(Math.max(...counts.map(c=>c[1])),54);
  assert.deepEqual(A.flatDecisionSchema(true,true,true,5).properties.moreOrders,{type:'string'});assert.equal(A.GRAMMAR_LIMIT,54);
});
test('Claude: the format text gains one sentence for moreOrders (with its count and schema); without further orders it is today\'s',()=>{
  assert.equal(A.formatText(0),A.FORMAT_TEXT);const t=A.formatText(4);assert.ok(t.startsWith(A.FORMAT_TEXT+'\n'));assert.match(t.split('\n').pop(),/^moreOrders is JSON written as text in that string: a list of at most 4 further orders/);
});
test('Claude: the rebuild reads the list as written; a text that is not a JSON list is kept as unparsed (every further order held back, D2); empty is none',()=>{
  const schema=A.flatDecisionSchema(false,false,false,3),base=Object.fromEntries(Object.keys(schema.properties).map(k=>[k,schema.properties[k].type==='number'||schema.properties[k].type==='integer'?0:schema.properties[k].type==='boolean'?true:schema.properties[k].type==='array'?[]:'']));
  const flat=x=>({...base,action:'Hold',credit:'none',plan_horizon:'none',plan_confidence:'low',reversal_basis:'none',moreOrders:x});
  assert.deepEqual(A.rebuildDecision(flat('[{"action":"Buy","symbol":"000660"}]'),schema).decision.moreOrders,[{action:'Buy',symbol:'000660'}]);
  {const r=A.rebuildDecision(flat('[{"action":"Buy",'),schema);assert.deepEqual(r.decision.moreOrders,{unparsed:true});assert.ok(r.dropped.includes('moreOrders'));}
  assert.deepEqual(A.rebuildDecision(flat('{"action":"Buy"}'),schema).decision.moreOrders,{unparsed:true},'an object, not a list');
  assert.deepEqual(A.rebuildDecision(flat(''),schema).decision.moreOrders,[]);
});
test('the size guard: a form over 54 is not sent; the request goes once as text, marked, and not remembered for the day',async()=>{
  const c=new A.AnthropicClient('sk-ant-fixture-enforced-key-0000',async()=>{throw new Error('no network');});const forms=[];
  const r=await c.withFallback('decide',async form=>{forms.push(form);return {decision:{action:'Hold'}};},{tooLarge:true});
  assert.deepEqual(forms,['text']);assert.equal(r.formTooLarge,true);assert.equal(r.formFallback,true);assert.equal(c.textFormToday('decide'),false,'the next request may be within the guard');
});
test('the ceiling (D1): 1 + the further orders that fit the output cap after the longest stored answer and a 20% reserve, at 1,000 tokens each',()=>{
  const at=(model,effort)=>M.orderCeiling({openaiModel:model,reasoningEffort:effort});
  assert.equal(at('claude-opus-5-5','high'),22,'1 + floor((32,000 - 4,353 - 6,400) / 1,000)');
  assert.equal(at('gpt-6-sol','medium'),1,'its longest answer (7,380) leaves no room in 8,192 with the reserve');assert.equal(at('gpt-6-sol','none'),1);
  assert.equal(at('gpt-6-luna','low'),1,'no stored trade answer');assert.equal(at('claude-haiku-5-5','low'),1);
  // The planner's check: a review at the ceiling with the longest order seen (2,931 bytes, about 3 bytes a token) fits with the reserve.
  {const n=at('claude-opus-5-5','high'),cap=M.outputCap({openaiModel:'claude-opus-5-5',reasoningEffort:'high'});
    assert.ok(M.WORST_ANSWER['claude-opus-5-5']+(n-1)*Math.ceil(2931/3)<=cap*(1-M.ANSWER_RESERVE),`${n} orders fit`);}
  // GPT-6 Sol's longest stored answer is already inside the reserve (7,380 of 8,192): one order per review, as today.
  assert.ok(M.WORST_ANSWER['gpt-6-sol']>8192*(1-M.ANSWER_RESERVE));
  assert.ok(M.FURTHER_ORDER_TOKENS>=Math.ceil(2931/3),'the per-order allowance covers the longest order seen');
});
test('the answer-form notes: a form over the limit has its own line; a further-order list not accepted is named',()=>{
  const {Automation}=require('../electron/automation.cjs');const lines=[];const a=Object.create(Automation.prototype);a.log=(...x)=>lines.push(x);
  a.noteAnswerForm({formFallback:true,formTooLarge:true});a.noteAnswerForm({textPartsDropped:['moreOrders']});
  assert.equal(lines[0][2],'Claude form over the size limit; sent as text');assert.match(lines[1][3],/moreOrders was not valid JSON/);
});
