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
  a.configure({lossAction:'stop'});a.emergencyState=()=>({active:true,activeMarkets:['KR']});const s=a.whileStoppedState();assert.deepEqual(s.lossLimit,{closing:1,covers:1,buysWait:0},'a cover is a closing order at the loss limit, named as a cover (B3f-1)');assert.equal(s.buys,0,'not a buy');assert.equal(s.covers,1);
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
// The short's trail (short.trailingStop, off by default).
test('the trail rule: the low and the level, which only moves down',()=>{
  assert.deepEqual(SS.trailStep({low:1000,price:900,level:1150,pct:15}),{low:900,level:1035,moved:true});
  assert.deepEqual(SS.trailStep({low:900,price:950,level:1035,pct:15}),{low:900,level:1035,moved:false},'the price rose: the level stays');
  assert.deepEqual(SS.trailStep({low:900,price:900,level:1035,pct:15}),{low:900,level:1035,moved:false});assert.equal(SS.trailStep({low:900,price:0,level:1035,pct:15}),null);
});
test('the short\'s trail: off by default; on, the app\'s stop follows two confirming fresh quotes, only down; one bad print moves nothing; at most a line per 10 minutes; the AI\'s cover on a hand short is not trailed',()=>{
  const trailWorld=(on,orders=[SHORT_ORDER])=>{const w=app({orders,extra:{exposure:{policy:()=>({short:{enabled:true,stopLossPct:15,trailingStop:on}})}}});w.a.syncShortStops();w.a.krShortSession=()=>'regular';return w;};
  let t=Date.now()-15000;const quote=(w,p,{age=0}={})=>{t+=500;const at=Date.now()-age;w.a.watchQuotes=()=>[{symbol:'990010',price:p,timestamp:Math.min(t,at)}];w.a.trackShortTrails();return w.a.desk.orders(w.a.watchScope())[0].conditions[0].value;};
  assert.equal(new (require('../electron/exposure.cjs').Exposure)(new DatabaseSync(':memory:')).policy('x').short.trailingStop,false,'off by default');
  const off=trailWorld(false);quote(off,900);assert.equal(quote(off,900),1150,'off: unchanged');
  const on=trailWorld(true);assert.equal(on.a.desk.orders(on.a.watchScope())[0].armedBy,'app');
  // One bad print: 700 once between 1000s moves nothing.
  quote(on,1000);quote(on,700);assert.equal(quote(on,1000),1150,'one print at 700: the higher of each pair is 1000');
  // Two confirming lower quotes: the low is the higher of the two.
  quote(on,900);assert.equal(quote(on,905),1041,'905 and 900: low 905, level 1041');assert.equal(quote(on,950),1041,'a rise: unchanged');
  quote(on,800);assert.equal(quote(on,800),920,'a new low of 800: 920');
  assert.equal(on.events.filter(e=>e.title==='Cover stop trailed').length,1,'two moves within 10 minutes: one line');
  assert.equal(quote(on,600,{age:61000}),920,'a stale quote: no move');assert.equal(quote(on,600,{age:61000}),920);on.a.krShortSession=()=>'other';quote(on,600);assert.equal(quote(on,600),920,'outside the regular session: no move');
  // The AI's cover stop on a short you opened: not trailed.
  const hand=trailWorld(true,[]);hand.a.desk.setOrder(hand.a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Buy',quantity:5,limitPrice:null,conditions:[{expr:'price("990010")',op:'>=',value:1150}],combine:'all',purpose:'stop_loss',expiresInHours:24,reason:'AI',credit:{kind:'cover',loanDate:'2026-10-09',source:'distribution'}},{config:hand.a.config,universe:['990010'],lot:{ok:true}});
  quote(hand,800);assert.equal(quote(hand,800),1150,'not the app\'s stop: not trailed');
});
test('the short\'s trail: a stop re-armed for the same lot after a partial fill keeps the trail it had reached',()=>{
  const w=app({orders:[SHORT_ORDER,{id:'P1',status:'Filled',filled:3}],extra:{exposure:{policy:()=>({short:{enabled:true,stopLossPct:15,trailingStop:true}})}}});w.a.syncShortStops();w.a.krShortSession=()=>'regular';
  let t=Date.now()-15000;const q=p=>{t+=500;w.a.watchQuotes=()=>[{symbol:'990010',price:p,timestamp:t}];w.a.trackShortTrails();};q(800);q(800);
  const [stop]=w.a.desk.orders(w.a.watchScope());assert.equal(stop.conditions[0].value,920);w.a.desk.update(stop,{status:'submitted',proposalId:'P1',closedAt:Date.now()});
  w.live.riskBalance.shorts=[{...LOT,quantity:2}];w.a.syncShortStops();const [again]=w.a.desk.orders(w.a.watchScope());assert.deepEqual([again.quantity,again.conditions[0].value,again.shortTrail?.low,again.armedBy],[2,920,800,'app'],'armed for 2 at the trailed level');
  assert.ok(w.events.some(e=>e.title==='Cover stop armed'&&/at 920 \(its trail kept\)\./.test(e.body)));
});
test('the trail is carried only from the lot\'s own partly filled stop; a new short on the same loan date starts fresh; a freshly armed stop is never at or below the entry',()=>{
  const w=app({orders:[SHORT_ORDER,{id:'P1',status:'Filled',filled:5}],extra:{exposure:{policy:()=>({short:{enabled:true,stopLossPct:15,trailingStop:true}})}}});w.a.syncShortStops();w.a.krShortSession=()=>'regular';
  let t=Date.now()-15000;const q=p=>{t+=500;w.a.watchQuotes=()=>[{symbol:'990010',price:p,timestamp:t}];w.a.trackShortTrails();};q(700);q(700);
  const [stop]=w.a.desk.orders(w.a.watchScope());assert.equal(stop.conditions[0].value,805);
  // The whole lot covered by the stop: the lot goes to zero (the sync closes nothing armed), then a new short on that loan date at 900.
  w.a.desk.update(stop,{status:'submitted',proposalId:'P1',closedAt:Date.now()});w.live.riskBalance.shorts=[];w.a.syncShortStops();
  w.a.desk.write('conditional_orders',{id:'Z',scope:w.a.watchScope(),status:'cancelled',closedBy:'app',symbol:'990010',side:'Buy',quantity:5,purpose:'stop_loss',credit:{kind:'cover',loanDate:'2026-10-09'}});
  w.live.riskBalance.shorts=[{...LOT,quantity:4,entryPrice:900}];w.a.syncShortStops();const [fresh]=w.a.desk.orders(w.a.watchScope());assert.equal(fresh.conditions[0].value,1035,'fresh from its own entry 900, not 805');assert.equal(fresh.shortTrail,undefined);
  // Property: a stop armed fresh (the lot's newest stop closed by the app, the lot gone and back) is above its own entry.
  for(const [entry,carried] of [[900,805],[900,900],[900,1000],[1000,1100],[20000,19000]]){const x=app({orders:[{...SHORT_ORDER},{id:'P1',status:'Filled',filled:1}],extra:{exposure:{policy:()=>({short:{enabled:true,stopLossPct:15,trailingStop:true}})}}});
    x.a.desk.write('conditional_orders',{id:'OLD',scope:x.a.watchScope(),status:'cancelled',closedBy:'app',armedBy:'app',shortTrail:{low:carried/1.15},proposalId:'P1',symbol:'990010',side:'Buy',quantity:5,purpose:'stop_loss',credit:{kind:'cover',loanDate:'2026-10-09'},conditions:[{expr:'price("990010")',op:'>=',value:carried}]});
    x.live.riskBalance.shorts=[{...LOT,quantity:4,entryPrice:entry}];x.a.syncShortStops();const [s]=x.a.desk.orders(x.a.watchScope());assert.ok(s.conditions[0].value>entry,`entry ${entry}, carried ${carried}: ${s.conditions[0].value}`);}
});
test('distinct quotes are judged exactly as the long trail does: by the quote\'s own time stamp (timestamp, else retrievedAt)',()=>{
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8');assert.match(src,/const stamp=require\('\.\/trailing-stops\.cjs'\)\.stamp\(q\),prev=this\.shortTrailSeen\.get\(o\.id\);/);
  const T=require('../electron/trailing-stops.cjs');assert.equal(T.stamp({timestamp:5,retrievedAt:9}),5);assert.equal(T.stamp({retrievedAt:9}),9);
});
