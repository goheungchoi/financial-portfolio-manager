// Sectors S1 (artifacts/reviews/2026-11-25-sectors): one common list, one resolver (your label, KIS's category by the
// fixed table, the app's stored assignment, Unclassified), funds never from KIS's product type, and the portfolio rows
// carrying the sector and where it came from. Made-up codes; no account data.
const test=require('node:test'),assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const S=require('../electron/sectors.cjs');

test('the resolver: your label, then the table, then the stored assignment, then Unclassified; clearing the label falls back',()=>{
  const stored={sector:'Industrials',detail:'Shipbuilding',model:'claude-haiku-5-5',at:1795600000000};
  assert.deepEqual(S.resolve({symbol:'990001',user:'My robots',kisNames:['증권'],stored}),{sector:'My robots',detail:null,source:'user'});
  assert.deepEqual(S.resolve({symbol:'990001',user:'  ',kisNames:['증권'],stored}),{sector:'Financials',detail:'Securities',source:'kis',category:'증권'},'a blank label is no label');
  assert.deepEqual(S.resolve({symbol:'990001',kisNames:['운송장비·부품'],stored}),{sector:'Industrials',detail:'Shipbuilding',source:'ai',model:'claude-haiku-5-5',at:1795600000000});
  assert.deepEqual(S.resolve({symbol:'990001',kisNames:[null,'운송장비·부품']}),{sector:'Unclassified',detail:null,source:'none',category:'운송장비·부품'});
  assert.equal(S.resolve({symbol:'990001',kisNames:['전기·전자','제약']}).sector,'Health Care','the first name the table knows');
  assert.equal(S.resolve({symbol:'990001',stored:{sector:'Crypto'}}).source,'none','a stored sector outside the list is ignored');
  assert.equal(S.resolve({symbol:'NASD:ZZZZ',kisNames:['제약']}).sector,'Health Care','the U.S. table for a U.S. listing');
});

test('the table: every mapped name gives a sector of the common list; every unmapped name gives none; the U.S. codes all have a place',()=>{
  for(const [market,rows] of Object.entries(S.KIS_TABLE))for(const [name,row] of Object.entries(rows)){
    assert.ok(S.SECTORS.includes(row.sector),market+' '+name);assert.deepEqual(S.kisSector(market,' '+name+' '),{sector:row.sector,detail:row.detail});}
  for(const [market,names] of Object.entries(S.UNMAPPED))for(const name of names){assert.equal(S.kisSector(market,name),null,market+' '+name);assert.ok(!(name in S.KIS_TABLE[market]));}
  for(const [code,name] of Object.entries(S.US_INDUSTRY_NAMES)){assert.match(code,/^\d{3}$/);assert.ok(name in S.KIS_TABLE.US||S.UNMAPPED.US.includes(name),code+' '+name);}
  assert.equal(S.usIndustryName('000'),null,'000 (all) is no industry');assert.equal(S.kisSector('KR','Unknown name'),null);
  // The two markets are separate vocabularies: a name is looked up in its own market's table only.
  assert.equal(S.kisSector('KR','가정 및 개인용품'),null);assert.equal(S.kisSector('US','음식료·담배'),null);
});

test("an ETF, ETN or fund never takes its sector from KIS's category, even a name the table knows",()=>{
  for(const type of ['etf','etn','fund']){
    assert.deepEqual(S.resolve({symbol:'990002',type,kisNames:['ETF(실물복제/수익증권)']}),{sector:'Unclassified',detail:null,source:'none',category:null});
    assert.equal(S.resolve({symbol:'990002',type,kisNames:['증권']}).source,'none',type);
    assert.equal(S.resolve({symbol:'990002',type,user:'Bonds'}).sector,'Bonds','your label still wins');}
  assert.equal(S.resolve({symbol:'990003',type:'reit',kisNames:['부동산']}).sector,'Real Estate','a REIT is a listed share, by its own category');
});

