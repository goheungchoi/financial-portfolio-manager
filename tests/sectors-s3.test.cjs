// Sectors S3 (artifacts/reviews/2026-11-25-sectors): the agent's portfolioExposure (and the scout's, and the Exposure view)
// read the same resolver as the screens, so a holding's sector there is your label, the fixed table's, the stored
// assignment's, or "Unclassified", never KIS's raw category. No instruction text changes. Made-up holdings.
const test=require('node:test'),assert=require('node:assert/strict');const pr=require('../electron/portfolio-risk.cjs');const S=require('../electron/sectors.cjs');
const holdings=[{symbol:'990001',name:'Fixture Chips',market:'KR',valueKRW:5000000},{symbol:'990002',name:'Fixture Pharma',market:'KR',valueKRW:3000000},{symbol:'990003',name:'Fixture Parts',market:'KR',valueKRW:2000000}];
const opts=sector=>({daily:()=>[],beta:()=>null,cashKRW:0,sector});

test('before and after: KIS\'s raw categories become the common sectors; an untold holding is Unclassified, as on the screen',()=>{
  const raw={'990001':'전기·전자','990002':'제약','990003':'운송장비·부품'};
  const before=pr.exposure(holdings,opts(s=>raw[s])).sectors;
  assert.deepEqual(before,[{name:'전기·전자',weightPct:50},{name:'제약',weightPct:30},{name:'운송장비·부품',weightPct:20}]);
  const stored={'990001':{sector:'Information Technology',detail:'Semiconductors',model:'m',at:1,category:'전기·전자'},'990003':{sector:'Unclassified',model:'m',at:1,category:'운송장비·부품'}};
  const resolved=s=>S.resolve({symbol:s,kisNames:[raw[s]],stored:stored[s]??null}).sector;
  const after=pr.exposure(holdings,opts(resolved)).sectors;
  assert.deepEqual(after,[{name:'Information Technology',weightPct:50},{name:'Health Care',weightPct:30},{name:'Unclassified',weightPct:20}]);
});

test('main wires automation.sectorOf to the resolver the screens use',()=>{
  const src=require('node:fs').readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  assert.ok(src.includes("automation.sectorOf=symbol=>{try{return sectorOf?.(symbol)?.sector??null;}catch{return null;}};"));
  assert.ok(!src.includes("automation.sectorOf=symbol=>research.cached(symbol,'overview')?.value?.sectorName"),'no longer KIS\'s raw overview name');
});
