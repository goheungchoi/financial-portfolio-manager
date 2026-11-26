// Several stops of one purpose on one stock (the user's direction for the linked-stop fix, 2026-11-26: "Can we let it
// have multiple stop triggers for one symbol? … one for the first two and the other one for the last one."). The desk
// allows them while together they cover no more than the shares held (plus shares being bought); each fires for its
// own shares; with one open order at a time a second one hit at the same moment waits for the first sale; replacing
// one leaves the other untouched. And what followPlan does today when the armed-order limit refuses a purchase's own
// stop. Made-up stock and quantities; a stand-in broker; no network.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const days=n=>Array.from({length:n},(_,i)=>new Date(Date.parse('2026-06-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));
const series=(n,f)=>days(n).map((date,i)=>({date,close:f(i),value:1e9+i}));
const SYM='990001';
const planDecision=(quantity,stopPrice)=>({action:'Buy',symbol:SYM,quantity,credit:'none',plan:{thesis:'Fixture thesis.',invalidation:'Breaks the fixture low',stopPrice,targetPrice:null,horizonDays:10,confidence:'medium'}});
function app(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:SYM,price:100,name:'Fixture'}],()=>[]);const events=[],alerts=[];
  const a=new Automation(db,paper,{request:async()=>({decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'})},(id,kind,title,body)=>events.push({id,kind,title,body}));
  const ctx={marketSession:{open:true},quotes:[{symbol:SYM,price:217000}],positions:{},equity:10000000,cash:5000000};const records=new Map();const calls={propose:[]};
  // The stand-in engine keeps every order it is given, so the one-open-order rule sees a fired sale as open.
  a.live={market:'KR',identity:()=>'acct',autoEnabled:true,enabled:true,context:async()=>ctx,orders:()=>[...records.values()],
    propose:(cmd,opts)=>{calls.propose.push(cmd);const id='S'+calls.propose.length;records.set(id,{id,...cmd,filled:0,status:'Accepted',...(opts?.conditional===true?{madeBy:'conditional'}:{})});return {id,status:'Ready'};},autoSubmit:async id=>({id}),getState:()=>({})};
  a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};const closes=series(40,i=>200000+i*500);a.series={closes:s=>s===SYM?closes:null,ensure:async()=>{}};
  a.marketQuotes=()=>[{symbol:SYM,price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];a.notify=(id,message)=>alerts.push({id,message});
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true,trailingStops:true});
  const scope=a.watchScope();const armed=()=>a.desk.orders(scope);
  const hold=n=>{ctx.positions={[SYM]:{quantity:n}};};
  const order=(purpose,quantity,value,extra={})=>a.desk.setOrder(scope,{action:'add',id:'',symbol:SYM,side:'Sell',quantity,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:purpose==='take_profit'?'>=':'<=',value}],combine:'all',purpose,expiresInHours:24,reason:'x',...extra},{config:a.config,universe:[SYM],positions:ctx.positions,quotes:[{symbol:SYM,price:217000}],atr:()=>({value:3000,date:'2026-11-25'})});
  // Every armed order's condition met now (the price itself is the fixture's), then one pass of the watch.
  const hitAll=async()=>{for(const o of armed())a.desk.update(o,{conditions:[{...o.conditions[0],op:o.purpose==='take_profit'?'>=':'<=',value:o.purpose==='take_profit'?1:9e9}],...(o.trail?{trail:{...o.trail,level:9e9}}:{}),nextCheckAt:0});await pass();};
  const pass=async()=>{a.configure({enabled:true});a.sessionArmed=true;a.lastDeskCheck=0;a.tick();await new Promise(r=>setTimeout(r,80));};
  return {a,db,ctx,records,calls,events,alerts,scope,armed,hold,order,hitAll,pass};}

for(const [purpose,trailing] of [['stop_loss',false],['stop_loss',true],['take_profit',false]])
  test(`several ${purpose}${trailing?' (trailing)':''} orders on one stock: armed side by side while they cover no more than held; one more is refused`,()=>{
    const w=app();w.hold(3);const extra=trailing?{trail:{pct:5,atrMultiple:null,activateAt:null}}:{};
    const first=w.order(purpose,2,purpose==='take_profit'?240000:200000,extra),second=w.order(purpose,1,purpose==='take_profit'?250000:210000,extra);
    assert.deepEqual([first.status,second.status],['armed','armed'],JSON.stringify([first,second]));assert.deepEqual(w.armed().map(o=>o.quantity).sort(),[1,2]);
    if(trailing)assert.ok(w.armed().every(o=>o.trail),'both trail');
    const third=w.order(purpose,1,purpose==='take_profit'?260000:205000,extra);assert.equal(third.status,'rejected');assert.match(third.reason,/3 shares of 990001 are held, and armed .* orders already cover 3/);
    // The other purpose is counted apart: a take profit beside two stop losses, and the reverse.
    const other=w.order(purpose==='take_profit'?'stop_loss':'take_profit',3,purpose==='take_profit'?190000:260000);assert.equal(other.status,'armed');
  });

