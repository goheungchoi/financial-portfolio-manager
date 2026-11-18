// A sale made by a conditional order (stop, take profit) names that order in its outcome (artifacts/reviews/
// 2026-11-18-stop-exit-record). A sale made by a trailing stop had no review behind it in the outcome; with no
// review, so reviews and the reflection read its reason as 'unavailable' and an AI lesson guessed at a discretionary exit.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {OutcomeLedger}=require('../electron/outcome-ledger.cjs');
function fixture(){const db=new DatabaseSync(':memory:');for(const t of ['reviews','live_intents','paper_orders','paper_fills'])db.exec(`CREATE TABLE ${t}(id TEXT PRIMARY KEY,payload TEXT)`);
  db.exec('CREATE TABLE conditional_orders(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)');
  const put=(t,row)=>t==='conditional_orders'?db.prepare('INSERT OR REPLACE INTO conditional_orders VALUES(?,?,?,?)').run(row.id,row.scope??'kis:acct',row.status??'armed',JSON.stringify(row)):db.prepare(`INSERT OR REPLACE INTO ${t} VALUES(?,?)`).run(row.id,JSON.stringify(row));
  return {db,ledger:new OutcomeLedger(db),put};}
// The fixture's shape: a filled sale intent, its stop order replacing an earlier stop through a chain of replacements.
const SALE={id:'7b3e19c4',accountKey:'acct',market:'KR',environment:'live',currency:'KRW',symbol:'990050',side:'Sell',quantity:3,filled:3,fillPrice:64600,createdAt:Date.parse('2026-11-11T02:47:15Z'),status:'Filled',brokerOrderId:'0005551200',resultCosts:{gross:193800,fees:411,netCash:193389,gainAfterFees:17262}};
const TRAIL={kind:'atr',atrMultiple:2,atr:3591.81,distance:7183.62,floor:64600,high:71800,highAt:Date.parse('2026-11-09T05:30:00Z'),level:64600,active:true};
const stop=(id,extra={})=>({id,symbol:'990050',side:'Sell',quantity:3,purpose:'stop_loss',reason:'Trail the gain under the 2 × ATR stop.',conditions:[{value:64600}],createdAt:Date.parse('2026-11-06T01:30:00Z'),...extra});
function seed(put,{withChain=true,withReview=true}={}){
  put('live_intents',SALE);
  put('conditional_orders',stop('C-a1b2c3',{status:'submitted',orderId:'7b3e19c4',proposalId:'7b3e19c4',reviewId:'5d6e7f80',trail:TRAIL,firingAt:Date.parse('2026-11-11T02:47:14Z'),closedAt:Date.parse('2026-11-11T02:47:15Z'),...(withChain?{replaces:'C-c4d5e6'}:{})}));
  if(withChain){put('conditional_orders',stop('C-c4d5e6',{status:'replaced',reviewId:'r4',replaces:'C-f7a8b9'}));put('conditional_orders',stop('C-f7a8b9',{status:'replaced',reviewId:'r3',replaces:'C-0c1d2e'}));
    put('conditional_orders',stop('C-0c1d2e',{status:'replaced',reviewId:'r2',replaces:'C-3f4a5b'}));put('conditional_orders',stop('C-3f4a5b',{status:'replaced',reviewId:'1a2b3c4d'}));}
  // An older plan's stop: expired, not linked by replaces.
  put('conditional_orders',stop('C-6c7d8e',{status:'expired',reviewId:'plan-10-21',conditions:[{value:52500}]}));
  if(withReview)put('reviews',{id:'5d6e7f80',timestamp:Date.parse('2026-11-09T06:10:00Z'),decision:{action:'Hold',explanation:'Keep 990050; raise the stop to trail the gain.',plan:{thesis:'Earnings growth',stopPrice:64600}}});}

