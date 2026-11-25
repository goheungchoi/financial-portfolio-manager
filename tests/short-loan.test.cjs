// Short selling B3d-3 (part 1): a cover is paid from the short's collateral; the loan's end (cover before, warn before
// that); an unfilled short at the close and the next morning. Fake engines; made-up codes, prices, quantities and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const LOT={symbol:'990010',quantity:5,loanDate:'2026-07-01',entryPrice:1000,source:'distribution'};
const SHORT={id:'S1',symbol:'990010',side:'Sell',credit:{kind:'short'},status:'Filled',filled:5,fillPrice:1000,lotLoanDate:'2026-07-01',lotTie:{loanDate:'2026-07-01',at:1,how:'exact'}};
function app({shorts=[LOT],orders=[SHORT],policy={},db=new DatabaseSync(':memory:')}={}){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},(id,k,title,body)=>events.push({title,body}));
  a.live={market:'KR',identity:()=>'acct',riskBalance:{shorts,holdings:[]},getConnection:()=>({snapshot:{accountKey:'acct',environment:'mock'}}),orders:()=>orders,policy:()=>({day:'d'}),exposure:{policy:()=>({short:{enabled:true,stopLossPct:15,maxDays:90,coverBeforeDays:5,...policy}})},getState:()=>({})};
  a.usLive=null;a.configure({scope:'kis',conditionalOrders:true});a.closedDays=new Set();a.officialClosedDays=()=>[];a.ordersWatched=()=>true;return {a,events};}
const at=day=>Date.parse(day+'T10:00:00+09:00');
const exits=a=>a.desk.orders(a.watchScope()).filter(o=>o.purpose==='exit');

