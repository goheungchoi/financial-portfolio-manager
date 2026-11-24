// 2026-11-19 order-rule audit, item 3 (artifacts/reviews/2026-11-19-order-rule-audit): a U.S. order request refused
// at its check (price moved, capacity, another open order, an invalid order) kept no code: the worker relabelled it
// US_REQUEST_FAILED, which no order outcome names, so the review failed. The codes are now checked as the app receives
// them, after the worker's relabelling (worker-codes.cjs), for both markets. Mock KIS and fake engines only.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const O=require('../electron/order-outcomes.cjs');const {relayCode}=require('../electron/worker-codes.cjs');const {publicUSCode}=require('../electron/us-errors.cjs');
const {MockKis}=require('./helpers/mock-kis.cjs');const {appHarness}=require('./helpers/app-harness.cjs');
const thrown=file=>[...fs.readFileSync(path.join(__dirname,'..','electron',file),'utf8').matchAll(/new (?:Error|KisError)\(\s*'([A-Z][A-Z0-9_]{2,})'/g)].map(m=>m[1]);

// Thrown by the history reads only, never by an order request: INVALID_DATE_RANGE (both clients' order history) and
// INVALID_INSTRUMENT (the Korean minute, daily and research reads).
const READS_ONLY=new Set(['INVALID_DATE_RANGE','INVALID_INSTRUMENT']);
test('every code a broker client throws on an order request reaches the app with a class, and every ORDER code keeps its own code',()=>{
  for(const [file,ops] of [['kis-overseas.cjs',['us-prepare-order','us-place-order','us-revise-order']],['kis-client.cjs',['prepare-order','place-order','revise-order']]])
    for(const code of new Set(thrown(file)))if(!READS_ONLY.has(code))for(const op of ops){const got=relayCode(op,new Error(code));
      assert.notEqual(O.classOf(got),'unknown',`${file} ${code} on ${op} arrives as ${got}`);
      if(O.ORDER.has(code))assert.equal(got,code,`${file} ${code} on ${op} keeps its code`);}
  assert.equal(relayCode('place-order',new Error('CREDIT_PATH_UNVERIFIED')),'CREDIT_PATH_UNVERIFIED','the Korean credit backstop keeps its code');
});
test('the U.S. reads are unchanged: an order code from a balance or quote read is still US_REQUEST_FAILED',()=>{
  for(const op of ['us-context','us-balance','us-quote','us-orders'])assert.equal(relayCode(op,new Error('PRICE_MOVED')),'US_REQUEST_FAILED',op);
  assert.equal(publicUSCode('INSUFFICIENT_CAPACITY'),'US_REQUEST_FAILED','without order: as before (main.cjs refresh sites)');
  assert.equal(relayCode('us-prepare-order',new Error('my-private-key')),'US_REQUEST_FAILED','no free text');
  assert.equal(relayCode('us-place-order',Object.assign(new Error('RATE_LIMITED'),{notSent:true})),'ORDER_NOT_SENT','M-1a unchanged');
  assert.equal(relayCode('prepare-order',new Error('SOMETHING_NEW')),'REQUEST_FAILED','Korea unchanged');
  // Shorts on, stage 1b: the worker's whole reply is worker-codes errorReply, whose code is relayCode.
  assert.ok(fs.readFileSync(require.resolve('../electron/kis-worker.cjs'),'utf8').includes("postMessage(require('./worker-codes.cjs').errorReply(id,operation,error))"),'the worker uses it');
  assert.equal(require('../electron/worker-codes.cjs').errorReply(1,'us-balance',new Error('PRICE_MOVED')).code,'US_REQUEST_FAILED');
});

// The U.S. engine behind a broker that relabels its errors as the worker does.
const usHarness=({prepare=null,place=null}={})=>{const m=new MockKis({us:{cash:5000,holdings:[{symbol:'NASD:GOOGL',name:'G',quantity:5,cost:250,price:285}]},prices:{'NASD:GOOGL':285}});
  if(prepare)m.fault('prepare-order',{fail:prepare});if(place)m.fault('place-order',{fail:place});
  const real=m.broker('US');m.broker=market=>market==='US'?{request:(op,p)=>real.request(op,p).catch(e=>{throw Object.assign(new Error(relayCode(op==='live-context'?'us-context':'us-'+op,e)),{brokerCode:e.brokerCode});})}:MockKis.prototype.broker.call(m,market);
  return appHarness({mock:m}).enable();};
test('a U.S. sale whose check finds the price moved: refused as PRICE_MOVED, the order not sent and still Ready',async()=>{
  const h=usHarness({prepare:'PRICE_MOVED'});const p=h.us.propose({symbol:'NASD:GOOGL',side:'Sell',quantity:1,limitPrice:285});
  await assert.rejects(h.us.submit(p.id,'PLACE MOCK ORDER'),/^Error: PRICE_MOVED$/);assert.equal(h.us.orders().find(o=>o.id===p.id).status,'Ready');});
test('a U.S. placement with an unclear reply: ORDER_UNCERTAIN, the order Uncertain (as before, the safe direction)',async()=>{
  const h=usHarness({place:'ORDER_UNCERTAIN'});const p=h.us.propose({symbol:'NASD:GOOGL',side:'Sell',quantity:1,limitPrice:285});
  const o=await h.us.submit(p.id,'PLACE MOCK ORDER');assert.equal(o.status,'Uncertain');assert.equal(o.reason,'ORDER_UNCERTAIN');});

// The review, as single-order-outcome.test.cjs runs it, with the code the app now receives.
const {DatabaseSync}=require('node:sqlite');const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const T=require('../electron/activity-today.cjs');
async function review(code,sentAs=null){const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'F',price:100}],()=>[]);const events=[];const intents=new Map();
  const make=(market,open,symbol,price)=>({market,enabled:true,getState:()=>({loss:null}),orders:()=>[...intents.values()],
    context:async()=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity:1000,cash:500,positions:{'NASD:GOOGL':{quantity:1}},universe:[{symbol,price}],quotes:[{symbol,price,stale:!open}],orders:[],risk:{baseline:1000,lossLimit:{mode:'off',value:0}},marketSession:{open,status:open?'open':'closed'}}),
    propose:command=>{const p={id:'P1',status:'Ready',...command,createdAt:Date.now()};intents.set('P1',p);return p;},annotate:(id,patch)=>{intents.set(id,{...intents.get(id),...patch});return intents.get(id);},
    autoSubmit:async()=>{if(sentAs)intents.set('P1',{...intents.get('P1'),status:sentAs});throw new Error(code);},autoEnabled:true,identity:()=>'acct'+market});
  const a=new Automation(db,paper,{request:async()=>({provider:'openai',decision:{action:'Sell',symbol:'NASD:GOOGL',quantity:1,credit:'none',loanDate:'',explanation:'Exit.'}})},(id,kind,title,body)=>events.push({title,body}));a.live=make('KR',false,'005930',70000);a.usLive=make('US',true,'NASD:GOOGL',285);
  a.refreshUS=async()=>{};a.fx=()=>({usdKRW:1400,source:'fixture'});a.providerStatus.aiConnected=true;a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:278.4,ask:278.6}});a.requestReview=()=>{};
  a.configure({scope:'both',provider:'openai',shareKisWithOpenAI:true,autoSubmit:true});const error=await a.review().then(()=>null,e=>e);
  const record=db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get();return {a,events,intents,error,record:record?JSON.parse(record.payload):null};}
test('a U.S. sale refused with PRICE_MOVED: the review completes and the order reads "Not sent" with its reason',async()=>{
  const code=relayCode('us-prepare-order',new Error('PRICE_MOVED'));assert.equal(code,'PRICE_MOVED');
  const {a,events,intents,error,record}=await review(code);assert.equal(error,null);assert.equal(a.guardrails.failureStreak,0);
  assert.equal(record.executionNote,`Not sent: Sell 1 NASD:GOOGL: ${T.reasonText('PRICE_MOVED')}.`);assert.ok(events.some(e=>e.title==='Order not sent'));
  assert.equal(intents.get('P1').status,'Rejected');});
test('a U.S. ORDER_UNCERTAIN still fails the review and leaves the order Uncertain',async()=>{
  const code=relayCode('us-place-order',new Error('ORDER_UNCERTAIN'));assert.equal(code,'ORDER_UNCERTAIN');
  const {a,events,intents,error}=await review(code,'Uncertain');assert.equal(error?.message,'REVIEW_FAILED');assert.ok(events.some(e=>e.title==='Review failed'));
  assert.equal(a.guardrails.failureStreak,1);assert.equal(intents.get('P1').status,'Uncertain');});
