// 2026-11-19 order-rule audit, item 13 (artifacts/reviews/2026-11-19-order-rule-audit): the STOP codes had no words
// (DISABLED_OR_EXPIRED, DAILY_SESSION_SETUP_REQUIRED, FUNDING_OVERCOMMITTED and others showed as raw codes). Every STOP
// code now has a sentence, and a review stopped by one says it on its failure line. Fake engines only.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const O=require('../electron/order-outcomes.cjs');const T=require('../electron/activity-today.cjs');
const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');

test('every STOP code has a sentence (a new STOP code needs one)',()=>{for(const c of O.STOP)assert.ok(T.NOT_SENT[c],c);
  assert.equal(T.reasonText('DISABLED_OR_EXPIRED'),'trading was switched off or the order expired (2 minutes after it was made)');});

async function review(error){const db=new DatabaseSync(':memory:');const paper=new PaperEngine(db,[{symbol:'005930',name:'F',price:100}],()=>[]);const events=[];
  const a=new Automation(db,paper,{request:async()=>({provider:'openai',decision:{action:'Buy',symbol:'005930',quantity:1,credit:'none',loanDate:'',explanation:'Buy.'}})},(id,kind,title,body)=>events.push({title,body}));
  a.live={market:'KR',enabled:true,getState:()=>({loss:null}),orders:()=>[],identity:()=>'acct',autoEnabled:true,
    context:async()=>({environment:'kis',market:'KR',currency:'KRW',equity:1000000,cash:500000,positions:{},universe:[{symbol:'005930',price:70000}],quotes:[{symbol:'005930',price:70000}],orders:[],risk:{baseline:1000000,lossLimit:{mode:'off',value:0}},marketSession:{open:true,status:'open'}}),
    propose:command=>({id:'P1',status:'Ready',...command,createdAt:Date.now()}),annotate:()=>null,autoSubmit:async()=>{throw error;}};
  a.providerStatus.aiConnected=true;a.orderBook=async()=>({status:'available',retrievedAt:Date.now(),data:{bid:69900,ask:70000}});a.requestReview=()=>{};
  a.configure({scope:'kis',provider:'openai',shareKisWithOpenAI:true,autoSubmit:true});await a.review().catch(()=>{});return events.find(e=>e.title==='Review failed');}
test('a review stopped by DAILY_SESSION_SETUP_REQUIRED says why on its failure line',async()=>{
  const line=await review(new Error('DAILY_SESSION_SETUP_REQUIRED'));assert.ok(line,'logged');
  assert.ok(line.body.includes('DAILY_SESSION_SETUP_REQUIRED: today\'s trading session is not set up yet (switch the market\'s trading on again). '),line.body);});
test('a KIS request failure keeps the B(2) line, without the STOP sentence',async()=>{
  const line=await review(Object.assign(new Error('REQUEST_FAILED'),{kisOperation:'prepare-order'}));assert.ok(line);
  assert.match(line.body,/KIS REQUEST_FAILED on prepare-order\. /);assert.ok(!line.body.includes('a KIS request failed'));});
test('an error the app does not know gets no sentence',async()=>{
  const line=await review(new Error('SOMETHING_NEW'));assert.ok(line);assert.ok(!line.body.includes('SOMETHING_NEW:'));});