test('a sale placed by a stop order names it: purpose, trailing level, trail, arming review and its decision',()=>{
  const {ledger,put}=fixture();seed(put);ledger.sync();const o=ledger.list()[0];
  assert.equal(o.reviewId,null,'no review decided this sale at its time');assert.equal(o.decision,null);
  assert.deepEqual(o.trigger,{kind:'conditional',orderId:'C-a1b2c3',purpose:'stop_loss',reason:'Trail the gain under the 2 × ATR stop.',level:64600,levelKind:'trailing',
    trail:{kind:'atr',atrMultiple:2,atr:3591.81,distance:7183.62,high:71800,highAt:TRAIL.highAt,floor:64600},armedAt:Date.parse('2026-11-06T01:30:00Z'),armedByReviewId:'5d6e7f80',firedAt:Date.parse('2026-11-11T02:47:15Z'),
    replaces:['C-c4d5e6','C-f7a8b9','C-0c1d2e','C-3f4a5b'],chainStartsAt:'C-3f4a5b',firstArmedByReviewId:'1a2b3c4d'});
  assert.deepEqual(o.armingDecision,{explanation:'Keep 990050; raise the stop to trail the gain.',plan:{thesis:'Earnings growth',stopPrice:64600}});
  assert.ok(!JSON.stringify(o.trigger).includes('C-6c7d8e'),'the expired plan stop is not linked');});

test('matched by proposal when the order id differs; a fixed stop has no trail; no arming review gives null',()=>{
  const {ledger,put}=fixture();put('live_intents',SALE);put('conditional_orders',stop('C-1',{status:'submitted',orderId:'other',proposalId:'7b3e19c4',reviewId:null}));ledger.sync();
  const t=ledger.list()[0].trigger;assert.equal(t.orderId,'C-1');assert.equal(t.levelKind,'fixed');assert.equal(t.level,64600);assert.equal(t.trail,undefined);assert.equal(t.armedByReviewId,null);assert.equal(t.replaces,undefined);
  assert.equal(ledger.list()[0].armingDecision,undefined);});