test('the portfolio rows carry the resolved sector, its detail and where it came from; without the resolver, as before',()=>{
  const {combinePortfolio}=require('../electron/portfolio-view.cjs');
  const korea={source:'kis',environment:'mock',cash:1000000,settledCash:1000000,reportedTotal:3000000,holdings:[{symbol:'990001',name:'Fixture A',quantity:10,price:100000,cost:900000},{symbol:'990004',name:'Fixture B',quantity:5,price:100000,cost:400000}]};
  const table={'990001':{kisNames:['제약']},'990004':{kisNames:['전기·전자']}};const meta={'990004':{sector:'My label',region:''}};
  const sectorOf=symbol=>{const input={symbol,...table[symbol]};const r=S.resolve({...input,user:meta[symbol]?.sector});return r.source==='user'?{...r,app:S.resolve(input)}:r;};
  const {rows}=combinePortfolio(korea,null,null,meta,{sectorOf});const by=Object.fromEntries(rows.map(r=>[r.symbol,r]));
  assert.equal(by['990001'].sector,'Health Care');assert.deepEqual(by['990001'].sectorInfo,{source:'kis',detail:'Pharmaceuticals',label:'',app:{sector:'Health Care',source:'kis',category:'제약',model:null,at:null}});
  assert.equal(by['990004'].sector,'My label');assert.deepEqual(by['990004'].sectorInfo.app,{sector:'Unclassified',source:'none',category:'전기·전자',model:null,at:null},'what applies without your label');
  const plain=combinePortfolio(korea,null,null,meta).rows;assert.deepEqual(plain.map(r=>r.sector),['Unclassified','My label']);assert.ok(plain.every(r=>!('sectorInfo' in r)));
  assert.equal(combinePortfolio(korea,null,null,{},{sectorOf:()=>{throw new Error('x');}}).rows[0].sector,'Unclassified','a resolver error is no sector');
});

test('the app\'s own assignments live in their own table; your labels are never written there',()=>{
  const db=new DatabaseSync(':memory:');const store=new S.SectorStore(db);assert.equal(store.get('990001'),null);
  db.prepare('INSERT INTO sector_assignments VALUES(?,?)').run('990001',JSON.stringify({sector:'Materials',detail:'Steel',model:'m',at:1}));
  assert.deepEqual(store.get('990001'),{sector:'Materials',detail:'Steel',model:'m',at:1});
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name='instrument_metadata'").all(),[],'the store never creates or writes the label table');
});

test('review change 1: 금융 spans sectors (holding companies, SPACs): unmapped; 증권 and 보험 stay Financials',()=>{
  assert.equal(S.kisSector('KR','금융'),null);assert.ok(S.UNMAPPED.KR.includes('금융'));
  assert.equal(S.resolve({symbol:'990001',kisNames:['금융']}).source,'none');assert.equal(S.kisSector('KR','증권').sector,'Financials');assert.equal(S.kisSector('KR','보험').sector,'Financials');
});

test('review change 2: one read per symbol within 30 seconds; a saved label or a master refresh shows at once',()=>{
  let now=1795600000000,reads=0,labels=0;const label={'990001':''};
  const r=new S.SectorResolver({clock:()=>now,label:s=>{labels++;return label[s];},read:()=>{reads++;return {type:'stock',kisNames:['제약'],stored:null};}});
  assert.equal(r.of('990001').sector,'Health Care');assert.deepEqual([reads,labels],[1,1]);
  now+=29000;r.of('990001');r.of('990001');assert.deepEqual([reads,labels],[1,1],'a second state within 30 s reads nothing');
  label['990001']='My label';r.clear('990001');assert.equal(r.of('990001').sector,'My label','a saved label shows at once');assert.equal(r.of('990001').app.sector,'Health Care');assert.deepEqual([reads,labels],[2,2]);
  now+=31000;r.of('990001');assert.equal(reads,3,'read again after 30 s');
  r.clear();r.of('990001');assert.equal(reads,4,'a master refresh clears every symbol');
});
