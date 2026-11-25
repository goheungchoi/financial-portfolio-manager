// Shorts on, stage 3 (the planner's (a), 2026-11-25): the app's cover stop and loan-end buy-back are conditional orders,
// so with conditional orders off an app short is listed unprotected (Home, Short positions, the review's coverStop) and
// the words say what the switches make them now; nothing the app may send changes. Made-up codes (99xxxx) and dates.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const fs=require('fs'),path=require('path');
const WORDS="conditional orders are off, so it has no cover stop and no loan-end buy-back; turn them on in Engine settings or buy it back in KIS's own app";
function app({conditionalOrders,conditionalAutoSubmit=false}){const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'990010',name:'F',price:1000}],()=>[]),{request:async()=>({})},()=>{});a.configure({scope:'kis',conditionalOrders,conditionalAutoSubmit});
  const shorts=[{symbol:'990010',name:'F',quantity:5,loanDate:'2026-10-13',source:'distribution',entryPrice:1000,price:1000,proceeds:5000,loanAmount:5000},{symbol:'990020',name:'G',quantity:3,loanDate:'2026-10-13',source:'distribution',entryPrice:2000,price:2000,proceeds:6000,loanAmount:6000}];
  const orders=[{id:'S0',side:'Sell',symbol:'990010',filled:5,quantity:5,status:'Filled',credit:{kind:'short'},lotLoanDate:'2026-10-13',lotTie:{loanDate:'2026-10-13',at:1,how:'exact'},fillPrice:1000,filledObservedAt:1}];// 990020: opened in KIS's app
  a.live={market:'KR',identity:()=>'acct',orders:()=>orders,riskBalance:{shorts,timestamp:new Date(Date.now()+60000).toISOString(),holdings:[]},exposure:{policy:()=>({short:{enabled:true,stopLossPct:15,maxDays:90,coverBeforeDays:5}})},getState:()=>({}),creditApproved:()=>false};
  a.brokerPositions=()=>({});return a;}
