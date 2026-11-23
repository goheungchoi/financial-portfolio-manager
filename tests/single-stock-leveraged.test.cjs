// A (the planner's rulings on the design): leveraged and inverse ETFs held
// up to the user's limits; single-stock ones under their own switch, off by default. Made-up symbols, companies and
// product names; nothing here is a real listing.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Exposure,singleStockName}=require('../electron/exposure.cjs');const RI=require('../electron/review-instructions.cjs');
// The security master: two made-up companies, and Korean ETFs and ETNs over a sector, an index, one company and unplaced names.
function db(){const d=new DatabaseSync(':memory:');d.exec('CREATE TABLE securities(symbol TEXT PRIMARY KEY,name TEXT,englishName TEXT,market TEXT,type TEXT,isin TEXT,industry TEXT)');
  const put=(symbol,name,type)=>d.prepare("INSERT INTO securities VALUES(?,?,'','KOSPI',?,'',NULL)").run(symbol,name,type);
  put('990001','가나전자','stock');put('990002','다라바이오','stock');
  put('990101','KODEX 가나전자 레버리지','etf');// one company, a brand in front
  put('990102','미래에셋 레버리지 다라바이오 ETN','etn');// an ETN issuer, words in the middle
  put('990103','TIGER 단일종목 레버리지 2X','etf');// the word itself
  put('990201','KODEX 가상반도체 레버리지','etf');// a sector: no company is called that
  put('990202','ACE 가상지수150 인버스','etf');// an index
  put('990203','KODEX 가나 레버리지','etf');// a name the rule cannot place (an abbreviation of a company)
  put('990204','KODEX 가상반도체','etf');// unleveraged
  return d;}
const ON={leveragedEtps:{enabled:true,auto:true,brokerEligible:true,maxPctOfEquity:20,maxHoldingDays:10}};
const buy=(e,symbol,extra={})=>e.check({account:'a',symbol,side:'Buy',notional:10000,equity:1000000,holdings:[],...extra});

