// Item 9 (R3, R6, and the planner's F1-F3): the Home "Needs you" line for a cash change the flow detector holds. No
// broker, no AI.
const test=require('node:test'),assert=require('node:assert/strict');const {attentionItems}=require('../electron/cash-checks.cjs');
const at=s=>new Date(Date.parse(s)).toISOString(),NOW=Date.parse('2026-11-10T18:00:00+09:00');
test('one line per held change: up or down, "seen" in Seoul time, not a return or loss yet; [Record it] fills the form',()=>{
  const [kr]=attentionItems([{market:'KR',amount:3000000,since:at('2026-11-10T14:02:30+09:00')}],NOW);
  assert.equal(kr.title,'Korean cash up ₩3,000,000, seen 14:02 · checking; not a return yet');assert.equal(kr.action,'Record it');assert.equal(kr.tab,'Performance');
  assert.deepEqual(kr.draft,{key:'performance:flow',value:{day:'2026-11-10',market:'KR',direction:'deposit',amount:'3000000',note:''}});
  const [us]=attentionItems([{market:'US',amount:-1200,since:at('2026-11-10T09:41:00+09:00')}],NOW);
  assert.equal(us.title,'U.S. cash down $1,200.00, seen 09:41 · checking; not a loss yet');assert.deepEqual(us.draft.value,{day:'2026-11-10',market:'US',direction:'withdrawal',amount:'1200',note:''});
  // Seen after midnight UTC but on the Seoul day.
  assert.equal(attentionItems([{market:'KR',amount:20000,since:at('2026-11-11T00:30:00+09:00')}],Date.parse('2026-11-11T09:00:00+09:00'))[0].draft.value.day,'2026-11-11');
});
test('both markets pointing opposite ways: one line, "may be an exchange", no form to fill; same direction: two lines',()=>{
  const items=attentionItems([{market:'KR',amount:-1350000,since:at('2026-11-10T14:02:00+09:00')},{market:'US',amount:1000,since:at('2026-11-10T14:03:00+09:00')}],NOW);
  assert.equal(items.length,1);assert.equal(items[0].title,'Korean cash down ₩1,350,000 and U.S. cash up $1,000.00, seen 14:02 · checking; may be an exchange');assert.equal(items[0].draft,undefined);assert.equal(items[0].action,'Open Performance');
  assert.equal(attentionItems([{market:'KR',amount:100000,since:at('2026-11-10T14:02:00+09:00')},{market:'US',amount:100,since:at('2026-11-10T14:03:00+09:00')}],NOW).length,2);
});
test('R3: a rise kept on the long hold says why; the U.S. balance not compared is said; nothing held, no line',()=>{
  assert.equal(attentionItems([{market:'KR',amount:3000000,since:at('2026-11-10T14:02:00+09:00'),holdReason:'U.S. buys are settling'}],NOW)[0].title,'Korean cash up ₩3,000,000, seen 14:02 · checking; not a return yet · held 2 h: U.S. buys are settling');
  assert.match(attentionItems([{market:'KR',amount:-500000,since:at('2026-11-10T14:02:00+09:00'),usBalanceUnseen:true}],NOW)[0].title,/· U\.S\. balance not compared yet$/);
  assert.deepEqual(attentionItems([],NOW),[]);assert.deepEqual(attentionItems(null,NOW),[]);
});
test('F1: a change an open order may explain says so, with nothing to record; the detector exposes it',()=>{
  const [i]=attentionItems([{market:'KR',amount:-1810000,since:at('2026-11-10T10:04:00+09:00'),couldBeFill:true}],NOW);
  assert.equal(i.title,'Korean cash down ₩1,810,000, seen 10:04 · checking; an open order may explain it');assert.equal(i.action,'Open Performance');assert.equal(i.draft,undefined);
  const {DatabaseSync}=require('node:sqlite');const {FlowDetector}=require('../electron/flow-detector.cjs');const {PerformanceHistory}=require('../electron/performance.cjs');
  let now=Date.parse('2026-11-10T10:00:00+09:00');const db=new DatabaseSync(':memory:'),d=new FlowDetector(db,new PerformanceHistory(db,()=>now),()=>now);d.observe('A',{krCash:3000000});
  now+=240000;d.observe('A',{krCash:1238000,orders:[{market:'KR',side:'Buy',status:'Accepted',quantity:30,filled:0,price:58700,limitPrice:58700,createdAt:now-60000}]});
  assert.equal(d.pending('A')[0].couldBeFill,true);
});
test('F2: a U.S. form amount is rounded to cents (the money field takes two decimals at most)',()=>{
  assert.equal(attentionItems([{market:'US',amount:1200.1000000001,since:at('2026-11-10T09:41:00+09:00')}],NOW)[0].draft.value.amount,'1200.1');
  assert.equal(attentionItems([{market:'US',amount:-99.999,since:at('2026-11-10T09:41:00+09:00')}],NOW)[0].draft.value.amount,'100');
});
test('the review context rows keep exactly their keys from before item 9; main builds them through contextRows',()=>{
  const {contextRows}=require('../electron/cash-checks.cjs');
  const rows=contextRows([{market:'KR',currency:'KRW',amount:3000000,since:'2026-11-10T05:02:00.000Z',holdReason:'U.S. buys are settling',couldBeFill:true},{market:'US',currency:'USD',amount:-100,since:'2026-11-10T05:03:00.000Z',usBalanceUnseen:true}]);
  assert.deepEqual(rows.map(r=>Object.keys(r)),[['market','currency','amount','since'],['market','currency','amount','since','usBalanceUnseen']]);
  const main=require('node:fs').readFileSync(require('node:path').join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(main,/checking:require\('\.\/cash-checks\.cjs'\)\.contextRows\(flowDetector\.pending\(account\)\)/,'the review context goes through contextRows');
  assert.ok(!/checking:flowDetector\.pending\(/.test(main),'no raw pending rows in the context');
});
test('F3: a change first seen on an earlier Seoul day shows its date',()=>{
  assert.equal(attentionItems([{market:'KR',amount:3000000,since:at('2026-11-09T12:07:00+09:00')}],NOW)[0].title,'Korean cash up ₩3,000,000, seen 11-09 12:07 · checking; not a return yet');
  assert.match(attentionItems([{market:'KR',amount:3000000,since:at('2026-11-10T00:05:00+09:00')}],NOW)[0].title,/seen 00:05 ·/,'today: time only');
});
