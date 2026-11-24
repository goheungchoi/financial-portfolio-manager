// Short selling B3d-1: what a short passes before it is proposed and sent (still not executable: the path is switched on
// inside these tests only). Fake transport, fake engines; made-up codes, prices and figures.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const CP=require('../electron/credit-paths.cjs');const {Exposure}=require('../electron/exposure.cjs');
const credentials={environment:'live',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const reply=body=>new Response(JSON.stringify(body),{headers:{tr_cont:''}});
const on=async fn=>{const real=CP.pathStatus;CP.pathStatus=(kind,o)=>['short','cover'].includes(kind)?{executable:true,automatic:false}:real(kind,o);try{return await fn();}finally{CP.pathStatus=real;}};

test('the cap through the B3b rules: open obligations, open and lagging short orders; an amount that cannot be read refuses',()=>{
  const e=new Exposure(new DatabaseSync(':memory:'));e.savePolicy('a',{short:{enabled:true,auto:true,maxGrossPctOfEquity:20}});
  const base={account:'a',kind:'short',symbol:'990010',equity:10_000_000,balance:{shorts:[{symbol:'990020',loanAmount:1_000_000}]}};
  assert.equal(e.checkCredit({...base,notional:1_000_000}).type,'22','20% exactly');assert.throws(()=>e.checkCredit({...base,notional:1_000_001}),/SHORT_LIMIT/);
  assert.throws(()=>e.checkCredit({...base,notional:600_000,pending:[{credit:'short',notional:500_000}]}),/SHORT_LIMIT/,'an open short order counts');
  assert.throws(()=>e.checkCredit({...base,notional:600_000,lagging:[{notional:500_000}]}),/SHORT_LIMIT/,'a filled short the balance does not show yet counts');
  assert.throws(()=>e.checkCredit({...base,notional:1,balance:{shorts:[{symbol:'990020'}]}}),/SHORT_CAP_UNKNOWN/,'an open short with no obligation');
  assert.throws(()=>e.checkCredit({...base,notional:1,equity:0}),/SHORT_CAP_UNKNOWN/,'no account value');
  assert.equal(e.checkCredit({...base,notional:1,pending:[{credit:'margin-buy',notional:9e9}]}).type,'22','other credit kinds do not count');
});
function engine({instrument={market:'KOSPI',type:'stock'},session='regular',noMaster=false}={}){const {LiveEngine}=require('../electron/live-engine.cjs');const db=new DatabaseSync(':memory:');
  const snapshot={accountKey:'acct',environment:'live',reportedTotal:10_000_000,cash:10_000_000,holdings:[],shorts:[]};const e=new LiveEngine(db,{request:async()=>({})},()=>({status:'connected',snapshot}));
  e.exposure=new Exposure(db);e.exposure.savePolicy('acct',{short:{enabled:true,auto:true,maxGrossPctOfEquity:20}});e.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');
  e.instrumentOf=noMaster?undefined:()=>instrument;e.shortSession=()=>session;e.netEquityOf=()=>({low:10_000_000,high:10_000_000});return e;}
const SHORT={symbol:'990010',side:'Sell',quantity:2,limitPrice:1001,credit:{kind:'short'}};
test('the engine: a KOSPI or KOSDAQ stock from the master, in the regular session or the opening auction; its market is the master\'s',async()=>{
  await on(async()=>{
    const ok=engine().propose(SHORT);assert.equal(ok.credit.kind,'short');assert.equal(ok.credit.market,'KOSPI','from the master');
    assert.equal(engine({session:'auction'}).propose(SHORT).credit.market,'KOSPI');assert.equal(engine({instrument:{market:'KOSDAQ',type:'stock'}}).propose(SHORT).credit.market,'KOSDAQ');
    const etf=(()=>{try{engine({instrument:{market:'KOSPI',type:'etf'}}).propose(SHORT);}catch(x){return x;}})();assert.equal(etf.message,'SHORT_ETF_NOT_ENABLED');assert.equal(etf.detail,'ETF short sales are not yet enabled.');
    assert.throws(()=>engine({instrument:null}).propose(SHORT),/SHORT_MARKET_UNSUPPORTED/,'not in the master');assert.throws(()=>engine({noMaster:true}).propose(SHORT),/SHORT_MARKET_UNSUPPORTED/,'no master');
    assert.throws(()=>engine({instrument:{market:'KOSPI',type:'other'}}).propose(SHORT),/SHORT_INSTRUMENT_UNKNOWN/);assert.throws(()=>engine({instrument:{market:'KONEX',type:'stock'}}).propose(SHORT),/SHORT_MARKET_UNSUPPORTED/);
    assert.throws(()=>engine().propose({...SHORT,credit:{kind:'short',market:'KOSDAQ'}}),/INVALID_ORDER/,'a market that is not the master\'s');
    for(const s of ['other','closing','nxt'])assert.throws(()=>engine({session:s}).propose(SHORT),/SHORT_SESSION_CLOSED/,String(s));
    const none=engine();none.shortSession=()=>undefined;assert.throws(()=>none.propose(SHORT),/SHORT_SESSION_CLOSED/,'no session given');const thrower=engine();thrower.shortSession=()=>{throw new Error('calendar');};assert.throws(()=>thrower.propose(SHORT),/SHORT_SESSION_CLOSED/);
  });
  assert.throws(()=>engine().propose(SHORT),/CREDIT_PATH_UNVERIFIED/,'with the path off: refused as before');
  const main=require('fs').readFileSync(require('path').join(__dirname,'..','electron','main.cjs'),'utf8');assert.match(main,/live\.instrumentOf=symbol=>\{const row=master\.get\(symbol\);return row\?\{market:row\.market,type:row\.type\}:null;\};live\.shortSession=/);
});
function korea({price='1000',shorts=[],psbl={nrcvb_buy_amt:'100000',nrcvb_buy_qty:'100'}}={}){const calls=[];const c=new KisReadOnlyClient(credentials,async url=>{calls.push(url);if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});
    if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:price,aspr_unit:'1',temp_stop_yn:'N'}});if(url.includes('inquire-psbl-order'))return reply({rt_cd:'0',output:psbl});
    if(url.includes('lendable-by-company'))return reply({rt_cd:'0',output1:[{pdno:'990010',psbl_yn:'Y',trad_psbl_qty2:'50'}],output2:{}});throw new Error('Unexpected '+url);},async()=>{});
  c.checkSession=async()=>({open:true});c.getBalance=async()=>({accountKey:'f',reportedTotal:10000,holdings:[{symbol:'990010',quantity:7,availableQuantity:5}],shorts});c.getActivity=async()=>({orders:[]});return {c,calls};}
