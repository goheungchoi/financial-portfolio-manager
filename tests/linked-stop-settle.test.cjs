// A stop that could not grow past its first purchase (found in live use; artifacts/reviews/2026-11-26-linked-stop-cap).
// After a second purchase of a stock, every replacement of the plan stop for the whole position inherited the first
// purchase's link and was cut back to that purchase's shares, within the same second, while the tool had answered
// "armed" with the asked quantity; the stop then fired for the first purchase's shares only.
// The rule: the link caps a stop only until its purchase ends; then it is sized once and marked settled, and a settled
// link caps nothing. Made-up stock and quantities; a stand-in broker; no network.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');require('./fixtures/order-book.cjs');
const days=n=>Array.from({length:n},(_,i)=>new Date(Date.parse('2026-06-01T00:00:00Z')+i*86400000).toISOString().slice(0,10));
const series=(n,f)=>days(n).map((date,i)=>({date,close:f(i),value:1e9+i}));
const SYM='005930';
const planDecision=(quantity,stopPrice=200000)=>({action:'Buy',symbol:SYM,quantity,credit:'none',plan:{thesis:'Fixture thesis.',invalidation:'Breaks the fixture low',stopPrice,targetPrice:null,horizonDays:10,confidence:'medium'}});
// The app with a stand-in Korean engine: its purchase records are set by the test; a fired stop's proposal is recorded.
function app(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:SYM,price:100,name:'Fixture'}],()=>[]);const events=[];
  const a=new Automation(db,paper,{request:async()=>({decision:{action:'Hold',symbol:'',quantity:0,explanation:'Hold.',credit:'none',loanDate:''},usage:{inputTokens:1,outputTokens:1},provider:'openai'})},(id,kind,title,body)=>events.push({id,kind,title,body}));
  const ctx={marketSession:{open:true},quotes:[{symbol:SYM,price:217000}],positions:{},equity:10000000,cash:5000000};const records=new Map();const calls={propose:[]};
  a.live={market:'KR',identity:()=>'acct',autoEnabled:true,enabled:true,context:async()=>ctx,orders:()=>[...records.values()],
    propose:(cmd,opts)=>{calls.propose.push(cmd);return {id:'S'+calls.propose.length,status:'Ready',...(opts?.conditional===true?{madeBy:'conditional'}:{})};},autoSubmit:async id=>({id}),getState:()=>({})};
  a.providerStatus.aiConnected=true;a.evidence={get:async()=>({})};const closes=series(40,i=>200000+i*500);a.series={closes:s=>s===SYM?closes:null,ensure:async()=>{}};
  a.marketQuotes=()=>[{symbol:SYM,price:217000,timestamp:Date.now(),retrievedAt:Date.now()}];
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,openaiModel:'gpt-6-sol',reasoningEffort:'low',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});
  const scope=a.watchScope();const stops=()=>a.desk.orders(scope).filter(o=>o.purpose==='stop_loss');
  const buy=(id,quantity,filled,status)=>records.set(id,{id,symbol:SYM,side:'Buy',quantity,filled,status});
  const hold=n=>{ctx.positions={[SYM]:{quantity:n}};};
  // The review's tool, as a review calls it (set_conditional_order, add with replaces).
  const replace=(old,quantity,value=205000)=>a.desk.setOrder(scope,{action:'add',id:'',symbol:SYM,side:'Sell',quantity,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:'<=',value}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'The whole position',replaces:old},{config:a.config,universe:[SYM],positions:ctx.positions});
  const fire=async(value=230000)=>{for(const o of stops())a.desk.update(o,{conditions:[{...o.conditions[0],value}],nextCheckAt:0});a.configure({enabled:true});a.sessionArmed=true;a.lastDeskCheck=0;a.tick();await new Promise(r=>setTimeout(r,60));};
  return {a,db,ctx,records,calls,events,scope,stops,buy,hold,replace,fire};}

