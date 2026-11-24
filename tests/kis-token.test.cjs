// The token fix (artifacts/reviews/2026-11-24-kis-token: note.md and the planner's ruling; found in live use: every KIS
// request failed with EGW00123 for over an hour, until the app's own clock renewed the sign-in). Fake transports only.
const test=require('node:test');const assert=require('node:assert/strict');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');
const credentials={environment:'mock',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{tr_cont:''}});
const expired=()=>reply({rt_cd:'1',msg_cd:'EGW00123',msg1:'token expired'},500);
// A KIS stand-in: tokens t1, t2, …; a token is dead once `kill` names it. Records every token request and every call.
function kis({clock}){const s={tokens:0,calls:[],dead:new Set(),orders:0};
  const transport=async(url,init)=>{if(url.endsWith('/oauth2/tokenP')){s.tokens++;s.tokenAt=(s.tokenAt??[]).concat(clock.now);return reply({access_token:'t'+s.tokens,expires_in:86400});}
    const token=String(init?.headers?.authorization??'').replace('Bearer ','');s.calls.push({url,token,method:init.method});if(s.dead.has(token))return expired();
    if(url.includes('inquire-price'))return reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}});
    if(url.includes('order-rvsecncl')){s.orders++;return reply({rt_cd:'0',output:{ODNO:'0000123',KRX_FWDG_ORD_ORGNO:'01'}});}
    return reply({rt_cd:'0',output:{}});};
  return s.transport=transport,s;}
function client(){const clock={now:1_000_000};const waits=[];const s=kis({clock});
  const c=new KisReadOnlyClient(credentials,s.transport,async ms=>{waits.push(ms);clock.now+=ms;});
  const real=Date.now;Date.now=()=>clock.now;return {c,s,clock,waits,restore:()=>{Date.now=real;}};}
test('a GET that meets an ended sign-in renews it once and succeeds with the new token',async()=>{
  const {c,s,clock,restore}=client();try{
    await c.getQuote('990010');assert.equal(s.tokens,1);clock.now+=120000;s.dead.add('t1');const before=s.calls.length;
    const q=await c.getQuote('990010');assert.equal(q.price??q.stck_prpr??100,q.price??100);assert.equal(s.tokens,2,'one renewal');assert.equal(s.calls.at(-1).token,'t2','retried with the new token');
    assert.equal(s.calls.slice(before).filter(x=>x.token==='t1').length,1,'renewal first: no second request with the dead token');
  }finally{restore();}
});
test('two requests that meet it together share one renewal; a second within the minute waits out the minute and asks one token',async()=>{
  const {c,s,clock,waits,restore}=client();try{
    await c.getQuote('990010');s.dead.add('t1');clock.now+=10000;
    await Promise.all([c.getQuote('990010'),c.getQuote('990020')]);assert.equal(s.tokens,2,'shared');
    assert.ok(waits.some(w=>w>=40000),'the renewal waited out the rest of the minute since the last token: '+waits.join(','));
    const gaps=s.tokenAt.slice(1).map((t,i)=>t-s.tokenAt[i]);assert.ok(gaps.every(g=>g>=60000),'never two tokens within a minute: '+gaps.join(','));
  }finally{restore();}
});
test('an order, revision or cancellation that meets it is thrown not sent (TOKEN_EXPIRED) and not repeated; the sign-in is renewed for the next',async()=>{
  const {c,s,clock,restore}=client();try{
    await c.getQuote('990010');clock.now+=120000;s.dead.add('t1');
    await assert.rejects(c.reviseOrder({originalOrderId:'0000100',organization:'01',cancel:true}),e=>e.code==='TOKEN_EXPIRED'&&e.notSent===true);
    assert.equal(s.calls.filter(x=>x.url.includes('order-rvsecncl')).length,1,'sent once, not repeated');assert.equal(s.orders,0);
    // A send started while the renewal runs does not wait for it: refused at once (review 2 of the second staging).
    await assert.rejects(c.reviseOrder({originalOrderId:'0000100',organization:'01',price:120}),e=>e.code==='TOKEN_EXPIRED'&&e.notSent===true);
    await c.getQuote('990010');assert.equal(s.tokens,2,'renewed (a read waits for it)');
    const r=await c.reviseOrder({originalOrderId:'0000100',organization:'01',price:120});assert.equal(r.brokerOrderId,'0000123','the next one goes out with the new token');
  }finally{restore();}
});
test('a failed renewal throws as before; another refusal (not EGW00123) is not a renewal',async()=>{
  const {c,s,clock,restore}=client();try{
    await c.getQuote('990010');clock.now+=120000;s.dead.add('t1');const t=s.transport;s.transport=null;
    let tokenCalls=0;const failing=async(url,init)=>{if(url.endsWith('/oauth2/tokenP')){tokenCalls++;return reply({error_code:'EGW00133'},403);}return t(url,init);};
    const c2=new KisReadOnlyClient(credentials,failing,async ms=>{clock.now+=ms;});await assert.rejects(c2.getQuote('990010'),e=>e.code==='AUTH_FAILED','no token at all: as before');
  }finally{restore();}
  const plain=new KisReadOnlyClient(credentials,async url=>url.endsWith('/oauth2/tokenP')?reply({access_token:'t',expires_in:86400}):reply({rt_cd:'1',msg_cd:'EGW00201'},500),async()=>{});
  await assert.rejects(plain.getQuote('990010'));
});
test('the send paths treat TOKEN_EXPIRED as passing: relayed as itself, an order not sent, a stop kept armed and never closed for it',()=>{
  const W=require('../electron/worker-codes.cjs');for(const op of ['place-order','revise-order','cancel-order'])assert.equal(W.relayCode(op,{code:'TOKEN_EXPIRED',notSent:true}),'TOKEN_EXPIRED',op);
  assert.equal(require('../electron/order-outcomes.cjs').classOf('TOKEN_EXPIRED'),'order','this order only: the rest of a batch goes on');
  const fs=require('node:fs'),path=require('node:path'),read=f=>fs.readFileSync(path.join(__dirname,'..','electron',f),'utf8');
  assert.match(read('live-engine.cjs'),/notSentCause:error\.message==='TICKET_EXPIRED'\?'ticket-expired':error\.message==='TOKEN_EXPIRED'\?'token-expired':'rate-limit'/);
  assert.match(read('live-engine.cjs'),/const notSentError=e=>e\?\.message==='ORDER_NOT_SENT'\|\|e\?\.message==='TOKEN_EXPIRED'/,'a revision or cancellation: not sent, nothing changed at KIS');
  const a=read('automation.cjs');assert.match(a,/if\(sent==='Rejected'&&placed\.reason==='ORDER_NOT_SENT'&&placed\.notSentCause==='token-expired'\)\{retire\(\);[^\n]*status:'armed',waiting:w,nextCheckAt:Date\.now\(\)\+60000\}\);return;\}/);
  assert.match(a,/if\(code==='TOKEN_EXPIRED'\)\{this\.noteTrack\(/);assert.match(a,/'Order not sent · sign-in renewed'/);
  assert.equal(require('../electron/activity-today.cjs').NOT_SENT['token-expired'],"KIS had ended the app's sign-in; it was renewed");
});
test('a stop that fires while the sign-in is dead is kept armed and sent once after renewal',async()=>{
  const {DatabaseSync}=require('node:sqlite');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');require('./fixtures/order-book.cjs');
  const db=new DatabaseSync(':memory:');const store=new Map();let sends=0,dead=true;
  const live={market:'KR',enabled:true,autoEnabled:true,identity:()=>'acct',getState:()=>({}),orders:()=>[...store.values()],riskBalance:{shorts:[]},
    context:async()=>({market:'KR',equity:1e7,cash:5e6,positions:{'990010':{quantity:4}},quotes:[{symbol:'990010',price:1000,timestamp:Date.now()}],marketSession:{open:true}}),
    propose:c=>{const o={id:'P'+(store.size+1),status:'Ready',...c};store.set(o.id,o);return o;},annotate:(id,p)=>store.set(id,{...store.get(id),...p}),
    autoSubmit:async id=>{sends++;const o=dead?{...store.get(id),status:'Rejected',reason:'ORDER_NOT_SENT',notSentCause:'token-expired'}:{...store.get(id),status:'Accepted'};store.set(id,o);return o;}};
  const events=[];const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},(id,k,title,body)=>events.push({title,body}));a.live=live;a.usLive=null;
  a.configure({scope:'kis',autoSubmit:true,conditionalOrders:true,conditionalAutoSubmit:true});a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:999,ask:1000}});a.emergencyState=()=>({active:false});a.marketQuotes=()=>[{symbol:'990010',price:1000,timestamp:Date.now()}];
  const r=a.desk.setOrder(a.watchScope(),{action:'add',id:'',symbol:'990010',side:'Sell',quantity:4,limitPrice:null,conditions:[{expr:'price("990010")',op:'<=',value:1001}],combine:'all',purpose:'stop_loss',expiresInHours:2,reason:'fixture'},{config:a.config,universe:['990010']});
  const row=()=>a.desk.rows('conditional_orders',a.watchScope()).find(x=>x.id===r.id);
  await a.fireConditional(row());assert.equal(row().status,'armed','kept armed');assert.match(row().waiting,/sign-in/);assert.ok(row().nextCheckAt>=Date.now()+59000);assert.equal(sends,1);
  await a.fireConditional(row());assert.equal(row().status,'armed','still armed, never closed for it');assert.equal(events.filter(e=>e.title==='Conditional order · waiting').length,1,'one line');
  dead=false;await a.fireConditional(row());assert.equal(row().status,'submitted','sent once the sign-in is renewed');
});
test('Home says when KIS has not answered for more than 3 minutes while orders are armed or auto trading runs',async()=>{
  const {kisDownLine}=await import('../src/unwatched-orders.mjs');const now=Date.parse('2026-11-24T11:30:00Z');
  const st=(feed,extra={})=>({kisFeed:feed,desk:{orders:[{id:'c1'}]},config:{enabled:false,autoSubmit:false},...extra});
  assert.equal(kisDownLine(st({status:'error',since:now-200000,brokerCode:'EGW00123'}),now),'KIS is not answering since 20:26 (its sign-in expired): armed orders and stops are not watched until it answers.');
  assert.match(kisDownLine(st({status:'error',since:now-200000,brokerCode:null}),now),/\(a connection error\)/);
  assert.equal(kisDownLine(st({status:'error',since:now-120000,brokerCode:'EGW00123'}),now),null,'3 minutes or less: the header only');
  assert.equal(kisDownLine(st({status:'error',since:now-200000},{desk:{orders:[]}}),now),null,'nothing armed and auto trading off: the header only');
  assert.ok(kisDownLine(st({status:'error',since:now-200000},{desk:{orders:[]},config:{enabled:true,autoSubmit:true}}),now),'auto trading on');
  assert.equal(kisDownLine(st({status:'connected',since:null}),now),null);assert.equal(kisDownLine({},now),null);
});
// ---- The review's points (single-flight sign-in, an order reported at once, the U.S. side, the resend guard, HTTP 200).
// A KIS stand-in whose token request can be held and can fail; every token request is timed on the test clock.
function kis2({clock,status=500}){const s={tokens:[],calls:[],dead:new Set(),fail:false,hold:null};
  const transport=async(url,init)=>{if(url.endsWith('/oauth2/tokenP')){s.tokens.push(clock.now);if(s.hold)await s.hold;if(s.fail)return reply({error_code:'EGW00133',error_description:'one a minute'},403);return reply({access_token:'k'+s.tokens.length,expires_in:86400});}
    const token=String(init?.headers?.authorization??'').replace('Bearer ','');s.calls.push({url,token});if(s.dead.has(token))return reply({rt_cd:'1',msg_cd:'EGW00123',msg1:'token expired'},status);
    if(url.includes('order-rvsecncl'))return reply({rt_cd:'0',output:{ODNO:'0000123',KRX_FWDG_ORD_ORGNO:'01'}});
    return reply({rt_cd:'0',output:{stck_prpr:'100',aspr_unit:'1',temp_stop_yn:'N'}});};return s.transport=transport,s;}
