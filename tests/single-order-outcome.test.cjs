// 2026-11-19 overnight failures, A(b) (artifacts/reviews/2026-11-19-overnight-failures, ruled): a single order refused
// with an ORDER code (order-outcomes.cjs) no longer fails the review. The review completes; the order is "Not sent"
// with its reason in words, or "Rejected by KIS" (with KIS's code) when KIS refused it; the intent is Rejected when it
// never reached KIS; no follow-up review; the consecutive-failure guardrail and the no-review alert are not fed. An
// order whose state at KIS is unknown (ORDER_UNCERTAIN, BROKER_ORDER_MISMATCH), STOP and unknown codes fail the review
// as before. The next review is told its last order was not placed and why; a pending decision is not closed as
// carried out. Fake engines and a fake provider only: no broker, no AI call.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
const O=require('../electron/order-outcomes.cjs');const T=require('../electron/activity-today.cjs');
const decision={action:'Sell',symbol:'NASD:GOOGL',quantity:1,credit:'none',loanDate:'',explanation:'Exit.'};
// code: what the submit throws; sentAs: the intent's status before it throws; brokerCode: on the thrown error;
// returned: the submit returns the intent with these fields instead (a placement KIS refused).
async function review(code,{decide=decision,sentAs=null,brokerCode=null,returned=null}={}){const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'F',price:100}],()=>[]);const events=[];const intents=new Map();
  const make=(market,open,symbol,price)=>({market,enabled:true,getState:()=>({loss:null}),orders:()=>[...intents.values()],
    context:async()=>({environment:'kis',market,currency:market==='US'?'USD':'KRW',equity:1000,cash:500,positions:{'NASD:GOOGL':{quantity:1}},universe:[{symbol,price}],quotes:[{symbol,price,stale:!open}],orders:[],risk:{baseline:1000,lossLimit:{mode:'off',value:0}},marketSession:{open,status:open?'open':'closed'}}),
    propose:command=>{const p={id:'P1',status:'Ready',...command,createdAt:Date.now()};intents.set('P1',p);return p;},annotate:(id,patch)=>{intents.set(id,{...intents.get(id),...patch});return intents.get(id);},
    autoSubmit:async()=>{if(sentAs)intents.set('P1',{...intents.get('P1'),status:sentAs});if(code)throw Object.assign(new Error(code),brokerCode?{brokerCode}:{});
      if(returned){intents.set('P1',{...intents.get('P1'),...returned});return {...intents.get('P1')};}return {id:'O1',status:'Accepted'};},autoEnabled:true,identity:()=>'acct'+market});
  const a=new Automation(db,paper,{request:async()=>({provider:'openai',decision:decide})},(id,kind,title,body)=>events.push({title,body}));a.live=make('KR',false,'005930',70000);a.usLive=make('US',true,'NASD:GOOGL',285);
  a.refreshUS=async()=>{};a.fx=()=>({usdKRW:1400,source:'fixture'});a.providerStatus.aiConnected=true;a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:278.4,ask:278.6}});
  const asked=[];a.requestReview=(...x)=>asked.push(x);
  a.configure({scope:'both',provider:'openai',shareKisWithOpenAI:true,autoSubmit:true});const error=await a.review().then(()=>null,e=>e);
  const record=db.prepare('SELECT payload FROM reviews ORDER BY rowid DESC LIMIT 1').get();return {a,db,events,intents,error,asked,record:record?JSON.parse(record.payload):null};}

test('every ORDER code has a reason in words',()=>{for(const c of O.ORDER)assert.ok(T.NOT_SENT[c],c);assert.equal(T.reasonText('SOMETHING_NEW'),'something new','an unknown code: lower case, as before');});

for(const code of [...O.ORDER].filter(c=>!['ORDER_UNCERTAIN','BROKER_ORDER_MISMATCH','BROKER_REJECTED'].includes(c)))
  test(`ORDER ${code}: the review completes, the order is Not sent with its reason, the intent Rejected, no follow-up, no failure counted`,async()=>{
    const {a,events,intents,error,asked,record}=await review(code);
    assert.equal(error,null,'the review completes');assert.ok(!events.some(e=>e.title==='Review failed'));assert.equal(a.guardrails.failureStreak,0);
    assert.equal(record.executionNote,`Not sent: Sell 1 NASD:GOOGL: ${T.reasonText(code)}.`);assert.ok(events.some(e=>e.title==='Order not sent'&&e.body===record.executionNote));
    assert.equal(intents.get('P1').status,'Rejected');assert.equal(intents.get('P1').reason,code);assert.equal(asked.length,0,'no follow-up review');});

for(const code of ['ORDER_UNCERTAIN','BROKER_ORDER_MISMATCH'])
  test(`ORDER ${code}: the order's state at KIS is unknown, so the review fails as before and the intent is left for reconciliation`,async()=>{
    const {a,events,intents,error}=await review(code,{sentAs:'Uncertain'});
    assert.equal(error?.message,'REVIEW_FAILED');assert.ok(events.some(e=>e.title==='Review failed'));assert.equal(a.guardrails.failureStreak,1);
    assert.equal(intents.get('P1').status,'Uncertain','left for reconciliation');assert.equal(intents.get('P1').reason,undefined);});

test('BROKER_REJECTED thrown (KIS refused the broker check): "Rejected by KIS" with its code; the review completes',async()=>{
  const {a,error,events,intents,record,asked}=await review('BROKER_REJECTED',{brokerCode:'APBK0919'});
  assert.equal(error,null);assert.equal(a.guardrails.failureStreak,0);assert.equal(record.executionNote,'Rejected by KIS: Sell 1 NASD:GOOGL (KIS APBK0919).');
  assert.ok(events.some(e=>e.title==='Order rejected by KIS'&&e.body===record.executionNote));
  assert.equal(intents.get('P1').status,'Rejected');assert.equal(intents.get('P1').reason,'BROKER_REJECTED');assert.equal(asked.length,0);});