test('live case: two purchases, the plan stop replaced for the whole position: it stays at the whole position and fires for it',async()=>{
  const w=app();w.a.followPlan(w.scope,planDecision(2),'R1',{proposalId:'P1',market:'KR',positions:{}});
  w.buy('P1',2,2,'Filled');w.hold(2);w.a.syncLinkedStops();
  // The second purchase of 1 share, with no stop of its own (as on the live record), then the review's replacement.
  w.buy('P2',1,1,'Filled');w.hold(3);
  const r=w.replace(w.stops()[0].id,3);assert.equal(r.status,'armed');assert.equal(r.quantity,3,'the answer names the quantity armed');
  w.a.syncLinkedStops();w.a.syncLinkedStops();
  assert.equal(w.stops().length,1);assert.equal(w.stops()[0].quantity,3,'not cut back to the first purchase\'s 2');
  assert.ok(!w.events.some(e=>e.title==='Conditional order · resized'),'no resize after an "armed" for 3');
  await w.fire();assert.equal(w.calls.propose.length,1);assert.deepEqual([w.calls.propose[0].side,w.calls.propose[0].quantity],['Sell',3],'fires for the whole position');
});

test('a purchase partly filled: its stop is sized to the fill once and settled; a later replacement for the shares then held stays',()=>{
  const w=app();w.a.followPlan(w.scope,planDecision(2),'R1',{proposalId:'P1',market:'KR',positions:{}});
  w.buy('P1',2,1,'Canceled');w.hold(1);w.a.syncLinkedStops();
  const [s]=w.stops();assert.equal(s.quantity,1);assert.equal(s.resizedFrom,2);assert.equal(s.linkedBuy.settled,true,'settled at the end of its purchase');
  w.hold(2);const r=w.replace(s.id,2);assert.equal(r.status,'armed');assert.equal(r.quantity,2);w.a.syncLinkedStops();
  assert.equal(w.stops()[0].quantity,2,'the replacement is an ordinary stop: not cut to the 1 its old purchase bought');assert.equal(w.stops()[0].linkedBuy,undefined);
  assert.equal(w.events.filter(e=>e.title==='Conditional order · resized').length,1,'sized once');
});

test('a purchase still open: a replacement keeps the link, the cap and the wait; a larger one is armed for the purchase and says so',async()=>{
  const w=app();w.hold(2);w.a.followPlan(w.scope,planDecision(1),'R1',{proposalId:'P1',market:'KR',positions:{[SYM]:{quantity:2}}});w.buy('P1',1,0,'Accepted');
  const [s]=w.stops();const r=w.replace(s.id,3);assert.equal(r.status,'armed');assert.equal(r.quantity,1,'armed for the 1 being bought');
  assert.match(r.note,/^Armed for 1, not 3: it is tied to purchase P1, which is still open, and covers at most the 1 shares it buys\. Arm another stop for other shares\./);
  const [n]=w.stops();assert.deepEqual([n.quantity,n.linkedBuy.id,n.linkedBuy.settled??false],[1,'P1',false]);
  await w.fire();assert.equal(w.calls.propose.length,0,'waits while its purchase has not filled');assert.equal(w.stops()[0].waiting,'its purchase has not filled');
});

test('the tool always names the quantity armed: a plain add, a replace and a renewal',()=>{
  const w=app();w.hold(3);const add=v=>w.a.desk.setOrder(w.scope,{action:'add',id:'',symbol:SYM,side:'Sell',quantity:3,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:'<=',value:v}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'x'},{config:w.a.config,universe:[SYM],positions:{[SYM]:{quantity:3}}});
  const first=add(200000);assert.equal(first.quantity,3);assert.equal(add(200000).quantity,3,'the renewal');assert.equal(w.replace(first.id,3).quantity,3,'the replace');
});

