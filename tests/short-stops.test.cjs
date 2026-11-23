// Short selling B3d-2: the cover stop (armed at the short's fill, reduced and closed with its lot), unprotected shorts,
// and the cover stop under orders-while-stopped. Fake engines; made-up codes, prices, quantities and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const SS=require('../electron/short-stops.cjs');
const LOT={symbol:'990010',quantity:5,loanDate:'2026-10-09',entryPrice:1000,source:'distribution'};
const cover=(extra={})=>({id:'C1',symbol:'990010',side:'Buy',quantity:5,purpose:'stop_loss',status:'armed',credit:{kind:'cover',loanDate:'2026-10-09',source:'distribution'},...extra});

test('the level: the entry raised by the stop percent, up to the grid; unreadable gives none',()=>{
  assert.equal(SS.coverStopLevel(1000,15),1150);assert.equal(SS.coverStopLevel(1003,15),1154,'1153.45 up to the grid');assert.equal(SS.coverStopLevel(19000,15),21850);
  for(const [e,p] of [[0,15],[null,15],[1000,0],[1000,101],['x',15]])assert.equal(SS.coverStopLevel(e,p),null,`${e} ${p}`);
});
test('which stops are reduced, raised or closed with their lot',()=>{
  assert.deepEqual(SS.lotChanges({shorts:[{...LOT,quantity:3}],deskOrders:[cover()]}).reduce.map(x=>x.quantity),[3]);assert.equal(SS.lotChanges({shorts:[],deskOrders:[cover()]}).close.length,1,'the lot is gone');
  assert.deepEqual(SS.lotChanges({shorts:[],deskOrders:[cover()],balanceKnown:false}),{reduce:[],close:[],raise:[]},'no balance: nothing changes');
  assert.equal(SS.lotChanges({shorts:[],deskOrders:[cover({side:'Sell',credit:null})]}).close.length,0,'only cover stops');
});
test('unprotected shorts: the last cover stop rejected or lapsed and not replaced',()=>{
  const rejected=cover({id:'C0',status:'rejected',closedAt:Date.parse('2026-10-10T01:00:00Z'),outcome:'refused'});
  assert.deepEqual(SS.unprotectedShorts({shorts:[LOT],rows:[rejected]}).map(u=>[u.symbol,u.short,u.quantity,u.orderId]),[['990010',true,5,'C0']]);
  assert.deepEqual(SS.unprotectedShorts({shorts:[LOT],rows:[cover(),rejected]}),[],'a live stop covers it');
  assert.equal(SS.unprotectedShorts({shorts:[LOT],rows:[cover({quantity:2}),rejected]})[0].partial,true);
  assert.deepEqual(SS.unprotectedShorts({shorts:[LOT],rows:[{...rejected,acknowledgedAt:1}]}),[],'dismissed');
  assert.equal(SS.unprotectedShorts({shorts:[LOT],rows:[cover({id:'C2',status:'submitted',closedAt:1})],lapsed:()=>true}).length,1,'sent, then lapsed at KIS');
  assert.deepEqual(SS.unprotectedShorts({shorts:[LOT],rows:[]}),[],'never had a stop: not this rule (the app arms one)');
});
function app({shorts=[LOT],orders=[],extra={}}={}){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const events=[];
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},(id,k,title,body)=>events.push({title,body}));
  const live={market:'KR',enabled:true,autoEnabled:true,severalOpen:false,identity:()=>'acct',riskBalance:{shorts,holdings:[]},getConnection:()=>({snapshot:{accountKey:'acct',environment:'mock',shorts,holdings:[]}}),orders:()=>orders,policy:()=>({day:'d'}),exposure:{policy:()=>({short:{stopLossPct:15}})},getState:()=>({}),...extra};
  a.live=live;a.usLive=null;a.configure({scope:'kis',conditionalOrders:true});a.marketQuotes=()=>[{symbol:'990010',price:1000,timestamp:Date.now()}];return {a,live,events};}
