// Orders while stopped, B-2: the engine's permit for the conditional watch's orders (permitConditional). While trading
// is stopped, only an order the watch makes is proposed, approved, sent and tracked under it; every other order is
// refused as before; an unclear order that stops the market revokes it; each of the engine's own limits applies to the
// watch's Sells and Buys as when running. Fake broker, made-up symbols, account and amounts.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine}=require('../electron/live-engine.cjs');
const SNAP={accountKey:'acct',environment:'mock',reportedTotal:10000000,cash:10000000,settledCash:10000000,holdings:[{symbol:'123450',name:'S',quantity:20,cost:50000,price:50000}]};
// place: what the fake KIS answers when an order is placed (an Error is thrown as is).
function fixture({policy={},place=()=>({brokerOrderId:'9001'})}={}){
  const db=new DatabaseSync(':memory:');const calls=[];let snapshot=SNAP;
  const broker={request:async(op,payload)=>{calls.push(op);if(op==='prepare-order')return {ticket:'t1',balance:{...snapshot,timestamp:new Date().toISOString()},checkedAt:Date.now()};
    if(op==='place-order'){const r=place(payload);if(r instanceof Error)throw r;return r;}return {};}};
  const e=new LiveEngine(db,broker,()=>({status:'connected',snapshot}));
  e.configure({symbols:['123450'],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0},...policy},'ENABLE MOCK');
  return {db,e,calls,setAccount:key=>{snapshot={...SNAP,accountKey:key};}};
}
const SELL={symbol:'123450',side:'Sell',quantity:1,limitPrice:50000},BUY={symbol:'123450',side:'Buy',quantity:1,limitPrice:50000};
const stopped=(f,{auto=false}={})=>{f.e.stop();f.e.permitConditional({account:'acct',auto});return f;};

