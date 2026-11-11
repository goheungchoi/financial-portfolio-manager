// movement:records (electron/movement-records.cjs, release gate 1.5.52 G3): it never throws. A damaged nav_history row
// is left out and counted; a failed read is an error reply; the orders failing still returns the days.
const test=require('node:test');const assert=require('node:assert/strict');
const {movementDays,movementRecords}=require('../electron/movement-records.cjs');
const row=(day,p)=>({day,payload:typeof p==='string'?p:JSON.stringify(p)});
const good=day=>row(day,{day,fx:1340,KRW:{equity:1,positions:[{symbol:'000270',name:'기아',quantity:1,value:95000,cost:95100}]},USD:{positions:[]}});

test('a damaged row among good ones is left out and counted; the good rows keep their order and shape',()=>{
  const r=movementDays([good('2026-11-03'),row('2026-11-04','{damaged'),row('2026-11-05','null'),row('2026-11-06','7'),good('2026-11-09')]);
  assert.deepEqual(r.days.map(d=>d.day),['2026-11-03','2026-11-09']);assert.equal(r.unreadableDays,3,'unparseable, null and a number');
  assert.deepEqual(r.days[0],{day:'2026-11-03',fx:1340,KRW:{positions:[{symbol:'000270',quantity:1,value:95000,cost:95100}]},USD:{positions:[]}},'name and other fields are not sent');
});
test('a market part without a positions list stays null (a gap for the cards); a missing market part is null',()=>{
  const r=movementDays([row('2026-11-04',{day:'2026-11-04',KRW:{equity:1,cash:1},USD:null}),row('2026-11-05',{day:'2026-11-05',KRW:{positions:[null,{symbol:'X',quantity:1,value:1,cost:1}]}})]);
  assert.equal(r.days[0].KRW.positions,null);assert.equal(r.days[0].USD,null);assert.equal(r.days[0].fx,null);
  assert.deepEqual(r.days[1].KRW.positions,[{symbol:'X',quantity:1,value:1,cost:1}],'a null entry in the list is dropped');assert.equal(r.unreadableDays,0);
});
test('movementRecords: a failed read is an error reply, never a throw; failing orders still return the days',()=>{
  const failed=movementRecords({read:()=>{throw new Error('SQLITE_CORRUPT');},orders:()=>[{symbol:'000270',side:'Buy',filled:1,filledObservedAt:5}]});
  assert.deepEqual(failed,{days:[],unreadableDays:0,fills:{'000270':[{side:'Buy',filled:1,at:5}]},error:'RECORDS_UNREADABLE'});
  const noOrders=movementRecords({read:()=>[good('2026-11-03')],orders:()=>{throw new Error('ENGINE');}});
  assert.equal(noOrders.days.length,1);assert.deepEqual(noOrders.fills,{});assert.equal(noOrders.error,undefined);
  const fills=movementRecords({read:()=>[],orders:()=>[{symbol:'A',side:'Buy',filled:0},{symbol:'A',side:'Sell',filled:2,acceptedAt:9},null,{side:'Buy',filled:1}]}).fills;
  assert.deepEqual(fills,{A:[{side:'Sell',filled:2,at:9}]},'only filled orders with a symbol');
});