test('two stop losses hit at the same moment: the first sells its shares; with one open order at a time the second waits, then sells its own',async()=>{
  const w=app();w.hold(3);w.order('stop_loss',2,200000);w.order('stop_loss',1,210000);
  await w.hitAll();assert.equal(w.calls.propose.length,1,'one sale first');const firstSale=w.calls.propose[0];assert.equal(firstSale.side,'Sell');
  const waiting=w.armed().find(o=>o.status==='armed');assert.ok(waiting,'the other stays armed, not sold beside the first');
  await w.pass();assert.equal(w.calls.propose.length,1,'still one sale while the first is open');
  // The first sale fills; the second fires for its own shares only.
  w.records.set('S1',{...w.records.get('S1'),filled:firstSale.quantity,status:'Filled'});w.hold(3-firstSale.quantity);
  for(const o of w.armed())w.a.desk.update(o,{nextCheckAt:0});await w.pass();
  assert.equal(w.calls.propose.length,2);assert.deepEqual(w.calls.propose.map(c=>c.quantity).sort(),[1,2],'each sold its own shares; 3 in all');
});

test('replacing one of two stops leaves the other untouched',()=>{
  const w=app();w.hold(3);const a1=w.order('stop_loss',2,200000),b1=w.order('stop_loss',1,210000);const before=JSON.stringify(w.armed().find(o=>o.id===a1.id));
  const r=w.order('stop_loss',1,215000,{replaces:b1.id});assert.equal(r.status,'armed');assert.equal(r.quantity,1);
  assert.deepEqual(w.armed().map(o=>o.id).sort(),[a1.id,r.id].sort());assert.equal(JSON.stringify(w.armed().find(o=>o.id===a1.id)),before,'the first is exactly as it was');
  assert.equal(w.order('stop_loss',2,215000,{replaces:r.id}).status,'rejected','a replacement still cannot cover shares the other one covers');
});

test('the user\'s example: two shares bought at one level, one more later: two plan stops, each for its own purchase, each at its own level',()=>{
  const w=app();w.a.followPlan(w.scope,planDecision(2,95000),'R1',{proposalId:'P1',market:'KR',positions:{}});w.records.set('P1',{id:'P1',symbol:SYM,side:'Buy',quantity:2,filled:2,status:'Filled'});w.hold(2);w.a.syncLinkedStops();
  w.a.followPlan(w.scope,planDecision(1,104000),'R2',{proposalId:'P2',market:'KR',positions:{[SYM]:{quantity:2}}});w.records.set('P2',{id:'P2',symbol:SYM,side:'Buy',quantity:1,filled:1,status:'Filled'});w.hold(3);w.a.syncLinkedStops();
  assert.deepEqual(w.armed().map(o=>[o.linkedBuy.id,o.quantity,o.conditions[0].value,o.linkedBuy.settled]).sort(),[['P1',2,95000,true],['P2',1,104000,true]]);
});

test('the armed-order limit is gone (the user, 2026-11-26): with many orders armed, a purchase\'s own plan stop is armed',async()=>{
  // Found in live use: at the limit (then 10), the second purchase's plan stop was refused ("Up to N armed conditional
  // orders"), so its share had no stop. The user: "Can we just remove this limit?"
  const w=app();w.hold(2);w.order('stop_loss',2,200000);w.order('take_profit',2,260000);
  for(let i=0;i<10;i++)assert.equal(w.a.desk.setOrder(w.scope,{action:'add',id:'',symbol:SYM,side:'Buy',quantity:1,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:'<',value:1+i}],combine:'all',purpose:'entry',expiresInHours:24,reason:'x'},{config:w.a.config,universe:[SYM]}).status,'armed');
  assert.equal(w.armed().length,12);
  w.a.followPlan(w.scope,planDecision(1,104000),'R2',{proposalId:'P2',market:'KR',positions:{[SYM]:{quantity:2}}});
  assert.ok(w.armed().some(o=>o.linkedBuy?.id==='P2'&&o.quantity===1),'the new share has its own stop');assert.ok(!w.events.some(x=>x.title==='Stop-loss NOT armed from the plan'));
});

test('when a plan stop is still refused (here the holding could not be read): the purchase is still sent; the user and the next review are told',async()=>{
  const w=app();w.hold(2);w.order('stop_loss',2,200000);{const o=w.armed()[0];w.a.desk.update(o,{createdAt:o.createdAt-1000});}
  // A review's Buy of 1 more with a plan: the review proposes the purchase first, then calls followPlan, whose result
  // gates nothing; the send follows (automation.cjs, the decision path).
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/automation.cjs'),'utf8');
  const at=s=>src.indexOf(s);const propose=at('proposal=context.environment!==\'local-paper\'?execution.propose('),follow=at('this.followPlan(watchScope,d,id,{proposalId:proposal.id'),send=at('const autoEligible=this.config.autoSubmit');
  assert.ok(propose>0&&follow>propose&&send>follow,'proposed, then the plan stop, then the send');
  assert.ok(!/const \w+=this\.followPlan\(watchScope/.test(src),'the plan stop\'s outcome is not read by the decision path');
  w.a.followPlan(w.scope,planDecision(1,104000),'R2',{proposalId:'P2',market:'KR',positions:{}});
  assert.equal(w.armed().length,1,'no stop for the new share');
  const e=w.events.find(x=>x.title==='Stop-loss NOT armed from the plan');assert.ok(e,'logged');assert.match(e.body,/0 shares of 990001 are held and 1 are being bought.* The purchase goes ahead without a stop order\.$/);
  assert.ok(w.alerts.some(x=>/has no stop order: 0 shares of 990001 are held/.test(x.message)),'the phone alert');
  const failures=w.a.desk.planStopFailures(w.scope);assert.equal(failures.length,1,'listed for Home');
  const next=w.a.desk.context(w.scope,w.a.config,[SYM],{});assert.match(next.conditionalOrders.planStopsNotArmed[0].fact,/^The plan stop for 990001 was not armed: 0 shares of 990001 are held/,'told to the next review');
});
