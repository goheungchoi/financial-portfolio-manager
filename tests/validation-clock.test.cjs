// The provider-test failure of 2026-11-25 22:30 KST (artifacts/reviews/2026-11-25-validation-clock): the provider test
// validates a recorded answer at its fixture's cutoff (validation.now); a live review and a dry run never carry a time,
// and anything but a finite number is ignored, so they always validate on the real clock. Fake transports only.
const test=require('node:test'),assert=require('node:assert/strict');const {adapt}=require('./fixtures/claude-flat.cjs');
const DAY=86400000;
const plan={horizon:'swing',thesis:'recovery',invalidation:'falls below 90',stopPrice:90,targetPrice:null,horizonDays:60,confidence:'medium',portfolioImpact:{weightBeforePct:0,weightAfterPct:5,related:[],relatedBeforePct:0,relatedAfterPct:5,equityReliable:true,why:'small'},evidence:[{claim:'orders rose',source:'release',verified:true}],valuation:null,uncertainty:null};
const answer={action:'Buy',symbol:'990020',quantity:1,credit:'none',loanDate:'',explanation:'Buy again.',reversal:null,plan,complexity:{score:10,reason:'r'},strategyCheck:[],execution:null};
const context={universe:[{symbol:'990020'}],quotes:[{symbol:'990020',price:100}]};
// A sale filled two days ago (real clock): reopening it within 30 days needs a reversal explanation.
const memory=()=>[{symbol:'990020',holding:0,lastMaterial:'exit',lastExit:{effect:'CLOSE_LONG',filledAt:new Date(Date.now()-2*DAY).toISOString(),decisionId:'rev-A',rationale:'r'}}];

test('a live review and a dry run validate on the real clock: validationOf carries only the memory and the quotes',()=>{
  const {validationOf}=require('../electron/automation.cjs');
  const v=validationOf({positionMemory:[{symbol:'990020'}],quotes:[{symbol:'990020',price:1}],now:123,validation:{now:5},cutoff:'2026-01-01'});
  assert.deepEqual(Object.keys(v),['positionMemory','quotes']);assert.ok(!('now' in v));
  assert.deepEqual(Object.keys(validationOf({})),['positionMemory','quotes']);
});

async function claude(now){const {AnthropicClient}=require('../electron/anthropic-client.cjs');
  const t=async(url,init)=>{const body=JSON.parse(init.body);const r={id:'m',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'thinking',thinking:'',signature:'s'},{type:'text',text:JSON.stringify(answer)}],stop_reason:'end_turn',stop_details:null,usage:{input_tokens:10,output_tokens:5},input_transformations:[]};return new Response(JSON.stringify(adapt(r,body)),{status:200,headers:{'content-type':'application/json'}});};
  return (await new AnthropicClient('sk-ant-api03-'+'v'.repeat(40),t).decide(context,{openaiModel:'claude-opus-5-5',reasoningEffort:'medium',validation:{positionMemory:memory(),quotes:context.quotes,...(now===undefined?{}:{now})}})).decision;}
async function openai(now){const {AiClient}=require('../electron/ai-client.cjs');
  const t=async()=>new Response(JSON.stringify({status:'completed',model:'gpt-6-sol',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer)}]}],usage:{input_tokens:10,output_tokens:5}}),{status:200});
  return (await new AiClient('sk-'+'v'.repeat(40),t).decide(context,{openaiModel:'gpt-6-sol',reasoningEffort:'medium',validation:{positionMemory:memory(),quotes:context.quotes,...(now===undefined?{}:{now})}})).decision;}

for(const [name,run] of [['Claude',claude],['OpenAI',openai]])
test(`${name}: a validation time that is not a finite number is ignored (the real clock); a finite one is used`,async()=>{
  for(const bad of [undefined,'2026-11-25',null,NaN,{},Infinity]){const d=await run(bad);assert.equal(d.withheld?.kind,'reversal',`${String(bad)}: the real clock sees the sale two days ago`);}
  const later=await run(Date.now()+40*DAY);assert.equal(later.action,'Buy','at a time 42 days after the sale the reopening needs no explanation');assert.equal(later.withheld,undefined);
});
