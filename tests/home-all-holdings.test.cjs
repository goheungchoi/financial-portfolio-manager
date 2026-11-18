// The Home Holdings card lists every holding, largest value first (artifacts/reviews/2026-11-18-home-all-holdings).
// Before, it listed the top six, so an account with seven holdings left one off the card. The list scrolls
// inside the card past about 10 rows. Home.tsx is transpiled and HomeHoldings rendered with stand-ins for the modules
// it does not need here.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const ts=require('typescript');const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const src=fs.readFileSync(path.join(__dirname,'../src/Home.tsx'),'utf8');
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const stubs={'./pending':{pendingKRW:()=>0},'./useDraftState':{useDraftState:(k,v)=>React.useState(v)},'./AllocationChart':{AllocationChart:()=>null}};
const local=name=>stubs[name]??new Proxy({},{get:(_,k)=>k==='__esModule'?true:()=>null});
const mod={exports:{}};new Function('require','module','exports',js)(n=>n.startsWith('.')?local(n):require(n),mod,mod.exports);
const {HomeHoldings}=mod.exports;
const row=(i,value)=>({symbol:String(100000+i),name:`Company ${i}`,market:'KR',currency:'KRW',quantity:1,price:value,cost:value,valueKRW:value,sector:'X',region:'Korea',color:'#888'});
const render=rows=>renderToStaticMarkup(React.createElement(HomeHoldings,{state:{rows,cash:{KRW:0,USD:0},fx:{usdKRW:1400}},onCompany(){},onAll(){},onRefresh(){},busy:false}));
const names=html=>[...html.matchAll(/class="company-link">([^<]+)</g)].map(m=>m[1]);

test('7 holdings give 7 rows, largest value first; the card is labelled Holdings and the link reads All 7',()=>{
  const values=[500,7000,300,9000,100,800,2000];const html=render(values.map((v,i)=>row(i,v)));
  assert.deepEqual(names(html),['Company 3','Company 1','Company 6','Company 5','Company 0','Company 2','Company 4']);
  assert.match(html,/<section class="home-holdings" aria-label="Holdings">/);assert.doesNotMatch(html,/Top holdings/);
  assert.match(html,/<ul class="compact-rows home-holdings-list">/);assert.match(html,/All 7 →/);});
test('15 holdings give 15 rows (no cut at six)',()=>{
  assert.equal(names(render(Array.from({length:15},(_,i)=>row(i,1000+i)))).length,15);});
test('no holdings: "No positions yet."',()=>{
  const html=render([]);assert.match(html,/<p class="muted">No positions yet\.<\/p>/);assert.doesNotMatch(html,/home-holdings-list/);});
test('the list scrolls inside the card past about 10 rows; a focused name keeps its outline inside the list',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../src/polish.css'),'utf8');
  assert.match(css,/\.home-holdings-list\{max-height:362px;overflow-y:auto;/);
  assert.match(css,/\.home-holdings-list \.company-link:focus-visible\{outline-offset:-2px\}/);});