test('BROKER_REJECTED at placement (the send returns the order Rejected): "Rejected by KIS" with its code; Home reads it',async()=>{
  const {error,record,events}=await review(null,{returned:{status:'Rejected',reason:'BROKER_REJECTED',brokerCode:'APBK0919'}});
  assert.equal(error,null);assert.equal(record.executionNote,'Rejected by KIS: Sell 1 NASD:GOOGL (KIS APBK0919).');assert.ok(events.some(e=>e.title==='Order rejected by KIS'));
  assert.ok(fs.readFileSync(require.resolve('../src/Dashboard.tsx'),'utf8').includes("/^Rejected by KIS:/.test(n)?'Rejected by KIS'"),'Home');
  assert.ok(fs.readFileSync(require.resolve('../electron/live-engine.cjs'),'utf8').includes("...(error.message==='BROKER_REJECTED'?(r=>({...(/^[A-Z0-9_-]{1,24}$/.test(r.brokerCode??'')?{brokerCode:r.brokerCode}:{})"),'the send keeps KIS\'s code (shorts on: the first refusal\'s when the loan date was tried twice)');});

for(const code of ['AUTH_FAILED','BROKER_UNAVAILABLE','ACCOUNT_CHANGED','SOMETHING_NEW'])
  test(`${O.classOf(code).toUpperCase()} ${code}: the review fails as before`,async()=>{
    const {a,events,error}=await review(code);assert.equal(error?.message,'REVIEW_FAILED');assert.ok(events.some(e=>e.title==='Review failed'));assert.equal(a.guardrails.failureStreak,1);});

async function nextReviewSees(a){let seen=null;a.provider={request:async(op,p)=>{seen=p.context.previousReview;return {provider:'openai',decision:{action:'Hold',symbol:'',quantity:0,credit:'none',loanDate:'',explanation:'Hold.'}};}};await a.review().catch(()=>{});return seen;}
test('the next review is told its last order was not placed, and why: not sent, or rejected by KIS',async()=>{
  const n=await review('DAILY_TURNOVER_LIMIT',{decide:{...decision,action:'Buy'}});const p=await nextReviewSees(n.a);
  assert.equal(p.action,'Buy');assert.equal(p.sent,false);assert.equal(p.notPlaced,n.record.executionNote);assert.equal(p.notPlaced,"Not sent: Buy 1 NASD:GOOGL: the day's turnover limit is reached.");
  const k=await review(null,{returned:{status:'Rejected',reason:'BROKER_REJECTED',brokerCode:'APBK0919'}});const q=await nextReviewSees(k.a);
  assert.equal(q.sent,false);assert.equal(q.notPlaced,'Rejected by KIS: Sell 1 NASD:GOOGL (KIS APBK0919).');
  const ok=await review(null);const r=await nextReviewSees(ok.a);assert.equal(r.sent,true);assert.equal('notPlaced' in r,false);});

test('a pending decision is not closed as carried out by an order that did not go out',()=>{
  assert.ok(fs.readFileSync(require.resolve('../electron/automation.cjs'),'utf8').includes("orderId:order?.id&&!['Rejected','Ready'].includes(order.status)?order.id:null,"));});

// B(2): a review that fails on a KIS request names the code, KIS's code and the request (01:22 read only REVIEW_FAILED).
test('B(2): a review failing at the account read names "KIS {code} (KIS {code}) on {request}"',async()=>{
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'F',price:100}],()=>[]);const events=[];
  const a=new Automation(db,paper,{request:async()=>({provider:'openai',decision})},(id,kind,title,body)=>events.push({title,body}));
  const fail=Object.assign(new Error('REQUEST_TIMEOUT'),{kisOperation:'live-context',brokerCode:'EGW00201'});
  a.live={market:'KR',enabled:true,getState:()=>({loss:null}),orders:()=>[],context:async()=>{throw fail;},identity:()=>'acct',autoEnabled:true};a.providerStatus.aiConnected=true;
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true});const e=await a.review().catch(x=>x);assert.equal(e.message,'REVIEW_FAILED');
  const line=events.find(x=>x.title==='Review failed');assert.ok(line,'logged');assert.match(line.body,/^REVIEW_FAILED · KIS REQUEST_TIMEOUT \(KIS EGW00201\) on live-context\. /);});
test('B(2): an AI provider error at the decision gives no "KIS" prefix',async()=>{
  const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'F',price:100}],()=>[]);const events=[];
  const a=new Automation(db,paper,{request:async()=>{throw new Error('RATE_LIMITED');}},(id,kind,title,body)=>events.push({title,body}));
  a.live={market:'KR',enabled:true,getState:()=>({loss:null}),orders:()=>[],context:async()=>({environment:'kis',market:'KR',currency:'KRW',equity:1000,cash:500,positions:{},universe:[{symbol:'005930',price:1}],quotes:[{symbol:'005930',price:1}],orders:[],risk:{baseline:1000,lossLimit:{mode:'off',value:0}},marketSession:{open:true,status:'open'}}),identity:()=>'acct',autoEnabled:true};
  a.providerStatus.aiConnected=true;a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true});await a.review().catch(()=>{});
  const line=events.find(x=>x.title==='Review failed');assert.ok(line);assert.doesNotMatch(line.body,/KIS /);});
