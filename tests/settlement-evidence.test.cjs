// Stage 2b.2: the settlement evidence ledger (electron/settlement-evidence.cjs) and its use by the U.S. settlement
// tracker (stage2b-spec.md; design tests T4 (v2), T7-T10, T13, T34-T36, atomicity, append-only, scope, A1 off).
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SettlementEvidence}=require('../electron/settlement-evidence.cjs');const {InFlight}=require('../electron/valuation.cjs');
const {TradingCosts,DEFAULT_COSTS}=require('../electron/trading-costs.cjs');
const MIN=60000,DAY=86400000,D='2026-11-05',SCOPE={account:'a',environment:'live',market:'US'},W={start:'2026-10-01',end:'2026-11-05'};
// A K row as trades() returns it, and an app order the K content key matches (U.S. trade date from the order time).
const k=(ticker='TEST',extra={})=>({tradeDate:D,settlementDate:'2026-11-06',ticker,side:'Buy',quantity:1,price:100,grossUSD:100,settlementUSD:100,settlementKRW:130000,feesUSD:0,exchangeRate:1300,...extra});
const order=(id,extra={})=>({id,symbol:'NASD:TEST',side:'Buy',filled:1,fillPrice:100,resultCosts:{netCash:-100},environment:'live',day:D,createdAt:Date.parse(D+'T15:00:00Z'),...extra});
function world(db=new DatabaseSync(':memory:')){let t=Date.parse(D+'T20:00:00Z');const clock=()=>t;const ledger=new SettlementEvidence(db,clock);let f=new InFlight(db,clock);
  return {db,ledger,see:(us,orders=[])=>{const r=f.observe('a',{us:{timestamp:new Date(t).toISOString(),environment:'live',...us},orders,fx:1300});t+=MIN;return r;},
    current:()=>f.current('a'),restart:()=>{f=new InFlight(db,clock);},later:ms=>{t+=ms;},now:()=>t,group:ticker=>ledger.kGroups('a').find(g=>g.key.ticker===(ticker??'TEST'))};}
const count=(db,table)=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

