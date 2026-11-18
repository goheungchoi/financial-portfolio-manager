// 2026-11-19 overnight failures, A (artifacts/reviews/2026-11-19-overnight-failures, cleared for 1.5.70): automatic
// U.S. purchases are refused before sending (autoSubmit: the funding regime is not verified separate), yet the review
// was not told and decided the same Nvidia buy twice. A(a): the U.S. account's buying power carries the fact, for the
// trading review (single and combined) and the scout; the scout's note no longer says U.S. listings can be bought
// automatically. Context only: the instruction fingerprints do not change.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine,AUTO_US_BUY_OFF}=require('../electron/live-engine.cjs');
function us(regime){const db=new DatabaseSync(':memory:');const snap={accountKey:'acct:US',environment:'live',source:'kis-us',currency:'USD',reportedTotal:1000,cash:1000,holdings:[]};
  const e=new LiveEngine(db,{request:async()=>({balance:snap,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot:snap}),{market:'US'});
  e.buyingPower=()=>({usd:1000,integratedMargin:false,fromKRWUSD:0,brokerUSD:1000,basis:'USD cash only.'});if(regime!==undefined)e.funding={regime:()=>regime};return e;}

test('the U.S. account tells whether its purchases go out automatically, and why not',async()=>{
  assert.deepEqual(us('unknown').automaticPurchases(),{automaticPurchases:{available:false,reason:AUTO_US_BUY_OFF}});
  assert.deepEqual(us('integrated-usd-first').automaticPurchases().automaticPurchases.available,false);
  assert.deepEqual(us('separate').automaticPurchases(),{automaticPurchases:{available:true}});
  assert.deepEqual(us(undefined).automaticPurchases(),{},'no funding ledger: no claim');
  const kr=us('unknown');kr.market='KR';assert.deepEqual(kr.automaticPurchases(),{},'Korea: not concerned');
  assert.match(AUTO_US_BUY_OFF,/^Automatic U\.S\. purchases are off: .*integrated margin.* U\.S\. sales still go out automatically\.$/);});

test('what the trading review reads: buyingPower carries automaticPurchases; the combined context passes it through',async()=>{
  const ctx=await us('unknown').context();
  assert.deepEqual(ctx.buyingPower,{usd:1000,integratedMargin:false,fromKRWUSD:0,brokerUSD:1000,basis:'USD cash only.',automaticPurchases:{available:false,reason:AUTO_US_BUY_OFF}});
  const src=fs.readFileSync(path.join(__dirname,'../electron/combined-context.cjs'),'utf8');assert.ok(src.includes('buyingPower?{buyingPower:context.buyingPower}:{}'),'each market keeps its buyingPower whole');
  assert.ok(fs.readFileSync(path.join(__dirname,'../electron/review-context.cjs'),'utf8').includes("buyingPower:'object'"),'kept by the context budget as an object');});

test('the scout: its U.S. account carries the fact, and the note says, as a fact, that U.S. listings are not bought automatically now',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.ok(src.includes('...(c.buyingPower.automaticPurchases?{automaticPurchases:c.buyingPower.automaticPurchases}:{})'));
  assert.ok(src.includes("const usAutoOff=accounts.some(a=>a.market==='US'&&a.automaticPurchases?.available===false);"));
  assert.ok(src.includes("note:usTradable&&usAutoOff?'Korean listings can be bought automatically. U.S. listings are not bought automatically now (see the U.S. account); the user can place a U.S. buy by hand. Compare them on the same footing.'"));});

test('context only: the review instruction fingerprints are unchanged',()=>{
  const RI=require('../electron/review-instructions.cjs');assert.equal(RI.fingerprint(),'36fe9b8abbd1bbea');assert.equal(RI.fingerprint(undefined,{orders:true}),'d3b7deb7b551a025');
  assert.equal(RI.fingerprint('proposed'),'db193ed8d9cc5268');assert.equal(RI.fingerprint('proposed',{orders:true}),'86dac6685f4d122f');});
