const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {Assessments,TOOL,SECTIONS}=require('../electron/assessments.cjs');
const t0=Date.parse('2026-10-29T05:00:00Z'),DAY=86400000;
const ctx=(over={})=>({userGuidelines:'Goal: aggressive growth',objective:'Grow',quotes:[{symbol:'028050',price:60300}],positions:{'028050':{quantity:3}},universe:[{symbol:'028050'},{symbol:'064350'}],eventCalendar:[],...over});
const full=(over={})=>({symbol:'028050',sections:['thesis','financials','valuation','catalysts'],strategy:'long-term',horizon:'12 months',thesis:'Overseas plant orders keep margins above 8%.',invalidation:'Order backlog falls two quarters running',
  evidence:[{claim:'Q2 operating margin 9.1%',sourceId:'dart:20260814000123',published:'2026-08-14',retrieved:'2026-10-29T09:00+09:00'}],assumptions:'PER 9 on 2026 EPS',unresolved:['Q3 margin repeatability'],nextCatalyst:{event:'Q3 results',date:'2026-10-29T15:30+09:00'},refreshWhen:'Q3 results or a new large order',conflict:false,conflictNote:'',...over});
const setup=()=>{let now=t0;const db=new DatabaseSync(':memory:');return {a:new Assessments(db,()=>now),db,at:t=>{now=t;}};};
const view=(a,c=ctx(),opts={})=>a.context('s',{context:c,symbols:['028050','064350'],...opts})[0];

test('an unchanged assessment comes back whole, with its sources, dates and open questions, and nothing stale',()=>{
  const {a,at}=setup();assert.equal(a.save('s',full(),{context:ctx(),reviewId:'R1',symbols:['028050']}).status,'saved');at(t0+3600000);
  const v=view(a);assert.deepEqual(v.stale,[]);assert.equal(v.staleBecause,undefined);assert.equal(v.evidence[0].sourceId,'dart:20260814000123');assert.equal(v.evidence[0].published,'2026-08-14');
  assert.deepEqual(v.unresolved,['Q3 margin repeatability']);assert.equal(v.priceAt,60300);assert.equal(view(a,ctx(),{symbols:['064350']}),undefined,'no assessment: research as usual');
});
test('new results make financials and valuation stale; a filing makes the thesis and financials stale',()=>{
  const {a,at}=setup();a.save('s',full({nextCatalyst:{event:'Q3 results',date:'2026-11-05'}}),{context:ctx(),symbols:['028050']});at(t0+DAY);
  const results=view(a,ctx({eventCalendar:[{date:'2026-10-30',kind:'earnings',symbol:'028050',title:'삼성E&A results announcement'}]}));assert.deepEqual(results.stale,['financials','valuation']);assert.match(results.staleBecause[0],/Results due 2026-10-30/);
  const filing=view(a,ctx(),{events:[{symbols:['028050'],kind:'disclosure',title:'단일판매ㆍ공급계약체결',firstSeenAt:t0+3600000}]});assert.deepEqual(filing.stale,['thesis','financials']);
  assert.deepEqual(view(a,ctx(),{events:[{symbols:['028050'],kind:'headline',importance:'normal',title:'x',firstSeenAt:t0+1}]}).stale,[],'an ordinary headline does not');
});
test('a price move makes only valuation stale; refreshing valuation keeps the filings read before',()=>{
  const {a,at}=setup();a.save('s',full({nextCatalyst:{event:'Q3 results',date:'2026-11-05'}}),{context:ctx(),symbols:['028050']});at(t0+3600000);
  const moved=ctx({quotes:[{symbol:'028050',price:63000}]});assert.deepEqual(view(a,moved).stale,['valuation']);
  const r=a.save('s',{...full(),sections:['valuation'],assumptions:'PER 9.5 after the rally',evidence:[]},{context:moved,symbols:['028050']});assert.deepEqual(r.reused,['thesis','financials','catalysts']);
  const v=view(a,moved);assert.deepEqual(v.stale,[]);assert.equal(v.assumptions,'PER 9.5 after the rally');assert.equal(v.evidence[0].sourceId,'dart:20260814000123','financial evidence kept');assert.equal(v.priceAt,63000);
});
test('conflicting sources ask for investigation; evidence needs its source; only holdings and universe symbols',()=>{
  const {a}=setup();a.save('s',full({conflict:true,conflictNote:'DART backlog differs from the IR deck'}),{context:ctx(),symbols:['028050']});
  const v=view(a);assert.ok(v.stale.includes('thesis'));assert.match(v.staleBecause.join(' '),/IR deck/);assert.equal(v.conflict,'DART backlog differs from the IR deck');
  assert.equal(a.save('s',full({evidence:[{claim:'x',sourceId:'',published:'',retrieved:''}]}),{context:ctx(),symbols:['028050']}).status,'rejected');
  assert.equal(a.save('s',full({symbol:'005930'}),{context:ctx(),symbols:['028050']}).status,'rejected');assert.equal(a.save('s',full({sections:[]}),{context:ctx(),symbols:['028050']}).status,'rejected');
});
test('assessments stay with their account and instruction version, go stale with age and lapse after a month',()=>{
  const {a,at}=setup();a.save('s',full(),{context:ctx(),symbols:['028050']});
  assert.equal(a.context('other',{context:ctx(),symbols:['028050']}).length,0,'another account');
  assert.equal(view(a,ctx({userGuidelines:'Goal: capital preservation'})),undefined,'other guidelines');
  at(t0+15*DAY);assert.deepEqual(view(a).stale,SECTIONS,'over two weeks: every section');at(t0+31*DAY);assert.equal(view(a),undefined,'dropped after a month');
});
test('the tool is strict and the scheduler offers it; shadow runs cannot write',async()=>{
  assert.equal(TOOL.strict,true);assert.deepEqual(TOOL.parameters.required.sort(),Object.keys(TOOL.parameters.properties).sort());
  const {Automation}=require('../electron/automation.cjs');const {PaperEngine}=require('../electron/paper-engine.cjs');const db=new DatabaseSync(':memory:');
  const a=new Automation(db,new PaperEngine(db,[{symbol:'005930',price:1,name:'F'}],()=>[]),{request:async()=>({})},()=>{});
  const actions=a.deskActions('s',ctx(),'R1',()=>{});assert.equal((await actions.save_assessment(full())).status,'saved');assert.equal(a.assessments.context('s',{context:ctx(),symbols:['028050']}).length,1);
  const src=require('node:fs').readFileSync(require.resolve('../electron/automation.cjs'),'utf8');assert.match(src,/save_assessment:noop\('save_assessment'\)/,'shadow runs get a no-op');
});
test('the context holds at most eight, holdings first, four evidence items each',()=>{
  const {a,at}=setup();const symbols=Array.from({length:12},(_,i)=>String(100000+i));const c=ctx({positions:{[symbols[0]]:{quantity:1}},universe:symbols.map(symbol=>({symbol})),quotes:[]});
  symbols.forEach((symbol,i)=>{at(t0+i*1000);a.save('s',full({symbol,evidence:Array.from({length:6},(_,k)=>({claim:'c'+k,sourceId:'s'+k,published:'',retrieved:''}))}),{context:c,symbols});});
  const list=a.context('s',{context:c,symbols});assert.equal(list.length,8);assert.equal(list[0].symbol,symbols[0],'the holding first');assert.equal(list[1].symbol,symbols[11],'then the newest');assert.equal(list[0].evidence.length,4);assert.equal(list[0].held,true);
});
