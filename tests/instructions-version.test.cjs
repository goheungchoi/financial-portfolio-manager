// The review-instruction evaluation version (audit 2026-11-04, Stage 4): instructions, decision schema and review tools
// are pinned to a named version, so evidence gathered under one version is never counted for another.
const test=require('node:test');const assert=require('node:assert/strict');const A=require('../electron/ai-client.cjs');
// Every version ever used, with its fingerprint. A change to the instructions, the decision schema or a review tool
// fails this test until INSTRUCTIONS_VERSION is given a new name and that name is added here. Never change a pinned entry.
const PINNED={'review 2026-11-05':'5deb5c593c334259','review 2026-11-05.2':'ab0460495a0c45e1','review 2026-11-05.3':'115589f950e8d871','review 2026-11-05.4':'c85e09768ea1322a'};
test('the instructions, decision schema and review tools match the fingerprint pinned to their version',()=>{
  const {version,fingerprint}=A.instructions();
  assert.ok(PINNED[version],`INSTRUCTIONS_VERSION '${version}' is not pinned: add it to PINNED with fingerprint ${fingerprint}`);
  assert.equal(fingerprint,PINNED[version],`The review instructions, decision schema or review tools changed under '${version}': give INSTRUCTIONS_VERSION a new name in electron/ai-client.cjs and pin ${fingerprint} to it`);
  assert.equal(new Set(Object.values(PINNED)).size,Object.keys(PINNED).length,'two versions share one fingerprint');
});
test('the version is saved on each model review and is part of every evaluation binding',()=>{
  assert.equal(require('../electron/routing-sim.cjs').binding({scope:'both'}).instructions,A.INSTRUCTIONS_VERSION);
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');
  assert.match(src,/provider==='openai'\?\{instructions:require\('\.\/ai-client\.cjs'\)\.instructions\(\)\}/);
});
test('the review request uses the pinned instructions and tools',async()=>{let sent=null;
  const client=new A.AiClient('k'.repeat(20),async(url,init)=>{sent=JSON.parse(init.body);return {ok:false,status:400,text:async()=>'{}',json:async()=>({}),headers:new Map()};});
  const context={environment:'kis',universe:[{symbol:'005930'}],positions:{},agentDesk:{conditionalOrders:{allowed:true}}};
  try{await client.decide(context,{research:true});}catch{}
  assert.equal(sent.instructions,A.REVIEW_INSTRUCTIONS);assert.deepEqual(sent.tools.map(t=>t.name),A.reviewTools(context).map(t=>t.name));
});
