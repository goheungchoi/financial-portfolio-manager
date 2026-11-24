// Short selling B3f-3 (artifacts/reviews/2026-11-24-short-selling/rulings-b3f-plan.md 3): Short & leverage gains the
// short's trailing stop and "buy back before the last day"; the stop's label says what it does; switching shorts on asks
// a confirmation with the planner's words; the keep-working confirmation gains its short line once a short can be sent;
// Stop everything names open shorts; the chart's cash buffer says "of holdings and cash" while a short is open.
// Made-up codes and figures.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const ts=require('typescript');const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const ROOT=path.join(__dirname,'..');
test('the confirmation\'s words: three short lines from the settings, a fourth while a short cannot be sent, the rest under More',async()=>{
  const {shortConfirmLines}=await import('../src/short-confirm.mjs');const short={maxGrossPctOfEquity:20,stopLossPct:15,maxDays:90,auto:false};
  const closed=shortConfirmLines(short);assert.deepEqual(closed.main,['Turn on short selling? The app may then sell borrowed shares and buy them back later. A short loses when the price rises, and its loss has no limit.',
    'All shorts together stay within 20% of the account value. Each gets a stop 15% above its sale price, and is bought back before its 90-day loan ends.',
    "While the app is closed, or after Stop everything, a short has no stop: only KIS's own forced buy-back protects it.",
    'The app cannot send a short yet. That is switched on by a later update, after one real test on your account.']);
  assert.equal(closed.more.length,5);for(const w of [/uptick rule/,/KRX only.*ETF short is refused for now/,/estimate until KIS reports it/,/holds the difference back/,/ban list or your KIS loan limit/])assert.ok(closed.more.some(l=>w.test(l)),String(w));
  assert.equal(shortConfirmLines(short,{pathsOpen:true,automatic:false}).main[3],'A short the AI decides is proposed and waits for your approval.','after B4: the value in force');
  assert.equal(shortConfirmLines({...short,auto:true},{pathsOpen:true,automatic:true}).main[3],'A short the AI decides is sent by itself.');
  assert.equal(shortConfirmLines({...short,auto:true},{pathsOpen:true,automatic:false}).main[3],'A short the AI decides is proposed and waits for your approval.','the setting alone does not send it');
  assert.match(shortConfirmLines({...short,maxGrossPctOfEquity:10,stopLossPct:8,maxDays:60}).main[1],/within 10% .* 8% above .* its 60-day loan/);
});
test('the settings: "buy back before the last day" is a whole number of business days from 1 to 20; the trailing stop is on or off',()=>{
  const {Exposure}=require('../electron/exposure.cjs');const e=new Exposure(new DatabaseSync(':memory:'));
  for(const v of [1,5,20])assert.equal(e.savePolicy('a',{short:{coverBeforeDays:v}}).short.coverBeforeDays,v);
  for(const v of [0,21,2.5,'5',null])assert.throws(()=>e.savePolicy('a',{short:{coverBeforeDays:v}}),/INVALID_SETTINGS/,JSON.stringify(v));
  // A stored value outside 1–20 (allowed before) is read as the nearest bound, so the card always saves.
  for(const [stored,read] of [[45,20],[365,20],[0,1],[-3,1],[7.4,7],[null,5],['x',5]]){const db=new DatabaseSync(':memory:');const x=new Exposure(db);db.prepare('INSERT INTO exposure_policy VALUES(?,?)').run('c',JSON.stringify({short:{coverBeforeDays:stored}}));
    assert.equal(x.policy('c').short.coverBeforeDays,read,JSON.stringify(stored));assert.equal(x.savePolicy('c',{short:x.policy('c').short}).short.coverBeforeDays,read,'and it saves');}
  assert.equal(e.savePolicy('a',{short:{trailingStop:true}}).short.trailingStop,true);assert.throws(()=>e.savePolicy('a',{short:{trailingStop:'yes'}}),/INVALID_SETTINGS/);
  assert.equal(new Exposure(new DatabaseSync(':memory:')).policy('b').short.trailingStop,false,'off by default');
});
test('the Short & leverage card: the two controls, the stop\'s label, and the confirmation only when shorts are switched on',()=>{
  const s=fs.readFileSync(path.join(ROOT,'src','ShortLeverage.tsx'),'utf8');
  assert.match(s,/\['stopLossPct','Cover stop above the sale price \(%\)','number',1,100\]/);assert.doesNotMatch(s,/Stop warning at adverse move/);
  assert.match(s,/\['coverBeforeDays','Buy back before the last day \(business days\)','number',1,20,1\]/);
  assert.match(s,/<Row title="Trail the cover stop"/);assert.match(s,/set\(x\.key,'trailingStop',v\)/);
  assert.match(s,/if\(market==='KR'&&draft\.short\.enabled&&!data\.policy!\.short\.enabled&&shortValid\(\)\)setAsking\(true\);else save\(\);/,'asked only when shorts go from off to on, and only once the form is valid');
  assert.match(s,/const shortValid=\(\)=>SECTIONS\.find\(x=>x\.key==='short'\)!\.fields\.every\(/);
  assert.match(s,/\{\.\.\.\(key==='coverBeforeDays'\?\{integer:true,errorText:'Whole business days, 1–20'\}:\{\}\)\}/);
  // The short paths in plain words while they cannot be sent; the engine's wording, which the review reads, is unchanged.
  assert.match(s,/'Opening a short: not available yet\. The app cannot send a short until one real test on your account has confirmed how KIS handles it\.'/);
  assert.match(s,/'Buying a short back: not available yet for the same reason; until then a cover the app proposes waits for your approval\.'/);
  // Shorts on (2026-11-25): what each path does once it can be sent, from the user's switch and the path.
  // (stage 1b: the saved switch, and covers as the conditional-order switches decide; pinned in shorts-on-1b)
  assert.match(s,/k==='short'\?`Opening a short: sent \$\{data\.policy!\.short\.auto&&ps\.automatic\?'by itself':'after your approval'\}, within your cap\.`/);
  const CP=require('../electron/credit-paths.cjs');assert.equal(CP.pathStatus('short',{shortsOn:true}).executable,true);assert.equal(CP.pathStatus('cover',{shortsOn:true}).executable,true);
  assert.match(s,/shortConfirmLines\(draft\.short,\{pathsOpen:paths\.short\?\.executable===true&&paths\.cover\?\.executable===true,automatic:paths\.short\?\.automatic===true\}\)/);
  assert.match(s,/role="dialog" aria-label="Turn on short selling"/);
});
test('Stop everything names open shorts; with none, its reply is as before',()=>{
  const L=require('../electron/auto-launch.cjs');assert.equal(L.stopShortWords([]),'');
  assert.equal(L.stopShortWords(['990010'])," Your short of 990010 has no stop now: only KIS's own forced buy-back protects it.");
  assert.equal(L.stopShortWords([{symbol:'990010',name:'Fixture short A'}])," Your short of Fixture short A (990010) has no stop now: only KIS's own forced buy-back protects it.",'by name with its code');
  assert.equal(L.stopShortWords(['990010','990020','990010']),' Your shorts of 990010, 990020 have no stop now: only KIS\'s own forced buy-back protects them.');
  const {Automation}=require('../electron/automation.cjs');const a=Object.create(Automation.prototype);a.watchStopped={stopEverything(){}};a.syncConditionalPermits=()=>{};a.config={enabled:false};a.live=null;a.usLive=null;
  const auto=require('../electron/auto-launch.cjs'),stop=auto.stop;auto.stop=()=>{};try{
    a.shortBalance=()=>({shorts:[]});assert.equal(a.stopEverything(),L.EVERYTHING_STOPPED,'no short: as before');
    a.shortBalance=()=>({shorts:[{symbol:'990010',name:'Fixture short A',quantity:10},{symbol:'990020',quantity:0}]});assert.equal(a.stopEverything(),L.EVERYTHING_STOPPED+" Your short of Fixture short A (990010) has no stop now: only KIS's own forced buy-back protects it.");
  }finally{auto.stop=stop;}
});
test('the keep-working confirmation gains its short line only once a short can be sent; the cash buffer says "of holdings and cash" while a short is open',async()=>{
  const k=fs.readFileSync(path.join(ROOT,'src','KeepWorking.tsx'),'utf8');assert.match(k,/\{\(state as \{shortsCanOpen\?:boolean\}\)\.shortsCanOpen&&<p>A short's cover stop is watched the same way/);
  assert.match(fs.readFileSync(path.join(ROOT,'electron','automation.cjs'),'utf8'),/shortsCanOpen:\(\(\)=>\{try\{return this\.shortFactsInForce\(\);\}catch\{return false;\}\}\)\(\)/);
  const src=fs.readFileSync(path.join(ROOT,'src','AllocationChart.tsx'),'utf8');const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};new Function('require','module','exports',js)(n=>n==='./useDraftState'?{useDraftState:(k,v)=>React.useState(v)}:require(n),mod,mod.exports);
  const buckets=[{label:'Fixture holding C',value:100000,percent:0,color:'#888'},{label:'Cash',value:200000,percent:0,color:'#7e858c'}];
  const draw=p=>renderToStaticMarkup(React.createElement(mod.exports.AllocationChart,{buckets,equity:300000,...p}));
  assert.match(draw({}),/66\.7% of equity<\/b>/);assert.equal(draw({}),draw({shortsOpen:false}));assert.match(draw({shortsOpen:true}),/66\.7% of holdings and cash<\/b>/);
});

test('the field\'s own error words: "Whole business days, 1–20" for a value out of range and for a fraction',()=>{
  const src=fs.readFileSync(path.join(ROOT,'src','SettingsUI.tsx'),'utf8');const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};new Function('require','module','exports',js)(n=>n.startsWith('.')?new Proxy({},{get:(_,k)=>k==='__esModule'?true:()=>null}):require(n),mod,mod.exports);
  const field=(value,extra={})=>renderToStaticMarkup(React.createElement(mod.exports.NumberField,{label:'x',value,min:1,max:20,step:1,unit:'business days',onChange(){},...extra}));
  const own={integer:true,errorText:'Whole business days, 1–20'};
  for(const v of [0,21,2.5])assert.match(field(v,own),/<small class="field-error" role="alert">Whole business days, 1–20<\/small>/,String(v));
  assert.doesNotMatch(field(5,own),/field-error/);
  assert.match(field(25),/Allowed 1–20business days/,'other fields: as before');assert.doesNotMatch(field(2.5),/field-error/,'other fields: a fraction is not flagged, as before');
});