test('recognized by name both ways: one company is single-stock; a sector, an index or an unplaced name is not',()=>{
  const e=new Exposure(db());const single=s=>e.classify(s).singleStock;
  assert.deepEqual(['990101','990102','990103'].map(single),[true,true,true],'a company name with a brand, an ETN issuer and words between, or the word 단일종목');
  assert.deepEqual(['990201','990202'].map(single),[false,false],'sector and index names are no company\'s name');
  // An abbreviation of a company matches no listed name: treated as an index or sector product. Refusing every unplaced
  // name would refuse every sector product; the user's setting fixes a misread one.
  assert.equal(single('990203'),false,'unplaced: index or sector');
  assert.equal(e.classify('990204').singleStock,undefined,'an unleveraged ETF is not classified at all');
  assert.equal(e.classify('990001').kind,'standard','the company itself is a stock');
  // The rule alone, with a set of names.
  const names=new Set(['가나전자']);assert.equal(singleStockName('RISE 가나전자 인버스2X',c=>names.has(c)),true);assert.equal(singleStockName('RISE 반도체 인버스2X',c=>names.has(c)),false);
});
test('the user\'s setting wins either way, and removing it returns to the rule',()=>{
  const e=new Exposure(db());
  e.setSingleStock('990203',true);assert.deepEqual([e.classify('990203').singleStock,e.classify('990203').singleStockSource],[true,'Your setting']);
  e.setSingleStock('990101',false);assert.equal(e.classify('990101').singleStock,false,'a misread single-stock product');
  assert.deepEqual(e.kindOverrides(),[{symbol:'990101',singleStock:false},{symbol:'990203',singleStock:true}]);
  e.setSingleStock('990203',null);assert.equal(e.classify('990203').singleStock,false);
  assert.throws(()=>e.setSingleStock('NASD:X',true),/INVALID_REQUEST/);assert.throws(()=>e.setSingleStock('990101','yes'),/INVALID_REQUEST/);
});
test('the switch: off by default and per account; off refuses a single-stock buy with words, on follows the same rules; sales always pass',()=>{
  const e=new Exposure(db());assert.equal(e.policy('a').leveragedEtps.singleStock,false,'off by default');e.savePolicy('a',ON);
  assert.throws(()=>buy(e,'990101'),/SINGLE_STOCK_LEVERAGED/);assert.equal(buy(e,'990201').requiresApproval,false,'a sector product passes');
  assert.equal(e.check({account:'a',symbol:'990101',side:'Sell',notional:10000,equity:1000000,holdings:[]}).requiresApproval,false,'a sale passes');
  e.savePolicy('a',{leveragedEtps:{singleStock:true}});assert.equal(buy(e,'990101').requiresApproval,false,'on: allowed');assert.equal(e.policy('b').leveragedEtps.singleStock,false,'per account');
  assert.throws(()=>buy(e,'990101',{notional:300000}),/LEVERAGED_EXPOSURE_LIMIT/,'on: the same cap');
  e.savePolicy('a',{leveragedEtps:{enabled:false}});assert.throws(()=>buy(e,'990101'),/LEVERAGED_NOT_ENABLED/,'the main switch first');
  assert.throws(()=>e.savePolicy('a',{leveragedEtps:{singleStock:'yes'}}),/INVALID_SETTINGS/);
  const words=require('../electron/activity-today.cjs');const text=JSON.stringify(words);assert.match(text,/single-stock leveraged or inverse products are turned off in Short & leverage/);
});
test('the context: single-stock rows say allowed or not, the room left under the cap, and the warning at the day limit',()=>{
  const e=new Exposure(db());e.savePolicy('a',ON);const day=86400000,now=Date.now();
  const holdings=[{symbol:'990201',quantity:1,marketValue:50000}];const universe=[{symbol:'990101',name:'KODEX 가나전자 레버리지'},{symbol:'990201',name:'KODEX 가상반도체 레버리지'}];
  let c=e.context('a',universe,holdings,1000000,()=>now-10*day);
  assert.deepEqual(c.products.find(p=>p.symbol==='990101'),{symbol:'990101',factor:2,kind:'leveraged',singleStock:true,allowed:false,reason:'Single-stock products are turned off in Short & leverage.'});
  assert.deepEqual(c.products.find(p=>p.symbol==='990201'),{symbol:'990201',factor:2,kind:'leveraged'},'a sector row is unchanged');
  assert.equal(c.leveragedEtps.singleStockAllowed,false);assert.equal(c.leveragedEtps.roomPctOfEquity,15,'20% cap less 5% held');
  assert.match(c.warnings[0],/held 10 of 10 days/,'a warning at the limit day, not only after it');
  assert.deepEqual(e.context('a',universe,holdings,1000000,()=>now-9*day).warnings,[],'before the limit: none');
  e.savePolicy('a',{leveragedEtps:{singleStock:true}});c=e.context('a',universe,holdings,1000000,()=>now);assert.equal(c.products.find(p=>p.symbol==='990101').allowed,true);assert.equal(c.leveragedEtps.singleStockAllowed,true);
});
test('the instruction text: no session rule, the decay fact, a hedge use, and the single-stock fact; the versions moved',()=>{
  const sentence=RI.REVIEW_CORE.slice(RI.REVIEW_CORE.indexOf(' A leveraged or inverse ETF trade'),RI.REVIEW_CORE.indexOf(' A symbol outside the review universe'));assert.ok(sentence.length>200);
  for(const t of [sentence,RI.PROPOSED_REVIEW_PARTS.find(p=>p.id==='leveraged').text]){assert.doesNotMatch(t,/this or the next session/);assert.match(t,/hedge/);assert.match(t,/singleStockAllowed is true/);assert.doesNotMatch(t,/stronger evidence/,'no evidence bar set by built-in text');}
  assert.match(RI.REVIEW_CORE,/Daily-reset leverage decays over longer and sideways holds\./);assert.match(RI.REVIEW_CORE,/held for any horizon up to maxHoldingDays/);
  assert.match(RI.SCOUT_CORE,/singleStockAllowed is true/);assert.match(RI.PROPOSED_SCOUT_PARTS[0].text,/singleStockAllowed is true/);
  assert.deepEqual([RI.INSTRUCTIONS_VERSION,RI.ORDERS_VERSION,RI.PROPOSED_VERSION,RI.PROPOSED_ORDERS_VERSION,RI.SCOUT_INSTRUCTIONS_VERSION],['review 2026-11-24','review 2026-11-24 orders','proposed 2026-11-24','proposed 2026-11-24 orders','scout 2026-11-21']);
  // The fingerprint moved, so a Claude dry run of the earlier version no longer counts (claude-start-stop.test.cjs).
  assert.notEqual(RI.fingerprint(),'36fe9b8abbd1bbea');
});