test('a sale a review placed gets no trigger; a sale nothing matches is unchanged (same signature, no new version)',()=>{
  const {db,ledger,put}=fixture();put('live_intents',SALE);put('reviews',{id:'rv',timestamp:1,orderId:'7b3e19c4',decision:{action:'Sell',explanation:'Sell.'}});
  put('conditional_orders',stop('C-x',{status:'submitted',orderId:'7b3e19c4'}));ledger.sync();assert.equal(ledger.list()[0].reviewId,'rv');assert.equal(ledger.list()[0].trigger,undefined);
  const b=fixture();b.put('live_intents',{...SALE,id:'plain'});b.ledger.sync();const before=b.ledger.list()[0];assert.ok(!('trigger' in before)&&!('armingDecision' in before),'no null keys');
  b.put('conditional_orders',stop('C-other',{status:'submitted',orderId:'someone-else'}));b.ledger.sync();const after=b.ledger.list()[0];
  assert.equal(after.signature,before.signature);assert.equal(after.version,1);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM outcome_versions').get().n,1);});

test('the trigger appears once: a new version on the first sync after it is added, then stable',()=>{
  const {db,ledger,put}=fixture();put('live_intents',SALE);ledger.sync();assert.equal(ledger.list()[0].version,1);
  seed(put);ledger.sync();assert.equal(ledger.list()[0].version,2);assert.equal(ledger.list()[0].trigger.orderId,'C-a1b2c3');
  ledger.sync();ledger.sync();assert.equal(ledger.list()[0].version,2,'stable');});

test('a replaces loop or a missing link stops the chain; it is capped at five',()=>{
  const {ledger,put}=fixture();put('live_intents',SALE);put('conditional_orders',stop('C-a',{status:'submitted',orderId:'7b3e19c4',replaces:'C-b'}));put('conditional_orders',stop('C-b',{replaces:'C-a'}));ledger.sync();
  assert.deepEqual(ledger.list()[0].trigger.replaces,['C-b']);
  const f=fixture();f.put('live_intents',SALE);f.put('conditional_orders',stop('C-0',{status:'submitted',orderId:'7b3e19c4',replaces:'C-1'}));for(let i=1;i<=7;i++)f.put('conditional_orders',stop('C-'+i,{replaces:'C-'+(i+1)}));f.ledger.sync();
  assert.equal(f.ledger.list()[0].trigger.replaces.length,5);
  const g=fixture();g.put('live_intents',SALE);g.put('conditional_orders',stop('C-0',{status:'submitted',orderId:'7b3e19c4',replaces:'C-gone'}));g.ledger.sync();assert.equal(g.ledger.list()[0].trigger.replaces,undefined,'a link to a missing order is not followed');});

test('a database without conditional_orders still syncs',()=>{
  const db=new DatabaseSync(':memory:');for(const t of ['reviews','live_intents','paper_orders','paper_fills'])db.exec(`CREATE TABLE ${t}(id TEXT PRIMARY KEY,payload TEXT)`);
  db.prepare('INSERT INTO live_intents VALUES(?,?)').run(SALE.id,JSON.stringify(SALE));const l=new OutcomeLedger(db);l.sync();assert.equal(l.list()[0].trigger,undefined);});

// Step 2: position memory (trading reviews) and the reflection's episode read the trigger through view().
const PM=require('../electron/position-memory.cjs');
test('view(): a stop exit says what sold it and why, in place of "unavailable"; decidedAt stays null',()=>{
  const {ledger,put}=fixture();seed(put);ledger.sync();const o=ledger.list()[0];const v=PM.view({...o,effect:'CLOSE_LONG'},new Map());
  assert.equal(v.decisionId,null);assert.equal(v.decidedAt,null);assert.equal(v.madeBy,'stop-loss order');assert.equal(v.orderRef,'C-a1b2c3');assert.equal(v.levelKind,'trailing');assert.equal(v.level,64600);
  assert.equal(v.trail,'trailing ₩7,184 (2 × ATR) below a high of ₩71,800');assert.equal(v.armedByReviewId,'5d6e7f80');
  assert.equal(v.rationale,'Sold by its stop-loss order C-a1b2c3 at the trailing level ₩64,600, trailing ₩7,184 (2 × ATR) below a high of ₩71,800; armed 2026-11-06 by review 5d6e7f80: Trail the gain under the 2 × ATR stop.');
  assert.doesNotMatch(JSON.stringify(v),/unavailable/);assert.equal(v.filled,3);assert.equal(v.fillPrice,64600);});
test('view(): a fixed stop with no arming review; a review exit is unchanged',()=>{
  const v=PM.view({source:'broker',side:'Sell',quantity:1,timestamp:0,effect:'CLOSE_LONG',market:'KR',trigger:{kind:'conditional',orderId:'C-1',purpose:'stop_loss',level:52500,levelKind:'fixed',armedAt:null,armedByReviewId:null,reason:null}},new Map());
  assert.equal(v.rationale,'Sold by its stop-loss order C-1 at the fixed level ₩52,500');assert.equal(v.trail,undefined);
  const r=PM.view({source:'broker',side:'Sell',quantity:1,timestamp:0,effect:'CLOSE_LONG',reviewId:'rv',decision:{explanation:'Sell on the miss.'},trigger:undefined},new Map([['rv',1000]]));
  assert.equal(r.rationale,'Sell on the miss.');assert.equal(r.madeBy,undefined);
  const none=PM.view({source:'broker',side:'Sell',quantity:1,timestamp:0,effect:'CLOSE_LONG'},new Map());assert.equal(none.rationale,'unavailable','no trigger, no review: as before');});
test('position memory: the sold stock\'s row\'s last exit names the stop',()=>{
  const {ledger,put}=fixture();seed(put);put('live_intents',{...SALE,id:'buy1',side:'Buy',fillPrice:58700,createdAt:Date.parse('2026-10-14T01:52:00Z'),resultCosts:{gross:176100,fees:27}});ledger.sync();
  const rows=PM.build(ledger.list(),{accounts:[ledger.list()[0].accountKey],positions:{},now:Date.parse('2026-11-12T00:00:00Z')});const row=rows.find(r=>r.symbol==='990050');
  assert.equal(row.lastMaterial,'exit');assert.equal(row.lastExit.madeBy,'stop-loss order');assert.match(row.lastExit.rationale,/^Sold by its stop-loss order C-a1b2c3/);});
