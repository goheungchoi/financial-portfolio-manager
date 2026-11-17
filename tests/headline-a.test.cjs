// Item 9 section 4, the user's answer (A), 2026-11-17 (design-note §4a): held cash changes and detected flows not yet
// confirmed count as deposits or withdrawals in the headline; the provisional scenario (excluded) is the figure if they
// were income or no money moved. Changes an open order, a U.S. buy or a settlement may explain are named, not counted.
// The review context keeps its figures ('exclude', no held changes). No broker, no AI.
const test=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {PerformanceHistory}=require('../electron/performance.cjs');const {FlowDetector}=require('../electron/flow-detector.cjs');
const at=s=>Date.parse(s+'+09:00');
function setup(){let now=at('2026-11-07T15:00:00');const db=new DatabaseSync(':memory:'),h=new PerformanceHistory(db,()=>now),d=new FlowDetector(db,h,()=>now);h.held=a=>d.heldParts(a);
  const row=(KRW,USD=0,fx=1300)=>({totals:{KRW,USD,equityKRW:KRW+USD*fx},cash:{KRW,USD},rows:[],fx:{usdKRW:fx}});return {h,d,row,tick:s=>{now=at(s);}};}
const all=s=>s.periods.find(p=>p.label==='All');
test('a deposit about the size of the account, while held, reads about 0%, not +102%; the scenario says +102%',()=>{
  const {h,d,row,tick}=setup();h.record('a',row(4620000));d.observe('a',{krCash:4620000});
  tick('2026-11-08T14:02:00');d.observe('a',{krCash:9320000});h.record('a',row(9320000));
  const s=h.summary('a','KRW');assert.ok(Math.abs(all(s).twr)<0.001,`headline ${all(s).twr}`);assert.equal(all(s).gain,0);
  assert.deepEqual(s.provisional.unresolved,[{day:'2026-11-08',market:'KR',currency:'KRW',amount:4700000,held:true,counted:true}]);
  assert.ok(Math.abs(s.provisional.excluded.find(p=>p.label==='All').twr-4700000/4620000)<0.001,'if it was income: +102%');
  // The series' own default (the daily digest, account values, the phone snapshot read it directly) is the headline too.
  const day=h.series('a','KRW').at(-1);assert.equal(day.flow,4700000);assert.ok(Math.abs(day.dailyReturn)<0.001,'the digest\'s day return is not +102%');
  const {todayFigures}=require('../electron/performance.cjs');assert.ok(Math.abs(todayFigures(h,'a','2026-11-08')[0].dailyReturn)<0.001);
});
test('held, then detected, then confirmed give the same headline; removed (or taken as income) gives the scenario figure',()=>{
  const {h,d,row,tick}=setup();h.record('a',row(4620000));d.observe('a',{krCash:4620000});
  tick('2026-11-08T14:02:00');d.observe('a',{krCash:9320000});h.record('a',row(9320000));const held=all(h.summary('a','KRW'));
  tick('2026-11-08T16:03:00');const [flow]=d.observe('a',{krCash:9320000});assert.ok(flow?.detected,'recorded after 2 h');const detected=all(h.summary('a','KRW'));
  h.confirmFlow('a',flow.id);const confirmed=all(h.summary('a','KRW'));
  assert.deepEqual([detected.twr,detected.gain],[held.twr,held.gain]);assert.deepEqual([confirmed.twr,confirmed.gain],[held.twr,held.gain]);assert.equal(h.summary('a','KRW').provisional,undefined,'confirmed: not provisional');
  h.removeFlow('a',flow.id);assert.ok(Math.abs(all(h.summary('a','KRW')).twr-4700000/4620000)<0.001,'removed: the income figure');
});
test('a withdrawal held counts as a withdrawal; a change an open order may explain is named, not counted',()=>{
  const {h,d,row,tick}=setup();h.record('a',row(5000000));d.observe('a',{krCash:5000000});
  tick('2026-11-08T10:00:00');d.observe('a',{krCash:4000000});h.record('a',row(4000000));assert.ok(Math.abs(all(h.summary('a','KRW')).twr)<0.001,'the withdrawal is not a loss');
  const b=setup();b.h.record('a',b.row(5000000));b.d.observe('a',{krCash:5000000});b.tick('2026-11-08T10:04:00');
  b.d.observe('a',{krCash:3238000,orders:[{market:'KR',side:'Buy',status:'Accepted',quantity:30,filled:0,price:58700,limitPrice:58700,createdAt:at('2026-11-08T10:03:00')}]});b.h.record('a',b.row(3238000));
  const s=b.h.summary('a','KRW');assert.ok(all(s).twr<-0.3,'not counted: the fall shows as it is until the order is counted');
  assert.deepEqual(s.provisional.unresolved.map(u=>[u.counted,u.reason]),[[false,'an open order may explain it']]);
});
test('both markets (a possible exchange): each market\'s series counts its side; the combined series nets them',()=>{
  const {h,d,row,tick}=setup();h.record('a',row(3000000,1000));d.observe('a',{krCash:3000000,usCash:1000,fx:1300});
  tick('2026-11-08T10:00:00');d.observe('a',{krCash:1700000,usCash:2000,fx:1300});h.record('a',row(1700000,2000));
  const kr=h.series('a','KRW').at(-1),us=h.series('a','USD').at(-1),all=h.series('a','COMBINED').at(-1);
  assert.equal(kr.flow,-1300000);assert.equal(us.flow,1000);assert.ok(Math.abs(all.flow)<1,`combined ${all.flow}`);
});
test('a day with a held deposit and a trade: only the held amount counts; the trade\'s gain stays a gain',()=>{
  const {h,d,row,tick}=setup();h.record('a',row(5000000));d.observe('a',{krCash:5000000});
  tick('2026-11-08T10:00:00');d.observe('a',{krCash:7000000});h.record('a',row(7100000));
  assert.equal(all(h.summary('a','KRW')).gain,100000,'₩2,000,000 deposit held; ₩100,000 gain from the holdings');
});
test('a held part a recorded flow already carries (its pendingIds) counts once in the headline',()=>{
  const {h,d,row,tick}=setup();h.record('a',row(5000000));d.observe('a',{krCash:5000000});
  tick('2026-11-08T10:00:00');d.observe('a',{krCash:6000000});tick('2026-11-08T10:30:00');d.observe('a',{krCash:7000000});h.record('a',row(7000000));
  const parts=JSON.parse(h.db.prepare('SELECT payload FROM flow_watch').get().payload).pending.KR.parts;assert.equal(parts.length,2);
  // A ₩1,000,000 deposit you recorded that carries the first part's id (as M-1c leaves it).
  const mine=h.addFlow('a',{day:'2026-11-08',market:'KR',amount:1000000,note:'mine'});h.explainHeld('a',mine.id,{pendingIds:[parts[0].id],at:Date.now()});
  assert.deepEqual(d.heldParts('a').map(p=>p.amount),[1000000],'only the second part is held for the headline');
  assert.equal(h.series('a','KRW').at(-1).flow,2000000,'₩1,000,000 yours plus ₩1,000,000 held: the money counted once');
});
test('the review context keeps its figures: summary with exclude ignores held changes and detected flows, and main passes exclude',()=>{
  const {h,d,row,tick}=setup();h.record('a',row(4620000));d.observe('a',{krCash:4620000});tick('2026-11-08T14:02:00');d.observe('a',{krCash:9320000});h.record('a',row(9320000));
  h.addFlow('a',{day:'2026-11-08',market:'KR',amount:20000,detected:true,note:'Detected'});
  const withHeld=h.summary('a','KRW',null,{unresolved:'exclude'});const held=h.held;h.held=null;const without=h.summary('a','KRW',null,{unresolved:'exclude'});h.held=held;
  assert.deepEqual(withHeld.periods,without.periods,'held changes do not reach the exclude figures');assert.ok(Math.abs(all(without).twr-4700000/4620000)<0.001,'exclude: as before item 9');
  const main=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(main,/const s=performance\.summary\(account,kind,benchmarkFor\(kind\),\{unresolved:'exclude'\}\);if\(!s\.start\)return null;/,'automation.performanceSummary (the review context) reads exclude');
});
