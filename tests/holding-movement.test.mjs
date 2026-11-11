// The Holdings Movement cards (src/holding-movement.mjs): the price line from daily closes, the P/L line from the
// recorded daily positions (current run only), the purchase day from the opening fill, and reasons for every gap.
import test from 'node:test';import assert from 'node:assert/strict';
import {holdingMovement,movementCards,recordedDays,seoulDay,newYorkDay,PERIODS} from '../src/holding-movement.mjs';

const TODAY='2026-11-04';
const at=(day,h=3)=>Date.parse(day+'T00:00:00Z')+h*3600000;// 03:00 UTC = 12:00 KST, inside that Seoul day
const closesFrom=(from,to,start=100,step=1)=>{const out=[];let d=from,v=start;while(d<=to){const w=new Date(d+'T00:00:00Z').getUTCDay();if(w!==0&&w!==6){out.push({date:d,close:v});v+=step;}d=new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);}return out;};
const pos=(symbol,quantity,value,cost)=>({symbol,name:symbol,quantity,value,cost});
const krRow=(symbol,quantity,price,cost)=>({symbol,name:symbol,market:'KR',currency:'KRW',quantity,price,cost,valueKRW:quantity*price});
const usRow=(symbol,quantity,price,cost,fx=1400)=>({symbol,name:symbol,market:'US',currency:'USD',quantity,price,cost,valueKRW:fx?quantity*price*fx:null});