test('the send: a short\'s price at or above the uptick floor from the price read then',async()=>{
  await on(async()=>{
    const ok=await korea().c.prepareOrder({...SHORT,limitPrice:1001,credit:{kind:'short',type:'22',market:'KOSPI'}});assert.equal(ok.capacityRaw.tr,'CTSC2702R');
    await assert.rejects(korea().c.prepareOrder({...SHORT,limitPrice:1000,credit:{kind:'short',type:'22',market:'KOSPI'}}),/SHORT_BELOW_UPTICK/,'at the last trade: refused');
    await assert.rejects(korea({price:'1004'}).c.prepareOrder({...SHORT,limitPrice:1001,credit:{kind:'short',type:'22',market:'KOSPI'}}),/SHORT_BELOW_UPTICK/,'the price rose past it');
  });
});
test('a cash buy while a short is open: KIS\'s orderable cash unreadable makes it wait; with no short exactly as before',async()=>{
  const BUY={symbol:'990010',side:'Buy',quantity:2,limitPrice:1000};
  await assert.rejects(korea({psbl:{}}).c.prepareOrder(BUY),/INVALID_RESPONSE/,'no short: as before');
  await assert.rejects(korea({psbl:{},shorts:[{symbol:'990020',quantity:1,loanAmount:5000}]}).c.prepareOrder(BUY),/SHORT_OPEN_CASH_UNKNOWN/);
  const fine=await korea({shorts:[{symbol:'990020',quantity:1,loanAmount:5000}]}).c.prepareOrder(BUY);assert.equal(fine.capacityRaw.tr,'TTTC8908R','readable: the usual check, KIS\'s figure');
  await assert.rejects(korea({psbl:{nrcvb_buy_amt:'1000',nrcvb_buy_qty:'1'},shorts:[{symbol:'990020',quantity:1,loanAmount:5000}]}).c.prepareOrder(BUY),/INSUFFICIENT_CAPACITY/,'the lower figure (KIS\'s) applies');
  assert.equal(require('../electron/worker-codes.cjs').relayCode('prepare-order',{code:'SHORT_OPEN_CASH_UNKNOWN'}),'SHORT_OPEN_CASH_UNKNOWN');
  assert.equal(require('../electron/activity-today.cjs').NOT_SENT.SHORT_OPEN_CASH_UNKNOWN,'a short is open and KIS\'s orderable cash could not be read, so buys wait');
});
test('a conditional buy refused because KIS\'s orderable cash could not be read while a short is open waits, armed',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const store=new Map();const events=[];
  const live={market:'KR',enabled:true,autoEnabled:true,identity:()=>'acct',getState:()=>({}),orders:()=>[...store.values()],context:async()=>({market:'KR',equity:1e7,cash:5e6,positions:{},quotes:[{symbol:'990010',price:1000,timestamp:Date.now()}],marketSession:{open:true}}),
    propose:c=>{const o={id:'P'+(store.size+1),status:'Ready',...c};store.set(o.id,o);return o;},annotate:(id,p)=>store.set(id,{...store.get(id),...p}),autoSubmit:async()=>{throw new Error('SHORT_OPEN_CASH_UNKNOWN');}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},(id,k,title,body)=>events.push({title,body}));a.live=live;a.usLive=null;
  a.configure({scope:'kis',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});a.placementPrice=async()=>({price:1000});a.emergencyState=()=>({active:false});a.marketQuotes=()=>[{symbol:'990010',price:1000,timestamp:Date.now()}];
  const r=a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Buy',quantity:1,limitPrice:null,conditions:[{expr:'price("990010")',op:'>=',value:999}],combine:'all',purpose:'entry',expiresInHours:2,reason:'fixture'},{config:a.config,universe:['990010']});
  await a.fireConditional(a.desk.orders(a.watchScope()).find(x=>x.id===r.id));const o=a.desk.rows('conditional_orders',a.watchScope()).find(x=>x.id===r.id);
  assert.equal(o.status,'armed');assert.equal(o.waiting,"a short is open and KIS's orderable cash could not be read");assert.equal(events.filter(e=>e.title==='Conditional order · waiting').length,1);
});
test('a review\'s short is placed at its placement price raised to the uptick floor from the polled last trade',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},()=>{});
  a.krShortSession=()=>'regular';a.marketQuotes=()=>[{symbol:'990010',price:1000,timestamp:Date.now()-1000}];assert.equal(a.shortLimit('990010',990),1001,'the best bid below the floor');assert.equal(a.shortLimit('990010',1010),1010);
  a.marketQuotes=()=>[{symbol:'990010',price:1000,timestamp:Date.now()-61000}];assert.equal(a.shortLimit('990010',990),990,'no fresh last trade: the placement price (the send checks it)');
  a.krShortSession=()=>'other';a.marketQuotes=()=>[{symbol:'990010',price:1000,timestamp:Date.now()}];assert.equal(a.shortLimit('990010',990),990);
  assert.match(require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8'),/limitPrice:d\.credit==='short'\?this\.shortLimit\(d\.symbol,placement\.price\):placement\.price/);
});
test('Home names buys waiting for KIS\'s orderable cash while a short is open',async()=>{
  const {shortCashWaitLine}=await import('../src/unwatched-orders.mjs');
  assert.equal(shortCashWaitLine({desk:{orders:[{waiting:"a short is open and KIS's orderable cash could not be read"},{waiting:null}]}}),"Buys wait: a short is open and KIS's orderable cash could not be read (1 order).");
  assert.equal(shortCashWaitLine({desk:{orders:[{waiting:'market closed'}]}}),null);
});
test('which buys the orderable-cash wait holds: the app\'s own buys; your ticket keeps 1.5.73\'s check and codes with a short open, and carries the fact',async()=>{
  const BUY={symbol:'990010',side:'Buy',quantity:2,limitPrice:1000},short=[{symbol:'990020',quantity:1,loanAmount:5000}];
  const outcome=async(opts)=>{try{const r=await korea(opts).c.prepareOrder({...BUY,yours:true});return {ok:true,availableQuantity:r.availableQuantity};}catch(e){return {ok:false,code:e.message};}};
  for(const psbl of [{},{nrcvb_buy_amt:'1000',nrcvb_buy_qty:'1'},{nrcvb_buy_amt:'100000',nrcvb_buy_qty:'100'}])
    assert.deepEqual(await outcome({psbl,shorts:short}),await outcome({psbl}),'your ticket, short open = no short: '+JSON.stringify(psbl));
  assert.deepEqual(await outcome({psbl:{}}),{ok:false,code:'INVALID_RESPONSE'});assert.deepEqual(await outcome({psbl:{nrcvb_buy_amt:'1000',nrcvb_buy_qty:'1'}}),{ok:false,code:'INSUFFICIENT_CAPACITY'});
  assert.deepEqual((await korea({shorts:short}).c.prepareOrder({...BUY,yours:true})).shortCash,{orderableCash:100000},'the fact for its screen');assert.equal((await korea().c.prepareOrder({...BUY,yours:true})).shortCash,undefined,'no short: no fact');
  await assert.rejects(korea({psbl:{},shorts:short}).c.prepareOrder(BUY),/SHORT_OPEN_CASH_UNKNOWN/,'a review or conditional buy (and your approval of one) waits');
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','live-engine.cjs'),'utf8');assert.match(src,/\.\.\.\(order\.madeBy==='ticket'\?\{yours:true\}:\{\}\)/);assert.match(src,/shortCashFact:Number\.isFinite\(prepared\.shortCash\.orderableCash\)\?`a short is open; KIS's orderable cash is \$\{/);
});
test('review 3 and the ranged value: open short orders always count; the base is the valuation\'s low bound, never KIS\'s total',async()=>{
  await on(async()=>{
    const e=engine();assert.equal(e.severalOpen,false);const first=e.propose({...SHORT,quantity:1000,limitPrice:1001});assert.ok(first.id,'1,001,000 of 2,000,000');
    assert.throws(()=>e.propose({...SHORT,quantity:1000,limitPrice:1001}),/SHORT_LIMIT/,'the first, still open, counts with several-open off');
    const r=engine();r.netEquityOf=()=>({low:8_000_000,high:12_000_000});assert.ok(r.propose({...SHORT,quantity:1500,limitPrice:1001}).id,'1,501,500 under 20% of 8,000,000');
    assert.throws(()=>r.propose({...SHORT,quantity:100,limitPrice:1001}),/SHORT_LIMIT/,'the low bound: 1,601,600 is over 1,600,000');
    const u=engine();u.netEquityOf=()=>({unavailable:true});assert.throws(()=>u.propose(SHORT),/SHORT_CAP_UNKNOWN/,'no valuation: not KIS\'s total');
    const n=engine();n.netEquityOf=undefined;assert.throws(()=>n.propose(SHORT),/SHORT_CAP_UNKNOWN/);
  });
});
test('review 4: in the opening auction with no previous close a short is not priced or sent; it waits for the regular session',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},()=>{});
  a.krShortSession=()=>'auction';a.marketQuotes=()=>[{symbol:'990010',price:1000,timestamp:Date.now()}];const e=(()=>{try{a.shortLimit('990010',990);}catch(x){return x;}})();
  assert.equal(e?.message,'SHORT_AUCTION_NO_CLOSE');assert.match(e.detail,/waits for the regular session/);
  a.marketQuotes=()=>[{symbol:'990010',price:1000,previousClose:995,timestamp:Date.now()}];assert.equal(a.shortLimit('990010',990),996,'with the previous close: above it');
  assert.ok(require('../electron/order-outcomes.cjs').ORDER.has('SHORT_AUCTION_NO_CLOSE'));assert.ok(require('../electron/activity-today.cjs').NOT_SENT.SHORT_AUCTION_NO_CLOSE);
});
test('review 2: a conditional buy waiting on KIS\'s orderable cash re-checks at most every 5 minutes, with no pricing, proposal or line between; one line per episode',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');const store=new Map();const events=[];let priced=0,proposed=0,sends=0;
  const live={market:'KR',enabled:true,autoEnabled:true,identity:()=>'acct',getState:()=>({}),riskBalance:{shorts:[{symbol:'990020',quantity:1,loanAmount:5000}]},orders:()=>[...store.values()],
    context:async()=>({market:'KR',equity:1e7,cash:5e6,positions:{},quotes:[{symbol:'990010',price:1000,timestamp:Date.now()}],marketSession:{open:true}}),
    propose:c=>{proposed++;const o={id:'P'+(store.size+1),status:'Ready',...c};store.set(o.id,o);return o;},annotate:(id,p)=>store.set(id,{...store.get(id),...p}),autoSubmit:async()=>{sends++;throw new Error('SHORT_OPEN_CASH_UNKNOWN');}};
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},(id,k,title,body)=>events.push({title,body}));a.live=live;a.usLive=null;
  a.configure({scope:'kis',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});a.orderBook=async()=>{priced++;return {status:'available',retrievedAt:Date.now(),data:{bid:999,ask:1000}};};a.emergencyState=()=>({active:false});a.marketQuotes=()=>[{symbol:'990010',price:1000,timestamp:Date.now()}];
  const r=a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Buy',quantity:1,limitPrice:null,conditions:[{expr:'price("990010")',op:'>=',value:999}],combine:'all',purpose:'entry',expiresInHours:2,reason:'fixture'},{config:a.config,universe:['990010']});
  const row=()=>a.desk.rows('conditional_orders',a.watchScope()).find(x=>x.id===r.id);await a.fireConditional(row());
  assert.equal(row().waiting,"a short is open and KIS's orderable cash could not be read");assert.ok(row().nextCheckAt>=Date.now()+299000,'5 minutes');assert.deepEqual([proposed,sends],[1,1]);
  for(let i=0;i<3;i++)await a.fireConditional(row());assert.deepEqual([proposed,sends,priced],[1,1,1],'checks within the 5 minutes: no pricing, proposal or send');
  assert.equal(events.filter(e=>e.title==='Conditional order · waiting').length,1,'one line');assert.equal(events.filter(e=>e.title==='Order priced').length,1,'only the first attempt priced it');
  a.shortCashWait.KR.at=Date.now()-301000;await a.fireConditional(row());assert.deepEqual([proposed,sends],[2,2],'after 5 minutes: one attempt');assert.equal(events.filter(e=>e.title==='Order priced').length,1,'no priced line while waiting');assert.equal(events.filter(e=>e.title==='Conditional order · waiting').length,1);
  live.riskBalance={shorts:[]};a.shortCashWait.KR.at=Date.now();live.autoSubmit=async id=>{sends++;const o={...store.get(id),status:'Accepted'};store.set(id,o);return o;};await a.fireConditional(row());assert.equal(row().status,'submitted','no short open: no wait');
});
test('B3d-1 final: each open short order counts once in both several-open modes; the wait is per account and market',async()=>{
  const e=new Exposure(new DatabaseSync(':memory:'));e.savePolicy('a',{short:{enabled:true,auto:true,maxGrossPctOfEquity:20}});const base={account:'a',kind:'short',symbol:'990010',equity:10_000_000,balance:{shorts:[]}};
  // Several-open on: the app's open short is both in openShorts and (without an id) in pending: counted once.
  assert.equal(e.checkCredit({...base,notional:500_000,openShorts:[{id:'S1',notional:1_500_000}],pending:[{credit:'short',notional:1_500_000}]}).type,'22','1,500,000 + 500,000 = 20%');
  assert.throws(()=>e.checkCredit({...base,notional:500_001,openShorts:[{id:'S1',notional:1_500_000}],pending:[{credit:'short',notional:1_500_000}]}),/SHORT_LIMIT/);
  // Several-open off: pending is empty; the same boundary.
  assert.equal(e.checkCredit({...base,notional:500_000,openShorts:[{id:'S1',notional:1_500_000}]}).type,'22');assert.throws(()=>e.checkCredit({...base,notional:500_001,openShorts:[{id:'S1',notional:1_500_000}]}),/SHORT_LIMIT/);
  // A short order you made outside the app (pending, yours) counts too.
  assert.throws(()=>e.checkCredit({...base,notional:500_000,openShorts:[{id:'S1',notional:1_500_000}],pending:[{credit:'short',notional:1,yours:true}]}),/SHORT_LIMIT/);
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8');
  assert.match(src,/\(this\.shortCashWait\?\?=\{\}\)\[market\]=\{account:who,at:Date\.now\(\)\}/);assert.match(src,/if\(w0&&w0\.account!==who\)delete this\[key\]\[market\]/,'another account: the wait ends');assert.match(src,/\[\['shortCashWait',SHORT_CASH_WAIT\],\['shortfallWait',SHORTFALL_WAIT\]\]/);
});