function client2(opts={}){const clock={now:5_000_000};const s=kis2({clock,...opts});const c=new KisReadOnlyClient(credentials,s.transport,async ms=>{clock.now+=ms;});
  const real=Date.now;Date.now=()=>clock.now;return {c,s,clock,restore:()=>{Date.now=real;}};}
const gaps=t=>t.slice(1).map((x,i)=>x-t[i]);
test('review 1: one sign-in at a time, at most one token a minute: the first sign-in, the natural expiry and a renewal',async()=>{
  {const {c,s,restore}=client2();try{await Promise.all(Array.from({length:10},(_,i)=>c.getQuote('99001'+(i%10))));assert.equal(s.tokens.length,1,'ten requests at the first sign-in: one token');}finally{restore();}}
  {const {c,s,clock,restore}=client2();try{await c.getQuote('990010');clock.now+=86400000;await Promise.all(Array.from({length:6},()=>c.getQuote('990010')));assert.equal(s.tokens.length,2,'at the natural expiry: one more token (the race before the fix asked one per request)');}finally{restore();}}
  {const {c,s,clock,restore}=client2();try{await c.getQuote('990010');clock.now+=120000;s.dead.add('k1');
    await Promise.all([...Array.from({length:10},()=>c.getQuote('990010')),...Array.from({length:6},()=>c.getQuote('990020'))]);
    assert.equal(s.tokens.length,2,'sixteen requests meeting the dead token: one renewal');assert.ok(gaps(s.tokens).every(g=>g>=60000));}finally{restore();}}
});
test('review 1: after a failed token request the next try waits a minute; a failed renewal never feeds itself',async()=>{
  const {c,s,clock,restore}=client2();try{await c.getQuote('990010');clock.now+=120000;s.dead.add('k1');s.fail=true;
    for(let i=0;i<5;i++){await c.getQuote('990010').catch(()=>{});clock.now+=10000;}
    assert.ok(gaps(s.tokens).every(g=>g>=60000),'never two token requests within a minute: '+gaps(s.tokens).join(','));
    s.fail=false;await c.getQuote('990010');assert.equal(s.calls.at(-1).token,'k'+s.tokens.length,'recovers with the next token');
  }finally{restore();}
});
test('review 2: an order meeting the dead token is reported not sent at once; the renewal runs on',async()=>{
  const {c,s,clock,restore}=client2();try{await c.getQuote('990010');clock.now+=5000;s.dead.add('k1');let release;s.hold=new Promise(r=>{release=r;});
    // The renewal must wait out the minute and its token request is held, so an order held for it could not settle here.
    await assert.rejects(c.reviseOrder({originalOrderId:'0000100',organization:'01',cancel:true}),e=>e.code==='TOKEN_EXPIRED'&&e.notSent===true);
    assert.equal(s.tokens.length<=2,true);assert.equal(s.calls.filter(x=>x.token==='k2').length,0,'reported before any request with a new token');release();s.hold=null;
    await c.getQuote('990010');assert.equal(s.tokens.length,2,'the renewal finished and is used');
  }finally{restore();}
});
test('review 5: the code with HTTP 200 is renewed too',async()=>{
  const {c,s,clock,restore}=client2({status:200});try{await c.getQuote('990010');clock.now+=120000;s.dead.add('k1');await c.getQuote('990010');assert.equal(s.tokens.length,2);assert.equal(s.calls.at(-1).token,'k2');}finally{restore();}
});
test('review 3: the U.S. side carries TOKEN_EXPIRED for its order, revision and cancellation',()=>{
  const W=require('../electron/worker-codes.cjs');for(const op of ['us-place-order','us-revise-order'])assert.equal(W.relayCode(op,{code:'TOKEN_EXPIRED',notSent:true}),'TOKEN_EXPIRED',op);
  assert.equal(W.relayCode('us-quotes',{code:'TOKEN_EXPIRED'}),'US_REQUEST_FAILED','a read never sees it (renewed and retried), and is not an order code');
});
test('review 4: before an order refused this way is sent again, the send reads KIS\'s open orders; an open order for that stock the app does not know stops it (Korea and the U.S.)',()=>{
  const {openGuard}=require('../electron/broker-open-orders.cjs');const kisSays=[{orderId:'0000777',symbol:'990010',side:'Sell',quantity:4,remaining:4,orderPrice:999,status:'Pending'}];
  for(const severalOpen of [false,true])assert.throws(()=>openGuard(kisSays,{symbol:'990010'},{severalOpen,fail:()=>new Error('OPEN_BROKER_ORDERS')}),/OPEN_BROKER_ORDERS/,'severalOpen '+severalOpen);
  const fs=require('node:fs'),path=require('node:path'),read=f=>fs.readFileSync(path.join(__dirname,'..','electron',f),'utf8');
  assert.match(read('kis-client.cjs'),/const \{orders\}=await this\.getActivity\('orders',today,today\);\s*const open=require\('\.\/broker-open-orders\.cjs'\)\.openGuard\(orders,command,/,'Korea: every preparation reads today\'s orders first');
  assert.match(read('kis-overseas.cjs'),/openGuard\(history\.orders,command,\{severalOpen,fail:\(\)=>new Error\('OPEN_BROKER_ORDERS'\)\}\)/,'the U.S.: the same guard on its order history');
});
test('review 5: Home\'s line when the app starts while KIS does not answer, and for the U.S. feed',async()=>{
  const {kisDownLine}=await import('../src/unwatched-orders.mjs');const now=Date.parse('2026-11-24T11:30:00Z');const armed={desk:{orders:[{id:'c1'}]},config:{}};
  assert.match(kisDownLine({...armed,kisFeed:{status:'error',since:now-400000,brokerCode:null}},now),/^KIS is not answering since 20:23 \(a connection error\)/,'from the start (no balance read yet)');
  assert.match(kisDownLine({...armed,kisFeed:{status:'connected',since:null,brokerCode:null,us:{status:'error',since:now-300000,brokerCode:'EGW00123'}}},now),/since 20:25 \(its sign-in expired\)/,'the U.S. feed');
  const main=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','main.cjs'),'utf8');
  assert.match(main,/const down=kisState\?\.status==='error'\|\|kisState\?\.status==='disconnected'&&Boolean\(kisState\.error\);/);assert.match(main,/usLive\.refreshErrorSince=Number\.isFinite\(usLive\.refreshErrorSince\)\?usLive\.refreshErrorSince:Date\.now\(\);/);
});
// ---- Third review: no send waits for a sign-in; the minute is per app key across clients and the two KIS workers.
test('third review 1: an order, revision, cancellation or preparation that starts while the sign-in waits is refused at once, not held',async()=>{
  const {c,s,clock,restore}=client2();try{await c.getQuote('990010');clock.now+=5000;s.dead.add('k1');let release;s.hold=new Promise(r=>{release=r;});
    const read=c.getQuote('990010');await new Promise(r=>setImmediate(r));// a read meets the dead token and starts the renewal (which waits)
    for(const send of [()=>c.placeOrder({symbol:'990010',side:'Buy',quantity:1,limitPrice:100}),()=>c.reviseOrder({originalOrderId:'0000100',organization:'01',cancel:true}),()=>c.prepareOrder({symbol:'990010',side:'Buy',quantity:1,limitPrice:100})])
      await assert.rejects(send(),e=>e.code==='TOKEN_EXPIRED'&&e.notSent===true);
    assert.equal(s.calls.filter(x=>x.token==='k2').length,0,'every send answered before any new token existed');release();s.hold=null;await read;
  }finally{restore();}
});
test('third review 2: the minute is per app key: a second client for the same key waits; another KIS endpoint does not; the file shares it between the two workers',async()=>{
  const clock={now:9_000_000};const real=Date.now;Date.now=()=>clock.now;try{
    const s=kis2({clock});const waits=[];const mk=()=>new KisReadOnlyClient(credentials,s.transport,async ms=>{waits.push(ms);clock.now+=ms;});
    const a=mk();await a.getQuote('990010');clock.now+=5000;const b=mk();const seen=[];b.onSignInWait=ms=>seen.push(ms);await b.getQuote('990010');
    assert.ok(gaps(s.tokens).every(g=>g>=60000),'a new client (Reconnect, account switch) keeps the minute: '+gaps(s.tokens).join(','));assert.ok(seen.length===1&&seen[0]>50000,'the wait is reported for the screen: '+seen.join(','));
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'kis-clock-')),'clock.json');process.env.KIS_TOKEN_CLOCK=file;try{
      const s1=kis2({clock}),s2=kis2({clock});clock.now+=120000;
      await new KisReadOnlyClient(credentials,s1.transport,async ms=>{clock.now+=ms;}).getQuote('990010');clock.now+=3000;
      await new KisReadOnlyClient(credentials,s2.transport,async ms=>{clock.now+=ms;}).getQuote('990010');// the other worker (another process: its own transport)
      assert.ok(s2.tokens[0]-s1.tokens[0]>=60000,'the calendar worker waits for the broker worker\'s token: '+(s2.tokens[0]-s1.tokens[0]));
      assert.doesNotMatch(fs.readFileSync(file,'utf8'),/fixture-key/,'only a short hash of the key is written');
    }finally{delete process.env.KIS_TOKEN_CLOCK;}
    const other=kis2({clock});await new KisReadOnlyClient({...credentials,appKey:'fixture-other-key'},other.transport,async ms=>{clock.now+=ms;}).getQuote('990010');assert.equal(other.tokens.length,1,'another key: its own minute');
  }finally{Date.now=real;}
  const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..',f),'utf8');
  assert.match(read('electron/kis-service.cjs'),/KIS_TOKEN_CLOCK:path\.join\(require\('electron'\)\.app\.getPath\('userData'\),'kis-token-clock\.json'\)/);
  assert.match(read('electron/kis-worker.cjs'),/client\.onSignInWait=waitMs=>process\.parentPort\.postMessage\(\{type:'signin',waitMs\}\);/);assert.match(read('electron/calendar-worker.cjs'),/next\.onSignInWait=/);
  assert.match(read('src/Connections.tsx'),/`KIS allows one sign-in a minute; connecting in \$\{kisWait\} s`/);
});
test('third review 3: after an order refused for an ended sign-in, a resend is refused when KIS lists an order of that stock and side the app does not know, placed since, whatever its status (both markets, several-open on and off)',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const at=Date.parse('2026-11-24T02:00:00Z');
  const engine=(symbol,severalOpen,known=[])=>{const rows=new Map();const tried={id:'P1',symbol,side:'Buy',quantity:5,status:'Rejected',reason:'ORDER_NOT_SENT',notSentCause:'token-expired',tokenAttemptAt:at};rows.set('P1',tried);
    for(const [i,id] of known.entries())rows.set('K'+i,{id:'K'+i,symbol,side:'Buy',status:'Filled',brokerOrderId:id});
    const e=Object.assign(Object.create(LiveEngine.prototype),{severalOpenFixed:severalOpen,orders:()=>[...rows.values()],save:o=>rows.set(o.id,o)});return {e,rows};};
  for(const [symbol,kisSymbol] of [['990010','990010'],['NASD:XYZ','NASD:XYZ']])for(const severalOpen of [false,true])for(const status of ['Filled','Partially filled','Canceled','Pending']){
    const {e,rows}=engine(symbol,severalOpen);const order={id:'P2',symbol,side:'Buy',quantity:5};
    assert.throws(()=>e.tokenResendCheck(order,{todayOrders:[{orderId:'0000900',symbol:kisSymbol,side:'Buy',timestamp:at+20000,status}]},at+90000),e=>e.message==='RECONCILIATION_REQUIRED'&&/marked uncertain for you to link/.test(e.detail),`${symbol} ${status} several-open ${severalOpen}`);
    assert.equal(rows.get('P1').status,'Uncertain','the refused order goes to the existing Uncertain handling');assert.deepEqual(rows.get('P1').kisCandidates,[{orderId:'0000900',symbol:kisSymbol,side:'Buy',quantity:null,status,timestamp:at+20000}]);}
  // No such order: the resend goes on, and the attempt is cleared (never checked again).
  {const {e,rows}=engine('990010',false,['0000500']);const order={id:'P2',symbol:'990010',side:'Buy',quantity:5};
    e.tokenResendCheck(order,{todayOrders:[{orderId:'0000500',symbol:'990010',side:'Buy',timestamp:at+20000,status:'Filled'},{orderId:'0000600',symbol:'990010',side:'Sell',timestamp:at+20000,status:'Filled'},{orderId:'0000700',symbol:'990020',side:'Buy',timestamp:at+20000,status:'Filled'},{orderId:'0000800',symbol:'990010',side:'Buy',timestamp:at-120000,status:'Filled'}]},at+90000);
    assert.ok(Number.isFinite(rows.get('P1').tokenChecked),'cleared: the app\'s own order, the other side, another stock and an older order do not count');assert.equal(rows.get('P1').status,'Rejected');
    e.tokenResendCheck(order,{todayOrders:[{orderId:'0000900',symbol:'990010',side:'Buy',timestamp:at+100000,status:'Filled'}]},at+200000);assert.equal(rows.get('P1').status,'Rejected','a cleared attempt is not checked again');}
  // A row with no time counts (the safe side).
  {const {e}=engine('NASD:XYZ',true);assert.throws(()=>e.tokenResendCheck({id:'P2',symbol:'NASD:XYZ',side:'Buy'},{todayOrders:[{orderId:'0000901',symbol:'NASD:XYZ',side:'Buy',timestamp:null,status:'Filled'}]},at+90000),/RECONCILIATION_REQUIRED/);}
  const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron',f),'utf8');
  assert.match(read('live-engine.cjs'),/this\.tokenResendCheck\(order,prepared\);/);assert.match(read('live-engine.cjs'),/\.\.\.\(error\.message==='TOKEN_EXPIRED'\?\{tokenAttemptAt:Date\.now\(\)\}:\{\}\)/);
  assert.match(read('kis-client.cjs'),/const todayOrders=\(orders\?\?\[\]\)\.filter\(o=>!o\.originalOrderId\)/);assert.match(read('kis-overseas.cjs'),/todayOrders:\(history\.orders\?\?\[\]\)\.filter\(o=>o\.kind==='order'\)/);
});
test('fourth review 1: a stop whose preparation is refused TOKEN_EXPIRED five times stays armed (one line), then is sent once (Korea and the U.S.)',async()=>{
  const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
  for(const [market,symbol,price,stopAt] of [['KR','990010',10000,9500],['US','NASD:XYZ',50,48]]){
    const m=new MockKis({kr:{cash:10000000,holdings:market==='KR'?[{symbol,name:symbol,quantity:10,cost:11000,price}]:[]},us:{cash:5000,holdings:market==='US'?[{symbol,name:symbol,quantity:10,cost:55,price}]:[]},prices:{[symbol]:price}});
    const h=appHarness({mock:m,severalOpen:true}).enable();h.automation(market==='US'?{scope:'us'}:{});
    if(market==='US'){h.a.refreshUS=async()=>m.request('US','context',{symbols:[symbol]});h.a.usQuotes=[{symbol,price,timestamp:Date.now(),retrievedAt:Date.now()}];}
    h.reading();m.price(symbol,stopAt-1);if(market==='US')h.a.usQuotes=[{symbol,price:stopAt-1,timestamp:Date.now(),retrievedAt:Date.now()}];
    const e=h.arm({symbol,side:'Sell',quantity:10,conditions:[{expr:`price("${symbol}")`,op:'<=',value:stopAt}],purpose:'stop_loss'});assert.ok(e?.id,market+': armed '+JSON.stringify(e));
    m.fault('prepare-order',{fail:'TOKEN_EXPIRED'},5);
    for(let i=0;i<5;i++){const r=await h.fire(e.id);assert.equal(r.status,'armed',`${market} try ${i+1}: ${r.status} ${r.outcome??''}`);assert.ok(r.nextCheckAt>Date.now()+50000,'checked again in a minute');}
    assert.equal(h.logs.filter(x=>x[2]==='Conditional order · waiting').length,1,market+': one line for the episode');
    assert.equal(m.book[market].filter(x=>x.kind==='order').length,0,market+': nothing reached KIS');
    const engine=market==='US'?h.us:h.kr;assert.ok(engine.orders().filter(o=>o.symbol===symbol).every(o=>o.status==='Rejected'&&o.notSentCause==='token-expired'&&!o.tokenAttemptAt),market+': each refusal recorded not sent, with no resend check (nothing was sent)');
    const r=await h.fire(e.id);assert.equal(r.status,'submitted',`${market} sixth: ${r.outcome??''}`);
    assert.equal(m.book[market].filter(x=>x.kind==='order'&&x.side==='Sell').length,1,market+': sent once');}
});
test('fourth review 2: the reviewer\'s false positive end to end: a hand order makes the refused order Uncertain; "KIS never took it" clears it and frees the market',async()=>{
  const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
  const m=new MockKis({kr:{cash:10000000},prices:{'990010':10000,'990020':20000}});const h=appHarness({mock:m,severalOpen:true}).enable();
  m.fault('place-order',{fail:'TOKEN_EXPIRED'});const first=await h.send('KR','990010','Buy',2,10000);
  const tried=h.kr.orders().find(o=>o.symbol==='990010');assert.equal(tried.status,'Rejected',JSON.stringify(first));assert.equal(tried.notSentCause,'token-expired');
  // The user's own order of the same stock and side, placed in KIS's app (the reviewer's case: KIS never took the refused one).
  const p=await m.request('KR','prepare-order',{command:{symbol:'990010',side:'Buy',quantity:1,limitPrice:10000,market:'KR'}});const hand=await m.request('KR','place-order',{ticket:p.ticket});m.fill('KR',hand.brokerOrderId);// filled: past the open-orders guard
  const second=await h.send('KR','990010','Buy',2,10000);assert.match(JSON.stringify(second),/RECONCILIATION_REQUIRED/);
  assert.equal(h.kr.orders().find(o=>o.id===tried.id).status,'Uncertain','the refused order goes to the Uncertain handling');
  assert.deepEqual(h.kr.uncertainHold().stocks,['990010'],'Home names what is held: that stock, with several open');
  {const was=h.kr.severalOpenFixed;h.kr.severalOpenFixed=false;try{assert.equal(h.kr.uncertainHold().stocks,null,'the whole market otherwise');}finally{h.kr.severalOpenFixed=was;}}
  const held=await h.send('KR','990010','Buy',1,10000);assert.match(JSON.stringify(held),/RECONCILIATION_REQUIRED/,'the stock\'s orders are held by it (several open; the whole market otherwise)');
  assert.throws(()=>h.kr.markNotTaken(tried.id,'yes'),/APPROVAL_REQUIRED/,'only with the confirmation');
  h.kr.markNotTaken(tried.id,'KIS NEVER TOOK IT');const after=h.kr.orders().find(o=>o.id===tried.id);
  assert.equal(after.status,'Rejected');assert.equal(after.reason,'ORDER_NOT_SENT');assert.equal(after.notSentCause,'user-confirmed-not-taken');
  assert.throws(()=>h.kr.markNotTaken(tried.id,'KIS NEVER TOOK IT'),/UNKNOWN_ORDER/,'only an Uncertain order');assert.equal(h.kr.uncertainHold(),null,'Home\'s item is gone');
  const free=await h.send('KR','990020','Buy',1,20000);assert.equal(free.status,'Accepted','the market is free: '+JSON.stringify(free));
  const again=await h.send('KR','990010','Buy',2,10000);assert.equal(again.status,'Accepted','and the order itself may be sent again: '+JSON.stringify(again));
  // Home's Needs-you item and the screen's way out (pinned by source: main.cjs builds it from both engines).
  const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..',f),'utf8');
  assert.match(read('electron/main.cjs'),/title:held\.stocks\?`\$\{name\} orders of \$\{held\.stocks\.join\(', '\)\} are held: an order's state at KIS is unknown`:`\$\{name\} orders are held: an order's state at KIS is unknown`/);
  assert.match(read('electron/main.cjs'),/for\(const \[engine,name,tab\] of \[\[live,'Korean','KIS trading'\],\[usLive,'U\.S\.','U\.S\. stocks'\]\]\)\{try\{const held=engine\?\.uncertainHold\?\.\(\);/);
  // The evidence the confirmation shows: the hand order, as KIS listed it.
  {const {notTakenEvidence}=await import('../src/not-taken.mjs');const u=h.kr.orders().find(o=>o.id===tried.id);assert.match(notTakenEvidence(u,'KR')[0],/^KIS shows: Buy 1 990010, filled, \d\d:\d\d$/);}
  assert.match(read('src/LiveTrading.tsx'),/void action\('not-taken',order\.id,'KIS NEVER TOOK IT'\)/);
  assert.match(read('src/LiveTrading.tsx'),/Only if you checked in KIS that it has no such order\. The app then counts it as not sent and may send it again\./);
});
test('fourth review 3: a stored sign-in time in the future (the file a day ahead, or the PC clock set back) never makes a wait longer than a minute',async()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const clock={now:1_795_000_000_000};const real=Date.now;Date.now=()=>clock.now;
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'kis-clock-')),'clock.json');process.env.KIS_TOKEN_CLOCK=file;try{
    const s1=kis2({clock});await new KisReadOnlyClient(credentials,s1.transport,async ms=>{clock.now+=ms;}).getQuote('990010');
    const v=JSON.parse(fs.readFileSync(file,'utf8'));for(const k of Object.keys(v))v[k]+=86400000;fs.writeFileSync(file,JSON.stringify(v));clock.now+=120000;
    const waits=[];const s2=kis2({clock});await new KisReadOnlyClient(credentials,s2.transport,async ms=>{waits.push(ms);clock.now+=ms;}).getQuote('990010');
    assert.equal(s2.tokens.length,1);assert.ok(waits.every(w=>w<=60000),'the file a day ahead: '+waits.join(','));
    // The PC's clock set back a day: the time this process noted is now in the future.
    delete process.env.KIS_TOKEN_CLOCK;const waits3=[];const s3=kis2({clock});const c=new KisReadOnlyClient(credentials,s3.transport,async ms=>{waits3.push(ms);clock.now+=ms;});
    clock.now+=120000;await c.getQuote('990010');clock.now-=86400000;s3.dead.add('k1');await c.getQuote('990010');
    assert.equal(s3.tokens.length,2,'renewed');assert.ok(waits3.every(w=>w<=60000),'the clock set back: '+waits3.join(','));
  }finally{delete process.env.KIS_TOKEN_CLOCK;Date.now=real;}
});
test('fourth review 4: the clock file holds a keyed hash: no key, no plain hash of it; the per-install value is made once and kept',async()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');const clock={now:30_000_000};const real=Date.now;Date.now=()=>clock.now;
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'kis-clock-')),'clock.json');process.env.KIS_TOKEN_CLOCK=file;try{
    const s=kis2({clock});await new KisReadOnlyClient(credentials,s.transport,async ms=>{clock.now+=ms;}).getQuote('990010');
    const text=fs.readFileSync(file,'utf8');const secret=fs.readFileSync(file+'.secret','utf8');assert.match(secret,/^[0-9a-f]{64}$/,'a random value beside the file');
    assert.doesNotMatch(text,/fixture-key/);const plain=crypto.createHash('sha256').update('fixture-key').digest('hex').slice(0,16);assert.ok(!text.includes(plain),'not a plain hash anyone could match');
    assert.ok(text.includes(crypto.createHmac('sha256',secret).update('fixture-key').digest('hex').slice(0,16)),'the keyed hash');
    clock.now+=120000;const s2=kis2({clock});await new KisReadOnlyClient(credentials,s2.transport,async ms=>{clock.now+=ms;}).getQuote('990010');
    assert.equal(fs.readFileSync(file+'.secret','utf8'),secret,'made once, kept');
  }finally{delete process.env.KIS_TOKEN_CLOCK;Date.now=real;}
});
test('fifth review 1: a stop whose order KIS never took is armed again; with the market stopped by the unclear reply, nothing is sent until Start, then it fires once (Korea and the U.S.)',async()=>{
  const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
  for(const [market,symbol,price,stopAt] of [['KR','990010',10000,9500],['US','NASD:XYZ',50,48]]){
    const m=new MockKis({kr:{cash:10000000,holdings:market==='KR'?[{symbol,name:symbol,quantity:10,cost:11000,price}]:[]},us:{cash:5000,holdings:market==='US'?[{symbol,name:symbol,quantity:10,cost:55,price}]:[]},prices:{[symbol]:price}});
    const h=appHarness({mock:m,severalOpen:false}).enable();h.automation(market==='US'?{scope:'us'}:{});const engine=market==='US'?h.us:h.kr;
    if(market==='US'){h.a.refreshUS=async()=>m.request('US','context',{symbols:[symbol]});}
    h.reading();m.price(symbol,stopAt-1);if(market==='US')h.a.usQuotes=[{symbol,price:stopAt-1,timestamp:Date.now(),retrievedAt:Date.now()}];
    const e=h.arm({symbol,side:'Sell',quantity:10,conditions:[{expr:`price("${symbol}")`,op:'<=',value:stopAt}],purpose:'stop_loss'});
    m.fault('place-order','lost-unplaced');const r=await h.fire(e.id);assert.equal(r.status,'submitted',market+': '+r.outcome);
    const o=engine.orders().find(x=>x.symbol===symbol&&x.side==='Sell');assert.equal(o.status,'Uncertain');assert.equal(engine.enabled,false,market+': one open order at a time: the unclear reply stopped the market');
    const back=h.a.markNotTaken(market,o.id,'KIS NEVER TOOK IT');assert.deepEqual(back.rearmed.map(x=>x.id),[e.id],market);assert.equal(back.halted,true);
    const armed=()=>h.a.desk.orders(h.a.watchScope()).find(x=>x.id===e.id);assert.ok(armed(),market+': the stop is armed again');assert.ok(armed().notTakenAt);
    assert.equal(h.logs.filter(x=>x[0]===e.id&&x[2]==='Conditional order · armed again').length,1,market+': one line');
    assert.match(h.logs.find(x=>x[2]==='Conditional order · armed again')[3],/nothing is sent until you press Start/);
    assert.deepEqual(h.a.notTakenHeld().map(x=>[x.market,x.orders[0].symbol]),[[market,symbol]],market+': Home says so');
    for(let i=0;i<3;i++){const w=await h.fire(e.id);assert.equal(w.status,'armed',market+' while stopped: '+w.status+' '+(w.outcome??''));assert.match(w.waiting,/until you press Start/);}
    assert.equal(h.logs.filter(x=>x[0]===e.id&&x[2]==='Conditional order · waiting').length,0,market+': no line per check (the armed-again line says it) '+JSON.stringify(h.logs.filter(x=>x[0]===e.id).map(x=>x.slice(2))));
    assert.equal(m.book[market].filter(x=>x.kind==='order').length,0,market+': nothing sent while stopped');assert.equal(engine.enabled,false,'no automatic restart');
    h.enable();assert.deepEqual(h.a.notTakenHeld(),[],market+': Home\'s line goes once Start ran');
    const sent=await h.fire(e.id);assert.equal(sent.status,'submitted',market+' after Start: '+(sent.outcome??''));
    assert.equal(m.book[market].filter(x=>x.kind==='order'&&x.side==='Sell').length,1,market+': sent once');}
  // A market not stopped (several open): armed again and not held.
  {const m=new MockKis({kr:{cash:10000000,holdings:[{symbol:'990010',name:'990010',quantity:10,cost:11000,price:10000}]},prices:{'990010':10000}});const h=appHarness({mock:m,severalOpen:true}).enable();h.automation();h.reading();m.price('990010',9000);
    const e=h.arm({symbol:'990010',side:'Sell',quantity:10,conditions:[{expr:'price("990010")',op:'<=',value:9500}],purpose:'stop_loss'});m.fault('place-order','lost-unplaced');await h.fire(e.id);
    const o=h.kr.orders().find(x=>x.symbol==='990010');const back=h.a.markNotTaken('KR',o.id,'KIS NEVER TOOK IT');assert.equal(back.halted,false);assert.deepEqual(h.a.notTakenHeld(),[]);
    const sent=await h.fire(e.id);assert.equal(sent.status,'submitted',sent.outcome);}
  const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..',f),'utf8');
  assert.match(read('electron/main.cjs'),/ipcMain\.handle\('live:not-taken',liveAction\(\(id,phrase\)=>automation\.markNotTaken\('KR',id,phrase\)\)\)/);
  assert.match(read('electron/main.cjs'),/else if\(name==='not-taken'\)data=automation\.markNotTaken\('US',\.\.\.args\)/);
  assert.match(read('electron/main.cjs'),/for\(const n of automation\.notTakenHeld\?\.\(\)\?\?\[\]\)/);
});
test('fifth review 2: the confirmation shows what KIS listed (up to three rows), or that KIS showed none, and says when the market is stopped',async()=>{
  const {notTakenEvidence,notTakenDone}=await import('../src/not-taken.mjs');const t=Date.parse('2026-11-24T05:02:00Z');
  const row=(i,status)=>({orderId:'000090'+i,symbol:'990010',side:'Buy',quantity:i,status,timestamp:t});
  assert.deepEqual(notTakenEvidence({symbol:'990010',kisCandidates:[row(1,'Filled'),row(2,'Canceled'),row(3,'Pending'),row(4,'Filled')]},'KR'),['KIS shows: Buy 1 990010, filled, 14:02; Buy 2 990010, cancelled, 14:02; Buy 3 990010, open, 14:02']);
  assert.deepEqual(notTakenEvidence({symbol:'990010',kisCandidates:[]},'KR','halted'),['KIS showed no order like it.','Korean auto trading is stopped: a stop armed again sends nothing until you press Start.']);
  assert.deepEqual(notTakenEvidence({symbol:'NASD:XYZ',kisCandidates:[{...row(1,'Filled'),symbol:'NASD:XYZ',timestamp:null}]},'US'),['KIS shows: Buy 1 NASD:XYZ, filled']);
  assert.equal(notTakenDone({rearmed:[{symbol:'990010',purpose:'stop_loss'}],halted:true,market:'KR'}),'Counted as not sent; the stop for 990010 armed again. Nothing is sent until you press Start: Korean auto trading is stopped.');
  assert.equal(notTakenDone({rearmed:[],halted:false}),'Counted as not sent.');
  // The engine keeps the rows themselves (side, quantity, status, time) from the preparation's read of today's orders.
  const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..',f),'utf8');
  assert.match(read('src/LiveTrading.tsx'),/setMessage\(reply\.ok\?\(name==='not-taken'\?notTakenDone\(/);
});
test('fifth review 3: "KIS never took it" only for an Uncertain order, never while a send is in flight',()=>{
  const {LiveEngine}=require('../electron/live-engine.cjs');const rows=new Map([['S',{id:'S',status:'Submitting'}],['U',{id:'U',status:'Uncertain'}]]);
  const e=Object.assign(Object.create(LiveEngine.prototype),{busy:false,getState:()=>null,orders:()=>[...rows.values()],save:o=>rows.set(o.id,o)});
  assert.throws(()=>e.markNotTaken('S','KIS NEVER TOOK IT'),/UNKNOWN_ORDER/,'a Submitting order may still be on its way');
  e.busy=true;assert.throws(()=>e.markNotTaken('U','KIS NEVER TOOK IT'),/KIS_ORDER_BUSY/,'refused while a send is in flight');assert.equal(rows.get('U').status,'Uncertain');
  e.busy=false;e.markNotTaken('U','KIS NEVER TOOK IT');assert.equal(rows.get('U').notSentCause,'user-confirmed-not-taken');
});
test('fifth review 4: the secret is the file\'s: a value already there is used, never overwritten; a file replaced is read at the next sign-in',async()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');const clock={now:1_796_000_000_000};const real=Date.now;Date.now=()=>clock.now;
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'kis-clock-')),'clock.json');process.env.KIS_TOKEN_CLOCK=file;const hmac=v=>crypto.createHmac('sha256',v).update('fixture-key').digest('hex').slice(0,16);try{
    // The other worker made it first (the race lost): this one uses that value.
    const first='a'.repeat(64);fs.writeFileSync(file+'.secret',first);const s=kis2({clock});const c=new KisReadOnlyClient(credentials,s.transport,async ms=>{clock.now+=ms;});await c.getQuote('990010');
    assert.equal(fs.readFileSync(file+'.secret','utf8'),first,'never overwritten');assert.ok(fs.readFileSync(file,'utf8').includes(hmac(first)));
    // Replaced after this process used it: its next sign-in reads the new value.
    const second='b'.repeat(64);fs.writeFileSync(file+'.secret',second);clock.now+=120000;s.dead.add('k1');await c.getQuote('990010');
    assert.ok(fs.readFileSync(file,'utf8').includes(hmac(second)),'the next sign-in is noted under the file\'s value');
    // An invalid file is replaced, and the value used is what the file then holds.
    fs.writeFileSync(file+'.secret','not hex');clock.now+=120000;s.dead.add('k2');await c.getQuote('990010');const third=fs.readFileSync(file+'.secret','utf8');
    assert.match(third,/^[0-9a-f]{64}$/);assert.ok(fs.readFileSync(file,'utf8').includes(hmac(third)));
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n=>n.endsWith('.tmp')),[],'no temp file left');
  }finally{delete process.env.KIS_TOKEN_CLOCK;Date.now=real;}
});
test('sixth review 1: the evidence says the app has not checked KIS when it never read KIS\'s orders; a row shows only what it has',async()=>{
  const {notTakenEvidence}=await import('../src/not-taken.mjs');const NOT='The app has not checked KIS for this order. Look in KIS before you confirm.';
  assert.deepEqual(notTakenEvidence({symbol:'990010'},'KR'),[NOT],'an unclear reply: no list');
  assert.deepEqual(notTakenEvidence({symbol:'990010',kisCandidates:null},'KR'),[NOT]);
  assert.deepEqual(notTakenEvidence({symbol:'990010',kisCandidates:['0000900']},'KR'),[NOT],'a fourth-staging record of ids only');
  assert.deepEqual(notTakenEvidence({symbol:'990010',kisCandidates:[]},'KR'),['KIS showed no order like it.'],'an empty list after a real read');
  assert.deepEqual(notTakenEvidence({symbol:'990010',kisCandidates:[{orderId:'0000900',side:'Buy',symbol:'990010'}]},'KR'),['KIS shows: Buy 990010']);
  assert.deepEqual(notTakenEvidence({symbol:'990010',kisCandidates:[{orderId:'0000900'}]},'KR'),['KIS shows: order 0000900']);
  // The order made Uncertain by an unclear reply has no list: the confirmation says the app has not checked.
  const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');const m=new MockKis({kr:{cash:10000000},prices:{'990010':10000}});const h=appHarness({mock:m}).enable();
  m.fault('place-order','lost-unplaced');await h.send('KR','990010','Buy',1,10000);const u=h.kr.orders().find(o=>o.status==='Uncertain');assert.ok(u);assert.deepEqual(notTakenEvidence(u,'KR'),[NOT]);
});
test('sixth review 2: armed again keeps what the stop had: a short\'s cover stop (and syncShortStops arms no second one for the lot) and a trailing stop\'s level',async()=>{
  const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');const m=new MockKis({kr:{cash:10000000},prices:{'990010':10000,'990020':20000}});
  const h=appHarness({mock:m}).enable();h.automation();const scope=h.a.watchScope();const later=Date.now()+86400000;
  const uncertain=(id,symbol,side)=>h.kr.save({id,accountKey:'acct',source:'kis',environment:'mock',market:'KR',currency:'KRW',symbol,side,quantity:5,limitPrice:10000,status:'Uncertain',reason:'ORDER_UNCERTAIN',day:'2026-11-24',createdAt:Date.now()});
  // A short's cover stop, trailed, sent with an unclear reply.
  uncertain('P-COVER','990010','Buy');
  h.a.desk.update({id:'C-COVER',scope,status:'submitted',proposalId:'P-COVER',symbol:'990010',side:'Buy',quantity:5,purpose:'stop_loss',combine:'all',conditions:[{expr:'price("990010")',op:'>=',value:10800}],credit:{kind:'cover',loanDate:'2026-11-20',source:'distribution'},armedBy:'app',shortTrail:{low:9400,at:1,lineAt:null},expiresAt:later,createdAt:Date.now()},{});
  // A long trailing stop, sent with an unclear reply.
  uncertain('P-TRAIL','990020','Sell');
  h.a.desk.update({id:'C-TRAIL',scope,status:'submitted',proposalId:'P-TRAIL',symbol:'990020',side:'Sell',quantity:5,purpose:'stop_loss',combine:'all',conditions:[{expr:'price("990020")',op:'<=',value:19200}],trail:{pct:4,high:20000,level:19200,active:true,awaitingFill:false},expiresAt:later,createdAt:Date.now()},{});
  h.kr.severalOpenFixed=true;
  const lines=()=>h.logs.filter(x=>x[2]==='Conditional order · armed again');
  h.a.markNotTaken('KR','P-COVER','KIS NEVER TOOK IT');assert.equal(lines().length,1,'one line per not-taken');
  h.a.markNotTaken('KR','P-TRAIL','KIS NEVER TOOK IT');assert.equal(lines().length,2,'one more line for the second, none repeated');assert.deepEqual(lines().map(x=>x[0]),['C-COVER','C-TRAIL']);
  const get=id=>h.a.desk.orders(scope).find(o=>o.id===id);
  const cover=get('C-COVER');assert.equal(cover.status,'armed');assert.deepEqual(cover.credit,{kind:'cover',loanDate:'2026-11-20',source:'distribution'});assert.equal(cover.conditions[0].value,10800,'its trailed level');assert.deepEqual(cover.shortTrail,{low:9400,at:1,lineAt:null});assert.equal(cover.armedBy,'app');
  assert.deepEqual(h.a.shortLotDecision(scope,{symbol:'990010',loanDate:'2026-11-20',quantity:5}),{covered:'armed'},'syncShortStops sees the lot covered by it: no second cover stop');
  const trail=get('C-TRAIL');assert.equal(trail.status,'armed');assert.equal(trail.conditions[0].value,19200,'the trailing level kept');assert.deepEqual(trail.trail,{pct:4,high:20000,level:19200,active:true,awaitingFill:false});
});
test('sixth review 3: with orders watched while stopped, the permit is granted again after not-taken: the words say it is armed and still watched, not "nothing is sent"',async()=>{
  const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
  const m=new MockKis({kr:{cash:10000000,holdings:[{symbol:'990010',name:'990010',quantity:10,cost:11000,price:10000}]},prices:{'990010':10000}});const h=appHarness({mock:m,severalOpen:false}).enable();h.automation();h.reading();m.price('990010',9000);
  const e=h.arm({symbol:'990010',side:'Sell',quantity:10,conditions:[{expr:'price("990010")',op:'<=',value:9500}],purpose:'stop_loss'});m.fault('place-order','lost-unplaced');await h.fire(e.id);
  const o=h.kr.orders().find(x=>x.symbol==='990010');assert.equal(h.kr.enabled,false);
  // Orders watched while stopped (the setting on, this account): syncConditionalPermits grants the permit again once nothing is unclear.
  const real=h.a.syncConditionalPermits.bind(h.a);h.a.syncConditionalPermits=()=>{if(!h.a.unclearOpen(h.kr))h.kr.permitConditional({account:h.kr.identity(),auto:true});};
  const back=h.a.markNotTaken('KR',o.id,'KIS NEVER TOOK IT');assert.equal(back.halted,false);assert.equal(back.watched,true);
  const line=h.logs.find(x=>x[0]===e.id&&x[2]==='Conditional order · armed again')[3];assert.match(line,/orders are watched while stopped: it may be sent before you press Start/);assert.doesNotMatch(line,/nothing is sent/);
  const armed=h.a.desk.orders(h.a.watchScope()).find(x=>x.id===e.id);assert.equal(armed.waiting,'KIS never took its order; armed again, watched while auto trading is stopped');
  assert.deepEqual(h.a.notTakenHeld(),[],'Home does not say nothing is sent');
  const {notTakenDone,notTakenEvidence}=await import('../src/not-taken.mjs');assert.equal(notTakenDone(back),'Counted as not sent; the stop for 990010 armed again. It is watched while auto trading is stopped, so it may be sent before you press Start.');
  assert.equal(notTakenEvidence(o,'KR','running').length,1,'no line while trading runs');
  const sent=await h.fire(e.id);assert.equal(sent.status,'submitted','sent under the permit, as the setting says: '+(sent.outcome??''));assert.equal(h.kr.enabled,false,'trading not restarted');
  h.a.syncConditionalPermits=real;
  const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..',f),'utf8');assert.match(read('src/LiveTrading.tsx'),/notTakenEvidence\(order,us\?'US':'KR',state\.enabled\?'running':\(state as \{notTakenOutlook\?:string\}\)\.notTakenOutlook\?\?'unknown'\)/);
});
test('sixth review 4: the clock file\'s temp file is removed when its rename fails',()=>{
  const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..',f),'utf8');
  assert.match(read('electron/kis-client.cjs'),/fsx\.writeFileSync\(tmp,JSON\.stringify\(v\)\);try\{fsx\.renameSync\(tmp,f\);\}catch\{try\{fsx\.unlinkSync\(tmp\);\}catch\{\}\}/);
});
test('seventh review: the line before the confirmation says what will hold after it, decided in the main process by the permit rule (real syncConditionalPermits)',async()=>{
  const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');const {notTakenEvidence}=await import('../src/not-taken.mjs');
  const WATCHED='Korean auto trading is stopped, but orders are watched while stopped: a stop armed again may be sent right away.',HALTED='Korean auto trading is stopped: a stop armed again sends nothing until you press Start.';
  // What the screen shows, from the engine's state as the screen reads it (LiveTrading: enabled → 'running', else notTakenOutlook ?? 'unknown').
  const screen=(h,o)=>{const s=h.kr.getState();return notTakenEvidence(o,'KR',s.enabled?'running':s.notTakenOutlook??'unknown').slice(1);};
  const world=({watch,second=false})=>{const m=new MockKis({kr:{cash:10000000,holdings:[{symbol:'990010',name:'990010',quantity:10,cost:11000,price:10000},{symbol:'990020',name:'990020',quantity:10,cost:21000,price:20000}]},prices:{'990010':10000,'990020':20000}});
    const h=appHarness({mock:m,severalOpen:false}).enable();h.automation();h.reading();h.kr.notTakenOutlook=()=>h.a.notTakenOutlook('KR');// as main.cjs wires it
    if(watch){h.a.setWatchWhileStopped(true,'WATCH WHILE STOPPED MOCK');h.a.watchStarted();}
    m.price('990010',9000);const e=h.arm({symbol:'990010',side:'Sell',quantity:10,conditions:[{expr:'price("990010")',op:'<=',value:9500}],purpose:'stop_loss'});
    return {m,h,e};};
  // The setting on: the unclear reply revoked the permit; the line says what holds after: may be sent right away.
  {const {m,h,e}=world({watch:true});
    m.fault('place-order','lost-unplaced');await h.fire(e.id);h.a.syncConditionalPermits();assert.equal(h.kr.enabled,false);assert.equal(h.kr.permitHolds(),false,'the unclear reply revoked the permit');
    const o=h.kr.orders().find(x=>x.status==='Uncertain');assert.equal(h.kr.getState().notTakenOutlook,'watched');assert.deepEqual(screen(h,o),[WATCHED]);
    const back=h.a.markNotTaken('KR',o.id,'KIS NEVER TOOK IT');assert.equal(back.watched,true,'and it is true after: the real path granted the permit again');assert.equal(h.kr.permitHolds(),true);assert.equal(back.halted,false);}
  // The setting off: nothing is sent until Start.
  {const {m,h,e}=world({watch:false});m.fault('place-order','lost-unplaced');await h.fire(e.id);const o=h.kr.orders().find(x=>x.status==='Uncertain');
    assert.equal(h.kr.getState().notTakenOutlook,'halted');assert.deepEqual(screen(h,o),[HALTED]);assert.equal(h.a.markNotTaken('KR',o.id,'KIS NEVER TOOK IT').halted,true);}
  // The setting on, but another unclear order still open in that market: halted.
  {const {h}=world({watch:true});const mk=(id,symbol)=>h.kr.save({id,accountKey:'acct',source:'kis',environment:'mock',market:'KR',currency:'KRW',symbol,side:'Sell',quantity:1,limitPrice:9000,status:'Uncertain',reason:'ORDER_UNCERTAIN',day:'2026-11-24',createdAt:Date.now()});
    mk('U1','990010');mk('U2','990020');h.kr.enabled=false;h.kr.revokeConditional();
    assert.equal(h.kr.getState().notTakenOutlook,'halted');assert.deepEqual(screen(h,h.kr.orders().find(o=>o.id==='U1')),[HALTED]);
    const back=h.a.markNotTaken('KR','U1','KIS NEVER TOOK IT');assert.equal(back.halted,true,'true after: the other unclear order keeps the permit away');assert.equal(h.kr.permitHolds(),false);}
  // Trading running: no line; not decided: the "may be sent" line, never a promise that nothing is sent.
  {const {h}=world({watch:false});assert.equal(h.kr.getState().notTakenOutlook,undefined,'no Uncertain order: no outlook');
    assert.deepEqual(notTakenEvidence({kisCandidates:[]},'KR','running').slice(1),[]);assert.deepEqual(notTakenEvidence({kisCandidates:[]},'KR','unknown').slice(1),[WATCHED]);}
  const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,'..',f),'utf8');
  assert.match(read('electron/main.cjs'),/live\.notTakenOutlook=\(\)=>automation\.notTakenOutlook\('KR'\);usLive\.notTakenOutlook=\(\)=>automation\.notTakenOutlook\('US'\);/);
});
