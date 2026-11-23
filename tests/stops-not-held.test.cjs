// A stop for shares sold outside the app (found in live use: the shares were sold in the KIS app and the stop stayed
// armed), the history reads that the flow detector needs, and the words when auto trading stops with armed orders.
// Made-up symbols, order numbers and amounts.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
function setup(){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const events=[];let appOrders=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'123450',price:1,name:'F'}],()=>[]),{request:async()=>({})},(id,kind,title,body)=>events.push({id,title,body}));
  a.live={identity:()=>'acct',orders:()=>appOrders,stop(){}};a.config.scope='kis';
  const arm=(extra={})=>a.desk.write('conditional_orders',{id:'c'+Math.random().toString(36).slice(2,8),scope:a.watchScope(),status:'armed',side:'Sell',symbol:'123450',quantity:3,purpose:'stop_loss',createdAt:Date.parse('2026-10-05T08:00:00+09:00'),...extra});
  const find=id=>[...a.desk.orders(a.watchScope()),...a.desk.recentOrders(a.watchScope(),20)].find(x=>x.id===id);
  return {a,events,arm,find,setApp:o=>{appOrders=o;}};}
const T=t=>Date.parse(`2026-10-05T${t}:00+09:00`),now=T('12:00');
const read=(t,qty)=>({timestamp:new Date(T(t)).toISOString(),holdings:qty?[{symbol:'123450',quantity:qty}]:[]});
const trade=(orderId,side,filled,t,symbol='123450')=>({id:'kis:'+orderId,market:'KR',side,symbol,filled,fillPrice:50000,status:'Filled',createdAt:T(t),resultCosts:{netCash:(side==='Sell'?1:-1)*50000*filled},outside:{orderId,kind:'cash'}});
// Readings at the given times with the given counts held (0: none listed), each with the outside fills given.
const run=(a,steps,f)=>{let last=[];for(const [t,q] of steps)last=a.closeStopsNotHeld(read(t,q),now,f);return last;};
test('none held after an outside sale covering the shares: closed with the KIS order number, after two readings 3 minutes apart',()=>{
  const {a,events,arm,find}=setup();const o=arm();const f=[trade('0000901','Sell',3,'09:30')];
  a.closeStopsNotHeld(read('09:00',3),now,[]);assert.deepEqual(a.closeStopsNotHeld(read('09:58',0),now,f),[],'one reading never acts');
  assert.deepEqual(a.closeStopsNotHeld(read('09:59',0),now,f),[],'nor two within 3 minutes');assert.deepEqual(a.closeStopsNotHeld(read('10:01',0),now,f),[o.id]);
  const c=find(o.id);assert.equal(c.status,'cancelled');assert.equal(c.outcome,'Stop for 123450 (3 shares) closed: you sold the shares outside the app (KIS order 901); none are held.');
  assert.ok(events.some(e=>e.title==='Conditional order · closed'));
  assert.deepEqual(a.stopNotices(now).map(x=>[x.id,x.notice.kind]),[[o.id,'closed']]);a.acknowledgeStopNotice(o.id);assert.deepEqual(a.stopNotices(now),[]);
});
test('absence alone never closes a stop: it stays armed and you are asked once; a sale for fewer shares than were held does not close it either',()=>{
  for(const f of [[],[trade('0000902','Sell',1,'09:30')]]){const {a,arm,find}=setup();const o=arm();
    run(a,[['09:00',3],['09:50',0],['09:55',0]],f);const s=find(o.id);assert.equal(s.status,'armed');assert.equal(s.quantity,3);assert.equal(s.notice.kind,'ask');
    assert.match(s.notice.words,/the balance shows none held and no order explains it\. It stays armed/);
    assert.deepEqual(a.closeStopsNotHeld(read('10:05',0),now,f),[],'not asked again for the same count');
    a.acknowledgeStopNotice(o.id);assert.deepEqual(a.closeStopsNotHeld(read('10:10',0),now,f),[],'nor after you dismissed it');
    a.closeStopsNotHeld(read('10:15',3),now,f);assert.equal(find(o.id).notice,null,'held again: the question goes');}
});
test('an old outside sale is never evidence twice: a glitch after the count moved, after a reduction, and after a buy-back outside',()=>{
  // A: 10 held, a stop for 5; 5 sold outside (covered, nothing changes); then a balance listing nothing.
  {const {a,arm,find}=setup();const o=arm({quantity:5});const f=[trade('0000903','Sell',5,'09:30')];run(a,[['09:00',10],['09:31',5],['10:00',0],['10:04',0]],f);
    const s=find(o.id);assert.equal(s.status,'armed');assert.equal(s.quantity,5);assert.equal(s.notice.kind,'ask');}
  // B: reduced 3 → 1 on a sale of 2; then a balance listing nothing closes nothing on the same sale.
  {const {a,arm,find}=setup();const o=arm();const f=[trade('0000904','Sell',2,'09:30')];run(a,[['09:00',3],['09:31',1],['09:35',1]],f);
    assert.equal(find(o.id).quantity,1);assert.equal(find(o.id).notice.words,'Stop for 123450 reduced from 3 to 1 share: you sold 2 shares outside the app (KIS order 904).');
    run(a,[['10:00',0],['10:04',0]],f);const s=find(o.id);assert.equal(s.status,'armed');assert.equal(s.notice.kind,'ask');}
  // C: 3 sold and 3 bought back outside; then a balance listing nothing.
  {const {a,arm,find}=setup();const o=arm();const f=[trade('0000905','Sell',3,'09:30'),trade('0000906','Buy',3,'09:40')];run(a,[['09:00',3],['09:41',3],['10:00',0],['10:04',0]],f);
    assert.equal(find(o.id).status,'armed');assert.equal(find(o.id).notice.kind,'ask');}
  // A sale ordered before the stop was armed is no evidence for it.
  {const {a,arm,find}=setup();const o=arm({createdAt:T('09:45')});run(a,[['09:50',0],['09:55',0]],[trade('0000907','Sell',3,'09:30')]);assert.equal(find(o.id).status,'armed');}
});
test('several stops on one stock: covered together, nothing; more than is held, none changes and each is asked about',()=>{
  {const {a,arm,find}=setup();const x=arm(),y=arm();run(a,[['09:00',6],['09:30',6],['09:35',6]],[]);assert.equal(find(x.id).notice??null,null);assert.equal(find(y.id).notice??null,null);}
  {const {a,arm,find}=setup();const x=arm(),y=arm();const f=[trade('0000908','Sell',3,'09:30')];run(a,[['09:00',6],['09:31',3],['09:35',3]],f);
    for(const id of [x.id,y.id]){const s=find(id);assert.equal(s.quantity,3);assert.equal(s.status,'armed');assert.match(s.notice.words,/Stops for 123450 cover 6 shares together and 3 shares are held\. The app cannot tell which stop/);}}
});
test('left alone: an app order on the stock, a credit lot, a plan stop waiting, a U.S. stock, a purchase, the paper account',()=>{
  const {a,arm,find,setApp}=setup();const f=[trade('0000909','Sell',3,'09:30')];
  const ids=[arm({credit:{kind:'cover',loanDate:'2026-10-07'}}),arm({symbol:'NASD:NWTH'}),arm({side:'Buy'}),arm({linkedBuy:{id:'p1',market:'KR'}})].map(o=>o.id);
  assert.deepEqual(run(a,[['09:50',0],['09:55',0],['09:59',0]],f),[]);
  const app=arm();setApp([{id:'s1',symbol:'123450',side:'Sell',status:'Filled',filled:3,createdAt:T('09:00')}]);
  assert.deepEqual(run(a,[['10:10',0],['10:15',0]],f),[],'the app sold them: its own rules apply');
  for(const id of [...ids,app.id])assert.equal(find(id).status,'armed');
  a.config.scope='paper';assert.deepEqual(a.closeStopsNotHeld(read('10:20',0),now,f),[]);
});
function reads(){const {a}=setup();const calls=[];const engine={identity:()=>'acct',orders:()=>[],getState:()=>({}),getConnection:()=>({snapshot:null}),historyReadAt:undefined,dayValue:'2026-10-05',day(){return this.dayValue;},
  async syncHistory(day){calls.push('history'+(day?':'+day:''));if(engine.fail)throw new Error('X');if(!day)this.historyReadAt=engine.clock;},async syncMissed(){calls.push('missed');},async refreshOutsideCharges(){calls.push('charges');}};
  a.live=engine;a.usLive=null;return {a,engine,calls};}