test('a later purchase of a stock already held with a stop: what followPlan does today',()=>{
  // Established here: with the first purchase's stop covering what is held, a second purchase's plan arms a second stop,
  // linked to the new purchase, for the shares it buys, at its own plan's level; the first stop is not touched. Once the
  // new purchase ends it is settled too, and both stay as they are.
  const w=app();w.a.followPlan(w.scope,planDecision(2,200000),'R1',{proposalId:'P1',market:'KR',positions:{}});w.buy('P1',2,2,'Filled');w.hold(2);w.a.syncLinkedStops();
  w.a.followPlan(w.scope,planDecision(1,210000),'R2',{proposalId:'P2',market:'KR',positions:{[SYM]:{quantity:2}}});
  const two=w.stops();assert.equal(two.length,2);const second=two.find(o=>o.linkedBuy?.id==='P2');assert.ok(second,'a second stop linked to the new purchase');
  assert.deepEqual([second.quantity,second.conditions[0].value],[1,210000]);assert.deepEqual(two.find(o=>o.linkedBuy?.id==='P1').conditions[0].value,200000,'the first stop keeps its level');
  w.buy('P2',1,1,'Filled');w.hold(3);w.a.syncLinkedStops();assert.deepEqual(w.stops().map(o=>[o.quantity,o.linkedBuy.settled]).sort(),[[1,true],[2,true]]);
  // And the review can then join them into one stop for the whole position: cancel one, replace the other.
  const p2=w.stops().find(o=>o.linkedBuy.id==='P2');w.a.desk.setOrder(w.scope,{action:'cancel',id:p2.id},{config:w.a.config});
  const r=w.replace(w.stops()[0].id,3);assert.equal(r.status,'armed');w.a.syncLinkedStops();assert.equal(w.stops()[0].quantity,3);
});

test('where the second purchase gets no stop of its own: its arming is refused and said, never silent',()=>{
  // The planner's question (why no stop for the later share): the cases the code refuses, each logged "Stop-loss NOT
  // armed from the plan" with its reason, listed for Home and the next review, and sent as a phone alert.
  // (The armed-order limit refused it too until 2026-11-26, when the user removed that limit: tests/stops-several.)
  for(const [name,setup] of [['no holding read at the proposal (positions empty)',w=>({positions:{}})]]){
    const w=app();w.a.followPlan(w.scope,planDecision(2),'R1',{proposalId:'P1',market:'KR',positions:{}});w.buy('P1',2,2,'Filled');w.hold(2);w.a.syncLinkedStops();
    const {positions}=setup(w);w.a.followPlan(w.scope,planDecision(1),'R2',{proposalId:'P2',market:'KR',positions});
    assert.equal(w.stops().length,1,name);const e=w.events.find(x=>x.title==='Stop-loss NOT armed from the plan');assert.ok(e,name+': said');
    assert.match(e.body,/^1 005930 at 200000: .+ The purchase goes ahead without a stop order\.$/,name+': with its reason');}
});

test('the update: every armed stop whose purchase has ended is marked settled once, its quantity unchanged; nothing is resized',()=>{
  const w=app();
  // Stops as an earlier version left them: one replaced for 3 still carrying a filled purchase's link of 2 (the live
  // shape), one whose purchase is still open, one whose purchase record cannot be read yet.
  const mk=(id,qty,link)=>{const o={id,scope:w.scope,status:'armed',symbol:SYM,side:'Sell',quantity:qty,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:'<=',value:200000}],symbols:[SYM],combine:'all',purpose:'stop_loss',reason:'x',createdAt:Date.now(),expiresAt:Date.now()+86400000,linkedBuy:link};w.a.desk.write('conditional_orders',o);};
  mk('C-old3',3,{id:'P1',market:'KR',quantity:2});mk('C-open',1,{id:'P9',market:'KR',quantity:1});mk('C-gone',2,{id:'PX',market:'KR',quantity:2});
  w.buy('P1',2,2,'Filled');w.buy('P9',1,0,'Accepted');w.hold(3);
  w.a.syncLinkedStops();const get=id=>w.stops().find(o=>o.id===id);
  assert.deepEqual([get('C-old3').quantity,get('C-old3').linkedBuy.settled,get('C-old3').linkedBuy.settledBy],[3,true,'update'],'settled as it stands: still 3');
  assert.equal(get('C-open').linkedBuy.settled,undefined,'its purchase is still open: untouched');assert.equal(get('C-gone').linkedBuy.settled,undefined,'unreadable: untouched');
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='app_once'").get().n,1);assert.equal(w.db.prepare('SELECT COUNT(*) n FROM app_once').get().n,0,'not marked done while a record could not be read');
  assert.ok(!w.events.some(e=>e.title==='Conditional order · resized'),'nothing resized');
  w.buy('PX',2,2,'Filled');w.a.linksSettledChecked=undefined;w.a.syncLinkedStops();assert.equal(get('C-gone').linkedBuy.settled,true);assert.equal(get('C-gone').quantity,2);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM app_once').get().n,1,'done once every record was read');
});

