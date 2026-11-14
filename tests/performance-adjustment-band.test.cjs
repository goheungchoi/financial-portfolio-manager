// C1a (settlement clean-up, artifacts/reviews/2026-11-14-settlement-cleanup/c1/design.md): a valuation correction may
// give a day's right band, a combined band, and name settlement pieces it supersedes; the days before an account holds
// money are not a trough. Nothing here writes a recorded day or a settlement event.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PerformanceHistory,analyze,reviewSummary}=require('../electron/performance.cjs');const {ValuationCorrections,validate}=require('../electron/valuation-corrections.cjs');
const {InFlight}=require('../electron/valuation.cjs');const {performanceCorrections}=require('../electron/performance-corrections.cjs');
const A='acct';const K=(day,h=9)=>Date.parse(`${day}T${String(h).padStart(2,'0')}:00:00+09:00`);
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-6,`${m??''}: ${a} vs ${b}`);
// A record shaped as the app writes it: per-market value, band and cash; combined value and band.
const row=(day,{krw,usd,fx=1340,band={},at=K(day,23)})=>({day,at,KRW:{equity:krw,cash:krw,open:band.kOpen??krw,high:band.kHigh??krw,low:band.kLow??krw,positions:[]},USD:{equity:usd,cash:usd,open:band.uOpen??usd,high:band.uHigh??usd,low:band.uLow??usd,positions:[]},fx,equityKRW:krw+usd*fx,equityKRWHigh:band.cHigh??krw+usd*fx,equityKRWLow:band.cLow??krw+usd*fx});
function world(rows){const db=new DatabaseSync(':memory:');let now=K('2026-11-07');const clock=()=>now;
  const perf=new PerformanceHistory(db,clock),corr=new ValuationCorrections(db,clock);perf.adjustments=a=>corr.inForce(a);
  for(const r of rows)db.prepare('INSERT INTO nav_history VALUES(?,?,?)').run(A,r.day,JSON.stringify(r));
  return {db,perf,corr,clock,set:t=>{now=t;}};}
const reason={reason:'test',evidence:'test fixture'};

test('validate: band-only and combined-band adjustments; refusals',()=>{
  assert.deepEqual(validate([{day:'2026-11-04',market:'US',amount:0,band:{open:521.63,low:515.42},...reason}])[0].band,{open:521.63,low:515.42});
  assert.equal(validate([{day:'2026-11-05',market:'COMBINED',amount:0,band:{high:4402816.35},...reason}])[0].currency,'COMBINED');
  assert.equal(validate([{day:'2026-11-04',market:'US',amount:0,...reason}])[0].amount,0,'amount 0 with no band withdraws a day (F1)');
  const bad=[{day:'2026-11-04',market:'COMBINED',amount:5,band:{high:1},...reason},{day:'2026-11-04',market:'XX',amount:1,...reason},
    {day:'2026-11-04',market:'US',amount:1,band:{high:'1'},...reason},{day:'2026-11-04',market:'US',amount:1,band:{mid:1},...reason},{day:'2026-11-04',market:'US',amount:1,band:{low:5,high:4},...reason},{day:'2026-11-04',market:'US',amount:1,band:{},...reason}];
  for(const b of bad)assert.throws(()=>validate([b]),/INVALID_CORRECTION/,JSON.stringify(b));
  assert.throws(()=>validate([{day:'2026-11-04',market:'US',amount:1,...reason},{day:'2026-11-04',market:'US',amount:2,...reason}]),/INVALID_CORRECTION/,'one adjustment per day and market in a version');
});

