// Fixes from the fact check (artifacts/reviews/2026-11-11-agent-tools/facts-fix-plan.md): X1 the KRX after-hours
// single-price auction ended on 2026-09-14; X2 leveraged and inverse products need the user's confirmation that the
// broker lets the account buy them; X6 sessions are dated rows with sources, listed in docs/EXTERNAL-FACTS.md.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');
const MS=require('../electron/market-sessions.cjs');
const kst=s=>Date.parse(s+'+09:00');const allOn={krNxt:true,krxSingle:true,usPre:true,usAfter:true,usDaytime:true};

// X1
test('X1: no session list contains the KRX single-price auction, before or after it ended, on any account',()=>{
  for(const day of ['2026-09-11','2026-09-14','2026-10-20','2026-11-11','2027-03-02'])for(const environment of ['live','mock']){
    const ids=MS.sessionsOn('KR',day,{environment,enabled:allOn}).map(s=>s.id);assert.ok(!ids.includes('krx-single'),day);
    assert.ok(ids.includes('krx-regular')||!ids.length,day);}
  const status=MS.marketStatus('KR',kst('2026-10-20T16:30'),{environment:'live',enabled:allOn});assert.ok(!status.sessions.some(s=>s.id==='krx-single'));assert.notEqual(status.next?.id,'krx-single');
  assert.ok(!('krx-single' in MS.TOGGLES)&&!('krx-single' in MS.ROUTES));
  assert.deepEqual(MS.ENDED_SESSIONS.map(s=>[s.id,s.to]),[['krx-single','2026-09-14']]);
});
test('X1: at 16:30 KST with only the old switch saved nothing is tradable; with NXT on, NXT is used',()=>{
  assert.equal(MS.tradableNow('KR',kst('2026-10-20T16:30'),{environment:'live',enabled:{krxSingle:true}}),null);
  assert.equal(MS.tradableNow('KR',kst('2026-10-20T16:30'),{environment:'live',enabled:allOn}).id,'nxt-after');
  for(const t of ['16:01','17:00','17:54'])assert.equal(MS.tradableNow('KR',kst('2026-10-20T'+t),{environment:'live',enabled:{krxSingle:true}}),null,t);
});
test('X1: a saved profile with the old switch loads, ignores it, and saves settings normally',()=>{
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');
  const db=new DatabaseSync(':memory:');const first=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'X',price:1}],()=>[]),{},()=>{});
  const saved=JSON.parse(db.prepare('SELECT payload FROM automation_settings WHERE id=1').get().payload);db.prepare('UPDATE automation_settings SET payload=? WHERE id=1').run(JSON.stringify({...saved,sessionKrxSingle:true,sessionKrNxt:true}));
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',name:'X',price:1}],()=>[]),{},()=>{});
  assert.equal('sessionKrxSingle' in a.config,false);assert.equal(a.config.sessionKrNxt,true,'other saved settings kept');assert.equal('krxSingle' in a.sessionOptions(),false);
  a.configure({...a.config,sessionKrxSingle:true,extendedMaxOrderPct:6});assert.equal(a.config.extendedMaxOrderPct,6,'a window still sending the old key can save');assert.equal('sessionKrxSingle' in a.config,false);
  assert.throws(()=>a.configure({noSuchSetting:true}),/INVALID_SETTINGS/,'other unknown keys are still refused');void first;
});
test('X1: the Extended hours card has four switches and no single-price text; the AI is no longer told about the auction',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/EngineSettings.tsx'),'utf8');const card=src.slice(src.indexOf('function ExtendedSessions'),src.indexOf('</Card>',src.indexOf('function ExtendedSessions')));
  assert.equal((card.match(/\{row\('/g)??[]).length,4);assert.ok(!/single price'|order type 07|sessionKrxSingle/.test(card));assert.match(card,/KRX ended its after-hours single-price auction on 2026-09-14/);
  const {REVIEW_INSTRUCTIONS,INSTRUCTIONS_VERSION}=require('../electron/ai-client.cjs');assert.ok(!/single-price/.test(REVIEW_INSTRUCTIONS));assert.match(INSTRUCTIONS_VERSION,/^review 2026-11-1[12]/,'review 2026-11-11.2 removed the auction; later versions (2026-11-12: replaces on set_conditional_order) keep it removed');
});

// X2
const {Exposure,leveragedAccess}=require('../electron/exposure.cjs');
const exposureDb=()=>{const d=new DatabaseSync(':memory:');d.exec("CREATE TABLE securities(symbol TEXT PRIMARY KEY,name TEXT,englishName TEXT,market TEXT,type TEXT,isin TEXT,industry TEXT);INSERT INTO securities VALUES('122630','KODEX 레버리지','','KOSPI','etf','',NULL)");return d;};
test('X2: leveraged products are allowed only with the switch on and eligibility confirmed, otherwise with a reason',()=>{
  assert.deepEqual(leveragedAccess({enabled:false,brokerEligible:true}),{allowed:false,reason:"Off in the user's settings."});
  assert.deepEqual(leveragedAccess({enabled:true,brokerEligible:null}),{allowed:false,reason:'The user has not confirmed that the broker lets this account buy leveraged or inverse products.'});
  assert.deepEqual(leveragedAccess({enabled:true,brokerEligible:false}),{allowed:false,reason:'The user says the broker does not let this account buy leveraged or inverse products.'});
  assert.deepEqual(leveragedAccess({enabled:true,brokerEligible:true}),{allowed:true});
});
test('X2: eligibility starts not confirmed, also for an account whose saved switch is on, and saves true, false or null only',()=>{
  const d=exposureDb();d.exec('CREATE TABLE IF NOT EXISTS product_overrides(symbol TEXT PRIMARY KEY,factor REAL NOT NULL);CREATE TABLE IF NOT EXISTS exposure_policy(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  d.prepare('INSERT INTO exposure_policy VALUES(?,?)').run('old',JSON.stringify({leveragedEtps:{enabled:true,auto:false,maxPctOfEquity:20,maxHoldingDays:10}}));
  const e=new Exposure(d);assert.equal(e.policy('old').leveragedEtps.brokerEligible,null,'saved before X2: not confirmed');assert.equal(e.policy('old').leveragedEtps.enabled,true,'the switch is kept');
  assert.equal(e.context('old',[{symbol:'122630',name:'KODEX 레버리지'}],[],1e6,()=>null).leveragedEtps.allowed,false);
  for(const bad of ['yes',1,'true',{}])assert.throws(()=>e.savePolicy('old',{leveragedEtps:{brokerEligible:bad}}),/INVALID_SETTINGS/);
  e.savePolicy('old',{leveragedEtps:{brokerEligible:true}});const c=e.context('old',[{symbol:'122630',name:'KODEX 레버리지'}],[],1e6,()=>null);assert.equal(c.leveragedEtps.allowed,true);assert.equal(c.leveragedEtps.reason,undefined);
  e.savePolicy('old',{leveragedEtps:{brokerEligible:null}});assert.equal(e.policy('old').leveragedEtps.brokerEligible,null);
});
test('X2: the AI context carries the reason, and an opening on a leveraged product is held back while not confirmed',()=>{
  const e=new Exposure(exposureDb());e.savePolicy('a',{leveragedEtps:{enabled:true}});const c=e.context('a',[{symbol:'122630',name:'KODEX 레버리지'}],[],1e6,()=>null);
  assert.equal(c.leveragedEtps.allowed,false);assert.match(c.leveragedEtps.reason,/has not confirmed/);assert.deepEqual(c.products,[{symbol:'122630',factor:2,kind:'leveraged'}]);
  const SA=require('../electron/strategy-axes.cjs');const context={productRisk:c};
  assert.match(SA.gap({action:'Buy',symbol:'122630',quantity:1,credit:'none',plan:{horizon:'short-term',horizonDays:3}},context),/leveraged product \(2x daily\) is not permitted/);
  e.savePolicy('a',{leveragedEtps:{brokerEligible:true}});assert.equal(SA.gap({action:'Buy',symbol:'122630',quantity:1,credit:'none',plan:{horizon:'short-term',horizonDays:3}},{productRisk:e.context('a',[{symbol:'122630',name:'KODEX 레버리지'}],[],1e6,()=>null)}),null);
});
test('X2: the Short & leverage tab has the eligibility row, the notice and the details',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/ShortLeverage.tsx'),'utf8');
  for(const s of ['My KIS account can buy these products','KIS requires a basic deposit and investor education.','Not offered to the AI until you confirm eligibility.','>Not confirmed<','Why the app asks'])assert.ok(src.includes(s),s);
});

// X6
test('X6: every session row is dated and names a source listed in docs/EXTERNAL-FACTS.md',()=>{
  const facts=fs.readFileSync(path.join(__dirname,'../docs/EXTERNAL-FACTS.md'),'utf8');const t=MS.sessionTable();
  for(const s of [...t.KR,...t.US,...t.ended]){assert.ok('from' in s&&'to' in s,s.id);assert.match(s.source,/^F-[A-Z0-9-]+$/,s.id);assert.ok(facts.includes('`'+s.source+'`'),s.source+' is in the facts list');}
  assert.ok(t.ended.every(s=>s.to),'an ended session has its end date');
  const ids=[...facts.matchAll(/^\| `(F-[A-Z0-9-]+)` \|/gm)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,'fact ids are unique');
  for(const row of facts.split('\n').filter(l=>/^\| `F-/.test(l)))assert.match(row,/\| 2026-\d\d-\d\d \|/,'each fact has the date it was checked: '+row.slice(0,40));
});
test('X6: a session with an end date stops being listed from that date',()=>{
  // The filter used by sessionsOn, on a copy of a row: active from `from` until the day before `to`.
  const NXT=MS.sessionTable().KR.find(s=>s.id==='nxt-pre');assert.equal(NXT.from,'2025-03-04');
  assert.ok(MS.sessionsOn('KR','2025-02-28').length>0&&!MS.sessionsOn('KR','2025-02-28').some(s=>s.id==='nxt-pre'),'a trading day before Nextrade opened');assert.ok(MS.sessionsOn('KR','2025-03-04').some(s=>s.id==='nxt-pre'));
});
