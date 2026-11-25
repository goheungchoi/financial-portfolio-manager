// Shorts on, stage 1b (artifacts/reviews/2026-11-25-shorts-on/review-stage1.md): the switch off keeps 1.5.74 for shorts
// the app did not open; the loan-date record crosses the worker and the service into the engine. Fake broker and fake
// transport; made-up codes (99xxxx), prices, quantities and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {Exposure}=require('../electron/exposure.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const CP=require('../electron/credit-paths.cjs');const WC=require('../electron/worker-codes.cjs');
const reply=body=>new Response(JSON.stringify(body),{headers:{tr_cont:''}});
const creds={environment:'live',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const HAND={symbol:'990020',quantity:3,price:2000,loanAmount:6000,entryPrice:1800,proceeds:5400,loanDate:'2026-09-24',expiry:null,source:'self'};
const APP={symbol:'990010',quantity:2,price:1000,loanAmount:2000,entryPrice:1000,proceeds:2000,loanDate:'2026-10-13',expiry:null,source:'distribution'};
const balance={environment:'live',reportedTotal:10000000,cash:2000000,loanTotal:0,holdings:[],shorts:[HAND,APP]};
// An engine on the live account with the two made-up shorts; appShort: the app's own filled short of 990010 (lot APP).
function engine({switchOn=false,appShort=true,place=null}={}){
  const d=new DatabaseSync(':memory:');const snapshot={...balance,accountKey:'acct'};const calls=[];
  const l=new LiveEngine(d,{request:async(op,payload)=>{calls.push([op,payload]);if(op==='prepare-order')return {ticket:'t',balance:snapshot};if(op==='place-order'){if(place)return place(payload);return {brokerOrderId:'9'};}throw new Error(op);}},()=>({status:'connected',snapshot}));
  l.exposure=new Exposure(d);l.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');l.exposure.savePolicy('acct',{short:{enabled:switchOn,auto:false}});
  if(appShort)l.writeOrder({id:'S0',accountKey:'acct',symbol:'990010',side:'Sell',quantity:2,filled:2,status:'Filled',credit:{kind:'short',type:'22'},lotLoanDate:'2026-10-13',lotTie:{loanDate:'2026-10-13',at:1,how:'exact'},createdAt:1,expiresAt:1});
  return {l,calls};}
const cover=(symbol,loanDate)=>({symbol,side:'Buy',quantity:1,limitPrice:symbol==='990010'?1000:2000,credit:{kind:'cover',loanDate}});
test('switch off: a cover of a short opened in KIS is refused as in 1.5.74; the app\'s own short keeps its buy-back',()=>{
  const {l}=engine({switchOn:false});
  assert.throws(()=>l.propose(cover('990020','2026-09-24')),/CREDIT_PATH_UNVERIFIED/,'a short the app did not open: as 1.5.74');
  const own=l.propose(cover('990010','2026-10-13'));assert.equal(own.status,'Ready');assert.equal(own.credit.kind,'cover');assert.equal(own.requiresApproval,false,'a protective close, automatic');
  assert.equal(l.shortsOnFor({kind:'short'},'990010'),false,'never a new short with the switch off');assert.equal(l.shortsOnFor({kind:'cover',loanDate:'2026-09-24'},'990020'),false);
  const on=engine({switchOn:true}).l;assert.equal(on.propose(cover('990020','2026-09-24')).status,'Ready','switch on: a short opened in KIS can be bought back by the app');
});
test('switch off with no app short: the review\'s credit paths are 1.5.74\'s byte for byte',()=>{
  // 1.5.74 (HEAD a78ac3a5) credit-paths text for the two paths, as the review read it.
  const HEAD={short:{executable:false,automatic:false,reason:'the loan date a new short sends (U1), the borrowable quantity (U3, lendable_by_company fields) and how a short row appears in the balance (U5) are not confirmed',label:CP.OPENINGS_LABEL},
    cover:{executable:false,automatic:false,reason:'how a cover names the short lot it repays (LOAN_DT for CRDT_TYPE 26/28, U2) and how the short row appears in the balance (U5) are not confirmed',label:CP.PROTECTION_LABEL}};
  for(const approved of [false,true])for(const k of ['short','cover'])assert.deepEqual(CP.pathStatus(k,{approved}),HEAD[k],k);
  const {l}=engine({switchOn:false,appShort:false});const value={balance:{...balance,accountKey:'acct'},quotes:[]};const credit=l.productRisk(value).productRisk.credit;
  assert.deepEqual({short:credit.effective.short,cover:credit.effective.cover},HEAD,'the context, no app short held');
  const held=engine({switchOn:false,appShort:true}).l.productRisk(value).productRisk.credit;assert.equal(held.effective.cover.executable,true,'an app short held: its cover can be sent, and the review is told so');assert.deepEqual(held.effective.short,HEAD.short,'stage 1c: a new short still reads closed');
  assert.equal('coverBeforeDays' in held.short,false,'switch off: no short facts');
});
test('the two-attempt record crosses the worker and the service into the engine: Rejected with both, the first refusal shown',async()=>{
  // The client: both dates refused.
  let n=0;const c=new KisReadOnlyClient(creds,async(url)=>{if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});n++;return reply(n===1?{rt_cd:'1',msg_cd:'APBK9999',msg1:'first made-up refusal'}:{rt_cd:'1',msg_cd:'APBK9998',msg1:'second made-up refusal'});},async()=>{});
  const plan={first:{form:'balance',date:'2026-10-13'},alternate:{form:'trade-day',date:'2026-10-09'}};
  const thrown=await c.placeOrder({symbol:'990010',side:'Buy',quantity:1,limitPrice:1000,credit:{kind:'cover',type:'26',loanDate:'2026-10-13',send:plan}}).then(()=>null,e=>e);
  // The worker's reply, as structured clone carries it, and the service's error.
  const message=structuredClone(WC.errorReply(5,'place-order',thrown));assert.equal(message.code,'BROKER_REJECTED');assert.equal(message.loanDateTried.length,2);
  const relayed=WC.kisErrorFields(new Error(message.code),message);
  // The engine: its broker throws that error at placement.
  const {l}=engine({switchOn:true,place:()=>{throw relayed;}});const p=l.propose(cover('990010','2026-10-13'));const o=await l.submit(p.id,'PLACE LIVE ORDER');
  assert.equal(o.status,'Rejected');assert.equal(o.reason,'BROKER_REJECTED');assert.deepEqual(o.loanDateTried.map(x=>[x.date,x.form,x.brokerCode]),[['2026-10-13','balance','APBK9999'],['2026-10-09','trade-day','APBK9998']]);
  assert.equal(o.brokerCode,'APBK9999','the first refusal shown first');assert.equal(o.brokerMessage,'first made-up refusal');
});
test('an unclear alternate: the order is Uncertain and keeps the first refusal and the date that may be at KIS',async()=>{
  let n=0;const c=new KisReadOnlyClient(creds,async(url)=>{if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});n++;return reply(n===1?{rt_cd:'1',msg_cd:'APBK9999',msg1:'made-up'}:{rt_cd:'0',output:{}});},async()=>{});
  const thrown=await c.placeOrder({symbol:'990010',side:'Buy',quantity:1,limitPrice:1000,credit:{kind:'cover',type:'26',loanDate:'2026-10-13',send:{first:{form:'balance',date:'2026-10-13'},alternate:{form:'trade-day',date:'2026-10-09'}}}}).then(()=>null,e=>e);
  const relayed=WC.kisErrorFields(new Error(WC.errorReply(1,'place-order',thrown).code),structuredClone(WC.errorReply(1,'place-order',thrown)));
  const {l}=engine({switchOn:true,place:()=>{throw relayed;}});const p=l.propose(cover('990010','2026-10-13'));const o=await l.submit(p.id,'PLACE LIVE ORDER');
  assert.equal(o.status,'Uncertain');assert.deepEqual(o.loanDateTried,[{date:'2026-10-13',form:'balance',brokerCode:'APBK9999',brokerMessage:'made-up'},{date:'2026-10-09',form:'trade-day',unclear:true}]);
});
test('the engine sends the plan with the order, and the screen lines read saved values',()=>{
  const fs=require('fs'),path=require('path');const s=fs.readFileSync(path.join(__dirname,'..','src','ShortLeverage.tsx'),'utf8');
  assert.match(s,/Opening a short: sent \$\{data\.policy!\.short\.auto&&ps\.automatic\?'by itself':'after your approval'\}, within your cap\./,'the saved switch, not the form');
  // Stage 3: the conditional-order switches' state, from saved values (short-confirm coverStopsWords).
  assert.match(s,/`Buying a short back: the app's cover stops and loan-end buy-backs are conditional orders\.\$\{coverStopsWords\(data\.coverStops\?\?null\)\?' '\+coverStopsWords\(data\.coverStops\?\?null\):''\} You can always buy a short back in KIS's own app\.`/);
  assert.doesNotMatch(s,/sent \$\{ps\.automatic\?'by themselves'/);
});