test('a buy inside the period: the price line covers the period with the purchase marked; the P/L line starts at the purchase',()=>{
  const days=[{day:'2026-10-26',positions:[]},{day:'2026-10-27',positions:[pos('990030',1,96700,92400)]},{day:'2026-10-28',positions:[pos('990030',1,97100,92400)]},{day:'2026-11-04',positions:[pos('990030',1,95000,92400)]}];
  const m=holdingMovement({row:krRow('990030',1,95000,92400),closes:closesFrom('2026-09-24',TODAY,90000,100),days,fills:[{side:'Buy',filled:1,at:at('2026-10-27')}],period:'1M',today:TODAY});
  assert.deepEqual(m.purchase,{day:'2026-10-27',marketDay:'2026-10-27',source:'fill'});assert.equal(m.from,'2026-10-05');assert.equal(m.price.purchaseMarked,true);
  assert.equal(m.price.points[0].day,'2026-10-05');assert.deepEqual(m.price.points.at(-1),{day:TODAY,close:95000,live:true},'today is the holdings table\'s price');
  assert.deepEqual(m.pl.points.filter(p=>!p.gap).map(p=>[p.day,p.pnl]),[['2026-10-27',4300],['2026-10-28',4700],['2026-11-04',2600]]);assert.equal(m.pl.startsAt,'2026-10-27');assert.equal(m.pl.startsLate,false);
  assert.equal(m.pl.reason,null);assert.ok(Math.abs(m.pl.endPct-(2600/92400))<1e-12);
  assert.equal(PERIODS.join(','),'1W,1M,3M,Since purchase');
});
test('a symbol that was sold and bought again: only the current run, from the new purchase',()=>{
  const days=[{day:'2026-10-19',positions:[pos('990030',1,105700,106000)]},{day:'2026-10-25',positions:[pos('990030',1,94800,106000)]},{day:'2026-10-26',positions:[]},
    {day:'2026-10-27',positions:[pos('990030',1,96700,92400)]},{day:'2026-11-04',positions:[pos('990030',1,95000,92400)]}];
  const fills=[{side:'Buy',filled:1,at:at('2026-10-19')},{side:'Sell',filled:1,at:at('2026-10-26')},{side:'Buy',filled:1,at:at('2026-10-27')}];
  const m=holdingMovement({row:krRow('990030',1,95000,92400),closes:closesFrom('2026-07-25',TODAY),days,fills,period:'3M',today:TODAY});
  assert.equal(m.purchase.day,'2026-10-27','the Buy that opened the position held now');assert.deepEqual(m.pl.points.filter(p=>!p.gap).map(p=>p.day),['2026-10-27','2026-11-04']);
  const since=holdingMovement({row:krRow('990030',1,95000,92400),closes:closesFrom('2026-07-25',TODAY),days,fills,period:'Since purchase',today:TODAY});assert.equal(since.from,'2026-10-27');assert.equal(since.price.points[0].day,'2026-10-27');
});
test('an addition: the cost steps up and the average cost follows it; a partial sale lowers the shares',()=>{
  const days=[{day:'2026-10-27',positions:[pos('990020',3,175200,176100)]},{day:'2026-10-28',positions:[pos('990020',5,300000,301000)]},{day:'2026-10-29',positions:[pos('990020',2,121000,120400)]}];
  const fills=[{side:'Buy',filled:3,at:at('2026-10-16')},{side:'Buy',filled:2,at:at('2026-10-28')},{side:'Sell',filled:3,at:at('2026-10-29')}];
  const m=holdingMovement({row:krRow('990020',2,60500,60200),closes:closesFrom('2026-09-24','2026-10-29'),days,fills,period:'1M',today:'2026-10-29'});
  assert.deepEqual(m.pl.points.map(p=>[p.quantity,p.averageCost,p.pnl]),[[3,58700,-900],[5,60200,-1000],[2,60200,600]]);
  assert.equal(m.purchase.day,'2026-10-16','the first Buy opened the position: the addition and the sale did not close it');
  assert.equal(m.pl.startsLate,true,'records start after the purchase inside the period');assert.equal(m.pl.startsAt,'2026-10-27');
});
test('a day with no record is a gap, not an end; a day with no close is a gap in the price line',()=>{
  const days=[{day:'2026-10-28',positions:[pos('NYSE:FBRK',1,100.655,94.14)]},{day:'2026-11-02',positions:[pos('NYSE:FBRK',1,95.1,94.14)]}];// 10-29, 10-30 not recorded
  const closes=closesFrom('2026-10-25',TODAY,95,1).filter(c=>c.date!=='2026-10-30');
  const m=holdingMovement({row:usRow('NYSE:FBRK',1,100.53,94.14),closes,days,fills:[{side:'Buy',filled:1,at:at('2026-10-23')}],period:'1W',today:TODAY});
  assert.deepEqual(m.pl.points.filter(p=>!p.gap).map(p=>p.day),['2026-10-28','2026-11-02']);
  assert.deepEqual(m.pl.points.filter(p=>p.gap).map(p=>[p.day,p.pnl]),[['2026-10-29',null],['2026-10-30',null],['2026-10-31',null],['2026-11-01',null]],'each missing calendar day is a gap point, so the line breaks');assert.ok(!m.price.points.some(p=>p.day==='2026-10-30'));
  assert.equal(m.purchase.day,'2026-10-23');assert.equal(m.pl.startsLate,false,'the purchase is before this period');
});
test('a U.S. holding: P/L in dollars, and in KRW only on days with a recorded rate',()=>{
  const days=[{day:'2026-10-23',fx:null,positions:[pos('NYSE:FBRK',1,95.72,94.14)]},{day:'2026-10-24',fx:1335.3,positions:[pos('NYSE:FBRK',1,91.73,94.14)]}];
  const m=holdingMovement({row:usRow('NYSE:FBRK',1,91.73,94.14),closes:closesFrom('2026-10-13','2026-10-24'),days,fills:[{side:'Buy',filled:1,at:at('2026-10-23')}],period:'Since purchase',today:'2026-10-24'});
  assert.equal(m.currency,'USD');assert.equal(m.pl.points[0].pnlKRW,null,'no rate that day');assert.ok(Math.abs(m.pl.points[1].pnlKRW-(91.73-94.14)*1335.3)<1e-9);
  assert.ok(Math.abs(m.pl.points[0].pnl-(95.72-94.14))<1e-12);
});
test('a holding older than the records, with no fill: "first recorded"; the P/L line starts at the first record',()=>{
  const days=[{day:'2026-10-12',positions:[pos('005930',2,120000,100000)]},{day:'2026-10-13',positions:[pos('005930',2,122000,100000)]}];
  const m=holdingMovement({row:krRow('005930',2,61000,50000),closes:closesFrom('2026-08-25','2026-10-13'),days,fills:[],period:'Since purchase',today:'2026-10-13'});
  assert.deepEqual(m.purchase,{day:'2026-10-12',marketDay:'2026-10-12',source:'first recorded'});assert.equal(m.price.purchaseMarked,false,'a first recorded day is not marked as a purchase');assert.equal(m.from,'2026-10-12');assert.equal(m.pl.startsLate,false);
  const fillsMismatch=holdingMovement({row:krRow('005930',2,61000,50000),closes:null,days,fills:[{side:'Buy',filled:1,at:at('2026-10-03')}],period:'3M',today:'2026-10-13'});
  assert.equal(fillsMismatch.purchase.source,'first recorded','fills that do not add up to the shares held are not used');
});
test('unknowns: no closes loaded, a failed read, too few closes, not in the records, no recorded cost',()=>{
  const row=krRow('396500',5,28130,27550);
  const a=holdingMovement({row,closes:null,days:[],period:'1M',today:TODAY});assert.equal(a.price.reason,'Daily prices are not loaded yet.');assert.equal(a.pl.reason,'P/L history unavailable: this holding is not in the daily records yet.');assert.deepEqual(a.purchase,{day:null,marketDay:null,source:null});
  assert.equal(holdingMovement({row,closes:null,closesReason:'Prices could not be read (RATE_LIMITED).',days:[],period:'1M',today:TODAY}).price.reason,'Prices could not be read (RATE_LIMITED).');
  const b=holdingMovement({row:{...row,price:null},closes:[{date:TODAY,close:28130}],days:[],period:'1M',today:TODAY});assert.equal(b.price.reason,'Not enough daily prices for this period.');assert.equal(b.price.changePct,null);
  const c=holdingMovement({row,closes:closesFrom('2026-09-24',TODAY),days:[{day:TODAY,positions:[pos('396500',5,140650,null)]}],period:'1M',today:TODAY});assert.equal(c.pl.reason,'P/L history unavailable: the average cost was not recorded.');assert.equal(c.pl.end,null);
});
test('movementCards: open holdings only, largest first; an empty portfolio gives no cards; recordedDays splits the markets',()=>{
  assert.deepEqual(movementCards({rows:[],days:{KR:[],US:[]},period:'1M',today:TODAY}),[]);
  const rows=[krRow('990030',1,95000,92400),krRow('990020',3,66600,58700),usRow('NYSE:FBRK',1,100.53,94.14),krRow('005930',0,60000,50000)];
  assert.deepEqual(movementCards({rows,days:{KR:[],US:[]},period:'1M',today:TODAY}).map(c=>c.symbol),['990020','NYSE:FBRK','990030']);
  const split=recordedDays([{day:'2026-11-04',fx:1343.3,KRW:{positions:[pos('990030',1,95000,92400)]},USD:{positions:[pos('NYSE:FBRK',1,100.53,94.14)]}},{day:'2026-11-03',fx:1355.7,KRW:{positions:[]},USD:null}]);
  assert.deepEqual(split.KR.map(d=>d.day),['2026-11-03','2026-11-04']);assert.deepEqual(split.US.map(d=>[d.day,d.fx]),[['2026-11-04',1343.3]]);
  assert.equal(seoulDay(Date.parse('2026-11-03T16:00:00Z')),'2026-11-04','a U.S. evening fill is the next Seoul day');
});