test('the history is read after the app\'s session until KIS\'s last fill (20:00), once after it, and yesterday\'s at a new day; a failing read backs off',async()=>{
  const {a,engine,calls}=reads();a.sessionOpen=()=>false;
  engine.clock=Date.parse('2026-10-05T15:40:00+09:00');engine.historyReadAt=Date.parse('2026-10-05T15:19:00+09:00');a.lastOpenAt={KR:Date.parse('2026-10-05T15:19:00+09:00')};
  await a.syncHistories(engine.clock);assert.deepEqual(calls,['history','missed','charges'],'15:40, after the app\'s 15:20 end: read');
  calls.length=0;await a.syncHistories(engine.clock+120000);assert.deepEqual(calls,[],'every 5 minutes in the evening');
  engine.clock+=300000;await a.syncHistories(engine.clock);assert.deepEqual(calls,['history','missed','charges']);
  calls.length=0;engine.clock=Date.parse('2026-10-05T20:30:00+09:00');await a.syncHistories(engine.clock);assert.deepEqual(calls,['history','missed','charges'],'once after 20:00');
  calls.length=0;await a.syncHistories(engine.clock+600000);assert.deepEqual(calls,[],'and not again');
  engine.dayValue='2026-10-06';await a.syncHistories(engine.clock+700000);assert.ok(calls.includes('history:2026-10-05'),'yesterday read once at the new day');
  const b=reads();b.a.sessionOpen=()=>true;b.engine.fail=true;const t0=Date.parse('2026-10-05T10:00:00+09:00');b.engine.clock=t0;
  await b.a.syncHistories(t0);await b.a.syncHistories(t0+61000);await b.a.syncHistories(t0+125000);assert.equal(b.calls.filter(c=>c==='history').length,2,'a failure waits 1, then 2 minutes');
});
test('the history is read with Order tracking off, through the tick itself',async()=>{
  const {a,engine,calls}=reads();a.config.orderTracking=false;a.sessionOpen=()=>true;engine.clock=Date.now();try{a.tick();}catch{}
  await new Promise(r=>setTimeout(r,30));assert.ok(calls.includes('history'),'read although tracking is off');
});
test('the missed days: wait for the account; none when the detector has no reading; the newest 10; a failing day retried later',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const asked=[];let fail=null;
  const e=new LiveEngine(db,{request:async(op,d)=>{if(op==='orders'){asked.push(d.startDate);if(d.startDate===fail)throw new Error('X');return {orders:[]};}return {};}},()=>({status:'connected',snapshot:{accountKey:'acct',environment:'mock'}}));
  e.identity=()=>'acct';e.day=()=>'2026-10-30';
  e.backfillFrom=()=>undefined;await e.syncMissed();assert.equal(e.missedRead,undefined,'the account is not known yet: wait');
  e.backfillFrom=()=>null;await e.syncMissed();assert.equal(e.missedRead,true,'no reading: nothing to read');
  e.missedRead=false;e.backfillFrom=()=>'2026-10-01';await e.syncMissed();assert.equal(asked.length,10);assert.equal(asked[0],'2026-10-16');assert.equal(asked.at(-1),'2026-10-29','the newest 10 business days');
  e.missedRead=false;asked.length=0;fail='2026-10-20';await assert.rejects(()=>e.syncMissed(Date.now()));assert.equal(e.missedRead,false);await e.syncMissed(Date.now()+1000);assert.ok(asked.length<=10,'not retried at once');
  e.resetHistoryFor('other');assert.equal(e.historyReadAt,undefined);assert.equal(e.missedRead,false,'another account starts again');
  assert.equal(await e.refreshOutsideCharges(),0,'no rows today or yesterday: nothing read');
});
test('stopping auto trading says armed orders are the app\'s and not watched until it starts again',()=>{
  const L=require('../electron/auto-launch.cjs');const {a,arm}=setup();a.configure=()=>{};a.config.conditionalOrders=true;
  assert.equal(L.stop(a),'Auto trading stopped. Existing broker orders remain active.','no armed orders: as before');
  arm();arm({symbol:'234560',createdAt:T('08:30')});assert.equal(L.stop(a),'Auto trading stopped. Orders already at KIS stay. Your 2 armed stops (123450, 234560) are not watched until you start it again.');
  arm({purpose:'take_profit'});assert.match(L.stop(a),/Your 3 armed conditional orders \(123450, 234560\) are not watched/);
});
test('third review: a stop loss and a take profit on the same shares are each judged against them',()=>{
  {const {a,arm,find}=setup();const sl=arm(),tp=arm({purpose:'take_profit'});run(a,[['09:00',3],['09:30',3],['09:35',3]],[]);
    assert.equal(find(sl.id).notice??null,null);assert.equal(find(tp.id).notice??null,null,'covered: nothing asked');}
  {const {a,arm,find}=setup();const sl=arm(),tp=arm({purpose:'take_profit'});const f=[trade('0000a01','Sell',3,'09:30')];run(a,[['09:00',3],['09:40',0],['09:45',0]],f);
    assert.equal(find(sl.id).status,'cancelled');assert.equal(find(tp.id).status,'cancelled');assert.match(find(tp.id).outcome,/^Take-profit order for 123450 \(3 shares\) closed/);}
});
test('third review: no question while the history is not ready',()=>{
  const {a,arm,find}=setup();const o=arm();for(const t of ['09:00','09:50','09:55','10:00'])assert.deepEqual(a.closeStopsNotHeld(read(t,t==='09:00'?3:0),now,null),[]);assert.equal(find(o.id).notice??null,null);
});
test('third review: a baseline raised after the sale was ordered asks, never closes, and is not asked again once dismissed',()=>{
  const {a,arm,find}=setup();const o=arm();const f=[trade('0000a02','Sell',3,'09:30')];run(a,[['09:31',3],['09:40',0],['09:45',0]],f);
  const s=find(o.id);assert.equal(s.status,'armed');assert.equal(s.notice.kind,'ask');a.acknowledgeStopNotice(o.id);assert.deepEqual(run(a,[['09:50',0],['09:55',0]],f),[],'kept until the count changes');
});
test('third review: the day-change read is under the gap and backoff, for both engines; a session open caps the wait at 3 minutes and a success resets it',async()=>{
  const {a,engine,calls}=reads();const us={...engine,dayValue:'2026-10-05',calls:[],async syncHistory(){us.calls.push(1);throw new Error('X');}};a.usLive=us;a.sessionOpen=()=>false;
  engine.fail=true;engine.historyReadAt=Date.parse('2026-10-05T21:00:00+09:00');let t=Date.parse('2026-10-05T23:59:00+09:00');await a.syncHistories(t);
  engine.dayValue='2026-10-06';us.dayValue='2026-10-06';calls.length=0;for(let i=0;i<100;i++){t+=3000;await a.syncHistories(t);}
  assert.ok(calls.filter(c=>c.startsWith('history')).length<=4,'not every tick: '+calls.length);assert.ok(us.calls.length<=4,'U.S. too: '+us.calls.length);
  const b=reads();b.a.sessionOpen=()=>true;b.engine.fail=true;let u=Date.parse('2026-10-05T10:00:00+09:00');for(let i=0;i<8;i++){await b.a.syncHistories(u);u+=Math.max(61000,(b.a.historyState.KR.retryAt??0)-u);}
  assert.ok(b.a.historyState.KR.retryAt-u<=180000+61000,'at most 3 minutes while open');b.engine.fail=false;u=b.a.historyState.KR.retryAt;await b.a.syncHistories(u);assert.equal(b.a.historyState.KR.failures,0,'reset by a success');
});
test('third review: refreshOutsideCharges reads 3 per call, gives up after 6 failures, and starts again for a grown fill',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');let ok=false,n=0;
  const e=new LiveEngine(db,{request:async(op,d)=>{if(op==='charges'){n++;if(!ok)throw new Error('X');return {filled:2,charges:90};}return {orders:[]};}},()=>({status:'connected',snapshot:{accountKey:'acct',environment:'mock'}}));
  e.identity=()=>'acct';e.day=()=>'2026-10-05';e.orders=()=>[];const rowOf=(id,filled)=>({orderId:id,originalOrderId:null,symbol:'123450',side:'Sell',filled,quantity:2,executionAmount:50000*filled,timestamp:Date.parse('2026-10-05T09:10:00+09:00'),creditName:'현금매도'});
  e.recordHistory({orders:['1','2','3','4'].map(id=>rowOf(id,1))},'2026-10-05');let t=Date.now();
  assert.equal(await e.refreshOutsideCharges(t),3,'3 per call');
  for(let i=0;i<8;i++){t+=300000;await e.refreshOutsideCharges(t);}assert.ok(Object.values(e.outsideCharges()).some(v=>v.failed),'failed after 6 attempts');
  const before=n;t+=300000;await e.refreshOutsideCharges(t);e.recordHistory({orders:[rowOf('1',2)]},'2026-10-05');ok=true;t+=300000;await e.refreshOutsideCharges(t);
  assert.ok(n>before,'the grown fill is read again');assert.deepEqual(e.outsideCharges()['2026-10-05|1'],{charges:90,filled:2});
});
test('fourth review: a large fill older than yesterday gets its fee read, and is estimated after 6 failures (awaitingCharge ends)',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const {outsideFills}=require('../electron/outside-fills.cjs');const db=new DatabaseSync(':memory:');const asked=[];
  const e=new LiveEngine(db,{request:async(op,d)=>{if(op==='charges'){asked.push(d.day);throw new Error('X');}return {orders:[]};}},()=>({status:'connected',snapshot:{accountKey:'acct',environment:'mock'}}));
  e.identity=()=>'acct';e.day=()=>'2026-10-12';e.orders=()=>[];
  e.recordHistory({orders:[{orderId:'7',originalOrderId:null,symbol:'123450',side:'Sell',filled:1,quantity:1,executionAmount:25000000,timestamp:Date.parse('2026-10-09T09:10:00+09:00'),creditName:'현금매도'}]},'2026-10-09');
  let t=Date.now();for(let i=0;i<7;i++){await e.refreshOutsideCharges(t);t+=300000;}assert.deepEqual([...new Set(asked)],['2026-10-09']);assert.equal(asked.length,6);
  const [f]=outsideFills(e.historyRange('2026-10-01'),[],{charges:e.outsideCharges()});assert.equal(f.awaitingCharge,undefined);assert.equal(f.resultCosts.basis,'estimate-unread');
});
test('fourth review: the missed days are retried at night after a day change, under their own wait',async()=>{
  const {a,engine,calls}=reads();a.sessionOpen=()=>false;engine.historyReadAt=Date.parse('2026-10-05T21:00:00+09:00');engine.missedRead=true;
  let t=Date.parse('2026-10-05T23:59:00+09:00');await a.syncHistories(t);engine.dayValue='2026-10-06';t+=120000;await a.syncHistories(t);assert.equal(engine.missedRead,false);
  calls.length=0;for(let i=0;i<3;i++){t+=600000;await a.syncHistories(t);}assert.ok(calls.filter(c=>c==='missed').length>=3,'tried again at night');
});
test('fifth review: fee reads take the newest rows first and skip rows the detector cannot list',async()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');const asked=[];
  const e=new LiveEngine(db,{request:async(op,d)=>{if(op==='charges'){asked.push(d.day+'|'+d.orderId);return {filled:1,charges:10};}return {orders:[]};}},()=>({status:'connected',snapshot:{accountKey:'acct',environment:'mock'}}));
  e.identity=()=>'acct';e.day=()=>'2026-10-12';e.orders=()=>[];const rowOf=(id,day,extra={})=>({orderId:id,originalOrderId:null,symbol:'123450',side:'Sell',filled:1,quantity:1,executionAmount:25000000,timestamp:Date.parse(day+'T09:10:00+09:00'),creditName:'현금매도',...extra});
  for(const [id,day] of [['1','2026-10-01'],['2','2026-10-02'],['3','2026-10-03'],['4','2026-10-12']])e.recordHistory({orders:[rowOf(id,day)]},day);e.recordHistory({orders:[rowOf('5','2026-10-12',{creditName:undefined})]},'2026-10-12');
  await e.refreshOutsideCharges(Date.now());assert.deepEqual(asked,['2026-10-12|4','2026-10-03|3','2026-10-02|2'],'today\'s first; the unnamed row is not read');
});