test('T4/T7: K rows link to an app order only when one order and one row share the content key',()=>{
  const w=world();w.ledger.importK(SCOPE,W,[k()]);
  assert.equal(w.ledger.links('a',[order('A')]).get('A').state,'linked','one row, one order');
  const two=w.ledger.links('a',[order('A'),order('B')]);assert.deepEqual([two.get('A').state,two.get('B').state],['uncertain','uncertain'],'one row, two orders: neither');
  // Reordered duplicate rows within one window: one group, count 2; neither of two matching orders is linked.
  const x=world();x.ledger.importK(SCOPE,W,[k(),k('OTHER'),k()]);const g=x.group();assert.equal(g.count,2);assert.equal(g.state,'uncertain');
  const l=x.ledger.links('a',[order('A'),order('B')]);assert.deepEqual([l.get('A').state,l.get('B').state],['uncertain','uncertain']);assert.match(l.get('A').reason,/several app orders|identical rows/);
  assert.equal(x.ledger.links('a',[order('A')]).get('A').reason,'2 identical rows in one window');
});
test('T8: overlapping windows returning the same row: one row, the count not doubled',()=>{
  const w=world();w.ledger.importK(SCOPE,{start:'2026-08-08',end:D},[k()]);w.ledger.importK(SCOPE,{start:'2026-10-22',end:D},[k()]);w.ledger.importK(SCOPE,W,[k()]);
  const g=w.group();assert.equal(g.count,1);assert.equal(g.versions.length,1);assert.equal(w.ledger.links('a',[order('A')]).get('A').state,'linked');
  // Two identical rows, returned again by an overlapping window: still two, not four.
  const x=world();x.ledger.importK(SCOPE,{start:'2026-08-08',end:D},[k(),k()]);x.ledger.importK(SCOPE,W,[k(),k()]);x.ledger.importK(SCOPE,{start:D,end:D},[k()]);assert.equal(x.group().count,2,'the largest count in one window, never a sum');
});
test('T9: a corrected row is a new version only when its key is unique on both sides; otherwise correction-ambiguous',()=>{
  const w=world();w.ledger.importK(SCOPE,W,[k()]);w.ledger.importK(SCOPE,W,[k('TEST',{settlementDate:'2026-11-07',price:100.5,grossUSD:100.5,settlementUSD:100.5})]);
  const g=w.group();assert.deepEqual(g.versions.map(v=>[v.version,v.fields.settlementDate,v.supersededBy??null]),[[1,'2026-11-06',2],[2,'2026-11-07',null]]);
  const l=w.ledger.links('a',[order('A')]).get('A');assert.deepEqual([l.state,l.version,l.fields.settlementUSD],['linked',2,100.5]);
  // Two rows where there was one: neither old nor new counts as independent evidence.
  const x=world();x.ledger.importK(SCOPE,W,[k()]);x.ledger.importK(SCOPE,W,[k('TEST',{price:101,grossUSD:101}),k('TEST',{price:99,grossUSD:99})]);
  assert.equal(x.group().state,'correction-ambiguous');const u=x.ledger.links('a',[order('A')]).get('A');assert.equal(u.state,'uncertain');assert.match(u.reason,/cannot be linked with certainty/);
});
test('T10: a repeated identical import changes nothing',()=>{
  const w=world();w.ledger.importK(SCOPE,W,[k(),k('OTHER')]);const before=[count(w.db,'settlement_events'),count(w.db,'settlement_evidence'),JSON.stringify(w.ledger.kGroups('a').map(g=>[g.id,g.count,g.state,g.versions.length]))];
  for(let i=0;i<3;i++)w.ledger.importK(SCOPE,W,[k('OTHER'),k()]);
  assert.deepEqual([count(w.db,'settlement_events'),count(w.db,'settlement_evidence'),JSON.stringify(w.ledger.kGroups('a').map(g=>[g.id,g.count,g.state,g.versions.length]))],before);
});
test('A1 stays off: a linked, final K row resolves nothing',()=>{
  const w=world();const A=order('A');w.see({cash:500});w.see({cash:500},[A]);w.ledger.importK(SCOPE,W,[k()]);assert.equal(w.ledger.links('a',[A]).get('A').state,'linked');
  for(let i=0;i<3;i++){w.later(DAY);assert.equal(w.see({cash:500},[A]).buysUSD,100,'still open: K is supporting evidence only');}
  assert.ok(!w.ledger.events('a').some(e=>e.kind==='allocation'),'no allocation from K');
});
test('T13: a reported rise allocated to a fill stays allocated for days; a linked K row $3 off reopens $3 only, once',()=>{
  const w=world();const A=order('A');w.see({cash:500});w.see({cash:500},[A]);
  assert.equal(w.see({cash:500,unsettled:{buyKRW:130000,sellKRW:0}},[A]).buysUSD,0,'A3: the reported rise covers A');
  for(let i=0;i<4;i++){w.later(DAY);assert.equal(w.see({cash:500,unsettled:{buyKRW:130000,sellKRW:0}},[A]).buysUSD,0,'an unchanged total is no conflict');}
  // A K row agreeing to the cent: no conflict.
  w.ledger.importK(SCOPE,W,[k()]);assert.equal(w.see({cash:500,unsettled:{buyKRW:130000,sellKRW:0}},[A]).buysUSD,0);
  // Corrected to $103: the $3 difference alone is unresolved again.
  w.ledger.importK(SCOPE,W,[k('TEST',{settlementUSD:103,grossUSD:103,price:103})]);const r=w.see({cash:500,unsettled:{buyKRW:130000,sellKRW:0}},[A]);
  assert.equal(r.buysUSD,3);assert.equal(r.open[0].unresolved.why,'conflict');assert.equal(r.open[0].unresolved.kUSD,103);assert.match(r.notes.join(' '),/\$3\.00 is unresolved again/);
  assert.equal(w.see({cash:500,unsettled:{buyKRW:130000,sellKRW:0}},[A]).buysUSD,3,'not reopened twice');assert.equal(w.ledger.events('a').filter(e=>e.kind==='conflict').length,1);
  // An order still on its gross amount (fees not reported) is not compared.
  const x=world();const G=order('G',{resultCosts:undefined});x.see({cash:500});x.see({cash:500},[G]);x.see({cash:500,unsettled:{buyKRW:130000,sellKRW:0}},[G]);x.ledger.importK(SCOPE,W,[k('TEST',{settlementUSD:100.8})]);
  assert.equal(x.see({cash:500,unsettled:{buyKRW:130000,sellKRW:0}},[G]).buysUSD,0);
});
test('T34: a cited row whose quantity or trade date changes puts its coverage under review; re-confirmation restores it',()=>{
  for(const [label,changed] of [['quantity',{quantity:2}],['trade date',{tradeDate:'2026-11-04'}]]){
    const w=world();w.ledger.importK(SCOPE,W,[k()]);const g=w.group();const c=w.ledger.cite({account:'a',groupId:g.id,version:1,orderId:'A',side:'Buy',cents:10000,rule:'manual'});
    assert.equal(w.current().buysUSD,0,label+': covered');
    w.ledger.importK(SCOPE,W,[k('TEST',changed)]);const cur=w.current();assert.equal(cur.buysUSD,100,label+': under review counts as unresolved');assert.equal(cur.unresolved.buysUSD,100);
    assert.equal(cur.open[0].unresolved.why,'under review');assert.match(cur.open[0].unresolved.reason,/missing from a later complete history window/);
    const fresh=w.ledger.kGroups('a').find(x=>x.id!==g.id);assert.equal(fresh.state,'possible correction');assert.deepEqual(fresh.possibleCorrectionOf,[g.id]);assert.equal(w.ledger.independent(fresh),false,label+': the new row is not independent evidence');
    w.ledger.confirm(c,{groupId:fresh.id,version:1});assert.equal(w.current().buysUSD,0,label+': re-confirmed');assert.equal(w.ledger.independent(w.ledger.kGroups('a').find(x=>x.id===fresh.id)),true);
  }
});
test('T35: a cited row missing from a later complete window is under review; seen again, it is not',()=>{
  const w=world();w.ledger.importK(SCOPE,W,[k(),k('OTHER')]);w.ledger.cite({account:'a',groupId:w.group().id,version:1,orderId:'A',side:'Buy',cents:10000,rule:'manual'});
  w.ledger.importK(SCOPE,{start:'2026-11-01',end:D},[k('OTHER')]);assert.equal(w.current().buysUSD,100);
  // A window that does not cover the date says nothing.
  w.ledger.importK(SCOPE,{start:'2026-11-06',end:'2026-11-07'},[]);assert.equal(w.current().buysUSD,100);
  w.ledger.importK(SCOPE,W,[k(),k('OTHER')]);assert.equal(w.current().buysUSD,0,'seen again');
  // A version corrected below the cited amount: the shortfall alone.
  w.ledger.importK(SCOPE,W,[k('TEST',{settlementUSD:97,grossUSD:97,price:97}),k('OTHER')]);const r=w.current();assert.equal(r.buysUSD,3);assert.match(r.open[0].unresolved.reason,/corrected to \$97\.00/);
});
test('T36: a reversing row makes its window incomplete: cited coverage on those dates is under review, with no second record; a side change likewise',()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE IF NOT EXISTS live_intents(id TEXT PRIMARY KEY,accountKey TEXT,payload TEXT)');const costs=new TradingCosts(db);costs.currentAccount=()=>({accountKey:'a',environment:'live'});
  const w=world(db);costs.importHistory('a',[{...W,complete:true,rows:[k()]}],1);const g=w.group();w.ledger.cite({account:'a',groupId:g.id,version:1,orderId:'A',side:'Buy',cents:10000,rule:'manual'});assert.equal(w.current().buysUSD,0);
  // trades() refuses a negative quantity (INVALID_RESPONSE): the range is a gap, and nothing is imported from it.
  costs.importHistory('a',[{...W,complete:false,reason:'INVALID_RESPONSE',rows:[]}],2);const r=w.current();assert.equal(r.buysUSD,100);assert.match(r.open[0].unresolved.reason,/trade-history gap/);
  assert.equal(w.ledger.kGroups('a').length,1,'no second record');
  costs.importHistory('a',[{...W,complete:true,rows:[k()]}],3);assert.equal(w.current().buysUSD,0,'a complete read restores it');
  // The side changes: the old key is missing, the new row only a possible correction.
  costs.importHistory('a',[{...W,complete:true,rows:[k('TEST',{side:'Sell'})]}],4);assert.equal(w.current().buysUSD,100);assert.equal(w.ledger.kGroups('a').find(x=>x.key.side==='Sell').state,'possible correction');
});
test('atomicity: one evidence remainder is never allocated twice; a refused allocation rolls back the whole reading',()=>{
  const w=world();const id=w.ledger.aggregate({account:'a',environment:'live',readingA:'1',readingB:'2',side:'Buy',field:'cash',amountCents:10000});
  w.ledger.allocate({account:'a',evidenceId:id,pieceId:'P#1',cents:6000,pieceCents:6000});
  assert.throws(()=>w.ledger.allocate({account:'a',evidenceId:id,pieceId:'Q#1',cents:6000,pieceCents:6000}),/ALLOCATION_EXCEEDS_EVIDENCE/);
  assert.throws(()=>w.ledger.allocate({account:'a',evidenceId:id,pieceId:'P#1',cents:1000,pieceCents:6000}),/ALLOCATION_EXCEEDS_PIECE/);assert.equal(w.ledger.allocated(id,1),6000);
  // Another connection holding the write lock: the allocation fails and writes nothing.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-'));const file=path.join(dir,'e.sqlite');const one=new DatabaseSync(file),two=new DatabaseSync(file,{timeout:0});
  const L1=new SettlementEvidence(one),L2=new SettlementEvidence(two);const e=L1.aggregate({account:'a',readingA:'1',readingB:'2',side:'Buy',field:'cash',amountCents:10000});
  one.exec('BEGIN IMMEDIATE');assert.throws(()=>L2.allocate({account:'a',evidenceId:e,pieceId:'P#1',cents:100}),/locked|busy/i);one.exec('ROLLBACK');assert.equal(L2.allocated(e,1),0);one.close();two.close();fs.rmSync(dir,{recursive:true,force:true});
  // A reading whose ledger write fails changes nothing: neither the tracker's state nor the ledger.
  const x=world();const A=order('A');x.see({cash:500});x.see({cash:500},[A]);const state=x.db.prepare('SELECT payload FROM inflight_settlement').get().payload,events=count(x.db,'settlement_events');
  const real=SettlementEvidence.prototype.allocate;SettlementEvidence.prototype.allocate=()=>{throw new Error('ALLOCATION_EXCEEDS_EVIDENCE');};
  try{assert.throws(()=>x.see({cash:400},[A]),/ALLOCATION_EXCEEDS_EVIDENCE/);}finally{SettlementEvidence.prototype.allocate=real;}
  assert.equal(x.db.prepare('SELECT payload FROM inflight_settlement').get().payload,state);assert.equal(count(x.db,'settlement_events'),events);assert.equal(count(x.db,'settlement_evidence'),0);
  assert.equal(x.see({cash:400},[A]).buysUSD,0,'the same reading again applies normally');assert.equal(count(x.db,'settlement_allocations'),1);
});
test('the tracker writes its evidence, allocations and piece events; events are append-only; a restart keeps piece ids',()=>{
  const w=world();const A=order('A'),B=order('B',{symbol:'NASD:OTHER',fillPrice:150,resultCosts:{netCash:-150}});w.see({cash:500});w.see({cash:500},[A,B]);w.see({cash:400},[A,B]);
  const kinds=w.ledger.events('a').map(e=>e.kind);assert.deepEqual(kinds.filter(x=>x!=='flag'),['piece-opened','piece-opened','evidence','allocation','piece-closed']);
  const al=w.db.prepare('SELECT pieceId,orderId,cents,rule FROM settlement_allocations').all().map(r=>({...r}));assert.deepEqual(al,[{pieceId:'A#1',orderId:'A',cents:10000,rule:'settled'}]);
  const ev=w.db.prepare('SELECT payload,amountCents FROM settlement_evidence').get();assert.equal(ev.amountCents,10000);assert.deepEqual(JSON.parse(ev.payload).identity.field,'cash');
  assert.throws(()=>w.db.exec("UPDATE settlement_events SET kind='x'"),/append-only/);assert.throws(()=>w.db.exec('DELETE FROM settlement_events'),/append-only/);
  w.restart();const r=w.see({cash:250},[A,B]);assert.equal(r.buysUSD,0);assert.deepEqual(w.db.prepare('SELECT pieceId FROM settlement_allocations ORDER BY rowid').all().map(x=>x.pieceId),['A#1','B#2']);
  // State saved before piece ids existed gets them at the next reading, and allocations work against them.
  const old=new DatabaseSync(':memory:');old.exec('CREATE TABLE inflight_settlement(account TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  old.prepare('INSERT INTO inflight_settlement VALUES(?,?)').run('a',JSON.stringify({basis:500,observed:{buys:0,sells:0},seen:{A:{filled:1,cents:10000,basis:'net'}},open:[{id:'A',side:'Buy',usd:100,basis:'net',at:1}],evidence:[],readAt:1,lastAt:1}));
  const y=world(old);assert.equal(y.see({cash:400},[A]).buysUSD,0);assert.equal(old.prepare('SELECT pieceId FROM settlement_allocations').get().pieceId,'A#1');
});
test('scope: evidence of another account or environment is never considered; standby evidence is kept, not consumed',()=>{
  const w=world();w.ledger.importK({account:'b',environment:'live',market:'US'},W,[k()]);w.ledger.importK({account:'a',environment:'mock',market:'US'},W,[k()]);
  assert.equal(w.ledger.links('a',[order('A')]).get('A').state,'none','neither another account\'s row nor this account\'s mock row is evidence for a live order');
  const e1=w.ledger.aggregate({account:'a',environment:'live',readingA:'1',readingB:'2',side:'Buy',field:'cash',amountCents:100}),e2=w.ledger.aggregate({account:'a',environment:'mock',readingA:'1',readingB:'2',side:'Buy',field:'cash',amountCents:100});assert.notEqual(e1,e2);
  const s=w.ledger.standby({account:'a',evidenceId:e1,version:1,pieceId:'P#1',cents:100});assert.equal(w.ledger.standby({account:'a',evidenceId:e1,version:1,pieceId:'P#1',cents:100}),s,'once');
  assert.equal(w.ledger.allocated(e1,1),0,'standby consumes nothing');assert.equal(w.ledger.standbyFor('P#1').length,1);
});
