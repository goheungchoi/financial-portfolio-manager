const test=require('node:test');const assert=require('node:assert/strict');
const {fit,size,LIMIT}=require('../electron/context-fit.cjs');const {researchReview}=require('../electron/research-review.cjs');const {bound}=require('../electron/review-context.cjs');
const research=n=>({overview:{price:216000,per:33.1,note:'x'.repeat(900)},closes:Array.from({length:n},(_,i)=>({date:`2026-08-${String(i%28+1).padStart(2,'0')}`,close:200000+i*37.123456})),analysts:{latest:Array.from({length:30},(_,i)=>({firm:'Firm '+i,target:300000+i,opinion:'Buy'}))}});
test('a tool response is bounded by whole parts: what fits is kept as it is, the rest is named for a narrower request',()=>{
  const b=bound(research(900));assert.equal(b.overview.price,216000);assert.equal(b.analysts.latest.length,30,'no rows dropped inside a kept part');assert.deepEqual(b.omittedParts,['closes']);assert.ok(size(b)<=16000);
  const small={overview:{price:1}};assert.equal(bound(small),small,'a response that fits is unchanged');
  assert.equal(bound('y'.repeat(20000)).status,'too_large');
});
const item=(id,value,args='{"symbol":"005930"}')=>[{type:'function_call',call_id:id,name:'get_company_research',arguments:args},{type:'function_call_output',call_id:id,output:JSON.stringify(value)}];
const part=n=>({overview:{price:216000,per:33.1},filler:'x'.repeat(n)});
test('small continuations are untouched; when large, older results become references to the request and the latest round stays in full',async()=>{
  const small=[{role:'user',content:'ctx'},...item('a',{x:1})];assert.equal((await fit(small)).items,small);
  const items=[{role:'user',content:'c'.repeat(90000)},...item('a',part(15000)),...item('b',part(15000)),...item('c',part(15000),'{"symbol":"000270"}')];const keepFrom=items.length-2;
  assert.ok(size(items)>LIMIT*0.9);const r=await fit(items,{keepFrom});assert.ok(size(r.items)<=LIMIT*0.9);
  assert.equal(r.items.at(-1).output,items.at(-1).output,'the latest result is unchanged');
  const ref=JSON.parse(r.items[2].output);assert.equal(ref.reference,true);assert.deepEqual(ref.request,{name:'get_company_research',args:'{"symbol":"005930"}'},'the agent can ask again');
});
test('the cheap model condenses older results first (figures kept, request named); if it fails, references are used',async()=>{
  const items=[{role:'user',content:'c'.repeat(100000)},...item('a',part(15000)),...item('b',part(15000))];const keepFrom=items.length-2;let asked=null;
  const r=await fit(items,{keepFrom,compact:async p=>{asked=p;return {summaries:p.results.map(x=>({callId:x.callId,summary:'PER 33.1, price 216000'}))};}});
  assert.deepEqual(asked.results.map(x=>x.callId),['a']);const c=JSON.parse(r.items[2].output);assert.equal(c.compacted,true);assert.match(c.summary,/PER 33.1/);assert.equal(c.request.name,'get_company_research');
  const failed=await fit(items,{keepFrom,compact:async()=>{throw new Error('AI_TIMEOUT');}});assert.equal(failed.steps[0].error,'AI_TIMEOUT');assert.equal(JSON.parse(failed.items[2].output).reference,true);
});
test('several research rounds of large lookups: every follow-up fits and the review reaches its decision',async()=>{
  const sent=[];let round=0;const logs=[];const context={universe:[{symbol:'005930'},{symbol:'000270'}],discovery:{enabled:true}};
  const request=async({continuation})=>{if(continuation)sent.push(size(continuation));round++;const base=continuation??[{role:'user',content:'c'.repeat(60000)}];
    if(round<4)return {toolCalls:[0,1,2,3].map(k=>({name:'get_company_research',callId:`r${round}-${k}`,args:{symbol:k%2?'000270':'005930',sections:['s'+k]}})),continuation:[...base,...[0,1,2,3].map(k=>({type:'function_call',call_id:`r${round}-${k}`,name:'get_company_research',arguments:JSON.stringify({symbol:k%2?'000270':'005930',sections:['s'+k]})}))],usage:{}};
    return {decision:{action:'Hold'},usage:{}};};
  const result=await researchReview({context,evidence:{get:async()=>({})},request,log:(k,t)=>logs.push(t),discovery:{get_company_research:async a=>({overview:{price:216000,per:33.1},notes:'n'.repeat(14000),closes:research(900).closes,asked:a})}});
  assert.equal(result.decision.action,'Hold');assert.equal(sent.length,3);assert.ok(sent.every(n=>n<=LIMIT),'every follow-up fits: '+sent.join(','));assert.ok(logs.includes('Research context condensed'));
});
test('a large evidence response in a review is bounded, named and the review completes',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(':memory:');let round=0;let output=null;
  const provider={request:async(op,{context,options})=>{if(op!=='decision')throw new Error('UNEXPECTED');round++;if(options.continuation)output=JSON.parse(options.continuation.at(-1).output);
    if(round===1)return {toolCalls:[{name:'get_market_evidence',callId:'e1',args:{symbol:'005930',dataset:'company'}}],continuation:[{role:'user',content:JSON.stringify(context)},{type:'function_call',call_id:'e1',name:'get_market_evidence',arguments:'{}'}],usage:{inputTokens:1,outputTokens:1},provider:'openai'};
    return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,()=>{});a.providerStatus.aiConnected=true;
  a.evidence={get:async()=>({status:'available',summary:{price:100},history:'x'.repeat(90000)})};a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low',unlimitedBudget:true,unlimitedCalls:true});
  const review=await a.review('User request');assert.equal(review.decision.action,'Hold');assert.deepEqual(output.omittedParts,['history']);assert.equal(output.summary.price,100);
});
