// Shorts on, stage 1c (artifacts/reviews/2026-11-25-shorts-on/review-stage1b.md): a cover's refusal words never strand
// it; no cover date names another lot, first or alternate; the app's own short is tied to its lot by either date and its
// counterpart; turning short selling on while Claude trades is refused. Fake broker and fake transport; made-up codes
// (99xxxx), prices, quantities and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {KisReadOnlyClient}=require('../electron/kis-client.cjs');const {Exposure}=require('../electron/exposure.cjs');const {LiveEngine}=require('../electron/live-engine.cjs');
const LD=require('../electron/short-loan-date.cjs');const SS=require('../electron/short-stops.cjs');const R=require('../electron/short-rules.cjs');
const reply=body=>new Response(JSON.stringify(body),{headers:{tr_cont:''}});
const creds={environment:'live',appKey:'fixture-key',appSecret:'fixture-secret',accountNumber:'12345678',accountProductCode:'01'};
const COVER_WORDS=['상환가능수량이 부족합니다','해당 잔고가 없습니다','대주 잔고내역이 없습니다','상환할 대주잔고가 존재하지 않습니다','주문수량을 확인하세요'];
test('1: a cover\'s balance, quantity and repayable words never suppress the alternate; a short\'s do, without the loose matches',async()=>{
  for(const w of COVER_WORDS){const body={rt_cd:'1',msg_cd:'APBK9999',msg1:w};assert.equal(LD.notAboutDate(body,'cover'),null,w);assert.ok(LD.notAboutDate(body,'short'),'short: '+w);}
  for(const body of [{},{rt_cd:'1',msg_cd:'EGW00201',msg1:'x'},{rt_cd:'1',msg_cd:'APBK1617',msg1:'x'},{rt_cd:'1',msg_cd:'APBK0001',msg1:'장운영시간이 아닙니다'}])assert.ok(LD.notAboutDate(body,'cover'),JSON.stringify(body));
  assert.equal(LD.notAboutDate({rt_cd:'1',msg_cd:'X',msg1:'체결약정 확인'},'short'),null,'약정 inside 체결약정');assert.equal(LD.notAboutDate({rt_cd:'1',msg_cd:'X',msg1:'수량단위 오류'},'short'),null,'수량 inside 수량단위');
  assert.ok(LD.notAboutDate({rt_cd:'1',msg_cd:'X',msg1:'신용약정이 없습니다'},'short'));
  // Through the client: a cover refused with "no balance" words sends its alternate.
  let n=0;const calls=[];const c=new KisReadOnlyClient(creds,async(url,o)=>{if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});calls.push(JSON.parse(o.body).LOAN_DT);n++;return reply(n===1?{rt_cd:'1',msg_cd:'APBK9999',msg1:COVER_WORDS[1]}:{rt_cd:'0',output:{ODNO:'1'}});},async()=>{});
  const r=await c.placeCreditOrder({symbol:'990010',side:'Buy',quantity:1,limitPrice:1000,credit:{kind:'cover',type:'26',loanDate:'2026-10-13',send:{first:{form:'balance',date:'2026-10-13'},alternate:{form:'trade-day',date:'2026-10-09'}}}});
  assert.deepEqual(calls,['20261013','20261009']);assert.equal(r.loanDateSent.alternate,true);
});
test('2: no cover date, first or alternate, names another lot: with trade-day in use the lot\'s own balance date is sent alone; reconcile names another lot even when it is the date sent',()=>{
  const balance={shorts:[{symbol:'990010',loanDate:'2026-10-13'},{symbol:'990010',loanDate:'2026-10-09'}]};
  const plan=LD.candidates('cover',{loanDate:'2026-10-13',forms:{short:'trade-day',cover:'trade-day'}});assert.equal(plan.first.date,'2026-10-09','trade-day in use: B\'s date first');
  assert.deepEqual(LD.guardPlan(plan,{symbol:'990010',loanDate:'2026-10-13',balance}),{plan:{first:{form:'balance',date:'2026-10-13'},alternate:null},dropped:'2026-10-09 is another short lot of 990010'});
  assert.deepEqual(LD.guardPlan(plan,{symbol:'990010',loanDate:'2026-10-13',balance:{shorts:[balance.shorts[0]]}}).plan,plan,'no other lot: as planned');
  assert.deepEqual(LD.guardPlan(plan,{symbol:'990010',loanDate:'2026-10-13',balance:{}}).plan,{first:{form:'balance',date:'2026-10-13'},alternate:null},'rows unreadable: the lot\'s own date alone');
  const words=R.creditRowCheck({credit:{kind:'cover',loanDate:'2026-10-13'},loanDateSent:{date:'2026-10-09'}},[{creditName:'유대상환',loanDate:'2026-10-09'}],['2026-10-09']);
  assert.match(words,/2026-10-09 is another short lot of this stock, so KIS may have bought that one back/);
});
// An engine with one app short whose KIS dates differ from the balance's.
function engine({switchOn=false,order={},lot={symbol:'990010',quantity:5,loanDate:'2026-10-13',source:'distribution',price:1000,proceeds:5000,loanAmount:5000}}={}){
  const d=new DatabaseSync(':memory:');const snapshot={environment:'live',reportedTotal:10000000,cash:2000000,loanTotal:0,holdings:[],shorts:[lot],accountKey:'acct',timestamp:new Date(Date.now()+60000).toISOString()};
  const l=new LiveEngine(d,{request:async(op)=>{if(op==='prepare-order')return {ticket:'t',balance:snapshot};if(op==='place-order')return {brokerOrderId:'9'};throw new Error(op);}},()=>({status:'connected',snapshot}));
  l.exposure=new Exposure(d);l.configure({symbols:[],lossLimit:{mode:'off',value:0}},'ENABLE LIVE');l.exposure.savePolicy('acct',{short:{enabled:switchOn,auto:false}});l.closedKrDays=()=>[];
  l.writeOrder({id:'S0',accountKey:'acct',symbol:'990010',side:'Sell',quantity:1,filled:1,status:'Filled',credit:{kind:'short',type:'22'},createdAt:1,expiresAt:1,fillPrice:1000,filledObservedAt:Date.now(),...order});
  return {l,snapshot};}