test('a band adjustment replaces its market\'s high and low; the combined band takes the COMBINED one; analyze follows',()=>{
  const w=world([row('2026-11-03',{krw:3000000,usd:500}),row('2026-11-04',{krw:3000000,usd:520,band:{uLow:-176.4,uHigh:525,cLow:2751400}}),row('2026-11-05',{krw:3010000,usd:521,band:{kHigh:3142500,cHigh:3850000}})]);
  w.corr.apply(A,[{day:'2026-11-04',market:'US',amount:0,band:{low:515.42},...reason},{day:'2026-11-04',market:'COMBINED',amount:0,band:{low:3691250},...reason},{day:'2026-11-05',market:'COMBINED',amount:0,band:{high:3712000},...reason}],{by:'test'});
  const usd=w.perf.series(A,'USD'),krw=w.perf.series(A,'KRW'),comb=w.perf.series(A,'COMBINED');
  close(usd[1].low,515.42,'U.S. low');close(usd[1].high,525,'U.S. high kept');assert.equal(usd[1].bandCorrected,1);assert.equal(usd[1].value,520,'value unchanged');
  close(krw[2].high,3142500,'a COMBINED band never touches the Korean series');assert.equal(krw[2].bandCorrected,undefined);
  close(comb[1].low,3691250);close(comb[2].high,3712000);
  const a=analyze(usd,'2026-11-03');close(a.intradayLow.value,500,'the corrected low is no longer the lowest');const c=analyze(comb,'2026-11-03');close(c.intradayHigh.value,3712000);
});

test('with no adjustment every point is as before: no marker, the recorded band',()=>{
  const rows=[row('2026-11-03',{krw:3000000,usd:500,band:{uLow:-10,kHigh:3100000}}),row('2026-11-04',{krw:3000000,usd:520})];const w=world(rows);
  for(const [kind,m] of [['USD','USD'],['KRW','KRW']]){const s=w.perf.series(A,kind);for(const [i,p] of s.entries()){assert.equal(p.bandCorrected,undefined);assert.equal(p.high,rows[i][m].high);assert.equal(p.low,rows[i][m].low);}}
});

test('an adjusted value stays inside its band; a band that leaves out the value is refused when applied',()=>{
  const w=world([row('2026-10-23',{krw:676390,usd:641.52,band:{uLow:549.2,uHigh:643.80}})]);
  assert.throws(()=>w.corr.apply(A,[{day:'2026-10-23',market:'US',amount:-94.38,band:{low:560},...reason}],{by:'test'}),/BAND_OUTSIDE_VALUE/);
  assert.throws(()=>w.corr.apply(A,[{day:'2026-10-22',market:'US',amount:0,band:{low:1},...reason}],{by:'test'}),/BAND_WITHOUT_RECORD/);
  w.corr.apply(A,[{day:'2026-10-23',market:'US',amount:-94.38,...reason}],{by:'test'});const p=w.perf.series(A,'USD')[0];
  close(p.value,547.14);close(p.low,547.14,'the value is the day\'s last reading, so the low is at most it');close(p.high,643.80,'a band the readings do not determine is left as recorded');
});