test('conditional orders off: the app\'s short is listed unprotected with the cause, on Home and in Short positions; a short opened in KIS is not claimed',()=>{
  const a=app({conditionalOrders:false});a.syncShortStops(a.watchScope());assert.equal(a.desk.orders(a.watchScope()).length,0,'nothing armed (as before)');
  const u=a.unprotectedNow(a.watchScope()).filter(x=>x.short);assert.deepEqual(u.map(x=>[x.symbol,x.cause,x.outcome]),[['990010','conditional-off',WORDS]]);
  const rows=a.shortPositionsRead(a.watchScope(),Date.now());const own=rows.find(r=>r.symbol==='990010'),hand=rows.find(r=>r.symbol==='990020');
  assert.deepEqual(own.stop,{state:'none',cause:WORDS});assert.equal(own.byHand,false);assert.equal(hand.byHand,true);
});
test('conditional orders on: no such listing, and the cover stop is armed as before',()=>{
  const a=app({conditionalOrders:true});a.syncShortStops(a.watchScope());assert.equal(a.desk.orders(a.watchScope()).length,1);
  assert.deepEqual(a.unprotectedNow(a.watchScope()).filter(x=>x.short),[]);
});
test('the review\'s facts: coverStops says what the switches make the covers now; with them off each app short\'s coverStop is unprotected with the cause, never null',()=>{
  // Stage 3b: what a hit cover does now, by the fire's own rule. run: auto trading running (sessionArmed and enabled);
  // main: the main "Submit automatically"; engine: the engine's automatic; watch: kept working while stopped, with the
  // engine's permit (permit: null none, true with auto, false without).
  const states=[
    [{co:false},{armed:false,whenHit:null}],
    [{co:true,run:true,auto:true,main:true,engine:true},{armed:true,whenHit:'sent'}],
    [{co:true,run:true,auto:true,main:false,engine:true},{armed:true,whenHit:'proposed'},'the main switch off'],
    [{co:true,run:true,auto:true,main:true,engine:false},{armed:true,whenHit:'proposed'},'the engine\'s automatic off'],
    [{co:true,run:true,auto:false,main:true,engine:true},{armed:true,whenHit:'proposed'}],
    [{co:true,run:false},{armed:true,whenHit:'not'},'stopped, not kept working'],
    [{co:true,run:false,watch:true,permit:null},{armed:true,whenHit:'not'},'kept working but no permit'],
    [{co:true,run:false,watch:true,permit:true},{armed:true,whenHit:'sent'}],
    [{co:true,run:false,watch:true,permit:false},{armed:true,whenHit:'proposed'}]];
  for(const [x,want,label] of states){
    const a=app({conditionalOrders:x.co,conditionalAutoSubmit:x.auto===true});a.config.autoSubmit=x.main===true;a.live.enabled=true;a.live.autoEnabled=x.engine!==false;
    a.autoTradingRuns=()=>x.run===true;a.watchingWhileStopped=()=>x.watch===true;a.live.permitHolds=()=>x.permit!=null;a.live.conditionalPermit=x.permit==null?null:{auto:x.permit};
    a.shortFactsInForce=()=>true;assert.deepEqual(a.coverStopsNow(),want,label??JSON.stringify(x));const co=x.co;
    const context={environment:'kis',productRisk:{credit:{short:{allowed:true},shorts:[{symbol:'990010',loanDate:'2026-10-13'},{symbol:'990020',loanDate:'2026-10-13'}]}}};a.coverStopFacts(context,a.watchScope());
    assert.deepEqual(context.productRisk.credit.short.coverStops,want);
    if(!co)assert.deepEqual(context.productRisk.credit.shorts[0].coverStop,{state:'unprotected',cause:WORDS});}
  // Shorts not in force (the switch off): nothing is added, as 1.5.74.
  const off=app({conditionalOrders:false});off.shortFactsInForce=()=>false;const c={environment:'kis',productRisk:{credit:{short:{allowed:false},shorts:[{symbol:'990010',loanDate:'2026-10-13'}]}}};off.coverStopFacts(c,off.watchScope());
  assert.equal('coverStops' in c.productRisk.credit.short,false);assert.equal('coverStop' in c.productRisk.credit.shorts[0],false);
});
test('the short part names coverStops, promises no stop; its fingerprints and versions move with shorts on only',()=>{
  const RI=require('../electron/review-instructions.cjs');
  assert.match(RI.SHORT_TEXT,/The app's covers are conditional orders: productRisk\.credit\.short\.coverStops\.armed says whether the app arms them now, and whenHit whether one that is hit is sent by itself \("sent"\), proposed for approval \("proposed"\) or not watched now \("not"\)\./,'stage 3b: the third value');
  assert.match(RI.SHORT_TEXT,/When coverStops\.armed is true, the app arms a cover stop at stopLossPct above the entry/);
  assert.doesNotMatch(RI.SHORT_TEXT,/the app covers by itself/);assert.doesNotMatch(RI.SHORT_TEXT,/They are facts, not reasons to short/,'removed: the user\'s "Remove it"');assert.match(RI.SHORT_TEXT,/a Buy that repays it\)\.\n- Instruments:/,'nothing in its place');
  assert.equal(RI.fingerprint(),'1004c642ceabd60d','off: unchanged');assert.equal(RI.fingerprint(undefined,{orders:true}),'ed412ea0edf116a2');
  assert.equal(RI.fingerprint(undefined,{short:true}),'5108190b5fb2a210','on: 748298e5b27c1087, then 3ad1abc9a64168fd (coverStops), now without the removed sentence');assert.equal(RI.fingerprint(undefined,{orders:true,short:true}),'b28c18f472365dab','on: cc58f9a9d4c59f9e, then 3e08e9a9a21ad00d');
  assert.equal(RI.INSTRUCTIONS_VERSION,'review 2026-11-25.5');assert.equal(RI.SHORT_VERSION,'review 2026-11-25.5 short.4');
});
test('the screens: the confirmation and Short & leverage read the switches from main\'s state',()=>{
  const main=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8');assert.match(main,/,coverStops:automation\.coverStopsNow\(\)\}:\{\}\)\}:\{account:false\};/);
  const s=fs.readFileSync(path.join(__dirname,'..','src','ShortLeverage.tsx'),'utf8');assert.match(s,/coverStops:data\.coverStops\?\?null\}\)/);
});
// The user's "1. Stay on as saved": a switch saved on before shorts on stays on; one notice, once per account.
test('the saved switch: on before the update, one Home notice until dismissed, once per account, with one Activity line; off or turned on now: none',()=>{
  const N=require('../electron/shorts-live-notice.cjs');const db=new DatabaseSync(':memory:');const n=new N.ShortsLiveNotice(db,()=>5);
  assert.deepEqual(n.due('acct',false),{listed:false,first:false},'switch off: no notice');assert.equal(n.state('acct'),null,'and nothing recorded');
  assert.deepEqual(n.due('acct',true),{listed:true,first:true},'saved on: listed, and the first read writes the Activity line');assert.deepEqual(n.due('acct',true),{listed:true,first:false},'listed again, no second line');
  n.note('acct','dismissed');assert.deepEqual(n.due('acct',true),{listed:false,first:false},'dismissed: gone for good');assert.deepEqual(new N.ShortsLiveNotice(db).due('acct',true),{listed:false,first:false},'across restarts');
  assert.deepEqual(n.due('other',true).listed,true,'once per account');
  n.note('new','confirmed');assert.deepEqual(n.due('new',true),{listed:false,first:false},'turned on through this version\'s confirmation: none');
  const t=N.noticeText({auto:true,coverStops:{armed:true,whenHit:'proposed'}});assert.equal(t.title,'Short selling can now be sent');
  assert.equal(t.detail,'Short selling was already on in Short & leverage, so since this update the app can send short sales and their buy-backs without a new confirmation. A short the AI decides is sent by itself, within your cap. No real short has been sent by this app yet, so the first one is also the first test with KIS. Conditional orders are on now, but a stop or buy-back that is hit is only proposed and waits for your approval. To stop, turn short selling off in Short & leverage.');
  assert.match(N.noticeText({auto:false,coverStops:{armed:false,whenHit:null}}).detail,/proposed and waits for your approval\. No real short .* Conditional orders are off now, so a short will have no stop/);
});
test('the notice\'s switch sentence is the confirmation\'s, and main wires it: listed from the saved values, dismissed by id, confirmed when turned on now',async()=>{
  const N=require('../electron/shorts-live-notice.cjs');const {coverStopsWords}=await import('../src/short-confirm.mjs');
  for(const c of [null,{armed:false,whenHit:null},{armed:true,whenHit:'sent'},{armed:true,whenHit:'proposed'}])assert.equal(N.coverStopsWords(c),coverStopsWords(c),JSON.stringify(c));
  const main=fs.readFileSync(path.join(__dirname,'..','electron','main.cjs'),'utf8');
  // Stage 4: Home reads the record only (listed); the reading records it (noteShortsLive, live accounts only).
  assert.match(main,/const account=kisState\.snapshot\?\.environment==='live'\?kisState\.snapshot\.accountKey:null;/);assert.match(main,/if\(shortsLiveNotice\.listed\(account,p\?\.enabled===true\)\)\{/);
  assert.match(main,/noteShortsLive=snapshot=>\{try\{if\(snapshot\?\.environment!=='live'\|\|!snapshot\.accountKey\)return;/);assert.match(main,/live\?\.observeBalance\(snapshot\);noteShortsLive\(snapshot\);/);
  assert.match(main,/'Short selling can now be sent',require\('\.\/shorts-live-notice\.cjs'\)\.ACTIVITY_WORDS/);
  assert.match(main,/noticeText\(\{auto:p\.auto===true,coverStops:automation\.coverStopsNow\(\)\}\);items\.push\(\{id:'shorts-live',tone:'warning'/);
  assert.match(main,/else if\(id==='shorts-live'\)\{const a=kisState\.snapshot\?\.accountKey;if\(a\)try\{shortsLiveNotice\.note\(a,'dismissed'\);\}catch\{\}\}/);
  assert.match(main,/if\(turningOn\)try\{shortsLiveNotice\.note\(account,'confirmed'\);\}catch\{\}/);
});
test('stage 3b: the words for a cover that is not watched now, the same on the screens and the notice',async()=>{
  const {coverStopsWords}=await import('../src/short-confirm.mjs');const N=require('../electron/shorts-live-notice.cjs');
  assert.equal(coverStopsWords({armed:true,whenHit:'not'}),'Conditional orders are on, but they are not watched now, so a stop or buy-back that is hit is neither sent nor proposed until you press Start (or keep them working while auto trading is stopped).');
  assert.equal(N.coverStopsWords({armed:true,whenHit:'not'}),coverStopsWords({armed:true,whenHit:'not'}));
});
