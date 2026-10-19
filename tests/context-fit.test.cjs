const test=require('node:test');const assert=require('node:assert/strict');
const {fit,digest,size,LIMIT}=require('../electron/context-fit.cjs');const {researchReview}=require('../electron/research-review.cjs');
const research=n=>({overview:{price:216000,per:33.1,note:'x'.repeat(900)},closes:Array.from({length:n},(_,i)=>({date:`2026-08-${String(i%28+1).padStart(2,'0')}`,close:200000+i*37.123456})),analysts:{latest:Array.from({length:30},(_,i)=>({firm:'Firm '+i,target:300000+i,opinion:'Buy'}))}});
test('digest keeps every key and headline number, shortens long lists and text',()=>{
  const d=digest(research(200));assert.equal(d.overview.price,216000);assert.equal(d.overview.per,33.1);assert.ok(d.overview.note.length<=280);
  assert.equal(d.closes.length,7,'3 + marker + 2 + summary');assert.equal(d.closes[3].omittedRows,195);assert.equal(d.closes.at(-1).rowSummary.close.min,200000);assert.equal(d.analysts.latest[0].target,300000);
  assert.deepEqual(digest([1,2,3]),[1,2,3]);assert.deepEqual(Object.keys(digest(Array.from({length:20},(_,i)=>i))),['count','first','last','min','max']);
});
const item=(id,value)=>[{type:'function_call',call_id:id,name:'get_company_research',arguments:'{}'},{type:'function_call_output',call_id:id,output:JSON.stringify(value)}];
test('small continuations are untouched; large ones digest older results and keep the latest round in full',async()=>{
  const small=[{role:'user',content:'ctx'},...item('a',{x:1})];assert.equal((await fit(small)).items,small);
  const items=[{role:'user',content:'c'.repeat(30000)},...item('a',research(600)),...item('b',research(600)),...item('c',research(600))];const keepFrom=items.length-2;
  assert.ok(size(items)>LIMIT*0.9,"above the 90% fitting point");const r=await fit(items,{keepFrom});assert.equal(r.steps[0].step,'digest');assert.ok(size(r.items)<LIMIT*0.9);
  assert.equal(r.items.at(-1).output,items.at(-1).output,'the latest result is unchanged');assert.match(r.items[2].output,/"digest":true/);
});
test('if digests are not enough the cheap model condenses older results; a failed condensation keeps the digests',async()=>{
  const items=[{role:'user',content:'c'.repeat(124000)},...item('a',research(300)),...item('b',research(300))];const keepFrom=items.length-2;let asked=null;
  const r=await fit(items,{keepFrom,compact:async p=>{asked=p;return {summaries:p.results.map(x=>({callId:x.callId,summary:'PER 33.1, target 300k'}))};}});
  assert.deepEqual(asked.results.map(x=>x.callId),['a']);assert.equal(r.steps.at(-1).step,'compact');assert.match(r.items[2].output,/compacted/);
  const failed=await fit(items,{keepFrom,compact:async()=>{throw new Error('AI_TIMEOUT');}});assert.equal(failed.steps.at(-1).error,'AI_TIMEOUT');assert.match(failed.items[2].output,/"digest":true/);
});
test('a research review that would have exceeded the limit now reaches its decision',async()=>{
  const big=research(900);const sent=[];let round=0;const logs=[];
  const request=async({continuation})=>{if(continuation)sent.push(size(continuation));round++;const base=continuation??[{role:'user',content:'c'.repeat(20000)}];
    if(round<4)return {toolCalls:[{name:'get_company_research',callId:'r'+round,args:{symbol:'005930'}}],continuation:[...base,{type:'function_call',call_id:'r'+round,name:'get_company_research',arguments:'{}'}],usage:{}};
    return {decision:{action:'Hold'},usage:{}};};
  const result=await researchReview({context:{universe:[{symbol:'005930'}],discovery:{enabled:true}},evidence:{get:async()=>({})},request,log:(k,t)=>logs.push(t),discovery:{get_company_research:async()=>big}});
  assert.equal(result.decision.action,'Hold');assert.ok(sent.every(n=>n<=LIMIT),'every follow-up fits: '+sent.join(','));assert.ok(logs.includes('Research context condensed'));
});
test('one round asking for several large lookups is digested too, so the review can continue',async()=>{
  const items=[{role:'user',content:'c'.repeat(38000)},{type:'function_call',call_id:'a',name:'get_company_research',arguments:'{}'},{type:'function_call',call_id:'b',name:'get_company_research',arguments:'{}'},{type:'function_call',call_id:'c',name:'get_company_research',arguments:'{}'},{type:'function_call',call_id:'d',name:'screen_market',arguments:'{}'},
    ...['a','b','c','d'].map(id=>({type:'function_call_output',call_id:id,output:JSON.stringify(research(700))}))];
  assert.ok(size(items)>LIMIT);const r=await fit(items,{keepFrom:1});
  assert.deepEqual(r.steps.map(s=>s.step),['digest','digest-latest']);assert.ok(size(r.items)<LIMIT*0.9,'fits: '+size(r.items));
  assert.equal(JSON.parse(r.items.at(-1).output).overview.price,216000,'numbers survive');
});
test('a review whose follow-up request is between 70 and 140 KB completes (the budget check uses the same limit)',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(':memory:');let round=0;const sizes=[];
  const provider={request:async(op,{context,options})=>{if(op!=='decision')throw new Error('UNEXPECTED');round++;if(options.continuation)sizes.push(size(options.continuation));
    if(round===1)return {toolCalls:[{name:'get_market_evidence',callId:'e1',args:{symbol:'005930',dataset:'company'}}],continuation:[{role:'user',content:JSON.stringify(context)},{type:'function_call',call_id:'e1',name:'get_market_evidence',arguments:'{}'}],usage:{inputTokens:1,outputTokens:1},provider:'openai'};
    return {decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:100,name:'F'}],()=>[]),provider,()=>{});a.providerStatus.aiConnected=true;
  a.evidence={get:async()=>({status:'available',padding:'x'.repeat(90000)})};a.configure({provider:'openai',openaiModel:'gpt-6-sol',reasoningEffort:'low',unlimitedBudget:true,unlimitedCalls:true});
  const review=await a.review('User request');assert.equal(review.decision.action,'Hold');assert.ok(sizes[0]>70000&&sizes[0]<140000,'follow-up was '+sizes[0]);
});
