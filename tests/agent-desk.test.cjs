const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
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
test('a held position whose stop loss was rejected stays unprotected until stop losses cover its shares or the user dismisses it',()=>{
  // 2026-10-29: the GOOGL stop loss was rejected at 09:15 (KIS_ORDER_BUSY) and later reviews treated the position as if it waited on a stop.
  let now=Date.parse('2026-10-29T00:15:00Z');const desk=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const U=['NASD:GOOGL','005930'];const on={...COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:5};
  const order=(purpose,quantity,op,value)=>desk.setOrder('kis:a',{action:'add',id:'',symbol:'NASD:GOOGL',side:'Sell',quantity,limitPrice:null,conditions:[{expr:'price("NASD:GOOGL")',op,value}],combine:'all',purpose,expiresInHours:48,reason:'r'},{config:on,universe:U});
  const stop=(quantity=2)=>order('stop_loss',quantity,'<=',290);const reject=(id,outcome)=>desk.update(desk.orders('kis:a').find(o=>o.id===id),{status:'rejected',outcome,closedAt:now});
  const held={'NASD:GOOGL':{quantity:2}};const list=(positions=held)=>desk.unprotected('kis:a',positions);
  const first=stop();assert.deepEqual(list(),[],'an armed stop protects');
  reject(first.id,'The broker or a risk check refused it (KIS_ORDER_BUSY).');
  const [u]=list({...held,'005930':{quantity:1}});assert.equal(u.symbol,'NASD:GOOGL');assert.equal(u.orderId,first.id);assert.equal(u.temporary,true);assert.equal(u.quantity,2);assert.equal(u.coveredQuantity,0);
  const ctx=desk.context('kis:a',on,U,held).conditionalOrders;assert.equal(ctx.unprotected.length,1);assert.match(ctx.unprotectedNote,/not protection/);
  assert.equal(desk.context('kis:a',on,U,{'NASD:GOOGL':{quantity:0}}).conditionalOrders.unprotected,undefined,'shares gone: nothing to protect');
  // Review P1: an armed take-profit cleared the warning though nothing limited a fall.
  order('take_profit',2,'>=',400);assert.equal(list()[0].coveredQuantity,0,'a take-profit is not a replacement stop');
  const half=stop(1);const [p]=list();assert.equal(p.partial,true);assert.equal(p.coveredQuantity,1);assert.equal(p.quantity,2);
  const rest=stop(1);assert.deepEqual(list(),[],'two stops cover both shares');desk.cancelOrder('kis:a',rest.id);assert.equal(list()[0].coveredQuantity,1);
  reject(half.id,'The broker or a risk check refused it (KIS_LIMIT_BAND).');const [l]=list();assert.equal(l.orderId,half.id);assert.equal(l.temporary,false,'a lasting refusal');assert.equal(l.quantity,1,'what that stop was for');
  now+=8*86400000;assert.equal(list().length,1,'time passing does not restore protection');
  assert.throws(()=>desk.dismissUnprotected('kis:a','C-nope'),/NOT_FOUND/);desk.dismissUnprotected('kis:a',half.id);assert.deepEqual(list(),[],'dismissed by the user');
});
test('a replacement stop that expires without firing does not settle the rejected one',()=>{
  // Review P1 (1.5.41): rejected, replacement armed, replacement expired: the warning stayed cleared with no stop.
  let now=Date.parse('2026-10-29T00:15:00Z');const desk=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const on={...COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:5};
  const stop=hours=>desk.setOrder('kis:a',{action:'add',id:'',symbol:'NASD:GOOGL',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("NASD:GOOGL")',op:'<=',value:290}],combine:'all',purpose:'stop_loss',expiresInHours:hours,reason:'r'},{config:on,universe:['NASD:GOOGL']});
  const held={'NASD:GOOGL':{quantity:1}};const first=stop(48);desk.update(desk.orders('kis:a').find(o=>o.id===first.id),{status:'rejected',outcome:'KIS_ORDER_BUSY',closedAt:now});
  now+=60000;stop(2);assert.deepEqual(desk.unprotected('kis:a',held),[],'the replacement covers it');
  now+=3*3600000;const [u]=desk.unprotected('kis:a',held);assert.equal(u?.orderId,first.id,'expired: unprotected again');assert.equal(u.coveredQuantity,0);
  const fired=stop(4);desk.update(desk.orders('kis:a').find(o=>o.id===fired.id),{status:'submitted',outcome:'Submitted',closedAt:now+1});now+=2;
  assert.deepEqual(desk.unprotected('kis:a',held),[],'a later stop that fired settles it');
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
  // A rejected stop on the held 005930 reaches the next review and the Agent desk.
  const scope=automation.watchScope();automation.desk.setOrder(scope,{action:'add',id:'',symbol:'005930',side:'Sell',quantity:10,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:200000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop'},{config:automation.config,universe:['005930']});
  automation.desk.update(automation.desk.orders(scope)[0],{status:'rejected',outcome:'refused (KIS_ORDER_BUSY).',closedAt:Date.now()});
  await automation.review();assert.equal(supplied.filter(([op])=>op==='decision').at(-1)[1].context.agentDesk.conditionalOrders.unprotected[0].symbol,'005930');
  assert.equal(automation.getState().desk.unprotected[0].temporary,true);
});
test('a met trigger starts a review with the values that met it',async()=>{
  const {automation,supplied,events}=harness();automation.configure({enabled:true});automation.sessionArmed=true;automation.lastRun=0;
  automation.desk.setTrigger(automation.watchScope(),{action:'add',id:'',name:'Dip',conditions:[{expr:'price("005930")',op:'<=',value:218000}],combine:'all',expiresInHours:4,reason:'Add on dips'},{universe:['005930']});
  automation.schedulerStatus=()=>({label:'Monitoring'});automation.marketHours=()=>({open:true,markets:[],preOpen:null,next:null});automation.sessionOpen=()=>true;automation.tick();await new Promise(r=>setTimeout(r,30));
  const review=supplied.find(([op])=>op==='decision');assert.ok(review,'a review ran');assert.equal(review[1].context.triggerEvidence.kind,'agent-trigger');assert.equal(review[1].context.triggerEvidence.results[0].actual,217000);
  assert.ok(events.some(e=>e.title==='Agent trigger met'));assert.equal(automation.desk.triggers(automation.watchScope()).length,0);
});
test('an agent trigger is checked only while every market it names has a session open',async()=>{
  // 2026-10-29: reviews started from U.S. prices while no U.S. session was open; triggers wait for the session.
  const {automation:a}=harness();a.configure({scope:'both',enabled:true});a.sessionArmed=true;a.schedulerStatus=()=>({label:'Monitoring'});a.marketHours=()=>({open:true,markets:[],preOpen:null,next:null});
  a.watchScope=()=>'both:acct';a.usQuotes=[{symbol:'NASD:GOOGL',price:294.86,timestamp:Date.now(),retrievedAt:Date.now(),stale:true}];
  const reviews=[];a.review=async trigger=>{reviews.push(trigger);};const open={KR:false,US:false};a.sessionOpen=m=>open[m];
  const add=(name,expr,value)=>a.desk.setTrigger(a.watchScope(),{action:'add',id:'',name,conditions:[{expr,op:'<=',value}],combine:'all',expiresInHours:4,reason:'x'},{universe:['005930','NASD:GOOGL']});
  add('Both','price("005930")+price("NASD:GOOGL")',300000);
  const tick=async()=>{a.lastRun=Date.now()-120000;a.lastDeskCheck=0;a.tick();await new Promise(r=>setTimeout(r,10));};
  await tick();assert.deepEqual(reviews,[],'both markets closed');
  open.KR=true;await tick();assert.deepEqual(reviews,[],'the U.S. session is still closed');assert.equal(a.desk.triggers(a.watchScope()).length,1,'the trigger stays active');
  open.US=true;await tick();assert.deepEqual(reviews,['Agent trigger']);assert.equal(a.desk.triggers(a.watchScope()).length,0);
  add('Korea','price("005930")',218000);open.KR=false;await tick();assert.equal(reviews.length,1,'a Korean trigger waits for the Korean session');
  open.KR=true;await tick();assert.equal(reviews.length,2);
});
test('a market counts as open in its regular session, or in an extended session switched on for a live account',()=>{
  const {automation:a}=harness();const at=iso=>Date.parse(iso);
  assert.equal(a.sessionOpen('KR',at('2026-10-29T00:15:33Z')),true,'09:15 KST');assert.equal(a.sessionOpen('KR',at('2026-10-29T12:00:00Z')),false,'21:00 KST');
  assert.equal(a.sessionOpen('US',at('2026-10-29T14:00:00Z')),true,'10:00 New York');assert.equal(a.sessionOpen('US',at('2026-10-29T00:15:33Z')),false,'the daytime session is off');
  a.configure({sessionUsDaytime:true});assert.equal(a.sessionOpen('US',at('2026-10-29T00:15:33Z')),false,'not on a mock account');
  a.live.getConnection=()=>({snapshot:{environment:'live'}});assert.equal(a.sessionOpen('US',at('2026-10-29T00:15:33Z')),true,'switched on, live');
});
test('held moves for the interval rule: open sessions and fresh quotes only; U.S. against the previous close',()=>{
  const {automation:a}=harness();a.configure({scope:'both'});const open={KR:true,US:true};a.sessionOpen=m=>open[m];a.series={closes:s=>s==='NASD:GOOGL'?[{date:'2020-01-02',close:300}]:null};
  const ctx={positions:{'028050':{quantity:3},'NASD:GOOGL':{quantity:2},'000270':{quantity:0},'005930':{quantity:1}},quotes:[{symbol:'028050',price:30000,changePct:-3.4},{symbol:'NASD:GOOGL',price:291},{symbol:'000270',price:1,changePct:9},{symbol:'005930',price:1,changePct:5,stale:true}]};
  assert.deepEqual(a.heldMoves(ctx),[{symbol:'028050',changePct:-3.4},{symbol:'NASD:GOOGL',changePct:-3}]);
  open.US=false;assert.deepEqual(a.heldMoves(ctx).map(m=>m.symbol),['028050'],'no U.S. session');
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
  ({automation:a}=harness({engineCtx:()=>open}));const sent=[];a.notify=(id,text)=>sent.push([id,text]);arm(a,{limitPrice:225000});o=await fire(a);assert.equal(o.status,'rejected');assert.match(o.outcome,/above the 2% limit/,'a floor 3.7% above the bid');
  assert.equal(sent.length,1);assert.match(sent[0][1],/Stop loss for 005930 was rejected.*not protected/,'a rejected stop loss tells the phone');
  // 2026-11-10: no shares on a fresh read means nothing is left to protect (not a rejection, no alert); unreadable holdings stay a rejection.
  ({automation:a}=harness({engineCtx:()=>({...open,positions:{}})}));sent.length=0;a.notify=(id,text)=>sent.push([id,text]);arm(a);o=await fire(a);assert.equal(o.status,'cancelled');assert.match(o.outcome,/Not needed: no shares of 005930 are held/);assert.equal(sent.length,0,'no stop-rejected alert');
  ({automation:a}=harness({engineCtx:()=>({...open,positions:undefined})}));a.notify=(id,text)=>sent.push([id,text]);arm(a);o=await fire(a);assert.equal(o.status,'rejected');assert.match(o.outcome,/could not be read/);assert.equal(sent.length,1,'an unreadable balance still alerts');
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
// Audit 2026-11-04 (Stage 1): every conditional Buy threw a ReferenceError (an undeclared market) that was recorded as
// "the broker or a risk check refused it", and an automatic submission was recorded as submitted whatever KIS replied.
// engine(market): a broker engine double whose propose, autoSubmit and order list a test can replace.
function engines(a,{lossMarkets=[],kr={},us={}}={}){
  const ctx=symbol=>({marketSession:{open:true},quotes:[{symbol,price:symbol.includes(':')?200:217000}],positions:{'005930':{quantity:10},'NASD:NVDA':{quantity:10}},equity:100000000,cash:50000000});
  const calls={propose:[],submit:[],annotate:[]};const book=[];
  const engine=(market,over)=>({market,identity:()=>'acct'+(market==='US'?':US':''),autoEnabled:true,enabled:true,context:async()=>ctx(market==='US'?'NASD:NVDA':'005930'),
    propose:cmd=>{calls.propose.push({market,...cmd});const p={id:'P'+calls.propose.length,status:'Ready'};book.push(p);return p;},autoSubmit:async id=>{calls.submit.push(id);const p=book.find(r=>r.id===id);p.status='Accepted';return {...p};},
    orders:()=>book,annotate:(id,patch)=>{calls.annotate.push([id,patch]);Object.assign(book.find(r=>r.id===id)??{},patch);},getState:()=>({}),...over});
  a.live=engine('KR',kr);a.usLive=engine('US',us);a.refreshUS=async()=>null;a.marketQuotes=()=>[{symbol:'005930',price:217000,timestamp:Date.now(),retrievedAt:Date.now()},{symbol:'NASD:NVDA',price:200,timestamp:Date.now(),retrievedAt:Date.now()}];a.calls=calls;a.book=book;
  a.emergencyState=()=>({active:lossMarkets.length>0,activeMarkets:lossMarkets});return a;
}
const armOrder=(a,{symbol='005930',side='Buy',quantity=1,purpose=side==='Buy'?'entry':'stop_loss',price=symbol.includes(':')?200:217000}={})=>{a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol,side,quantity,limitPrice:null,conditions:[{expr:`price("${symbol}")`,op:side==='Buy'?'>=':'<=',value:side==='Buy'?price-1:price+1}],combine:'all',purpose,expiresInHours:24,reason:'Fixture'},{config:a.config,universe:[symbol]});return a.desk.orders(a.watchScope()).find(o=>o.symbol===symbol&&o.side===side);};
const fired=async(a,order)=>{await a.fireConditional(order);return a.desk.rows('conditional_orders',a.watchScope()).find(o=>o.id===order.id);};
test('a conditional Buy reaches the proposal and submission in Korea and the U.S. (no ReferenceError)',async()=>{
  for(const symbol of ['005930','NASD:NVDA']){const {automation,events}=harness();const a=engines(automation);const o=await fired(a,armOrder(a,{symbol}));
    assert.equal(o.status,'submitted',symbol);assert.equal(a.calls.propose.length,1);assert.equal(a.calls.propose[0].market,symbol.includes(':')?'US':'KR','the account for its market');assert.deepEqual(a.calls.submit,['P1']);
    assert.equal(o.brokerStatus,'Accepted');assert.ok(!events.some(e=>/internal error/.test(e.title)));}
});
test('a daily loss halt blocks conditional Buys only in the market that reached it, and only when set to block',async()=>{
  let {automation:a}=harness();a.configure({lossAction:'stop'});engines(a,{lossMarkets:['US']});
  let o=await fired(a,armOrder(a,{symbol:'NASD:NVDA'}));assert.equal(o.status,'rejected');assert.match(o.outcome,/blocked after the daily loss limit/);
  o=await fired(a,armOrder(a,{symbol:'005930'}));assert.equal(o.status,'submitted','Korea has not reached its limit');
  ({automation:a}=harness());a.configure({lossAction:'review'});engines(a,{lossMarkets:['US','KR']});o=await fired(a,armOrder(a,{symbol:'NASD:NVDA'}));assert.equal(o.status,'submitted','"review more often, keep trading" does not block');
  ({automation:a}=harness());a.configure({lossAction:'stop'});engines(a,{lossMarkets:['US']});o=await fired(a,armOrder(a,{symbol:'NASD:NVDA',side:'Sell'}));assert.equal(o.status,'submitted','a protective sale is never blocked by the halt');
});
test('a conditional order states what stopped it: an app fault, the broker, an app check, or a mismatched account',async()=>{
  const sent=[];let {automation:a,events}=harness();engines(a,{kr:{propose:()=>{throw new TypeError("Cannot read properties of undefined (reading 'x')");}}});a.notify=(id,text)=>sent.push(text);
  let o=await fired(a,armOrder(a,{side:'Sell'}));assert.equal(o.status,'rejected');assert.match(o.outcome,/^Internal error in the app \(INTERNAL_ERROR, TypeError at agent-desk\.test\.cjs:\d+\)\. Nothing was proposed\. Nothing was sent to the broker\.$/);
  assert.doesNotMatch(o.outcome,/broker or a risk check|refused/);assert.equal(o.failure.kind,'internal');assert.ok(events.some(e=>e.title==='Conditional order · internal error'));assert.equal(sent.length,1,'a stop loss that failed still tells the phone');
  ({automation:a}=harness());engines(a,{kr:{autoSubmit:async()=>{throw Object.assign(new Error('BROKER_REJECTED'),{brokerCode:'APBK0919'});}}});o=await fired(a,armOrder(a));assert.equal(o.status,'rejected');assert.equal(o.outcome,'The broker rejected it (BROKER_REJECTED, KIS APBK0919). Proposal P1 was not sent.');
  ({automation:a}=harness());engines(a,{kr:{autoSubmit:async()=>{throw new Error('CONCENTRATION_LIMIT');}}});o=await fired(a,armOrder(a));assert.equal(o.outcome,'An app order check refused it (CONCENTRATION_LIMIT). Proposal P1 was not sent.');
  ({automation:a}=harness());engines(a,{us:{market:'KR'}});o=await fired(a,armOrder(a,{symbol:'NASD:NVDA'}));assert.equal(o.status,'rejected');assert.match(o.outcome,/MARKET_MISMATCH/);assert.equal(a.calls.propose.length,0);
});
test('an automatic submission follows what KIS replied: rejected, unclear, needs approval, or a closed session',async()=>{
  const reply=r=>({kr:{autoSubmit:async function(id){(this.submitted??=[]).push(id);return {id,...r};}}});const sent=[];
  let {automation:a}=harness();engines(a,reply({status:'Rejected',reason:'BROKER_REJECTED',brokerCode:'40580000'}));a.notify=(id,text)=>sent.push(text);
  let o=await fired(a,armOrder(a,{side:'Sell',quantity:10}));assert.equal(o.status,'rejected','not recorded as submitted');assert.equal(o.outcome,'The broker rejected it (BROKER_REJECTED, KIS 40580000). No order was placed.');assert.equal(o.brokerStatus,'Rejected');
  assert.equal(sent.length,1);const [u]=a.desk.unprotected(a.watchScope(),{'005930':{quantity:10}});assert.equal(u?.orderId,o.id,'the holding shows as not protected');
  ({automation:a}=harness());engines(a,reply({status:'Uncertain',reason:'ORDER_UNCERTAIN'}));o=await fired(a,armOrder(a,{side:'Sell'}));
  assert.equal(o.status,'submitted');assert.equal(o.unconfirmed,true);assert.match(o.outcome,/not confirmed as accepted or filled.*not retried/);assert.deepEqual(a.live.submitted,['P1']);assert.equal(a.desk.orders(a.watchScope()).length,0,'closed: nothing fires it again');
  assert.deepEqual(a.desk.unprotected(a.watchScope(),{'005930':{quantity:10}}),[],'an unclear stop is not reported as rejected (re-arming could sell twice)');
  ({automation:a}=harness());engines(a,reply({status:'Ready',reason:'APPROVAL_REQUIRED'}));o=await fired(a,armOrder(a));assert.equal(o.status,'proposed');assert.match(o.outcome,/^Not executed: proposal P1 .* needs your approval .*Nothing is at the broker until it is approved\.$/);
  ({automation:a}=harness());engines(a,reply({status:'Rejected',reason:'SESSION_CLOSED'}));o=await fired(a,armOrder(a));assert.equal(o.status,'armed');assert.equal(o.waiting,'market closed');
  ({automation:a}=harness());a.configure({conditionalAutoSubmit:false});engines(a);o=await fired(a,armOrder(a));assert.equal(o.status,'proposed');assert.match(o.outcome,/^Not executed: proposal P1 .* awaits your approval\. Nothing is at the broker/);
});
test('a temporary refusal before anything reached KIS is retried three times without leaving a second proposal',async()=>{
  const {automation,events}=harness();const a=engines(automation,{kr:{autoSubmit:async()=>{throw new Error('RATE_LIMITED');}}});const order=armOrder(a,{side:'Sell'});const scope=a.watchScope();
  for(let i=1;i<=3;i++){const o=await fired(a,a.desk.orders(scope)[0]);assert.equal(o.status,'armed',`attempt ${i}`);assert.equal(o.waiting,'temporary refusal (RATE_LIMITED)');assert.equal(o.retries,i);}
  assert.equal(a.calls.propose.length,3);assert.ok(a.book.every(p=>p.expiresAt<=Date.now()&&p.reason==='SUPERSEDED'),'each unsent proposal was retired before the next');
  assert.equal(events.filter(e=>e.title==='Conditional order · waiting'&&/not executed/.test(e.body)).length,3);
  const o=await fired(a,a.desk.orders(scope)[0]);assert.equal(o.status,'rejected');assert.match(o.outcome,/RATE_LIMITED on three attempts.*temporary/);
  assert.equal(a.desk.unprotected(scope,{'005930':{quantity:10}})[0].temporary,true);assert.equal(order.id,o.id);
  // Attempts count in a row: a check where the conditions are no longer met starts the count again.
  const {automation:c}=harness();engines(c,{kr:{autoSubmit:async()=>{throw new Error('SERVER_ERROR');}}});const cs=c.watchScope();armOrder(c,{side:'Sell'});
  await fired(c,c.desk.orders(cs)[0]);await fired(c,c.desk.orders(cs)[0]);assert.equal(c.desk.orders(cs)[0].retries,2);
  const ctx=c.live.context;c.live.context=async()=>({...(await ctx()),quotes:[{symbol:'005930',price:300000}]});assert.equal((await fired(c,c.desk.orders(cs)[0])).retries,0,'not met: the count restarts');
  // The proposal reached Submitting before the error: it may be at KIS, so it is unconfirmed and never retried.
  const {automation:b}=harness();engines(b,{kr:{autoSubmit:async id=>{b.book.find(p=>p.id===id).status='Submitting';throw new Error('REQUEST_TIMEOUT');}}});
  const u=await fired(b,armOrder(b,{side:'Sell'}));assert.equal(u.status,'submitted');assert.equal(u.unconfirmed,true);assert.equal(b.calls.annotate.length,0,'a proposal that may be at KIS is left alone');
});
test('a stop that reached the broker and then lapsed leaves its unfilled shares unprotected',()=>{
  let now=Date.parse('2026-11-04T01:00:00Z');const desk=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const on={...COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:5};
  const engine={P1:{status:'Partially filled',filled:4}};desk.sellStatus=o=>engine[o.orderId]?.status??null;desk.sellOrder=o=>engine[o.orderId]??null;
  desk.setOrder('kis:a',{action:'add',id:'',symbol:'005930',side:'Sell',quantity:10,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:200000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'r'},{config:on,universe:['005930']});
  const s=desk.orders('kis:a')[0];now+=60000;desk.update(s,{status:'submitted',orderId:'P1',outcome:'Submitted.',closedAt:now});
  assert.deepEqual(desk.unprotected('kis:a',{'005930':{quantity:6}}),[],'still working at the broker');
  engine.P1={status:'Canceled',filled:4};const [u]=desk.unprotected('kis:a',{'005930':{quantity:6}});
  assert.equal(u.quantity,6,'the six unfilled shares');assert.deepEqual(u.lapsed,{brokerStatus:'Canceled',filled:4});assert.match(u.outcome,/canceled there with 4 of 10 shares filled/);assert.equal(u.temporary,false);
  engine.P1={status:'Filled',filled:10};assert.deepEqual(desk.unprotected('kis:a',{'005930':{quantity:0}}),[]);
  engine.P1={status:'Expired',filled:0};assert.equal(desk.unprotected('kis:a',{'005930':{quantity:3}})[0].quantity,3,'never more than the shares held');
});
test('order failures are classified from their code, never from their wording',()=>{
  const {classify}=require('../electron/broker-errors.cjs');let ref;try{
    // @ts-ignore: a deliberate undefined name (the undefined-name check skips this line)
    undefinedName;}catch(e){ref=e;}
  const internal=classify(ref);assert.equal(internal.kind,'internal');assert.equal(internal.type,'ReferenceError');assert.match(internal.where,/^agent-desk\.test\.cjs:\d+$/);
  assert.equal(classify(Object.assign(new Error('x'),{code:'ERR_INVALID_ARG_TYPE'})).kind,'internal');assert.equal(classify('text').kind,'internal');assert.equal(classify(null).kind,'internal');
  assert.deepEqual([classify(new Error('BROKER_REJECTED')),classify(new Error('RATE_LIMITED')),classify(new Error('ORDER_UNCERTAIN')),classify(new Error('INSUFFICIENT_CAPACITY')),classify(Object.assign(new Error('x'),{code:'SESSION_CLOSED'}))].map(f=>f.kind),['broker','temporary','uncertain','check','temporary']);
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
test('a replacement stop protects only once its sell reaches the broker',()=>{
  // Review P1 (2b2c1cd): a replacement that became a proposal awaiting approval hid the rejection with all shares held.
  let now=Date.parse('2026-10-29T00:15:00Z');const desk=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const on={...COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:5};
  const broker={};desk.sellStatus=o=>broker[o.proposalId]??null;const held={'NASD:GOOGL':{quantity:1}};const list=()=>desk.unprotected('kis:a',held);
  const stop=()=>desk.setOrder('kis:a',{action:'add',id:'',symbol:'NASD:GOOGL',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("NASD:GOOGL")',op:'<=',value:290}],combine:'all',purpose:'stop_loss',expiresInHours:48,reason:'r'},{config:on,universe:['NASD:GOOGL']});
  const close=(id,status,extra={})=>{now+=60000;desk.update(desk.orders('kis:a').find(o=>o.id===id),{status,outcome:status,closedAt:now,...extra});};
  const first=stop();close(first.id,'rejected');
  const second=stop();close(second.id,'proposed',{proposalId:'P2'});broker.P2='Ready';
  let [u]=list();assert.equal(u?.orderId,first.id,'awaiting approval: still unprotected');assert.deepEqual(u.replacement,{orderId:second.id,status:'proposed',brokerStatus:'Ready'});
  delete broker.P2;assert.equal(list()[0]?.orderId,first.id,'a proposal the engine no longer lists does not count either');
  broker.P2='Accepted';assert.deepEqual(list(),[],'approved and sent');broker.P2='Filled';assert.deepEqual(list(),[]);
  broker.P2='Canceled';[u]=list();assert.equal(u?.orderId,first.id,'cancelled at the broker: unprotected again');assert.equal(u.replacement.brokerStatus,'Canceled');
  // A submitted stop the broker then refused protects nothing: it is listed itself, as lapsed (Stage 1, 2026-11-04).
  const third=stop();close(third.id,'submitted',{proposalId:'P3'});broker.P3='Rejected';[u]=list();assert.equal(u?.orderId,third.id,'submitted but refused by the broker');assert.deepEqual(u.lapsed,{brokerStatus:'Rejected',filled:0});
  broker.P3='Partially filled';assert.deepEqual(list(),[]);
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  a.engineOrders=()=>[{id:'P9',status:'Ready'}];assert.equal(a.desk.sellStatus({proposalId:'P9'}),'Ready','the scheduler reads the engines');assert.equal(a.desk.sellStatus({}),null);
});
test('a fired conditional order goes in at the best bid and gives the tracker its limitPrice as the bound',async()=>{
  const open={marketSession:{open:true},quotes:[{symbol:'005930',price:217000}],positions:{'005930':{quantity:4}},equity:10000000,cash:5000000};
  const {automation:a}=harness({engineCtx:()=>open});const notes=[];a.live.annotate=(id,patch)=>notes.push([id,patch]);
  a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'005930',side:'Sell',quantity:4,limitPrice:216000,conditions:[{expr:'price("005930")',op:'<=',value:218000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop'},{config:a.config,universe:['005930']});
  await a.fireConditional(a.desk.orders(a.watchScope())[0]);assert.equal(a.calls.propose[0].limitPrice,217000,'the bid, above the floor');assert.deepEqual(notes,[['P1',{tracking:{bound:216000}}]]);
  const {automation:b}=harness({engineCtx:()=>open});const none=[];b.live.annotate=(id,patch)=>none.push(patch);
  b.desk.setOrder(b.watchScope(),{action:'add',id:'',symbol:'005930',side:'Sell',quantity:4,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:218000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop'},{config:b.config,universe:['005930']});
  await b.fireConditional(b.desk.orders(b.watchScope())[0]);assert.deepEqual(none,[],'no limitPrice: no bound, it fills at any price');
});
test('a combined review reasons from the account valuation: its low bound, and how much it may understate and why',async()=>{
  const {automation:a}=harness();a.configure({scope:'both'});
  const ctx=(market,equity)=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity,cash:market==='US'?100:500000,universe:[],positions:{},quotes:[],orders:[],marketSession:{open:true},risk:{},executionEnabled:true,automaticExecutionEnabled:true});
  a.live={...a.live,market:'KR',identity:()=>'acct',context:async()=>ctx('KR',700000),orders:()=>[],getState:()=>({})};a.usLive={market:'US',identity:()=>'acct:US',context:async()=>ctx('US',500),orders:()=>[],getState:()=>({})};a.refreshUS=async()=>null;a.fx=()=>({usdKRW:1300});
  a.valuation=()=>({combined:{low:1250000,high:1380000,exact:false,complete:true,scope:['KR','US'],reasons:['Korea: 130000 of it may have been paid in USD']}});
  const {context}=await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'User request'});
  assert.equal(context.equity,1250000,'the low bound, not 700,000 + 500 × 1,300');assert.equal(context.equityUncertainty.understatedUpToKRW,130000);assert.match(context.equityUncertainty.reasons.join(' '),/paid in USD/);
  assert.equal(context.equityReliability.reliable,false);
  a.valuation=()=>({combined:{low:1350000,high:1350000,exact:true,complete:true,scope:['KR','US'],reasons:[]}});const exact=(await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'User request'})).context;
  assert.equal(exact.equity,1350000);assert.equal(exact.equityUncertainty,undefined);
  a.valuation=()=>({combined:{low:700000,high:700000,exact:false,complete:false,scope:['KR'],reasons:['U.S. balance not loaded']}});assert.equal((await a.assembleReviewContext({watchScope:a.watchScope(),trigger:'User request'})).context.equity,1350000,'Korea only: the engines figure stays');
});
test('while a daily loss breach is ambiguous, new conditional buys are restricted as a breach would be; sales are not',async()=>{
  let {automation:a}=harness();a.configure({lossAction:'stop'});engines(a);a.emergencyState=()=>({active:false,activeMarkets:[],ambiguousMarkets:['KR']});
  let o=await fired(a,armOrder(a,{symbol:'005930'}));assert.equal(o.status,'rejected');assert.match(o.outcome,/restricted.*No loss is claimed/);
  o=await fired(a,armOrder(a,{symbol:'NASD:NVDA'}));assert.equal(o.status,'submitted','only the market whose limit is in doubt');
  o=await fired(a,armOrder(a,{symbol:'005930',side:'Sell'}));assert.equal(o.status,'submitted','a protective sale goes ahead');
  ({automation:a}=harness());a.configure({lossAction:'review'});engines(a);a.emergencyState=()=>({active:false,activeMarkets:[],ambiguousMarkets:['KR']});o=await fired(a,armOrder(a,{symbol:'005930'}));assert.equal(o.status,'submitted','"review more often, keep trading" does not restrict');
});
test('a conditional stop sells only free cash shares: never margin-loan shares, never shares a waiting sale takes',async()=>{
  const bal=(extra={})=>({holdings:[{symbol:'005930',quantity:10,availableQuantity:10,loans:[{quantity:6,loanDate:'2026-09-01',availableQuantity:6}]}],...extra});
  let {automation:a}=harness();engines(a,{kr:{riskBalance:bal()}});let o=await fired(a,armOrder(a,{side:'Sell',quantity:10}));assert.equal(o.status,'submitted');assert.equal(a.calls.propose[0].quantity,4,'the 4 cash shares, not the 6 on loan');
  ({automation:a}=harness());engines(a,{kr:{riskBalance:bal(),orders:()=>[{symbol:'005930',side:'Sell',quantity:4,filled:0,status:'Accepted'}]}});o=await fired(a,armOrder(a,{side:'Sell',quantity:4}));
  assert.equal(o.status,'cancelled');assert.match(o.outcome,/already waiting/);assert.equal(a.calls.propose.length,0,'no second order for the same shares');
  ({automation:a}=harness());engines(a,{kr:{riskBalance:{holdings:[{symbol:'005930',quantity:10,availableQuantity:10,loans:[{quantity:10,loanDate:'2026-09-01',availableQuantity:10}]}]}}});o=await fired(a,armOrder(a,{side:'Sell'}));
  assert.equal(o.status,'rejected');assert.match(o.outcome,/margin-loan lots/);
});
test('a review sale larger than the free cash shares is recorded as not proposed, not as a failed review',async()=>{
  // The real live engine of the harness holds 10 shares of 005930; the review decides to sell 11.
  const {automation:a,queue}=harness();a.live.configure({symbols:[],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE MOCK');queue.push(()=>({decision:{action:'Sell',symbol:'005930',quantity:11,explanation:'Exit.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'}));
  const r=await a.review('User request').catch(e=>{throw new Error(a.lastError+' '+a.lastErrorDetail);});
  assert.match(r.executionNote??'',/Not proposed: Sell 11 005930 is more than the shares it can close: 10 free in its lot/);assert.equal(a.live.orders().length,0,'no proposal');
});
// 2026-11-10: two identical one-share PNR stop losses for one held share. The agent re-armed a stop that expired before
// the next U.S. open because the tool had no way to extend it, and nothing compared a new sell with shares held.
test('an identical stop for shares already covered renews the armed one; a different one past the shares held is refused',()=>{
  let now=Date.parse('2026-11-10T05:02:00Z');const desk=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const on={...COND_DEFAULTS,conditionalOrders:true,conditionalMaxActive:3,conditionalMaxHours:168};const U=['NYSE:PNR'];
  const stop=(extra={},positions={'NYSE:PNR':{quantity:1}})=>desk.setOrder('both:a',{action:'add',id:'',symbol:'NYSE:PNR',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("NYSE:PNR")',op:'<=',value:58.1}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Downside exit',...extra},{config:on,universe:U,positions,reviewId:'r1'});
  const first=stop();assert.equal(first.status,'armed');const before=desk.orders('both:a')[0];
  now+=3600000;const again=stop({conditions:[{expr:'price( "NYSE:PNR" )',op:'<=',value:58.10}],expiresInHours:168,reason:'Keep it through the open'});
  assert.equal(again.status,'armed');assert.equal(again.renewed,true);assert.equal(again.id,first.id);assert.equal(desk.orders('both:a').length,1,'one armed row');
  const row=desk.orders('both:a')[0];assert.equal(row.expiresAt,now+168*3600000,'later expiry');assert.equal(row.createdAt,before.createdAt,'createdAt kept');assert.equal(row.priceAtCreation,before.priceAtCreation);assert.equal(row.renewals,1);assert.equal(row.reason,'Keep it through the open');
  // A renewal never shortens the expiry.
  stop({expiresInHours:1});assert.equal(desk.orders('both:a')[0].expiresAt,now+168*3600000);
  // A different level for the same share: refused, naming the armed order.
  const other=stop({conditions:[{expr:'price("NYSE:PNR")',op:'<=',value:57}]});assert.equal(other.status,'rejected');assert.ok(other.reason.includes('1 shares of NYSE:PNR are held')&&other.reason.includes(first.id)&&other.reason.includes('send the identical order again'),other.reason);
  // A take profit on the same share is a different purpose and is allowed.
  assert.equal(stop({purpose:'take_profit',conditions:[{expr:'price("NYSE:PNR")',op:'>=',value:80}]}).status,'armed');
  assert.equal(stop({purpose:'take_profit',conditions:[{expr:'price("NYSE:PNR")',op:'>=',value:90}]},{'NYSE:PNR':{quantity:2}}).status,'armed');assert.equal(desk.orders('both:a').length,3);
  // Renewal works at the active-order limit, since nothing new is armed.
  assert.equal(stop().renewed,true,'at the limit of 3, the identical stop still renews');
  // Without positions nothing is compared: a second identical order is armed as before (a stop from a new buy's plan).
  const d2=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const s2=()=>d2.setOrder('k',{action:'add',id:'',symbol:'NYSE:PNR',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("NYSE:PNR")',op:'<=',value:58.1}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'r'},{config:on,universe:U});
  s2();assert.equal(s2().renewed,undefined);assert.equal(d2.orders('k').length,2);
  // Shares held: stops of 1 and 2 cover 3; a third of 1 is refused. No shares held: refused.
  const d3=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const s3=(quantity,value,held=3)=>d3.setOrder('k',{action:'add',id:'',symbol:'NYSE:PNR',side:'Sell',quantity,limitPrice:null,conditions:[{expr:'price("NYSE:PNR")',op:'<=',value}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'r'},{config:on,universe:U,positions:{'NYSE:PNR':{quantity:held}}});
  assert.equal(s3(1,58).status,'armed');assert.equal(s3(2,55).status,'armed');assert.equal(s3(1,50).status,'rejected');assert.ok(s3(1,50,0).reason.startsWith('0 shares of NYSE:PNR are held'));
  // Two identical one-share stops for two shares are both armed (there is room); a third renews.
  const d4=new AgentDesk(new DatabaseSync(':memory:'),()=>now);const s4=()=>d4.setOrder('k',{action:'add',id:'',symbol:'NYSE:PNR',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("NYSE:PNR")',op:'<=',value:58.1}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'r'},{config:on,universe:U,positions:{'NYSE:PNR':{quantity:2}}});
  assert.notEqual(s4().id,s4().id);assert.equal(d4.orders('k').length,2);assert.equal(s4().renewed,true,'the third renews');
  // A Buy is never compared with holdings.
  assert.equal(d4.setOrder('k',{action:'add',id:'',symbol:'NYSE:PNR',side:'Buy',quantity:5,limitPrice:null,conditions:[{expr:'price("NYSE:PNR")',op:'>=',value:70}],combine:'all',purpose:'entry',expiresInHours:24,reason:'r'},{config:{...on,conditionalMaxActive:5},universe:U,positions:{'NYSE:PNR':{quantity:2}}}).status,'armed');
});
test('a review sending the same stop twice renews it: one armed row, and the tool reply says so',async()=>{
  const {automation:a,queue,supplied}=harness();const args={action:'add',id:'',symbol:'005930',side:'Sell',quantity:10,limitPrice:null,conditions:[{expr:'price("005930")',op:'<=',value:200000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'Stop'};
  queue.push(()=>({toolCalls:[call('set_conditional_order',args,'s1')],continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1}}));
  queue.push(()=>({toolCalls:[call('set_conditional_order',{...args,expiresInHours:48},'s2')],continuation:[{role:'user',content:'x'}],usage:{inputTokens:1,outputTokens:1}}));
  await a.review('User request').catch(e=>{throw new Error(a.lastError+' '+a.lastErrorDetail);});
  const outs=supplied.filter(([op])=>op==='decision').flatMap(([,p])=>(p.options.continuation??[]).filter(o=>o.type==='function_call_output').map(o=>JSON.parse(o.output)));
  assert.ok(outs.some(o=>o.renewed===true),'the second reply says renewed: '+JSON.stringify(outs));assert.equal(a.desk.orders(a.watchScope()).length,1);
});
test('a duplicate stop that fires after the first sold the share is closed as not needed, without an alert; the second waits a minute',async()=>{
  let held=1;const ctx=()=>({marketSession:{open:true},quotes:[{symbol:'NYSE:PNR',price:58}],positions:{'NYSE:PNR':{quantity:held}},equity:5000000,cash:200});
  const {automation:a}=harness();engines(a,{us:{context:async()=>ctx()}});a.placementPrice=async()=>({price:58});const sent=[];a.notify=(id,text)=>sent.push(text);
  const scope=a.watchScope();for(const id of ['C-aaaaaa','C-bbbbbb'])a.desk.write('conditional_orders',{id,scope,status:'armed',symbol:'NYSE:PNR',side:'Sell',quantity:1,limitPrice:null,conditions:[{expr:'price("NYSE:PNR")',op:'<=',value:58.1}],symbols:['NYSE:PNR'],combine:'all',purpose:'stop_loss',reason:'r',createdAt:Date.now(),expiresAt:Date.now()+86400000});
  const pick=id=>a.desk.orders(scope).find(o=>o.id===id);
  const first=await fired(a,pick('C-aaaaaa'));assert.equal(first.status,'submitted');assert.ok(pick('C-bbbbbb').nextCheckAt>Date.now()+50000,'the other stop waits for a balance read after the fill');
  held=0;const second=await fired(a,pick('C-bbbbbb'));assert.equal(second.status,'cancelled');assert.ok(second.outcome.includes('Not needed: no shares of NYSE:PNR are held'));assert.equal(sent.length,0,'no "not protected" alert');assert.equal(a.calls.propose.length,1,'one sale only');
});
test('a stale review names the guard that tripped: settings or cost settings by key, never values',async()=>{
  const hold={decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'};
  let {automation:a,queue}=harness();queue.push(()=>{a.configure({reasoningEffort:'medium'});return hold;});
  await assert.rejects(a.review('User request'));assert.equal(a.lastError,'STALE_DECISION');assert.ok(a.lastErrorDetail.includes('Changed: settings.'),a.lastErrorDetail);
  ({automation:a,queue}=harness());const costs={usdKRW:1357.9,fees:{kr:1}};a.costs={get:()=>JSON.parse(JSON.stringify(costs)),context:()=>null};
  queue.push(()=>{costs.usdKRW=1355.7;return hold;});
  await assert.rejects(a.review('User request'));assert.equal(a.lastError,'STALE_DECISION');assert.ok(a.lastErrorDetail.includes('Changed: cost settings: usdKRW.'),a.lastErrorDetail);assert.ok(!/1355|1357/.test(a.lastErrorDetail),'no values');
  // The helper directly: current, account scope, disposed.
  const s=a.watchScope(),r=a.revision,c=JSON.stringify(a.costs.get());assert.equal(a.staleReason(s,r,c),null);assert.equal(a.staleReason('other',r,c),'account scope');a.disposed=true;assert.equal(a.staleReason(s,r,c),'disposed');
  // A review with nothing changed still completes.
  ({automation:a}=harness());await a.review('User request');assert.equal(a.lastError,null);
});
