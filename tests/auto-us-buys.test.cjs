// Automatic U.S. buys (artifacts/reviews/2026-11-19-us-auto-buys/decision.md, the user's "Yes"): R15 is removed, so
// the U.S. account's automatic switch governs buys and sales alike. What the reviews and the scout read follows: one
// fact for whether orders go out automatically (automaticExecutionEnabled; the integrated-margin "off" fact of the
// overnight fix A(a) is gone), and the shared won rule every U.S. buy is checked against (buyingPower.wonRule), with the
// room it leaves worked from readings already held (no KIS request). Context only: the instruction fingerprints do not
// change.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {LiveEngine,WON_RULE}=require('../electron/live-engine.cjs');const {FundingLedger}=require('../electron/funding-ledger.cjs');
const {opportunityNote}=require('../electron/automation.cjs');const {combinedContext}=require('../electron/combined-context.cjs');
// A U.S. engine with the real ledger: Korean cash ₩1,000,000, rate 1,300 (ρ 1,326).
function us({krCash=1000000,rate=1300,kr=true,auto=true}={}){const db=new DatabaseSync(':memory:');const at=new Date().toISOString();
  const snap={accountKey:'acct:US',environment:'live',source:'kis-us',currency:'USD',reportedTotal:1000,cash:1000,holdings:[],timestamp:at,fx:rate?{usdKRW:rate,timestamp:Date.now()}:null,unsettled:{buyKRW:0,sellKRW:0}};
  const e=new LiveEngine(db,{request:async()=>({balance:snap,quotes:[],marketSession:{open:false,status:'closed'}})},()=>({status:'connected',snapshot:snap}),{market:'US'});
  e.buyingPower=()=>({usd:1000,integratedMargin:true,fromKRWUSD:0,brokerUSD:1000,basis:'Integrated margin.'});
  e.funding=new FundingLedger(db,{fresh:async()=>{throw new Error('the context must not read balances');}});e.funding.init();
  e.krReading=()=>kr?{accountKey:'acct',environment:'live',cash:krCash,settledCash:krCash}:null;e.autoEnabled=auto;return e;}

test('the U.S. account states the won rule and the room it leaves, from readings already held',async()=>{
  const ctx=await us().context();assert.equal(ctx.automaticExecutionEnabled,true);assert.equal('automaticPurchases' in ctx.buyingPower,false,'the off fact is gone');
  assert.equal(ctx.buyingPower.wonRule.rule,WON_RULE);assert.match(WON_RULE,/Korean won cash at the exchange rate plus 2%/);
  assert.match(WON_RULE,/ A U\.S\. buy larger than the smaller of buyingPower\.usd and buyingPower\.wonRule\.roomUSD, fees included, is not sent\.$/);assert.ok(!/\bSize\b/.test(WON_RULE),'a fact about the app, not an instruction');
  assert.equal(ctx.buyingPower.wonRule.roomUSD,754.14,'₩1,000,000 ÷ 1,326, rounded down');
  assert.equal((await us({kr:false}).context()).buyingPower.wonRule.roomUSD,null,'no Korean reading: no room claimed');
  assert.equal((await us({rate:null}).context()).buyingPower.wonRule.roomUSD,null,'no rate: no room claimed');
  const kr=us();kr.market='KR';assert.deepEqual(kr.wonRule(),{},'Korea: not concerned');});

test('the switch is the one fact: off, the U.S. account says automatic execution is off',async()=>{
  const ctx=await us({auto:false}).context();assert.equal(ctx.automaticExecutionEnabled,false);assert.ok(ctx.buyingPower.wonRule,'the rule is stated either way');});

test('the combined context keeps buyingPower whole and states the won rule beside integrated margin',async()=>{
  const u=await us().context();const k={environment:'kis',market:'KR',currency:'KRW',equity:1,cash:1,positions:{},universe:[],quotes:[],orders:[],risk:{},marketSession:{open:false,status:'closed'}};
  const c=combinedContext(k,u,{usdKRW:1300});const usRow=c.markets.find(m=>m.market==='US');assert.deepEqual(usRow.buyingPower,u.buyingPower);
  assert.ok(c.objective.includes('Every U.S. buy must also fit the shared cash rule in buyingPower.wonRule. '),'the objective only points to the rule');
  assert.ok(!/rate plus 2%|smaller of|roomUSD/.test(c.objective),'the rule itself is stated once, in wonRule.rule');});

test('the scout: each account says whether its orders go out automatically, and the note is true in both states',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../electron/automation.cjs'),'utf8');
  assert.ok(src.includes("...(typeof c.automaticExecutionEnabled==='boolean'?{automaticExecutionEnabled:c.automaticExecutionEnabled}:{})"),'carried on each scout account');
  assert.ok(src.includes('...(c.buyingPower.wonRule?{wonRule:c.buyingPower.wonRule}:{})'));assert.ok(!src.includes('automaticPurchases'),'no trace of the old fact');
  const on=[{market:'KR',automaticExecutionEnabled:true},{market:'US',automaticExecutionEnabled:true}];
  assert.equal(opportunityNote(on,true),'Both Korean and U.S. listings can be bought; compare them on the same footing. A U.S. buy is also counted against Korean won cash (wonRule on the U.S. account).');
  assert.match(opportunityNote([on[0],{market:'US',automaticExecutionEnabled:false}],true),/ Automatic orders are off for the U\.S\. account \(automaticExecutionEnabled\): a buy there is proposed to the user, not sent\.$/);
  assert.match(opportunityNote([{market:'KR',automaticExecutionEnabled:false},{market:'US',automaticExecutionEnabled:false}],true),/off for the Korean and U\.S\. accounts/);
  assert.match(opportunityNote([on[0],{market:'US',status:'unavailable'}],false),/^Only Korean listings can be bought now\./);
  assert.ok(!/Automatic orders are off/.test(opportunityNote([on[0],{market:'US',status:'unavailable',automaticExecutionEnabled:false}],false)),'an unread account says nothing');});

test('context only: the review instruction fingerprints are unchanged',()=>{
  const RI=require('../electron/review-instructions.cjs');assert.equal(RI.fingerprint(),'cef9f646decfa59a');assert.equal(RI.fingerprint(undefined,{orders:true}),'c9ff8de188f65b22');
  assert.equal(RI.fingerprint('proposed'),'c99507dd13f94a53');assert.equal(RI.fingerprint('proposed',{orders:true}),'73d6594cd62f2e72');});