test('stopped without the permit: nothing is proposed, the watch\'s orders included (1.5.73 unchanged)',()=>{
  const {e}=fixture();e.stop();
  assert.throws(()=>e.propose(SELL),/KIS_TRADING_DISABLED/);assert.throws(()=>e.propose(SELL,{conditional:true}),/KIS_TRADING_DISABLED/);
  assert.equal(e.conditionalPermit,null,'off by default');
});
test('with the permit, only the watch\'s orders are proposed; a review\'s order and your ticket are refused',()=>{
  const {e}=stopped(fixture());
  assert.throws(()=>e.propose(BUY),/KIS_TRADING_DISABLED/,'a review\'s order');assert.throws(()=>e.propose(BUY,{ticket:true}),/KIS_TRADING_DISABLED/,'your ticket');
  const s=e.propose(SELL,{conditional:true});const b=e.propose(BUY,{conditional:true});assert.equal(s.madeBy,'conditional');assert.equal(b.madeBy,'conditional');
  assert.throws(()=>e.permitConditional({}),/INVALID_REQUEST/);
  e.revokeConditional();assert.throws(()=>e.propose(SELL,{conditional:true}),/KIS_TRADING_DISABLED/,'revoked');
});
test('a permit for another account admits nothing',()=>{
  const f=stopped(fixture());f.setAccount('other');assert.throws(()=>f.e.propose(SELL,{conditional:true}),/KIS_TRADING_DISABLED/);
});
test('while running the permit changes nothing: every order as before',()=>{
  const {e}=fixture();e.permitConditional({account:'acct',auto:true});
  assert.ok(e.propose(BUY).id);assert.ok(e.propose(BUY,{ticket:true}).id);assert.ok(e.propose(SELL,{conditional:true}).id);
});
test('sent by itself only when the permit says auto; otherwise it waits for you, and your approval sends it',async()=>{
  const off=stopped(fixture());const p=off.e.propose(SELL,{conditional:true});
  await assert.rejects(off.e.autoSubmit(p.id),/AUTO_KIS_DISABLED/);assert.equal(off.calls.includes('place-order'),false);
  const sent=await off.e.submit(p.id,'PLACE MOCK ORDER');assert.equal(sent.status,'Accepted','your approval');
  const on=stopped(fixture(),{auto:true});const q=on.e.propose(BUY,{conditional:true});assert.equal((await on.e.autoSubmit(q.id)).status,'Accepted');assert.equal(on.calls.filter(c=>c==='place-order').length,1);
});
test('an order not made by the watch is never sent under the permit, even one proposed while running',async()=>{
  const f=fixture();const early=f.e.propose(BUY);f.e.stop();f.e.permitConditional({account:'acct',auto:true});
  await assert.rejects(f.e.submit(early.id,'PLACE MOCK ORDER'),/DISABLED_OR_EXPIRED/);await assert.rejects(f.e.autoSubmit(early.id),/AUTO_KIS_DISABLED/);
  assert.equal(f.calls.includes('prepare-order'),false,'nothing asked of KIS');
});
test('an unclear order stops the market and revokes the permit; the next watch order is refused',async()=>{
  const f=stopped(fixture({place:()=>new Error('TIMEOUT')}),{auto:true});const p=f.e.propose(SELL,{conditional:true});
  const r=await f.e.autoSubmit(p.id);assert.equal(r.status,'Uncertain');assert.equal(f.e.conditionalPermit,null);
  assert.throws(()=>f.e.propose(SELL,{conditional:true}),/KIS_TRADING_DISABLED/);
});
test('the engine\'s limits apply to the watch\'s Sells and Buys while stopped as when running',async()=>{
  // The day's turnover cap: a second order past it is refused, Sell or Buy.
  for(const side of [SELL,BUY]){const f=stopped(fixture({policy:{maxDailyTurnoverKRW:60000}}),{auto:true});
    const first=await f.e.autoSubmit(f.e.propose(side,{conditional:true}).id);assert.equal(first.status,'Accepted');f.e.save({...first,status:'Filled',filled:1});// one open order at a time
    await assert.rejects(f.e.autoSubmit(f.e.propose(side,{conditional:true}).id),/DAILY_TURNOVER_LIMIT/,side.side);}
  // The order size limit.
  {const f=stopped(fixture({policy:{maxOrderKRW:40000}}));assert.throws(()=>f.e.propose(SELL,{conditional:true}),/ORDER_SIZE_LIMIT/);assert.throws(()=>f.e.propose(BUY,{conditional:true}),/ORDER_SIZE_LIMIT/);}
  // The day's loss restriction holds an automatic Buy (it opens exposure); a Sell is protective and is sent.
  {const f=stopped(fixture(),{auto:true});f.e.currentLoss=()=>({restrictedForDay:true});
    await assert.rejects(f.e.autoSubmit(f.e.propose(BUY,{conditional:true}).id),/DAILY_LOSS_RESTRICTED/);
    assert.equal((await f.e.autoSubmit(f.e.propose(SELL,{conditional:true}).id)).status,'Accepted');}
  // The buy-back block refuses the Buy at proposal and again at sending; the Sell is not affected.
  {const f=stopped(fixture(),{auto:true});const b=f.e.propose(BUY,{conditional:true});const block={symbol:'123450',soldOn:'2026-10-05',blockedUntil:'2026-11-04'};
    f.e.buybackBlock=s=>s==='123450'?block:null;await assert.rejects(f.e.autoSubmit(b.id),err=>err.message==='BUYBACK_BLOCKED');
    assert.throws(()=>f.e.propose(BUY,{conditional:true}),err=>err.message==='BUYBACK_BLOCKED');assert.ok(f.e.propose(SELL,{conditional:true}).id);}
  // Expiry: a proposal older than its two minutes is not sent.
  {const f=stopped(fixture(),{auto:true});const p=f.e.propose(SELL,{conditional:true});f.e.save({...f.e.orders().find(o=>o.id===p.id),expiresAt:Date.now()-1});
    await assert.rejects(f.e.autoSubmit(p.id),/DISABLED_OR_EXPIRED/);}
});
test('a revision or cancel is admitted for the watch\'s open order only',()=>{
  const {e}=stopped(fixture());const mine={madeBy:'conditional',notional:50000},other={notional:50000};
  assert.equal(e.revisionStop(other,{price:50000,remaining:1,notional:50000}),'DISABLED_OR_EXPIRED');
  assert.notEqual(e.revisionStop(mine,{price:50000,remaining:1,notional:50000}),'DISABLED_OR_EXPIRED');
  assert.equal(e.notSendable({...other,accountKey:'acct',expiresAt:Date.now()+60000},e.policy()),'DISABLED_OR_EXPIRED');
  assert.equal(e.notSendable({...mine,symbol:'123450',accountKey:'acct',expiresAt:Date.now()+60000},e.policy()),null);
});
test('review fix 1: after an unclear-order halt, a permit without auto does not send by itself (autoEnabled left on)',async()=>{
  const f=fixture({place:()=>new Error('TIMEOUT')});f.e.enableAuto('ENABLE AUTO MOCK');const review=f.e.propose(BUY);
  const unclear=await f.e.autoSubmit(f.e.propose(SELL).id);assert.equal(unclear.status,'Uncertain');assert.equal(f.e.enabled,false);assert.equal(f.e.autoEnabled,true,'the halt as in 1.5.73');
  // A non-watch order after the halt keeps 1.5.73's refusal, with no permit and with one; nothing is asked of KIS.
  const before=f.calls.length;await assert.rejects(f.e.autoSubmit(review.id),/DISABLED_OR_EXPIRED/,'no permit');
  f.e.save({...unclear,status:'Rejected'});f.e.permitConditional({account:'acct',auto:false});
  await assert.rejects(f.e.autoSubmit(review.id),/DISABLED_OR_EXPIRED/,'with a permit');assert.equal(f.calls.length,before);
  const p=f.e.propose(SELL,{conditional:true});await assert.rejects(f.e.autoSubmit(p.id),/AUTO_KIS_DISABLED/);
});
test('review fix 2: a connection change revokes the permit; Stop auto trading leaves it',()=>{
  const src=require('fs').readFileSync(require('path').join(__dirname,'..','electron','main.cjs'),'utf8');
  const paths=src.split('live.stop();usLive?.stop();live.revokeConditional();usLive?.revokeConditional();').length-1;assert.equal(paths,3,'connect, forget, disconnect');
  assert.equal(src.split('live.stop();usLive?.stop();').length-1,3,'no connection path without it');
  assert.match(src,/kisBusy=true;live\.stop\(\);usLive\?\.stop\(\);live\.revokeConditional\(\)/,'connect');assert.match(src,/'kis:disconnect'[^\n]*live\.revokeConditional\(\)/,'disconnect');assert.match(src,/'connections:forget'[^\n]*live\.revokeConditional\(\)/,'forget');
  assert.match(src,/ipcMain\.handle\('live:stop',liveAction\(\(\)=>live\.stop\(\)\)\);/,'Stop leaves it');
  const {e}=fixture();e.permitConditional({account:'acct'});e.stop();assert.ok(e.conditionalPermit,'stop() keeps it');
  e.stop();e.revokeConditional();assert.throws(()=>e.propose(SELL,{conditional:true}),/KIS_TRADING_DISABLED/,'the same account back: no permit');
});
test('review fix 3: only propose marks a watch order; annotate cannot make or relabel one',async()=>{
  const f=fixture();const review=f.e.propose(BUY);f.e.annotate(review.id,{madeBy:'review',reviewId:'r1'});const ticket=f.e.propose(BUY,{ticket:true});f.e.annotate(ticket.id,{madeBy:'ticket'});
  assert.throws(()=>f.e.annotate(review.id,{madeBy:'conditional'}),/INVALID_REQUEST/);assert.throws(()=>f.e.annotate(ticket.id,{madeBy:'conditional'}),/INVALID_REQUEST/);
  const watch=f.e.propose(SELL,{conditional:true});assert.equal(watch.madeBy,'conditional','marked while running');
  assert.throws(()=>f.e.annotate(watch.id,{madeBy:'review'}),/INVALID_REQUEST/);assert.equal(f.e.annotate(watch.id,{madeBy:'conditional',conditionalId:'c1'}).conditionalId,'c1','same mark: no change');
  f.e.stop();f.e.permitConditional({account:'acct',auto:true});await assert.rejects(f.e.submit(review.id,'PLACE MOCK ORDER'),/DISABLED_OR_EXPIRED/);
  const auto=require('fs').readFileSync(require('path').join(__dirname,'..','electron','automation.cjs'),'utf8');
  assert.match(auto,/loanDate:order\.credit\.loanDate\}\}:\{\}\)\},\{conditional:true\}\);engine\.annotate\?\.\(proposal\.id,\{conditionalId:order\.id,/,'the fire path marks through propose');
});
test('a watch Buy while stopped is refused for short cash by the funding ledger, the same as while running',async()=>{
  const {FundingLedger}=require('../electron/funding-ledger.cjs');
  const run=async stop=>{const db=new DatabaseSync(':memory:');const KR={...SNAP,cash:30000,settledCash:30000,reportedTotal:1030000};
    const broker={request:async op=>op==='prepare-order'?{ticket:'t',balance:{...KR,timestamp:new Date().toISOString()},checkedAt:Date.now()}:op==='place-order'?{brokerOrderId:'1'}:{}};
    const e=new LiveEngine(db,broker,()=>({status:'connected',snapshot:KR}));e.costs={get:()=>({krCommissionPct:0,krSellTaxPct:0}),context:()=>null};
    const l=new FundingLedger(db,{fresh:async()=>{throw new Error('no fresh read');},balance:async()=>({accountKey:'acct:US',environment:'mock',reportedTotal:0,cash:0,holdings:[],unsettled:{buyKRW:0,sellKRW:0},timestamp:new Date().toISOString(),fx:{usdKRW:1300,timestamp:Date.now()}}),fx:()=>({usdKRW:1300,timestamp:Date.now()}),regime:'separate'});l.init();e.funding=l;
    e.configure({symbols:['123450'],maxOrderKRW:null,maxDailyTurnoverKRW:null,maxCompanyPct:null,lossLimit:{mode:'off',value:0}},'ENABLE MOCK');
    if(stop){e.stop();e.permitConditional({account:'acct',auto:false});}
    const p=e.propose(BUY,{conditional:true});try{await e.submit(p.id,'PLACE MOCK ORDER');return 'sent';}catch(error){return error.message;}};
  const running=await run(false),whileStopped=await run(true);assert.match(running,/INSUFFICIENT/,running);assert.equal(whileStopped,running);
});