// The C0 shape: five fills opened before tracking on day 1 lower the U.S. low bound by their amount until they
// close by age on day 3. Today those are accounting corrections; a version that corrects the values of days 1
// and 2 supersedes them.
function liveShape(){const rows=[row('2026-10-28',{krw:711720,usd:553.71,fx:1338.6,at:K('2026-10-28',23)}),row('2026-11-02',{krw:3694220,usd:-158.37,fx:1352.4,at:K('2026-11-02',10)}),
    row('2026-11-03',{krw:3701620,usd:-170.58,fx:1350.1,at:K('2026-11-03',23)}),row('2026-11-04',{krw:3711600,usd:518.36,fx:1339.8,at:K('2026-11-04',23)}),row('2026-11-05',{krw:3706255,usd:517.24,fx:1333.5,at:K('2026-11-05',23)})];
  // Each tracked day keeps the tracker's snapshot, as the app records it: the four buys open on 11-02 and 11-03.
  const open=['o1#1','o3#3','o4#4','o5#5'],snap=(on)=>({last:{at:0,started:K('2026-11-02',8),pieces:on?open.map(pid=>({pid,side:'Buy',usd:1,why:'awaiting verification'})):[],totals:{},open:{buysUSD:on?694.50:0,buys:on?4:0,pids:on?open:[]}},seen:on?open.map(pid=>({pid,side:'Buy',usd:1})):[],openBuysMaxUSD:on?694.50:0,openPids:on?open:[]});
  for(const r of rows)if(r.day>='2026-11-02')r.settlement=snap(r.day<'2026-11-04');
  const w=world(rows);const f=new InFlight(w.db,w.clock);f.save(A,{basis:174.09,seen:{},open:[],evidence:[],startedAt:K('2026-11-02',8),readAt:K('2026-11-02',8)});
  const pieces=[['o1#1','Buy',94.38],['o2#2','Sell',268.47],['o3#3','Buy',62.94],['o4#4','Buy',205.11],['o5#5','Buy',332.07]];
  w.set(K('2026-11-02',8));for(const [pid,side,usd] of pieces)f.evidence.event(A,'piece-opened',{pieceId:pid,orderId:pid.split('#')[0],side,usd,basis:'net',why:'awaiting verification',pretracking:true});
  w.set(K('2026-11-04',7));for(const [pid,side,usd] of pieces)f.evidence.event(A,'piece-closed',{pieceId:pid,orderId:pid.split('#')[0],side,why:'age',usd,days:3,tradeDay:'2026-10-23'});
  const sc=performanceCorrections(w.db,{inFlight:f});sc.superseded=a=>w.corr.superseded(a);w.perf.corrections=(a,r)=>sc.byDay(a,r);
  return {...w,f,sc,pieces:pieces.map(p=>p[0])};}
const W2=[{day:'2026-11-02',market:'US',amount:694.50,...reason},{day:'2026-11-03',market:'US',amount:694.50,...reason},{day:'2026-11-04',market:'US',amount:0,band:{open:521.63,low:515.42},...reason}];

test('without a supersede the settlement corrections are as today; a value correction alone counts the fix twice',()=>{
  const w=liveShape();const before=w.perf.series(A,'USD');
  close(before[1].correction,-694.50);close(before[3].correction,694.50);close(before[1].dailyReturn,(-158.37+694.50-553.71)/553.71,'today the correction keeps the 11-02 return right');
  w.corr.apply(A,W2,{by:'test'});const twice=w.perf.series(A,'USD');assert.ok(twice[1].dailyReturn>1,'+122%: the value and the correction both remove the -694.50');
});

test('a supersede removes the pieces\' corrections, open base and estimate tag; the returns stay right; no event is written',()=>{
  const w=liveShape();const events=JSON.stringify(w.db.prepare('SELECT * FROM settlement_events').all()),nav=JSON.stringify(w.db.prepare('SELECT * FROM nav_history').all());
  const without=w.sc.byDay(A,w.perf.history(A));assert.ok(without.get('2026-11-02')?.items?.length);assert.ok(without.get('2026-11-03')?.openUSD,'an open base on 11-03 today');
  w.corr.apply(A,W2,{by:'test'},{supersedes:{pieceIds:w.pieces,reason:'the values of 11-02 and 11-03 are corrected instead'}});
  const map=w.sc.byDay(A,w.perf.history(A));for(const d of ['2026-11-02','2026-11-03','2026-11-04']){const x=map.get(d);assert.ok(!x||(!x.items.length&&!x.openUSD&&!x.pending),`${d}: ${JSON.stringify(x)}`);}
  const s=w.perf.series(A,'USD');close(s[1].value,536.13);close(s[2].value,523.92);
  close(s[1].dailyReturn,(536.13-553.71)/553.71);close(s[2].dailyReturn,(523.92-536.13)/536.13);close(s[3].dailyReturn,(518.36-523.92)/523.92);
  for(const p of s)assert.equal(p.correction,undefined,p.day);close(s[3].low,515.42);
  const c=w.perf.series(A,'COMBINED');close(c[1].value,3694220+(-158.37+694.50)*1352.4);for(const p of c)assert.equal(p.correction,undefined,p.day);
  assert.equal(JSON.stringify(w.db.prepare('SELECT * FROM settlement_events').all()),events,'settlement events unchanged');assert.equal(JSON.stringify(w.db.prepare('SELECT * FROM nav_history').all()),nav,'records unchanged');
});