test('the app arms a cover stop when its short has filled and its lot shows; once; reduced and closed with the lot',()=>{
  const short={id:'S1',symbol:'990010',side:'Sell',credit:{kind:'short'},status:'Filled',filled:5,fillPrice:1000,lotLoanDate:'2026-10-09'};const {a,live,events}=app({orders:[short]});
  a.syncShortStops();let stops=a.desk.orders(a.watchScope());assert.equal(stops.length,1);
  assert.deepEqual({side:stops[0].side,quantity:stops[0].quantity,purpose:stops[0].purpose,credit:stops[0].credit,condition:stops[0].conditions[0]},{side:'Buy',quantity:5,purpose:'stop_loss',credit:{kind:'cover',loanDate:'2026-10-09',source:'distribution',account:'acct'},condition:{expr:'price("990010")',op:'>=',value:1150}});
  assert.ok(events.some(e=>e.title==='Cover stop armed'&&/at 1150\./.test(e.body)));a.syncShortStops();assert.equal(a.desk.orders(a.watchScope()).length,1,'once');
  live.riskBalance.shorts=[{...LOT,quantity:3}];a.syncShortStops();assert.equal(a.desk.orders(a.watchScope())[0].quantity,3,'reduced');
  live.riskBalance.shorts=[];a.syncShortStops();assert.equal(a.desk.orders(a.watchScope()).length,0,'closed');assert.ok(events.some(e=>e.title==='Cover stop closed'));
  const none=app({shorts:[{...LOT,entryPrice:null}],orders:[{...short,fillPrice:null}]});none.a.syncShortStops();assert.equal(none.a.desk.orders(none.a.watchScope()).length,0);assert.ok(none.events.some(e=>e.title==='Cover stop not armed'));
  const off=app({orders:[short]});off.a.configure({conditionalOrders:false});off.a.syncShortStops();assert.equal(off.a.desk.orders(off.a.watchScope()).length,0,'conditional orders off: none');
});
test('a cover stop held behind its own short sale: held, named as an unprotected short, given to the review, and kept armed by the fire',async()=>{
  const open={id:'S2',symbol:'990010',side:'Sell',credit:{kind:'short'},status:'Accepted',quantity:2,filled:0};const {a,live}=app({orders:[open],extra:{exposure:{policy:()=>({short:{enabled:true,stopLossPct:15}})}}});
  a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Buy',quantity:5,limitPrice:null,conditions:[{expr:'price("990010")',op:'>=',value:999}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'fixture',credit:{kind:'cover',loanDate:'2026-10-09',source:'distribution'}},{config:a.config,universe:['990010'],lot:{ok:true}});
  const stop=a.desk.orders(a.watchScope())[0];assert.equal(a.stopHeldNow(stop)?.why,'another order in Korea is open');
  const u=a.unprotectedNow(a.watchScope());assert.deepEqual(u.map(x=>[x.symbol,x.short,x.held,x.waiting]),[['990010',true,true,'another order in Korea is open']]);
  const [fact]=a.heldStopFacts();assert.equal(fact.short,true);assert.match(fact.fact,/^The cover stop for the short of 990010 was hit and is still armed; it is not sent while another order in Korea is open \(order S2, Sell 990010, Accepted\)\.$/);
  const {heldStopsLine}=await import('../src/unwatched-orders.mjs');assert.equal(heldStopsLine({desk:{unprotected:u}}),'990010 short has no working stop loss: its stop was hit and is waiting (another order in Korea is open).');
  live.context=async()=>{throw new Error('no account read while held');};await a.fireConditional(stop);const row=a.desk.rows('conditional_orders',a.watchScope()).find(x=>x.id===stop.id);assert.equal(row.status,'armed');assert.equal(row.waiting,'another order in Korea is open');
});
test('the cover stop under orders-while-stopped: watched while stopped, a closing order at the loss limit, halted by Stop everything',async()=>{
  const {a}=app();a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Buy',quantity:5,limitPrice:null,conditions:[{expr:'price("990010")',op:'>=',value:1150}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'fixture',credit:{kind:'cover',loanDate:'2026-10-09',source:'distribution'}},{config:a.config,universe:['990010'],lot:{ok:true}});
  a.connectedAccount=()=>({account:'acct',environment:'mock'});a.watchStopped.turnOn({account:'acct',environment:'mock'});assert.equal(a.autoTradingRuns(),false);assert.equal(a.watchingWhileStopped(),true);
  assert.deepEqual(a.watchedSymbols('KR'),['990010'],'watched while stopped');
  a.configure({lossAction:'stop'});a.emergencyState=()=>({active:true,activeMarkets:['KR']});const s=a.whileStoppedState();assert.deepEqual(s.lossLimit,{closing:1,buysWait:0},'a cover is a closing order at the loss limit');
  a.watchStopped.stopEverything();assert.equal(a.conditionalMonitoringActive(),false,'Stop everything halts it');assert.deepEqual(a.watchedSymbols('KR'),[]);
});
// B3d-2 review.
const SHORT_ORDER={id:'S1',symbol:'990010',side:'Sell',credit:{kind:'short'},status:'Filled',filled:5,fillPrice:1000,lotLoanDate:'2026-10-09'};
test('review 1: a rejected cover stop is not re-armed by the app; the short is listed as unprotected; an expired one is re-armed',()=>{
  const {a}=app({orders:[SHORT_ORDER]});a.syncShortStops();const [stop]=a.desk.orders(a.watchScope());a.desk.update(stop,{status:'rejected',outcome:'refused (fixture)',closedAt:Date.now()});
  a.syncShortStops();a.syncShortStops();assert.equal(a.desk.orders(a.watchScope()).length,0,'not re-armed');assert.equal(a.desk.rows('conditional_orders',a.watchScope()).length,1,'one row');
  assert.deepEqual(a.unprotectedNow(a.watchScope()).map(u=>[u.symbol,u.short,u.orderId]),[['990010',true,stop.id]]);
  const e=app({orders:[SHORT_ORDER]});e.a.syncShortStops();const [s2]=e.a.desk.orders(e.a.watchScope());e.a.desk.update(s2,{status:'expired',closedAt:Date.now()});e.a.syncShortStops();assert.equal(e.a.desk.orders(e.a.watchScope()).length,1,'expired: armed again');
});
test('review 2: only a stop_loss cover is the lot\'s stop; a take-profit cover does not suppress it',()=>{
  const {a}=app({orders:[SHORT_ORDER]});a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Buy',quantity:2,limitPrice:null,conditions:[{expr:'price("990010")',op:'<=',value:900}],combine:'all',purpose:'take_profit',expiresInHours:24,reason:'fixture',credit:{kind:'cover',loanDate:'2026-10-09',source:'distribution'}},{config:a.config,universe:['990010'],lot:{ok:true}});
  a.syncShortStops();const stops=a.desk.orders(a.watchScope()).filter(o=>o.purpose==='stop_loss');assert.equal(stops.length,1);assert.equal(stops[0].quantity,5,'for the lot\'s quantity');
});
test('review 3: the stop follows its lot up and down, with a line each way',()=>{
  const {a,live,events}=app({orders:[SHORT_ORDER]});a.syncShortStops();live.riskBalance.shorts=[{...LOT,quantity:8}];a.syncShortStops();assert.equal(a.desk.orders(a.watchScope())[0].quantity,8,'raised');assert.ok(events.some(e=>e.title==='Cover stop raised'));
  live.riskBalance.shorts=[{...LOT,quantity:4}];a.syncShortStops();assert.equal(a.desk.orders(a.watchScope())[0].quantity,4,'reduced');assert.ok(events.some(e=>e.title==='Cover stop reduced'));
});
test('review 4: with shorts disabled the review gains nothing and the Desk claims no review; enabled, the held cover stop is a fact',()=>{
  const open={id:'S2',symbol:'990010',side:'Sell',credit:{kind:'short'},status:'Accepted',quantity:2,filled:0};
  const make=enabled=>{const {a}=app({orders:[open],extra:{exposure:{policy:()=>({short:{enabled,stopLossPct:15}})}}});a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Buy',quantity:5,limitPrice:null,conditions:[{expr:'price("990010")',op:'>=',value:999}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'fixture',credit:{kind:'cover',loanDate:'2026-10-09',source:'distribution'}},{config:a.config,universe:['990010'],lot:{ok:true}});return a;};
  assert.deepEqual(make(false).heldStopFacts(),[],'disabled: nothing new for the review');assert.equal(make(true).heldStopFacts().length,1,'enabled: the fact');
  assert.match(require('fs').readFileSync(require('path').join(__dirname,'..','src','AgentDesk.tsx'),'utf8'),/\{u\.short\?'\.':'; the next review is asked to re-arm it or say why not\.'\}/,'no claim about a review for a short');
});
test('review 5: the app reduces and closes any armed cover with its lot, one the AI armed on a short you opened included',()=>{
  const {a,live}=app({orders:[]});a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Buy',quantity:5,limitPrice:null,conditions:[{expr:'price("990010")',op:'>=',value:1200}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'AI',credit:{kind:'cover',loanDate:'2026-10-09',source:'distribution'}},{config:a.config,universe:['990010'],lot:{ok:true}});
  live.riskBalance.shorts=[{...LOT,quantity:2}];a.syncShortStops();assert.equal(a.desk.orders(a.watchScope())[0].quantity,2,'you covered 3 by hand: reduced');
  live.riskBalance.shorts=[];a.syncShortStops();assert.equal(a.desk.orders(a.watchScope()).length,0,'covered in full: closed');
  assert.match(require('fs').readFileSync(require('path').join(__dirname,'..','artifacts','reviews','2026-11-24-short-selling','release-notes-draft.md'),'utf8'),/whoever armed it/);
});
test('review 6: the unprotected list reads the newest rows only',()=>{
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8');assert.match(src,/rows=\[\.\.\.this\.desk\.recentRows\('conditional_orders',scope\)\]/);assert.doesNotMatch(src,/rows=\[\.\.\.this\.desk\.rows\('conditional_orders',scope\)\]/);
  const {a}=app();for(let i=0;i<5;i++)a.desk.write('conditional_orders',{id:'X'+i,scope:a.watchScope(),status:'cancelled',symbol:'990010',side:'Buy',quantity:1});assert.equal(a.desk.recentRows('conditional_orders',a.watchScope(),3).length,3);
});
// B3d-2 second review: never neither.
test('review 2: the reviewer\'s four cases: armed again or listed, never neither',()=>{
  // The stop fired and covered 3 of 5: 2 left, armed for them.
  let w=app({orders:[SHORT_ORDER,{id:'P1',status:'Filled',filled:3}]});w.a.syncShortStops();let [stop]=w.a.desk.orders(w.a.watchScope());w.a.desk.update(stop,{status:'submitted',proposalId:'P1',closedAt:Date.now()});
  w.live.riskBalance.shorts=[{...LOT,quantity:2}];w.a.syncShortStops();assert.deepEqual(w.a.desk.orders(w.a.watchScope()).map(o=>o.quantity),[2],'armed for what is left');
  // The lot went to zero (closed as not needed) and came back with 4: armed.
  w=app({orders:[SHORT_ORDER]});w.a.syncShortStops();w.live.riskBalance.shorts=[];w.a.syncShortStops();assert.equal(w.a.desk.orders(w.a.watchScope()).length,0);
  w.live.riskBalance.shorts=[{...LOT,quantity:4}];w.a.syncShortStops();assert.deepEqual(w.a.desk.orders(w.a.watchScope()).map(o=>o.quantity),[4],'the lot is back');
  // You cancelled the stop: not re-armed, listed with that cause.
  w=app({orders:[SHORT_ORDER]});w.a.syncShortStops();[stop]=w.a.desk.orders(w.a.watchScope());w.a.desk.cancelOrder(w.a.watchScope(),stop.id);w.a.syncShortStops();
  assert.equal(w.a.desk.orders(w.a.watchScope()).length,0,'not re-armed');assert.deepEqual(w.a.unprotectedNow(w.a.watchScope()).map(u=>[u.symbol,u.cause,u.outcome]),[['990010','cancelled','you cancelled its cover stop']]);
  // A rejected stop behind 250 newer rows: still listed, not re-armed.
  w=app({orders:[SHORT_ORDER]});w.a.syncShortStops();[stop]=w.a.desk.orders(w.a.watchScope());w.a.desk.update(stop,{status:'rejected',outcome:'refused (fixture)',closedAt:Date.now()});
  for(let i=0;i<250;i++)w.a.desk.write('conditional_orders',{id:'N'+i,scope:w.a.watchScope(),status:'cancelled',symbol:'990020',side:'Sell',quantity:1,purpose:'stop_loss'});
  w.a.syncShortStops();assert.equal(w.a.desk.orders(w.a.watchScope()).length,0,'not re-armed');assert.deepEqual(w.a.unprotectedNow(w.a.watchScope()).map(u=>[u.symbol,u.cause]),[['990010','rejected']]);
});
test('review 2: over generated histories every app lot with shares left is armed, listed or covered: exactly one',()=>{
  const statuses=['armed','firing','expired','proposed','submitted','rejected','cancelled'],broker=['Ready','Accepted','Filled','Canceled','Rejected',null],by=['app','user','agent'];let seed=7;const rnd=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
  for(let i=0;i<5000;i++){const rows=Array.from({length:rnd(5)},(_,k)=>({id:'R'+k,side:'Buy',purpose:'stop_loss',credit:{kind:'cover',loanDate:'2026-10-09'},symbol:'990010',status:statuses[rnd(statuses.length)],closedBy:by[rnd(3)],outcome:'x'}));const st=broker[rnd(broker.length)],filled=rnd(3);
    const d=SS.lotDecision(rows,{brokerStatus:()=>st,brokerFilled:()=>filled});const kinds=['arm','list','covered'].filter(k=>d[k]);assert.equal(kinds.length,1,JSON.stringify({rows,st,filled,d}));
    const last=rows[0];if(!last)assert.ok(d.arm);else if(rows.some(r=>['armed','firing'].includes(r.status)))assert.ok(d.covered);
    else if(last.status==='rejected')assert.equal(d.list?.cause,'rejected');else if(last.status==='cancelled'&&last.closedBy!=='app')assert.equal(d.list?.cause,'cancelled');else if(last.status==='expired')assert.ok(d.arm);}
});
test('review 2: growth keeps the level, and the line says it',()=>{
  const {a,live,events}=app({orders:[SHORT_ORDER]});a.syncShortStops();live.riskBalance.shorts=[{...LOT,quantity:8}];a.syncShortStops();assert.ok(events.some(e=>e.title==='Cover stop raised'&&/its level stays at 1150\.$/.test(e.body)));
});
// B3d-2 third review.
test('review 3-1: a cover proposal waiting for your click is named as held; past its time it is armed again',()=>{
  const at={brokerStatus:()=>'Ready',brokerFilled:()=>0};const rows=[cover({status:'proposed',proposalId:'P9'})];
  assert.deepEqual(SS.lotDecision(rows,{...at,brokerExpired:()=>false}),{list:{cause:'approval',held:true,words:'its stop was hit and waits for your approval'}});
  assert.deepEqual(SS.lotDecision(rows,{...at,brokerExpired:()=>true}),{arm:'its proposal ended unapproved'});
  const proposal={id:'P9',status:'Ready',expiresAt:Date.now()+60000};const w=app({orders:[SHORT_ORDER,proposal]});w.a.desk.write('conditional_orders',{...cover({status:'proposed',proposalId:'P9',closedAt:Date.now()}),scope:w.a.watchScope()});
  w.a.syncShortStops();assert.equal(w.a.desk.orders(w.a.watchScope()).length,0,'not armed while it waits');const u=w.a.unprotectedNow(w.a.watchScope());assert.deepEqual(u.map(x=>[x.symbol,x.held,x.cause]),[['990010',true,'approval']]);
  proposal.expiresAt=Date.now()-1;w.a.syncShortStops();assert.equal(w.a.desk.orders(w.a.watchScope()).length,1,'past its time: armed again');
});
test('review 3-1: over generated histories with expiry, exactly one of arm, list or covered; a live proposal is never covered',()=>{
  const statuses=['armed','firing','expired','proposed','submitted','rejected','cancelled'],broker=['Ready','Accepted','Filled','Canceled','Rejected',null];let seed=11;const rnd=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
  for(let i=0;i<5000;i++){const rows=Array.from({length:rnd(5)},(_,k)=>({id:'R'+k,side:'Buy',purpose:'stop_loss',credit:{kind:'cover',loanDate:'2026-10-09'},symbol:'990010',status:statuses[rnd(statuses.length)],closedBy:['app','user','agent'][rnd(3)]}));const st=broker[rnd(broker.length)],expired=rnd(2)===1;
    const d=SS.lotDecision(rows,{brokerStatus:()=>st,brokerFilled:()=>rnd(3),brokerExpired:()=>expired});assert.equal(['arm','list','covered'].filter(k=>d[k]).length,1);
    const last=rows[0];if(last?.status==='proposed'&&!rows.some(r=>['armed','firing'].includes(r.status)))assert.ok(st==='Ready'&&!expired?d.list?.held:d.arm,JSON.stringify({st,expired,d}));}
});
test('review 3-2: during the balance lag after a cover filled the whole lot, no new stop is armed; a part fill arms for what is left',()=>{
  const at=Date.now()-30000;const filled={id:'P1',symbol:'990010',side:'Buy',credit:{kind:'cover',loanDate:'2026-10-09'},status:'Filled',quantity:5,filled:5,filledObservedAt:at,lotAtSend:5,lotAtSendAt:at-5000};
  const w=app({orders:[SHORT_ORDER,filled]});w.live.riskBalance.timestamp=new Date().toISOString();w.a.syncShortStops();assert.equal(w.a.desk.orders(w.a.watchScope()).length,0,'all 5 taken by the unshown fill: none armed');
  const p=app({orders:[SHORT_ORDER,{...filled,filled:3,quantity:3}]});p.live.riskBalance.timestamp=new Date().toISOString();p.a.syncShortStops();assert.deepEqual(p.a.desk.orders(p.a.watchScope()).map(o=>o.quantity),[2],'5 less the 3 not shown yet');
});