test('3: the app\'s short is tied to its lot by either date or its counterpart; with the switch off its buy-back is limited to what it sold',()=>{
  // The order row's date two business days before the balance's (trade day against settlement day).
  for(const order of [{lotLoanDate:'2026-10-09'},{loanDateSent:{date:'2026-10-09',form:'trade-day',alternate:false}},{credit:{kind:'short',type:'22',send:{first:{form:'trade-day',date:'2026-10-09'},alternate:null}}},{lotLoanDate:'2026-10-13'}]){
    const {l}=engine({order});assert.deepEqual([...l.appLots().lots],[['990010|2026-10-13',{quantity:1,fillPrice:1000}]],JSON.stringify(order));assert.equal(l.holdsAppShort(),true);}
  // Switch off: the cover of what the app sold goes; the hand-opened rest of the lot does not.
  const {l}=engine({order:{lotLoanDate:'2026-10-09'}});const cover=q=>({symbol:'990010',side:'Buy',quantity:q,limitPrice:1000,credit:{kind:'cover',loanDate:'2026-10-13'}});
  assert.throws(()=>l.propose(cover(5)),e=>e.message==='EXCEEDS_LOT'&&/only the 1 shares it sold/.test(e.detail));assert.equal(l.propose(cover(1)).status,'Ready');
  const on=engine({switchOn:true,order:{lotLoanDate:'2026-10-09'}}).l;assert.equal(on.appCoverLimit({kind:'cover',loanDate:'2026-10-13'},'990010'),null,'switch on: no limit');assert.equal(on.propose(cover(5)).status,'Ready');
  // A date that ties to nothing: unmatched once a balance read after the fill shows no lot it ties to.
  const far=SS.appLots({orders:[{id:'S9',side:'Sell',symbol:'990010',filled:1,credit:{kind:'short'},lotLoanDate:'2026-09-01',filledObservedAt:1000}],balance:{timestamp:new Date(2000).toISOString(),shorts:[{symbol:'990010',quantity:5,loanDate:'2026-10-13'}]}});
  assert.equal(far.lots.size,0);assert.deepEqual(far.unmatched,[{symbol:'990010',orderId:'S9'}]);
  assert.deepEqual(SS.appLots({orders:[{id:'S9',side:'Sell',symbol:'990010',filled:1,credit:{kind:'short'},lotLoanDate:'2026-09-01',filledObservedAt:3000}],balance:{timestamp:new Date(2000).toISOString(),shorts:[]}}).unmatched,[],'a balance read before the fill: not yet');
});
test('3: the cover stop is armed for a lot tied by its counterpart; a lot that cannot be tied is listed with the KIS-app words',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},()=>{});a.configure({scope:'kis',conditionalOrders:true});
  const shorts=[{symbol:'990010',quantity:5,loanDate:'2026-10-13',source:'distribution',entryPrice:1000,price:1000}];let orders=[{id:'S0',side:'Sell',symbol:'990010',filled:5,quantity:5,status:'Filled',credit:{kind:'short'},lotLoanDate:'2026-10-09',fillPrice:1000,filledObservedAt:1}];
  a.live={market:'KR',identity:()=>'acct',orders:()=>orders,riskBalance:{shorts,timestamp:new Date(Date.now()+60000).toISOString(),holdings:[]},exposure:{policy:()=>({short:{stopLossPct:15,maxDays:90,coverBeforeDays:5}})},getState:()=>({})};
  a.syncShortStops(a.watchScope());const armed=a.desk.orders(a.watchScope());assert.equal(armed.length,1,'armed for the counterpart lot');assert.equal(armed[0].credit.loanDate,'2026-10-13');
  // The order's date ties to nothing in the balance: listed, never silent.
  orders=[{...orders[0],lotLoanDate:'2026-09-01'}];a.desk.update(armed[0],{status:'cancelled',closedBy:'app',closedAt:Date.now()});a.brokerPositions=()=>({});
  const u=a.unprotectedNow(a.watchScope()).filter(x=>x.short);assert.equal(u.length,1);assert.equal(u[0].cause,'unmatched');assert.match(u[0].outcome,/cannot tie it to this lot's loan date, so it has no cover stop; buy it back in KIS's own app/);
});
test('4: turning short selling on while auto trading runs on Claude is refused; turning it off never is, and the dry run without shorts counts again',()=>{
  const {Automation}=require('../electron/automation.cjs');const a=Object.create(Automation.prototype);a.config={scope:'kis',openaiModel:'claude-opus-5-5'};
  let runs=true,vendor='anthropic';a.autoTradingRuns=()=>runs;a.vendorOf=()=>vendor;a.agentModel=()=>({openaiModel:'claude-opus-5-5'});
  const AM=require('../electron/ai-models.cjs'),was=AM.decisionMaker;AM.decisionMaker=()=>'ai';try{
    assert.equal(a.shortsSwitchRefusal({was:false,next:true}),'CLAUDE_SHORTS_RUNNING');
    assert.equal(a.shortsSwitchRefusal({was:true,next:false}),null,'turning it off: never refused');assert.equal(a.shortsSwitchRefusal({was:true,next:true}),null,'already on: other settings save');
    runs=false;assert.equal(a.shortsSwitchRefusal({was:false,next:true}),null,'stopped: Start then asks the dry run');runs=true;
    vendor='openai';assert.equal(a.shortsSwitchRefusal({was:false,next:true}),null,'OpenAI: no dry-run gate');}finally{AM.decisionMaker=was;}
  // Off again: the fingerprints in force are those without shorts, so the dry run made without shorts counts.
  const b=Object.create(Automation.prototype);b.config={scope:'kis'};b.live={creditApproved:()=>false};b.completedClaudeDryRun=()=>({instructions:{fingerprint:'1004c642ceabd60d'}});
  b.shortsEnabled=()=>true;assert.equal(b.claudeTradingDryRun(),null,'on: one new dry run');b.shortsEnabled=()=>false;assert.ok(b.claudeTradingDryRun(),'off again: the earlier dry run counts');
  const fs=require('fs'),path=require('path');const main=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8');assert.match(main,/const refused=automation\.shortsSwitchRefusal\(\{was:exposure\.policy\(account\)\.short\.enabled===true,next:value\.short\.enabled===true\}\);if\(refused\)throw new Error\(refused\);/);
  assert.match(fs.readFileSync(path.join(__dirname,'..','src','ShortLeverage.tsx'),'utf8'),/CLAUDE_SHORTS_RUNNING:'Stop auto trading first: turning short selling on changes what Claude is sent, so Start asks one new dry run\.'/);
});
test('small: the pending count lapses after 10 days, counts different orders only, reads strictly; a null row gives defaults; real dates never throw',()=>{
  let now=0;const db=new DatabaseSync(':memory:');const f=new LD.LoanDateForms(db,()=>now);
  f.accepted('short','settlement',{alternate:true,orderId:'A'});assert.equal(f.accepted('short','settlement',{alternate:true,orderId:'A'}).changed,false,'the same order twice: one');
  now=LD.PENDING_MS+1;assert.deepEqual(f.accepted('short','settlement',{alternate:true,orderId:'B'}),{changed:false,form:'trade-day',count:1},'lapsed: counts from one');
  now+=1000;assert.equal(f.accepted('short','settlement',{alternate:true,orderId:'C'}).changed,true,'two orders within 10 days: learned');
  db.prepare("UPDATE short_loan_forms SET payload=? WHERE id=1").run(JSON.stringify({coverPending:{form:'trade-day',count:'9',at:now}}));assert.equal(f.accepted('cover','trade-day',{alternate:true,orderId:'D'}).changed,false,'a count of "9" is not a number');
  db.prepare("UPDATE short_loan_forms SET payload='null' WHERE id=1").run();assert.deepEqual(f.get(),{short:'trade-day',cover:'balance'});
  for(const d of ['2026-13-45','2026-10-32','2026-02-30','x'])assert.equal(LD.realDate(d),false,d);assert.equal(LD.validPlan('cover',{first:{form:'balance',date:'2026-13-45'}}),null);
  assert.equal(LD.tried([{date:'2026-10-32'}]),null);assert.doesNotThrow(()=>require('../electron/worker-codes.cjs').errorReply(1,'place-order',Object.assign(new Error('BROKER_REJECTED'),{code:'BROKER_REJECTED',loanDateTried:[{date:'2026-13-45'}]})));
});
test('small: a cover with no engine plan gets no alternate; the order records the plan the ticket placed',async()=>{
  const calls=[];const c=new KisReadOnlyClient(creds,async(url,o)=>{if(url.endsWith('/oauth2/tokenP'))return reply({access_token:'t',expires_in:3600});calls.push(JSON.parse(o.body).LOAN_DT);return reply({rt_cd:'1',msg_cd:'APBK9999',msg1:'made-up'});},async()=>{});
  await assert.rejects(c.placeCreditOrder({symbol:'990010',side:'Buy',quantity:1,limitPrice:1000,credit:{kind:'cover',type:'26',loanDate:'2026-10-13'}}),/BROKER_REJECTED/);assert.deepEqual(calls,['20261013']);
  const {l}=engine({switchOn:true,order:{lotLoanDate:'2026-10-13'}});const placed={first:{form:'balance',date:'2026-10-13'},alternate:null};
  l.broker={request:async(op)=>{if(op==='prepare-order')return {ticket:'t',balance:l.getConnection().snapshot,sendPlan:placed};if(op==='place-order')return {brokerOrderId:'9'};throw new Error(op);}};
  const p=l.propose({symbol:'990010',side:'Buy',quantity:1,limitPrice:1000,credit:{kind:'cover',loanDate:'2026-10-13'}});const o=await l.submit(p.id,'PLACE LIVE ORDER');
  assert.equal(o.status,'Accepted');assert.deepEqual(o.credit.send,placed,'what was placed, not the engine\'s plan');
});
