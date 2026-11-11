// Release gate 1.5.52, G5: the live records keep acceptedAt as an ISO text and some fills have no filledObservedAt; a
// text time made the Movement section throw and blank the window. Fill times are read as numbers or ISO texts, a fill
// with none is left out, the day helpers never throw, and a section that throws shows one line instead of the page.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {movementRecords,fillTime}=require('../electron/movement-records.cjs');

test('fill time: filledObservedAt, else acceptedAt (number or ISO text), else createdAt; none valid is left out',()=>{
  const iso='2026-10-30T14:12:24.256Z',ms=Date.parse(iso);
  assert.equal(fillTime({filledObservedAt:5,acceptedAt:iso,createdAt:1}),5);
  assert.equal(fillTime({acceptedAt:iso,createdAt:1}),ms,'a missing filledObservedAt: the ISO acceptedAt, as a number');
  assert.equal(fillTime({filledObservedAt:'not a time',acceptedAt:'also not',createdAt:7}),7);
  assert.equal(fillTime({filledObservedAt:NaN,acceptedAt:null,createdAt:0}),null);
  const r=movementRecords({read:()=>[],orders:()=>[{symbol:'NYSE:RDDT',side:'Buy',filled:1,acceptedAt:iso,createdAt:ms-6000},{symbol:'X',side:'Buy',filled:1,acceptedAt:'garbage'}]});
  assert.deepEqual(r.fills,{'NYSE:RDDT':[{side:'Buy',filled:1,at:ms}]},'the fill with no valid time is left out');
});

test('the day helpers return null for a bad time; a fill without a finite time falls back to "first recorded"',async()=>{
  const {seoulDay,newYorkDay,holdingMovement}=await import('../src/holding-movement.mjs');
  for(const bad of ['2026-10-30T14:12:24.256Z',NaN,undefined,null,{}])assert.equal(seoulDay(bad),null),assert.equal(newYorkDay(bad),null);
  assert.equal(seoulDay(Date.parse('2026-11-10T16:00:00Z')),'2026-11-11');
  const row={symbol:'NYSE:RDDT',name:'Reddit',market:'US',currency:'USD',quantity:1,price:100.5,cost:97.42,valueKRW:135000};
  const days=[{day:'2026-10-31',fx:1335,positions:[{symbol:'NYSE:RDDT',quantity:1,value:91.73,cost:97.42}]}];
  const m=holdingMovement({row,closes:null,days,fills:[{side:'Buy',filled:1,at:'2026-10-30T14:12:24.256Z'}],period:'Since purchase',today:'2026-11-11',now:Date.parse('2026-11-11T05:00:00Z')});
  assert.deepEqual(m.purchase,{day:'2026-10-31',marketDay:'2026-10-31',source:'first recorded'},'a text time inside the module is not a fill');
  assert.equal(holdingMovement({row,closes:null,days,fills:[],period:'1M',today:'2026-11-11',now:NaN}).price.to,'2026-11-11','a bad "now" falls back to today');
});

test('SectionBoundary: a render error puts one line in the section and does not throw past it',async()=>{
  const ts=require('typescript');const src=fs.readFileSync(path.join(__dirname,'../src/SectionBoundary.tsx'),'utf8');
  const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};new Function('require','module','exports',js)(require,mod,mod.exports);const {SectionBoundary}=mod.exports;
  assert.deepEqual(SectionBoundary.getDerivedStateFromError(new Error('x')),{failed:true});
  const b=new SectionBoundary({label:'Movement',className:'holding-movement',children:'content'});const errors=[];const orig=console.error;console.error=(...a)=>errors.push(a);
  try{b.componentDidCatch(new RangeError('Invalid time value'));}finally{console.error=orig;}assert.match(String(errors[0][0]),/^Movement could not be shown:/);
  assert.equal(b.render(),'content','no error: the children as they are');
  b.state={failed:true};const {renderToStaticMarkup}=require('react-dom/server');
  assert.equal(renderToStaticMarkup(b.render()),'<section class="holding-movement" aria-label="Movement" data-section-error="true"><p class="muted" role="status">This section could not be shown.</p></section>');
});
