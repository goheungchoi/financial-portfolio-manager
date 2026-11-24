// Carried scout targets (artifacts/reviews/2026-11-24-scout-carried; the user: "I like these ideas. Can we add this
// revision to this release"): any scout run may restate a carried target from what it already has; each carried target
// carries its facts (priceWhenSet, priceNow, movePct, sessionsSince) to the scout and to the review; a passed verdict
// flags a carried target whatever its role. The review's instructions and fingerprints do not change. Made-up symbols.
const test=require('node:test');const assert=require('node:assert/strict');
const S=require('../electron/scout.cjs');const RI=require('../electron/review-instructions.cjs');
const kst=s=>Date.parse(s+':00+09:00'),ny=s=>require('../electron/market-sessions.cjs').zoned(s.slice(0,10),s.slice(11),'America/New_York');
const T=(symbol,role,extra={})=>({symbol,name:symbol,role,targetWeightPct:5,thesis:'t',risks:'r',...extra});

test('the live case: a U.S.-focused run restates a carried Korean trim target; it replaces that one only, the other Korean targets carry, the U.S. targets as returned',()=>{
  const prevAt=kst('2026-11-24T08:40');const now=kst('2026-11-24T22:40');
  const previous={timestamp:prevAt,plan:{targets:[T('990010','trim',{thesis:'Trim unless it reclaims 100 within 30 minutes of the open.',priceWhenSet:95,priceWhenSetAt:prevAt}),T('990020','hold'),T('990030','candidate'),T('NASD:XYZ','hold')]}};
  const plan={summary:'s',targets:[T('NASD:XYZ','add'),T('NASD:XYW','candidate'),T('990010','hold',{thesis:'It reclaimed 100 after the open; the trim condition passed.'})]};
  const merged=S.carryForward(plan,previous,['KR'],now);
  assert.deepEqual(merged.targets.map(t=>`${t.symbol}:${t.role}`),['NASD:XYZ:add','NASD:XYW:candidate','990010:hold','990020:hold','990030:candidate']);
  const restated=merged.targets.find(t=>t.symbol==='990010');assert.equal(restated.carriedFrom,undefined,'a new target: no carriedFrom');assert.match(restated.thesis,/condition passed/);
  for(const s of ['990020','990030'])assert.equal(merged.targets.find(t=>t.symbol===s).carriedFrom,new Date(prevAt).toISOString());
  // The run's price is stamped on the restated target as on any new one (automation.priceTargets runs before carryForward).
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','automation.cjs'),'utf8');
  assert.match(src,/const plan=scoutLib\.carryForward\(this\.priceTargets\(result\.plan\),previous,focus\.deferred/);
  assert.match(src,/priceTargets\(plan,now=Date\.now\(\)\)\{const data=this\.formulaData\(\);return \{\.\.\.plan,targets:plan\.targets\.map\(t=>\{if\(t\.carriedFrom\)return t;/);
});
test('a deferred-market symbol NOT in the previous plan is handled as before (the run covers that market); a run with nothing for the deferred market is unchanged byte for byte',()=>{
  const prevAt=kst('2026-11-24T08:40');const now=kst('2026-11-24T22:40');const previous={timestamp:prevAt,plan:{targets:[T('990010','trim'),T('990020','hold')]}};
  const fresh=S.carryForward({summary:'s',targets:[T('NASD:XYZ','add'),T('990099','candidate')]},previous,['KR'],now);
  assert.deepEqual(fresh.targets.map(t=>t.symbol),['NASD:XYZ','990099'],'as before: a new Korean symbol covers Korea, the carried ones are not kept');
  const none={summary:'s',targets:[T('NASD:XYZ','add')]};const merged=S.carryForward(none,previous,['KR'],now);
  assert.equal(JSON.stringify(merged),JSON.stringify({...none,targets:[...none.targets,...previous.plan.targets.map(t=>({...t,carriedFrom:new Date(prevAt).toISOString()}))]}),'HEAD\'s plan, byte for byte');
  // The 72-hour drop and the 16-target cap are unchanged.
  const old={timestamp:prevAt,plan:{targets:[{...T('990010','trim'),carriedFrom:new Date(prevAt-73*3600000).toISOString()}]}};assert.equal(S.carryForward(none,old,['KR'],now).targets.length,1);
  const many={timestamp:prevAt,plan:{targets:Array.from({length:20},(_,i)=>T(String(990100+i),'candidate'))}};assert.equal(S.carryForward(none,many,['KR'],now).targets.length,16);
});
test('the facts: priceWhenSet, priceNow, movePct, and sessionsSince for 0, 1 and 2 sessions, across a weekend and a closed day, Korea and the U.S.; none without a price; none on a target not carried',()=>{
  const facts=(t,price,now,closed=new Set())=>S.carriedFacts(t,{price:()=>price,sessionsSince:(m,since)=>S.sessionsStarted(m,since,now,closed)});
  const kr=at=>({...T('990010','trim'),priceWhenSet:95,carriedFrom:new Date(at).toISOString()});
  // Set Friday 08:40 KST, before the open.
  const fri=kst('2026-11-20T08:40');
  assert.deepEqual(facts(kr(fri),99,kst('2026-11-20T08:59')),{setAt:new Date(fri).toISOString(),priceWhenSet:95,priceNow:99,movePct:4.2,sessionsSince:0},'before the open: 0');
  assert.equal(facts(kr(fri),99,kst('2026-11-20T09:00')).sessionsSince,1,'the open itself counts');
  assert.equal(facts(kr(fri),99,kst('2026-11-23T08:00')).sessionsSince,1,'across the weekend, before Monday\'s open: still 1');
  assert.equal(facts(kr(fri),99,kst('2026-11-23T10:00')).sessionsSince,2,'Monday\'s session: 2');
  assert.equal(facts(kr(fri),99,kst('2026-11-23T10:00'),new Set(['2026-11-23'])).sessionsSince,1,'a closed Monday has no session');
  // The U.S.: set Friday 18:00 New York.
  const us={...T('NASD:XYZ','hold'),priceWhenSet:200,carriedFrom:new Date(ny('2026-11-20T18:00')).toISOString()};
  assert.equal(facts(us,190,ny('2026-11-23T09:29')).sessionsSince,0);assert.equal(facts(us,190,ny('2026-11-23T09:30')).sessionsSince,1);assert.equal(facts(us,190,ny('2026-11-24T12:00')).sessionsSince,2);
  assert.equal(facts(us,190,ny('2026-11-24T12:00')).movePct,-5);
  assert.equal(facts(us,190,ny('2026-11-27T12:00')).sessionsSince,4,'Monday to Wednesday and the half day Friday; Thanksgiving (Thursday) has no session');
  // No price now: no priceNow and no movePct; no stored price: no priceWhenSet and no movePct.
  const noNow=facts(kr(fri),null,kst('2026-11-23T10:00'));assert.equal('priceNow' in noNow,false);assert.equal('movePct' in noNow,false);assert.equal(noNow.priceWhenSet,95);
  const noThen=facts({...kr(fri),priceWhenSet:undefined},99,kst('2026-11-23T10:00'));assert.equal('priceWhenSet' in noThen,false);assert.equal('movePct' in noThen,false);assert.equal(noThen.priceNow,99);
  // Not carried: no facts.
  assert.equal(S.carriedFacts(T('990010','trim'),{price:()=>1}),null);
  // A sessions count that cannot be worked out: none.
  assert.equal('sessionsSince' in S.carriedFacts(kr(fri),{price:()=>1,sessionsSince:()=>{throw new Error('x');}}),false);
});
test('the review sees the facts on carried targets only; the scout sees them on the previous plan\'s deferred-market targets',()=>{
  const rec={timestamp:kst('2026-11-24T22:40'),plan:{summary:'s',cashTargetPct:10,focus:'f',targets:[T('NASD:XYZ','add'),{...T('990010','trim'),priceWhenSet:95,carriedFrom:'2026-11-23T23:40:00.000Z'}]}};
  const ctx=S.reviewContext(rec,kst('2026-11-25T09:30'),{facts:t=>S.carriedFacts(t,{price:()=>99,sessionsSince:()=>1})});
  assert.deepEqual(ctx.targets[0],{symbol:'NASD:XYZ',name:'NASD:XYZ',role:'add',targetWeightPct:5,thesis:'t'},'not carried: as before');
  assert.deepEqual(ctx.targets[1],{symbol:'990010',name:'990010',role:'trim',targetWeightPct:5,thesis:'t',setAt:'2026-11-23T23:40:00.000Z',priceWhenSet:95,priceNow:99,movePct:4.2,sessionsSince:1});
  assert.equal(JSON.stringify(S.reviewContext(rec,kst('2026-11-25T09:30'))),JSON.stringify(S.reviewContext(rec,kst('2026-11-25T09:30'),{facts:null})),'without facts: as before');
  // Worst case: 16 carried targets with every fact add at most this many bytes to the review's plan.
  const one={priceWhenSet:123456.78,priceNow:123456.78,movePct:-99.9,sessionsSince:99};assert.equal(16*Buffer.byteLength(JSON.stringify(one)),1312,'the worst case added to the review request');
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','automation.cjs'),'utf8');
  assert.match(src,/reviewContext\(latestPlan,Date\.now\(\),\{facts:t=>this\.carriedFacts\(t,context\.quotes\),stale:/);
  assert.match(src,/previousPlan:previous\?\{asOf:new Date\(previous\.timestamp\)\.toISOString\(\),\.\.\.previous\.plan,targets:\(previous\.plan\?\.targets\?\?\[\]\)\.map\(t=>\{if\(!focus\.deferred\.includes\(scoutLib\.marketOf\(t\.symbol\)\)\)return t;/);
});
test('staleCarried: a passed verdict flags a carried target whatever its role; the opposite-trade and move rules unchanged',()=>{
  const setAt='2026-11-23T23:40:00.000Z',at=Date.parse('2026-11-24T02:00:00Z');const c=(s,role,extra={})=>({...T(s,role),carriedFrom:setAt,priceWhenSetAt:Date.parse(setAt),...extra});
  const passed=sym=>({timestamp:at,decision:{action:'Hold',symbol:'',planVerdicts:[{symbol:sym,verdict:'passed',reason:'The condition lapsed.'}]}});
  for(const role of ['trim','exit','hold','add','candidate']){const s=S.staleCarried([c('990010',role)],{reviews:[passed('990010')]});assert.equal(s.length,1,role);assert.match(s[0].reasons[0],/passed on it: The condition lapsed\./);}
  assert.equal(S.staleCarried([c('990010','hold')],{reviews:[{timestamp:at,decision:{action:'Sell',symbol:'990010',planVerdicts:[]}}]}).length,1,'opposite trade');
  assert.equal(S.staleCarried([c('990010','trim')],{reviews:[{timestamp:at,decision:{action:'Sell',symbol:'990010',planVerdicts:[]}}]}).length,0,'a sale agrees with trim');
  assert.equal(S.staleCarried([c('990010','trim',{priceWhenSet:100})],{price:()=>106}).length,1,'a 6% move');assert.equal(S.staleCarried([c('990010','trim',{priceWhenSet:100})],{price:()=>105}).length,0);
  assert.equal(S.staleCarried([c('990010','trim')],{reviews:[{...passed('990010'),timestamp:Date.parse(setAt)-1}]}).length,0,'a verdict before the target counts for nothing');
});
test('carried targets add nothing to the review\'s text (its fingerprints are the risk-off step\'s, review 2026-11-25); the scout\'s text says what a run can do with carried targets',()=>{
  assert.equal(RI.fingerprint(),'1004c642ceabd60d');assert.equal(RI.fingerprint(undefined,{orders:true}),'ed412ea0edf116a2');
  for(const core of [RI.SCOUT_CORE,RI.PROPOSED_SCOUT_CORE])assert.match(core,/A carried target can be restated in this plan when its facts show the condition it rests on has passed; it then replaces that target only\. No new target can be added for those markets\./);
  assert.equal(RI.SCOUT_INSTRUCTIONS_VERSION,'scout 2026-11-25b');
});