test('a supersede is refused for an open piece, an unknown piece, or a day the version does not correct',()=>{
  const w=liveShape();const sup=pieceIds=>({supersedes:{pieceIds,reason:'r'}});
  assert.throws(()=>w.corr.apply(A,W2,{by:'test'},sup(['nope#9'])),/SUPERSEDE_UNCOVERED/);
  assert.throws(()=>w.corr.apply(A,W2.slice(0,1),{by:'test'},sup(w.pieces)),/SUPERSEDE_UNCOVERED/,'11-03 and 11-04 not covered');
  w.set(K('2026-11-05',8));w.f.evidence.event(A,'piece-opened',{pieceId:'o6#6',orderId:'o6',side:'Buy',usd:10,basis:'net',why:null});
  assert.throws(()=>w.corr.apply(A,[...W2,{day:'2026-11-05',market:'US',amount:10,...reason}],{by:'test'},sup([...w.pieces,'o6#6'])),/SUPERSEDE_UNCOVERED/,'an open piece');
  assert.throws(()=>w.corr.apply(A,W2,{by:'test'},{supersedes:{pieceIds:'x',reason:'r'}}),/INVALID_CORRECTION/);
  assert.equal(w.corr.versions(A).length,0,'nothing written by a refused version');
});

test('the flow detector\'s interval reads every piece: excludePieces is passed only by the performance corrections',()=>{
  const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','flow-detector.cjs'),'utf8')+require('node:fs').readFileSync(require('node:path').join(__dirname,'..','electron','main.cjs'),'utf8');
  assert.ok(!/excludePieces/.test(src.replace(/settlementCorrections\.superseded[^\n]*/,'')),'only performance-corrections passes excludePieces');
  const w=liveShape();w.corr.apply(A,W2,{by:'test'},{supersedes:{pieceIds:w.pieces,reason:'r'}});close(w.f.explained(A,{since:0,sides:['Buy']}).usd,0,'opened and closed: the detector\'s view is unchanged by a supersede');
  close(w.f.explained(A,{since:0,until:K('2026-11-03',23),sides:['Buy']}).usd,-694.50);
});

test('the days before an account holds money are not its trough; a later 0 still counts; returns keep the first funded day',()=>{
  const w=world([row('2026-10-12',{krw:505000,usd:0}),row('2026-10-16',{krw:505000,usd:0}),row('2026-10-17',{krw:771530,usd:524.86}),row('2026-10-21',{krw:702680,usd:597.13}),row('2026-10-27',{krw:683270,usd:546.81})]);
  w.perf.addFlow?.(A,{day:'2026-10-17',market:'US',amount:533.84,note:'transfer',transfer:true});
  const s=w.perf.series(A,'USD'),a=analyze(s,'2026-10-12');assert.equal(a.trough.day,'2026-10-17');close(a.trough.value,524.86);assert.equal(a.intradayLow.day,'2026-10-17');
  assert.equal(a.from,'2026-10-12','the window still starts where it did');
  const later=analyze([{day:'d1',value:10,high:10,low:10,index:1},{day:'d2',value:0,high:0,low:0,index:1,dailyReturn:null}],'d1');assert.equal(later.trough.value,0,'a fall to 0 is a trough');
  const r=reviewSummary(w.perf.summary(A,'USD',null)).risk;assert.ok(!r.trough||r.trough.value>0,JSON.stringify(r.trough));
});