test('a cover is paid from the short\'s collateral: no cash reservation and no cash check, as a margin buy; a cash buy as before',()=>{
  const {FundingLedger}=require('../electron/funding-ledger.cjs');const base={id:'o',side:'Buy',status:'Accepted',quantity:1,limitPrice:1000,market:'KR'};
  assert.equal(FundingLedger.commitment({...base,credit:{kind:'cover'}}),null);assert.equal(FundingLedger.commitment({...base,credit:{kind:'margin-buy'}}),null);assert.notEqual(FundingLedger.commitment(base),null,'a cash buy still commits');
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','live-engine.cjs'),'utf8');
  assert.equal((src.match(/order\.side==='Buy'&&!\['margin-buy','cover'\]\.includes\(order\.credit\?\.kind\)/g)??[]).length,3,'the other market\'s reading, the cash check and the ledger');
});
test('the loan\'s end: the last day to cover is the last business day before the end; N counts to it; boundaries',()=>{
  const SS=require('../electron/short-stops.cjs');assert.deepEqual(SS.loanEnd('2026-07-01',90),{end:'2026-09-29',lastDay:'2026-09-28'});
  assert.deepEqual(SS.loanEnd('2026-07-04',90),{end:'2026-10-02',lastDay:'2026-10-01'});assert.equal(SS.loanEnd('2026-07-01',90,d=>d==='2026-09-28'?false:null).lastDay,'2026-09-25','a closed Monday: the Friday');
  assert.equal(SS.businessDaysTo('2026-09-28','2026-09-28'),0);assert.equal(SS.businessDaysTo('2026-09-29','2026-09-28'),-1);
  // End 2026-09-29, last day 2026-09-28 (Monday).
  let w=app();w.a.shortLoanEnds(w.a.watchScope(),[LOT],[SHORT],at('2026-09-11'));assert.equal(w.events.length,0,'11 business days before: nothing');
  w=app();w.a.shortLoanEnds(w.a.watchScope(),[LOT],[SHORT],at('2026-09-14'));assert.deepEqual(w.events.map(e=>e.title),['Short loan ends soon']);
  assert.equal(w.events[0].body,'The short of 5 990010 (loan 2026-07-01) ends its 90-day loan on 2026-09-29; the last day to cover is taken as 2026-09-28; the app covers it 5 business days before, in 5 business days.');
  w=app();w.a.shortLoanEnds(w.a.watchScope(),[LOT],[SHORT],at('2026-09-18'));assert.match(w.events[0].body,/in 1 business day\.$/);assert.equal(exits(w.a).length,0,'6 days before: not yet');
  w=app();w.a.shortLoanEnds(w.a.watchScope(),[LOT],[SHORT],at('2026-09-21'));assert.equal(exits(w.a).length,1,'5 days before: covered');assert.match(w.events.at(-1).body,/the last day to cover is taken as 2026-09-28, 5 business days away, so it is covered now\.$/);
  w=app();w.a.shortLoanEnds(w.a.watchScope(),[LOT],[SHORT],at('2026-09-29'));assert.equal(exits(w.a).length,1,'past the last day: covered at once');assert.match(w.events.at(-1).body,/already past, so it is covered now\.$/);
  const two=app({policy:{coverBeforeDays:2}});two.a.shortLoanEnds(two.a.watchScope(),[LOT],[SHORT],at('2026-09-21'));assert.equal(exits(two.a).length,0);assert.equal(two.events[0].title,'Short loan ends soon');
});
test('the loan-end cover is decided from the lot\'s own record: one order at most over several desk steps; refused or cancelled: not re-armed, and Home says so',async()=>{
  const {shortLoanLine}=await import('../src/unwatched-orders.mjs');const steps=(w,n=4)=>{for(let k=0;k<n;k++)w.a.shortLoanEnds(w.a.watchScope(),[LOT],w.orders,at('2026-09-21'));};
  const make=(extra=[])=>{const orders=[SHORT,...extra];const w=app({orders});w.orders=orders;steps(w,1);return w;};const rows=w=>w.a.desk.lotStops(w.a.watchScope(),'990010','2026-07-01','exit');
  // Rejected: not re-armed, listed.
  let w=make();let [c]=exits(w.a);w.a.desk.update(c,{status:'rejected',outcome:'refused (fixture)',closedAt:Date.now()});steps(w);assert.equal(rows(w).length,1,'one order at most');
  assert.deepEqual(w.a.shortLoanAlarms(w.a.watchScope(),at('2026-09-21')).map(x=>[x.cause,x.end]),[['rejected','2026-09-29']]);
  assert.equal(shortLoanLine({desk:{shortLoanAlarms:w.a.shortLoanAlarms(w.a.watchScope(),at('2026-09-21'))}}),'The short of 990010 ends its loan on 2026-09-29 and is not being covered (refused (fixture); buy it back in KIS\'s own app).');
  // You cancelled it: not re-armed, listed.
  w=make();[c]=exits(w.a);w.a.desk.cancelOrder(w.a.watchScope(),c.id);steps(w);assert.equal(rows(w).length,1);assert.equal(w.a.shortLoanAlarms(w.a.watchScope(),at('2026-09-21'))[0].cause,'cancelled');
  // Awaiting your approval: nothing new; named.
  w=make([{id:'P7',status:'Ready',expiresAt:Date.now()+60000}]);[c]=exits(w.a);w.a.desk.update(c,{status:'proposed',proposalId:'P7',closedAt:Date.now()});steps(w);assert.equal(rows(w).length,1);
  assert.match(shortLoanLine({desk:{shortLoanAlarms:w.a.shortLoanAlarms(w.a.watchScope(),at('2026-09-21'))}}),/its cover waits for your approval\.$/);
  // Resting at KIS: nothing new, nothing listed.
  w=make([{id:'P8',status:'Accepted',filled:0}]);[c]=exits(w.a);w.a.desk.update(c,{status:'submitted',proposalId:'P8',closedAt:Date.now()});steps(w);assert.equal(rows(w).length,1);assert.deepEqual(w.a.shortLoanAlarms(w.a.watchScope(),at('2026-09-21')),[]);
  // Filled with shares left: armed again, once.
  w=make([{id:'P9',status:'Filled',filled:3}]);[c]=exits(w.a);w.a.desk.update(c,{status:'submitted',proposalId:'P9',closedAt:Date.now()});steps(w);assert.equal(rows(w).length,2,'armed again once');
});
test('the loan-end warning\'s day is kept on the lot\'s record: a restart the same day does not repeat it',()=>{
  const db=new DatabaseSync(':memory:');const w=app({db});w.a.shortLoanEnds(w.a.watchScope(),[LOT],[SHORT],at('2026-09-14'));assert.equal(w.events.length,1);
  const r=app({db});r.a.shortLoanEnds(r.a.watchScope(),[LOT],[SHORT],at('2026-09-14'));assert.equal(r.events.length,0,'after a restart, the same day: not again');
  r.a.shortLoanEnds(r.a.watchScope(),[LOT],[SHORT],at('2026-09-15'));assert.equal(r.events.length,1,'the next day: again');
});
test('the loan\'s end is for the app\'s own shorts only; a short you opened gets no automatic cover from the app',()=>{
  const w=app({orders:[]});w.a.shortLoanEnds(w.a.watchScope(),[LOT],[],at('2026-09-22'));assert.equal(exits(w.a).length,0);assert.equal(w.events.length,0);
  const s=require('../electron/exposure.cjs');const e=new s.Exposure(new DatabaseSync(':memory:'));assert.equal(e.policy('x').short.coverBeforeDays,5,'the default');
});
test('an unfilled short at the close: KIS lapses the day order; the app records it ended, stops tracking it, and the cap no longer counts it',()=>{
  const {resolve}=require('../electron/order-chain.cjs');const order={id:'S2',symbol:'990010',side:'Sell',quantity:3,limitPrice:1001,brokerOrderId:'0000555',status:'Accepted',credit:{kind:'short'},filled:0};
  const res=resolve(order,[{orderId:'0000555',originalOrderId:null,symbol:'990010',side:'Sell',quantity:3,filled:0,remaining:0,orderPrice:1001,status:'Canceled',timestamp:Date.now()}]);
  assert.equal(res.status,'Canceled');
  const {LiveEngine}=require('../electron/live-engine.cjs');const snap={accountKey:'acct',environment:'mock',reportedTotal:1e7,cash:1e7,holdings:[]};const e=new LiveEngine(new DatabaseSync(':memory:'),{request:async()=>({})},()=>({status:'connected',snapshot:snap}));
  e.writeOrder({...order,accountKey:'acct',status:'Accepted',day:'2026-10-08'});assert.equal(e.openShortOrders().length,1,'resting: counted');
  e.writeOrder({...order,accountKey:'acct',status:res.status,closedReason:res.closedReason??null,day:'2026-10-08'});assert.deepEqual(e.openShortOrders(),[],'ended: not counted the next morning');
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8');assert.match(src,/o\.day!==engine\.day\(\)\)continue;/,'the tracker never moves a day order of another day');
});
test('run: a partly filled short at the close and an auction short that never fills',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const snap={accountKey:'acct',environment:'mock',reportedTotal:1e7,cash:1e7,holdings:[]};const db=new DatabaseSync(':memory:');const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'connected',snapshot:snap}));
  const order={id:'S3',accountKey:'acct',symbol:'990010',side:'Sell',quantity:3,limitPrice:1001,brokerOrderId:'0000556',status:'Accepted',credit:{kind:'short'},filled:0,day:'2026-10-08'};e.writeOrder(order);
  // The close: 1 of 3 filled, the rest lapses. History shows the filled part and nothing left open.
  const next=e.applyHistory(order,[{orderId:'0000556',originalOrderId:null,symbol:'990010',side:'Sell',quantity:3,filled:1,remaining:0,orderPrice:1001,averagePrice:1001,status:'Partially filled',loanDate:'2026-10-12',timestamp:Date.now()}]);
  assert.deepEqual([next.status,next.filled,next.closedReason,next.lotLoanDate],['Canceled',1,'expired unfilled','2026-10-12']);e.writeOrder({...next,filledObservedAt:Date.now()-1000,lotAtSend:0,lotAtSendAt:Date.now()-60000});// as the send records them
  assert.deepEqual(e.openShortOrders(),[],'the next morning the cap does not count the lapsed rest');
  const R=require('../electron/short-rules.cjs');assert.deepEqual(R.laggingShorts(e.orders(),{timestamp:new Date().toISOString(),shorts:[]}).map(x=>x.notional),[1001],'its filled share counts until the balance shows it');
  assert.deepEqual(R.laggingShorts(e.orders(),{timestamp:new Date().toISOString(),shorts:[{symbol:'990010',quantity:1}]}),[],'then the balance carries it');
  // The filled share is a lot with its stop.
  // Stage 2c: the next balance reading ties it to its lot (the engine's tieShorts, recorded on the order).
  const lot12={symbol:'990010',quantity:1,loanDate:'2026-10-12',entryPrice:1001};const seen={...next,filled:1,filledObservedAt:Date.now()-1000};
  const [tie]=require('../electron/short-stops.cjs').tieShorts({orders:[seen],balance:{timestamp:new Date().toISOString(),shorts:[lot12]}});assert.deepEqual(tie.set.lotTie.loanDate,'2026-10-12');
  const w=app({shorts:[lot12],orders:[{...seen,...tie.set}]});w.a.syncShortStops();assert.deepEqual(w.a.desk.orders(w.a.watchScope()).filter(o=>o.purpose==='stop_loss').map(o=>[o.quantity,o.conditions[0].value]),[[1,1152]]);
  // An auction short that never fills: nothing filled and nothing open at the end of the day.
  const auction={...order,id:'S4',brokerOrderId:'0000557',session:'auction'};e.writeOrder(auction);const gone=e.applyHistory(auction,[{orderId:'0000557',originalOrderId:null,symbol:'990010',side:'Sell',quantity:3,filled:0,remaining:0,orderPrice:1001,status:'Canceled',timestamp:Date.now()}]);
  assert.deepEqual([gone.status,gone.filled],['Canceled',0]);e.writeOrder(gone);assert.deepEqual(e.openShortOrders(),[]);assert.deepEqual(R.laggingShorts(e.orders().filter(o=>o.id==='S4'),{timestamp:new Date().toISOString(),shorts:[]}),[]);
});
test('the loan-end cover over generated histories: exactly one of arm, list or covered; a stop\'s rows never count for it',()=>{
  const SS=require('../electron/short-stops.cjs');const statuses=['armed','firing','expired','proposed','submitted','rejected','cancelled'];let seed=13;const rnd=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
  for(let i=0;i<5000;i++){const rows=Array.from({length:rnd(5)},(_,k)=>({id:'R'+k,side:'Buy',purpose:['exit','stop_loss'][rnd(2)],credit:{kind:'cover',loanDate:'2026-07-01'},symbol:'990010',status:statuses[rnd(statuses.length)],closedBy:['app','user','agent'][rnd(3)]}));
    const st=['Ready','Accepted','Filled','Canceled',null][rnd(5)],d=SS.lotDecision(rows,{purpose:'exit',brokerStatus:()=>st,brokerFilled:()=>rnd(3),brokerExpired:()=>rnd(2)===1});assert.equal(['arm','list','covered'].filter(k=>d[k]).length,1);
    if(!rows.some(r=>r.purpose==='exit'))assert.ok(d.arm,'only exit rows decide');}
});
test('the loan-end cover armed but not watched: the line and Home say so; stopped without the setting, Stop everything, and watched',async()=>{
  const {shortLoanLine}=await import('../src/unwatched-orders.mjs');const run=w=>{w.a.shortLoanEnds(w.a.watchScope(),[LOT],[SHORT],at('2026-09-21'));return [w.events.at(-1).body,shortLoanLine({desk:{shortLoanAlarms:w.a.shortLoanAlarms(w.a.watchScope(),at('2026-09-21'))}})];};
  // Stopped with the setting off: the real rule (nothing watched).
  const off=app();delete off.a.ordersWatched;off.a.connectedAccount=()=>({account:'acct',environment:'mock'});assert.equal(off.a.ordersWatched(),false);
  let [line,home]=run(off);assert.match(line,/so its cover is armed and is sent once orders are watched\.$/);assert.equal(home,'990010 short ends its loan on 2026-09-29: its cover is armed but not watched until auto trading is started.');
  // Stop everything (the setting on, everything stopped).
  const se=app();delete se.a.ordersWatched;se.a.connectedAccount=()=>({account:'acct',environment:'mock'});se.a.watchStopped.turnOn({account:'acct',environment:'mock'});se.a.watchStopped.stopEverything();assert.equal(se.a.ordersWatched(),false);
  [line,home]=run(se);assert.match(line,/sent once orders are watched\.$/);assert.match(home,/armed but not watched/);
  // Watched (the setting on): covered now, no Home line.
  const on=app();delete on.a.ordersWatched;on.a.connectedAccount=()=>({account:'acct',environment:'mock'});on.a.watchStopped.turnOn({account:'acct',environment:'mock'});assert.equal(on.a.ordersWatched(),true);
  [line,home]=run(on);assert.match(line,/so it is covered now\.$/);assert.equal(home,null);
});
test('small: the loan-end cover\'s own words; coverBeforeDays a whole number; the warnings table made once, only with shorts, its rows removed with their lot',()=>{
  const SS=require('../electron/short-stops.cjs');assert.equal(SS.lotDecision([{side:'Buy',purpose:'exit',credit:{kind:'cover',loanDate:'d'},status:'cancelled',closedBy:'user'}],{purpose:'exit'}).list.words,"you cancelled its loan-end cover; buy it back in KIS's own app");
  assert.equal(SS.lotDecision([{side:'Buy',purpose:'stop_loss',credit:{kind:'cover',loanDate:'d'},status:'cancelled',closedBy:'user'}]).list.words,"you cancelled its cover stop; buy it back in KIS's own app");
  const E=require('../electron/exposure.cjs');const e=new E.Exposure(new DatabaseSync(':memory:'));assert.throws(()=>e.savePolicy('a',{short:{coverBeforeDays:2.5}}),/INVALID_SETTINGS/);e.savePolicy('a',{short:{coverBeforeDays:3}});assert.equal(e.policy('a').short.coverBeforeDays,3);
  const db=new DatabaseSync(':memory:');const none=app({db,shorts:[]});none.a.shortLoanEnds(none.a.watchScope(),[],[SHORT],at('2026-09-14'));assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='short_loan_warnings'").get(),undefined,'no shorts: no table');
  const w=app({db});w.a.shortLoanEnds(w.a.watchScope(),[LOT],[SHORT],at('2026-09-14'));assert.equal(db.prepare('SELECT count(*) n FROM short_loan_warnings').get().n,1);
  w.a.shortLoanEnds(w.a.watchScope(),[],[SHORT],at('2026-09-15'));assert.equal(db.prepare('SELECT count(*) n FROM short_loan_warnings').get().n,0,'the lot gone: its row removed');
  assert.equal((require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8').match(/CREATE TABLE IF NOT EXISTS short_loan_warnings/g)??[]).length,1);
});
