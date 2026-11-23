// Short selling B3c: the order path, still not executable (the short and cover paths stay executable:false). The request
// fields are shown by switching the path on inside this test only. Fake transport and fake engines; made-up codes, prices,
// quantities and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const fs=require('fs'),path=require('path');const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const CP=require('../electron/credit-paths.cjs');const R=require('../electron/short-rules.cjs');
const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const reply=body=>new Response(JSON.stringify(body),{headers:{tr_cont:''}});
function client(answer){const calls=[];const c=new KisReadOnlyClient(credentials,async(url,options)=>{calls.push({url,options});if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});return reply(answer(url,options));},async()=>{});return {c,calls};}
const executable=async fn=>{const real=CP.pathStatus;CP.pathStatus=kind=>['short','cover'].includes(kind)?{executable:true,automatic:false}:real(kind);try{return await fn();}finally{CP.pathStatus=real;}};

test('the order request: a short (22) sends KRX and the loan date by the one rule; a cover (26) its lot\'s loan date',async()=>{
  const {c,calls}=client(()=>({rt_cd:'0',output:{ODNO:'0000123',KRX_FWDG_ORD_ORGNO:'00950'}}));const {seoulDate}=require('../electron/kis-activity.cjs');
  await executable(()=>c.placeCreditOrder({symbol:'990010',side:'Sell',quantity:2,limitPrice:1001,credit:{kind:'short',type:'22',market:'KOSPI'}}));
  const short=JSON.parse(calls.find(x=>x.url.includes('order-credit')).options.body);
  assert.deepEqual({CRDT_TYPE:short.CRDT_TYPE,LOAN_DT:short.LOAN_DT,EXCG_ID_DVSN_CD:short.EXCG_ID_DVSN_CD,ORD_DVSN:short.ORD_DVSN,ORD_QTY:short.ORD_QTY,ORD_UNPR:short.ORD_UNPR},{CRDT_TYPE:'22',LOAN_DT:seoulDate().replaceAll('-',''),EXCG_ID_DVSN_CD:'KRX',ORD_DVSN:'00',ORD_QTY:'2',ORD_UNPR:'1001'});
  assert.equal(calls.find(x=>x.url.includes('order-credit')).options.headers.tr_id,'TTTC0051U');
  const k=client(()=>({rt_cd:'0',output:{ODNO:'0000124'}}));await executable(()=>k.c.placeCreditOrder({symbol:'990010',side:'Buy',quantity:2,limitPrice:1100,credit:{kind:'cover',type:'26',loanDate:'2026-10-07'}}));
  const cover=JSON.parse(k.calls.find(x=>x.url.includes('order-credit')).options.body);assert.deepEqual([cover.CRDT_TYPE,cover.LOAN_DT,cover.EXCG_ID_DVSN_CD],['26','20261007','KRX']);assert.equal(k.calls.find(x=>x.url.includes('order-credit')).options.headers.tr_id,'TTTC0052U');
});
test('still not executable: no request leaves the app for a short or a cover',async()=>{
  for(const kind of ['short','cover']){const {c,calls}=client(()=>({rt_cd:'0'}));await assert.rejects(c.placeCreditOrder({symbol:'990010',side:kind==='short'?'Sell':'Buy',quantity:1,limitPrice:1001,credit:{kind,type:kind==='short'?'22':'26',loanDate:'2026-10-07',market:'KOSPI'}}),/CREDIT_PATH_UNVERIFIED/);assert.equal(calls.length,0,kind);}
});
test('the loan date of a new short: the trade day (the rule now) or T+2 Korean business days; B4 picks one',()=>{
  assert.equal(R.SHORT_LOAN_DATE_RULE,'trade-day');assert.equal(R.shortLoanDate('2026-10-09'),'2026-10-09');
  assert.equal(R.shortLoanDate('2026-10-09','settlement'),'2026-10-13','a Friday: Monday and Tuesday');
  assert.equal(R.shortLoanDate('2026-10-09','settlement',d=>d==='2026-10-12'?false:null),'2026-10-14','a closed Monday is skipped');
  assert.throws(()=>R.shortLoanDate('20261009'),/INVALID_DATE/);assert.throws(()=>R.shortLoanDate('2026-10-09','other'),/INVALID_RULE/);
});
test('the lending read: one stock, its market\'s code; a stock not listed is not lendable now',async()=>{
  const {c,calls}=client(url=>({rt_cd:'0',output1:new URL(url).searchParams.get('PDNO')==='990030'?[{pdno:'990030',psbl_yn:'Y',trad_psbl_qty2:'40',lmt_qty1:'40',use_qty1:'0'}]:[],output2:{}}));
  const read=await c.getLendable('990030','KOSDAQ');const p=new URL(calls.find(x=>x.url.includes('lendable-by-company')).url).searchParams;
  assert.deepEqual([p.get('EXCG_DVSN_CD'),p.get('PDNO'),p.get('THCO_STLN_PSBL_YN'),p.get('INQR_DVSN_1')],['03','990030','Y','1']);assert.equal(calls.find(x=>x.url.includes('lendable-by-company')).options.headers.tr_id,'CTSC2702R');
  assert.deepEqual({...read,at:0},{symbol:'990030',exchange:'03',open:true,tradable:40,limit:40,used:0,at:0});
  const none=await c.getLendable('990040','KOSPI');assert.equal(none.open,false);assert.equal(R.borrowable(none,1,Date.now(),{symbol:'990040',market:'KOSPI'}).code,'SHORT_NOT_LENDABLE');
  await assert.rejects(c.getLendable('990030','KONEX'),/SHORT_MARKET_UNSUPPORTED/);
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','kis-client.cjs'),'utf8');assert.match(src,/if\(kind==='short'\)\{const R=require\('\.\/short-rules\.cjs'\);const read=await this\.getLendable\(command\.symbol,command\.credit\.market\)/,'the preparation reads it');
  const W=require('../electron/worker-codes.cjs');for(const code of ['SHORT_NOT_LENDABLE','SHORT_BORROW_SHORT','SHORT_BORROW_STALE','SHORT_MARKET_UNSUPPORTED'])assert.equal(W.relayCode('prepare-order',{code}),code);
});
test('the engine takes a short\'s market (KOSPI or KOSDAQ) and nothing else new',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const snapshot={accountKey:'acct',environment:'mock',reportedTotal:1e7,cash:1e7,holdings:[]};const e=new LiveEngine(new DatabaseSync(':memory:'),{request:async()=>({})},()=>({status:'connected',snapshot}));
  e.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE MOCK');const base={symbol:'990010',quantity:1,limitPrice:1001};
  assert.throws(()=>e.propose({...base,side:'Sell',credit:{kind:'short',market:'NYSE'}}),/INVALID_ORDER/);assert.throws(()=>e.propose({...base,side:'Buy',credit:{kind:'cover',loanDate:'2026-10-07',market:'KOSPI'}}),/INVALID_ORDER/,'only a short carries it');
  assert.throws(()=>e.propose({...base,side:'Sell',credit:{kind:'short',market:'KOSPI'}}),/FEATURE_UNAVAILABLE/,'valid: refused further on (mock), as before');
});
test('the balance lag: a filled cover stays reserved until a balance read after the fill shows the lot lower by it; time never releases it',()=>{
  const at=Date.parse('2026-10-08T01:00:00Z');const bal=(t,q)=>({timestamp:new Date(t).toISOString(),holdings:[],shorts:[{symbol:'990010',quantity:q,availableQuantity:q,loanDate:'2026-10-07',source:'distribution'}]});
  const cover=(extra={})=>({symbol:'990010',side:'Buy',quantity:4,filled:4,status:'Filled',credit:{kind:'cover',loanDate:'2026-10-07'},filledObservedAt:at,lotAtSend:10,...extra});
  const lot=(t,q,orders)=>CP.remaining(bal(t,q),{symbol:'990010',side:'Buy',credit:{kind:'cover',loanDate:'2026-10-07'}},orders);
  // The reviewer's case: a lot of 10, a cover of 4 filled 4 minutes ago, the balance still showing 10.
  assert.deepEqual([lot(at+240000,10,[cover()]).available,lot(at+240000,10,[cover()]).reserved],[6,4],'still reserved after 4 minutes');
  // The balance catching up at 1, 4 and 12 minutes: released only by the read that shows 6.
  for(const m of [1,4,12])assert.equal(lot(at+m*60000,6,[cover()]).available,6,`caught up at ${m} min`);
  assert.equal(lot(at+12*60000,10,[cover()]).available,6,'12 minutes, still showing 10: still reserved');
  assert.equal(lot(at+12*60000,10,[cover()]).waiting,"waiting for KIS's balance to show the cover",'over 10 minutes: the words');assert.equal(lot(at+60000,10,[cover()]).waiting,undefined);
  assert.equal(lot(at-1000,6,[cover()]).available,2,'a balance read before the fill does not release it');
  assert.equal(lot(at+60000,6,[cover({lotAtSend:undefined})]).available,2,'the lot at sending unknown: kept');assert.equal(lot(at+60000,6,[cover({filledObservedAt:undefined,reconciledAt:undefined})]).available,2,'no time: kept');
  // A partial fill, then the rest: each released when the balance shows it.
  const part=cover({quantity:4,filled:2,status:'Partially filled'});assert.deepEqual([lot(at+60000,10,[part]).available,lot(at+60000,10,[part]).reserved],[6,4],'2 open + 2 filled not shown');
  assert.deepEqual([lot(at+60000,8,[part]).available,lot(at+60000,8,[part]).reserved],[6,2],'the 2 filled shown: only the open 2 reserved');
  assert.equal(lot(at+120000,6,[cover({filledObservedAt:at+100000})]).available,6,'the full fill shown');
  // A filled short counts toward the cap until the stock's short rows read higher by it.
  const short={symbol:'990010',side:'Sell',credit:{kind:'short'},filled:2,fillPrice:1001,filledObservedAt:at,lotAtSend:0};const sb=(t,q)=>({timestamp:new Date(t).toISOString(),shorts:q?[{symbol:'990010',quantity:q}]:[]});
  assert.deepEqual(R.laggingShorts([short],sb(at+240000,0)),[{notional:2002}],'4 minutes, not shown: counted');assert.deepEqual(R.laggingShorts([short],sb(at+60000,2)),[],'shown');
  assert.deepEqual(R.laggingShorts([{...short,lotAtSend:null}],sb(at+60000,2)),[{notional:2002}],'unknown lot at sending: counted');assert.deepEqual(R.laggingShorts([{...short,credit:null}],sb(at,0)),[]);
  // The engine keeps the lot read at sending.
  const src=fs.readFileSync(path.join(__dirname,'..','electron','live-engine.cjs'),'utf8');assert.match(src,/if\(order\.credit\?\.kind==='cover'\)\{const l=prepared\.balance\.shorts\?\.find/);assert.match(src,/order=\{\.\.\.order,lotAtSend:require\('\.\/short-rules\.cjs'\)\.shortQuantity\(prepared\.balance,order\.symbol\),lotAtSendAt:/);
});
test('review 2: fills sent on one reading are released together, only once the balance accounts for all of them',()=>{
  const at=Date.parse('2026-10-08T01:00:00Z');const bal=(t,q)=>({timestamp:new Date(t).toISOString(),holdings:[],shorts:[{symbol:'990010',quantity:q,availableQuantity:q,loanDate:'2026-10-07',source:'distribution'}]});
  const cover=(id,filled,extra={})=>({id,symbol:'990010',side:'Buy',quantity:filled,filled,status:'Filled',credit:{kind:'cover',loanDate:'2026-10-07'},filledObservedAt:at,lotAtSend:10,lotAtSendAt:at-5000,...extra});
  const lot=(q,orders)=>{const r=CP.remaining(bal(at+60000,q),{symbol:'990010',side:'Buy',credit:{kind:'cover',loanDate:'2026-10-07'}},orders);return [r.available,r.reserved];};
  // The reviewer's case: A (4) and B (3) sent on one reading of 10, the balance shows only A (6, truly 3 left).
  const A=cover('A',4),B=cover('B',3);assert.deepEqual(lot(6,[A,B]),[3,3],'3 real shares left: a third cover cannot pass them');
  assert.deepEqual(lot(3,[A,B]),[3,0],'the balance at 3: both released');
  // Three covers on one reading, shown one at a time: released only when the last is shown.
  const C=[cover('C1',2),cover('C2',3),cover('C3',4)];assert.deepEqual(lot(8,C),[1,7]);assert.deepEqual(lot(5,C),[1,4]);assert.deepEqual(lot(1,C),[1,0]);
  // Sent one after another on later readings: a later cover does not hold back an earlier one's own release test beyond its reading.
  const first=cover('F1',4,{lotAtSend:10,lotAtSendAt:at-10000}),second=cover('F2',3,{lotAtSend:6,lotAtSendAt:at-2000});
  assert.deepEqual(lot(3,[first,second]),[3,0],'both shown');assert.deepEqual(lot(6,[first,second]),[3,3],'only the first shown: the second\'s 3 still reserved');
  // Shorts on one reading: released together too.
  const sb=q=>({timestamp:new Date(at+60000).toISOString(),shorts:q?[{symbol:'990010',quantity:q}]:[]});const s=(id,f)=>({id,symbol:'990010',side:'Sell',credit:{kind:'short'},filled:f,fillPrice:1000,filledObservedAt:at,lotAtSend:0,lotAtSendAt:at-5000});
  assert.deepEqual(R.laggingShorts([s('S1',2),s('S2',3)],sb(2)),[{notional:3000}],'2 of 5 shown: 3 still counted');assert.deepEqual(R.laggingShorts([s('S1',2),s('S2',3)],sb(5)),[]);
});
test('review 2: an unreadable calendar is no session for a short, and the tracker goes on',()=>{
  const {Automation}=require('../electron/automation.cjs');const ctx={closedDays:new Set(),officialClosedDays:()=>{throw new Error('calendar');}};
  assert.equal(Automation.prototype.krShortSession.call(ctx,Date.parse('2026-10-08T10:00:00+09:00')),'other');
});
test('the preparation refuses a credit path that is not confirmed before any request',async()=>{
  const TYPE={short:'22',cover:'26','margin-buy':'23','margin-sell':'27'};
  for(const kind of Object.keys(TYPE)){const calls=[];const c=new KisReadOnlyClient({...credentials,environment:'live'},async(url,options)=>{calls.push(url);return reply({rt_cd:'0'});},async()=>{});
    await assert.rejects(c.prepareOrder({symbol:'990010',side:['short','margin-sell'].includes(kind)?'Sell':'Buy',quantity:1,limitPrice:1001,credit:{kind,type:TYPE[kind],loanDate:'2026-10-07',market:'KOSPI'}}),/CREDIT_PATH_UNVERIFIED/);assert.equal(calls.length,0,kind);}
});
test('reconcile: KIS\'s own names and loan date for the app\'s short or cover; a mismatch in words',()=>{
  assert.equal(R.creditRowCheck({credit:{kind:'short'}},[{creditName:'유대신규',loanDate:'2026-10-09'}]),null);
  assert.equal(R.creditRowCheck({credit:{kind:'short'}},[{creditName:'유대매도거부'}]),null,'a refusal is still a short-sale row');
  assert.equal(R.creditRowCheck({credit:{kind:'short'}},[{creditName:'현금매도'}]),'KIS recorded it as 현금매도, not a new short sale.');
  assert.equal(R.creditRowCheck({credit:{kind:'short'}},[{creditName:'<script>x'}]),'KIS recorded it as an unknown kind, not a new short sale.','only known names are printed');
  assert.equal(R.creditRowCheck({credit:{kind:'cover',loanDate:'2026-10-07'}},[{creditName:'유대상환',loanDate:'2026-10-09'}]),'its loan date at KIS is 2026-10-09, the app sent 2026-10-07.');
  assert.equal(R.creditRowCheck({credit:{kind:'cover',loanDate:'2026-10-07'}},[{creditName:'유대상환',loanDate:'2026-10-07'}]),null);assert.equal(R.creditRowCheck({credit:{kind:'margin-sell'}},[{creditName:'x'}]),null);
  assert.match(require('fs').readFileSync(require('path').join(__dirname,'..','electron','live-engine.cjs'),'utf8'),/const creditCheck=order\.credit\?require\('\.\/short-rules\.cjs'\)\.creditRowCheck\(order,res\.chain\):null;/);
});
test('the tracker: an open short sale is revised only at or above the uptick floor; not when the floor rose but its price meets it; not on a stale trade or outside the regular session',async()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},()=>{});a.syncHistories=async()=>{};a.sessionOpen=()=>true;
  const run=async({current,bid,last,lastAge=1000,session='regular'})=>{const revised=[];const order={id:'S1',symbol:'990010',side:'Sell',quantity:2,filled:0,status:'Accepted',brokerOrderId:'1',limitPrice:current,credit:{kind:'short'},day:'d'};
    a.live={market:'KR',busy:false,day:()=>'d',orders:()=>[order],revise:async(id,{price})=>{revised.push(price);},annotate:()=>{}};a.usLive=null;a.krShortSession=()=>session;
    a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid,ask:bid+10}});a.marketQuotes=()=>[{symbol:'990010',price:last,timestamp:Date.now()-lastAge}];await a.trackOrders();return revised;};
  assert.deepEqual(await run({current:1010,bid:990,last:1000}),[1001],'the bid fell: held at the floor');
  assert.deepEqual(await run({current:1000,bid:990,last:1004}),[1005],'the floor passed its price: raised');
  assert.deepEqual(await run({current:1010,bid:1010,last:1004}),[],'the floor rose, the price still meets it: not moved');
  assert.deepEqual(await run({current:1000,bid:990,last:1004,lastAge:61000}),[],'a stale last trade: kept');
  assert.deepEqual(await run({current:1000,bid:990,last:1004,session:'auction'}),[],'the auction: kept');assert.deepEqual(await run({current:1000,bid:990,last:1004,session:'other'}),[],'the closing auction or after: kept');
});
test('the Korean session for a short: the auction before the open, the regular session to the app\'s last order time, special days included',()=>{
  const {Automation}=require('../electron/automation.cjs');const ctx={closedDays:new Set(),officialClosedDays:()=>['2026-10-09']};const s=t=>Automation.prototype.krShortSession.call(ctx,t);const at=(day,hm)=>Date.parse(`${day}T${hm}:00+09:00`);
  assert.equal(s(at('2026-10-08','08:29')),'other');assert.equal(s(at('2026-10-08','08:30')),'auction');assert.equal(s(at('2026-10-08','09:00')),'regular');assert.equal(s(at('2026-10-08','15:19')),'regular');assert.equal(s(at('2026-10-08','15:20')),'other','the closing auction');
  assert.equal(s(at('2026-11-19','09:30')),'auction','a shifted day');
  assert.equal(s(at('2026-10-11','10:00')),'other','a Sunday');assert.equal(s(at('2026-10-10','10:00')),'other','a Saturday');assert.equal(s(at('2026-10-09','10:00')),'other','a closed day by the KIS calendar');assert.equal(s(at('2026-11-19','10:00')),'regular');
});