// Review of the linked-stop fix (an independent read, 2026-11-26): three changes.
test('review 1: the update\'s settling is recorded per account and never while disconnected',()=>{
  const w=app();const mk=(id,qty,link)=>{w.a.desk.write('conditional_orders',{id,scope:w.scope,status:'armed',symbol:SYM,side:'Sell',quantity:qty,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:'<=',value:200000}],symbols:[SYM],combine:'all',purpose:'stop_loss',reason:'x',createdAt:Date.now(),expiresAt:Date.now()+86400000,linkedBuy:link});};
  mk('C-old3',3,{id:'P1',market:'KR',quantity:2});w.buy('P1',2,2,'Filled');w.hold(3);
  w.a.settleEndedLinksOnce('kis:disconnected');w.a.settleEndedLinksOnce('kis:other-account');
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM app_once WHERE id='linked-stops-settled:kis:disconnected'").get().n,0,'never while disconnected');
  assert.equal(w.stops()[0].linkedBuy.settled,undefined,'another account\'s pass leaves this account\'s stop for its own');
  w.a.syncLinkedStops();assert.deepEqual([w.stops()[0].quantity,w.stops()[0].linkedBuy.settled],[3,true],'its own account: settled as it stands, still 3');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM app_once WHERE id=?').get('linked-stops-settled:'+w.scope).n,1);
});

test('review 2: settling clears a stale "cannot read its purchase" mark, so Home stops warning',()=>{
  const w=app();w.a.followPlan(w.scope,planDecision(2),'R1',{proposalId:'P1',market:'KR',positions:{}});const [s]=w.stops();
  w.a.desk.update(s,{unreadableSince:Date.now()-400000,unreadableNoticeAt:Date.now()-60000});
  w.buy('P1',2,2,'Filled');w.hold(2);w.a.syncLinkedStops();const [n]=w.stops();
  assert.deepEqual([n.linkedBuy.settled,n.unreadableSince,n.unreadableNoticeAt],[true,null,null]);
});

test('review 3: an open purchase\'s filled shares are not counted twice: with 6 of 10 bought, its stop and another cover at most the 6 held plus 4 to come',()=>{
  const w=app();w.a.followPlan(w.scope,planDecision(10),'R1',{proposalId:'P1',market:'KR',positions:{}});w.buy('P1',10,6,'Partially filled');w.hold(6);
  const add=(quantity,extra={})=>w.a.desk.setOrder(w.scope,{action:'add',id:'',symbol:SYM,side:'Sell',quantity,limitPrice:null,conditions:[{expr:`price("${SYM}")`,op:'<=',value:190000}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'x',...extra},{config:w.a.config,universe:[SYM],positions:{[SYM]:{quantity:6}},linkFilled:l=>w.a.linkedPurchase({symbol:SYM,linkedBuy:l})?.filled??0});
  const more=add(6);assert.equal(more.status,'rejected','the linked stop already covers the 10');assert.match(more.reason,/6 shares of 005930 are held, and armed stop_loss orders already cover 10/);
  // Its replacement for the whole purchase still passes: 6 held and 4 still to be bought.
  const r=add(10,{replaces:w.stops()[0].id});assert.equal(r.status,'armed');assert.equal(r.quantity,10);
  // The review's own tool path passes the purchase's fills (automation.cjs deskActions).
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/automation.cjs'),'utf8'),/linkFilled:l=>this\.linkedPurchase\(\{symbol:args\?\.symbol,linkedBuy:l\}\)\?\.filled\?\?0/);
});
