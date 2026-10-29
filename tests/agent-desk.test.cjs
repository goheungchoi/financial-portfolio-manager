const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const formula=require('../electron/formula.cjs');const {AgentDesk,onTick,krTick,COND_DEFAULTS}=require('../electron/agent-desk.cjs');
const days=n=>Array.from({length:n},(_,i)=>new Date(Date.parse('2026-06-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));
const series=(n,f)=>days(n).map((date,i)=>({date,close:f(i),value:1e9+i}));
const data=(prices,closes,prev={})=>({price:s=>prices[s]??null,closes:s=>closes[s]??null,previousClose:s=>prev[s]??null});

test('formulas compute averages, returns, oscillators and pair statistics from daily closes',()=>{
  const a=series(60,i=>100+i),b=series(60,i=>200+2*i+(i%3));const d=data({'005930':160,'000660':330},{'005930':a,'000660':b},{'005930':150});
  const v=e=>formula.evaluate(formula.parse(e).ast,d);
  assert.equal(v('price("005930")'),160);assert.equal(v('sma("005930",10)'),154.5);assert.equal(v('close("005930",1)'),158);assert.equal(v('high("005930",5)'),159);assert.equal(v('low("005930",5)'),155);
  assert.equal(Math.round(v('change("005930")')*100)/100,6.67);assert.equal(Math.round(v('ret("005930",10)')*100)/100,syn(160/150));assert.equal(v('rsi("005930")'),100,'only gains');
  const r=v('corr("005930","000660",30)');assert.ok(r>=-1&&r<=1);assert.ok(Number.isFinite(v('ratio_z("005930","000660",30)')));assert.equal(v('avgvalue("005930",2)'),1e9+58.5);
  assert.equal(v('(price("005930")/sma("005930",10)-1)*100'),(160/154.5-1)*100);assert.equal(v('max(1, 4, 2) - 2^3 + abs(-1) + round(1.256, 2)'),-1.74);
  assert.ok(Math.abs(v('ema("005930",10)')-155)<2);assert.ok(v('zscore("005930",20)')>1);assert.ok(v('std("005930",20)')>0);
});
function syn(r){return Math.round((r-1)*10000)/100;}
test('formulas reject anything outside the language and fail clearly on missing data',()=>{
  for(const [bad,code] of [['process.exit()',null],['require("fs")','UNKNOWN_FUNCTION'],['price(005930)','WRONG_ARGUMENTS'],['price("ABC")','BAD_SYMBOL'],['sma("005930",999)',null],['1 +','SYNTAX_ERROR'],['x'.repeat(301),'FORMULA_TOO_LONG'],['price("005930");','BAD_CHARACTER'],['`1`','BAD_CHARACTER'],['['+'1]','BAD_CHARACTER'],['('.repeat(20)+'1'+')'.repeat(20),'FORMULA_TOO_DEEP'],['price("000001")+price("000002")+price("000003")+price("000004")+price("000005")+price("000006")+price("000007")','TOO_MANY_SYMBOLS']]){
    assert.throws(()=>formula.evaluate(formula.parse(bad).ast,data({},{})),e=>e instanceof formula.FormulaError&&(code==null||e.code===code),bad);
  }
  const empty=data({},{});assert.throws(()=>formula.evaluate(formula.parse('sma("005930",5)').ast,empty),/NO_DATA/);assert.throws(()=>formula.evaluate(formula.parse('price("005930")').ast,empty),/NO_PRICE/);
  assert.throws(()=>formula.evaluate(formula.parse('sma("005930",50)').ast,data({},{'005930':series(10,i=>i+1)})),/NOT_ENOUGH_HISTORY/);assert.throws(()=>formula.evaluate(formula.parse('1/0').ast,empty),/DIVIDE_BY_ZERO/);
  const c=formula.checkConditions([{expr:'price("005930")',op:'>',value:100},{expr:'sma("005930",5)',op:'<',value:1}],'any',data({'005930':150},{}));assert.equal(c.met,true);assert.equal(c.results[1].error,'NO_DATA');
  assert.equal(formula.checkConditions([{expr:'price("005930")',op:'>',value:100},{expr:'sma("005930",5)',op:'<',value:1}],'all',data({'005930':150},{})).met,false,'an unevaluable condition is not met');
});
test('triggers: validated against the universe, at most five, fire once and expire',()=>{
  let now=Date.parse('2026-10-17T01:00:00Z');const desk=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const U=['005930','000660'];
  const add=(extra={})=>desk.setTrigger('kis:a',{action:'add',id:'',name:'Breakout',conditions:[{expr:'price("005930")',op:'>=',value:220000}],combine:'all',expiresInHours:24,reason:'Above the August high',...extra},{universe:U});
  assert.equal(add({conditions:[{expr:'price("035420")',op:'>',value:1}]}).status,'rejected','outside the universe');assert.equal(add({expiresInHours:999}).status,'rejected');assert.match(add({conditions:[{expr:'foo()',op:'>',value:1}]}).reason,/UNKNOWN_FUNCTION/);
  const first=add();assert.equal(first.status,'saved');for(let i=0;i<4;i++)add();assert.match(add().reason,/Up to 5/);
  assert.equal(desk.checkTriggers('kis:a',data({'005930':210000},{})),null);const hit=desk.checkTriggers('kis:a',data({'005930':221000},{}));assert.equal(hit.trigger.name,'Breakout');assert.equal(hit.results[0].actual,221000);assert.equal(desk.triggers('kis:a').length,4,'a fired trigger closes');
  assert.equal(desk.setTrigger('kis:a',{action:'remove',id:desk.triggers('kis:a')[0].id},{}).status,'removed');now+=25*3600000;assert.equal(desk.triggers('kis:a').length,0,'expired');assert.equal(desk.triggers('kis:b').length,0);
});
test('notes: one per symbol, general notes, limits and expiry',()=>{
  let now=Date.parse('2026-10-17T01:00:00Z');const desk=new AgentDesk(new DatabaseSync(':memory:'),()=>now);
  assert.equal(desk.saveNote('kis:a',{action:'set',symbol:'005930',note:'Thesis: memory upcycle. Exit below 190,000.',expiresInDays:30}).status,'saved');
  desk.saveNote('kis:a',{action:'set',symbol:'005930',note:'Updated: exit below 195,000.',expiresInDays:30});desk.saveNote('kis:a',{action:'set',symbol:'',note:'Keep 30% cash until CPI.',expiresInDays:2});
  assert.deepEqual(desk.notes('kis:a').map(n=>[n.symbol,n.note]),[['','Keep 30% cash until CPI.'],['005930','Updated: exit below 195,000.']]);
  assert.equal(desk.saveNote('kis:a',{action:'set',symbol:'BAD',note:'x',expiresInDays:1}).status,'rejected');assert.equal(desk.saveNote('kis:a',{action:'set',symbol:'',note:'',expiresInDays:1}).status,'rejected');
  assert.equal(desk.saveNote('kis:a',{action:'set',symbol:'',note:'y'.repeat(900),expiresInDays:1}).status,'saved');assert.equal(desk.notes('kis:a')[0].note.length,500);
  now+=3*86400000;assert.deepEqual(desk.notes('kis:a').map(n=>n.symbol),['005930'],'the general note expired');assert.equal(desk.saveNote('kis:a',{action:'clear',symbol:'005930'}).status,'cleared');
  const ctx=new AgentDesk(new DatabaseSync(':memory:'),()=>now);ctx.saveNote('s',{action:'set',symbol:'000660',note:'n',expiresInDays:5});assert.equal(ctx.context('s',COND_DEFAULTS,['005930']).notes.length,0,'notes about symbols outside the universe are left out');
});
test('conditional orders need the setting, valid inputs and room; the context shows limits only when allowed',()=>{
  const desk=new AgentDesk(new DatabaseSync(':memory:'));const U=['005930'];const base={action:'add',id:'',symbol:'005930',side:'Sell',quantity:3,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:195000}],combine:'all',purpose:'stop_loss',expiresInHours:48,reason:'Thesis broken below 195k'};
  const off={...COND_DEFAULTS};const on={...COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:2};
  assert.match(desk.setOrder('kis:a',base,{config:off,universe:U}).reason,/turned off/);
  assert.equal(desk.setOrder('kis:a',{...base,symbol:'000660'},{config:on,universe:U}).status,'rejected');assert.equal(desk.setOrder('kis:a',{...base,quantity:0},{config:on,universe:U}).status,'rejected');
  assert.equal(desk.setOrder('kis:a',{...base,expiresInHours:500},{config:on,universe:U}).status,'rejected');assert.equal(desk.setOrder('kis:a',{...base,limitPrice:500000},{config:on,universe:U,quotes:[{symbol:'005930',price:200000}]}).status,'rejected','limit far from price');
  const armed=desk.setOrder('kis:a',base,{config:on,universe:U});assert.equal(armed.status,'armed');assert.match(armed.note,/waits for approval/);desk.setOrder('kis:a',base,{config:on,universe:U});assert.match(desk.setOrder('kis:a',base,{config:on,universe:U}).reason,/Up to 2/);
  assert.equal(desk.setOrder('kis:a',{action:'cancel',id:armed.id},{config:on}).status,'cancelled');assert.equal(desk.orders('kis:a').length,1);
  assert.deepEqual(desk.context('kis:a',off,U).conditionalOrders.allowed,false);assert.equal(desk.context('kis:a',on,U).conditionalOrders.maxSlippagePct,2);
});
test('limit prices land on the exchange tick',()=>{
  assert.equal(krTick(1500),1);assert.equal(krTick(150000),100);assert.equal(krTick(250000),500);assert.equal(onTick(217040,'Buy','KR'),217000);assert.equal(onTick(217040,'Sell','KR'),217500,'500-won ticks from 200,000');assert.equal(onTick(12.341,'Buy','US'),12.35);assert.equal(onTick(12.349,'Sell','US'),12.34);
});

// Automation with a fake broker engine: a review uses the desk tools in parallel, a trigger starts a review, a conditional order fires through the guarded path.
function harness({engineCtx,autoSubmit=true,conditionalAutoSubmit=true}={}){
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',price:100,name:'Fixture'}],()=>[]);
  const snapshot={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:5000000,holdings:[{symbol:'005930',name:'Samsung',quantity:10,cost:200000,price:217000}]};
  const live=new LiveEngine(db,{request:async()=>({balance:snapshot,quotes:[{symbol:'005930',price:217000,retrievedAt:Date.now()}],marketSession:{open:true,status:'open'}})},()=>({status:'connected',snapshot}));
  const supplied=[];const events=[];const queue=[];
  const provider={request:async(op,payload)=>{supplied.push([op,payload]);const next=queue.shift();return next?next(payload):{decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};}};
  const automation=new Automation(db,paper,provider,(id,kind,title,body)=>events.push({id,kind,title,body}));automation.live=live;automation.providerStatus.aiConnected=true;automation.evidence={get:async()=>({})};
  const closes=series(40,i=>200000+i*500);automation.series={closes:s=>s==='005930'?closes:null,ensure:async()=>{}};
  automation.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  automation.configure({scope:'kis',provider:'openai',shareKisWithAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit,conditionalOrders:true,conditionalAutoSubmit});
  if(engineCtx){const calls={propose:[],submit:[]};automation.live={identity:()=>'acct',autoEnabled:true,enabled:true,context:async()=>engineCtx(),propose:cmd=>{calls.propose.push(cmd);return {id:'P1',status:'Ready'};},autoSubmit:async id=>{calls.submit.push(id);return {id:'O1'};},getState:()=>({})};automation.calls=calls;}
  return {automation,supplied,events,queue,db};
}
const call=(name,args,id)=>({name,callId:id,args});
test('a review uses compute, notes and a trigger in one round; the context carries the desk',async()=>{
  const {automation,supplied,events,queue}=harness();
  queue.push(()=>({toolCalls:[call('compute',{formulas:[{name:'gap',expr:'(price("005930")/sma("005930",20)-1)*100'},{name:'bad',expr:'foo()'}]},'c1'),call('save_note',{action:'set',symbol:'005930',note:'Trim above 230,000.',expiresInDays:14},'c2'),call('set_review_trigger',{action:'add',id:'',name:'Breakout',conditions:[{expr:'price("005930")',op:'>=',value:230000}],combine:'all',expiresInHours:48,reason:'Trim zone'},'c3')],continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1}}));
  await automation.review();
  const first=supplied.find(([op])=>op==='decision')[1];assert.equal(first.context.agentDesk.conditionalOrders.allowed,true);assert.equal((first.context.agentDesk.notes??[]).length,0);
  const outputs=supplied.filter(([op])=>op==='decision')[1][1].options.continuation.filter(o=>o.type==='function_call_output').map(o=>JSON.parse(o.output));
  assert.equal(outputs[0].results[0].name,'gap');assert.ok(Number.isFinite(outputs[0].results[0].value));assert.match(outputs[0].results[1].error,/UNKNOWN_FUNCTION/);
  assert.equal(outputs[1].status,'saved');assert.equal(outputs[2].status,'saved');assert.equal(outputs[2].currentValues[0].actual,217000);assert.equal(outputs[2].currentValues[0].met,false);
  assert.ok(events.some(e=>e.title==='Desk result · set_review_trigger'));
  const state=automation.getState().desk;assert.equal(state.notes[0].note,'Trim above 230,000.');assert.equal(state.triggers[0].name,'Breakout');
  await automation.review();const second=supplied.filter(([op])=>op==='decision').at(-1)[1].context.agentDesk;assert.equal(second.notes[0].note,'Trim above 230,000.');assert.equal(second.triggers.length,1);
});
test('a met trigger starts a review with the values that met it',async()=>{
  const {automation,supplied,events}=harness();automation.configure({enabled:true});automation.sessionArmed=true;automation.lastRun=0;
  automation.desk.setTrigger(automation.watchScope(),{action:'add',id:'',name:'Dip',conditions:[{expr:'price("005930")',op:'<=',value:218000}],combine:'all',expiresInHours:4,reason:'Add on dips'},{universe:['005930']});
  automation.schedulerStatus=()=>({label:'Monitoring'});automation.marketHours=()=>({open:true,markets:[],preOpen:null,next:null});automation.tick();await new Promise(r=>setTimeout(r,30));
  const review=supplied.find(([op])=>op==='decision');assert.ok(review,'a review ran');assert.equal(review[1].context.triggerEvidence.kind,'agent-trigger');assert.equal(review[1].context.triggerEvidence.results[0].actual,217000);
  assert.ok(events.some(e=>e.title==='Agent trigger met'));assert.equal(automation.desk.triggers(automation.watchScope()).length,0);
});
test('conditional orders fire through the guarded path: submitted, proposed, or refused with a reason',async()=>{
  const open={marketSession:{open:true},quotes:[{symbol:'005930',price:217000}],positions:{'005930':{quantity:4}},equity:10000000,cash:5000000};
  const arm=(a,args={})=>a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'005930',side:'Sell',quantity:10,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:218000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop',...args},{config:a.config,universe:['005930']});
  const fire=async a=>{await a.fireConditional(a.desk.orders(a.watchScope())[0]);return a.desk.recentOrders(a.watchScope())[0]??a.desk.orders(a.watchScope())[0];};
  let {automation:a}=harness({engineCtx:()=>open});arm(a);let o=await fire(a);assert.equal(o.status,'submitted');assert.deepEqual(a.calls.propose[0],{symbol:'005930',side:'Sell',quantity:4,limitPrice:217000},'sells are capped at shares held');assert.deepEqual(a.calls.submit,['P1']);
  ({automation:a}=harness({engineCtx:()=>open,conditionalAutoSubmit:false}));arm(a);o=await fire(a);assert.equal(o.status,'proposed');assert.equal(a.calls.submit.length,0,'waits for approval');
  ({automation:a}=harness({engineCtx:()=>({...open,marketSession:{open:false}})}));arm(a);o=await fire(a);assert.equal(o.status,'armed');assert.equal(o.waiting,'market closed');
  assert.ok(o.nextCheckAt-Date.now()>290000,'a closed market is not re-checked for five minutes');a.configure({enabled:true});a.sessionArmed=true;a.lastDeskCheck=0;const before=a.calls.propose.length;a.tick();await new Promise(r=>setTimeout(r,20));assert.ok(!a.firing,'no new fire while backing off');assert.equal(a.calls.propose.length,before);
  a.desk.update(a.desk.orders(a.watchScope())[0],{status:'firing',firingAt:Date.now()-180000});assert.equal(a.desk.orders(a.watchScope())[0].waiting,'interrupted; checking again','an interrupted fire returns to armed');
  ({automation:a}=harness({engineCtx:()=>open}));arm(a,{limitPrice:200000});o=await fire(a);assert.equal(o.status,'rejected');assert.match(o.outcome,/above the 2% limit/);
  ({automation:a}=harness({engineCtx:()=>({...open,positions:{}})}));arm(a);o=await fire(a);assert.equal(o.status,'rejected');assert.match(o.outcome,/No shares held/);
  ({automation:a}=harness({engineCtx:()=>open}));arm(a,{side:'Buy',quantity:10});o=await fire(a);assert.equal(o.status,'rejected');assert.match(o.outcome,/above 10% of equity/);
  ({automation:a}=harness({engineCtx:()=>({...open,quotes:[{symbol:'005930',price:225000}]})}));arm(a);o=await fire(a);assert.equal(o.status,'armed','the fresh price no longer meets the condition');
  ({automation:a}=harness({engineCtx:()=>open}));a.live.propose=()=>{throw new Error('INSTRUMENT_NOT_ALLOWED');};arm(a);o=await fire(a);assert.equal(o.status,'rejected');assert.match(o.outcome,/INSTRUMENT_NOT_ALLOWED/);
});
test('a conditional order that meets another order being sent stays armed and fires on a later check',async()=>{
  // 2026-10-29: a GOOGL stop-loss was closed as rejected (KIS_ORDER_BUSY) while another order held the U.S. engine.
  const open={marketSession:{open:true},quotes:[{symbol:'005930',price:217000}],positions:{'005930':{quantity:4}},equity:10000000,cash:5000000};
  const {automation:a,events}=harness({engineCtx:()=>open});const scope=a.watchScope();
  a.desk.setOrder(scope,{action:'add',id:'',symbol:'005930',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:218000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop'},{config:a.config,universe:['005930']});
  const armed=()=>a.desk.orders(scope)[0],waits=()=>events.filter(e=>e.title==='Conditional order · waiting').length;
  // The engine is busy before the proposal: nothing is proposed, the order waits.
  a.live.busy=true;await a.fireConditional(armed());
  assert.equal(armed()?.status,'armed');assert.equal(armed().waiting,'another order in progress');assert.equal(a.calls.propose.length,0,'no proposal is left behind');
  assert.ok(Math.abs(armed().nextCheckAt-(Date.now()+10000))<2000,'checked again in 10 seconds');assert.equal(waits(),1);
  await a.fireConditional(armed());assert.equal(waits(),1,'one log entry while it keeps waiting');
  // The engine becomes busy between the proposal and the submission: the same.
  a.live.busy=false;const submit=a.live.autoSubmit;a.live.autoSubmit=async()=>{throw new Error('KIS_ORDER_BUSY');};await a.fireConditional(armed());
  assert.equal(armed()?.status,'armed');assert.equal(a.desk.recentOrders(scope).length,0,'not closed');
  a.live.autoSubmit=submit;await a.fireConditional(armed());assert.equal(a.desk.recentOrders(scope)[0].status,'submitted');assert.deepEqual(a.calls.submit,['P1']);
  assert.ok(!events.some(e=>e.title==='Conditional order · rejected'));
});
test('the tick fires conditional orders only while auto trading is on, one at a time',async()=>{
  const open={marketSession:{open:true},quotes:[{symbol:'005930',price:217000}],positions:{'005930':{quantity:4}},equity:10000000,cash:5000000};
  const {automation:a}=harness({engineCtx:()=>open});a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'005930',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:218000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop'},{config:a.config,universe:['005930']});
  a.tick();await new Promise(r=>setTimeout(r,20));assert.equal(a.calls.propose.length,0,'auto trading is off');
  a.configure({enabled:true});a.sessionArmed=true;a.lastDeskCheck=0;a.tick();await new Promise(r=>setTimeout(r,30));assert.equal(a.calls.propose.length,1);assert.equal(a.desk.orders(a.watchScope()).length,0);
});
test('reviews get the desk tools with parallel calls; conditional orders only when allowed; refused requests do not end a review',async()=>{
  const {AiClient}=require('../electron/ai-client.cjs');const bodies=[];
  const client=new AiClient('sk-fixture-key-123',async(url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'ok'})}]}]}));});
  await client.decide({universe:[],agentDesk:{conditionalOrders:{allowed:true}}},{research:true});await client.decide({universe:[],agentDesk:{conditionalOrders:{allowed:false}}},{research:true});await client.decide({universe:[]},{research:true});
  const names=b=>b.tools.map(t=>t.name);assert.ok(['compute','set_review_trigger','save_note','set_conditional_order'].every(n=>names(bodies[0]).includes(n)));assert.ok(!names(bodies[1]).includes('set_conditional_order'));assert.ok(!names(bodies[2]).includes('compute'));assert.equal(bodies[0].parallel_tool_calls,true);
  const {researchReview}=require('../electron/research-review.cjs');let round=0;const outputs=[];
  const result=await researchReview({context:{universe:[{symbol:'005930'}]},evidence:{get:async()=>({})},log:()=>{},actions:{save_note:async()=>{throw new Error('BOOM');}},request:async({continuation})=>{round++;if(continuation)outputs.push(...continuation.filter(o=>o.type==='function_call_output'));
    return round===1?{toolCalls:[call('get_market_evidence',{symbol:'999999',dataset:'company'},'a'),call('save_note',{},'b'),call('web_search',{},'c')],continuation:[]}:{decision:{action:'Hold'}};}});
  assert.equal(result.decision.action,'Hold');assert.equal(outputs.length,3);assert.ok(outputs.every(o=>/rejected/.test(o.output)));
  await assert.rejects(researchReview({context:{universe:[]},evidence:{get:async()=>({})},log:()=>{},actions:{save_note:async()=>{throw new Error('STALE_DECISION');}},request:async()=>({toolCalls:[call('save_note',{},'x')],continuation:[]})}),/STALE_DECISION/);
});