test('a recorded day whose market part has no positions list is a gap, not "not held" (review change 1)',()=>{
  const split=recordedDays([{day:'2026-10-27',fx:1341,KRW:{positions:[pos('990030',1,96700,92400)]}},{day:'2026-10-28',fx:1341,KRW:{equity:1,cash:1}},{day:'2026-11-02',fx:1357,KRW:{positions:[pos('990030',1,97600,92400)]}}]);
  assert.equal(split.KR[1].positions,null,'kept as unknown, not as an empty list');
  const m=holdingMovement({row:krRow('990030',1,95000,92400),closes:null,days:split.KR,fills:[],period:'1M',today:'2026-11-02'});
  assert.deepEqual(m.pl.points.filter(p=>!p.gap).map(p=>p.day),['2026-10-27','2026-11-02'],'the run continues across the unknown day');assert.equal(m.purchase.day,'2026-10-27');
  const empty=holdingMovement({row:krRow('990030',1,95000,92400),closes:null,days:[...split.KR.slice(0,1),{day:'2026-10-28',positions:[]},split.KR[2]],fills:[],period:'1M',today:'2026-11-02'});
  assert.deepEqual(empty.pl.points.map(p=>p.day),['2026-11-02'],'an empty list is "not held": the run restarts');
});
test('a U.S. holding: the price line uses New York days; a 02:00 KST fill is the previous New York day (review change 2)',()=>{
  const fillAt=Date.parse('2026-11-04T17:00:00Z');// 02:00 KST on 11-05, 12:00 in New York on 11-04
  assert.equal(seoulDay(fillAt),'2026-11-05');assert.equal(newYorkDay(fillAt),'2026-11-04');
  const days=[{day:'2026-11-05',fx:1343,positions:[pos('NYSE:FBRK',1,100.5,94.14)]}];
  const m=holdingMovement({row:usRow('NYSE:FBRK',1,100.5,94.14),closes:closesFrom('2026-10-25','2026-11-04',95,1),days,fills:[{side:'Buy',filled:1,at:fillAt}],period:'1W',today:'2026-11-05',now:Date.parse('2026-11-04T19:00:00Z')});
  assert.deepEqual(m.purchase,{day:'2026-11-05',marketDay:'2026-11-04',source:'fill'});assert.equal(m.price.purchaseMarked,true);
  assert.deepEqual(m.pl.points.map(p=>p.day),['2026-11-05'],'P/L keeps the Seoul record day');
  assert.equal(m.price.to,'2026-11-04');assert.equal(m.price.from,'2026-10-28');
});
test("the live point during the U.S. session is dated by the New York day, replacing that day's close (review change 2)",()=>{
  const now=Date.parse('2026-11-04T15:00:00Z');// 00:00 KST on 11-05, 10:00 in New York on 11-04 (regular session)
  const days=[{day:'2026-11-04',fx:1343,positions:[pos('NYSE:FBRK',1,100.53,94.14)]}];
  const m=holdingMovement({row:usRow('NYSE:FBRK',1,101.2,94.14),closes:closesFrom('2026-10-25','2026-11-04',95,1),days,fills:[],period:'1W',today:'2026-11-05',now});
  assert.deepEqual(m.price.points.at(-1),{day:'2026-11-04',close:101.2,live:true},'not a 11-05 point ahead of the New York calendar');
  assert.equal(m.price.points.filter(p=>p.day==='2026-11-04').length,1);
  const kr=holdingMovement({row:krRow('990030',1,95000,92400),closes:closesFrom('2026-10-25','2026-11-04',95000,100),days:[],period:'1W',today:'2026-11-05',now});
  assert.equal(kr.price.points.at(-1).day,'2026-11-05','a Korean holding keeps the Seoul day');
});