test('D4: a band set to its known limit is marked partly estimated, in the series and the intraday figures',()=>{
  assert.equal(validate([{day:'2026-10-20',market:'US',amount:0,band:{low:526.3,estimated:true},...reason}])[0].band.estimated,true);
  assert.throws(()=>validate([{day:'2026-10-20',market:'US',amount:0,band:{estimated:true},...reason}]),/INVALID_CORRECTION/,'a flag alone is no band');
  assert.throws(()=>validate([{day:'2026-10-20',market:'US',amount:0,band:{low:1,estimated:'yes'},...reason}]),/INVALID_CORRECTION/);
  const w=world([row('2026-10-17',{krw:771530,usd:524.86}),row('2026-10-20',{krw:779410,usd:530.42,band:{uLow:-4.9,uHigh:531.90}}),row('2026-10-21',{krw:702680,usd:597.13})]);
  w.corr.apply(A,[{day:'2026-10-20',market:'US',amount:0,band:{low:526.3,estimated:true},...reason}],{by:'test'});
  const s=w.perf.series(A,'USD');assert.equal(s[1].bandEstimated,true);close(s[1].low,526.3);assert.equal(s[0].bandEstimated,undefined);
  const a=analyze(s,'2026-10-17');assert.equal(a.intradayLow.day,'2026-10-17');assert.equal(a.intradayLow.estimated,undefined);
  const b=analyze(s.map(p=>p.day==='2026-10-17'?{...p,low:540}:p),'2026-10-17');assert.equal(b.intradayLow.day,'2026-10-20');assert.equal(b.intradayLow.estimated,true);
});

// C1a review, F1: a supersede never outlives the adjustments it rests on. An amount of 0 with no band withdraws a day's
// adjustment.
const withdraw=days=>days.map(day=>({day,market:'US',amount:0,...reason}));
test('F1: a version that withdraws a covered day while the supersede stays is refused; nothing is written',()=>{
  const w=liveShape();w.corr.apply(A,W2,{by:'test'},{supersedes:{pieceIds:w.pieces,reason:'r'}});
  assert.throws(()=>w.corr.apply(A,withdraw(['2026-11-03']),{by:'test'}),/SUPERSEDE_UNCOVERED/);
  assert.throws(()=>w.corr.apply(A,withdraw(['2026-11-02']),{by:'test'},{supersedes:{pieceIds:w.pieces,reason:'again'}}),/SUPERSEDE_UNCOVERED/);
  assert.equal(w.corr.versions(A).length,1,'nothing written');assert.equal(w.corr.superseded(A).size,5);
});
test('F1: withdrawing the days and ending the supersede in one version gives the series as today',()=>{
  const w=liveShape();const pick=()=>JSON.stringify(w.perf.series(A,'USD').map(p=>[p.day,p.value,p.dailyReturn,p.correction??0,p.high,p.low]));const today=pick();
  w.corr.apply(A,W2,{by:'test'},{supersedes:{pieceIds:w.pieces,reason:'r'}});assert.notEqual(pick(),today);
  const v=w.corr.apply(A,withdraw(['2026-11-02','2026-11-03','2026-11-04']),{by:'test'},{supersedes:{pieceIds:[],reason:'ended'}});
  assert.deepEqual(v.supersedes.pieceIds,[]);assert.equal(w.corr.superseded(A).size,0);assert.equal(w.corr.inForce(A).length,0);
  assert.equal(pick(),today,'values, returns, corrections and bands as today');
});
test('F1: an empty list on its own ends the supersede; the corrections come back',()=>{
  const w=liveShape();w.corr.apply(A,W2,{by:'test'},{supersedes:{pieceIds:w.pieces,reason:'r'}});
  w.corr.apply(A,[{day:'2026-11-05',market:'KR',amount:1,...reason}],{by:'test'},{supersedes:{pieceIds:[],reason:'ended'}});
  assert.equal(w.corr.superseded(A).size,0);close(w.perf.series(A,'USD')[1].correction,-694.50);
});
